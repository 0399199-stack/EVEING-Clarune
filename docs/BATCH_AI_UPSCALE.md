# Batch AI Upscale — v0.0.3-preview.4

## User flow

1. Open Batch. **AI Upscale / 图片超清** is first and selected by default on first use.
2. Select an existing verified local Real-ESRGAN runtime folder with the native picker.
   The app validates the executable, DLL and both allowlisted models against fixed
   SHA-256 values. No executable path or command-line argument is accepted from renderer job data.
3. Import one or more PNG/JPEG/WebP images; choose 2x, 3x or 4x, General or Anime,
   output format and quality. The scale supports both a slider and typed input.
4. Click Start batch AI upscale; choose a destination folder. Each item has a
   success/error state. Stop remaining finishes the current image safely.

The image tools share a recipe. Switching to compression/watermark/crop does not
silently turn off AI. The applied-edit checklist can disable AI independently.
The AI toggle also supports undo/redo and local recovery; recovered work never
starts inference automatically. An unconfigured runtime blocks only enabled AI
exports, not ordinary local editing.

## Actual processing, not simulated upscaling

Pipeline: orientation → crop → native AI 4x → requested 2x/3x downsample → optional
explicit resize → rotation/flip → watermark → rounded corners → encoding → full
decode validation → exclusive atomic publication. Existing files and inputs are
never overwritten; collisions receive numbered suffixes.

Both pinned models are native 4x. The generic CLI scale flag is **not** used to
pretend they are native 2x/3x. Inference runs in an isolated temporary folder with
shell disabled, a fixed argument allowlist, a hidden worker and a ten-minute
per-image timeout. Normal close waits for current inference and file publication.
Modern Sharp decodes and re-encodes input PNG before the legacy executable sees it.

Live editing uses ordinary resizing for layout preview only, explicitly labeled
as not an AI result. This preserves watermark/radius/output coordinate geometry
without repeatedly running the GPU. Final AI file size is shown after export.
The original/comparison viewer can load the saved output for sliding comparison.

## Limits and runtime setup

- Windows local preview with a working Vulkan GPU driver.
- At most 60 images / 128 MiB queue input; 64 MiB per file.
- Cropped AI input: at most 2,500,000 pixels and 4,096 pixels on either side.
  The native 4x intermediate is capped at 40,000,000 pixels / 16,384 per side.
  A too-large item fails explicitly; other valid batch items continue.
- General: `realesrgan-x4plus`; Anime: `realesrgan-x4plus-anime`.
- Runtime selection persists only its external directory in
  `<userData>/upscale-runtime.json`; hashes are checked again before every inference.
- The external folder must contain `realesrgan-ncnn-vulkan.exe`, `vcomp140.dll`,
  and the corresponding `.bin`/`.param` files in `models/`, matching
  `src/main/upscale/runtime.ts`. Unknown adjacent DLLs are rejected.
- This workstation's already-validated external runtime is
  `work/engine-baseline/runtime-full` under the workspace root. It is deliberately
  not copied into the portable app or source archive. Keep that folder in place,
  or use the native picker to register an independently verified matching folder.

## Release boundary

Local functionality is now connected. This does **not** approve bundling the old
runtime/model assets or releasing a paid installer. Existing provenance, model
rights, dependency modernization, code-signing and activation gates remain in
`PHASE0_EVIDENCE.md` and `MODEL_ALLOWLIST.json`.

## Reproducible checks

- Unit tests: `node node_modules/vitest/vitest.mjs run`.
- Hardware opt-in: set `CLARUNE_REAL_AI_RUNTIME` and optionally
  `CLARUNE_REAL_AI_REPORTDIR`, then run Vitest on
  `tests/upscale-integration.test.ts`. Validates real General 2x/3x/4x, Anime 4x,
  full decode, dimensions, alpha and difference from ordinary interpolation.
- Electron UI test: `tools/verify-upscale-v4.mjs` with `CLARUNE_REAL_AI_RUNTIME`,
  `CLARUNE_PLAYWRIGHT_MODULE`, optional `CLARUNE_PREVIEW_EXE` and `CLARUNE_REVIEW_DIR`.
  Uses isolated profiles/fixtures, real inference, output collision checks,
  AI toggle, compression, limits, cross-page cancellation and restart recovery.
