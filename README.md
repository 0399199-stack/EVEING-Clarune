# EVEING Clarune

Clean-room Windows desktop application for local image editing and AI enhancement.
**1.0.0-rc.1 adds offline device-bound activation and a complete offline installer pipeline.
It is still a release candidate, not a commercially approved final release.**

For a new computer or a future GitHub repository, start with
[`docs/NEW_COMPUTER.md`](docs/NEW_COMPUTER.md),
[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) and
[`docs/PUBLISHING.md`](docs/PUBLISHING.md). The repository does not include the
administrator signing key, AI model weights, Python/PyTorch environment or installer.

The administrator-only `../EVEING_License_Desk_Release` is separate from the customer application.
See `docs/OFFLINE_LICENSE.md` and `docs/INSTALLATION.md` for activation and installer setup.
Imports and editing previews remain available without a license; AI processing and image/PDF
exports are checked in the main process. No production signing key is generated automatically.

## Current scope

- Original Electron/React shell with secure renderer defaults.
- Simplified Chinese and English resources with live switching.
- Ice-blue/white glass interface, clean gradient background without scenery,
  responsive controls and reduced-motion support; light and dark themes.
- Enlarged image viewer: cursor-centered wheel zoom, drag-to-pan, 1:1 and fit controls.
- Original/comparison split slider, including synchronized transforms and transparent images.
- Main AI workspace: explicit Start, native inference progress, cancel, and automatic
  original/AI sliding comparison. Save or recompress the generated result without
  running inference again. Cancel preserves the previous successful result.
- AI Upscale is first/default in the Batch workspace: real local Real-ESRGAN and
  optional Real-HAT ordinary (Natural detail), with independent runtime status,
  2x/3x/4x scale slider and typed input, general/anime models, PNG/JPEG/WebP output.
  The main workspace also links to Batch for processing a queue.
- Continuous output-quality slider below Format, with measured encoded size and
  explicit original/imported/AI result export source selection.
- Local resize/format conversion, compression, drag/numeric crop, text/image
  watermark, transparent rounded corners, rotation and horizontal/vertical flip.
- Actual local batch processing from the Batch page or any image tool: select a
  queue, adjust a shared recipe, choose one output folder, and export all images.
  Per-item progress, errors and stop-after-current-image controls are included.
- Edits persist across tool tabs and combine in one export. Undo/redo and an applied
  edit checklist let you revise or disable individual steps. Reset clears the recipe.
  Locked resizing fits each image inside the requested bounds; unlocked resizing
  stretches to the exact dimensions. Free crops use relative regions; fixed-ratio
  crops retain their chosen ratio across landscape and portrait images.
- Image-tool canvases support cursor-centered wheel zoom, pan, typed zoom, 1:1 and
  fit. Crop/watermark modes use Space + drag or middle-button drag to pan.
- Watermarks support searchable installed fonts with preview, X/Y in pixels or
  percent, live drag placement, optional edge snapping and margin guides,
  plus local image/logo selection. White logos with transparent backgrounds are recommended.
- Adjustable numeric parameters have text-entry controls as well as sliders where
  applicable, including quality, angle, opacity, watermark scale and X/Y.
- Merge ordered PNG/JPEG/WebP images into a PDF: one image per page, image-sized
  pages, A4 portrait or A4 landscape. Reorder/remove pages before saving.
- Up to 60 batch images, with a 128 MiB input payload limit including the image
  watermark repeated for every queue item. Each image remains limited to 64 MiB,
  40 megapixels and 16,384 pixels per side.
- Single-image General/Anime AI accepts up to 16 megapixels and 8,192 pixels per
  side using a disk-backed full result and a smaller UI preview. Real-HAT and
  batch/image-tool AI still limit input to 2.5 megapixels and 4,096 pixels per side.
  The models infer at native 4x; 2x/3x are AI 4x followed by downsampling.
  Editing uses ordinary layout previews, explicitly not AI results;
  inference only starts after an explicit AI start or AI export action.
- Native dialogs and exclusive atomic file publication protect existing files.
  Batch name collisions get numbered suffixes. Closing waits for active writes,
  including single-image and PDF output; reload is blocked during export.
