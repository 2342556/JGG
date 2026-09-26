// Offline web build with esbuild (npm registry unavailable in the build environment; see docs/DECISIONS.md ADR-001).
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps/web'); const out = join(web, 'dist');
const globalMods = process.env.JGG_NODE_PATH ?? '/home/claude/.npm-global/lib/node_modules';
const require = createRequire(import.meta.url);
let esbuild; // prefer a project-local install; fall back to the offline copy bundled with the global tsx
for (const p of ['esbuild', join(globalMods, 'tsx/node_modules/esbuild')]) { try { esbuild = require(p); break; } catch { /* next */ } }
if (!esbuild) { console.error('esbuild not found: npm install esbuild (see README)'); process.exit(1); }
const { build } = esbuild;
rmSync(out, { recursive: true, force: true }); mkdirSync(join(out, 'assets'), { recursive: true });
const t = Date.now();
const r = await build({
  entryPoints: { app: join(web, 'src/main.tsx') }, bundle: true, format: 'esm', target: 'es2022', jsx: 'automatic',
  outdir: join(out, 'assets'), minify: process.env.NODE_ENV !== 'development', sourcemap: true, metafile: true,
  nodePaths: [join(root, 'node_modules'), globalMods].filter(existsSync), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
});
cpSync(join(web, 'src/styles.css'), join(out, 'assets/app.css'));
cpSync(join(web, 'public'), out, { recursive: true });
// Netlify: proxy the API to the backend origin (build-time env JGG_API_ORIGIN) and serve the SPA for deep links.
import('node:fs').then(({ writeFileSync }) => {
  const origin = (process.env.JGG_API_ORIGIN ?? '').replace(/\/$/, '');
  if (origin && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) { console.error('JGG_API_ORIGIN must be an https origin, e.g. https://api.example.com'); process.exit(1); }
  const lines = [...(origin ? [`/api/*  ${origin}/api/:splat  200`] : ['# JGG_API_ORIGIN not set: /api is not proxied (the PWA will show "cannot reach server")']), '/*  /index.html  200'];
  writeFileSync(join(out, '_redirects'), lines.join('\n') + '\n');
});
const bytes = Object.values(r.metafile.outputs).filter((o, i) => Object.keys(r.metafile.outputs)[i].endsWith('.js')).reduce((a, o) => a + o.bytes, 0);
console.log(`web built in ${Date.now() - t}ms → ${out} (js ${(bytes / 1024).toFixed(0)} KiB)`);
