import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const scratch = await mkdtemp(join(tmpdir(), 'clarune-realhat-close-v6-'));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-v6/realhat-close');
await mkdir(review, { recursive: true });
const exe = process.env.CLARUNE_PREVIEW_EXE || require('electron');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], cases = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };

async function runCase(mode) {
  const evidencePath = join(scratch, mode + '-quit.json');
  let app;
  try {
    app = await _electron.launch({ executablePath: exe,
      args: [...(process.env.CLARUNE_PREVIEW_EXE ? [] : [project]), `--user-data-dir=${join(scratch, mode + '-profile')}`], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(mode + ': ' + error.message));
    await app.evaluate(({ app: electronApp, BrowserWindow }, { evidencePath, mode }) => {
      const fs = process.getBuiltinModule('fs'), fsPromises = process.getBuiltinModule('fs/promises');
      const childProcess = process.getBuiltinModule('child_process');
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setBackgroundThrottling(false);
      const state = globalThis.realhatCloseQa = { mode, closeRequested: false, closeAt: null,
        probes: [], workers: [], forbiddenInference: 0, readArmed: false, readsHeld: 0, readsReleased: 0,
        releases: [], readHeldAtClose: false, liveProbesAtClose: 0 };
      const spawn = childProcess.spawn;
      childProcess.spawn = function (command, args, ...rest) {
        const worker = spawn.call(this, command, args, ...rest);
        if (Array.isArray(args) && args.some(arg => String(arg).endsWith('realhat-worker.py'))) {
          state.workers.push(worker);
          if (!args.includes('--probe')) state.forbiddenInference++;
          else {
            const item = { pid: worker.pid ?? null, spawned: false, closed: false, kills: 0, spawnedAt: null, closedAt: null, code: null };
            state.probes.push(item);
            worker.once('spawn', () => { item.pid = worker.pid; item.spawned = true; item.spawnedAt = Date.now(); });
            worker.once('close', code => { item.closed = true; item.closedAt = Date.now(); item.code = code; });
            const kill = worker.kill;
            worker.kill = function (...killArgs) { item.kills++; return kill.apply(this, killArgs); };
          }
        }
        return worker;
      };
      const originalReadFile = fsPromises.readFile;
      fsPromises.readFile = function (path, ...args) {
        const reading = originalReadFile.call(this, path, ...args);
        if (state.readArmed && String(path).endsWith('Real_HAT_GAN_SRx4.pth')) {
          state.readArmed = false;
          return reading.then(bytes => new Promise(resolve => {
            state.readsHeld++;
            state.releases.push(() => { state.readsReleased++; resolve(bytes); });
          }));
        }
        return reading;
      };
      window.on('close', () => {
        if (state.closeRequested) return;
        state.closeRequested = true; state.closeAt = Date.now();
        state.readHeldAtClose = state.readsHeld > state.readsReleased;
        state.liveProbesAtClose = state.probes.filter(probe => probe.spawned && !probe.closed).length;
        // Release only this test-owned delayed read after close handling starts.
        setTimeout(() => { for (const release of state.releases.splice(0)) release(); }, 250);
      });
      electronApp.once('will-quit', () => {
        const { workers: _workers, releases: _releases, ...snapshot } = state;
        fs.writeFileSync(evidencePath, JSON.stringify({ ...snapshot, quitAt: Date.now() }, null, 2));
      });
    }, { evidencePath, mode });
    await page.getByTestId('enhance-model').waitFor();
    if (mode === 'close-during-weight-check') await app.evaluate(() => { globalThis.realhatCloseQa.readArmed = true; });
    await page.getByTestId('enhance-model').selectOption('real-hat-x4');
    await app.evaluate((_electron, mode) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const timer = setInterval(() => {
        const state = globalThis.realhatCloseQa;
        const reached = mode === 'close-during-probe' ? state.probes.some(probe => probe.spawned && !probe.closed) : state.readsHeld > state.readsReleased;
        if (reached) { clearInterval(timer); resolve(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Real-HAT did not reach ' + mode)); }
      }, 10);
    }), mode);
    const closed = app.waitForEvent('close', { timeout: 30000 });
    await app.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); });
    await closed; app = null;
    const snapshot = JSON.parse(await readFile(evidencePath, 'utf8'));
    cases.push(snapshot);
    check(mode + ': no inference was started', snapshot.forbiddenInference === 0);
    check(mode + ': quit snapshot was captured after a close request', snapshot.closeRequested && snapshot.quitAt >= snapshot.closeAt);
    if (mode === 'close-during-probe') {
      check('Close was requested while a real probe process was alive', snapshot.liveProbesAtClose > 0);
      check('Every real probe was closed before application quit', snapshot.probes.length > 0 && snapshot.probes.every(probe => probe.closed && probe.closedAt <= snapshot.quitAt));
      check('Shutdown canceled the owned active probe', snapshot.probes.some(probe => probe.kills > 0));
    } else {
      check('Close was requested during a held real checkpoint read', snapshot.readHeldAtClose && snapshot.readsHeld > 0);
      check('No late probe started from in-flight verification after close', snapshot.probes.length === 0);
    }
  } finally {
    if (app) {
      // Failure cleanup is restricted to workers recorded in this isolated test app.
      await app.evaluate(() => {
        for (const release of globalThis.realhatCloseQa?.releases.splice(0) ?? []) release();
        for (const worker of globalThis.realhatCloseQa?.workers ?? []) { if (worker.exitCode === null) worker.kill(); }
      }).catch(() => {});
      await app.close().catch(() => {});
    }
  }
}

try {
  await runCase('close-during-probe');
  await runCase('close-during-weight-check');
  check('No renderer exceptions', errors.length === 0);
} finally {
  await writeFile(join(review, 'realhat-close.json'), JSON.stringify({ date: new Date().toISOString(), exe, scratch, checks, errors, cases }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, review }));
}