- Global task status remains visible across pages. Failed items can be retried
  separately. Valid imports are retained when another selected image is unreadable.
- Image/PDF queues and editing parameters recover locally after restart, without
  automatically restarting exports. Clear queues to delete their recovery cache.
- Successful output history includes show-in-folder and copy-path actions.
  Comfortable/compact density is configurable in Settings.
- EVEING Clarune branding, original icon options, native Windows icon, and bilingual About intro.
- No Upscayl source code, assets, IPC code, translations, branding, or model
  files are included.
- The full candidate installer stages a private Python/PyTorch runtime and a
  HAT-only Spandrel subset alongside the pinned model files. The original ComfyUI
  environment is not changed or required by the installed application.
- Offline Ed25519 activation is connected to the UI and processing/export gates.
  Both hashed Windows MachineGuid and SMBIOS UUID must match. Expiring, future
  and perpetual licenses are supported with protected local state and renewal sequences.
  Offline checks cannot guarantee rollback resistance after local state reset,
  prevent client patching, or remotely revoke a previously issued license.
- The activation issuer is a separate internal deliverable; private signing
  keys are never part of this app or either source deliverable.

## Commands

```powershell
pnpm install
pnpm test
pnpm build
pnpm dev
```

## UI preview revision

See [`docs/UI_REVISION.md`](docs/UI_REVISION.md) for current UI behavior and
verification, and [`docs/LOCAL_IMAGE_ENGINE.md`](docs/LOCAL_IMAGE_ENGINE.md) for
processing limits and dependencies. `UI-review/` and `UI-review-ice-tools/`
contain actual packaged-app screenshots using synthetic test fixtures.

On Windows, after building, run `pwsh -NoProfile -File tools/package-preview.ps1`
to create the sibling `EVEINGClarune_Preview` folder. Keep the entire folder;
start `EVEING Clarune.exe`. This is an unsigned local preview, not an installer.

The most recent full installer candidate is `1.0.0-rc.1` revision `fix2` in a
sibling output directory, not in this source repository. It is not code-signed.
See [`docs/REALHAT_UPSCALE.md`](docs/REALHAT_UPSCALE.md) for the optional Natural detail
model, external environment setup and local-only deployment limits.
See [`docs/MAIN_AI_UPSCALE.md`](docs/MAIN_AI_UPSCALE.md) for the main workspace workflow.
See [`docs/BATCH_AI_UPSCALE.md`](docs/BATCH_AI_UPSCALE.md) for local engine setup,
actual inference verification and the unchanged commercial-distribution boundary.

The optional `tools/verify-viewer.mjs`, `tools/verify-tools.mjs`,
`tools/verify-canvas-v2.mjs` and `tools/verify-batch-v2.mjs` end-to-end checks use
Playwright and sharp; PDF checks also use `pdftoppm` to render PDFs.
Install them in your tooling environment, or set `CLARUNE_PLAYWRIGHT_MODULE` and
`CLARUNE_SHARP_MODULE` to their absolute package directories before running it.
Set `CLARUNE_PREVIEW_EXE` to test a packaged build instead of the source runtime.
See `docs/AUDIT_FIXES.md` for this revision's fixes, regression evidence and limits.
Older `UI-review*` folders describe the earlier revisions and are not a substitute
for the new regression results.

On the current development machine, registry downloads timed out. Exact-version
runtime dependency copies and an offline-generated lockfile were used; the preview
includes its own complete runtime dependency closure. If pnpm 11 tries to repair
this local dependency tree before a script, set the temporary environment variable
`pnpm_config_verify_deps_before_run=warn`, or call the tool's Node entrypoint directly.
A fresh source checkout should use the regular `pnpm install --frozen-lockfile` flow.

## Release gate

See [`docs/PHASE0_ACCEPTANCE.md`](docs/PHASE0_ACCEPTANCE.md) and
[`docs/PHASE0_EVIDENCE.md`](docs/PHASE0_EVIDENCE.md). Current status is a
technical history, not approval to sell. See `docs/PROJECT_STATUS.md` for the
current candidate and remaining release blockers.
