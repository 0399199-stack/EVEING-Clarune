import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { AppInfo } from "../../shared/contracts";
import { setLanguage, type SupportedLanguage } from "./i18n";
import AboutCard from "./components/AboutCard";
import LicenseDialog from "./components/LicenseDialog";
import ImageViewer, { type PreviewImage } from "./components/ImageViewer";
import { BrandMark } from "./components/BrandMark";
import { sameAspectRatio } from "../../shared/viewer-geometry";
import type { EnhancementProgress, ToolId, UpscaleOptions, UpscaleStatus } from "../../shared/image-tools";
import ImageToolStudio, { type StudioTask } from "./components/ImageToolStudio";
import OutputCompression from "./components/OutputCompression";
import ParameterNumber from "./components/ParameterNumber";
import { clearOutputHistory, getOutputHistory } from "./lib/output-history";
import { useToolText } from "./locales/tool-text";

type Page = "enhance" | "batch" | "history" | "models" | "settings" | ToolId;
type ThemeChoice = "system" | "light" | "dark";
type DensityChoice = "comfortable" | "compact";
type EnhancementTask = EnhancementProgress & { name: string; canceling: boolean };
type GlobalTask = Omit<StudioTask, "kind"> & { kind: StudioTask["kind"] | "enhance"; percent?: number };

interface SelectedImage {
  id: string;
  name: string;
  size: number;
  url: string;
}

const toolPages: ToolId[] = ["resize", "compress", "crop", "watermark", "round", "rotate", "flip", "pdf"];
const navigationGroups: Array<{ title: string; items: Page[] }> = [
  { title: "workspaceGroup", items: ["enhance", "batch"] },
  { title: "toolsGroup", items: toolPages },
  { title: "appGroup", items: ["history", "models", "settings"] },
];

function Icon({ name, size = 20 }: { name: string; size?: number }): ReactNode {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (name) {
    case "enhance":
      return <svg {...common}><path d="m12 3 1.5 4.2L18 9l-4.5 1.8L12 15l-1.5-4.2L6 9l4.5-1.8L12 3Z"/><path d="m5 14 .8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z"/><path d="m19 13 .7 1.8 1.8.7-1.8.7L19 18l-.7-1.8-1.8-.7 1.8-.7L19 13Z"/></svg>;
    case "batch":
      return <svg {...common}><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></svg>;
    case "history":
      return <svg {...common}><path d="M4.9 7.5A8 8 0 1 1 4 12"/><path d="M4 4v4h4M12 8v5l3 2"/></svg>;
    case "models":
      return <svg {...common}><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z"/><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5"/></svg>;
    case "settings":
      return <svg {...common}><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M10 14v6"/></svg>;
    case "shield":
      return <svg {...common}><path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>;
    case "image":
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 3 3 2-2 6 5"/></svg>;
    case "plus":
      return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case "lock":
      return <svg {...common}><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>;
    case "check":
      return <svg {...common}><path d="m5 12 4 4L19 6"/></svg>;
    case "resize":
      return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 16 8-8M11 8h5v5M8 11v5h5"/></svg>;
    case "compress":
      return <svg {...common}><path d="M4 4h5v5M20 20h-5v-5M9 9 3 3M15 15l6 6M15 4h5v5M4 15v5h5"/></svg>;
    case "crop":
      return <svg {...common}><path d="M7 3v14h14M3 7h14v14M10 4h10v10"/></svg>;
    case "watermark":
      return <svg {...common}><path d="M8 4h8M12 4v11M9 15h6M4 19h16"/><path d="M4 4v3M20 4v3"/></svg>;
    case "round":
      return <svg {...common}><path d="M4 20V11a7 7 0 0 1 7-7h9M9 20h3m5 0h3v-3m0-5V9"/></svg>;
    case "rotate":
      return <svg {...common}><path d="M5 8a8 8 0 1 1-1 7M5 3v5h5"/><path d="M10 10h5v5h-5z"/></svg>;
    case "flip":
      return <svg {...common}><path d="M12 3v3m0 4v4m0 4v3M3 7h5v10H3zM21 7h-5v10h5z"/></svg>;
    case "pdf":
      return <svg {...common}><path d="M7 3h8l4 4v14H7zM15 3v5h4M4 6v12M10 12h6M10 16h6"/></svg>;
    default:
      return <span aria-hidden>·</span>;
  }
}

