import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const project = resolve(import.meta.dirname, '..');
const require = createRequire(join(project, 'package.json'));
const sharp = require('sharp');
const stage = resolve(project, '../EVEINGClarune_ReleaseCandidate');
const ai = join(stage, 'resources/ai');
const review = resolve(project, '../EVEINGClarune_Release_Review/bundled-runtime');
await mkdir(review, { recursive: true });
const checks = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
async function run(file, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timeout = false;
    const timer = setTimeout(() => { timeout = true; child.kill(); }, 180_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); if (timeout || code !== 0) reject(Error(`Bundled worker failed: ${code}: ${stdout.slice(-2000)} ${stderr}`)); else resolveRun(stdout); });
  });
}
const manifest = JSON.parse(await readFile(join(ai, 'runtime-manifest.json'), 'utf8'));
check('Complete runtime manifest exists', manifest.files.length > 1000);
const pythonRoot = join(ai, 'realhat/python'), python = join(pythonRoot, 'python.exe');
const worker = join(stage, 'resources/realhat-worker.py');
const pth = await readFile(join(pythonRoot, 'python313._pth'), 'utf8');
check('Python search path has no ComfyUI or external drive path', pth.trim() === 'python313.zip\n.\nLib/site-packages\nimport site');
const architectures = (await readdir(join(pythonRoot, 'Lib/site-packages/spandrel/architectures'), { withFileTypes: true })).filter(item => item.isDirectory() && item.name !== '__pycache__').map(item => item.name);
check('Only HAT and its shared architecture helpers are bundled', architectures.sort().join(',') === 'HAT,__arch_helpers');
const importCheck = `import sys,json,pathlib,torch,spandrel,numpy,PIL\nroot=pathlib.Path(sys.executable).resolve().parent\nmodules=[torch,spandrel,numpy,PIL]\nprint(json.dumps({'local':all(pathlib.Path(m.__file__).resolve().is_relative_to(root) for m in modules),'cuda':torch.cuda.is_available()}))`;
const imports = JSON.parse((await run(python, ['-I', '-B', '-c', importCheck], review)).trim());
check('Core Python dependencies resolve only inside the private bundled runtime', imports.local);
check('Bundled CUDA is available on this machine', imports.cuda);
const probe = await run(python, ['-I', '-B', '-u', worker, '--probe'], review);
check('Bundled HAT-only worker passes real CUDA probe', probe.includes('"type": "ready"'));
const source = join(review, 'synthetic-source.png');
await sharp({ create: { width: 96, height: 64, channels: 4, background: { r: 38, g: 120, b: 220, alpha: .5 } } }).png().toFile(source);
const originalHash = hash(await readFile(source));
for (const model of ['realesrgan-x4plus', 'realesrgan-x4plus-anime']) {
  const target = join(review, `${model}.png`);
  await run(join(ai, 'ncnn/realesrgan-ncnn-vulkan.exe'), ['-i', source, '-o', target, '-m', 'models', '-n', model, '-s', '4', '-t', '128', '-j', '1:1:1', '-f', 'png'], join(ai, 'ncnn'));
  const meta = await sharp(target).metadata(); await sharp(target).raw().toBuffer();
  check(`${model} completes from bundled directory without debug DLL`, meta.width === 384 && meta.height === 256);
}
const hatTarget = join(review, 'realhat-synthetic.png');
await run(python, ['-I', '-B', '-u', worker, '--model', join(ai, 'realhat/models/Real_HAT_GAN_SRx4.pth'), '--input', source, '--output', hatTarget, '--tile', '128'], review);
const hatMeta = await sharp(hatTarget).metadata();
check('HAT-only runtime generates fully decoded RGBA output', hatMeta.width === 384 && hatMeta.height === 256 && hatMeta.hasAlpha && (await sharp(hatTarget).raw().toBuffer()).length > 0);
const fixture = process.env.CLARUNE_REALHAT_FIXTURE;
if (fixture) {
  const before = hash(await readFile(fixture));
  const baseline = JSON.parse(await readFile(resolve(project, '../RealHAT_Face_Comparison/realhat.json'), 'utf8'));
  check('Baseline uses matching HAT weight and inference settings', baseline.tile === 256 && baseline.tilePad === 32 && baseline.parameterKey === 'params_ema' && baseline.weightSHA256 === hash(await readFile(join(ai, 'realhat/models/Real_HAT_GAN_SRx4.pth'))));
  const target = join(review, 'poster-bundled-realhat.png');
  await run(python, ['-I', '-B', '-u', worker, '--model', join(ai, 'realhat/models/Real_HAT_GAN_SRx4.pth'), '--input', fixture, '--output', target, '--tile', String(baseline.tile)], review);
  const previous = resolve(project, '../RealHAT_Face_Comparison/realhat4x.png');
  const [a,b] = await Promise.all([sharp(target).removeAlpha().raw().toBuffer(), sharp(previous).removeAlpha().raw().toBuffer()]);
  check('Bundled HAT-only poster is pixel-identical to approved full-environment sample', a.equals(b));
  check('User original remains byte-identical', hash(await readFile(fixture)) === before);
}
check('Synthetic input remains unchanged', originalHash === hash(await readFile(source)));
await writeFile(join(review, 'results.json'), JSON.stringify({ date: new Date().toISOString(), checks, isolatedEnvironment: true, stage }, null, 2));
console.log(JSON.stringify({ passed: checks.length, review }));
