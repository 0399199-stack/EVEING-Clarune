import { type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent,
  useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { clampView, fitImage, zoomAt, type Size, type ViewTransform } from "../../../shared/viewer-geometry";
import "./image-viewer.css";
import ParameterNumber from "./ParameterNumber";

export interface PreviewImage extends Size {
  id: string;
  name: string;
  url: string;
  size: number;
  file?: File;
  origin?: "ai";
  largeId?: string;
  largeSize?: number;
}

interface Props {
  original: PreviewImage | null;
  result: PreviewImage | null;
  loading: boolean;
  locked?: boolean;
  onChoose: () => void;
  onChooseResult: () => void;
  onRemove: () => void;
  onRemoveResult: () => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

type Mode = "original" | "compare" | "result";
interface ViewState { viewport: Size; transform: ViewTransform; fitted: boolean }

export default function ImageViewer({ original, result, loading, locked = false, onChoose, onChooseResult,
  onRemove, onRemoveResult, onDrop }: Props) {
  const { t } = useTranslation(["workspace", "common"]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: "pan" | "compare"; pointerId: number; x: number; y: number;
    transform: ViewTransform } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<Mode>(result ? "compare" : "original");
  const [split, setSplit] = useState(50);
  const [view, setView] = useState<ViewState>({ viewport: { width: 0, height: 0 },
    transform: { x: 0, y: 0, scale: 1 }, fitted: true });

  useEffect(() => { setMode(result ? "compare" : "original"); setSplit(50); }, [result?.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !original) return;
    const observer = new ResizeObserver(([entry]) => {
      const size = { width: entry.contentRect.width, height: entry.contentRect.height };
      if (size.width <= 0 || size.height <= 0) return;
      setView((previous) => {
        if (previous.fitted || !previous.viewport.width) {
          return { viewport: size, transform: fitImage(original, size), fitted: true };
        }
        return { ...previous, viewport: size, transform: clampView({ ...previous.transform,
          x: previous.transform.x + (size.width - previous.viewport.width) / 2,
          y: previous.transform.y + (size.height - previous.viewport.height) / 2 }, original, size) };
      });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [original]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !original) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      drag.current = null;
      setDragging(false);
      const rect = viewport.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const delta = Math.max(-500, Math.min(500, event.deltaY * unit));
      setView((previous) => ({ ...previous, fitted: false, transform: zoomAt(previous.transform,
        previous.transform.scale * Math.exp(-delta * 0.002),
        { x: event.clientX - rect.left, y: event.clientY - rect.top }, original, previous.viewport) }));
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [original]);

  const fit = () => {
    if (original) setView((previous) => ({ ...previous, fitted: true,
      transform: fitImage(original, previous.viewport) }));
  };
  const changeZoom = (factor: number, actualSize = false) => {
    if (!original) return;
    setView((previous) => ({ ...previous, fitted: false, transform: zoomAt(previous.transform,
      actualSize ? 1 : previous.transform.scale * factor,
      { x: previous.viewport.width / 2, y: previous.viewport.height / 2 }, original, previous.viewport) }));
  };
  const moveSplit = (clientX: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) setSplit(Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100)));
  };
  const beginDrag = (event: PointerEvent, kind: "pan" | "compare") => {
    if (!original || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      transform: view.transform };
    viewportRef.current?.setPointerCapture(event.pointerId);
    setDragging(true);
    if (kind === "compare") moveSplit(event.clientX);
  };
  const onPointerMove = (event: PointerEvent) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId || !original) return;
    if (active.kind === "compare") moveSplit(event.clientX);
    else setView((previous) => ({ ...previous, fitted: false, transform: clampView({
      ...active.transform, x: active.transform.x + event.clientX - active.x,
      y: active.transform.y + event.clientY - active.y }, original, previous.viewport) }));
  };
  const stopDrag = () => { drag.current = null; setDragging(false); };
  const handleSplitKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 1;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    setSplit((current) => event.key === "Home" ? 0 : event.key === "End" ? 100
      : Math.max(0, Math.min(100, current + (event.key === "ArrowLeft" ? -step : step))));
  };

  const imageStyle: CSSProperties = original ? {
    width: original.width, height: original.height,
    transform: `translate(${view.transform.x}px, ${view.transform.y}px) scale(${view.transform.scale})`,
  } : {};
  const hasComparison = Boolean(result && mode === "compare");
  const resultLabel = t(result?.origin === "ai" ? "ai.result" : "importedResult");
  const setZoomPercent = (percent: number) => {
    if (!original) return;
    drag.current = null; setDragging(false);
    setView(previous => ({ ...previous, fitted: false, transform: zoomAt(previous.transform, percent / 100,
      { x: previous.viewport.width / 2, y: previous.viewport.height / 2 }, original, previous.viewport) }));
  };

  return (
    <section className="image-viewer glass-panel" aria-label={t("previewTitle")}
      onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <div className="viewer-toolbar">
        <div className="viewer-mode-group" role="group" aria-label={t("previewTitle")}>
          {(["original", "compare", "result"] as Mode[]).map((item) => (
            <button type="button" key={item} aria-pressed={mode === item}
              disabled={!original || (item !== "original" && !result)}
              onClick={() => setMode(item)}>{item === "result" && result?.origin === "ai" ? t("ai.result") : t(item)}</button>
          ))}
        </div>
        <button className="viewer-import" type="button" onClick={onChooseResult} disabled={!original || loading || locked}>
          <span aria-hidden>＋</span>{t(result ? "replaceResult" : "importResult")}
        </button>
      </div>

      <div className={`viewer-viewport ${dragging ? "is-dragging" : ""} ${original ? "has-image" : ""}`}
        ref={viewportRef} data-testid="image-viewport" data-zoom={view.transform.scale}
        onPointerDown={(event) => beginDrag(event, "pan")} onPointerMove={onPointerMove}
        onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
        onDoubleClick={fit} tabIndex={original ? 0 : -1}
        aria-label={t("viewerHint")} onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "+" || event.key === "=") { event.preventDefault(); changeZoom(1.25); }
          if (event.key === "-") { event.preventDefault(); changeZoom(0.8); }
          if (event.key === "0") { event.preventDefault(); fit(); }
        }}>
        {original ? <>
          {result && mode !== "original" && <div className="viewer-image-layer"
            style={hasComparison ? { clipPath: `inset(0 0 0 ${split}%)` } : undefined}>
            <img src={result.url} alt={resultLabel} className="viewer-image" data-testid="comparison-image" style={imageStyle} draggable={false} />
          </div>}
          {mode !== "result" && <div className="viewer-image-layer viewer-original-layer"
            style={hasComparison ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined}>
            <img src={original.url} alt={t("original")} className="viewer-image" style={imageStyle} draggable={false} />
          </div>}
          <span className="viewer-side-label original-label">{mode === "result" ? resultLabel : t("original")}</span>
          {hasComparison && <>
            <span className="viewer-side-label result-label">{resultLabel}</span>
            <div className="comparison-divider" style={{ left: `${split}%` }}>
              <div className="comparison-handle" role="slider" tabIndex={0}
                aria-label={t("comparePosition")} aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={Math.round(split)} aria-orientation="horizontal"
                onPointerDown={(event) => beginDrag(event, "compare")} onKeyDown={handleSplitKey}>
                <span aria-hidden>‹</span><i aria-hidden /><span aria-hidden>›</span>
              </div>
            </div>
          </>}
        </> : <button className="viewer-empty" type="button" onClick={onChoose} disabled={loading || locked}>
          <span className="viewer-empty-icon" aria-hidden>
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="3" y="4" width="18" height="16" rx="4"/><circle cx="9" cy="9" r="1.5"/><path d="m4 17 5-5 3 3 3-4 5 6"/></svg>
          </span>
          <strong>{t(loading ? "loadingImage" : "dropTitle")}</strong><small>{t("dropBody")}</small>
          <span className="soft-button">{t("common:actions.chooseImage")}</span>
        </button>}

        {original && <div className="viewer-zoom-dock" onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}>
          <button type="button" aria-label={t("zoomOut")} title={t("zoomOut")} onClick={() => changeZoom(0.8)}>−</button>
          <span className="viewer-zoom-number" data-testid="zoom-value"><ParameterNumber value={Math.round(view.transform.scale * 1000) / 10} min={0.1} max={1600} step={0.1} onChange={setZoomPercent} label={t("zoomLabel")} testId="viewer-zoom-number"/>%</span>
          <button type="button" aria-label={t("zoomIn")} title={t("zoomIn")} onClick={() => changeZoom(1.25)}>＋</button>
          <span className="dock-separator" />
          <button type="button" className="dock-text" title={t("actualSize")} onClick={() => changeZoom(1, true)}>1:1</button>
          <button type="button" className="dock-text" onClick={fit}>{t("fit")}</button>
        </div>}
      </div>

      {hasComparison && <div className="viewer-comparison-control">
        <span>{t("original")}</span><input type="range" min={0} max={100} step={1} value={split}
          aria-label={t("comparePosition")} onChange={(event) => setSplit(Number(event.target.value))} />
        <span>{result?.origin === "ai" ? t("ai.result") : t("result")}</span><span className="viewer-split-number"><ParameterNumber value={split} min={0} max={100} onChange={setSplit} label={t("comparePosition")} testId="viewer-split-number"/>%</span>
      </div>}
      <footer className="viewer-footer">
        <div className="viewer-file-info"><strong title={original?.name}>{original?.name ?? t("previewTitle")}</strong>
          <small>{original ? `${original.width} × ${original.height} · ${t(hasComparison ? "compareHint" : "viewerHint")}` : t("viewerHint")}</small>
          {result?.origin === "ai" && <small data-testid="ai-result-dimensions">{t("ai.result")} · {result.width} × {result.height}</small>}
        </div>
        {original && <div className="viewer-file-actions">
          <button type="button" disabled={loading || locked} onClick={onChoose}>{t("common:actions.chooseImage")}</button>
          {result && <button type="button" disabled={loading || locked} onClick={onRemoveResult}>{t("removeResult")}</button>}
          <button type="button" disabled={loading || locked} onClick={onRemove} className="danger">{t("common:actions.remove")}</button>
        </div>}
      </footer>
    </section>
  );
}
