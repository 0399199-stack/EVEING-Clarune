# EVEING Clarune

Clean-room Windows desktop application for local AI image enlargement and
enhancement. The project is currently at **Phase 0**.

## Current scope

- Original Electron/React shell with secure renderer defaults.
- Simplified Chinese and English resources with live switching.
- Canvas-first glass interface prototype.
- No Upscayl source code, assets, IPC code, translations, branding, or model
  files are included.
- The inference worker and commercial model allowlist are not yet bundled.
- The app includes a public-key license verifier proof of concept, but it is
  not connected to the disabled activation UI yet.
- The activation issuer is a separate internal deliverable; private signing
  keys are never part of this app or either source deliverable.

## Commands

```powershell
pnpm install
pnpm test
pnpm build
pnpm dev
```

## Phase 0 completion gate

See [`docs/PHASE0_ACCEPTANCE.md`](docs/PHASE0_ACCEPTANCE.md) and
[`docs/PHASE0_EVIDENCE.md`](docs/PHASE0_EVIDENCE.md). Current status is a
verified technical prototype, **not** a paid-release candidate.
