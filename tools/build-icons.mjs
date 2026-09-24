import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// Rebuild from the vector sources with any installed sharp package:
// NODE_PATH=<directory containing sharp> node tools/build-icons.mjs
// Or set CLARUNE_SHARP_MODULE to the absolute sharp package directory.
const require = createRequire(import.meta.url);
const sharp = require(process.env.CLARUNE_SHARP_MODULE || "sharp");
const branding = join(dirname(fileURLToPath(import.meta.url)), "../resources/branding");
const selected = process.argv[2] || "a";
if (!/^[abcd]$/.test(selected)) throw new Error("Choose an icon variant: a, b, c or d.");
const variants = [
  ["a", "Interlace", "交叠光环 · 当前默认"],
  ["b", "Clarity", "聚焦透镜"],
  ["c", "Prism", "层叠棱镜"],
  ["d", "Aperture", "极简光圈"],
];
const sources = await Promise.all(variants.map(async ([key]) => readFile(join(branding, `clarune-${key}.svg`))));
await Promise.all(sources.map((source, index) => sharp(source, { density: 288 }).resize(512, 512).png().toFile(join(branding, `clarune-${variants[index][0]}.png`))));
const source = sources[variants.findIndex(([key]) => key === selected)];
await sharp(source, { density: 288 }).resize(256, 256).png().toFile(join(branding, "clarune.png"));

// ICO directory + PNG-encoded entries; Windows Vista and newer support PNG ICOs.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(size => sharp(source, { density: 288 }).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  header.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], entry);
  header.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});
await writeFile(join(branding, "clarune.ico"), Buffer.concat([header, ...images]));

const cards = sources.map((svg, index) => {
  const [key, label, description] = variants[index];
  const x = 56 + index * 336;
  const embedded = `data:image/svg+xml;base64,${svg.toString("base64")}`;
  return `<g transform="translate(${x} 148)">
    <rect width="320" height="410" rx="35" fill="#FFF" fill-opacity=".52" stroke="#FFF" stroke-opacity=".94"/>
    <rect x="1" y="1" width="318" height="408" rx="34" fill="none" stroke="#BECDED" stroke-opacity=".28"/>
    <image href="${embedded}" x="72" y="51" width="176" height="176"/>
    <text x="160" y="278" text-anchor="middle" font-size="25" font-weight="650" fill="#22324F">${key.toUpperCase()} · ${label}</text>
    <text x="160" y="313" text-anchor="middle" font-size="17" fill="#63718E">${description}</text>
    <image href="${embedded}" x="103" y="349" width="24" height="24"/>
    <image href="${embedded}" x="146" y="345" width="32" height="32"/>
    <image href="${embedded}" x="196" y="337" width="48" height="48"/>
  </g>`;
}).join("");
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="624" viewBox="0 0 1440 624">
  <defs><linearGradient id="page" x2="1" y2="1"><stop stop-color="#E3E8FD"/><stop offset=".5" stop-color="#F4F7FD"/><stop offset="1" stop-color="#DAF4F4"/></linearGradient></defs>
  <rect width="1440" height="624" fill="url(#page)"/>
  <g font-family="Segoe UI, Microsoft YaHei, sans-serif">
    <text x="60" y="69" font-size="30" font-weight="650" fill="#253452">EVEING Clarune</text>
    <text x="60" y="105" font-size="18" fill="#63718E">原创图标方案 · 界面 / 任务栏 / 安装图标统一</text>
    <text x="1375" y="72" text-anchor="end" font-size="13" letter-spacing="2" fill="#7A8AA9">ICON STUDY 01</text>
    ${cards}
    <text x="60" y="593" font-size="13" fill="#75829B">A 保留你喜欢的交叠图形。四款均提供独立可编辑 SVG，原生图标由同一矢量源导出。</text>
  </g>
</svg>`;
await writeFile(join(branding, "icon-options.svg"), sheet);
await sharp(Buffer.from(sheet)).png().toFile(join(branding, "icon-options.png"));
console.log(`Built variant ${selected.toUpperCase()}: clarune.ico (${sizes.join(", ")} px), clarune.png, four SVG/PNG options and contact sheet.`);
