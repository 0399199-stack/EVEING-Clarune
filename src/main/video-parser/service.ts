import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink, stat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { prepareShareInputs, normalizeShare, VideoFailure, videoError, type AssetKind, type DownloadTask, type ParsedVideo, type ParseItem, type ParseRecord, type ParseProgress, type VideoSnapshot } from "../../shared/video-parser";
import { type DouyinProvider, type PrivateAsset, type ProviderResult } from "./douyin-provider";
import { checkStatus, delay, type NetClient } from "./network";
import { downloadFile, mediaFormat, publishMedia, safeFilename, type TransferState } from "./transfer";

interface TaskFile { resourceId: string; kind: AssetKind; order: number; path?: string; transfer: TransferState }
interface StoredTask { view: DownloadTask; directory: string; files: TaskFile[] }
interface LiveTask extends StoredTask { result?: ProviderResult; intent?: "paused" | "cancelled" }
const idPattern = /^[0-9a-f-]{36}$/;
const assetPattern = /^(video|image|cover|audio)-\d{1,3}$/;
const kinds: AssetKind[] = ["video", "image", "cover", "audio"];
const taskStates = ["queued", "downloading", "paused", "completed", "failed", "cancelled"];
export class VideoService {
  private sessions = new Map<string, ProviderResult>();
  private tasks: LiveTask[] = [];
  private history: ParseRecord[] = [];
  private directory: string;
  private concurrency = 2;
  private ready: Promise<void>;
  private writes = Promise.resolve();
  private parseRequest?: { id: string; abort: AbortController };
  private parserTail: Promise<unknown> = Promise.resolve();
  private nextParseAt = 0;
  private running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private previewTokens = new Map<string, { asset: PrivateAsset; sessionId: string }>();
  private previewRequests = new Map<AbortController, string>();
  private stopping = false;
  private persistFailed = false;
  private enqueues: Promise<unknown> = Promise.resolve();
  private parses = new Set<Promise<ParseItem[]>>();
  private actions = new Map<string, Promise<void>>();
  private downloadNotBefore = 0;
  private cooldownTimer?: ReturnType<typeof setTimeout>;

  constructor(private options: {
    storagePath: string; defaultDirectory: string; provider: DouyinProvider; client: NetClient; engineAvailable: boolean;
    changed?: () => void; parseProgress?: (progress: ParseProgress) => void; requireLicense?: () => Promise<void>;
    parseIntervalMs?: number;
  }) { this.directory = options.defaultDirectory; this.ready = this.load(); }

