import type { ToolId } from "./image-tools";

export type Page = "enhance" | "batch" | "history" | "models" | "settings" | "douyin" | ToolId;
export const toolPages: ToolId[] = ["resize", "compress", "crop", "watermark", "round", "rotate", "flip", "pdf"];
export const navigationGroups: Array<{ title: string; items: Page[]; collapsible?: boolean }> = [
  { title: "workspaceGroup", items: ["enhance", "batch"] },
  { title: "toolsGroup", items: toolPages },
  { title: "videoParserGroup", items: ["douyin"], collapsible: true },
  { title: "appGroup", items: ["history", "models", "settings"] },
];
const routes: Record<Page, string> = {
  enhance: "/enhance", batch: "/batch", history: "/history", models: "/models", settings: "/settings",
  resize: "/resize", compress: "/compress", crop: "/crop", watermark: "/watermark", round: "/round", rotate: "/rotate", flip: "/flip", pdf: "/pdf", upscale: "/upscale",
  douyin: "/video-parser/douyin",
};
export const pageRoute = (page: Page): string => routes[page];
export function pageFromHash(hash: string): Page {
  const path = hash.replace(/^#/, "").replace(/\/$/, "");
  if (path === "/video-parser") return "douyin";
  return (Object.entries(routes).find(([, route]) => route === path)?.[0] as Page | undefined) ?? "enhance";
}
