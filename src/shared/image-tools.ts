export type ImageFormat = "png" | "jpeg" | "webp";
export type ToolId = "upscale" | "resize" | "compress" | "crop" | "watermark" | "round" | "rotate" | "flip" | "pdf";
export const UPSCALE_MODELS = ["realesrgan-x4plus", "realesrgan-x4plus-anime", "real-hat-x4"] as const;
export interface UpscaleOptions { scale: 2 | 3 | 4; model: typeof UPSCALE_MODELS[number]; tileSize: 128 | 256 | 512 }
export interface UpscaleStatus { ready: boolean; localOnly: true; reason?: string; runtimeVersion?: string; source?: "selected" | "detected" }
export interface EnhancementJob { id: string; bytes: Uint8Array; upscale: UpscaleOptions }
export interface LargeEnhancement { large: true; id: string; preview: Uint8Array; width: number; height: number; size: number }
export interface EnhancementProgress { id: string; stage: "preparing" | "inference" | "finishing"; percent?: number }
export interface CropRect { left: number; top: number; width: number; height: number }
export type WatermarkPosition = "top-left" | "top-right" | "center" | "bottom-left" | "bottom-right" | "custom";
export interface WatermarkBounds { left: number; top: number; width: number; height: number }
export interface WatermarkOptions {
  text?: string;
  image?: Uint8Array;
  color: string;
  opacity: number;
  fontSize: number;
  fontFamily?: string;
  imageScale: number;
  position: WatermarkPosition;
  // Normalized top-left position over the available travel, so 0/1 align to either edge.
  x?: number;
  y?: number;
}
// Operation order: EXIF orientation -> crop -> AI upscale -> resize -> rotate -> flip -> watermark -> corners -> encode.
// Crop is measured in oriented original pixels; corner radius and watermark font size in output pixels.
export interface ImageEditOptions {
  format: ImageFormat;
  quality: number;
  upscale?: UpscaleOptions;
  crop?: CropRect;
  resize?: { width: number; height: number; fit: "fill" | "inside" };
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  radius?: number;
  watermark?: WatermarkOptions;
}
export interface ImageJob { bytes: Uint8Array; options: ImageEditOptions; previewLayers?: boolean }
export interface ProcessedImage { bytes: Uint8Array; width: number; height: number; format: ImageFormat; size: number; watermarkBounds?: WatermarkBounds; watermarkLayers?: { base: Uint8Array; overlay: Uint8Array } }
export interface PdfJob { images: Array<{ name: string; bytes: Uint8Array }>; pageSize: "image" | "a4" | "a4-landscape"; quality: number }
export interface SavedFile { path: string; size: number; width?: number; height?: number; pages?: number }
export interface BatchJob { id: string; images: Array<{ id: string; name: string; bytes: Uint8Array; options: ImageEditOptions }> }
export interface BatchItemResult { id: string; name: string; status: "saved" | "failed" | "canceled"; file?: SavedFile; error?: string }
export interface BatchProgress { id: string; completed: number; total: number; currentName?: string; item?: BatchItemResult }
export interface BatchSummary { directory: string; items: BatchItemResult[]; canceled: boolean }
export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string; canceled?: boolean };
export const IMAGE_TOOL_CHANNELS = {
  process: "image:process", save: "image:save", pdf: "image:pdf",
  fonts: "image:fonts", batch: "image:batch", cancelBatch: "image:batch-cancel", batchProgress: "image:batch-progress",
  openOutput: "image:open-output", copyOutputPath: "image:copy-output-path",
  upscaleStatus: "image:upscale-status", selectUpscaleRuntime: "image:upscale-runtime-select",
  enhance: "image:enhance", cancelEnhancement: "image:enhance-cancel", enhancementProgress: "image:enhance-progress",
  saveLargeEnhancement: "image:enhance-large-save", discardLargeEnhancement: "image:enhance-large-discard",
} as const;
