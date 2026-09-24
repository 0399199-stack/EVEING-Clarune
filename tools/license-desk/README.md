# License Desk integration boundary

The desktop app verifies Ed25519-signed licenses using a **public** release key supplied by the main process. Activation UI, Windows device binding and local protected state are implemented in the app. No private key, issuer script, or key-generation routine belongs in this Electron project or installer.

The standalone internal issuer source is delivered separately at [`EVEING_License_Desk`](../../../EVEING_License_Desk) (a sibling of `EVEINGClarune`). Keep it on a restricted signing machine. Its demonstration commands generate a private key at runtime; no key is provided in the source deliverable.

The source repository intentionally excludes the issuer and private key. Before a commercial release, repeat the public-key match, license interoperability, installer-exclusion and independent-machine checks for the exact release artifacts; see [`docs/PROJECT_STATUS.md`](../../docs/PROJECT_STATUS.md).
