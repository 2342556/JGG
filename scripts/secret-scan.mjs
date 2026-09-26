// T42: scan tracked sources and the web bundle for credential-like material. Exit 1 on findings.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['JGG API key', /\bjgg_[A-Za-z0-9_-]{30,}\b/], ['Supabase/JWT', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/], ['OpenAI key', /\bsk-[A-Za-z0-9]{32,}/], ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/], ['64-byte Solana secret (base58, 87-88 chars)', /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/],
  ['hex private key assignment', /(private|secret)[_-]?key\s*[:=]\s*['"]?(0x)?[0-9a-fA-F]{64}/i], ['BIP39-like seed assignment', /(mnemonic|seed)\s*[:=]\s*['"](\w+\s){11,23}\w+['"]/i],
];
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(f => f && !/\.(png|jpg|ico|db)$/.test(f));
const dist = 'apps/web/dist/assets'; if (existsSync(dist)) for (const f of readdirSync(dist)) if (f.endsWith('.js')) files.push(join(dist, f));
const hits = [];
for (const f of files) { let t; try { t = readFileSync(f, 'utf8'); } catch { continue; } for (const [name, re] of PATTERNS) if (re.test(t)) hits.push(`${f}: ${name}`); }
if (existsSync('.env')) hits.push('.env present in working tree (must never be committed)');
console.log(hits.length ? `SECRET SCAN FAILED:\n${hits.join('\n')}` : `secret scan: ${files.length} files clean`);
process.exit(hits.length ? 1 : 0);
