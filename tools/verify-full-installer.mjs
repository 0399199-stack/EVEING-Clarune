import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = resolve(import.meta.dirname, '..');
const workspace = resolve(project, '../..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const work = join(workspace, 'work');
const reviewRoot = join(work, 'full-installer-review');
await mkdir(reviewRoot, { recursive: true });
const run = await mkdtemp(join(reviewRoot, 'run-'));
const profile = join(run, 'isolated-profile');
const extract = join(run, 'extracted');
const publicFile = join(run, 'TEST-ONLY-public.pem');
const systemRoot = process.env.SystemRoot || process.env.WINDIR;
assert.ok(systemRoot, 'Windows SystemRoot must be available');
const systemOnlyPath = [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32/Wbem')].join(';');
const pwsh = process.env.CLARUNE_POWERSHELL_EXE || 'C:/Users/15168/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
const unpacker = join(work, 'installer-tools/innounp-latest/innounp.exe');
const fixedInstaller = join(work, 'release-installer-test/TEST-ONLY-EVEING-Clarune-1.0.0-rc.1-Full-x64-Setup-fix1.exe');
const fixedEvidence = fixedInstaller.replace(/\.exe$/, '.evidence.json');
const installer = join(run, basename(fixedInstaller));
const checks = [], models = [], errors = [], sensitive = [];
const report = { createdAt: new Date().toISOString(), run, checks, models, errors, installationExecuted: false,
  systemRedistributableExecuted: false, privateKeyPersisted: false,
  scope: 'One full TEST-ONLY installer compiled, archive extracted, extracted packaged application exercised. No installation, upgrade or uninstall was executed.' };
let app, page;
let { privateKey, publicKey } = generateKeyPairSync('ed25519');
await writeFile(publicFile, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
report.publicKeyFingerprint = fingerprint;
const sanitize = (value) => {
  let result = String(value).replace(/CLARUNE-(?:DEVICE|LICENSE)-1\.[A-Za-z0-9_-]+/g, '[redacted]');
  for (const secret of sensitive) if (secret) result = result.split(secret).join('[redacted]');
  return result;
};
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const beneath = (parent, child) => { const rel = relative(resolve(parent), resolve(child)); return rel && !isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(child).startsWith('\\\\'); };
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function runProcess(label, executable, args, logName, env = process.env) {
  console.log(`START ${label}`);
  const started = Date.now();
  const log = createWriteStream(join(run, logName), { flags: 'wx' });
  const child = spawn(executable, args, { cwd: project, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const append = (chunk) => { const text = sanitize(chunk.toString()); log.write(text); tail = (tail + text).slice(-5000); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const timer = setInterval(() => console.log(`RUNNING ${label} ${Math.round((Date.now() - started) / 1000)}s`), 30000);
  try {
    await new Promise((resolveRun, rejectRun) => {
      child.once('error', rejectRun);
      child.once('close', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${label} failed (${code}): ${tail}`)));
    });
  } finally { clearInterval(timer); await new Promise((done) => log.end(done)); }
  console.log(`DONE ${label} ${Math.round((Date.now() - started) / 1000)}s`);
}
async function closeApp() {
  if (!app) return;
  const closed = app.waitForEvent('close', { timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); });
  await closed; app = null; page = null;
}
const appEnv = { ...process.env, PATH: systemOnlyPath };
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PYTHONPATH', 'PYTHONHOME', 'NODE_PATH', 'CLARUNE_PREVIEW_EXE']) delete appEnv[name];
let applicationDirectory;
async function launchApp() {
  const executablePath = join(applicationDirectory, 'EVEING Clarune.exe');
  app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env: appEnv, timeout: 60000 });
  page = await app.firstWindow({ timeout: 60000 }); page.setDefaultTimeout(120000);
  page.on('pageerror', (error) => errors.push(sanitize(error.message)));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const paths = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, app: app.getAppPath(), resources: process.resourcesPath,
    exe: app.getPath('exe'), profile: app.getPath('userData'), version: app.getVersion(), path: process.env.PATH }));
  check('Extracted exe is the real packaged application', paths.packaged && samePath(paths.exe, executablePath));
  check('Packaged resources and application paths resolve only inside extraction', samePath(paths.resources, join(applicationDirectory, 'resources')) && samePath(paths.app, join(applicationDirectory, 'resources/app')));
  check('Single-instance isolation uses the explicit disposable userData', samePath(paths.profile, profile));
  check('Packaged app has expected candidate version and system-only PATH', paths.version === '1.0.0-rc.1' && paths.path === systemOnlyPath);
  await page.getByTestId('enhance-model').waitFor();
  const renderedFile = fileURLToPath(page.url());
  check('Renderer is a packaged file URL, not a developer server', page.url().startsWith('file:') && beneath(join(applicationDirectory, 'resources/app/out/renderer'), renderedFile));
  report.runtime = { isPackaged: paths.packaged, executable: paths.exe, appPath: paths.app, resourcesPath: paths.resources, userData: paths.profile, rendererFile: renderedFile, systemOnlyPath: paths.path === systemOnlyPath };
  await app.evaluate(({ BrowserWindow, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1280, 850); window.webContents.setBackgroundThrottling(false);
    globalThis.__fullQa = { saveDialogs: 0, savePath: null, processes: [] };
    // Only native save selection is supplied by the test. License, status and all AI handlers remain untouched.
    dialog.showSaveDialog = async () => {
      globalThis.__fullQa.saveDialogs++;
      return globalThis.__fullQa.savePath ? { canceled: false, filePath: globalThis.__fullQa.savePath } : { canceled: true };
    };
    const path = process.getBuiltinModule('path');
    const child = process.getBuiltinModule('child_process'), originalSpawn = child.spawn;
    const base = path.join(process.resourcesPath, 'ai').toLowerCase() + path.sep;
    child.spawn = function (command, args, options) {
      if (String(command).toLowerCase().endsWith('python.exe') || String(command).toLowerCase().endsWith('realesrgan-ncnn-vulkan.exe')) {
        const values = (args || []).map(String);
        const modelPath = values.includes('--model') ? values[values.indexOf('--model') + 1] : values.includes('-m') ? path.resolve(options?.cwd || '', values[values.indexOf('-m') + 1]) : null;
        globalThis.__fullQa.processes.push({ command: path.basename(command), bundled: path.resolve(command).toLowerCase().startsWith(base),
          inference: values.includes('--input') || values.includes('-i'), pythonNoBytecode: values.includes('-B'),
          bundledModel: modelPath === null || path.resolve(modelPath).toLowerCase().startsWith(base),
          localWorker: !values.some((value) => value.endsWith('realhat-worker.py') && path.resolve(value) !== path.join(process.resourcesPath, 'realhat-worker.py')),
          systemOnlyPath: options?.env?.PATH === path.join(process.env.SystemRoot, 'System32') || options?.env?.Path === path.join(process.env.SystemRoot, 'System32') });
      }
      return originalSpawn.call(this, command, args, options);
    };
  });
}
function issue(claims) {
  const payload = Buffer.from(JSON.stringify(claims));
  const token = 'CLARUNE-LICENSE-1.' + Buffer.from(JSON.stringify({ version: 1, alg: 'Ed25519', payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') })).toString('base64url');
  sensitive.push(token); return token;
}
async function screenshot(name) {
  if (page) await page.screenshot({ path: join(run, name), mask: [page.getByTestId('license-machine'), page.getByTestId('license-code')] });
}

try {
  await access(pwsh); await access(unpacker);
  check('Archive extractor matches the locally reviewed binary hash', await sha256(unpacker) === '94377351f03257b06e221285b16d41108040151ab672b96faf1d3d874a7d0a32');
  try { await access(fixedInstaller); throw new Error('A previous TEST-ONLY installer still exists at the fixed pipeline output; archive it explicitly before this test.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const compileEnv = { ...process.env, PATH: `${resolve(process.execPath, '..')};${process.env.PATH || ''}` };
  await runProcess('compile-full-TEST-ONLY-installer', pwsh, ['-NoProfile', '-File', join(project, 'tools/package-release.ps1'), '-CompileOnly', '-TestOnly', '-PublicKeyPem', publicFile], 'compiler.log', compileEnv);
  const packaging = JSON.parse(await readFile(fixedEvidence, 'utf8'));
  check('Pipeline marks the installer TEST-ONLY and binds this ephemeral public key', packaging.testOnly === true && packaging.publicKeyFingerprint === fingerprint && packaging.allAiFileHashesVerified === true);
  check('Full installer uses the reviewed long-path-capable 64-bit compiler', packaging.generatedBy === 'Inno Setup 7.1.0 x64');
  check('Compiler produced a single EXE without split data volumes', !(await readdir(resolve(fixedInstaller, '..'))).some((file) => /^TEST-ONLY-EVEING-Clarune.*\.bin$/i.test(file)));
  assert.ok(beneath(work, fixedInstaller) && beneath(run, installer), 'Only newly created test artifacts may be archived');
  await rename(fixedInstaller, installer);
  await rename(fixedEvidence, join(run, 'installer.evidence.json'));
  report.installer = installer;
  report.installerBytes = packaging.bytes;
  report.installerSha256 = await sha256(installer);
  check('Archived test installer matches the pipeline SHA-256', report.installerSha256 === packaging.installerSha256);
  console.log(`ARCHIVED TEST-ONLY installer: ${installer}`);
  await mkdir(extract);
  await runProcess('extract-installer-archive-without-running-setup', unpacker, ['-x', '-b', '-q', '-a', '-m', `-d${extract}`, installer], 'extractor.log');
  applicationDirectory = join(extract, '{app}');
  await access(join(applicationDirectory, 'EVEING Clarune.exe'));
  check('Full installer contains the standalone app and bundled Python/three-model payload', (await Promise.all([
    'resources/ai/realhat/python/python.exe', 'resources/ai/realhat/models/Real_HAT_GAN_SRx4.pth',
    'resources/ai/ncnn/models/realesrgan-x4plus.bin', 'resources/ai/ncnn/models/realesrgan-x4plus-anime.bin',
    'Prerequisites/vc_redist.x64.exe', 'Prerequisites/Microsoft-VC-v14-License.docx'
  ].map((file) => access(join(applicationDirectory, file)).then(() => true)))).every(Boolean));
  check('Extracted public key exactly matches this run, with no private key material', (await readFile(join(applicationDirectory, 'resources/license-public-key.pem'), 'utf8')).trim() === publicKey.export({ type: 'spki', format: 'pem' }).trim());
  const aiDirectory = join(applicationDirectory, 'resources/ai');
  const manifestFile = join(aiDirectory, 'runtime-manifest.json');
  check('Extracted AI manifest matches the fully verified staged manifest', await sha256(manifestFile) === packaging.aiManifestSha256);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.equal(manifest.files.length, packaging.aiFileCount);
  let longestPath = 0;
  for (const entry of manifest.files) {
    const file = resolve(aiDirectory, entry.path);
    assert.ok(beneath(aiDirectory, file), 'AI manifest path stays inside extracted runtime');
    assert.equal((await stat(file)).size, entry.bytes, `Extracted AI size: ${entry.path}`);
    assert.equal(await sha256(file), entry.sha256, `Extracted AI SHA-256: ${entry.path}`);
    longestPath = Math.max(longestPath, file.length);
  }
  check('Every extracted AI runtime and third-party license file passes its full SHA-256', manifest.files.length > 0);
  report.extractedAi = { filesVerified: manifest.files.length, longestAbsolutePath: longestPath, allHashesMatch: true };
  const fixture = join(run, 'fixture-96x64.png');
  const raw = Buffer.alloc(96 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
    const i = (y * 96 + x) * 4;
    raw[i] = Math.round(x * 255 / 95); raw[i + 1] = Math.round(y * 255 / 63); raw[i + 2] = x % 8 < 4 ? 230 : 35; raw[i + 3] = x < 8 ? 0 : x < 48 ? 128 : 255;
  }
  await sharp(raw, { raw: { width: 96, height: 64, channels: 4 } }).png().toFile(fixture);
  const fixtureBuffer = await readFile(fixture), fixtureBytes = Array.from(fixtureBuffer);
  report.fixtureSha256 = createHash('sha256').update(fixtureBuffer).digest('hex');
  await launchApp();
  const status = await page.evaluate(() => window.clarune.getLicenseStatus());
  sensitive.push(status.machineCode);
  check('Fresh extracted app is inactive and reads an actual Windows machine code', status.state === 'inactive' && status.machineCode?.startsWith('CLARUNE-DEVICE-1.'));
  const device = JSON.parse(Buffer.from(status.machineCode.slice('CLARUNE-DEVICE-1.'.length), 'base64url').toString('utf8')).device_component_hashes;
  for (const hash of Object.values(device)) sensitive.push(hash);
  const denied = await page.evaluate(async (bytes) => ({
    ai: await window.clarune.enhanceImage({ id: 'installer-locked', bytes: new Uint8Array(bytes), upscale: { model: 'real-hat-x4', scale: 4, tileSize: 128 } }),
    save: await window.clarune.saveImage({ bytes: new Uint8Array(bytes), options: { format: 'png', quality: 100 } }, 'locked')
  }), fixtureBytes);
  check('Real main-process gates deny unlicensed inference and image export', !denied.ai.ok && denied.ai.error === 'LICENSE_REQUIRED' && !denied.save.ok && denied.save.error === 'LICENSE_REQUIRED');
  check('Unlicensed export does not even show its native save dialog', await app.evaluate(() => globalThis.__fullQa.saveDialogs === 0));
  const claims = { product_id: 'eveing-clarune', license_id: 'TEST-ONLY-FULL-INSTALLER', not_before: new Date(Date.now() - 60000).toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), sequence: 1, device_match_min: 2, device_component_hashes: device };
  const token = issue(claims);
  const activated = await page.evaluate((value) => window.clarune.activateLicense(value), token);
  check('Actual packaged client activates with an in-memory signed machine-bound license', activated.state === 'active');
  if (await page.locator('.license-dialog').count()) await page.locator('.license-dialog .dialog-close').click();
  const progress = [];
  await page.evaluate(() => { globalThis.__fullProgress = []; window.clarune.onEnhancementProgress((event) => globalThis.__fullProgress.push({ id: event.id, stage: event.stage, percent: event.percent })); });
  for (const model of ['realesrgan-x4plus', 'realesrgan-x4plus-anime', 'real-hat-x4']) {
    console.log(`START real packaged inference ${model}`);
    const capability = await page.evaluate((id) => window.clarune.getUpscaleStatus(id), model);
    check(`${model} verifies its real bundled runtime without status mocks`, capability.ok && capability.value.ready && capability.value.source === 'detected');
    const result = await page.evaluate(async ({ bytes, model }) => {
      const result = await window.clarune.enhanceImage({ id: `full-${model}`, bytes: new Uint8Array(bytes), upscale: { model, scale: 4, tileSize: 128 } });
      return result.ok ? { ok: true, value: { width: result.value.width, height: result.value.height, bytes: Array.from(result.value.bytes) } } : result;
    }, { bytes: fixtureBytes, model });
    if (!result.ok) throw new Error(`Actual packaged ${model} failed: ${result.error}`);
    check(`${model} actual inference returns 384x256`, result.ok && result.value.width === 384 && result.value.height === 256);
    const output = join(run, `${model}-4x.png`), bytes = Buffer.from(result.value.bytes);
    await writeFile(output, bytes);
    const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    check(`${model} complete returned PNG fully decodes at expected dimensions`, decoded.info.width === 384 && decoded.info.height === 256);
    const alpha = (x, y) => decoded.data[(y * decoded.info.width + x) * 4 + 3];
    check(`${model} transparent and opaque edges survive the packaged processing path`, alpha(0, 128) === 0 && alpha(350, 128) === 255);
    models.push({ model, width: decoded.info.width, height: decoded.info.height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (model === 'real-hat-x4') {
      const exportFile = join(run, 'licensed-save-realhat.png');
      await app.evaluate((_electron, file) => { globalThis.__fullQa.savePath = file; }, exportFile);
      const saved = await page.evaluate((bytes) => window.clarune.saveImage({ bytes: new Uint8Array(bytes), options: { format: 'png', quality: 100 } }, 'licensed-realhat'), result.value.bytes);
      check('Activated native save publishes the actual Real-HAT result', saved.ok);
      const savedDecode = await sharp(exportFile).raw().toBuffer({ resolveWithObject: true });
      check('Published result fully decodes without rerunning AI', savedDecode.info.width === 384 && savedDecode.info.height === 256);
    }
  }
  progress.push(...await page.evaluate(() => globalThis.__fullProgress));
  check('Real inference progress reaches the packaged renderer', progress.some((item) => item.stage === 'inference') && progress.some((item) => item.stage === 'finishing'));
  const processes = await app.evaluate(() => globalThis.__fullQa.processes);
  check('Every observed AI process uses only bundled runtime, worker and weights', processes.length >= 3 && processes.every((entry) => entry.bundled && entry.localWorker && entry.bundledModel));
  check('Actual AI worker environments restrict PATH to Windows System32', processes.every((entry) => entry.systemOnlyPath));
  check('Three explicit runs produced exactly three real inference workers', processes.filter((entry) => entry.inference).length === 3);
  check('Bundled Real-HAT uses bytecode-disabled Python', processes.filter((entry) => entry.command.toLowerCase() === 'python.exe').every((entry) => entry.pythonNoBytecode));
  report.processes = processes;
  await screenshot('packaged-activated.png');
  await closeApp();
  const encrypted = await readFile(join(profile, 'activation-state.bin'));
  check('Persisted activation is not plaintext machine code or activation token', encrypted.length > 0 && !encrypted.includes(Buffer.from(token)) && !encrypted.includes(Buffer.from(status.machineCode)));
  await launchApp();
  const restored = await page.evaluate(() => window.clarune.getLicenseStatus());
  check('Closing and relaunching the extracted app preserves active authorization', restored.state === 'active' && restored.licenseId === claims.license_id);
  check('Restart launches no inference automatically', (await app.evaluate(() => globalThis.__fullQa.processes)).every((entry) => !entry.inference));
  check('No renderer exceptions occurred', errors.length === 0);
  report.complete = true;
} catch (error) {
  report.complete = false; report.failure = sanitize(error?.message || error);
  await screenshot('failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await closeApp().catch((error) => { errors.push(sanitize(error?.message || error)); report.complete = false; process.exitCode = 1; });
  privateKey = null; publicKey = null;
  report.passed = checks.length;
  await writeFile(join(run, 'results.json'), sanitize(JSON.stringify(report, null, 2)));
  console.log(JSON.stringify({ complete: report.complete, passed: checks.length, models: models.length, run, installer: report.installer, failure: report.failure,
    note: 'Archive-extracted packaged application test only; Windows installer/uninstaller and VC redistributable were not executed.' }, null, 2));
}
