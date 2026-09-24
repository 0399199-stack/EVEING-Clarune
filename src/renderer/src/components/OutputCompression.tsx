import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImageFormat } from "../../../shared/image-tools";
import type { PreviewImage } from "./ImageViewer";
import ParameterNumber from "./ParameterNumber";
import { recordOutputs } from "../lib/output-history";
import "./output-compression.css";

const imageFormat = (format: string): ImageFormat => format === "JPG" ? "jpeg" : format === "WEBP" ? "webp" : "png";
const bytesLabel = (size: number) => size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(2)} MB`;

export default function OutputCompression({ original, comparison, format, onSavingChange, disabled = false }: {
  original: PreviewImage | null; comparison: PreviewImage | null; format: string; onSavingChange: (saving: boolean) => void; disabled?: boolean;
}) {
  const { t } = useTranslation("workspace");
  const [target, setTarget] = useState<"original" | "comparison">("original");
  const source = target === "comparison" && comparison ? comparison : original;
  const isComparison = Boolean(target === "comparison" && comparison);
  const isAI = isComparison && comparison?.origin === "ai";
  const [quality, setQuality] = useState(90);
  const [encoded, setEncoded] = useState<{ key: string; size: number } | null>(null);
  const [error, setError] = useState<{ key: string; code: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [outputNotice, setOutputNotice] = useState("");
  const revision = useRef(0);
  const active = useRef(false);
  const queue = useRef<{ image: PreviewImage; format: ImageFormat; quality: number; key: string; revision: number } | null>(null);
  const input = useRef<{ id: string; bytes: Uint8Array } | null>(null);
  const mounted = useRef(true);
  const key = `${source?.id}:${format}:${quality}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; queue.current = null; }; }, []);
  useEffect(() => { onSavingChange(saving); return () => onSavingChange(false); }, [saving, onSavingChange]);
  useEffect(() => { setTarget("original"); }, [original?.id]);
  useEffect(() => { if (comparison?.origin === "ai") { setTarget("comparison"); setQuality(100); } }, [comparison?.id]);
  useEffect(() => {
    const next = ++revision.current;
    queue.current = null;
    setSaved(null);
    if (!source?.file) return;
    const timer = window.setTimeout(() => {
      queue.current = { image: source, format: imageFormat(format), quality, key, revision: next };
      if (active.current) return;
      active.current = true;
      void (async () => {
        try {
          while (queue.current && mounted.current) {
            const task = queue.current;
            queue.current = null;
            try {
              if (task.image.largeId) {
                if (task.format === "webp" && (task.image.width > 16383 || task.image.height > 16383)) {
                  if (mounted.current && task.revision === revision.current) setError({ key: task.key, code: "OUTPUT_TOO_LARGE" });
                } else if (mounted.current && task.revision === revision.current) {
                  setEncoded(task.format === "png" && task.quality === 100 ? { key: task.key, size: task.image.largeSize ?? task.image.size } : null);
                  setError(null);
                }
                continue;
              }
              if (input.current?.id !== task.image.id) {
                input.current = { id: task.image.id, bytes: new Uint8Array(await task.image.file!.arrayBuffer()) };
              }
              const response = await window.clarune.processImage({ bytes: input.current.bytes,
                options: { format: task.format, quality: task.quality } });
              if (!mounted.current || task.revision !== revision.current) continue;
              if (response.ok) { setEncoded({ key: task.key, size: response.value.size }); setError(null); }
              else setError({ key: task.key, code: response.error });
            } catch {
              if (mounted.current && task.revision === revision.current) setError({ key: task.key, code: "PROCESSING_FAILED" });
            }
          }
        } finally { active.current = false; }
      })();
    }, 240);
    return () => clearTimeout(timer);
  }, [source, format, quality, key]);

  const exportImage = async () => {
    if (!source?.file || saving || disabled) return;
    setSaving(true); setSaved(null); setError(null);
    try {
      const suggestedName = `${source.name.replace(/\.[^.]+$/, "")}-clarune`;
      const response = source.largeId
        ? await window.clarune.saveLargeEnhancement(source.largeId, imageFormat(format), quality, suggestedName)
        : await window.clarune.saveImage({ bytes: new Uint8Array(await source.file.arrayBuffer()),
          options: { format: imageFormat(format), quality } }, suggestedName);
      if (response.ok) recordOutputs([response.value], "image");
      if (!mounted.current || currentKey.current !== key) return;
      if (response.ok) setSaved(response.value.path);
      else if (!response.canceled) setError({ key, code: response.error });
    } catch { if (mounted.current && currentKey.current === key) setError({ key, code: "WRITE_FAILED" }); }
    finally { if (mounted.current) setSaving(false); }
  };
  const current = encoded?.key === key ? encoded : null;
  const failure = error?.key === key ? error.code : null;
  const delta = source && current ? (1 - current.size / source.size) * 100 : 0;
  return <section className="output-compression" aria-labelledby="output-quality-label">
    <label className="export-source-label" htmlFor="export-source">{t("exportSource")}</label>
    <select id="export-source" data-testid="export-source" className="export-source" value={isComparison ? "comparison" : "original"} disabled={saving || disabled}
      onChange={event => { setTarget(event.target.value as "original" | "comparison"); setOutputNotice(""); }}>
      <option value="original">{t("original")}</option>
      <option value="comparison" disabled={!comparison}>{t(comparison?.origin === "ai" ? "ai.result" : "importedResult")}</option>
    </select>
    <div className="compression-heading"><label id="output-quality-label" htmlFor="output-quality">{t("compression")}</label>
      <span className="compression-number"><ParameterNumber value={quality} min={1} max={100} step={0.1} onChange={setQuality} label={t("compression")} testId="output-quality-number" disabled={saving || disabled}/>%</span></div>
    <input id="output-quality" data-testid="output-quality" className="enhance-scale-range" type="range"
      min={1} max={100} step={0.1} value={quality} disabled={saving || disabled}
      onChange={event => setQuality(Number(event.target.value))} />
    <div className="compression-ticks"><span>{t("smallerFile")}</span><span>{t("higherQuality")}</span></div>
    <p>{t(format === "PNG" ? "pngCompressionHint" : "compressionHint")}</p>
    <div className="compression-estimate" data-testid="output-size" aria-live="polite">
      {!source ? t("compressionChoose") : failure ? t(`exportErrors.${failure}`, { defaultValue: t("exportErrors.PROCESSING_FAILED") })
        : current ? <><strong>{bytesLabel(current.size)}</strong><span>{t(delta >= 0 ? "sizeReduced" : "sizeIncreased", { value: Math.abs(delta).toFixed(1) })}</span></>
          : source.largeId ? t("largeEstimate") : t("encoding")}
    </div>
    <button type="button" className="primary-button compression-export" data-testid="compression-export"
      onClick={() => void exportImage()} disabled={!source || saving || disabled || (Boolean(source?.largeId) && format === "WEBP" && (source.width > 16383 || source.height > 16383))}>
      {t(saving ? "exporting" : isAI ? "ai.export" : isComparison ? "exportComparison" : "exportOriginal")}
    </button>
    <small>{t(isAI ? "ai.exportHint" : isComparison ? "exportComparisonHint" : "exportOriginalHint")}</small>
    {saved && <p className="compression-saved" role="status" data-testid="compression-saved">{t("exportSaved")}<span>{saved}</span></p>}
    {saved && <div className="compression-actions">{([false, true] as const).map(copy => <button type="button" className="text-button" key={String(copy)} onClick={() => {
      void (copy ? window.clarune.copyOutputPath(saved) : window.clarune.openOutput(saved)).then(result => setOutputNotice(t(result.ok ? copy ? "pathCopied" : "folderOpened" : "outputUnavailable"))).catch(() => setOutputNotice(t("outputUnavailable")));
    }}>{t(copy ? "copyPath" : "openFolder")}</button>)}</div>}
    {outputNotice && <small role="status">{outputNotice}</small>}
  </section>;
}
