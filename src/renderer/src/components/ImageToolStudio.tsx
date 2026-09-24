import { type CSSProperties, type DragEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BatchItemResult, BatchProgress, BatchSummary, CropRect, ImageEditOptions, ImageFormat, ProcessedImage, SavedFile, ToolId, UpscaleOptions, UpscaleStatus, WatermarkPosition } from "../../../shared/image-tools";
import { boundCrop, centeredCrop, resizedDimension, optionsForImage, normalizeParameter, localPreviewOptions, type ImageSize } from "../../../shared/image-tool-ui";
import { useToolText } from "../locales/tool-text";
import { recordOutputs } from "../lib/output-history";
import { cacheRecoveryImages, readStudioRecovery, writeStudioRecovery, type RecoveryImage, type StudioRecovery } from "../lib/studio-recovery";
import ImageToolCanvas from "./ImageToolCanvas";
import "./tool-studio.css";

interface LocalImage { id: string; name: string; bytes: Uint8Array; url: string; width: number; height: number; size: number }
interface Preview extends ProcessedImage { url: string; baseUrl?: string; overlayUrl?: string }
export interface StudioTask { id: string; kind: "batch" | "image" | "pdf"; completed: number; total: number; currentName?: string; canceling: boolean }
interface EditSnapshot { options: ImageEditOptions; cropReference: ImageSize | null; cropRatio: string; ratioLocked: boolean; disabledEdits: string[]; watermarkKind: "text" | "image"; watermarkImage: LocalImage | null }
const ACCEPT = "image/png,image/jpeg,image/webp";
const MAX_BYTES = 64 * 1024 * 1024;
const UPSCALE_DEFAULTS: UpscaleOptions = { scale: 4, model: "realesrgan-x4plus", tileSize: 256 };
const defaultOptions = (format: ImageFormat = "png", upscale = false): ImageEditOptions => ({ format, quality: format === "png" ? 100 : 90, ...(upscale ? { upscale: { ...UPSCALE_DEFAULTS } } : {}) });
const fullCrop = (image: LocalImage): CropRect => ({ left: 0, top: 0, width: image.width, height: image.height });
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;

