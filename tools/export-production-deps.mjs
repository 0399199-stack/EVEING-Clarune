import { cp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] ?? "");
const previewName = process.argv[3] ?? "EVEINGClarune_Preview";
if (!/^EVEINGClarune_Preview(?:_[A-Za-z0-9-]+)?$/.test(previewName) && previewName !== "EVEINGClarune_ReleaseCandidate") throw new Error("Invalid package directory name");
const expected = resolve(project, "..", previewName, "resources", "app", "node_modules");
if (destination.toLowerCase() !== expected.toLowerCase()) throw new Error("Unexpected production dependency destination");
const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const copied = [];
const notices = new Map();

async function findPackage(name, parentManifest) {
  const require = createRequire(parentManifest);
  for (const root of require.resolve.paths(name) ?? []) {
    const candidate = join(root, name);
    try { if ((await stat(join(candidate, "package.json"))).isFile()) return await realpath(candidate); } catch {}
  }
  return null;
}

async function copyPackage(name, parentManifest, targetModules, ancestors, optional = false) {
  const source = await findPackage(name, parentManifest);
  if (!source) { if (optional) return; throw new Error(`Missing runtime dependency: ${name}`); }
  if (ancestors.get(name) === source) return;
  const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const target = join(targetModules, name);
  await mkdir(dirname(target), { recursive: true });
  // Follow pnpm package roots, not its store or development dependency tree.
  await cp(source, target, { recursive: true, dereference: true, filter: (path) => path === source || !path.slice(source.length + 1).split(/[\\/]/).includes("node_modules") });
  copied.push(`${name}@${packageJson.version}`);
  notices.set(`${name}@${packageJson.version}`, `${packageJson.license ?? "See package notices"} — node_modules/${target.slice(destination.length + 1).replaceAll("\\", "/")}`);
  const next = new Map(ancestors); next.set(name, source);
  const optionalDependencies = packageJson.optionalDependencies ?? {};
  for (const dependency of Object.keys({ ...packageJson.dependencies, ...optionalDependencies })) {
    await copyPackage(dependency, join(source, "package.json"), join(target, "node_modules"), next, dependency in optionalDependencies);
  }
}

await mkdir(destination, { recursive: true });
for (const name of Object.keys(manifest.dependencies ?? {})) await copyPackage(name, join(project, "package.json"), destination, new Map());
const requiredNotices = ["sharp/LICENSE", "sharp/node_modules/@img/sharp-win32-x64/LICENSE", "sharp/node_modules/@img/sharp-win32-x64/README.md", "sharp/node_modules/@img/sharp-win32-x64/versions.json", "pdf-lib/LICENSE.md"];
for (const path of requiredNotices) if (!(await stat(join(destination, path))).isFile()) throw new Error(`Missing packaged notice: ${path}`);
await writeFile(join(dirname(destination), "THIRD_PARTY_NOTICES.md"), `# EVEING Clarune runtime dependencies\n\nThe original package LICENSE, COPYING, NOTICE and README files are preserved in the locations below.\nThe Sharp Windows package README includes the licenses of libvips and the bundled native libraries; versions.json records their versions.\n\n${[...notices.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `- ${name}: ${value}`).join("\n")}\n`, "utf8");
console.log(JSON.stringify({ productionPackages: [...new Set(copied)].sort(), verifiedNotices: requiredNotices }, null, 2));
