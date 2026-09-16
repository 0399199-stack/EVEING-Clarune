# Phase 0 acceptance — 2026-09-16

Status: **technical prototype verified; paid distribution blocked**. This is
not a finished enhancer or a sellable installer. See `PHASE0_EVIDENCE.md` for
exact measurements and `RELEASE_GATES.md` for commercial blockers.

## Passed in this workspace

- [x] Original Electron/React source and tests contain no Upscayl code or
      assets; source scan found no Upscayl reference outside audit documents.
- [x] The candidate MIT worker is pinned to an immutable upstream commit; its
      license and the candidate dependency licenses were audited.
- [x] Internal-POC model files have official source, byte size and SHA-256 in
      `MODEL_ALLOWLIST.json`. No model is bundled in the app.
- [x] Real GPU inference completed on this Windows machine: `220×220 → 880×880`,
      exit code 0, output present and fully decoded; the input hash was unchanged.
- [x] Chinese/English switching, System/Light/Dark themes and 100%/150%/200%
      forced-scale visual checks passed for the shell.
- [x] BrowserWindow security options and bilingual resource parity tests pass.
- [x] Ed25519 tests reject tampering, expiry, wrong product/device and sequence
      rollback; client source/build contains no signing key or issuer.
- [x] App tests `10/10`, internal issuer tests `2/2`, TypeScript check and
      Electron production build pass.

## Not yet passed

- [ ] Rebuild the worker against a supported, pinned ncnn/glslang/libwebp chain,
      run the full inference regression suite and sign the resulting binary.
- [ ] Obtain explicit commercial redistribution clearance for selected model
      weights or documented legal risk approval. Current model status is
      **internal POC only**.
- [ ] Connect a vetted worker/model to the app; implement queue, cancellation,
      `.partial` output and final decode/dimension verification.
- [ ] Add production public key, device-hash collection, DPAPI rollback state,
      activation IPC and release packaging checks. The UI currently disables
      activation and processing intentionally.
- [ ] Add complete third-party license texts, final SBOM, clean-machine
      installation test and installer signature.