function App(): ReactNode {
  const { t, i18n } = useTranslation([
    "common",
    "workspace",
    "batch",
    "history",
    "models",
    "settings",
    "license",
  ]);
  const [page, setPage] = useState<Page>("enhance");
  const [activeTool, setActiveTool] = useState<ToolId>("upscale");
  const [studioTask, setStudioTask] = useState<StudioTask | null>(null);
  const [enhanceSaving, setEnhanceSaving] = useState(false);
  const [enhancementTask, setEnhancementTask] = useState<EnhancementTask | null>(null);
  const [enhancementError, setEnhancementError] = useState<string | null>(null);
  const [enhancementNotice, setEnhancementNotice] = useState<"complete" | "canceled" | null>(null);
  const [upscaleModel, setUpscaleModel] = useState<UpscaleOptions["model"]>("realesrgan-x4plus");
  const [upscaleTile, setUpscaleTile] = useState<UpscaleOptions["tileSize"]>(128);
  const [runtimeStatus, setRuntimeStatus] = useState<UpscaleStatus | null>(null);
  const [runtimeModel, setRuntimeModel] = useState<UpscaleOptions["model"] | null>(null);
  const [runtimeChecking, setRuntimeChecking] = useState(true);
  const [stopRequested, setStopRequested] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [licenseOpen, setLicenseOpen] = useState(false);
  useEffect(() => {
    const open = () => setLicenseOpen(true);
    window.addEventListener("clarune:license-required", open);
    return () => window.removeEventListener("clarune:license-required", open);
  }, []);
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    const saved = window.localStorage.getItem("clarune.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [density, setDensity] = useState<DensityChoice>(() => window.localStorage.getItem("clarune.density") === "compact" ? "compact" : "comfortable");
  const [scale, setScale] = useState(4);
  const [format, setFormat] = useState("PNG");
  const [enhanceImage, setEnhanceImage] = useState<PreviewImage | null>(null);
  const [comparisonImage, setComparisonImage] = useState<PreviewImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo>({
    name: "EVEING Clarune",
    version: "1.0.0-rc.1",
    platform: "win32",
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultInputRef = useRef<HTMLInputElement>(null);
  const previewRequest = useRef(0);
  const objectUrls = useRef(new Set<string>());
  const mainStage = useRef<HTMLElement>(null);
  const activeEnhancement = useRef<{ id: string; canceled: boolean; started: boolean } | null>(null);
  const runtimeRequest = useRef(0);
  const { errorText } = useToolText();
  const selectedRuntime = runtimeModel === upscaleModel ? runtimeStatus : null;
  const runtimePending = runtimeChecking || runtimeModel !== upscaleModel;

  const refreshRuntime = async () => {
    const request = ++runtimeRequest.current;
    setRuntimeChecking(true);
    try {
      const response = await window.clarune.getUpscaleStatus(upscaleModel);
      if (request === runtimeRequest.current) {
        setRuntimeStatus(response.ok ? response.value : { ready: false, localOnly: true, reason: response.error });
        setRuntimeModel(upscaleModel);
      }
    } catch {
      if (request === runtimeRequest.current) {
        setRuntimeStatus({ ready: false, localOnly: true, reason: upscaleModel === "real-hat-x4" ? "REALHAT_RUNTIME_NOT_CONFIGURED" : "UPSCALE_RUNTIME_NOT_FOUND" });
        setRuntimeModel(upscaleModel);
      }
    } finally { if (request === runtimeRequest.current) setRuntimeChecking(false); }
  };

  useEffect(() => {
    const refresh = () => { void refreshRuntime(); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("clarune:upscale-runtime-change", refresh);
    return () => { runtimeRequest.current++; window.removeEventListener("focus", refresh); window.removeEventListener("clarune:upscale-runtime-change", refresh); };
  }, [upscaleModel]);

  useEffect(() => window.clarune.onEnhancementProgress(progress => {
    if (progress.id !== activeEnhancement.current?.id || activeEnhancement.current.canceled) return;
    setEnhancementTask(previous => previous?.id === progress.id ? { ...previous, ...progress, percent: progress.percent } : previous);
  }), []);

  useEffect(() => { mainStage.current?.scrollTo({ top: 0 }); }, [page]);
  useEffect(() => {
    document.documentElement.dataset.density = density;
    window.localStorage.setItem("clarune.density", density);
  }, [density]);

  useEffect(() => {
    void window.clarune.getAppInfo().then(setAppInfo);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      window.localStorage.setItem("clarune.theme", theme);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => () => {
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const makeImage = (file: File): SelectedImage => {
    const url = URL.createObjectURL(file);
    objectUrls.current.add(url);
    return {
      id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
      name: file.name,
      size: file.size,
      url,
    };
  };

  const releaseImage = (image: SelectedImage): void => {
    URL.revokeObjectURL(image.url);
    objectUrls.current.delete(image.url);
    if ("largeId" in image && typeof image.largeId === "string") void window.clarune.discardLargeEnhancement(image.largeId);
  };

  const loadPreview = async (file: File, target: "original" | "result"): Promise<void> => {
    if (activeEnhancement.current || enhanceSaving) return;
    const request = ++previewRequest.current;
    setImageError(null);
    setImageLoading(true);
    const selected = makeImage(file);
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error("previewLimit");
      const decoded = new Image();
      decoded.src = selected.url;
      await decoded.decode();
      if (!decoded.naturalWidth || !decoded.naturalHeight) throw new Error("imageLoadError");
      if (decoded.naturalWidth * decoded.naturalHeight > 40_000_000 || Math.max(decoded.naturalWidth, decoded.naturalHeight) > 16384) throw new Error("previewLimit");
      const image: PreviewImage = { ...selected, file, width: decoded.naturalWidth, height: decoded.naturalHeight };
      if (request !== previewRequest.current) { releaseImage(image); return; }
      if (target === "result") {
        if (!enhanceImage || !sameAspectRatio(enhanceImage, image)) throw new Error("aspectMismatch");
        if (comparisonImage) releaseImage(comparisonImage);
        setComparisonImage(image);
        setEnhancementNotice(null);
      } else {
        if (enhanceImage) releaseImage(enhanceImage);
        if (comparisonImage) releaseImage(comparisonImage);
        setEnhanceImage(image);
        setComparisonImage(null);
        setEnhancementNotice(null);
        setEnhancementError(null);
      }
    } catch (error) {
      releaseImage(selected);
      if (request === previewRequest.current) {
        setImageError(error instanceof Error && ["aspectMismatch", "previewLimit"].includes(error.message) ? error.message : "imageLoadError");
      }
    } finally {
      if (request === previewRequest.current) setImageLoading(false);
    }
  };

  const acceptFiles = (files: FileList | File[]): void => {
    const accepted = Array.from(files).filter((file) =>
      ["image/png", "image/jpeg", "image/webp"].includes(file.type),
    );
    if (!accepted[0]) { setImageError("imageLoadError"); return; }
    void loadPreview(accepted[0], "original");
  };

  const chooseFiles = (): void => { if (!activeEnhancement.current && !enhanceSaving) fileInputRef.current?.click(); };
  const onFileInput = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files) acceptFiles(event.target.files);
    event.target.value = "";
  };
  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    if (activeEnhancement.current || enhanceSaving) return;
    acceptFiles(event.dataTransfer.files);
  };
  const selectRuntime = async () => {
    if (activeEnhancement.current) return;
    const request = ++runtimeRequest.current;
    setRuntimeChecking(true); setEnhancementError(null);
    try {
      const response = await window.clarune.selectUpscaleRuntime(upscaleModel);
      if (response.ok) {
        if (request === runtimeRequest.current) {
          setRuntimeStatus(response.value);
          setRuntimeModel(upscaleModel);
        }
        window.dispatchEvent(new Event("clarune:upscale-runtime-change"));
      } else if (request === runtimeRequest.current && !response.canceled) setEnhancementError(response.error);
    } catch { if (request === runtimeRequest.current) setEnhancementError(upscaleModel === "real-hat-x4" ? "REALHAT_RUNTIME_NOT_CONFIGURED" : "UPSCALE_RUNTIME_NOT_FOUND"); }
    finally { if (request === runtimeRequest.current) setRuntimeChecking(false); }
  };
  const startEnhancement = async () => {
    if (!enhanceImage?.file || imageLoading || enhanceSaving || studioTask || activeEnhancement.current || runtimePending || !selectedRuntime?.ready) return;
    const source = enhanceImage;
    const task = { id: crypto.randomUUID(), canceled: false, started: false };
    activeEnhancement.current = task;
    setEnhancementTask({ id: task.id, name: source.name, stage: "preparing", canceling: false });
    setEnhancementError(null); setEnhancementNotice(null);
    try {
      const bytes = new Uint8Array(await source.file!.arrayBuffer());
      if (task.canceled) { setEnhancementNotice("canceled"); return; }
      task.started = true;
      const response = await window.clarune.enhanceImage({ id: task.id, bytes,
        upscale: { scale: scale as UpscaleOptions["scale"], model: upscaleModel, tileSize: upscaleTile } });
      if (activeEnhancement.current?.id !== task.id) return;
      if (task.canceled || (!response.ok && response.canceled)) { setEnhancementNotice("canceled"); return; }
      if (!response.ok) { setEnhancementError(response.error); return; }
      const enhanced = response.value;
      const file = new File([Uint8Array.from("large" in enhanced ? enhanced.preview : enhanced.bytes)], `${source.name.replace(/\.[^.]+$/, "")}-ai-${scale}x.png`, { type: "image/png" });
      const selected = makeImage(file);
      const image: PreviewImage = { ...selected, file, width: enhanced.width, height: enhanced.height, origin: "ai",
        ...("large" in enhanced ? { largeId: enhanced.id, largeSize: enhanced.size, size: enhanced.size } : {}) };
      const decoded = new Image(); decoded.src = selected.url;
      try { await decoded.decode(); } catch { releaseImage(image); throw new Error("UPSCALE_INVALID_OUTPUT"); }
      if (activeEnhancement.current?.id !== task.id || task.canceled) { releaseImage(image); setEnhancementNotice("canceled"); return; }
      if (comparisonImage) releaseImage(comparisonImage);
      setComparisonImage(image);
      setEnhancementNotice("complete");
    } catch (error) {
      if (activeEnhancement.current?.id === task.id) {
        if (task.canceled) setEnhancementNotice("canceled");
        else setEnhancementError(error instanceof Error && error.message === "UPSCALE_INVALID_OUTPUT" ? error.message : "PROCESSING_FAILED");
      }
    } finally {
      if (activeEnhancement.current?.id === task.id) { activeEnhancement.current = null; setEnhancementTask(null); }
    }
  };
  const cancelEnhancement = async () => {
    const task = activeEnhancement.current;
    if (!task || task.canceled) return;
    task.canceled = true;
    setEnhancementTask(previous => previous ? { ...previous, canceling: true } : null);
    if (!task.started) return;
    try {
      const response = await window.clarune.cancelEnhancement(task.id);
      if (!response.ok && activeEnhancement.current?.id === task.id) {
        task.canceled = false;
        setEnhancementTask(previous => previous ? { ...previous, canceling: false } : null);
        setEnhancementError(response.error);
      }
    } catch {
      if (activeEnhancement.current?.id === task.id) {
        task.canceled = false; setEnhancementTask(previous => previous ? { ...previous, canceling: false } : null);
        setEnhancementError("PROCESSING_FAILED");
      }
    }
  };
  const changeLanguage = (language: SupportedLanguage): void => {
    void setLanguage(language);
  };
  const navigate = (next: Page): void => {
    if (toolPages.includes(next as ToolId)) setActiveTool(next as ToolId);
    if (next === "batch" && activeTool === "pdf") setActiveTool("upscale");
    setPage(next);
  };
  const activeTasks: GlobalTask[] = [];
  if (studioTask) activeTasks.push(studioTask);
  if (enhanceSaving) activeTasks.push({ id: "enhance-export", kind: "image", completed: 0, total: 1, canceling: false });
  if (enhancementTask) activeTasks.push({ id: enhancementTask.id, kind: "enhance", completed: 0, total: 100, percent: enhancementTask.percent,
    currentName: `${enhancementTask.name} · ${t(`workspace:ai.stage.${enhancementTask.stage}`)}`, canceling: enhancementTask.canceling });
  const stopTask = async (id: string) => {
    setStopRequested(id); setTaskError(null);
    try {
      const result = await window.clarune.cancelBatch(id);
      if (!result.ok) { setTaskError(t("task.stopFailed")); setStopRequested(null); }
    } catch { setTaskError(t("task.stopFailed")); setStopRequested(null); }
  };

  return (
    <div className={`app-shell ${activeTasks.length ? "has-global-task" : ""} ${activeTasks.length > 1 ? "has-two-tasks" : ""}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="titlebar">
        <div className="brand-lockup">
          <BrandMark />
          <div>
            <strong>{t("appName")}</strong>
            <small>{t("appTagline")}</small>
          </div>
        </div>
        <div className="titlebar-actions">
          <span className="phase-pill">{t("phase")}</span>
          <button className="license-trigger" type="button" onClick={() => setLicenseOpen(true)}>
            <Icon name="shield" size={17} />
            {t("license:button")}
          </button>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar glass-panel">
          <nav className="sidebar-scroll" aria-label={t("navigationLabel")}>
            {navigationGroups.map((group) => <div key={group.title}>
              <p className="nav-section-label">{t(group.title)}</p>
              <NavigationGroup items={group.items} page={page} onNavigate={navigate} />
            </div>)}
          </nav>
          <button className="sidebar-brand-card" type="button" onClick={() => setPage("settings")} aria-label={t("aboutLink")}>
            <BrandMark />
            <strong>{t("brandIntroName")}</strong>
            <small>{t("brandIntroSubtitle")}</small>
            <span>Beyond Resolution.</span>
          </button>
        </aside>

        <main className="main-stage" ref={mainStage}>
          <div hidden={page !== "batch" && !toolPages.includes(page as ToolId)} style={{ height: "100%" }}>
            <ImageToolStudio tool={activeTool} active={page === "batch" || toolPages.includes(page as ToolId)} batchMode={page === "batch"} onToolChange={setActiveTool} onTaskChange={setStudioTask} externalCancelId={stopRequested} engineBusy={Boolean(enhancementTask)} />
          </div>
          <div hidden={page !== "enhance"} style={{ height: "100%" }}>
            <EnhancePage
              image={enhanceImage}
              result={comparisonImage}
              loading={imageLoading}
              error={imageError}
              scale={scale}
              format={format}
              onChoose={chooseFiles}
              onChooseResult={() => { if (!activeEnhancement.current && !enhanceSaving) resultInputRef.current?.click(); }}
              onDrop={onDrop}
              onScale={setScale}
              onFormat={setFormat}
              onSavingChange={setEnhanceSaving}
              saving={enhanceSaving}
              engineBusy={Boolean(studioTask)}
              task={enhancementTask}
              aiError={enhancementError ? errorText(enhancementError) : null}
              aiNotice={enhancementNotice}
              model={upscaleModel}
              tileSize={upscaleTile}
              runtime={selectedRuntime}
              runtimeChecking={runtimePending}
              onModel={model => { if (model === upscaleModel) return; runtimeRequest.current++; setRuntimeChecking(true); setRuntimeModel(null); setUpscaleModel(model); setEnhancementError(null); }}
              onTileSize={setUpscaleTile}
              onSelectRuntime={() => void selectRuntime()}
              onRefreshRuntime={() => void refreshRuntime()}
              onStart={() => void startEnhancement()}
              onCancel={() => void cancelEnhancement()}
              onOpenBatchUpscale={() => { setActiveTool("upscale"); setPage("batch"); }}
              onRemove={() => {
                if (activeEnhancement.current || enhanceSaving) return;
                previewRequest.current++;
                if (enhanceImage) releaseImage(enhanceImage);
                if (comparisonImage) releaseImage(comparisonImage);
                setEnhanceImage(null);
                setComparisonImage(null);
                setImageError(null);
                setImageLoading(false);
                setEnhancementError(null); setEnhancementNotice(null);
              }}
              onRemoveResult={() => {
                if (activeEnhancement.current || enhanceSaving) return;
                previewRequest.current++;
                if (comparisonImage) releaseImage(comparisonImage);
                setComparisonImage(null);
                setImageError(null);
                setImageLoading(false);
                setEnhancementNotice(null);
              }}
            />
          </div>
          {page === "history" && <HistoryPage />}
          {page === "models" && <ModelsPage />}
          {page === "settings" && (
            <SettingsPage
              theme={theme}
              language={(i18n.resolvedLanguage === "en-US" ? "en-US" : "zh-CN")}
              appInfo={appInfo}
              density={density}
              onDensity={setDensity}
              onTheme={setTheme}
              onLanguage={changeLanguage}
            />
          )}
        </main>
      </div>

      {activeTasks.length > 0 && <section className="global-task-bar glass-panel" aria-label={t("task.title")} data-testid="global-task-bar">
        {activeTasks.map(task => <div className="global-task" key={task.id}>
          <span className="global-task-status" role="status"><strong>{t(`task.${task.kind}`)}</strong><small title={task.currentName}>{task.currentName ?? t("task.savingHint")}</small></span>
          <progress max={Math.max(1, task.total)} value={task.kind === "batch" ? task.completed : task.kind === "enhance" ? task.percent : undefined} aria-label={t("task.progress")} />
          <span className="global-task-count">{task.kind === "enhance" ? task.percent === undefined ? "…" : `${Math.round(task.percent)}%` : `${task.completed} / ${task.total}`}</span>
          <button type="button" className="text-button" onClick={() => navigate(task.id === "enhance-export" || task.kind === "enhance" ? "enhance" : task.kind === "pdf" ? "pdf" : "batch")}>{t("task.return")}</button>
          {task.kind === "batch" && <button type="button" className="text-button danger" data-testid="global-task-stop" disabled={task.canceling || stopRequested === task.id} onClick={() => void stopTask(task.id)}>{t(task.canceling || stopRequested === task.id ? "task.stopping" : "task.stop")}</button>}
          {task.kind === "enhance" && <button type="button" className="text-button danger" data-testid="global-enhance-cancel" disabled={task.canceling} onClick={() => void cancelEnhancement()}>{t(task.canceling ? "workspace:ai.canceling" : "actions.cancel")}</button>}
        </div>)}
        {taskError && <small role="alert">{taskError}</small>}
      </section>}

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        data-testid="original-file-input"
        accept="image/png,image/jpeg,image/webp"
        disabled={Boolean(enhancementTask) || enhanceSaving || imageLoading}
        onChange={onFileInput}
        tabIndex={-1}
      />
      <input ref={resultInputRef} className="visually-hidden" type="file" tabIndex={-1}
        disabled={Boolean(enhancementTask) || enhanceSaving || imageLoading}
        accept="image/png,image/jpeg,image/webp" data-testid="result-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void loadPreview(file, "result");
          event.target.value = "";
        }} />

      {licenseOpen && <LicenseDialog onClose={() => setLicenseOpen(false)} />}
    </div>
  );
}

function NavigationGroup({ items, page, onNavigate }: { items: Page[]; page: Page; onNavigate: (page: Page) => void }): ReactNode {
  const { t, i18n } = useTranslation("common");
  const list = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState({ top: 0, height: 38, visible: false });
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const button = element.querySelector<HTMLButtonElement>(`[data-page="${page}"]`);
      if (button) setPill({ top: button.offsetTop, height: button.offsetHeight, visible: true });
      else setPill(previous => ({ ...previous, visible: false }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [page, i18n.language]);
  return <div className="nav-list" ref={list}>
    <span className="nav-active-pill" aria-hidden style={{ top: pill.top, height: pill.height, opacity: pill.visible ? 1 : 0 }} />
    {items.map(item => <button className={`nav-item ${page === item ? "active" : ""}`}
      type="button" key={item} data-page={item} data-testid={`nav-${item}`} onClick={() => onNavigate(item)}
      aria-current={page === item ? "page" : undefined}>
      <Icon name={item} size={19} /><span>{t(`nav.${item}`)}</span>
    </button>)}
  </div>;
}

function PageIntro({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }): ReactNode {
  return (
    <div className="page-intro">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{body}</p>
    </div>
  );
}

function EnhancePage({
  image,
  result,
  loading,
  error,
  scale,
  format,
  onChoose,
  onChooseResult,
  onDrop,
  onScale,
  onFormat,
  onRemove,
  onRemoveResult,
  onSavingChange,
  onOpenBatchUpscale,
  saving, engineBusy, task, aiError, aiNotice, model, tileSize, runtime, runtimeChecking,
  onModel, onTileSize, onSelectRuntime, onRefreshRuntime, onStart, onCancel,
}: {
  image: PreviewImage | null;
  result: PreviewImage | null;
  loading: boolean;
  error: string | null;
  scale: number;
  format: string;
  onChoose: () => void;
  onChooseResult: () => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onScale: (value: number) => void;
  onFormat: (value: string) => void;
  onRemove: () => void;
  onRemoveResult: () => void;
  onSavingChange: (saving: boolean) => void;
  onOpenBatchUpscale: () => void;
  saving: boolean;
  engineBusy: boolean;
  task: EnhancementTask | null;
  aiError: string | null;
  aiNotice: "complete" | "canceled" | null;
  model: UpscaleOptions["model"];
  tileSize: UpscaleOptions["tileSize"];
  runtime: UpscaleStatus | null;
  runtimeChecking: boolean;
  onModel: (model: UpscaleOptions["model"]) => void;
  onTileSize: (tileSize: UpscaleOptions["tileSize"]) => void;
  onSelectRuntime: () => void;
  onRefreshRuntime: () => void;
  onStart: () => void;
  onCancel: () => void;
}): ReactNode {
  const { t } = useTranslation(["common", "workspace"]);
  const { words, errorText } = useToolText();
  const locked = Boolean(task) || saving;
  const inputTooLarge = Boolean(image && (model === "real-hat-x4"
    ? image.width * image.height > 2_500_000 || Math.max(image.width, image.height) > 4096
    : image.width * image.height > 16_000_000 || Math.max(image.width, image.height) > 8192));
  return (
    <div className="page page-enhance">
      <PageIntro eyebrow={t("workspace:eyebrow")} title={t("workspace:title")} body={t("workspace:body")} />
      {error && <p className="workspace-message" role="alert">{t(`workspace:${error}`)}</p>}
      <div className="workspace-grid">
        <div className="canvas-column">
          <ImageViewer key={image?.id ?? "empty"} original={image} result={result} loading={loading} locked={locked}
            onChoose={onChoose} onChooseResult={onChooseResult} onDrop={onDrop}
            onRemove={onRemove} onRemoveResult={onRemoveResult} />
        </div>
        <aside className="inspector glass-panel">
          <div className="panel-heading">
            <div><span className="panel-icon"><Icon name="enhance" size={18} /></span><strong>{t("workspace:inspector")}</strong></div>
            <span className={`pending-dot ${!runtimeChecking && runtime?.ready ? "engine-ready" : ""}`} data-testid="enhance-runtime-status">{runtimeChecking ? words.upscaleChecking : runtime?.ready ? words.upscaleReady : words.upscaleMissing}</span>
          </div>
          <div className="scale-control">
            <div className="scale-heading"><label htmlFor="enhancement-scale">{t("workspace:scale")}</label><span className="scale-value"><ParameterNumber value={scale} min={2} max={4} step={1} onChange={onScale} label={t("workspace:scale")} testId="enhancement-scale-number" disabled={locked}/>×</span></div>
            <input id="enhancement-scale" className="enhance-scale-range" type="range" min={2} max={4} step={1}
              value={scale} disabled={locked} onChange={(event) => onScale(Number(event.target.value))} />
            <div className="scale-ticks" aria-hidden><span>2×</span><span>3×</span><span>4×</span></div>
          </div>
          <div className="ai-model-field"><label htmlFor="enhance-model">{words.upscaleModel}</label>
            <select id="enhance-model" data-testid="enhance-model" value={model} disabled={locked} onChange={event => onModel(event.target.value as UpscaleOptions["model"])}>
              <option value="real-hat-x4">{words.upscaleNatural}</option>
              <option value="realesrgan-x4plus">{t("workspace:ai.general")}</option>
              <option value="realesrgan-x4plus-anime">{t("workspace:ai.anime")}</option>
            </select>
            {model === "real-hat-x4" && <p className="ai-model-hint" data-testid="enhance-model-hint">{words.realhatHint}</p>}
          </div>
          <div className="ai-output-summary" data-testid="enhance-output-dimensions">{image ? `${image.width} × ${image.height} → ${image.width * scale} × ${image.height * scale}` : t("workspace:ai.chooseFirst")}</div>
          {inputTooLarge && <p className="ai-warning" role="alert">{t(model === "real-hat-x4" ? "workspace:ai.realhatInputLimit" : "workspace:ai.inputLimit")}</p>}
          <button className="primary-button ai-start" type="button" data-testid="enhance-start" disabled={!image || loading || locked || engineBusy || runtimeChecking || !runtime?.ready || inputTooLarge} onClick={onStart}>
            <Icon name="enhance" size={16} />{t(task ? "workspace:ai.running" : "workspace:ai.start")}
          </button>
          {engineBusy && <p className="ai-warning" role="status">{words.BUSY}</p>}
          {task && <section className="ai-progress" data-testid="enhance-progress" aria-live="polite">
            <div><span>{t(task.canceling ? "workspace:ai.canceling" : `workspace:ai.stage.${task.stage}`)}</span><strong>{task.percent === undefined ? "…" : `${Math.round(task.percent)}%`}</strong></div>
            <progress max={100} value={task.percent} aria-label={t("task.progress")} />
            <button type="button" className="text-button danger" data-testid="enhance-cancel" disabled={task.canceling} onClick={onCancel}>{t(task.canceling ? "workspace:ai.canceling" : "actions.cancel")}</button>
          </section>}
          {aiError && <p className="ai-warning" role="alert" data-testid="enhance-error">{aiError}</p>}
          {aiNotice && <p className="ai-complete" role="status" data-testid="enhance-notice">{t(`workspace:ai.${aiNotice}`, { width: result?.width, height: result?.height })}{aiNotice === "complete" && result?.largeId ? ` ${t("workspace:ai.largePreview")}` : ""}</p>}
          <details className="ai-runtime-settings" open={!runtime?.ready}>
            <summary>{t("workspace:ai.runtimeSettings")}</summary>
            <p>{words.upscaleScaleHint}</p>
            <label htmlFor="enhance-tile">{words.upscaleTile}</label>
            <select id="enhance-tile" data-testid="enhance-tile" value={tileSize} disabled={locked} onChange={event => onTileSize(Number(event.target.value) as UpscaleOptions["tileSize"])}>
              {[128, 256, 512].map(value => <option key={value} value={value}>{value} × {value}</option>)}
            </select>
            <p>{words.upscaleTileHint}</p>
            {!runtimeChecking && !runtime?.ready && runtime?.reason && <p className="ai-warning">{errorText(runtime.reason)}</p>}
            <div className="ai-runtime-actions"><button className="text-button" type="button" data-testid="enhance-runtime-select" disabled={locked || runtimeChecking} onClick={onSelectRuntime}>{model === "real-hat-x4" ? words.realhatChooseRuntime : words.upscaleChooseRuntime}</button>
              <button className="text-button" type="button" disabled={locked || runtimeChecking} onClick={onRefreshRuntime}>{words.upscaleRefresh}</button></div>
            <p>{model === "real-hat-x4" ? words.realhatLocalOnly : words.upscaleLocalOnly}</p>
          </details>
          <div className="safe-note"><Icon name="shield" size={16} /><span>{t("workspace:saveRule")}</span></div>
          <ControlGroup label={t("workspace:format")}>
            <Segmented values={["PNG", "JPG", "WEBP"]} value={format} onChange={onFormat} disabled={locked} />
          </ControlGroup>
          <OutputCompression original={image} comparison={result} format={format} disabled={Boolean(task)} onSavingChange={onSavingChange} />
          <button className="text-button ai-batch-link" type="button" data-testid="open-batch-upscale" onClick={onOpenBatchUpscale}>
            <Icon name="enhance" size={16} />{t("workspace:batchUpscale")}
          </button>
        </aside>
      </div>
    </div>
  );
}

function ControlGroup({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return <div className="control-group"><label>{label}</label>{children}</div>;
}

function Segmented({ values, value, labels, onChange, disabled = false }: { values: string[]; value: string; labels?: Record<string, string>; onChange: (value: string) => void; disabled?: boolean }): ReactNode {
  return <div className="segmented">{values.map((item) => <button type="button" className={item === value ? "selected" : ""} key={item} disabled={disabled} onClick={() => onChange(item)}>{labels?.[item] ?? item}</button>)}</div>;
}

function HistoryPage(): ReactNode {
  const { t } = useTranslation("history");
  const [entries, setEntries] = useState(getOutputHistory);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const refresh = () => setEntries(getOutputHistory());
    window.addEventListener("clarune:history-change", refresh);
    return () => window.removeEventListener("clarune:history-change", refresh);
  }, []);
  const outputAction = async (path: string, copy: boolean) => {
    const result = await (copy ? window.clarune.copyOutputPath(path) : window.clarune.openOutput(path)).catch(() => ({ ok: false }));
    setNotice(t(result.ok ? copy ? "copied" : "opened" : "unavailable"));
  };
  return <div className="page"><PageIntro eyebrow={t("eyebrow")} title={t("title")} body={t("body")} />
    {notice && <p className="workspace-message" role="status">{notice}</p>}
    {entries.length ? <section className="history-panel glass-panel">
      <header><span>{t("count", { count: entries.length })}</span><button type="button" className="text-button" onClick={() => { clearOutputHistory(); setNotice(t("cleared")); }}>{t("clear")}</button></header>
      <div className="history-list">{entries.map(entry => <article key={entry.id} className="history-entry" data-testid="history-entry">
        <div><strong title={entry.path}>{entry.path.split(/[\\/]/).pop()}</strong><small>{new Date(entry.createdAt).toLocaleString()} · {(entry.size / 1024 / 1024).toFixed(2)} MB{entry.width && entry.height ? ` · ${entry.width} × ${entry.height}` : ""}{entry.pages ? ` · ${t("pages", { count: entry.pages })}` : ""}</small><p>{entry.path}</p></div>
        <div className="history-actions"><button type="button" className="text-button" onClick={() => void outputAction(entry.path, false)}>{t("openFolder")}</button><button type="button" className="text-button" onClick={() => void outputAction(entry.path, true)}>{t("copyPath")}</button></div>
      </article>)}</div>
    </section> : <section className="empty-state glass-panel"><span className="empty-orbit"><Icon name="history" size={34} /></span><h2>{t("emptyTitle")}</h2><p>{t("emptyBody")}</p></section>}
  </div>;
}

function ModelsPage(): ReactNode {
  const { t } = useTranslation("models");
  return (
    <div className="page"><PageIntro eyebrow={t("eyebrow")} title={t("title")} body={t("body")} />
      <div className="models-grid">
        <section className="model-card glass-panel"><span className="model-art"><Icon name="models" size={30} /></span><div className="model-copy"><small>{t("candidate")}</small><h2>{t("candidateName")}</h2><p>{t("candidateMeta")}</p></div><span className="audit-badge">{t("notBundled")}</span></section>
        <section className="rule-card glass-panel"><span className="panel-icon"><Icon name="shield" size={20} /></span><div><h2>{t("ruleTitle")}</h2><p>{t("ruleBody")}</p></div></section>
      </div>
    </div>
  );
}

function SettingsPage({ theme, language, appInfo, density, onDensity, onTheme, onLanguage }: { theme: ThemeChoice; language: SupportedLanguage; appInfo: AppInfo; density: DensityChoice; onDensity: (density: DensityChoice) => void; onTheme: (theme: ThemeChoice) => void; onLanguage: (language: SupportedLanguage) => void }): ReactNode {
  const { t } = useTranslation("settings");
  return (
    <div className="page"><PageIntro eyebrow={t("eyebrow")} title={t("title")} body={t("body")} />
      <div className="settings-grid">
        <section className="settings-card glass-panel"><h2>{t("appearance")}</h2><ControlGroup label={t("theme")}><Segmented values={["system", "light", "dark"]} value={theme} labels={{ system: t("system"), light: t("light"), dark: t("dark") }} onChange={(value) => onTheme(value as ThemeChoice)} /></ControlGroup><ControlGroup label={t("language")}><div className="segmented language"><button type="button" className={language === "zh-CN" ? "selected" : ""} onClick={() => onLanguage("zh-CN")}>{t("chinese")}</button><button type="button" className={language === "en-US" ? "selected" : ""} onClick={() => onLanguage("en-US")}>{t("english")}</button></div></ControlGroup><ControlGroup label={t("density")}><Segmented values={["comfortable", "compact"]} value={density} labels={{ comfortable: t("comfortable"), compact: t("compact") }} onChange={value => onDensity(value as DensityChoice)} /></ControlGroup><p className="settings-recovery-note">{t("recoveryPrivacy")}</p></section>
        <section className="settings-card glass-panel"><div className="settings-heading"><h2>{t("safety")}</h2><span className="audit-badge">{t("planned")}</span></div><SettingPlan title={t("noOverwrite")} body={t("noOverwriteBody")} /><SettingPlan title={t("metadata")} body={t("metadataBody")} /><SettingPlan title={t("localOnly")} body={t("localOnlyBody")} /></section>
        <AboutCard name={appInfo.name} version={appInfo.version} />
      </div>
    </div>
  );
}

function SettingPlan({ title, body }: { title: string; body: string }): ReactNode {
  return <div className="setting-row"><span><strong>{title}</strong><small>{body}</small></span><Icon name="lock" size={14} /></div>;
}

export default App;
