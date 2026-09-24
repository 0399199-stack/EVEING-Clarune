# EVEING Clarune project guidance

Scope: this repository only. Do not add the enclosing Codex workspace, sibling
`work/`, other `outputs/`, customer images, license issuer, signing keys or
generated installers to this Git repository.

Before changing code, state the assumption and a checkable success criterion.
If the task is ambiguous, ask; do not silently broaden it. Prefer the smallest
change, preserve unrelated work, and do not refactor adjacent working code.

Keep the renderer untrusted: filesystem access, license gates, native inference
and output publication belong in the main process behind validated IPC. Keep
processing local; no network upload, bundled adware, silent settings changes or
automatic overwrite of user images. Preserve Chinese/English parity and the
ice-blue/white glass design unless a task explicitly changes them.

Do not copy Upscayl code/assets/models. Do not commit AI weights, the staged
Python/PyTorch runtime, the license issuer, private keys, customer licenses or
private test photos. Source notices and exact dependency/model provenance must
remain reviewable; do not infer commercial rights from a project's code license.

Verification for code changes: run `pnpm test` and `pnpm build` (or the exact
installed tool entrypoints if pnpm attempts to repair the local environment),
then test the affected workflow. Record failures rather than hiding them.
Before a release, also review `docs/PROJECT_STATUS.md`, `docs/RELEASE_GATES.md`,
`docs/INSTALLATION.md` and `docs/PUBLISHING.md`. For a new development machine,
follow `docs/NEW_COMPUTER.md`; external resources are listed in
`docs/EXTERNAL_ASSETS.md`.
