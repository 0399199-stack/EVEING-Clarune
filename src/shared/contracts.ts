export const IPC_CHANNELS = {
  appInfo: "app:get-info",
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export interface ClaruneAPI {
  getAppInfo: () => Promise<AppInfo>;
}