export default function ImageToolStudio({ tool, batchMode = false, active = true, engineBusy = false, onToolChange, onTaskChange, onHistoryChange, externalCancelId }: { tool: ToolId; batchMode?: boolean; active?: boolean; engineBusy?: boolean; onToolChange?: (tool: ToolId) => void; onTaskChange?: (task: StudioTask | null) => void; onHistoryChange?: () => void; externalCancelId?: string | null }) {
  const { words: w, names, errorText } = useToolText();
  const [source, setSource] = useState<LocalImage | null>(null);
  const [images, setImages] = useState<LocalImage[]>([]);
  const [cropReference, setCropReference] = useState<ImageSize | null>(null);
  const [options, setOptions] = useState<ImageEditOptions>(defaultOptions);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState<"original" | "preview" | "crop">("preview");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedFile | null>(null);
  const [savedScope, setSavedScope] = useState<"image" | "pdf">("image");
  const [canceled, setCanceled] = useState(false);
  const [ratioLocked, setRatioLocked] = useState(true);
  const [cropRatio, setCropRatio] = useState("free");
  const [watermarkKind, setWatermarkKind] = useState<"text" | "image">("text");
  const [watermarkImage, setWatermarkImage] = useState<LocalImage | null>(null);
  const [pdfImages, setPdfImages] = useState<LocalImage[]>([]);
  const [pdfSize, setPdfSize] = useState<"image" | "a4" | "a4-landscape">("image");
  const [pdfQuality, setPdfQuality] = useState(90);
  const [fonts, setFonts] = useState<string[]>([]);
  const [fontsError, setFontsError] = useState(false);
  const [runtimeStatus, setUpscaleStatus] = useState<UpscaleStatus | null>(null);
  const [runtimeModel, setRuntimeModel] = useState<UpscaleOptions["model"] | null>(null);
  const [runtimeChecking, setRuntimeLoading] = useState(false);
  const runtimeRequest = useRef(0);
  const upscaleModel = options.upscale?.model ?? UPSCALE_DEFAULTS.model;
  const upscaleStatus = runtimeModel === upscaleModel ? runtimeStatus : null;
  const runtimeLoading = runtimeChecking || runtimeModel !== upscaleModel;
  const enteredUpscale = useRef(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchResults, setBatchResults] = useState<Record<string, BatchItemResult>>({});
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);
  const [retryIds, setRetryIds] = useState<string[]>([]);
  const [canceling, setCanceling] = useState(false);
  const [fontSearch, setFontSearch] = useState("");
  const [watermarkUnit, setWatermarkUnit] = useState<"percent" | "pixels">("percent");
  const [watermarkSnap, setWatermarkSnap] = useState(true);
  const [watermarkGuide, setWatermarkGuide] = useState(false);
  const [importIssues, setImportIssues] = useState<{ name: string; error: string }[]>([]);
  const [disabledEdits, setDisabledEdits] = useState<string[]>([]);
  const [undoStack, setUndoStack] = useState<EditSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditSnapshot[]>([]);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recovered, setRecovered] = useState<"queue" | "interrupted" | null>(null);
  const [recoveryError, setRecoveryError] = useState(false);
  const [recoverySuspended, setRecoverySuspended] = useState(false);
  const [exportKind, setExportKind] = useState<StudioTask["kind"]>("image");
  const taskCallback = useRef(onTaskChange); taskCallback.current = onTaskChange;
  const lastEdit = useRef({ key: "", at: 0 });
  const batchId = useRef<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const addImageInput = useRef<HTMLInputElement>(null);
  const watermarkInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const inspectorScroll = useRef<HTMLDivElement>(null);
  const ownedUrls = useRef(new Set<string>());
  const alive = useRef(true);
  const sourceRequest = useRef(0);
  const watermarkRequest = useRef(0);
  const previewVersion = useRef(0);
  const processing = useRef(false);
  const queuedPreview = useRef<{ version: number; bytes: Uint8Array; options: ImageEditOptions; previewLayers: boolean } | null>(null);
  const previewUrl = useRef<string | null>(null);
  const layerUrls = useRef<string[]>([]);
  const addBusy = useRef(false);

  function newUrl(blob: Blob) { const url = URL.createObjectURL(blob); ownedUrls.current.add(url); return url; }
  function releaseUrl(url?: string | null) { if (url) { URL.revokeObjectURL(url); ownedUrls.current.delete(url); } }
  const recipe = useMemo(() => {
    const next = { ...options };
    for (const key of disabledEdits) if (key in next) delete next[key as keyof ImageEditOptions];
    if (next.watermark && !next.watermark.image && !next.watermark.text?.trim()) next.watermark = undefined;
    return next;
  }, [options, disabledEdits]);
  const effectiveOptions = useMemo(() => source ? optionsForImage(recipe, cropReference, source, ratioLocked, cropRatio) : recipe, [recipe, cropReference, source, ratioLocked, cropRatio]);
  useEffect(() => {
    alive.current = true;
    return () => {
    alive.current = false;
    sourceRequest.current += 1;
    previewVersion.current += 1;
    queuedPreview.current = null;
    ownedUrls.current.forEach((url) => URL.revokeObjectURL(url));
    ownedUrls.current.clear();
    };
  }, []);

  useEffect(() => {
    void readStudioRecovery().then((stored) => {
      if (!alive.current || !stored) return;
      const restore = (image: RecoveryImage): LocalImage => ({ ...image, bytes: Uint8Array.from(image.bytes), url: newUrl(new Blob([Uint8Array.from(image.bytes)])) });
      const restored = stored.images.map(restore);
      setImages(restored); setSource(restored.find((image) => image.id === stored.sourceId) ?? restored[0] ?? null);
      setPdfImages(stored.pdfImages.map(restore)); setOptions(stored.options); setCropReference(stored.cropReference);
      setRatioLocked(stored.ratioLocked); setCropRatio(stored.cropRatio); setDisabledEdits(stored.disabledEdits ?? []);
      setWatermarkKind(stored.watermarkKind); setWatermarkImage(stored.watermarkImage ? restore(stored.watermarkImage) : null);
      setPdfSize(stored.pdfSize); setPdfQuality(stored.pdfQuality);
      setRecovered(stored.interrupted ? "interrupted" : "queue");
    }).catch(() => { if (alive.current) { setRecoveryError(true); setRecoverySuspended(true); } }).finally(() => { if (alive.current) { setRecoveryReady(true); setLoading(false); } });
  }, []);
  useLayoutEffect(() => {
    if (!recoveryReady || recoverySuspended) return;
    const strip = ({ url: _url, ...image }: LocalImage): RecoveryImage => image;
    const value: StudioRecovery | null = images.length || pdfImages.length ? {
      images: images.map(strip), pdfImages: pdfImages.map(strip), sourceId: source?.id, options, cropReference, ratioLocked, cropRatio,
      watermarkKind, watermarkImage: watermarkImage ? strip(watermarkImage) : null, pdfSize, pdfQuality, disabledEdits, interrupted: exporting || !!batchSummary?.canceled || recovered === "interrupted",
    } : null;
    try { void writeStudioRecovery(value).catch(() => { if (alive.current) setRecoveryError(true); }); }
    catch { setRecoveryError(true); }
  }, [recoveryReady, recoverySuspended, images, pdfImages, source, options, cropReference, ratioLocked, cropRatio, watermarkKind, watermarkImage, pdfSize, pdfQuality, disabledEdits, exporting, batchSummary, recovered]);
  useEffect(() => {
    taskCallback.current?.(exporting ? { id: batchId.current ?? "studio-export", kind: exportKind, completed: exportKind === "batch" ? batchProgress?.completed ?? 0 : 0,
      total: exportKind === "batch" ? batchProgress?.total ?? images.length : 1, currentName: exportKind === "batch" ? batchProgress?.currentName : exportKind === "image" ? source?.name : "Clarune-images.pdf", canceling } : null);
  }, [exporting, exportKind, batchProgress, canceling, images.length, source?.name]);
  useEffect(() => { if (externalCancelId && externalCancelId === batchId.current) setCanceling(true); }, [externalCancelId]);

  useEffect(() => {
    setMode(tool === "crop" ? "crop" : "preview");
    inspectorScroll.current?.scrollTo({ top: 0 });
  }, [tool]);
  useEffect(() => {
    if (tool !== "upscale" || !active) { enteredUpscale.current = false; return; }
    if (!recoveryReady || enteredUpscale.current) return;
    enteredUpscale.current = true;
    if (!options.upscale && !disabledEdits.includes("upscale")) change({ upscale: { ...UPSCALE_DEFAULTS } });
  }, [tool, active, recoveryReady, options.upscale, disabledEdits]);
  useEffect(() => {
    const refresh = () => { void refreshUpscaleStatus(); };
    refresh();
    window.addEventListener("clarune:upscale-runtime-change", refresh);
    return () => { runtimeRequest.current++; window.removeEventListener("clarune:upscale-runtime-change", refresh); };
  }, [upscaleModel]);
  useEffect(() => {
    void window.clarune.getSystemFonts().then((result) => {
      if (!alive.current) return;
      if (result.ok) setFonts(result.value); else setFontsError(true);
    }).catch(() => { if (alive.current) setFontsError(true); });
    return window.clarune.onBatchProgress((progress) => {
      if (progress.id !== batchId.current) return;
      setBatchProgress(progress);
      if (progress.item) setBatchResults((old) => ({ ...old, [progress.item!.id]: progress.item! }));
    });
  }, []);

  // One encoder request at a time. Edits made during an encode replace the queued job.
  useEffect(() => {
    const version = ++previewVersion.current;
    queuedPreview.current = null;
    if (!source) { setBusy(false); return; }
    setBusy(true);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      queuedPreview.current = { version, bytes: source.bytes, options: localPreviewOptions(effectiveOptions, source), previewLayers: tool === "watermark" };
      void drain();
    }, 220);
    async function drain() {
      if (processing.current) return;
      processing.current = true;
      try {
        while (queuedPreview.current && alive.current) {
          const job = queuedPreview.current;
          queuedPreview.current = null;
          try {
            let result = await window.clarune.processImage({ bytes: job.bytes, options: job.options, previewLayers: job.previewLayers });
            if (!result.ok && result.error === "BUSY" && alive.current && job.version === previewVersion.current) {
              await new Promise((resolve) => window.setTimeout(resolve, 350));
              if (alive.current && job.version === previewVersion.current) result = await window.clarune.processImage({ bytes: job.bytes, options: job.options, previewLayers: job.previewLayers });
            }
            if (!alive.current || job.version !== previewVersion.current) continue;
            if (result.ok) {
              const bytes = Uint8Array.from(result.value.bytes);
              const url = newUrl(new Blob([bytes], { type: `image/${result.value.format}` }));
              releaseUrl(previewUrl.current);
              previewUrl.current = url;
              layerUrls.current.forEach(releaseUrl); layerUrls.current = [];
              const baseUrl = result.value.watermarkLayers ? newUrl(new Blob([Uint8Array.from(result.value.watermarkLayers.base)])) : undefined;
              const overlayUrl = result.value.watermarkLayers ? newUrl(new Blob([Uint8Array.from(result.value.watermarkLayers.overlay)])) : undefined;
              layerUrls.current = [baseUrl, overlayUrl].filter((item): item is string => !!item);
              setPreview({ ...result.value, url, baseUrl, overlayUrl });
            } else setPreviewError(result.error);
            setBusy(false);
          } catch {
            if (alive.current && job.version === previewVersion.current) { setPreviewError("PROCESSING_FAILED"); setBusy(false); }
          }
        }
      } finally { processing.current = false; }
    }
    return () => window.clearTimeout(timer);
  }, [source, effectiveOptions, tool]);

  const crop = source ? effectiveOptions.crop ?? fullCrop(source) : { left: 0, top: 0, width: 1, height: 1 };
  const resize = options.resize ?? { width: crop.width, height: crop.height, fit: "fill" as const };
  const imageRatio = crop.width / crop.height;
  const outputSize = preview ? { width: preview.width, height: preview.height } : resize;
  const watermark = options.watermark;
  const watermarkTravel = { x: Math.max(0, outputSize.width - (preview?.watermarkBounds?.width ?? 0)), y: Math.max(0, outputSize.height - (preview?.watermarkBounds?.height ?? 0)) };
  const activeCropRatio = cropRatio === "original" && source ? source.width / source.height : cropRatio.includes(":") ? Number(cropRatio.split(":")[0]) / Number(cropRatio.split(":")[1]) : undefined;
  const radiusMax = Math.max(0.5, Math.min(outputSize.width, outputSize.height) / 2);
  const effectiveRadius = Math.min(options.radius ?? 0, radiusMax);
  const upscale = options.upscale ?? UPSCALE_DEFAULTS;
  const upscaleEnabled = !!recipe.upscale;
  const upscaleInputTooLarge = upscaleEnabled && (crop.width * crop.height > 2_500_000 || crop.width > 4096 || crop.height > 4096);
  const upscaleUnavailable = upscaleEnabled && (runtimeLoading || !upscaleStatus?.ready);
  const appliedEdits = (["upscale", "crop", "resize", "rotation", "flipHorizontal", "flipVertical", "watermark", "radius"] as const).filter((key) => !!options[key]);
  const editNames = { upscale: names.upscale, crop: names.crop, resize: names.resize, rotation: names.rotate, flipHorizontal: w.flipH, flipVertical: w.flipV, watermark: names.watermark, radius: names.round };

  async function refreshUpscaleStatus() {
    const request = ++runtimeRequest.current;
    setRuntimeLoading(true);
    try {
      const result = await window.clarune.getUpscaleStatus(upscaleModel);
      if (alive.current && request === runtimeRequest.current) {
        setUpscaleStatus(result.ok ? result.value : { ready: false, localOnly: true, reason: result.error });
        setRuntimeModel(upscaleModel);
      }
    } catch {
      if (alive.current && request === runtimeRequest.current) {
        setUpscaleStatus({ ready: false, localOnly: true, reason: upscaleModel === "real-hat-x4" ? "REALHAT_RUNTIME_NOT_CONFIGURED" : "UPSCALE_RUNTIME_NOT_CONFIGURED" });
        setRuntimeModel(upscaleModel);
      }
    } finally { if (alive.current && request === runtimeRequest.current) setRuntimeLoading(false); }
  }
  async function selectUpscaleRuntime() {
    if (engineBusy) return;
    const request = ++runtimeRequest.current;
    setRuntimeLoading(true); setError(null);
    try {
      const result = await window.clarune.selectUpscaleRuntime(upscaleModel);
      if (!alive.current) return;
      if (result.ok) {
        if (request === runtimeRequest.current) {
          setUpscaleStatus(result.value);
          setRuntimeModel(upscaleModel);
        }
        window.dispatchEvent(new Event("clarune:upscale-runtime-change"));
      } else if (request === runtimeRequest.current && !result.canceled) setError(result.error);
    } catch { if (alive.current && request === runtimeRequest.current) setError(upscaleModel === "real-hat-x4" ? "REALHAT_RUNTIME_NOT_CONFIGURED" : "UPSCALE_RUNTIME_NOT_CONFIGURED"); }
    finally { if (alive.current && request === runtimeRequest.current) setRuntimeLoading(false); }
  }

  function snapshot(): EditSnapshot { return { options, cropReference, cropRatio, ratioLocked, disabledEdits, watermarkKind, watermarkImage }; }
  function remember(key: string) {
    const now = Date.now();
    if (lastEdit.current.key !== key || now - lastEdit.current.at > 650) setUndoStack((old) => [...old.slice(-29), snapshot()]);
    lastEdit.current = { key, at: now }; setRedoStack([]);
  }
  async function restoreEdit(value: EditSnapshot) {
    if (value.watermarkImage) { setLoading(true); try { await cacheRecoveryImages([value.watermarkImage]); } catch { setRecoveryError(true); } finally { setLoading(false); } }
    setOptions(value.options); setCropReference(value.cropReference); setCropRatio(value.cropRatio); setRatioLocked(value.ratioLocked); setDisabledEdits(value.disabledEdits);
    setWatermarkKind(value.watermarkKind); setWatermarkImage(value.watermarkImage);
    setSaved(null); setBatchSummary(null); setBatchResults({}); lastEdit.current = { key: "", at: 0 };
  }
  function undo() { const previous = undoStack.at(-1); if (!previous) return; setRedoStack((old) => [...old, snapshot()]); setUndoStack((old) => old.slice(0, -1)); void restoreEdit(previous); }
  function redo() { const next = redoStack.at(-1); if (!next) return; setUndoStack((old) => [...old, snapshot()]); setRedoStack((old) => old.slice(0, -1)); void restoreEdit(next); }

  function change(patch: Partial<ImageEditOptions>) {
    remember(Object.keys(patch).join(","));
    setDisabledEdits((old) => old.filter((key) => !Object.keys(patch).includes(key)));
    if (source) setBusy(true);
    setPreviewError(null); setOptions((old) => ({ ...old, ...patch })); setSaved(null); setCanceled(false);
    setBatchSummary(null); setBatchResults({});
  }
  async function readImage(file: File): Promise<LocalImage> {
    if (!/\.(png|jpe?g|webp)$/i.test(file.name) && !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("invalidFile");
    if (file.size > MAX_BYTES) throw new Error("INPUT_TOO_LARGE");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const url = newUrl(file);
    try {
      const image = new Image(); image.src = url; await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("imageLoadError");
      if (image.naturalWidth > 16384 || image.naturalHeight > 16384 || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error("INPUT_TOO_LARGE");
      return { id: crypto.randomUUID(), name: file.name, bytes, url, width: image.naturalWidth, height: image.naturalHeight, size: file.size };
    } catch (cause) { releaseUrl(url); throw cause instanceof Error && cause.message === "INPUT_TOO_LARGE" ? cause : new Error("imageLoadError"); }
  }
  async function chooseImages(files: File[], append = true) {
    if (!files.length || addBusy.current || exporting) return;
    if ((append ? images.length : 0) + files.length > 60) { setError("tooMany"); return; }
    if ((append ? images.reduce((sum, image) => sum + image.size, 0) : 0) + files.reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024) { setError("batchTooLarge"); return; }
    const request = ++sourceRequest.current;
    addBusy.current = true;
    setLoading(true); setError(null); setImportIssues([]); setSaved(null); setCanceled(false);
    const loaded: LocalImage[] = [];
    const rejected: { name: string; error: string }[] = [];
    try {
      for (const file of files) {
        try { loaded.push(await readImage(file)); }
        catch (cause) { rejected.push({ name: file.name, error: cause instanceof Error ? cause.message : "imageLoadError" }); }
      }
      if (!alive.current || request !== sourceRequest.current) { loaded.forEach((image) => releaseUrl(image.url)); return; }
      setImportIssues(rejected);
      if (!loaded.length) return;
      try { await cacheRecoveryImages(loaded); } catch { setRecoveryError(true); }
      setRecoverySuspended(false);
      if (!append) images.forEach((image) => releaseUrl(image.url));
      if (!append) setRetryIds([]);
      setImages((old) => append ? [...old, ...loaded] : loaded);
      setBatchResults({}); setBatchSummary(null);
      if (!source || !append) {
        const image = loaded[0]!;
        releaseUrl(previewUrl.current); previewUrl.current = null;
        setSource(image); setCropReference({ width: image.width, height: image.height }); setPreview(null);
        const format: ImageFormat = /\.webp$/i.test(image.name) ? "webp" : /\.jpe?g$/i.test(image.name) ? "jpeg" : "png";
        setOptions(defaultOptions(format, tool === "upscale")); setRatioLocked(true); setCropRatio("free");
        setDisabledEdits([]); setUndoStack([]); setRedoStack([]);
        watermarkRequest.current += 1; setWatermarkImage(null); setWatermarkKind("text");
        setMode(tool === "crop" ? "crop" : "preview");
      }
    } catch (cause) { loaded.forEach((image) => releaseUrl(image.url)); if (request === sourceRequest.current) setError(cause instanceof Error ? cause.message : "imageLoadError"); }
    finally { addBusy.current = false; if (alive.current && request === sourceRequest.current) setLoading(false); }
  }
  function selectImage(image: LocalImage) {
    if (image.id === source?.id) return;
    sourceRequest.current += 1;
    setSource(image); setPreview(null); setSaved(null); setError(null); setPreviewError(null);
    releaseUrl(previewUrl.current); previewUrl.current = null;
  }
  function removeImage(image: LocalImage) {
    const next = images.filter((item) => item.id !== image.id);
    setImages(next); releaseUrl(image.url);
    setRetryIds((old) => old.filter((id) => id !== image.id));
    if (source?.id === image.id) {
      sourceRequest.current += 1; setSource(next[0] ?? null); setPreview(null);
      releaseUrl(previewUrl.current); previewUrl.current = null;
    }
    setSaved(null);
    setBatchSummary(null); setBatchResults({});
  }
  function clearImages() {
    sourceRequest.current += 1;
    images.forEach((image) => releaseUrl(image.url));
    setImages([]); setSource(null); setPreview(null); setCropReference(null); setSaved(null);
    releaseUrl(previewUrl.current); previewUrl.current = null;
    reset();
    setBatchResults({}); setBatchSummary(null); setBatchProgress(null);
    setRetryIds([]);
    setRecovered(null); setImportIssues([]);
  }
  async function chooseWatermark(file?: File) {
    if (!file || addBusy.current || exporting) return;
    const request = ++watermarkRequest.current;
    addBusy.current = true; setLoading(true); setError(null);
    try {
      const image = await readImage(file);
      if (!alive.current || request !== watermarkRequest.current) { releaseUrl(image.url); return; }
      try { await cacheRecoveryImages([image]); } catch { setRecoveryError(true); }
      if (!alive.current || request !== watermarkRequest.current) { releaseUrl(image.url); return; }
      change({ watermark: { ...watermarkDefaults(), ...watermark, text: undefined, image: image.bytes } });
      setWatermarkImage(image);
      setSaved(null); setCanceled(false);
      setBatchSummary(null); setBatchResults({});
    } catch (cause) { if (request === watermarkRequest.current) setError(cause instanceof Error ? cause.message : "imageLoadError"); }
    finally { addBusy.current = false; if (alive.current) setLoading(false); }
  }
  function reset() {
    remember("reset");
    watermarkRequest.current += 1;
    if (source) setBusy(true);
    setOptions(defaultOptions(options.format, tool === "upscale")); setRatioLocked(true); setCropRatio("free");
    setDisabledEdits([]);
    setWatermarkKind("text"); setWatermarkImage(null);
    setError(null); setSaved(null); setCanceled(false);
    setBatchSummary(null); setBatchResults({});
  }
  function resizeAxis(axis: "width" | "height", value: number) {
    change({ resize: { ...resizedDimension(value, axis, imageRatio, ratioLocked, resize), fit: "fill" } });
  }
  function setCrop(next: CropRect) { if (source) { setCropReference({ width: source.width, height: source.height }); change({ crop: boundCrop(next, source) }); } }
  function changeCropPreset(value: string) {
    if (value === "free") remember("crop-preset");
    setCropRatio(value);
    if (!source || value === "free") return;
    const ratio = value === "original" ? source.width / source.height : Number(value.split(":")[0]) / Number(value.split(":")[1]);
    setCrop(centeredCrop(source, ratio));
  }
  function watermarkDefaults() {
    return { text: "EVEING", color: "#ffffff", opacity: 0.65, fontSize: Math.max(12, Math.round(outputSize.width / 24)), imageScale: 0.2, position: "bottom-right" as WatermarkPosition, fontFamily: undefined, x: 0.5, y: 0.5 };
  }
  function changeWatermark(patch: Partial<NonNullable<ImageEditOptions["watermark"]>>) {
    change({ watermark: { ...watermarkDefaults(), ...watermark, ...patch } });
  }
  function changeWatermarkKind(kind: "text" | "image") {
    watermarkRequest.current += 1;
    setWatermarkKind(kind);
    if (watermark) changeWatermark({ text: kind === "text" ? "EVEING" : undefined, image: kind === "image" ? watermarkImage?.bytes : undefined });
  }
  async function saveImage() {
    if (!source || exporting || engineBusy || (upscaleEnabled && runtimeLoading)) return;
    if (upscaleUnavailable) { setError(upscaleStatus?.reason ?? (upscaleModel === "real-hat-x4" ? "REALHAT_RUNTIME_NOT_CONFIGURED" : "UPSCALE_RUNTIME_NOT_CONFIGURED")); return; }
    if (upscaleInputTooLarge) { setError("UPSCALE_INPUT_TOO_LARGE"); return; }
    const sourceVersion = sourceRequest.current;
    setExportKind("image"); setExporting(true); setError(null); setSaved(null); setCanceled(false); setSavedScope("image");
    const ext = options.format === "jpeg" ? "jpg" : options.format;
    try {
      const result = await window.clarune.saveImage({ bytes: source.bytes, options: effectiveOptions }, `${source.name.replace(/\.[^.]+$/, "")}-clarune.${ext}`);
      if (!alive.current || sourceVersion !== sourceRequest.current) return;
      if (result.ok) { setSaved(result.value); recordOutputs([result.value], "image"); onHistoryChange?.(); } else if (result.canceled) setCanceled(true); else setError(result.error);
    } catch { if (alive.current && sourceVersion === sourceRequest.current) setError("WRITE_FAILED"); }
    finally { if (alive.current) setExporting(false); }
  }
  async function saveBatch(failedOnly = false) {
    if (!images.length || exporting || engineBusy || (upscaleEnabled && runtimeLoading)) return;
    if (upscaleUnavailable) { setError(upscaleStatus?.reason ?? (upscaleModel === "real-hat-x4" ? "REALHAT_RUNTIME_NOT_CONFIGURED" : "UPSCALE_RUNTIME_NOT_CONFIGURED")); return; }
    const selected = failedOnly ? images.filter((image) => retryIds.includes(image.id)) : images;
    if (!selected.length) return;
    const payloadBytes = selected.reduce((sum, image) => sum + image.size, 0) + (recipe.watermark?.image?.length ?? 0) * selected.length;
    if (payloadBytes > 128 * 1024 * 1024) { setError("batchPayloadTooLarge"); return; }
    const id = crypto.randomUUID(); batchId.current = id;
    setExportKind("batch"); setExporting(true); setCanceling(false); setError(null); setSaved(null); setCanceled(false); setRecovered(null);
    setBatchSummary(null); if (!failedOnly) setBatchResults({}); setBatchProgress({ id, completed: 0, total: selected.length });
    try {
      const result = await window.clarune.saveBatch({ id, images: selected.map((image) => ({ id: image.id, name: image.name, bytes: image.bytes, options: optionsForImage(recipe, cropReference, image, ratioLocked, cropRatio) })) });
      if (!alive.current) return;
      if (result.ok) {
        setBatchSummary(result.value);
        setRetryIds(result.value.items.filter((item) => item.status === "failed").map((item) => item.id));
        setBatchResults((old) => ({ ...(failedOnly ? old : {}), ...Object.fromEntries(result.value.items.map((item) => [item.id, item])) }));
        recordOutputs(result.value.items.flatMap((item) => item.status === "saved" && item.file ? [item.file] : []), "batch"); onHistoryChange?.();
      } else if (result.canceled) { setCanceled(true); setSavedScope("image"); } else setError(result.error);
    } catch { if (alive.current) setError("WRITE_FAILED"); }
    finally { batchId.current = null; if (alive.current) { setExporting(false); setCanceling(false); } }
  }
  async function cancelBatch() {
    if (!batchId.current || canceling) return;
    setCanceling(true);
    try {
      const result = await window.clarune.cancelBatch(batchId.current);
      if (!result.ok) { setError(result.error); setCanceling(false); }
    } catch { setError("PROCESSING_FAILED"); setCanceling(false); }
  }
  async function addPdfFiles(files: File[]) {
    if (!files.length || addBusy.current) return;
    if (pdfImages.length + files.length > 60) { setError("tooMany"); return; }
    if (pdfImages.reduce((sum, image) => sum + image.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024) { setError("pdfTooLarge"); return; }
    addBusy.current = true; setLoading(true); setError(null); setImportIssues([]); setSaved(null); setCanceled(false);
    const loaded: LocalImage[] = [];
    const rejected: { name: string; error: string }[] = [];
    try {
      for (const file of files) {
        try { loaded.push(await readImage(file)); }
        catch (cause) { rejected.push({ name: file.name, error: cause instanceof Error ? cause.message : "imageLoadError" }); }
      }
      if (!alive.current) { loaded.forEach((image) => releaseUrl(image.url)); return; }
      setImportIssues(rejected);
      try { await cacheRecoveryImages(loaded); } catch { setRecoveryError(true); }
      setRecoverySuspended(false);
      setPdfImages((images) => [...images, ...loaded]);
    } catch (cause) { loaded.forEach((image) => releaseUrl(image.url)); setError(cause instanceof Error ? cause.message : "imageLoadError"); }
    finally { addBusy.current = false; if (alive.current) setLoading(false); }
  }
  function movePdf(index: number, direction: number) {
    setPdfImages((old) => { const next = [...old]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; return next; });
    setSaved(null);
  }
  async function savePdf() {
    if (!pdfImages.length || exporting || engineBusy) return;
    setExportKind("pdf"); setExporting(true); setError(null); setSaved(null); setCanceled(false); setSavedScope("pdf");
    try {
      const result = await window.clarune.savePdf({ images: pdfImages.map(({ name, bytes }) => ({ name, bytes })), pageSize: pdfSize, quality: pdfQuality }, "Clarune-images.pdf");
      if (result.ok) { setSaved(result.value); recordOutputs([result.value], "pdf"); onHistoryChange?.(); } else if (result.canceled) setCanceled(true); else setError(result.error);
    } catch { setError("WRITE_FAILED"); }
    finally { if (alive.current) setExporting(false); }
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (exporting || loading) return;
    const files = Array.from(event.dataTransfer.files);
    if (tool === "pdf") void addPdfFiles(files); else void chooseImages(files);
  }
  async function outputAction(path: string, copy = false) {
    const result = copy ? await window.clarune.copyOutputPath(path) : await window.clarune.openOutput(path);
    if (!result.ok) setError(result.error);
  }

  return <section className="tool-studio" data-testid="image-tool-studio" data-tool={tool} data-batch-mode={batchMode}>
    <header className="tool-page-heading">
      <div><span className="tool-eyebrow">{w.eyebrow}</span><h1>{batchMode ? w.batchTitle : names[tool]}</h1><p>{batchMode ? w.batchSubtitle : w.subtitle}</p></div>
      <button className="tool-button" onClick={() => tool === "pdf" ? pdfInput.current?.click() : source ? addImageInput.current?.click() : imageInput.current?.click()} disabled={loading || exporting} data-testid={source && tool !== "pdf" ? "tool-add" : "tool-choose"}>＋ {tool === "pdf" || source ? w.addImages : w.choose}</button>
    </header>
    {batchMode && <nav className="tool-batch-tools" aria-label={w.controls}>{(["upscale", "resize", "compress", "crop", "watermark", "round", "rotate", "flip"] as const).map((item) => <button className={`tool-button ${item === "upscale" ? "tool-ai-tab" : ""}`} key={item} aria-pressed={tool === item} onClick={() => onToolChange?.(item)} disabled={exporting} data-testid={`batch-tool-${item}`}>{item === "upscale" && <span aria-hidden="true">✧ </span>}{names[item]}</button>)}</nav>}
    {recovered && <div className="tool-save-status" role="status" data-testid="recovery-notice"><span>{recovered === "interrupted" ? w.recoveredInterrupted : w.recoveredQueue}</span><button className="tool-text-button" onClick={() => setRecovered(null)}>{w.dismiss}</button></div>}
    {recoveryError && <div className="tool-alert" role="status"><span>{w.recoveryError}</span>{recoverySuspended && <button className="tool-text-button" onClick={() => { setRecoverySuspended(false); setRecoveryError(false); }}>{w.clearRecovery}</button>}</div>}
    {!!importIssues.length && <details className="tool-import-issues" data-testid="import-issues"><summary>{w.importSkipped} ({importIssues.length})</summary><ul>{importIssues.map((item, index) => <li key={`${item.name}-${index}`}><strong>{item.name}</strong> · {errorText(item.error)}</li>)}</ul></details>}
    {(error || previewError && tool !== "pdf") && <div className="tool-alert" role="alert" data-testid="tool-error">{errorText(error ?? previewError!)}{previewError && tool !== "pdf" && <button className="tool-text-button" onClick={() => setOptions((old) => ({ ...old }))} data-testid="tool-preview-retry">{w.retryPreview}</button>}</div>}
    {(saved || canceled) && savedScope === (tool === "pdf" ? "pdf" : "image") && <div className="tool-save-status" role="status" data-testid="tool-save-status">
      {saved ? <><strong>{w.saved}</strong><span>{saved.path}</span><small>{formatSize(saved.size)}{saved.pages ? ` · ${saved.pages} ${w.pages}` : saved.width && saved.height ? ` · ${saved.width} × ${saved.height}` : ""}</small><button className="tool-text-button" onClick={() => void outputAction(saved.path)} data-testid="tool-open-output">{w.openFolder}</button><button className="tool-text-button" onClick={() => void outputAction(saved.path, true)} data-testid="tool-copy-output">{w.copyPath}</button></> : w.canceled}
    </div>}
    {batchSummary && tool !== "pdf" && <div className="tool-save-status" role="status" data-testid="batch-summary"><strong>{batchSummary.canceled ? w.batchCanceled : batchSummary.items.every((item) => item.status === "failed") ? w.batchAllFailed : batchSummary.items.some((item) => item.status === "failed") ? w.batchPartial : w.batchFinished}</strong><span>{batchSummary.directory}</span><small>{w.batchSaved} {batchSummary.items.filter((item) => item.status === "saved").length} · {w.batchFailed} {batchSummary.items.filter((item) => item.status === "failed").length}</small>{batchSummary.items.some((item) => item.file) && <button className="tool-text-button" onClick={() => void outputAction(batchSummary.items.find((item) => item.file)!.file!.path)}>{w.openFolder}</button>}{batchSummary.items.some((item) => item.status === "failed") && <button className="tool-text-button" disabled={exporting} onClick={() => void saveBatch(true)} data-testid="batch-retry-failed">{w.retryFailed}</button>}</div>}
    <div className="tool-workspace">
      {tool === "pdf" ? <section className="tool-pdf-canvas glass-panel" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
        <div className="tool-canvas-toolbar"><strong>{pdfImages.length} {w.pdfCount}</strong><button className="tool-text-button" disabled={!pdfImages.length || exporting || loading} onClick={() => { pdfImages.forEach((image) => releaseUrl(image.url)); setPdfImages([]); setSaved(null); }} data-testid="pdf-clear">{w.removeAll}</button></div>
        {!pdfImages.length ? <button className="tool-empty" onClick={() => pdfInput.current?.click()} disabled={loading || exporting}><span className="tool-empty-symbol">▧</span><strong>{loading ? w.loading : w.pdfEmpty}</strong><small>{w.pdfSupport}</small></button> : <div className="tool-pdf-list" data-testid="pdf-list">
          {pdfImages.map((image, index) => <article className="tool-pdf-item" key={image.id} data-testid="pdf-item">
            <span className="tool-pdf-index">{index + 1}</span><img src={image.url} alt=""/><div><strong title={image.name}>{image.name}</strong><small>{image.width} × {image.height} · {formatSize(image.size)}</small></div>
            <div className="tool-pdf-actions"><button title={w.moveUp} aria-label={`${w.moveUp}: ${image.name}`} disabled={index === 0 || exporting || loading} onClick={() => movePdf(index, -1)} data-testid={`pdf-up-${index}`}>↑</button><button title={w.moveDown} aria-label={`${w.moveDown}: ${image.name}`} disabled={index === pdfImages.length - 1 || exporting || loading} onClick={() => movePdf(index, 1)} data-testid={`pdf-down-${index}`}>↓</button><button title={w.remove} aria-label={`${w.remove}: ${image.name}`} disabled={exporting || loading} onClick={() => { releaseUrl(image.url); setPdfImages((old) => old.filter((item) => item.id !== image.id)); setSaved(null); }} data-testid={`pdf-remove-${index}`}>×</button></div>
          </article>)}
        </div>}
        <p className="tool-canvas-note">{loading ? w.loading : w.pdfOrder}</p>
      </section> : <section className="tool-canvas glass-panel" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
        <div className="tool-canvas-toolbar"><div className="tool-segments" aria-label={w.preview}>
          <button aria-pressed={mode === "original"} onClick={() => setMode("original")} disabled={!source} data-testid="tool-show-original">{w.original}</button>
          {tool === "crop" && <button aria-pressed={mode === "crop"} onClick={() => setMode("crop")} disabled={!source} data-testid="tool-show-crop">{w.cropView}</button>}
          <button aria-pressed={mode === "preview"} onClick={() => setMode("preview")} disabled={!source} data-testid="tool-show-preview">{upscaleEnabled ? w.upscaleLocalPreview : w.preview}</button>
        </div><span className={`tool-processing-indicator ${busy || loading ? "is-busy" : ""}`} aria-live="polite">{loading ? w.loading : busy ? w.processing : source && preview ? `${preview.width} × ${preview.height}` : ""}</span></div>
        {!source ? <div className="tool-image-surface" data-testid="tool-image-surface"><button className="tool-empty" onClick={() => imageInput.current?.click()} disabled={loading || exporting}><span className="tool-empty-symbol">＋</span><strong>{loading ? w.loading : w.empty}</strong><small>{w.supported}</small></button></div> : <ImageToolCanvas
          source={{ ...(mode === "preview" && preview ? preview : source), id: source.id, name: source.name }}
          mode={mode === "crop" ? "crop" : tool === "watermark" && mode === "preview" ? "watermark" : "preview"}
          busy={busy || exporting} crop={crop} cropRatio={activeCropRatio} onCropChange={setCrop}
          watermarkBounds={mode === "preview" && !busy && !previewError ? preview?.watermarkBounds : undefined}
          watermarkBaseUrl={preview?.baseUrl} watermarkOverlayUrl={preview?.overlayUrl} watermarkRadius={effectiveOptions.radius}
          watermarkSnap={watermarkSnap} watermarkGuide={watermarkGuide}
          onWatermarkPosition={({ x, y }) => changeWatermark({ position: "custom", x, y })}
        />}
        <footer className="tool-canvas-footer"><div><strong title={source?.name}>{source?.name ?? w.local}</strong>{source && <small>{source.width} × {source.height} · {formatSize(source.size)}</small>}</div>{source && <button className="tool-text-button" onClick={reset} disabled={exporting || loading} data-testid="tool-reset">{w.reset}</button>}</footer>
        <p className="tool-canvas-note" data-testid="tool-preview-note">{mode === "crop" ? w.cropHint : upscaleEnabled ? w.upscalePreviewHint : w.recipeHint}</p>
        {!!images.length && <section className="tool-image-queue" aria-label={w.batchQueue}>
          <div className="tool-queue-toolbar"><strong>{w.batchQueue} · {images.length}</strong><div><button className="tool-text-button" onClick={() => imageInput.current?.click()} disabled={exporting || loading} data-testid="tool-choose">{w.replaceList}</button><button className="tool-text-button" onClick={clearImages} disabled={exporting || loading} data-testid="batch-clear">{w.removeAll}</button></div></div>
          <div className="tool-queue-strip">{images.map((image, index) => <article className={`tool-queue-item ${image.id === source?.id ? "is-selected" : ""}`} key={image.id} data-testid="batch-item">
            <button className="tool-queue-select" onClick={() => selectImage(image)} disabled={exporting || loading} aria-pressed={image.id === source?.id} title={`${image.name}${batchResults[image.id]?.error ? ` · ${errorText(batchResults[image.id].error!)}` : ""}`} data-testid={`batch-select-${index}`}><img src={image.url} alt=""/><span>{image.name}</span><small className={batchResults[image.id]?.status === "failed" ? "has-error" : ""}>{batchResults[image.id] ? batchResults[image.id].status === "failed" ? errorText(batchResults[image.id].error ?? "PROCESSING_FAILED") : batchResults[image.id].status === "saved" ? w.batchSaved : w.batchCanceled : `${image.width} × ${image.height}`}</small></button>
            <button className="tool-queue-remove" aria-label={`${w.remove}: ${image.name}`} onClick={() => removeImage(image)} disabled={exporting || loading} data-testid={`batch-remove-${index}`}>×</button>
          </article>)}</div>
        </section>}
      </section>}
      <aside className="tool-inspector glass-panel">
        <div className="tool-inspector-scroll" ref={inspectorScroll}>
        {tool !== "pdf" && (tool === "upscale" || upscaleEnabled) && <section className="tool-upscale-runtime" data-testid="tool-upscale-runtime">
          <div><strong>{w.upscaleEngine}</strong><span className={!runtimeLoading && upscaleStatus?.ready ? "is-ready" : ""} role="status" data-testid="tool-upscale-status">{runtimeLoading ? w.upscaleChecking : upscaleStatus?.ready ? w.upscaleReady : w.upscaleMissing}</span></div>
          <p>{w.upscaleBoundary}</p>
          <div className="tool-upscale-runtime-actions"><button className="tool-text-button" disabled={runtimeLoading || exporting || loading || engineBusy} onClick={() => void selectUpscaleRuntime()} data-testid="tool-upscale-runtime-select">{upscaleModel === "real-hat-x4" ? w.realhatChooseRuntime : w.upscaleChooseRuntime}</button><button className="tool-text-button" disabled={runtimeLoading || exporting} onClick={() => void refreshUpscaleStatus()} data-testid="tool-upscale-runtime-refresh">{w.upscaleRefresh}</button></div>
          <details className="tool-upscale-runtime-details"><summary>{w.upscaleRuntimeDetails}</summary><p>{upscaleModel === "real-hat-x4" ? w.realhatLocalOnly : w.upscaleLocalOnly}</p>{!runtimeLoading && !upscaleStatus?.ready && upscaleStatus?.reason && <p className="tool-upscale-warning">{errorText(upscaleStatus.reason)}</p>}</details>
        </section>}
        <fieldset disabled={exporting || loading || (tool !== "pdf" && !source)}>
          <div className="tool-inspector-title"><span>✧</span><h2>{tool === "pdf" ? w.pdfSettings : w.controls}</h2></div>
          {tool === "pdf" ? <>
            <label className="tool-field">{w.pageSize}<select value={pdfSize} onChange={(event) => { setPdfSize(event.target.value as "image" | "a4" | "a4-landscape"); setSaved(null); }} data-testid="pdf-page-size"><option value="image">{w.imagePage}</option><option value="a4">{w.a4Page}</option><option value="a4-landscape">{w.a4Landscape}</option></select></label>
            <Range label={w.pdfQuality} value={pdfQuality} min={1} max={100} step={0.1} suffix="%" testId="pdf-quality" onChange={(value) => { setPdfQuality(value); setSaved(null); }}/>
            <p className="tool-help">{w.pdfHint}</p>
          </> : <>
            <div className="tool-edit-history"><button className="tool-button" disabled={!undoStack.length} onClick={undo} data-testid="tool-undo">↶ {w.undo}</button><button className="tool-button" disabled={!redoStack.length} onClick={redo} data-testid="tool-redo">↷ {w.redo}</button></div>
            {!!appliedEdits.length && <details className="tool-applied-edits" data-testid="tool-applied-edits"><summary>{w.appliedEdits} ({appliedEdits.filter((key) => !disabledEdits.includes(key)).length})</summary>{appliedEdits.map((key) => <label className="tool-toggle" key={key}><input type="checkbox" checked={!disabledEdits.includes(key)} onChange={(event) => { remember(`enabled-${key}`); setDisabledEdits((old) => event.target.checked ? old.filter((item) => item !== key) : [...old, key]); setSaved(null); }} data-testid={`edit-enabled-${key}`}/>{editNames[key]}</label>)}</details>}
            {tool === "upscale" && <div className="tool-edit-group tool-upscale-controls">
              <label className="tool-toggle"><input type="checkbox" checked={upscaleEnabled} onChange={(event) => { if (event.target.checked) change({ upscale: { ...upscale } }); else { remember("enabled-upscale"); setDisabledEdits((old) => [...old.filter((key) => key !== "upscale"), "upscale"]); setSaved(null); } }} data-testid="tool-upscale-enabled"/><span>{w.upscaleOn}</span></label>
              <Range label={w.upscaleScale} value={upscale.scale} min={2} max={4} step={1} suffix="×" testId="tool-upscale-scale" onChange={(scale) => change({ upscale: { ...upscale, scale: scale as 2 | 3 | 4 } })}/>
              <div className="tool-range-ticks"><span>2×</span><span>3×</span><span>4×</span></div>
              <label className="tool-field">{w.upscaleModel}<select value={upscale.model} onChange={(event) => { change({ upscale: { ...upscale, model: event.target.value as UpscaleOptions["model"] } }); setError(null); }} data-testid="tool-upscale-model"><option value="real-hat-x4">{w.upscaleNatural}</option><option value="realesrgan-x4plus">{w.upscaleGeneral}</option><option value="realesrgan-x4plus-anime">{w.upscaleAnime}</option></select></label>
              {upscaleModel === "real-hat-x4" && <p className="tool-help" data-testid="tool-upscale-model-hint">{w.realhatHint}</p>}
              <label className="tool-field">{w.upscaleTile}<select value={upscale.tileSize} onChange={(event) => change({ upscale: { ...upscale, tileSize: Number(event.target.value) as UpscaleOptions["tileSize"] } })} data-testid="tool-upscale-tile">{([128, 256, 512] as const).map((size) => <option key={size} value={size}>{size} px</option>)}</select></label>
              <p className="tool-help">{w.upscaleTileHint}</p><p className="tool-help">{w.upscaleScaleHint}</p>
              <p className={`tool-help ${upscaleInputTooLarge ? "tool-upscale-warning" : ""}`} data-testid="tool-upscale-limit">{w.upscaleLimit}{source && ` ${w.upscaleCurrentInput}: ${(crop.width * crop.height / 1_000_000).toFixed(2)} MP`}</p>
              {upscaleEnabled && recipe.resize && <p className="tool-help tool-upscale-warning">{w.upscaleResizeWarning}</p>}
            </div>}
            {tool === "resize" && <div className="tool-edit-group">
              <h3>{w.dimensions}</h3><div className="tool-two-columns"><NumberField label={w.width} value={resize.width} max={16384} onChange={(value) => resizeAxis("width", value)} testId="tool-width"/><NumberField label={w.height} value={resize.height} max={16384} onChange={(value) => resizeAxis("height", value)} testId="tool-height"/></div>
              <label className="tool-toggle"><input type="checkbox" checked={ratioLocked} onChange={(event) => { if (!event.target.checked) remember("ratio-lock"); setRatioLocked(event.target.checked); if (event.target.checked) change({ resize: { ...resizedDimension(resize.width, "width", imageRatio, true, resize), fit: "fill" } }); }} data-testid="tool-aspect-lock"/><span>{w.lockRatio}</span><small>{crop.width}:{crop.height}</small></label>
              <button className="tool-text-button" onClick={() => change({ resize: undefined })}>{options.crop ? w.cropSize : w.originalSize}</button>
              {images.length > 1 && <p className="tool-help">{w.batchResizeHint}</p>}
            </div>}
            {tool === "crop" && <div className="tool-edit-group">
              <label className="tool-field">{w.cropPreset}<select value={cropRatio} onChange={(event) => changeCropPreset(event.target.value)} data-testid="tool-crop-preset"><option value="free">{w.free}</option><option value="original">{w.imageRatio}</option>{["1:1", "4:3", "3:2", "16:9", "9:16"].map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label>
              <div className="tool-two-columns">{([['left', w.left], ['top', w.top], ['width', w.width], ['height', w.height]] as const).map(([key, label]) => <NumberField key={key} label={label} min={key === "left" || key === "top" ? 0 : 1} max={source ? key === "left" || key === "width" ? source.width : source.height : 1} value={crop[key]} onChange={(value) => { setCropRatio("free"); setCrop({ ...crop, [key]: value }); }} testId={`tool-crop-${key}`}/>)}</div>
              <button className="tool-text-button" onClick={() => { change({ crop: undefined }); setCropRatio("free"); }} data-testid="tool-crop-clear">{w.cropClear}</button><p className="tool-help">{w.cropHint}</p>{images.length > 1 && <p className="tool-help">{w.batchCropHint}</p>}
            </div>}
            {tool === "watermark" && <div className="tool-edit-group">
              <label className="tool-toggle"><input type="checkbox" checked={!!watermark} onChange={(event) => { watermarkRequest.current += 1; change({ watermark: event.target.checked ? { ...watermarkDefaults(), text: watermarkKind === "text" ? "EVEING" : undefined, image: watermarkKind === "image" ? watermarkImage?.bytes : undefined } : undefined }); }} data-testid="tool-watermark-enabled"/><span>{w.watermarkOn}</span></label>
              <div className="tool-segments"><button aria-pressed={watermarkKind === "text"} onClick={() => changeWatermarkKind("text")} data-testid="tool-watermark-text-mode">{w.text}</button><button aria-pressed={watermarkKind === "image"} onClick={() => changeWatermarkKind("image")} data-testid="tool-watermark-image-mode">{w.image}</button></div>
              {watermarkKind === "text" ? <><label className="tool-field">{w.watermarkText}<input type="text" maxLength={160} value={watermark?.text ?? ""} placeholder={w.watermarkPlaceholder} onChange={(event) => changeWatermark({ text: event.target.value, image: undefined })} data-testid="tool-watermark-text"/></label><label className="tool-field">{w.fontSearch}<input type="search" value={fontSearch} onChange={(event) => setFontSearch(event.target.value)} placeholder={w.fontSearch} data-testid="tool-font-search"/></label><label className="tool-field">{w.fontFamily}<select value={watermark?.fontFamily ?? ""} onChange={(event) => changeWatermark({ fontFamily: event.target.value || undefined })} data-testid="tool-watermark-font-family"><option value="">{w.defaultFont}</option>{fonts.filter((font) => font === watermark?.fontFamily || font.toLocaleLowerCase().includes(fontSearch.toLocaleLowerCase())).map((font) => <option key={font} value={font}>{font}</option>)}</select></label><div className="tool-font-preview" style={{ fontFamily: watermark?.fontFamily ? `"${watermark.fontFamily.replaceAll('"', '')}"` : undefined }} data-testid="tool-font-preview"><small>{w.fontPreview}</small><span>{watermark?.text || "澄像 Clarune Aa 0123"}</span></div>{fontSearch && !fonts.some((font) => font.toLocaleLowerCase().includes(fontSearch.toLocaleLowerCase())) && <p className="tool-help">{w.noFonts}</p>}{fontsError && <p className="tool-help">{w.fontsUnavailable}</p>}<div className="tool-two-columns"><NumberField label={w.fontSize} min={8} max={1024} value={watermark?.fontSize ?? watermarkDefaults().fontSize} onChange={(value) => changeWatermark({ fontSize: value })} testId="tool-watermark-font-size"/><label className="tool-field">{w.color}<input type="color" value={watermark?.color ?? "#ffffff"} onChange={(event) => changeWatermark({ color: event.target.value })} data-testid="tool-watermark-color"/></label></div></> : <><button className="tool-button tool-watermark-picker" onClick={() => watermarkInput.current?.click()} data-testid="tool-watermark-choose">{watermarkImage && <img src={watermarkImage.url} alt=""/>}{watermarkImage ? w.watermarkReplace : w.watermarkChoose}</button><p className="tool-help">{w.watermarkImageHint}</p>{!watermarkImage && <p className="tool-help">{w.watermarkMissing}</p>}<Range label={w.imageScale} value={(watermark?.imageScale ?? 0.2) * 100} min={1} max={100} step={0.1} suffix="%" testId="tool-watermark-scale" onChange={(value) => changeWatermark({ imageScale: value / 100, text: undefined, image: watermarkImage?.bytes })}/></>}
              <Range label={w.opacity} value={(watermark?.opacity ?? 0.65) * 100} min={0} max={100} step={0.1} suffix="%" testId="tool-watermark-opacity" onChange={(value) => changeWatermark({ opacity: value / 100 })}/>
              <label className="tool-field">{w.position}<select value={watermark?.position ?? "bottom-right"} onChange={(event) => changeWatermark({ position: event.target.value as WatermarkPosition })} data-testid="tool-watermark-position">{([['top-left', w.topLeft], ['top-right', w.topRight], ['center', w.center], ['bottom-left', w.bottomLeft], ['bottom-right', w.bottomRight], ['custom', w.customPosition]] as const).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              {watermark?.position === "custom" && <><label className="tool-field">{w.watermarkUnit}<select value={watermarkUnit} onChange={(event) => setWatermarkUnit(event.target.value as "percent" | "pixels")} data-testid="tool-watermark-unit"><option value="percent">%</option><option value="pixels">{w.pixels}</option></select></label><div className="tool-two-columns">{(["x", "y"] as const).map((axis) => { const max = watermarkUnit === "percent" ? 100 : watermarkTravel[axis]; return <NumberField key={axis} label={watermarkUnit === "percent" ? axis === "x" ? w.watermarkX : w.watermarkY : axis === "x" ? w.watermarkPixelsX : w.watermarkPixelsY} value={(watermark[axis] ?? 0.5) * max} min={0} max={max} step={watermarkUnit === "percent" ? 0.1 : 1} onChange={(value) => changeWatermark({ [axis]: max ? value / max : 0 })} testId={`tool-watermark-${axis}`}/>; })}</div></>}
              <label className="tool-toggle"><input type="checkbox" checked={watermarkSnap} onChange={(event) => setWatermarkSnap(event.target.checked)} data-testid="tool-watermark-snap"/>{w.watermarkSnap}</label><label className="tool-toggle"><input type="checkbox" checked={watermarkGuide} onChange={(event) => setWatermarkGuide(event.target.checked)} data-testid="tool-watermark-guide"/>{w.watermarkGuide}</label>
              <p className="tool-help">{w.watermarkDragHint}</p>
            </div>}
            {tool === "round" && <div className="tool-edit-group"><Range label={w.radius} value={effectiveRadius} min={0} max={radiusMax} step={0.1} suffix={` ${w.pixels}`} testId="tool-radius" onChange={(value) => change({ radius: value })}/><p className="tool-help">{w.radiusHint}{(options.radius ?? 0) > radiusMax && ` ${w.radiusLimited} ${options.radius} → ${effectiveRadius} ${w.pixels}`}</p></div>}
            {tool === "rotate" && <div className="tool-edit-group"><div className="tool-two-columns"><button className="tool-button" onClick={() => change({ rotation: normalizeAngle((options.rotation ?? 0) - 90) })} data-testid="tool-rotate-left">↶ {w.rotateLeft}</button><button className="tool-button" onClick={() => change({ rotation: normalizeAngle((options.rotation ?? 0) + 90) })} data-testid="tool-rotate-right">↷ {w.rotateRight}</button></div><Range label={w.rotation} value={options.rotation ?? 0} min={-180} max={180} step={0.1} suffix="°" testId="tool-rotation" onChange={(value) => change({ rotation: value })}/><button className="tool-text-button" onClick={() => change({ rotation: 0 })}>{w.rotationReset}</button></div>}
            {tool === "flip" && <div className="tool-edit-group"><button className="tool-button tool-wide" aria-pressed={!!options.flipHorizontal} onClick={() => change({ flipHorizontal: !options.flipHorizontal })} data-testid="tool-flip-horizontal">↔ {w.flipH}</button><button className="tool-button tool-wide" aria-pressed={!!options.flipVertical} onClick={() => change({ flipVertical: !options.flipVertical })} data-testid="tool-flip-vertical">↕ {w.flipV}</button><p className="tool-help">{w.flipHint}</p></div>}
            <div className="tool-output-settings"><h3>{w.exportSettings}</h3><label className="tool-field">{w.format}</label><div className="tool-segments tool-formats">{(["png", "jpeg", "webp"] as const).map((format) => <button key={format} aria-pressed={options.format === format} onClick={() => change({ format, quality: format === "png" ? 100 : options.quality })} data-testid={`tool-format-${format}`}>{format === "jpeg" ? "JPG" : format.toUpperCase()}</button>)}</div>
              <Range label={w.quality} value={options.quality} min={1} max={100} step={0.1} suffix="%" testId="tool-quality" onChange={(value) => change({ quality: value })}/><div className="tool-range-ticks"><span>{w.qualityLow}</span><span>{w.qualityHigh}</span></div>
              <p className="tool-help">{options.format === "png" ? w.pngHint : w.qualityHint}</p>{options.format === "jpeg" && <p className="tool-help">{w.jpegHint}</p>}
              <div className="tool-size-report" aria-live="polite" data-testid="tool-size-report"><span>{w.actualSize}</span><strong>{upscaleEnabled ? w.upscaleAfterExport : busy || loading ? "…" : preview && !previewError ? formatSize(preview.size) : "—"}</strong>{!upscaleEnabled && preview && source && !busy && !previewError && <small>{Math.abs(preview.size - source.size) < 1 ? w.sameSize : `${(Math.abs(preview.size - source.size) / source.size * 100).toFixed(1)}% ${preview.size < source.size ? w.smaller : w.larger}`}</small>}</div>
            </div>
          </>}
        </fieldset>
        </div>
        <div className="tool-export-area"><small>♧ {w.local}</small>
          {engineBusy && <small role="status">{w.BUSY}</small>}
          {batchProgress && batchId.current && <div className="tool-batch-progress" role="status" data-testid="batch-progress"><span>{batchProgress.completed} / {batchProgress.total} · {batchProgress.currentName ?? w.batchPreparing}</span><progress max={batchProgress.total} value={batchProgress.completed}/><button className="tool-text-button" onClick={() => void cancelBatch()} disabled={canceling} data-testid="batch-cancel">{canceling ? w.batchCanceling : w.batchCancel}</button></div>}
          {tool !== "pdf" && <button className="tool-primary-button" onClick={() => void saveBatch()} disabled={engineBusy || exporting || loading || runtimeLoading || !images.length || upscaleUnavailable} data-testid="tool-batch-export">{exporting && batchId.current ? w.exporting : `${upscaleEnabled ? w.upscaleBatchExport : w.batchExport} (${images.length})`} <span>↗</span></button>}
          {tool !== "pdf" && !batchSummary && retryIds.some((id) => images.some((image) => image.id === id)) && <button className="tool-text-button" disabled={exporting || loading} onClick={() => void saveBatch(true)} data-testid="batch-retry-failed">{w.retryFailed} ({retryIds.length})</button>}
          <button className={tool === "pdf" ? "tool-primary-button" : "tool-button"} onClick={() => tool === "pdf" ? void savePdf() : void saveImage()} disabled={engineBusy || exporting || loading || (tool === "pdf" ? !pdfImages.length : !source || !!previewError || upscaleUnavailable || upscaleInputTooLarge || runtimeLoading)} data-testid={tool === "pdf" ? "pdf-export" : "tool-export"}>{exporting && !batchId.current ? w.exporting : tool === "pdf" ? w.pdfExport : upscaleEnabled ? w.upscaleExportCurrent : w.exportCurrent} {tool === "pdf" && <span>↗</span>}</button>
          {tool !== "pdf" && <small>{upscaleEnabled ? w.upscaleApplyHint : w.batchApplyHint}</small>}
          {tool !== "pdf" && upscaleInputTooLarge && <small className="tool-upscale-warning">{w.UPSCALE_INPUT_TOO_LARGE}</small>}
        </div>
      </aside>
    </div>
    <input ref={imageInput} type="file" accept={ACCEPT} multiple hidden data-testid="tool-file-input" onChange={(event) => { void chooseImages(Array.from(event.target.files ?? []), false); event.target.value = ""; }}/>
    <input ref={addImageInput} type="file" accept={ACCEPT} multiple hidden data-testid="tool-add-file-input" onChange={(event) => { void chooseImages(Array.from(event.target.files ?? [])); event.target.value = ""; }}/>
    <input ref={watermarkInput} type="file" accept={ACCEPT} hidden data-testid="tool-watermark-file-input" onChange={(event) => { void chooseWatermark(event.target.files?.[0]); event.target.value = ""; }}/>
    <input ref={pdfInput} type="file" accept={ACCEPT} multiple hidden data-testid="pdf-file-input" onChange={(event) => { void addPdfFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }}/>
  </section>;
}

function normalizeAngle(value: number) { return ((value + 180) % 360 + 360) % 360 - 180; }
function NumericInput({ label, value, onChange, min, max, step = 1, testId }: { label: string; value: number; onChange: (value: number) => void; min: number; max: number; step?: number; testId: string }) {
  const display = Number(value.toFixed(2));
  const [draft, setDraft] = useState(String(display));
  const focused = useRef(false);
  useLayoutEffect(() => { if (!focused.current) setDraft(String(display)); }, [display]);
  function commit(raw: string) {
    const numeric = Number(raw);
    const rounded = raw.trim() && Number.isFinite(numeric) ? normalizeParameter(numeric, min, max, step) : value;
    if (rounded !== value) onChange(rounded);
    setDraft(String(rounded));
  }
  return <input type="number" aria-label={label} min={min} max={max} step={step} value={draft} data-testid={testId} onFocus={() => { focused.current = true; }} onChange={(event) => {
    setDraft(event.target.value);
    const numeric = event.target.valueAsNumber;
    const next = normalizeParameter(numeric, min, max, step);
    if (event.target.value !== "" && Number.isFinite(numeric) && next !== value) onChange(next);
  }} onBlur={(event) => { focused.current = false; commit(event.currentTarget.value); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}/>;
}
function NumberField({ label, value, onChange, min = 1, max, step = 1, testId }: { label: string; value: number; onChange: (value: number) => void; min?: number; max: number; step?: number; testId: string }) {
  return <label className="tool-field">{label}<NumericInput label={label} value={value} onChange={onChange} min={min} max={max} step={step} testId={testId}/></label>;
}
function Range({ label, value, min, max, step, suffix, testId, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix: string; testId: string; onChange: (value: number) => void }) {
  return <div className="tool-range"><span><label htmlFor={testId}>{label}</label><span className="tool-range-number"><NumericInput label={label} value={value} min={min} max={max} step={step} onChange={onChange} testId={`${testId}-input`}/><span>{suffix}</span></span></span><input id={testId} type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(event) => onChange(event.target.valueAsNumber)} style={{ "--range-fill": `${(value - min) / Math.max(1, max - min) * 100}%` } as CSSProperties} data-testid={testId}/></div>;
}
