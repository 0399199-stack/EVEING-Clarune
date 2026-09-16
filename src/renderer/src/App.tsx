import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { AppInfo } from "../../shared/contracts";
import { setLanguage, type SupportedLanguage } from "./i18n";

type Page = "enhance" | "batch" | "history" | "models" | "settings";
type ThemeChoice = "system" | "light" | "dark";

interface SelectedImage {
  id: string;
  name: string;
  size: number;
  url: string;
}

const pages: Page[] = ["enhance", "batch", "history", "models", "settings"];

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
    default:
      return <span aria-hidden>·</span>;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    const saved = window.localStorage.getItem("clarune.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [scale, setScale] = useState("4×");
  const [format, setFormat] = useState("PNG");
  const [enhanceImage, setEnhanceImage] = useState<SelectedImage | null>(null);
  const [batchImages, setBatchImages] = useState<SelectedImage[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo>({
    name: "EVEING Clarune",
    version: "0.0.1-phase0",
    platform: "win32",
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrls = useRef(new Set<string>());

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
  };

  const acceptFiles = (files: FileList | File[], target: "enhance" | "batch"): void => {
    const accepted = Array.from(files).filter((file) =>
      ["image/png", "image/jpeg", "image/webp"].includes(file.type),
    );
    if (target === "enhance") {
      if (!accepted[0]) return;
      if (enhanceImage) releaseImage(enhanceImage);
      setEnhanceImage(makeImage(accepted[0]));
      return;
    }
    setBatchImages((current) => [...current, ...accepted.map(makeImage)]);
  };

  const chooseFiles = (): void => fileInputRef.current?.click();
  const onFileInput = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files) acceptFiles(event.target.files, page === "batch" ? "batch" : "enhance");
    event.target.value = "";
  };
  const onDrop = (event: DragEvent<HTMLElement>, target: "enhance" | "batch"): void => {
    event.preventDefault();
    acceptFiles(event.dataTransfer.files, target);
  };
  const changeLanguage = (language: SupportedLanguage): void => {
    void setLanguage(language);
  };

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="titlebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden><span /></span>
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
          <nav aria-label="Primary">
            {pages.map((item) => (
              <button
                className={`nav-item ${page === item ? "active" : ""}`}
                key={item}
                type="button"
                onClick={() => setPage(item)}
                aria-current={page === item ? "page" : undefined}
              >
                <Icon name={item} />
                <span>{t(`nav.${item}`)}</span>
              </button>
            ))}
          </nav>
          <div className="local-card">
            <span className="local-orbit"><span /></span>
            <div>
              <strong>{t("status.local")}</strong>
              <small>{t("status.offline")}</small>
            </div>
          </div>
        </aside>

        <main className="main-stage">
          {page === "enhance" && (
            <EnhancePage
              image={enhanceImage}
              scale={scale}
              format={format}
              onChoose={chooseFiles}
              onDrop={(event) => onDrop(event, "enhance")}
              onScale={setScale}
              onFormat={setFormat}
              onRemove={() => {
                if (enhanceImage) releaseImage(enhanceImage);
                setEnhanceImage(null);
              }}
            />
          )}
          {page === "batch" && (
            <BatchPage
              images={batchImages}
              onChoose={chooseFiles}
              onDrop={(event) => onDrop(event, "batch")}
              onRemove={(id) => setBatchImages((current) => current.filter((image) => {
                if (image.id !== id) return true;
                releaseImage(image);
                return false;
              }))}
              onClear={() => {
                batchImages.forEach(releaseImage);
                setBatchImages([]);
              }}
            />
          )}
          {page === "history" && <HistoryPage />}
          {page === "models" && <ModelsPage />}
          {page === "settings" && (
            <SettingsPage
              theme={theme}
              language={(i18n.resolvedLanguage === "en-US" ? "en-US" : "zh-CN")}
              appInfo={appInfo}
              onTheme={setTheme}
              onLanguage={changeLanguage}
            />
          )}
        </main>
      </div>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple={page === "batch"}
        onChange={onFileInput}
        tabIndex={-1}
      />

      {licenseOpen && <LicenseDialog onClose={() => setLicenseOpen(false)} />}
    </div>
  );
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

