export type UpdateStatus =
  | { state: "available"; version: string }
  | { state: "current" | "no-release" | "error" };

export const UPDATE_REPOSITORY = "0399199-stack/EVEING-Clarune";
export const UPDATE_CHANNELS = {
  check: "updates:check",
  download: "updates:download",
} as const;
