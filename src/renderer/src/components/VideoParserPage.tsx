import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { prepareShareInputs, VideoFailure, videoError, type AssetKind, type DownloadTask, type MediaAsset, type ParsedVideo, type ParseItem, type ParseState, type VideoError, type VideoReply, type VideoSnapshot } from "../../../shared/video-parser";
import "./video-parser.css";

const bytes = (n: number) => n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
export default function VideoParserPage() {
  const { t } = useTranslation("videoParser");
  const api = window.clarune.videoParser;
  const [text, setText] = useState("");
  const [batch, setBatch] = useState(false);
  const [state, setState] = useState<ParseState>("idle");
  const [items, setItems] = useState<ParseItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<VideoError | null>(null);
  const [notice, setNotice] = useState("");
  const [snapshot, setSnapshot] = useState<VideoSnapshot | null>(null);
  const [tab, setTab] = useState<"tasks" | "history">("tasks");
  const tabRefs = useRef<Partial<Record<"tasks" | "history", HTMLButtonElement | null>>>({});
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [pending, setPending] = useState(false);
  const request = useRef<string | null>(null);
  const sessions = useRef<string[]>([]);
  const mounted = useRef(true);
  const results = items.flatMap(item => item.result ? [item.result] : []);
  const current = results[selected] ?? results[0];
  const busy = state === "validating" || state === "parsing";

  async function invoke<T>(work: Promise<VideoReply<T>>): Promise<T | undefined> {
    try {
      const reply = await work;
      if (!mounted.current) return;
      if (!reply.ok) { setError(reply.error); return; }
      return reply.value;
    } catch { if (mounted.current) setError("NETWORK"); return; }
  }
  useEffect(() => {
    mounted.current = true;
    let revision = 0;
    const refresh = async () => {
      const serial = ++revision;
      const value = await invoke(api.snapshot());
      if (value && mounted.current && serial === revision) setSnapshot(value);
    };
    void refresh();
    const off = api.onChange(() => { void refresh(); });
    const progressOff = api.onParseProgress(value => { if (value.requestId === request.current) setProgress(value); });
    return () => {
      mounted.current = false; off(); progressOff();
      if (request.current) void api.cancel(request.current);
      request.current = null;
      void api.release(sessions.current); sessions.current = [];
    };
  }, [api]);

  function resetResults() {
    void api.release(sessions.current); sessions.current = [];
    setItems([]); setSelected(0); setNotice(""); setError(null);
  }
  async function parse(value: string) {
    if (request.current) void api.cancel(request.current);
    request.current = null; resetResults(); setState("validating");
    try {
      const links = prepareShareInputs(value);
      if (links.every(item => item.error)) throw new VideoFailure(links[0].error!);
      setProgress({ completed: 0, total: links.length });
    }
    catch (cause) { setError(videoError(cause)); setState("failed"); return; }
    const id = crypto.randomUUID(); request.current = id; setState("parsing");
    try {
      const reply = await api.parse(id, value);
      if (!mounted.current || request.current !== id) {
        if (reply.ok) void api.release(reply.value.flatMap(item => item.result ? [item.result.sessionId] : []));
        return;
      }
      if (reply.ok) {
        setItems(reply.value); sessions.current = reply.value.flatMap(item => item.result ? [item.result.sessionId] : []);
        setState(sessions.current.length ? "succeeded" : "failed");
      } else { setError(reply.error); setState(reply.error === "CANCELLED" ? "cancelled" : "failed"); }
    } catch { if (request.current === id && mounted.current) { setError("NETWORK"); setState("failed"); } }
    finally { if (request.current === id) request.current = null; }
  }
  function cancel() {
    if (request.current) void invoke(api.cancel(request.current));
    request.current = null; setState("cancelled");
  }
  async function download(result: ParsedVideo, kind: AssetKind) {
    setPending(true); setError(null);
    try { if (await invoke(api.enqueue(result.sessionId, kind))) { setNotice("queued"); setTab("tasks"); } }
    finally { if (mounted.current) setPending(false); }
  }
  async function queueAll() {
    setPending(true); setError(null);
    try {
      for (const result of results) {
        if (!mounted.current) break;
        if (!await invoke(api.enqueue(result.sessionId, result.mediaType === "video" ? "video" : "image"))) break;
      }
      setTab("tasks");
    } finally { if (mounted.current) setPending(false); }
  }
  const taskAction = async (task: DownloadTask, action: "pause" | "resume" | "cancel" | "retry" | "reveal") => {
    setError(null); await invoke(api.taskAction(task.id, action));
  };

  return <div className="page video-parser-page" data-testid="video-parser-page">
    <header className="page-intro"><h1>{t("title")}</h1><p>{t("description")}</p></header>
    {snapshot && !snapshot.engineAvailable && <p className="video-message" role="status">{t("unavailable")}</p>}
    {snapshot?.engineAvailable && <p className="video-status">{t("verifiedScope")}</p>}
    {snapshot?.storageError && <p className="video-error" role="alert">{t("storageError")}</p>}
    <form className="glass-panel video-input-card" onSubmit={event => { event.preventDefault(); void parse(text); }}>
      <label htmlFor="douyin-share">{t("input")}</label>
      <textarea id="douyin-share" rows={batch ? 5 : 3} value={text} maxLength={128_000} placeholder={t("placeholder")} onChange={event => {
        setText(event.target.value);
        if (!event.target.value.trim()) { cancel(); resetResults(); setState("idle"); }
      }} />
      <div className="video-actions">
        <button className="primary-button" type="submit" disabled={!text.trim() || busy || pending}>{t("parse")}</button>
        {busy && <button className="text-button" type="button" onClick={cancel}>{t("cancel")}</button>}
        <button className="text-button" type="button" onClick={() => { void invoke(api.paste()).then(value => { if (value !== undefined) setText(value); }); }}>{t("paste")}</button>
        <button className="text-button" type="button" onClick={() => { cancel(); resetResults(); setText(""); setState("idle"); }}>{t("clear")}</button>
        <label className="video-batch-toggle"><input type="checkbox" checked={batch} onChange={event => setBatch(event.target.checked)} />{t("batch")}</label>
      </div>
      {batch && <div className="video-batch-options"><p>{t("batchHint")}</p><button className="text-button" type="button" onClick={() => { void invoke(api.importText()).then(value => { if (value != null) setText(value); }); }}>{t("import")}</button></div>}
      <p className="video-status" role="status">{busy ? t("parseProgress", progress) : t(`states.${state}`)}</p>
      {busy && <p className="video-status">{t("browserHint")}</p>}
    </form>
    {error && <p className="video-error" role="alert">{t(`errors.${error}`)}</p>}
    {notice && <p className="video-message" role="status">{t(notice)}</p>}
    {items.filter(item => item.error || item.duplicate).map((item, index) => <p className="video-message" key={`${item.sourceUrl}-${index}`}>{item.sourceUrl} · {item.error ? t(`errors.${item.error}`) : t("duplicate")}</p>)}
    {current && <section className="glass-panel video-result" aria-label={t("results")}>
      {results.length > 1 && <div className="video-result-picker"><select aria-label={t("results")} value={selected} onChange={event => setSelected(Number(event.target.value))}>{results.map((result, index) => <option value={index} key={result.sessionId}>{index + 1}. {result.title || result.contentId}</option>)}</select><button type="button" className="text-button" disabled={pending} onClick={() => { void queueAll(); }}>{t("queueAll")}</button></div>}
      <div className="video-result-body">
        <MediaPreview key={current.sessionId} result={current} />
        <div className="video-result-info">
          <span className="audit-badge">{t(current.mediaType)}</span><h2>{current.title || t("untitled")}</h2>
          <p>{t("author")}: {current.authorName || t("unknown")}</p>
          <p className="video-meta">ID: {current.contentId}</p>
          {current.durationMs !== null && <p>{t("duration")}: {t("seconds", { value: (current.durationMs / 1000).toFixed(1) })}</p>}
          {current.width && current.height && <p>{t("dimensions")}: {current.width} × {current.height}</p>}
          {current.mediaType === "gallery" && <p>{t("images", { count: current.assets.filter(asset => asset.kind === "image").length })}</p>}
          <p className="video-meta">{t("parsedOnly")}</p>
          <div className="video-actions">
            {(["video", "image", "cover", "audio"] as AssetKind[]).filter(kind => current.assets.some(asset => asset.kind === kind)).map(kind => <button key={kind} type="button" className={kind === "video" || kind === "image" ? "primary-button" : "text-button"} disabled={pending} onClick={() => { void download(current, kind); }}>{t({ video: "downloadVideo", image: "downloadImages", cover: "downloadCover", audio: "downloadAudio" }[kind])}</button>)}
            <button className="text-button" type="button" onClick={() => { void invoke(api.copySource(current.sessionId)).then(ok => { if (ok) setNotice("copied"); }); }}>{t("copy")}</button>
          </div>
        </div>
      </div>
    </section>}
    <details className="glass-panel video-save-settings"><summary>{t("saveSettings")}</summary><div>
      <p>{t("directory")}: <span className="video-path">{snapshot?.directory ?? t("loading")}</span></p>
      <button type="button" className="text-button" onClick={() => { void invoke(api.chooseDirectory()); }}>{t("choose")}</button>
      <label>{t("concurrency")}<select value={snapshot?.concurrency ?? 2} onChange={event => { void invoke(api.setConcurrency(Number(event.target.value))); }}>{[1, 2, 3].map(n => <option value={n} key={n}>{n}</option>)}</select></label>
    </div></details>
    <section className="glass-panel video-records" aria-label={t("records")}>
      <div className="segmented video-record-tabs" role="tablist" aria-label={t("records")}>{(["tasks", "history"] as const).map(value => <button id={`video-tab-${value}`} role="tab" type="button" key={value} ref={element => { tabRefs.current[value] = element; }} tabIndex={tab === value ? 0 : -1} className={tab === value ? "selected" : ""} aria-selected={tab === value} aria-controls={`video-panel-${value}`} onClick={() => setTab(value)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "tasks" : event.key === "End" ? "history" : value === "tasks" ? "history" : "tasks";
        setTab(next); tabRefs.current[next]?.focus();
      }}>{t(value)}{value === "tasks" && snapshot?.tasks.length ? ` (${snapshot.tasks.length})` : ""}</button>)}</div>
      {tab === "tasks" ? <div id="video-panel-tasks" role="tabpanel" aria-labelledby="video-tab-tasks">
        {!snapshot?.tasks.length && <p className="video-meta">{t("emptyTasks")}</p>}
        {snapshot?.tasks.map(task => <article className="video-record" key={task.id}>
          <div><strong>{task.title || task.contentId}</strong><p>{t(`downloadStates.${task.state}`)} · {t("saved", { completed: task.completed, count: task.count })}</p>
            {task.state === "downloading" && <><p className="video-meta">{t("bytes", { received: bytes(task.bytes), total: task.total === null ? t("unknown") : bytes(task.total), speed: bytes(task.speed) })}</p>{task.total !== null && task.total > 0 && <progress aria-label={t("tasks")} value={task.bytes} max={task.total} />}</>}
            {task.error && <p className="video-error">{t(`errors.${task.error}`)}</p>}
            {(task.restartRequired || task.state === "paused") && <p className="video-meta">{t("restart")}</p>}
          </div>
          <div className="video-actions">
            {["queued", "downloading"].includes(task.state) && <button className="text-button" type="button" onClick={() => { void taskAction(task, "pause"); }}>{t("pause")}</button>}
            {task.state === "paused" && <button className="text-button" type="button" onClick={() => { void taskAction(task, "resume"); }}>{t("resume")}</button>}
            {task.state === "failed" && <button className="text-button" type="button" onClick={() => { void taskAction(task, "retry"); }}>{t("retry")}</button>}
            {!["completed", "cancelled"].includes(task.state) && <button className="text-button danger" type="button" onClick={() => { void taskAction(task, "cancel"); }}>{t("cancelDownload")}</button>}
            {task.paths.length > 0 && <button className="text-button" type="button" onClick={() => { void taskAction(task, "reveal"); }}>{t("reveal")}</button>}
          </div>
        </article>)}
      </div> : <div id="video-panel-history" role="tabpanel" aria-labelledby="video-tab-history">
        <div className="video-history-heading"><p className="video-meta">{t("historyHint")}</p><button type="button" className="text-button" onClick={() => { void invoke(api.clearHistory()); }}>{t("clearHistory")}</button></div>
        {!snapshot?.history.length && <p className="video-meta">{t("emptyHistory")}</p>}
        {snapshot?.history.map(record => <article className="video-record" key={record.id}><div><strong>{record.title || record.sourceUrl}</strong><p className="video-meta">{t(`states.${record.state}`)} · {new Date(record.at).toLocaleString()}</p>{record.error && <p>{t(`errors.${record.error}`)}</p>}</div><button type="button" className="text-button" disabled={busy} onClick={() => { setText(record.sourceUrl); void parse(record.sourceUrl); }}>{t("reparse")}</button></article>)}
      </div>}
    </section>
    <p className="video-meta video-scope">{t("scope")}</p>
  </div>;
}