function DropSurface({
  image,
  onChoose,
  onDrop,
}: {
  image: SelectedImage | null;
  onChoose: () => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}): ReactNode {
  const { t } = useTranslation(["common", "workspace"]);
  return (
    <section
      className={`drop-surface glass-panel ${image ? "has-image" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      {image ? (
        <>
          <img src={image.url} alt={t("workspace:previewAlt")} />
          <div className="image-caption">
            <div><small>{t("workspace:selected")}</small><strong>{image.name}</strong></div>
            <span>{formatBytes(image.size)}</span>
          </div>
        </>
      ) : (
        <button className="drop-invitation" type="button" onClick={onChoose}>
          <span className="drop-icon"><Icon name="image" size={30} /><i><Icon name="plus" size={12} /></i></span>
          <strong>{t("workspace:dropTitle")}</strong>
          <small>{t("workspace:dropBody")}</small>
          <span className="soft-button">{t("actions.chooseImage")}</span>
        </button>
      )}
    </section>
  );
}

function EnhancePage({
  image,
  scale,
  format,
  onChoose,
  onDrop,
  onScale,
  onFormat,
  onRemove,
}: {
  image: SelectedImage | null;
  scale: string;
  format: string;
  onChoose: () => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onScale: (value: string) => void;
  onFormat: (value: string) => void;
  onRemove: () => void;
}): ReactNode {
  const { t } = useTranslation(["common", "workspace"]);
  return (
    <div className="page page-enhance">
      <PageIntro eyebrow={t("workspace:eyebrow")} title={t("workspace:title")} body={t("workspace:body")} />
      <div className="workspace-grid">
        <div className="canvas-column">
          <DropSurface image={image} onChoose={onChoose} onDrop={onDrop} />
          {image && (
            <div className="canvas-actions">
              <button className="text-button" type="button" onClick={onChoose}>{t("actions.chooseImage")}</button>
              <button className="text-button danger" type="button" onClick={onRemove}>{t("actions.remove")}</button>
            </div>
          )}
        </div>
        <aside className="inspector glass-panel">
          <div className="panel-heading">
            <div><span className="panel-icon"><Icon name="enhance" size={18} /></span><strong>{t("workspace:inspector")}</strong></div>
            <span className="pending-dot">{t("status.enginePending")}</span>
          </div>
          <ControlGroup label={t("workspace:scale")}>
            <Segmented values={["2×", "3×", "4×"]} value={scale} onChange={onScale} />
          </ControlGroup>
          <div className="detail-grid">
            <InfoField label={t("workspace:quality")} value={t("workspace:qualityValue")} />
            <InfoField label={t("workspace:detail")} value={t("workspace:detailValue")} />
          </div>
          <ControlGroup label={t("workspace:format")}>
            <Segmented values={["PNG", "JPG", "WEBP"]} value={format} onChange={onFormat} />
          </ControlGroup>
          <div className="safe-note"><Icon name="shield" size={16} /><span>{t("workspace:saveRule")}</span></div>
          <button className="primary-button" type="button" disabled>
            <Icon name="lock" size={16} />{t("actions.start")}
          </button>
          <p className="disabled-copy">{t("workspace:disabledReason")}</p>
        </aside>
      </div>
    </div>
  );
}

function ControlGroup({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return <div className="control-group"><label>{label}</label>{children}</div>;
}

function Segmented({ values, value, labels, onChange }: { values: string[]; value: string; labels?: Record<string, string>; onChange: (value: string) => void }): ReactNode {
  return <div className="segmented">{values.map((item) => <button type="button" className={item === value ? "selected" : ""} key={item} onClick={() => onChange(item)}>{labels?.[item] ?? item}</button>)}</div>;
}

function InfoField({ label, value }: { label: string; value: string }): ReactNode {
  return <div className="info-field"><small>{label}</small><strong>{value}</strong></div>;
}

function BatchPage({ images, onChoose, onDrop, onRemove, onClear }: { images: SelectedImage[]; onChoose: () => void; onDrop: (event: DragEvent<HTMLElement>) => void; onRemove: (id: string) => void; onClear: () => void }): ReactNode {
  const { t } = useTranslation(["common", "batch"]);
  return (
    <div className="page">
      <PageIntro eyebrow={t("batch:eyebrow")} title={t("batch:title")} body={t("batch:body")} />
      <section className="batch-drop glass-panel" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <span className="drop-icon compact"><Icon name="batch" size={24} /><i><Icon name="plus" size={11} /></i></span>
        <div><strong>{t("batch:dropTitle")}</strong><small>{t("batch:dropBody")}</small></div>
        <button className="soft-button real-button" type="button" onClick={onChoose}>{t("actions.addImages")}</button>
      </section>
      <section className="queue-panel glass-panel">
        <header><div><h2>{t("batch:queue")}</h2><span>{t("batch:queued", { count: images.length })}</span></div>{images.length > 0 && <button className="text-button danger" type="button" onClick={onClear}>{t("actions.clear")}</button>}</header>
        {images.length === 0 ? (
          <div className="queue-empty"><Icon name="image" size={28} /><p>{t("batch:empty")}</p></div>
        ) : (
          <div className="queue-list">{images.map((image, index) => (
            <article className="queue-item" key={image.id}>
              <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
              <img src={image.url} alt="" />
              <div><strong>{image.name}</strong><small>{formatBytes(image.size)} · {t("batch:pending")}</small></div>
              <button className="icon-button" type="button" onClick={() => onRemove(image.id)} aria-label={t("actions.remove")}>×</button>
            </article>
          ))}</div>
        )}
      </section>
    </div>
  );
}

function HistoryPage(): ReactNode {
  const { t } = useTranslation("history");
  return <div className="page"><PageIntro eyebrow={t("eyebrow")} title={t("title")} body={t("body")} /><section className="empty-state glass-panel"><span className="empty-orbit"><Icon name="history" size={34} /></span><h2>{t("emptyTitle")}</h2><p>{t("emptyBody")}</p></section></div>;
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

function SettingsPage({ theme, language, appInfo, onTheme, onLanguage }: { theme: ThemeChoice; language: SupportedLanguage; appInfo: AppInfo; onTheme: (theme: ThemeChoice) => void; onLanguage: (language: SupportedLanguage) => void }): ReactNode {
  const { t } = useTranslation("settings");
  return (
    <div className="page"><PageIntro eyebrow={t("eyebrow")} title={t("title")} body={t("body")} />
      <div className="settings-grid">
        <section className="settings-card glass-panel"><h2>{t("appearance")}</h2><ControlGroup label={t("theme")}><Segmented values={["system", "light", "dark"]} value={theme} labels={{ system: t("system"), light: t("light"), dark: t("dark") }} onChange={(value) => onTheme(value as ThemeChoice)} /></ControlGroup><ControlGroup label={t("language")}><div className="segmented language"><button type="button" className={language === "zh-CN" ? "selected" : ""} onClick={() => onLanguage("zh-CN")}>{t("chinese")}</button><button type="button" className={language === "en-US" ? "selected" : ""} onClick={() => onLanguage("en-US")}>{t("english")}</button></div></ControlGroup></section>
        <section className="settings-card glass-panel"><div className="settings-heading"><h2>{t("safety")}</h2><span className="audit-badge">{t("planned")}</span></div><SettingPlan title={t("noOverwrite")} body={t("noOverwriteBody")} /><SettingPlan title={t("metadata")} body={t("metadataBody")} /><SettingPlan title={t("localOnly")} body={t("localOnlyBody")} /></section>
        <section className="settings-card about-card glass-panel"><div><small>{t("about")}</small><strong>{appInfo.name}</strong><span>{t("version", { version: appInfo.version })}</span></div><span className="brand-mark large" aria-hidden><span /></span></section>
      </div>
    </div>
  );
}

function SettingPlan({ title, body }: { title: string; body: string }): ReactNode {
  return <div className="setting-row"><span><strong>{title}</strong><small>{body}</small></span><Icon name="lock" size={14} /></div>;
}

function LicenseDialog({ onClose }: { onClose: () => void }): ReactNode {
  const { t } = useTranslation(["common", "license"]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="license-dialog glass-panel" role="dialog" aria-modal="true" aria-labelledby="license-title">
        <button className="dialog-close" type="button" aria-label={t("actions.close")} onClick={onClose}>×</button>
        <div className="license-hero"><span className="license-emblem"><Icon name="shield" size={30} /></span><div><small>{t("license:subtitle")}</small><h2 id="license-title">{t("license:title")}</h2></div><span className="state-badge">{t("license:state")}</span></div>
        <p className="license-copy">{t("license:body")}</p>
        <label className="license-field"><span>{t("license:machine")}</span><div><code>{t("license:machinePending")}</code><Icon name="lock" size={15} /></div></label>
        <label className="license-field"><span>{t("license:code")}</span><textarea rows={4} disabled placeholder={t("license:placeholder")} /></label>
        <button className="primary-button" type="button" disabled><Icon name="lock" size={16} />{t("actions.activate")}</button>
        <div className="license-footnote"><Icon name="shield" size={15} /><span>{t("license:privacy")} · {t("license:disabled")}</span></div>
      </section>
    </div>
  );
}

export default App;
