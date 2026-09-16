import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { enUS } from "./locales/en-US";
import { zhCN } from "./locales/zh-CN";

export const supportedLanguages = ["zh-CN", "en-US"] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

function initialLanguage(): SupportedLanguage {
  const saved = window.localStorage.getItem("clarune.language");
  if (saved === "en-US" || saved === "zh-CN") return saved;
  return window.navigator.language.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en-US";
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": zhCN,
    "en-US": enUS,
  },
  lng: initialLanguage(),
  fallbackLng: "zh-CN",
  supportedLngs: supportedLanguages,
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export async function setLanguage(language: SupportedLanguage): Promise<void> {
  window.localStorage.setItem("clarune.language", language);
  document.documentElement.lang = language;
  await i18n.changeLanguage(language);
}

document.documentElement.lang = initialLanguage();

export default i18n;