function MediaPreview({ result }: { result: ParsedVideo }) {
  const { t } = useTranslation("videoParser");
  const [url, setUrl] = useState<string | null>(null);
  const [kind, setKind] = useState<AssetKind>("cover");
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const player = useRef<HTMLVideoElement>(null);
  const api = window.clarune.videoParser;
  function detachPlayer() {
    const video = player.current;
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
  }
  async function show(asset: MediaAsset) {
    const serial = ++generation.current;
    detachPlayer();
    setUrl(null); setFailed(false);
    try {
      await api.stopPreview();
      const response = await api.preview(result.sessionId, asset.resourceId);
      if (serial !== generation.current) return;
      if (response.ok) { setKind(asset.kind); setUrl(response.value); } else setFailed(true);
    } catch { if (serial === generation.current) setFailed(true); }
  }
  useEffect(() => {
    const initial = result.cover ?? result.assets.find(asset => asset.kind === "image");
    if (initial) void show(initial);
    return () => { generation.current++; detachPlayer(); void api.stopPreview(); };
  }, [result.sessionId]);
  const video = result.assets.find(asset => asset.kind === "video");
  return <div className="video-preview">
    <div className="video-preview-stage">
      {url && !failed && (kind === "video" ? <video ref={player} src={url} controls muted preload="metadata" onError={() => setFailed(true)} /> : <img src={url} alt={result.title || t("untitled")} onError={() => setFailed(true)} />)}
      {failed && <p role="status">{t("previewFailed")}</p>}
      {!url && !failed && <span>{t(result.mediaType)}</span>}
    </div>
    <div className="video-actions">
      {video && <button className="text-button" type="button" onClick={() => { void show(video); }}>{t("preview")}</button>}
      {kind === "video" && url && <button className="text-button" type="button" onClick={() => { generation.current++; detachPlayer(); setUrl(null); void api.stopPreview(); }}>{t("stopPreview")}</button>}
      {result.assets.filter(asset => asset.kind === "image").map(asset => <button type="button" className="text-button" key={asset.resourceId} aria-label={t("selectedImage", { index: asset.order })} onClick={() => { void show(asset); }}>{asset.order}</button>)}
    </div>
  </div>;
}
