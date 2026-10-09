import { link, lstat, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AssetKind } from "../../shared/video-parser";
import { VideoFailure, videoError } from "../../shared/video-parser";
import { checkStatus, delay, type NetClient, type NetResponse } from "./network";

export interface TransferState { bytes: number; total: number | null; etag?: string; fingerprint?: string }
export function safeFilename(value: string): string {
  let name = value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 70).replace(/[. ]+$/g, "");
  if (!name) name = "douyin";
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
export function mediaFormat(bytes: Buffer, kind: AssetKind): { extension: string; mime: string } {
  let detected: { extension: string; mime: string; group: "image" | "video" | "audio" } | undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) detected = { extension: "png", mime: "image/png", group: "image" };
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) detected = { extension: "jpg", mime: "image/jpeg", group: "image" };
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") detected = { extension: "webp", mime: "image/webp", group: "image" };
  else if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) detected = { extension: "gif", mime: "image/gif", group: "image" };
  else if (bytes.toString("ascii", 4, 8) === "ftyp") {
    const brand = bytes.toString("ascii", 8, 12);
    if (["avif", "avis"].includes(brand)) detected = { extension: "avif", mime: "image/avif", group: "image" };
    else if (["M4A ", "M4B "].includes(brand)) detected = { extension: "m4a", mime: "audio/mp4", group: "audio" };
    else detected = { extension: "mp4", mime: "video/mp4", group: "video" };
  } else if (bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) detected = { extension: "webm", mime: "video/webm", group: "video" };
  else if (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 0xe6) === 0xe2)) detected = { extension: "mp3", mime: "audio/mpeg", group: "audio" };
  else if (bytes.toString("ascii", 0, 4) === "OggS") detected = { extension: "ogg", mime: "audio/ogg", group: "audio" };
  else if (bytes.toString("ascii", 0, 4) === "fLaC") detected = { extension: "flac", mime: "audio/flac", group: "audio" };
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") detected = { extension: "wav", mime: "audio/wav", group: "audio" };
  const expected = kind === "cover" ? "image" : kind;
  if (!detected || detected.group !== expected) throw new VideoFailure("INVALID_MEDIA");
  return detected;
}
export function rangePlan(response: NetResponse, previous: TransferState): { offset: number; total: number | null; length: number | null } {
  const lengthHeader = response.headers["content-length"];
  const length = lengthHeader === undefined ? null : /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
  if (length !== null && (!Number.isSafeInteger(length) || length < 0)) throw new VideoFailure("INVALID_MEDIA");
  if (response.status === 200) return { offset: 0, total: length, length };
  if (response.status !== 206) throw new VideoFailure("RANGE_MISMATCH");
  const match = response.headers["content-range"]?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) throw new VideoFailure("RANGE_MISMATCH");
  const [, start, end, total] = match.map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start !== previous.bytes || end < start || end >= total || (length !== null && length !== end - start + 1)) throw new VideoFailure("RANGE_MISMATCH");
  if (start > 0 && (!previous.etag || response.headers.etag !== previous.etag || (previous.total !== null && total !== previous.total))) throw new VideoFailure("RANGE_MISMATCH");
  return { offset: start, total, length: end - start + 1 };
}

async function checkContainer(path: string, size: number, kind: AssetKind): Promise<{ extension: string; mime: string }> {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(64); await file.read(head, 0, head.length, 0);
    const format = mediaFormat(head, kind);
    if (["mp4", "m4a"].includes(format.extension)) {
      let offset = 0; let data = false; let index = false; let boxes = 0;
      while (offset < size) {
        if (++boxes > 100_000 || size - offset < 8) throw new VideoFailure("TRUNCATED");
        const header = Buffer.alloc(16); await file.read(header, 0, 16, offset);
        let length = header.readUInt32BE(0); const type = header.toString("ascii", 4, 8);
        if (length === 1) length = Number(header.readBigUInt64BE(8));
        if (length === 0) length = size - offset;
        if (!Number.isSafeInteger(length) || length < 8 || offset + length > size) throw new VideoFailure("TRUNCATED");
        if (type === "mdat" && length > 8) data = true;
        if (type === "moov" || type === "moof") index = true;
        offset += length;
      }
      if (!data || !index) throw new VideoFailure("INVALID_MEDIA");
    }
    if (format.extension === "png") {
      const end = Buffer.alloc(12); await file.read(end, 0, 12, Math.max(0, size - 12));
      if (end.toString("ascii", 4, 8) !== "IEND") throw new VideoFailure("TRUNCATED");
    }
    if (["webp", "wav"].includes(format.extension) && head.readUInt32LE(4) + 8 !== size) throw new VideoFailure("TRUNCATED");
    if (format.extension === "jpg") {
      const end = Buffer.alloc(2); await file.read(end, 0, 2, Math.max(0, size - 2));
      if (end[0] !== 255 || end[1] !== 217) throw new VideoFailure("TRUNCATED");
    }
    return format;
  } finally { await file.close(); }
}

