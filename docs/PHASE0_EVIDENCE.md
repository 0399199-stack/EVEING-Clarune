# Phase 0 evidence — 2026-09-16

## Actual image inference

Official candidate: `xinntao/Real-ESRGAN-ncnn-vulkan` tag `v0.2.0`, commit
`37026f49824c5cf84062e7c6a5dd71445dcf610f` (MIT). The baseline used the
official Real-ESRGAN `v0.2.5.0` Windows asset **only for this internal test**.
It is not copied into the application or approved for redistribution.

| Check | Observed result |
|---|---|
| GPU | NVIDIA GeForce RTX 5070 Ti, Vulkan |
| Model | `realesrgan-x4plus`, internal POC only |
| Command scale | `-s 4` |
| Process exit | `0` |
| Wall time | `3,044 ms` |
| Source | JPEG, `220×220`, 11,985 bytes |
| Result | PNG, `880×880`, 987,973 bytes |
| Decode | Full 32-bpp pixel-buffer decode passed |
| Non-black pixels | `774386 / 774400` (`99.9982%`) |
| Source SHA-256 before/after | `2F49C8CF6249940408FFF736F394A4F8A228A6488BCC2FE9F92BDFB90B54A504` / unchanged |
| Result SHA-256 | `E1BBBF2E066D852CA9C128097F10DA99FAE622025CB96D88F7EDF1B874D19190` |

The exact command, stderr and hash manifest remain in the non-deliverable
research workspace at `work/engine-baseline/BASELINE_REPORT.md`. Normal worker
progress was written to stderr; stderr being nonempty was not treated as failure.
The original upstream binary is unsigned and the portable archive includes
non-redistributable debug/runtime and old dependency concerns, so this result
does **not** authorize bundling that executable.

## App and license checks

| Check | Observed result |
|---|---|
| App unit tests | 3 files, 10 tests passed |
| TypeScript | main/preload/shared and renderer checks passed |
| Electron production build | main, preload and renderer bundles emitted |
| Internal License Desk tests | 2 tests passed |
| License client boundary | verifier takes a public key; no PEM/key files in app `src` or Desk source deliverable |
| Source scan | no `Upscayl` or private-key marker in app `src` and tests |
| Bundled worker/model scan | no `.exe`, `.dll`, `.bin` or `.param` in app `src` |
| UI | Built Electron window opened; Enhance, Settings and License dialog inspected |
| Localization | Chinese→English changed immediately, with no restart |
| Appearance | System/Light/Dark controls and dark dialog visually checked |
| HiDPI | `--force-device-scale-factor=1.5` and `2` inspected; primary shell and inspector remained visible without clipping |

The private signing key used by the original proof of concept was never copied
into either deliverable. The standalone Desk currently creates an **unencrypted
test key**, so real sales require protected key storage before issuance.

## Commercial go/no-go

**No-go.** The app is a working, bilingual and visually checked Phase 0 shell;
inference is proven separately. Paid release remains blocked by model-weight
redistribution evidence, an audited modern worker build, complete notices,
activation integration and installer/signing work.
