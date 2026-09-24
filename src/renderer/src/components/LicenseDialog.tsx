import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LicenseStatus } from "../../../shared/license";

export default function LicenseDialog({ onClose }: { onClose: () => void }): ReactNode {
  const { t, i18n } = useTranslation(["common", "license"]);
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useLayoutEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>(".dialog-close")?.focus();
    return () => { element?.close(); if (returnTo?.isConnected) returnTo.focus(); };
  }, []);
  useEffect(() => {
    let current = true;
    void window.clarune.getLicenseStatus().then(value => { if (current) setStatus(value); }).catch(() => { if (current) setNotice("failed"); });
    return () => { current = false; };
  }, []);
  const activate = async () => {
    setBusy(true); setNotice("");
    try {
      const result = await window.clarune.activateLicense(code.trim());
      setStatus(result);
      if (result.state === "active") { setCode(""); setNotice("success"); }
    } catch { setNotice("failed"); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { setNotice(await window.clarune.copyMachineCode() ? "copied" : "failed"); }
    catch { setNotice("failed"); }
  };
  const date = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);
  return <dialog ref={dialog} className="dialog-backdrop" aria-labelledby="license-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="license-dialog glass-panel">
      <button className="dialog-close" type="button" disabled={busy} aria-label={t("actions.close")} onClick={onClose}>×</button>
      <div className="license-hero"><div><small>{t("license:subtitle")}</small><h2 id="license-title">{t("license:title")}</h2></div></div>
      <p className="state-badge" data-testid="license-status" role="status">{t(`license:states.${status?.state || "loading"}`)}</p>
      <p className="license-copy">{t("license:body")}</p>
      {status?.licenseId && <dl className="license-details"><dt>{t("license:id")}</dt><dd>{status.licenseId}</dd><dt>{t("license:start")}</dt><dd>{status.notBefore ? date(status.notBefore) : "—"}</dd><dt>{t("license:end")}</dt><dd>{status.expiresAt === null ? t("license:permanent") : status.expiresAt ? date(status.expiresAt) : "—"}</dd></dl>}
      <label className="license-field"><span>{t("license:machine")}</span><textarea data-testid="license-machine" readOnly rows={3} value={status?.machineCode || ""} placeholder={t("license:machinePending")} /></label>
      <button className="soft-button" type="button" disabled={!status?.machineCode || busy} onClick={() => void copy()}>{t("license:copy")}</button>
      <label className="license-field"><span>{t("license:code")}</span><textarea data-testid="license-code" rows={4} value={code} maxLength={16_384} spellCheck={false} disabled={busy} onChange={event => setCode(event.target.value)} placeholder={t("license:placeholder")} /></label>
      <button data-testid="license-activate" className="primary-button" type="button" disabled={busy || !code.trim() || !status?.machineCode || status.state === "unconfigured"} onClick={() => void activate()}>{busy ? t("license:activating") : t("actions.activate")}</button>
      {notice && <p role="status" className="license-copy">{t(`license:${notice}`)}</p>}
      {status?.error && <p className="license-copy" role="alert">{t(`license:errors.${status.error}`, { defaultValue: t("license:failed") })}</p>}
      <div className="license-footnote"><span>{t("license:privacy")} {t("license:renewal")}</span></div>
    </section>
  </dialog>;
}
