import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BrandMark } from "./BrandMark";
import "./about-card.css";

export default function AboutCard({ name, version }: { name: string; version: string }): ReactNode {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <section className="settings-card clarune-about glass-panel" aria-labelledby="about-title">
      <div className="clarune-about-heading">
        <BrandMark large />
        <div>
          <h2 id="about-title">{t("about")}</h2>
          <strong>{name}</strong>
          <p>{t("version", { version })}</p>
        </div>
      </div>
      <div className="clarune-about-intro">
        <div className="clarune-about-product">
          <h3>{t("common:brandIntroName")}</h3>
          <span>{t("common:brandIntroSubtitle")}</span>
        </div>
        <p className="clarune-about-lead">{t("introLead")}</p>
        <p className="clarune-about-body">{t("introBody")}</p>
        <p className="clarune-about-tagline">{t("introTagline")}</p>
      </div>
      <dl className="clarune-about-details">
        <div><dt>{t("copyright")}</dt><dd>© EVEING</dd></div>
        <div><dt>{t("developer")}</dt><dd>EVEING</dd></div>
        <div><dt>{t("email")}</dt><dd className="clarune-about-email">0399199@gmail.com</dd></div>
      </dl>
    </section>
  );
}
