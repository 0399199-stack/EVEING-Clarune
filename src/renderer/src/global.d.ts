import type { ClaruneAPI } from "../../shared/contracts";

declare global {
  interface Window {
    clarune: ClaruneAPI;
  }
}

export {};
