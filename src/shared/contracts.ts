import type { BatchJob, BatchProgress, BatchSummary, EnhancementJob, EnhancementProgress, ImageFormat, ImageJob, LargeEnhancement, PdfJob, ProcessedImage, SavedFile, ToolResult, UpscaleOptions, UpscaleStatus } from "./image-tools";
import type { LicenseStatus } from "./license";

export const IPC_CHANNELS = {
  appInfo: "app:get-info",
  licenseStatus: "license:get-status",
  licenseActivate: "license:activate",
  licenseCopyMachine: "license:copy-machine",
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export interface ClaruneAPI {
  getAppInfo: () => Promise<AppInfo>;
  getLicenseStatus: () => Promise<LicenseStatus>;
  activateLicense: (text: string) => Promise<LicenseStatus>;
  copyMachineCode: () => Promise<boolean>;
  processImage: (job: ImageJob) => Promise<ToolResult<ProcessedImage>>;
  saveImage: (job: ImageJob, suggestedName: string) => Promise<ToolResult<SavedFile>>;
  savePdf: (job: PdfJob, suggestedName: string) => Promise<ToolResult<SavedFile>>;
  getSystemFonts: () => Promise<ToolResult<string[]>>;
  saveBatch: (job: BatchJob) => Promise<ToolResult<BatchSummary>>;
  cancelBatch: (id: string) => Promise<ToolResult<boolean>>;
  onBatchProgress: (handler: (progress: BatchProgress) => void) => () => void;
  openOutput: (path: string) => Promise<ToolResult<null>>;
  copyOutputPath: (path: string) => Promise<ToolResult<null>>;
  getUpscaleStatus: (model?: UpscaleOptions["model"]) => Promise<ToolResult<UpscaleStatus>>;
  selectUpscaleRuntime: (model?: UpscaleOptions["model"]) => Promise<ToolResult<UpscaleStatus>>;
  enhanceImage: (job: EnhancementJob) => Promise<ToolResult<ProcessedImage | LargeEnhancement>>;
  saveLargeEnhancement: (id: string, format: ImageFormat, quality: number, suggestedName: string) => Promise<ToolResult<SavedFile>>;
  discardLargeEnhancement: (id: string) => Promise<ToolResult<boolean>>;
  cancelEnhancement: (id: string) => Promise<ToolResult<boolean>>;
  onEnhancementProgress: (handler: (progress: EnhancementProgress) => void) => () => void;
}