/** Complete files appear atomically; link refuses to replace an existing name. */
export async function publishMedia(part: string, directory: string, basename: string, extension: string): Promise<string> {
  for (let index = 0; index < 10_000; index++) {
    const path = join(directory, `${safeFilename(basename)}${index ? ` (${index})` : ""}.${extension}`);
    try { await link(part, path); await unlink(part).catch(() => undefined); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new VideoFailure("FILE_ERROR"); }
  }
  throw new VideoFailure("FILE_ERROR");
}
export async function downloadFile(options: {
  url: string; kind: AssetKind; part: string; state: TransferState; client: NetClient; signal: AbortSignal;
  progress: (state: TransferState, speed: number) => void;
}): Promise<{ extension: string; mime: string }> {
  const { client, signal, part, state } = options;
  let resetRange = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    let response: NetResponse | undefined;
    try {
      const info = await lstat(part).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw new VideoFailure("FILE_ERROR"); });
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new VideoFailure("FILE_ERROR");
      if (!info || info.size !== state.bytes || !state.etag) state.bytes = 0;
      const headers: Record<string, string> = state.bytes > 0 ? { Range: `bytes=${state.bytes}-`, "If-Range": state.etag! } : {};
      response = await client(options.url, { scope: "media", signal, headers });
      if (response.status === 416) {
        if (resetRange) throw new VideoFailure("RANGE_MISMATCH");
        resetRange = true; state.bytes = 0; state.etag = undefined; state.total = null;
        response.close(); attempt--; continue;
      }
      checkStatus(response);
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new VideoFailure("INVALID_MEDIA");
      if (/text\/|json|html/i.test(response.headers["content-type"] ?? "")) throw new VideoFailure("INVALID_MEDIA");
      const plan = rangePlan(response, state);
      if (plan.total !== null && plan.total > 4 * 1024 ** 3) throw new VideoFailure("INVALID_MEDIA");
      state.bytes = plan.offset; state.total = plan.total;
      state.etag = /^"[^\r\n]{1,250}"$/.test(response.headers.etag ?? "") ? response.headers.etag : undefined;
      const file = await open(part, info ? "r+" : "wx", 0o600).catch(() => { throw new VideoFailure("FILE_ERROR"); });
      let received = 0; const started = Date.now(); let lastUpdate = 0;
      let prefix = Buffer.alloc(0); let checked = plan.offset > 0;
      try {
        if (plan.offset === 0) await file.truncate(0);
        for await (const raw of response.body) {
          signal.throwIfAborted(); const chunk = Buffer.from(raw);
          if (!checked) {
            prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.length)]);
            if (prefix.length >= 16) { mediaFormat(prefix, options.kind); checked = true; }
          }
          if (state.bytes + chunk.length > 4 * 1024 ** 3 || (plan.total !== null && state.bytes + chunk.length > plan.total)) throw new VideoFailure("INVALID_MEDIA");
          let written = 0;
          while (written < chunk.length) {
            const result = await file.write(chunk, written, chunk.length - written, state.bytes);
            if (!result.bytesWritten) throw new VideoFailure("FILE_ERROR");
            state.bytes += result.bytesWritten; written += result.bytesWritten;
          }
          received += chunk.length;
          if (Date.now() - lastUpdate >= 150) { lastUpdate = Date.now(); options.progress(state, received * 1000 / Math.max(1, Date.now() - started)); }
        }
        signal.throwIfAborted();
        if (!state.bytes) throw new VideoFailure("EMPTY_MEDIA");
        if ((plan.length !== null && received !== plan.length) || (plan.total !== null && state.bytes !== plan.total)) throw new VideoFailure("TRUNCATED");
        await file.sync();
      } finally { await file.close(); options.progress(state, 0); }
      const size = (await stat(part)).size;
      if (size !== state.bytes) throw new VideoFailure("TRUNCATED");
      return await checkContainer(part, size, options.kind);
    } catch (error) {
      if (signal.aborted) throw new VideoFailure("CANCELLED");
      if ((error as NodeJS.ErrnoException)?.code?.match(/^(EACCES|EPERM|ENOSPC|ENOENT|EISDIR)$/)) throw new VideoFailure("FILE_ERROR");
      const code = videoError(error);
      if (["INVALID_MEDIA", "EMPTY_MEDIA", "RANGE_MISMATCH"].includes(code)) { state.bytes = 0; state.etag = undefined; }
      if (attempt === 2 || !["NETWORK", "TIMEOUT", "TRUNCATED"].includes(code)) throw error;
      await delay(1000 * 2 ** attempt, signal);
    } finally { response?.close(); }
  }
  throw new VideoFailure("NETWORK");
}
