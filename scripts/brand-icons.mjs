// Regenerates favicon.svg and all PWA / home-screen icons from apps/web/src/brand.ts (the owner's JGG mark).
// Usage: node scripts/brand-icons.mjs   (needs `sharp`; falls back to the global install in this build env)
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { iconSvg } from '../apps/web/src/brand.ts';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'); const pub = join(root, 'apps/web/public');
const require = createRequire(import.meta.url);
let sharp; for (const p of ['sharp', '/home/claude/.npm-global/lib/node_modules/sharp']) { try { sharp = require(p); break; } catch { /* next */ } }
if (!sharp) { console.error('sharp not found: npm install sharp'); process.exit(1); }
const rounded = iconSvg({ scale: 0.76, rx: 22 });     // browser tab / in-app
const square = iconSvg({ scale: 0.72, rx: 0 });       // iOS applies its own mask; Android "any"
const maskable = iconSvg({ scale: 0.58, rx: 0 });     // Android adaptive: mark stays inside the 80% safe zone
writeFileSync(join(pub, 'favicon.svg'), rounded);
const png = (svg, size, file) => sharp(Buffer.from(svg), { density: 1200 }).resize(size, size).png().toFile(join(pub, file));
await Promise.all([png(square, 192, 'icon-192.png'), png(square, 512, 'icon-512.png'), png(square, 180, 'apple-touch-icon.png'), png(maskable, 512, 'icon-maskable-512.png')]);
console.log('brand icons written: favicon.svg, icon-192.png, icon-512.png, apple-touch-icon.png, icon-maskable-512.png');
