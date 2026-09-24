# Main AI workspace — v0.0.4-preview.5

## Release candidate fix2 large-image update

In the single-image workspace, General and Anime use a file-backed pipeline for
inputs over 2.5 MP or 4,096 pixels on one side, up to 16 MP and 8,192 pixels
per side. The native model still computes 4× tiles; a requested 2× or 3× output
is downsampled from that 4× result. The full image stays in a private temporary
directory until exported or discarded. Only a preview capped at 4,096 pixels
per side crosses IPC. PNG/JPEG/WebP export reads the complete image from disk;
WebP is unavailable when the final image exceeds 16,383 pixels on one side.

The previous limits below continue to apply to Real-HAT and the in-memory image
tools/batch paths. This update does not claim equivalent large-image support for
those paths. Large jobs can consume substantial GPU, memory, disk and time;
available resources vary by computer.

## Workflow

1. Open **图片超清 / AI Upscale** and import PNG, JPEG or WebP.
2. Choose 2x, 3x or 4x and General (photos) or Anime (illustrations).
3. Start AI upscaling. Only this explicit action starts inference. The original
   and previous result remain visible; replacing them and saving are locked.
4. Completion automatically shows original/AI sliding comparison and selects the
   AI result as the export source. Wheel zoom, pan and typed comparison position
   work on the same registered image coordinates.
5. Choose PNG/JPEG/WebP and output quality, then save. Re-encoding does not run AI
   again. New AI results default to quality 100. Choosing Original explicitly
   exports the original instead. Source files are never overwritten.

Native inference reports real percentages when emitted; preparation and finishing
use indeterminate stages, not invented progress. Cancel terminates only the owned
worker and waits for exit/temporary-file cleanup. It preserves the previous result.
Closing cancels single-image inference safely. Batch cancellation still finishes
the current image before stopping. Global task status and cancel work across pages.
Neither workflow resumes inference automatically after restart.

## Runtime and limits

The current workstation's `work/engine-baseline/runtime-full` sibling-workspace
runtime is detected only when no explicit runtime configuration exists. Detection
requires every pinned executable/DLL/model hash to match. A missing/corrupt explicit
configuration is not silently replaced. The native directory picker is available
under Engine and advanced settings. Main and Batch share the runtime selection.

The app does not search arbitrary disks, download components or bundle this old
external runtime. Moving the app without its development workspace requires
selecting an independently verified matching runtime. Commercial distribution,
dependency modernization, model rights and activation remain separate release gates.

- Input: at most 64 MiB, 2,500,000 pixels and 4,096 pixels on either side.
- Models infer at native 4x; 2x/3x are genuine AI 4x followed by Lanczos downsampling.
- Intermediate: at most 40 megapixels and 16,384 pixels on either side.
- Completed in-memory PNG: at most 64 MiB so later export stays within safe limits.
- One inference at a time. Main AI cannot overlap batch/export/runtime selection.
- No network upload. Processing and queue/cache state remain on this computer.

## Verification

`tools/verify-enhance-v5.mjs` runs actual main-window AI inference in an isolated
profile: automatic runtime detection, exact output dimensions, alpha/full decode,
non-interpolation pixels, automatic comparison, export without repeated GPU work,
cross-page cancel, input bounds and close/restart cleanup. It accepts
`CLARUNE_PLAYWRIGHT_MODULE`, `CLARUNE_PREVIEW_EXE` and `CLARUNE_REVIEW_DIR`.

The earlier Batch AI and image-tool suites remain regression checks. Their missing
runtime tests seed an explicit invalid runtime entry so workstation auto-detection
cannot mask the blocked-configuration branch.
