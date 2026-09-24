import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CropRect } from "../../../shared/image-tools";
import { canvasImagePoint, moveCropBounds, moveWatermarkBounds, resizeCropBounds, snapWatermarkBounds, watermarkMargin, watermarkPosition, type CropCorner } from "../../../shared/image-tool-canvas";
import { cropFromDrag } from "../../../shared/image-tool-ui";
import { clampView, fitImage, zoomAt, type Point, type Size, type ViewTransform } from "../../../shared/viewer-geometry";
import "./image-tool-canvas.css";

export interface ImageToolCanvasSource extends Size { id: string; url: string; name?: string; alt?: string }
export interface ImageToolCanvasProps {
  source: ImageToolCanvasSource;
  mode: "preview" | "crop" | "watermark";
  busy?: boolean;
  crop?: CropRect;
  cropRatio?: number;
  onCropChange?: (crop: CropRect) => void;
  watermarkBounds?: CropRect;
  watermarkBaseUrl?: string;
  watermarkOverlayUrl?: string;
  watermarkRadius?: number;
  watermarkSnap?: boolean;
  watermarkGuide?: boolean;
  onWatermarkPosition?: (position: Point) => void;
}
interface ViewState { viewport: Size; transform: ViewTransform; fitted: boolean }
type DragState = { pointerId: number; start: Point; view: ViewTransform } & (
  { kind: "pan" } | { kind: "crop"; selection: CropRect | null } |
  { kind: "crop-move"; initial: CropRect; selection: CropRect } |
  { kind: "crop-resize"; initial: CropRect; selection: CropRect; corner: CropCorner } |
  { kind: "watermark"; initial: CropRect; selection: CropRect });

