import type { BrowserWindow } from "electron";
import type { ImageToolsLifecycle } from "./ipc";

/** Normal close finishes output writes and cancels/cleans up explicit AI inference. */
export function protectOutputClose(window: BrowserWindow, lifecycle: ImageToolsLifecycle): void {
  let waiting = false;
  let ready = false;
  window.on("close", (event) => {
    if (ready) return;
    const completion = lifecycle.requestOutputStop();
    if (!completion) { ready = true; return; }
    event.preventDefault();
    if (waiting) return;
    waiting = true;
    void completion.then(() => {
      ready = true;
      if (!window.isDestroyed()) window.close();
    });
  });
  // Export IPC promises can still be resolving in the renderer when main is done.
  // Only the final safe close may bypass its beforeunload reload protection.
  window.webContents.on("will-prevent-unload", (event) => {
    if (ready) event.preventDefault();
  });
}
