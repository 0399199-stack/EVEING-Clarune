import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.CLARUNE_SHARP_MODULE || 'sharp');
const scratch = await mkdtemp(join(tmpdir(), 'clarune-realhat-ui-v6-'));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-v6/realhat-ui');
await mkdir(review, { recursive: true });
const fixture = join(scratch, '澄像 Real-HAT · layout and recovery.png');
await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#93d5ed"/><circle cx="225" cy="66" r="38" fill="#edfaff"/><text x="24" y="150" fill="#183451" font-size="23">CLARUNE Real-HAT QA</text></svg>')).png().toFile(fixture);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const exe = process.env.CLARUNE_PREVIEW_EXE || require('electron');
const app = await _electron.launch({ executablePath: exe, args: [...(process.env.CLARUNE_PREVIEW_EXE ? [] : [project]), `--user-data-dir=${join(scratch, 'profile')}`], env });
const page = await app.firstWindow(); page.setDefaultTimeout(20000);
await page.emulateMedia({ reducedMotion: 'reduce' });
const checks = [], errors = [], layouts = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
page.on('pageerror', error => errors.push(error.message));
const hat = 'real-hat-x4', general = 'realesrgan-x4plus', anime = 'realesrgan-x4plus-anime';
const readyStatus = { ready: true, localOnly: true, source: 'selected', runtimeVersion: 'Mock runtime; no inference' };
const missingStatus = { ready: false, localOnly: true, reason: 'REALHAT_RUNTIME_NOT_CONFIGURED' };
await app.evaluate(({ BrowserWindow, ipcMain }) => {
  BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
  globalThis.realhatUi = { held: [], pending: [], calls: [], selections: [], forbidden: [], status: {
    'realesrgan-x4plus': { ready: true, localOnly: true },
    'realesrgan-x4plus-anime': { ready: true, localOnly: true },
    'real-hat-x4': { ready: false, localOnly: true, reason: 'REALHAT_RUNTIME_NOT_CONFIGURED' },
  } };
  for (const channel of ['image:enhance', 'image:save', 'image:batch', 'image:pdf']) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => { globalThis.realhatUi.forbidden.push(channel); return { ok: false, error: 'UI_QA_EXPORT_FORBIDDEN' }; });
  }
  ipcMain.removeHandler('image:upscale-status');
  ipcMain.handle('image:upscale-status', (_event, requestedModel) => {
    const state = globalThis.realhatUi, model = requestedModel || 'realesrgan-x4plus', id = state.calls.length + 1;
    state.calls.push({ id, model });
    if (state.held.includes(model)) return new Promise(resolve => state.pending.push({ id, model, resolve }));
    return { ok: true, value: state.status[model] };
  });
  ipcMain.removeHandler('image:upscale-runtime-select');
  ipcMain.handle('image:upscale-runtime-select', (_event, model) => {
    const state = globalThis.realhatUi; state.selections.push(model);
    state.status[model] = { ready: true, localOnly: true, source: 'selected' };
    return { ok: true, value: state.status[model] };
  });
});
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('clarune:upscale-runtime-change')));
const nav = target => page.getByTestId('nav-' + target).click();
const hold = models => app.evaluate((_electron, models) => { globalThis.realhatUi.held = models; }, models);
const setStatus = (model, status) => app.evaluate((_electron, value) => { globalThis.realhatUi.status[value.model] = value.status; }, { model, status });
async function waitPending(model, minimum = 1) {
  await app.evaluate((_electron, { model, minimum }) => new Promise((resolve, reject) => {
    const end = Date.now() + 15000;
    const timer = setInterval(() => {
      if (globalThis.realhatUi.pending.filter(item => item.model === model).length >= minimum) { clearInterval(timer); resolve(); }
      else if (Date.now() > end) { clearInterval(timer); reject(new Error('Expected held status request for ' + model)); }
    }, 10);
  }), { model, minimum });
}
async function release(model, status, newestOnly = false) {
  const count = await app.evaluate((_electron, { model, status, newestOnly }) => {
    const state = globalThis.realhatUi, matches = state.pending.filter(item => item.model === model);
    const selected = newestOnly ? matches.slice(-1) : matches;
    state.pending = state.pending.filter(item => !selected.includes(item));
    for (const item of selected) item.resolve({ ok: true, value: status });
    return selected.length;
  }, { model, status, newestOnly });
  assert.ok(count, 'No pending response to release for ' + model); await frames();
}
async function waitStatus(id, ready) {
  await page.waitForFunction(({ id, ready }) => {
    const text = document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
    return ready ? /^(Connected|已连接)$/.test(text.trim()) : /^(Not connected|未连接)$/.test(text.trim());
  }, { id, ready });
}
async function importMain() {
  await page.getByTestId('original-file-input').setInputFiles(fixture);
  await page.waitForFunction(() => document.querySelector('.viewer-original-layer img') && !document.querySelector('[data-testid="original-file-input"]').disabled);
}
try {
  await page.reload(); await page.getByTestId('enhance-model').waitFor(); await importMain();
  await waitStatus('enhance-runtime-status', true);
  check('Existing general default and 128 main tile are preserved', await page.getByTestId('enhance-model').inputValue() === general && await page.getByTestId('enhance-tile').inputValue() === '128');
  const choices = await page.getByTestId('enhance-model').locator('option').evaluateAll(options => options.map(option => option.value));
  check('Real-HAT is first; both existing models remain', choices.join(',') === [hat, general, anime].join(','));

  await hold([hat]); await page.getByTestId('enhance-model').selectOption(hat); await waitPending(hat);
  check('Model change immediately blocks start while detection is held', await page.getByTestId('enhance-start').isDisabled() && /Checking|检查/.test(await page.getByTestId('enhance-runtime-status').innerText()));
  await page.getByTestId('enhance-model').selectOption(general); await waitStatus('enhance-runtime-status', true);
  await release(hat, missingStatus);
  check('Late missing Real-HAT response cannot overwrite current ncnn ready state', !(await page.getByTestId('enhance-start').isDisabled()) && await page.getByTestId('enhance-model').inputValue() === general);

  await hold([anime, hat]); await page.getByTestId('enhance-model').selectOption(anime); await waitPending(anime);
  await page.getByTestId('enhance-model').selectOption(hat); await waitPending(hat);
  await release(hat, missingStatus); await waitStatus('enhance-runtime-status', false);
  await release(anime, readyStatus);
  check('Late ncnn ready cannot enable missing Real-HAT', await page.getByTestId('enhance-start').isDisabled() && /未连接|Not connected/.test(await page.getByTestId('enhance-runtime-status').innerText()));
  check('Real-HAT setup and facial-detail warning are model-specific', (await page.locator('.page-enhance .ai-runtime-settings').innerText()).includes('PyTorch') && (await page.getByTestId('enhance-model-hint').innerText()).includes('五官'));

  await hold([hat]); await refresh(); await waitPending(hat);
  await refresh(); await waitPending(hat, 2);
  await release(hat, missingStatus, true); await waitStatus('enhance-runtime-status', false);
  await release(hat, readyStatus);
  check('Earlier response for the same model cannot overwrite newer failed check', await page.getByTestId('enhance-start').isDisabled());

  await hold([]); await nav('batch'); await page.getByTestId('batch-tool-upscale').click();
  await page.getByTestId('tool-file-input').setInputFiles([fixture, fixture]);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="batch-item"]').length === 2 && !document.querySelector('[data-testid="tool-upscale-model"]').disabled);
  check('Batch preserves existing general model and 256 tile default', await page.getByTestId('tool-upscale-model').inputValue() === general && await page.getByTestId('tool-upscale-tile').inputValue() === '256');
  await hold([hat]); await page.getByTestId('tool-upscale-model').selectOption(hat); await waitPending(hat);
  check('Batch and selected-image exports block during model check', await page.getByTestId('tool-batch-export').isDisabled() && await page.getByTestId('tool-export').isDisabled());
  await page.getByTestId('tool-upscale-model').selectOption(anime); await waitStatus('tool-upscale-status', true);
  await release(hat, missingStatus);
  check('Late batch Real-HAT status cannot replace selected anime readiness', !(await page.getByTestId('tool-batch-export').isDisabled()) && await page.getByTestId('tool-upscale-model').inputValue() === anime);
  await hold([]); await page.getByTestId('tool-upscale-model').selectOption(hat); await waitStatus('tool-upscale-status', false);
  await page.getByTestId('tool-upscale-tile').selectOption('128');
  check('Missing Real-HAT disables both batch export paths', await page.getByTestId('tool-batch-export').isDisabled() && await page.getByTestId('tool-export').isDisabled());
  await nav('enhance'); await waitStatus('enhance-runtime-status', false);
  check('Page switching never borrows another model readiness', await page.getByTestId('enhance-model').inputValue() === hat && await page.getByTestId('enhance-start').isDisabled());
  await nav('batch'); await page.getByTestId('tool-upscale-runtime-select').click(); await waitStatus('tool-upscale-status', true);
  await nav('enhance'); await waitStatus('enhance-runtime-status', true);
  check('Selecting Real-HAT environment passes its model and refreshes both pages', await app.evaluate(() => globalThis.realhatUi.selections.at(-1)) === hat && !(await page.getByTestId('enhance-start').isDisabled()));

  for (const language of ['zh-CN', 'en-US']) for (const theme of ['light', 'dark']) {
    await page.evaluate(({ language, theme }) => { localStorage.setItem('clarune.language', language); localStorage.setItem('clarune.theme', theme); }, { language, theme });
    await page.reload(); await importMain();
    await page.getByTestId('enhance-model').selectOption(hat); await waitStatus('enhance-runtime-status', true);
    check(language + ' ' + theme + ' localized model and honest hint', (await page.getByTestId('enhance-model').locator('option:checked').innerText()).includes(language === 'zh-CN' ? '自然超清' : 'Natural detail') && (await page.getByTestId('enhance-model-hint').innerText()).includes(language === 'zh-CN' ? '不保证' : 'not guaranteed'));
    for (const target of ['enhance', 'batch']) {
      await nav(target);
      if (target === 'batch') {
        await page.getByTestId('batch-tool-upscale').click(); await waitStatus('tool-upscale-status', true);
        check(language + ' ' + theme + ' batch restores Real-HAT recipe without inference', await page.getByTestId('tool-upscale-model').inputValue() === hat && await page.getByTestId('tool-upscale-tile').inputValue() === '128' && await page.getByTestId('batch-item').count() === 2);
      }
      for (const size of [[980, 680], [1280, 820]]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size); await frames();
        const label = `${language}-${theme}-${target}-${size[0]}`;
        const geometry = await page.evaluate(target => {
          const pane = document.querySelector(target === 'enhance' ? '.page-enhance .inspector' : '.tool-inspector');
          const stage = document.querySelector('.main-stage');
          return { viewport: [innerWidth, innerHeight], body: [document.body.scrollWidth, document.body.scrollHeight], pane: [pane.clientWidth, pane.scrollWidth], stage: [stage.clientWidth, stage.scrollWidth] };
        }, target);
        assert.ok(geometry.body[0] <= geometry.viewport[0] + 1 && geometry.body[1] <= geometry.viewport[1] + 2, label + ' body overflow');
        assert.ok(geometry.pane[1] <= geometry.pane[0] + 1 && geometry.stage[1] <= geometry.stage[0] + 1, label + ' horizontal overflow');
        for (const id of target === 'enhance' ? ['enhance-model', 'enhance-model-hint', 'enhance-start', 'open-batch-upscale'] : ['tool-upscale-model', 'tool-upscale-model-hint', 'tool-batch-export', 'tool-export']) {
          await page.getByTestId(id).scrollIntoViewIfNeeded();
          const reachable = await page.getByTestId(id).evaluate(element => {
            const box = element.getBoundingClientRect();
            return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;
          });
          assert.ok(reachable, label + ' inaccessible ' + id);
        }
        await page.getByTestId(target === 'enhance' ? 'enhance-model' : 'tool-upscale-model').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(review, label + '.png') }); layouts.push({ label, ...geometry });
      }
    }
  }
  await nav('enhance');
  for (const reason of ['REALHAT_RUNTIME_NOT_CONFIGURED', 'REALHAT_RUNTIME_UNVERIFIED', 'REALHAT_DEPENDENCIES_MISSING', 'REALHAT_CUDA_UNAVAILABLE', 'REALHAT_OUT_OF_MEMORY', 'REALHAT_ENGINE_FAILED']) {
    await setStatus(hat, { ...missingStatus, reason }); await refresh(); await waitStatus('enhance-runtime-status', false);
    const content = await page.locator('.page-enhance .ai-runtime-settings').innerText();
    check(reason + ' has translated actionable setup text', content.includes('Real-HAT') && !content.includes(reason) && await page.getByTestId('enhance-start').isDisabled());
  }
  check('No GPU inference or export was attempted', (await app.evaluate(() => globalThis.realhatUi.forbidden)).length === 0);
  check('No renderer exceptions', errors.length === 0);
} catch (error) {
  await page.screenshot({ path: join(review, 'failure.png') }).catch(() => {}); throw error;
} finally {
  const mock = await app.evaluate(() => ({ calls: globalThis.realhatUi.calls, selections: globalThis.realhatUi.selections, forbidden: globalThis.realhatUi.forbidden })).catch(() => null);
  await writeFile(join(review, 'realhat-ui.json'), JSON.stringify({ date: new Date().toISOString(), exe, scratch, checks, layouts, errors, mock }, null, 2));
  await app.close(); console.log(JSON.stringify({ passed: checks.length, layouts: layouts.length, errors, review }));
}