export default function ImageToolCanvas({ source, mode, busy = false, crop, cropRatio,
  onCropChange, watermarkBounds, watermarkBaseUrl, watermarkOverlayUrl, watermarkRadius = 0, watermarkSnap = false, watermarkGuide = false,
  onWatermarkPosition }: ImageToolCanvasProps) {
  const { i18n } = useTranslation();
  const english = i18n.language.startsWith("en");
  const words = english ? { fit: "Fit", zoom: "Zoom", out: "Zoom out", in: "Zoom in",
    hint: "Wheel to zoom · drag to pan", editHint: "Wheel to zoom · Space + drag to pan",
    mark: "Drag watermark", move: "Move", one: "Actual size", crop: "Move crop selection (arrow keys; Shift for 10 pixels)",
    corners: { "top-left": "Resize top left", "top-right": "Resize top right", "bottom-left": "Resize bottom left", "bottom-right": "Resize bottom right" } } :
    { fit: "适应窗口", zoom: "缩放", out: "缩小", in: "放大", hint: "滚轮缩放 · 拖动平移",
      editHint: "滚轮缩放 · 空格＋拖动平移", mark: "拖动水印位置", move: "移动", one: "实际尺寸", crop: "移动裁剪框（方向键微调，Shift 每次 10 像素）",
      corners: { "top-left": "调整左上角", "top-right": "调整右上角", "bottom-left": "调整左下角", "bottom-right": "调整右下角" } };
  const viewportRef = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const spaceRef = useRef(false);
  const drag = useRef<DragState | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragKind, setDragKind] = useState<DragState["kind"] | null>(null);
  const [cropDraft, setCropDraft] = useState<CropRect | null>(null);
  const [markDraft, setMarkDraft] = useState<CropRect | null>(null);
  const [view, setView] = useState<ViewState>({ viewport: { width: 1, height: 1 },
    transform: { x: 0, y: 0, scale: 1 }, fitted: true });
  const [zoomDraft, setZoomDraft] = useState("100");
  const zoomFocused = useRef(false);

  function cancelDrag() {
    const active = drag.current;
    drag.current = null; setDragKind(null); setCropDraft(null); setMarkDraft(null);
    if (active && viewportRef.current?.hasPointerCapture(active.pointerId)) viewportRef.current.releasePointerCapture(active.pointerId);
  }
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    cancelDrag();
    const rect = node.getBoundingClientRect();
    if (rect.width && rect.height) {
      const viewport = { width: rect.width, height: rect.height };
      setView({ viewport, transform: fitImage(source, viewport), fitted: true });
    }
    const observer = new ResizeObserver(([entry]) => {
      const viewport = { width: entry.contentRect.width, height: entry.contentRect.height };
      if (!viewport.width || !viewport.height) return;
      setView((previous) => previous.fitted ? { viewport, transform: fitImage(source, viewport), fitted: true } : {
        ...previous, viewport, transform: clampView({ ...previous.transform,
          x: previous.transform.x + (viewport.width - previous.viewport.width) / 2,
          y: previous.transform.y + (viewport.height - previous.viewport.height) / 2 }, source, viewport) });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [source.id, source.width, source.height]);

  useEffect(() => { cancelDrag(); }, [mode]);
  useEffect(() => { if (drag.current?.kind !== "watermark") setMarkDraft(null); }, [source.url]);
  useEffect(() => { if (!drag.current?.kind.startsWith("crop")) setCropDraft(null); }, [crop?.left, crop?.top, crop?.width, crop?.height]);
  useLayoutEffect(() => {
    if (!zoomFocused.current) setZoomDraft(String(Number((view.transform.scale * 100).toFixed(1))));
  }, [view.transform.scale]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      node.focus({ preventScroll: true });
      cancelDrag();
      const rect = node.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const delta = Math.max(-500, Math.min(500, event.deltaY * unit));
      setView((previous) => ({ ...previous, fitted: false, transform: zoomAt(previous.transform,
        previous.transform.scale * Math.exp(-delta * 0.002),
        { x: event.clientX - rect.left, y: event.clientY - rect.top }, source, previous.viewport) }));
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [source.id, source.width, source.height]);

  useEffect(() => {
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.code !== "Space" || event.target instanceof Element && event.target.closest("input,textarea,select,button:not([data-crop-corner]),[contenteditable=true]")) return;
      if (!hovered.current && !viewportRef.current?.contains(document.activeElement)) return;
      event.preventDefault(); spaceRef.current = true; setSpaceHeld(true);
    };
    const keyUp = (event: globalThis.KeyboardEvent) => { if (event.code === "Space") { spaceRef.current = false; setSpaceHeld(false); } };
    const blur = () => { spaceRef.current = false; setSpaceHeld(false); cancelDrag(); };
    window.addEventListener("keydown", keyDown); window.addEventListener("keyup", keyUp); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", blur); };
  }, []);

  function imagePoint(clientX: number, clientY: number, transform = view.transform) {
    const rect = viewportRef.current!.getBoundingClientRect();
    return canvasImagePoint({ x: clientX - rect.left, y: clientY - rect.top }, transform, source);
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    const pan = event.button === 1 || spaceRef.current || mode === "preview";
    if (!pan && busy) return;
    const start = imagePoint(event.clientX, event.clientY);
    const target = event.target as HTMLElement;
    let next: DragState;
    if (pan) next = { kind: "pan", pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, view: view.transform };
    else if (mode === "watermark" && watermarkBounds && (event.target as Element).closest("[data-watermark-handle]")) {
      next = { kind: "watermark", pointerId: event.pointerId, start, view: view.transform,
        initial: watermarkBounds, selection: watermarkBounds };
      setMarkDraft(watermarkBounds);
    } else if (mode === "crop" && target.closest(".image-tool-stage")) {
      const corner = target.closest<HTMLElement>("[data-crop-corner]")?.dataset.cropCorner as CropCorner | undefined;
      if (crop && corner) next = { kind: "crop-resize", pointerId: event.pointerId, start, view: view.transform,
        initial: crop, selection: crop, corner };
      else if (crop && !event.altKey && (crop.width < source.width || crop.height < source.height) && target.closest("[data-crop-move]")) next = { kind: "crop-move", pointerId: event.pointerId,
        start, view: view.transform, initial: crop, selection: crop };
      else next = { kind: "crop", pointerId: event.pointerId, start: { x: Math.min(source.width - 1, start.x), y: Math.min(source.height - 1, start.y) },
          view: view.transform, selection: null };
    } else return;
    event.preventDefault(); (target.closest<HTMLElement>("[data-crop-corner],[data-crop-move]") ?? event.currentTarget).focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId); drag.current = next; setDragKind(next.kind);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.kind === "pan") {
      setView((previous) => ({ ...previous, fitted: false, transform: clampView({ ...active.view,
        x: active.view.x + event.clientX - active.start.x, y: active.view.y + event.clientY - active.start.y }, source, previous.viewport) }));
      return;
    }
    const end = imagePoint(event.clientX, event.clientY, active.view);
    if (active.kind === "crop") {
      if (Math.abs(end.x - active.start.x) + Math.abs(end.y - active.start.y) < 2) return;
      active.selection = cropFromDrag(active.start, end, source, cropRatio); setCropDraft(active.selection);
    } else if (active.kind === "crop-move") {
      active.selection = moveCropBounds(active.initial, { x: end.x - active.start.x, y: end.y - active.start.y }, source);
      setCropDraft(active.selection);
    } else if (active.kind === "crop-resize") {
      active.selection = resizeCropBounds(active.initial, active.corner, {
        x: active.initial.left + (active.corner.endsWith("right") ? active.initial.width : 0) + end.x - active.start.x,
        y: active.initial.top + (active.corner.startsWith("bottom") ? active.initial.height : 0) + end.y - active.start.y }, source, cropRatio);
      setCropDraft(active.selection);
    } else {
      active.selection = moveWatermarkBounds(active.initial, { x: end.x - active.start.x, y: end.y - active.start.y }, source);
      if (watermarkSnap && !event.altKey) active.selection = snapWatermarkBounds(active.selection, source, 6 / active.view.scale);
      setMarkDraft(active.selection);
    }
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null; setDragKind(null);
    if (active.kind !== "pan" && active.kind !== "watermark" && active.selection) {
      const previous = "initial" in active ? active.initial : null;
      if (!previous || ["left", "top", "width", "height"].some(key => active.selection![key as keyof CropRect] !== previous[key as keyof CropRect])) onCropChange?.(active.selection);
    }
    if (active.kind === "watermark") onWatermarkPosition?.(watermarkPosition(active.selection, source));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function zoom(scale: number) {
    cancelDrag();
    setView((previous) => ({ ...previous, fitted: false, transform: zoomAt(previous.transform, scale,
      { x: previous.viewport.width / 2, y: previous.viewport.height / 2 }, source, previous.viewport) }));
  }
  function fit() { cancelDrag(); setView((previous) => ({ ...previous, fitted: true, transform: fitImage(source, previous.viewport) })); }
  function commitZoom(rawValue: string) {
    zoomFocused.current = false;
    const value = Number(rawValue);
    if (rawValue.trim() && Number.isFinite(value) && value > 0) {
      const minScale = Math.min(0.05, fitImage(source, view.viewport).scale);
      const scale = Math.max(minScale, Math.min(16, value / 100));
      zoom(scale); setZoomDraft(String(Number((scale * 100).toFixed(1))));
    } else setZoomDraft(String(Number((view.transform.scale * 100).toFixed(1))));
  }
  function cropKey(event: KeyboardEvent<HTMLElement>, corner?: CropCorner) {
    if (busy || !crop || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    const delta = { x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
      y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0 };
    const next = corner ? resizeCropBounds(crop, corner, {
      x: crop.left + (corner.endsWith("right") ? crop.width : 0) + delta.x,
      y: crop.top + (corner.startsWith("bottom") ? crop.height : 0) + delta.y }, source, cropRatio) : moveCropBounds(crop, delta, source);
    onCropChange?.(next);
  }
  const selection = cropDraft ?? crop;
  const mark = markDraft ?? watermarkBounds;
  const markLabel = mark && mark.top * view.transform.scale >= 24 ? "label-above" : mark && (source.height - mark.top - mark.height) * view.transform.scale >= 24 ? "label-below" : "";
  const showLiveMark = mode === "watermark" && Boolean(markDraft && watermarkBaseUrl && watermarkOverlayUrl);
  const stageStyle = { width: source.width, height: source.height,
    transform: `translate(${view.transform.x}px, ${view.transform.y}px) scale(${view.transform.scale})`,
    "--inverse-zoom": 1 / view.transform.scale } as CSSProperties;
  const boxStyle = (box: CropRect): CSSProperties => ({ left: box.left, top: box.top, width: box.width, height: box.height });

  return <div className="image-tool-canvas">
    <div ref={viewportRef} className={`tool-image-surface image-tool-viewport mode-${mode} ${spaceHeld ? "space-held" : ""} ${dragKind ? `dragging-${dragKind}` : ""}`}
      data-testid="tool-image-surface" data-zoom={view.transform.scale} tabIndex={0}
      aria-label={mode === "preview" ? words.hint : words.editHint}
      onPointerEnter={() => { hovered.current = true; }} onPointerLeave={() => { hovered.current = false; }}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
      onPointerCancel={cancelDrag} onLostPointerCapture={() => { if (drag.current) cancelDrag(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); cancelDrag(); return; }
        if (event.target !== event.currentTarget) return;
        if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(view.transform.scale * 1.25); }
        if (event.key === "-") { event.preventDefault(); zoom(view.transform.scale * 0.8); }
        if (event.key === "0") { event.preventDefault(); fit(); }
      }}>
      <div className="tool-image-stage image-tool-stage" style={stageStyle} data-testid="tool-image-stage">
        <img src={source.url} alt={source.alt ?? source.name ?? ""} draggable={false} style={showLiveMark ? { visibility: "hidden" } : undefined} className={busy && mode !== "crop" ? "is-stale" : undefined} data-testid="tool-preview-image"/>
        {mode === "watermark" && mark && watermarkBaseUrl && watermarkOverlayUrl && <div className="image-tool-live-watermark" style={{ visibility: showLiveMark ? "visible" : "hidden" }} aria-hidden="true">
          <img src={watermarkBaseUrl} alt="" draggable={false}/>
          <div className="image-tool-watermark-clip" style={{ borderRadius: Math.min(watermarkRadius, source.width / 2, source.height / 2) }}>
            <img src={watermarkOverlayUrl} alt="" draggable={false} style={boxStyle(mark)} data-testid="tool-watermark-live-overlay"/>
          </div>
        </div>}
        {mode === "watermark" && watermarkGuide && <div className="image-tool-margin-guide" style={{ inset: watermarkMargin(source) }} aria-hidden="true" data-testid="tool-watermark-margin-guide"/>}
        {mode === "crop" && selection && <div className="tool-crop-box image-tool-crop" style={boxStyle(selection)} data-testid="tool-crop-box"
          data-crop-move="true" tabIndex={0} role="group" aria-label={words.crop} onKeyDown={(event) => { if (event.target === event.currentTarget) cropKey(event); }}>
          {(["top-left", "top-right", "bottom-left", "bottom-right"] as const).map(corner => <button key={corner} type="button"
            className={`image-tool-crop-handle corner-${corner}`} data-crop-corner={corner} data-testid={`tool-crop-${corner}-handle`}
            aria-label={words.corners[corner]} title={words.corners[corner]} onKeyDown={event => cropKey(event, corner)} disabled={busy}/>)}
          <span>{selection.width} × {selection.height}</span>
        </div>}
        {mode === "watermark" && mark && <div className={`image-tool-watermark ${markLabel} ${mark.left + mark.width / 2 > source.width / 2 ? "label-align-right" : ""} ${markDraft ? "is-draft" : ""} ${busy ? "is-busy" : ""}`}
          style={boxStyle(mark)} data-testid="tool-watermark-box" data-watermark-handle="true" title={words.mark}>
          <span>{words.move} · X {Math.round(mark.left)} · Y {Math.round(mark.top)}</span>
          <i/><i/><i/><i/>
        </div>}
      </div>
    </div>
    <div className="image-tool-zoom-bar">
      <small>{mode === "preview" ? words.hint : words.editHint}</small>
      <div className="image-tool-zoom-controls" role="group" aria-label={words.zoom}>
        <button type="button" title={words.out} aria-label={words.out} onClick={() => zoom(view.transform.scale * 0.8)} data-testid="tool-zoom-out">−</button>
        <label><input type="number" min={0.1} max={1600} step={1} value={zoomDraft} aria-label={words.zoom} data-testid="tool-zoom-input"
          onFocus={() => { zoomFocused.current = true; }} onChange={(event) => setZoomDraft(event.target.value)} onBlur={(event) => commitZoom(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}/><span>%</span></label>
        <button type="button" title={words.in} aria-label={words.in} onClick={() => zoom(view.transform.scale * 1.25)} data-testid="tool-zoom-in">＋</button>
        <button type="button" title={words.one} className="zoom-text" onClick={() => zoom(1)} data-testid="tool-zoom-actual">1:1</button>
        <button type="button" className="zoom-text" onClick={fit} data-testid="tool-zoom-fit">{words.fit}</button>
      </div>
    </div>
  </div>;
}