  private async load(): Promise<void> {
    try {
      if ((await stat(this.options.storagePath)).size > 16 * 1024 * 1024) throw new Error("state too large");
      const bytes = await readFile(this.options.storagePath);
      const data = JSON.parse(bytes.toString("utf8"));
      if (data.version !== 1) throw new Error("unsupported state");
      if (typeof data.directory === "string" && isAbsolute(data.directory)) this.directory = data.directory;
      if ([1, 2, 3].includes(data.concurrency)) this.concurrency = data.concurrency;
      this.history = Array.isArray(data.history) ? data.history.slice(0, 100).filter((item: ParseRecord) => {
        try { return idPattern.test(item.id) && normalizeShare(item.sourceUrl) === item.sourceUrl && ["succeeded", "failed", "cancelled"].includes(item.state) && typeof item.title === "string"; } catch { return false; }
      }) : [];
      for (const task of Array.isArray(data.tasks) ? data.tasks.slice(0, 100) : []) {
        try {
          const view = task.view as DownloadTask;
          if (!idPattern.test(view.id) || !kinds.includes(view.kind) || !taskStates.includes(view.state) || !/^\d{8,30}$/.test(view.contentId) || normalizeShare(view.sourceUrl) !== view.sourceUrl || !isAbsolute(task.directory) || !Array.isArray(task.files) || !task.files.length || task.files.length > 100) continue;
          if (!task.files.every((file: TaskFile) => assetPattern.test(file.resourceId) && kinds.includes(file.kind) && Number.isInteger(file.order) && file.order >= 1 && file.order <= 100 && (!file.path || (isAbsolute(file.path) && file.path.startsWith(task.directory + (process.platform === "win32" ? "\\" : "/")))))) continue;
          // Signed media addresses are never restored. Resume re-parses, discarding partial bytes.
          for (const file of task.files) file.transfer = { bytes: 0, total: null };
          view.speed = 0; view.restartRequired = view.state !== "completed";
          if (["queued", "downloading"].includes(view.state)) view.state = "paused";
          this.tasks.push({ view, directory: task.directory, files: task.files });
        } catch { /* Reject malformed individual records without losing the rest. */ }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.persistFailed = true; }
  }
  private notify(): void { this.options.changed?.(); }
  private async persist(): Promise<void> {
    const data = JSON.stringify({ version: 1, directory: this.directory, concurrency: this.concurrency, history: this.history,
      tasks: this.tasks.map(task => ({ view: task.view, directory: task.directory, files: task.files })) });
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await mkdir(join(this.options.storagePath, ".."), { recursive: true });
      const temp = `${this.options.storagePath}.tmp`;
      await writeFile(temp, data, { mode: 0o600 }); await rename(temp, this.options.storagePath);
    });
    try { await this.writes; this.persistFailed = false; }
    catch { this.persistFailed = true; throw new VideoFailure("FILE_ERROR"); }
  }
  async snapshot(): Promise<VideoSnapshot> {
    await this.ready;
    return structuredClone({ directory: this.directory, concurrency: this.concurrency, tasks: this.tasks.map(task => task.view), history: this.history, engineAvailable: this.options.engineAvailable, storageError: this.persistFailed });
  }
  async setDirectory(directory: string): Promise<void> {
    await this.ready; this.directory = await realpath(directory); await this.persist(); this.notify();
  }
  async setConcurrency(value: number): Promise<void> {
    await this.ready;
    if (![1, 2, 3].includes(value)) throw new VideoFailure("INVALID_INPUT");
    this.concurrency = value; await this.persist(); this.notify(); this.pump();
  }
  private parseSource(source: string, signal: AbortSignal): Promise<ProviderResult> {
    const result = this.parserTail.catch(() => undefined).then(async () => {
      signal.throwIfAborted();
      if (!this.options.engineAvailable) throw new VideoFailure("ENGINE_UNAVAILABLE");
      if (this.nextParseAt - Date.now() > 30_000) throw new VideoFailure("RATE_LIMIT");
      await delay(Math.max(0, this.nextParseAt - Date.now()), signal);
      this.nextParseAt = Date.now() + (this.options.parseIntervalMs ?? 1200);
      const deadline = AbortSignal.timeout(this.options.provider.timeoutMs ?? 30_000);
      const combined = AbortSignal.any([signal, deadline]);
      try { return await this.options.provider.parse(source, combined); }
      catch (error) {
        if (error instanceof VideoFailure && error.code === "RATE_LIMIT") this.nextParseAt = Date.now() + Math.max(60_000, error.retryAfterMs);
        if (deadline.aborted && !signal.aborted) throw new VideoFailure("TIMEOUT");
        throw error;
      }
    });
    this.parserTail = result;
    return result;
  }
  parse(requestId: string, text: string): Promise<ParseItem[]> {
    const task = this.parseBatch(requestId, text);
    this.parses.add(task);
    void task.finally(() => this.parses.delete(task)).catch(() => undefined);
    return task;
  }
  private async parseBatch(requestId: string, text: string): Promise<ParseItem[]> {
    if (this.stopping || typeof requestId !== "string" || !idPattern.test(requestId)) throw new VideoFailure("INVALID_INPUT");
    const links = prepareShareInputs(text);
    this.parseRequest?.abort.abort(); this.stopPreview();
    const request = { id: requestId, abort: new AbortController() }; this.parseRequest = request;
    await this.ready;
    const items: ParseItem[] = []; const ids = new Set<string>();
    for (const input of links) {
      if (request.abort.signal.aborted) break;
      const source = input.sourceUrl;
      if (input.error) { items.push({ sourceUrl: "", state: "failed", error: input.error }); continue; }
      let item: ParseItem;
      try {
        const data = await this.parseSource(source, request.abort.signal);
        request.abort.signal.throwIfAborted();
        if (ids.has(data.contentId)) {
          items.push({ sourceUrl: source, state: "succeeded", duplicate: true });
          if (this.parseRequest === request) this.options.parseProgress?.({ requestId, completed: items.length, total: links.length });
          continue;
        }
        ids.add(data.contentId);
        const sessionId = randomUUID(); this.sessions.set(sessionId, data);
        while (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value!);
        const publicAsset = ({ url: _url, ...asset }: PrivateAsset) => asset;
        const result: ParsedVideo = { ...data, sessionId, assets: data.assets.map(publicAsset), cover: data.cover ? publicAsset(data.cover) : null };
        item = { sourceUrl: source, state: "succeeded", result };
      } catch (error) {
        item = { sourceUrl: source, state: request.abort.signal.aborted ? "cancelled" : "failed", error: request.abort.signal.aborted ? "CANCELLED" : videoError(error) };
      }
      items.push(item);
      const record: ParseRecord = { id: randomUUID(), sourceUrl: source, contentId: item.result?.contentId ?? null, title: item.result?.title ?? "", authorName: item.result?.authorName ?? "", mediaType: item.result?.mediaType ?? null, at: new Date().toISOString(), state: item.state, ...(item.error ? { error: item.error } : {}) };
      this.history = [record, ...this.history].slice(0, 100);
      await this.persist();
      if (this.parseRequest === request) this.options.parseProgress?.({ requestId, completed: items.length, total: links.length });
      this.notify();
    }
    if (request.abort.signal.aborted) {
      // A superseded reply cannot keep unreferenced media capabilities alive.
      for (const item of items) if (item.result) this.sessions.delete(item.result.sessionId);
      throw new VideoFailure("CANCELLED");
    }
    if (this.parseRequest === request) this.parseRequest = undefined;
    return items;
  }
  cancel(id: string): boolean {
    if (this.parseRequest?.id !== id) return false;
    this.parseRequest.abort.abort(); return true;
  }
  release(ids: string[]): void {
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== "string")) throw new VideoFailure("INVALID_INPUT");
    for (const id of ids) this.sessions.delete(id);
    for (const [token, value] of this.previewTokens) if (ids.includes(value.sessionId)) this.previewTokens.delete(token);
    for (const [abort, id] of this.previewRequests) if (ids.includes(id)) { abort.abort(); this.previewRequests.delete(abort); }
  }
  source(sessionId: string): string { return this.session(sessionId).sourceUrl; }
  private session(id: string): ProviderResult {
    const value = this.sessions.get(id);
    if (!value) throw new VideoFailure("SESSION_EXPIRED");
    return value;
  }
  async clearHistory(): Promise<void> { await this.ready; this.history = []; await this.persist(); this.notify(); }
  private part(task: LiveTask, file: TaskFile): string { return join(task.directory, `.clarune-${task.view.id}-${file.resourceId}.part`); }

  enqueue(sessionId: string, kind: AssetKind): Promise<DownloadTask> {
    const task = this.enqueues.catch(() => undefined).then(() => this.enqueueOne(sessionId, kind));
    this.enqueues = task; return task;
  }
  private async enqueueOne(sessionId: string, kind: AssetKind): Promise<DownloadTask> {
    await this.ready;
    if (this.stopping) throw new VideoFailure("CANCELLED");
    const result = this.session(sessionId);
    if (!kinds.includes(kind)) throw new VideoFailure("INVALID_INPUT");
    await this.options.requireLicense?.();
    if (this.stopping) throw new VideoFailure("CANCELLED");
    const assets = result.assets.filter(asset => asset.kind === kind);
    if (!assets.length) throw new VideoFailure("EMPTY_MEDIA");
    const duplicate = this.tasks.find(task => task.view.contentId === result.contentId && task.view.kind === kind && ["queued", "downloading", "paused"].includes(task.view.state));
    if (duplicate) return structuredClone(duplicate.view);
    if (this.tasks.length >= 100) {
      const index = this.tasks.findIndex(task => ["completed", "cancelled"].includes(task.view.state));
      if (index < 0) throw new VideoFailure("QUEUE_FULL");
      this.tasks.splice(index, 1);
    }
    await mkdir(this.directory, { recursive: true });
    let directory = await realpath(this.directory);
    if (kind === "image") {
      const stem = safeFilename(`${result.title || result.contentId}_${result.contentId}`);
      for (let n = 0; n < 10_000; n++) {
        const candidate = join(directory, `${stem}${n ? ` (${n})` : ""}`);
        try { await mkdir(candidate); directory = candidate; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n === 9999) throw new VideoFailure("FILE_ERROR"); }
      }
    }
    const task: LiveTask = { directory, result, files: assets.map(asset => ({ resourceId: asset.resourceId, kind: asset.kind, order: asset.order, transfer: { bytes: 0, total: null } })),
      view: { id: randomUUID(), sourceUrl: result.canonicalUrl, contentId: result.contentId, title: result.title, kind, state: "queued", bytes: 0, total: null, speed: 0, completed: 0, count: assets.length, paths: [], createdAt: new Date().toISOString(), restartRequired: false } };
    this.tasks.push(task);
    try { await this.persist(); } catch (error) { this.tasks = this.tasks.filter(item => item !== task); throw error; }
    this.notify(); this.pump(); return structuredClone(task.view);
  }
  private pump(): void {
    if (this.stopping) return;
    if (Date.now() < this.downloadNotBefore) {
      if (!this.cooldownTimer) {
        this.cooldownTimer = setTimeout(() => { this.cooldownTimer = undefined; this.pump(); }, Math.min(2_147_483_647, this.downloadNotBefore - Date.now()));
        this.cooldownTimer.unref();
      }
      return;
    }
    for (const task of this.tasks) {
      if (this.running.size >= this.concurrency) break;
      if (task.view.state !== "queued" || this.running.has(task.view.id)) continue;
      const abort = new AbortController(); task.intent = undefined; task.view.state = "downloading";
      const done = this.runTask(task, abort.signal).finally(async () => {
        this.running.delete(task.view.id);
        await this.persist().catch(() => undefined); this.notify(); this.pump();
      });
      this.running.set(task.view.id, { abort, done });
      this.notify();
    }
  }
  private async refresh(task: LiveTask, signal: AbortSignal): Promise<void> {
    const result = await this.parseSource(task.view.sourceUrl, signal);
    if (result.contentId !== task.view.contentId) throw new VideoFailure("INVALID_DATA");
    const assets = result.assets.filter(asset => asset.kind === task.view.kind);
    if (assets.length !== task.files.length || task.files.some(file => !assets.some(asset => asset.resourceId === file.resourceId))) throw new VideoFailure("INVALID_DATA");
    task.result = result;
    for (const file of task.files) if (!file.path) { file.transfer = { bytes: 0, total: null }; await unlink(this.part(task, file)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw new VideoFailure("FILE_ERROR"); }); }
    task.view.restartRequired = true;
  }
  private async runTask(task: LiveTask, signal: AbortSignal): Promise<void> {
    try {
      await this.options.requireLicense?.();
      if ((await realpath(task.directory)) !== task.directory) throw new VideoFailure("FILE_ERROR");
      if (!task.result) await this.refresh(task, signal);
      let refreshed = false;
      for (const file of task.files) {
        signal.throwIfAborted();
        if (file.path) {
          const saved = await stat(file.path).catch(() => null);
          if (saved?.isFile() && saved.size > 0) continue;
          file.path = undefined;
          task.view.paths = task.files.flatMap(item => item.path ? [item.path] : []);
          task.view.completed = task.view.paths.length;
        }
        let asset = task.result!.assets.find(item => item.resourceId === file.resourceId)!;
        const fingerprint = createHash("sha256").update(asset.url).digest("hex");
        if (file.transfer.fingerprint !== fingerprint) { file.transfer = { bytes: 0, total: null, fingerprint }; }
        const transfer = () => downloadFile({ url: asset.url, kind: file.kind, part: this.part(task, file), state: file.transfer, client: this.options.client, signal,
          progress: (_state, speed) => { task.view.bytes = file.transfer.bytes; task.view.total = file.transfer.total; task.view.speed = speed; this.notify(); } });
        let format;
        try { format = await transfer(); }
        catch (error) {
          if (!refreshed && error instanceof VideoFailure && ["ACCESS_DENIED", "NOT_FOUND"].includes(error.code)) {
            refreshed = true; await this.refresh(task, signal);
            asset = task.result!.assets.find(item => item.resourceId === file.resourceId)!;
            format = await transfer();
          } else throw error;
        }
        signal.throwIfAborted();
        const name = task.view.kind === "image" ? `${String(file.order).padStart(3, "0")}_${task.view.contentId}` : `${task.view.title || task.view.contentId}_${file.kind}_${task.view.contentId}`;
        file.path = await publishMedia(this.part(task, file), task.directory, name, format.extension);
        task.view.paths = task.files.flatMap(item => item.path ? [item.path] : []);
        task.view.completed = task.view.paths.length;
        await this.persist(); this.notify();
      }
      task.view.state = "completed"; task.view.error = undefined; task.view.restartRequired = false;
    } catch (error) {
      task.view.state = task.intent ?? "failed";
      task.view.error = signal.aborted ? undefined : videoError(error);
      if (error instanceof VideoFailure && error.code === "RATE_LIMIT") {
        this.downloadNotBefore = Math.max(this.downloadNotBefore, Date.now() + Math.max(60_000, error.retryAfterMs));
      }
      if (!(error instanceof VideoFailure) && !signal.aborted && (error as NodeJS.ErrnoException)?.code?.match(/^(EACCES|EPERM|ENOSPC|ENOENT)$/)) task.view.error = "FILE_ERROR";
      task.view.restartRequired = task.files.some(file => !file.path && file.transfer.bytes > 0 && !file.transfer.etag);
    } finally { task.view.speed = 0; }
  }
  taskAction(id: string, action: "pause" | "resume" | "cancel" | "retry"): Promise<void> {
    const operation = (this.actions.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => this.changeTask(id, action));
    this.actions.set(id, operation);
    void operation.finally(() => { if (this.actions.get(id) === operation) this.actions.delete(id); }).catch(() => undefined);
    return operation;
  }
  private async changeTask(id: string, action: "pause" | "resume" | "cancel" | "retry"): Promise<void> {
    await this.ready;
    const task = this.tasks.find(item => item.view.id === id);
    if (!task || this.stopping) throw new VideoFailure("INVALID_INPUT");
    if (action === "pause" || action === "cancel") {
      if (task.view.state === "completed") return;
      task.intent = action === "pause" ? "paused" : "cancelled";
      const active = this.running.get(id); active?.abort.abort();
      task.view.state = task.intent; this.notify();
      await active?.done;
      if (action === "cancel") {
        for (const file of task.files) if (!file.path) {
          await unlink(this.part(task, file)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw new VideoFailure("FILE_ERROR"); });
          file.transfer = { bytes: 0, total: null };
        }
      }
    } else {
      if (!((action === "resume" && task.view.state === "paused") || (action === "retry" && task.view.state === "failed"))) throw new VideoFailure("INVALID_INPUT");
      await this.running.get(id)?.done;
      await this.options.requireLicense?.();
      task.intent = undefined; task.view.error = undefined; task.view.state = "queued";
    }
    await this.persist(); this.notify(); this.pump();
  }
  async outputPath(id: string): Promise<string> {
    await this.ready;
    const task = this.tasks.find(item => item.view.id === id);
    const path = task?.view.paths[0];
    if (!path || !(await stat(path).catch(() => null))?.isFile()) throw new VideoFailure("MISSING_FILE");
    return path;
  }
  preview(sessionId: string, resourceId: string): string {
    const asset = this.session(sessionId).assets.find(item => item.resourceId === resourceId);
    if (!asset) throw new VideoFailure("SESSION_EXPIRED");
    const token = randomUUID(); this.previewTokens.set(token, { asset, sessionId });
    if (this.previewTokens.size > 110) this.previewTokens.delete(this.previewTokens.keys().next().value!);
    return `clarune-media://preview/${token}`;
  }
  stopPreview(): void {
    this.previewTokens.clear();
    for (const abort of this.previewRequests.keys()) abort.abort();
    this.previewRequests.clear();
  }
  async previewResponse(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.pathname.slice(1);
    const entry = url.hostname === "preview" && !url.search && idPattern.test(token) ? this.previewTokens.get(token) : undefined;
    if (!entry || request.method !== "GET" || this.previewRequests.size >= 8) return new Response(null, { status: 404 });
    const { asset } = entry;
    const range = request.headers.get("range");
    if (range && !/^bytes=\d+-\d*$/.test(range)) return new Response(null, { status: 416 });
    const abort = new AbortController(); this.previewRequests.set(abort, entry.sessionId);
    const signal = AbortSignal.any([abort.signal, request.signal]);
    let response;
    try {
      response = await this.options.client(asset.url, { scope: "media", signal, headers: range ? { Range: range } : {} });
      checkStatus(response);
      const offset = range ? Number(range.match(/\d+/)![0]) : 0;
      if (response.status === 206) {
        const actual = response.headers["content-range"]?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        const length = response.headers["content-length"];
        const requestedEnd = range?.match(/^bytes=\d+-(\d+)$/)?.[1];
        if (!actual || !actual.slice(1).every(value => Number.isSafeInteger(Number(value))) || Number(actual[1]) !== offset || Number(actual[2]) < offset || Number(actual[2]) >= Number(actual[3]) || (length !== undefined && Number(length) !== Number(actual[2]) - offset + 1) || (requestedEnd && Number(actual[2]) > Number(requestedEnd))) throw new VideoFailure("RANGE_MISMATCH");
      }
      if (/text\/|json|html/i.test(response.headers["content-type"] ?? "")) throw new VideoFailure("INVALID_MEDIA");
      const iterator = response.body[Symbol.asyncIterator]();
      let prefix = Buffer.alloc(0);
      while (prefix.length < 16) { const next = await iterator.next(); if (next.done) break; prefix = Buffer.concat([prefix, Buffer.from(next.value)]); }
      const mime = response.status === 200 || offset === 0 ? mediaFormat(prefix, asset.kind).mime : response.headers["content-type"];
      if (!mime || !/^(video|audio|image)\//.test(mime)) throw new VideoFailure("INVALID_MEDIA");
      const upstream = response; const requests = this.previewRequests;
      const stream = Readable.from((async function* () {
        try { yield prefix; for (;;) { const next = await iterator.next(); if (next.done) break; signal.throwIfAborted(); yield next.value; } }
        finally { upstream.close(); requests.delete(abort); }
      })());
      stream.once("close", () => { abort.abort(); upstream.close(); requests.delete(abort); });
      const headers: Record<string, string> = { "Content-Type": mime, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      for (const key of ["content-length", "content-range", "accept-ranges"]) if (response.headers[key]) headers[key] = response.headers[key];
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: response.status, headers });
    } catch (error) { response?.close(); this.previewRequests.delete(abort); return new Response(null, { status: 502, headers: { "X-Clarune-Error": videoError(error) } }); }
  }
  async shutdown(): Promise<void> {
    this.stopping = true; this.parseRequest?.abort.abort(); this.stopPreview();
    clearTimeout(this.cooldownTimer); this.cooldownTimer = undefined;
    await this.enqueues.catch(() => undefined);
    await Promise.allSettled([...this.actions.values()]);
    for (const task of this.tasks) if (["queued", "downloading"].includes(task.view.state)) {
      task.intent = "paused"; task.view.state = "paused"; this.running.get(task.view.id)?.abort.abort();
    }
    await Promise.allSettled([...this.running.values()].map(item => item.done));
    await Promise.allSettled([...this.parses]);
    await this.parserTail.catch(() => undefined);
    await this.ready; await this.persist().catch(() => undefined);
  }
}
