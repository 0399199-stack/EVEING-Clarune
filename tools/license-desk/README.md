# License Desk integration boundary

The desktop app contains only [`src/main/license/verify-license.ts`](../../src/main/license/verify-license.ts): it verifies Ed25519-signed licenses using a **public** release key supplied by the main process. No private key, issuer script, or key-generation routine belongs in this Electron project or installer.

The standalone internal issuer source is delivered separately at [`EVEING_License_Desk`](../../../EVEING_License_Desk) (a sibling of `EVEINGClarune`). Keep it on a restricted signing machine. Its demonstration commands generate a private key at runtime; no key is provided in the source deliverable.

This is a Phase 0 verification module, not an activation feature yet. Before selling licenses, add a release public key, Windows device-hash collection, DPAPI-protected highest-time and highest-sequence state, activation IPC, and packaging tests proving the issuer and private key are absent from the app archive.
