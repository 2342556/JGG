import { createHash, createPublicKey, randomBytes, verify, timingSafeEqual } from 'node:crypto';
import { type DB, tx, q1, run } from './db.ts';
import { ApiError, newId } from './http.ts';
import { CHAINS, SOLANA_ADDR, type Chain } from '../../../packages/contracts/src/index.ts';
import { DENY_ALL_POLICY } from '../../../packages/domain/src/index.ts';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (n = 32) => randomBytes(n).toString('base64url');

const SESSION_TTL_MS = 7 * 86_400_000;
const CHALLENGE_TTL_MS = 5 * 60_000;

// ---------------- base58 (Solana public keys) ----------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s: string): Uint8Array {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
export function b58encode(b: Uint8Array): string {
  let n = 0n; for (const x of b) n = n * 256n + BigInt(x);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = '1' + s; else break; }
  return s;
}
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
export function verifyEd25519(address: string, message: string, signatureB64: string): boolean {
  try {
    const pub = b58decode(address); if (pub.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' });
    const sig = Buffer.from(signatureB64, 'base64'); if (sig.length !== 64) return false;
    return verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch { return false; }
}

// ---------------- users ----------------
function bootstrapUser(db: DB, userId: string, now: number) {
  run(db, `INSERT INTO settings (user_id, mode) VALUES (?, 'demo')`, userId);
  run(db, `INSERT INTO risk_policies (user_id, policy) VALUES (?, ?)`, userId, JSON.stringify(DENY_ALL_POLICY));
  const PAPER: Record<Chain, [string, string]> = { solana: ['SOL', '10'], bsc: ['BNB', '5'], base: ['ETH', '1'], ethereum: ['ETH', '1'] };
  for (const c of CHAINS) {
    for (let k = 1; k <= 3; k++) {
      const wid = newId('pw');
      run(db, `INSERT INTO wallets (id, user_id, chain, address, custody, label, verified_control, created_at) VALUES (?, ?, ?, ?, 'paper', ?, 1, ?)`, wid, userId, c, `paper-${c}-${k}-${userId.slice(-6)}`, `Paper ${k}`, now);
      run(db, `INSERT INTO paper_balances (user_id, wallet_id, asset, qty) VALUES (?, ?, ?, ?)`, userId, wid, PAPER[c][0], k === 1 ? PAPER[c][1] : '1');
    }
    for (const slot of ['P1', 'P2', 'P3']) run(db, `INSERT INTO presets (user_id, slot, chain, config) VALUES (?, ?, ?, ?)`, userId, slot, c,
      JSON.stringify({ buyAmounts: c === 'solana' ? ['0.1', '0.5', '1'] : ['0.01', '0.05', '0.1'], slippageBps: slot === 'P1' ? 300 : slot === 'P2' ? 1000 : 1500, maxFee: c === 'solana' ? '0.001' : '0.002', mevProtect: true, exitTemplate: 'none' }));
  }
  run(db, `INSERT INTO watchlists (id, user_id, name, created_at) VALUES (?, ?, 'Main', ?)`, newId('wl'), userId, now);
}

export function createUser(db: DB, kind: 'demo' | 'wallet', now: number, display: string | null, referredBy?: string): string {
  const id = newId('usr');
  run(db, `INSERT INTO users (id, created_at, kind, display, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?)`, id, now, kind, display, token(6).replace(/[-_]/g, 'x').toUpperCase(), referredBy ?? null);
  bootstrapUser(db, id, now);
  return id;
}

export function createSession(db: DB, userId: string, now: number) {
  const sid = token(32); const csrf = token(24);
  run(db, `INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, sha256(sid), userId, csrf, now, now + SESSION_TTL_MS);
  return { sid, csrf };
}
export function sessionCookies(sid: string, csrf: string, secure: boolean) {
  const s = secure ? '; Secure' : '';
  return [`jgg_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${s}`, `jgg_csrf=${csrf}; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${s}`];
}
export const clearCookies = () => ['jgg_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'jgg_csrf=; SameSite=Strict; Path=/; Max-Age=0'];

export function resolveSession(db: DB, sid: string | undefined, now: number): { userId: string; csrf: string } | null {
  if (!sid) return null;
  const s = q1(db, `SELECT user_id, csrf, expires_at, revoked_at FROM sessions WHERE id_hash = ?`, sha256(sid));
  if (!s || s.revoked_at || s.expires_at < now) return null;
  return { userId: s.user_id, csrf: s.csrf };
}
export const csrfMatches = (a: string | undefined, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const revokeSession = (db: DB, sid: string, now: number) => run(db, `UPDATE sessions SET revoked_at = ? WHERE id_hash = ?`, now, sha256(sid));

// ---------------- Solana wallet sign-in (SIWS-style, spec §16.1) ----------------
export function buildChallenge(domain: string, origin: string, address: string, nonce: string, issuedAt: number, expiresAt: number) {
  return `${domain} wants you to sign in with your Solana account:\n${address}\n\nSign in to JGG. This request will not trigger a blockchain transaction or cost any fees.\n\nURI: ${origin}\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce}\nIssued At: ${new Date(issuedAt).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`;
}
export function createChallenge(db: DB, chain: string, address: string, domain: string, origin: string, now: number) {
  if (chain !== 'solana') throw new ApiError('CHAIN_UNSUPPORTED', 'EVM SIWE sign-in requires an audited secp256k1/keccak implementation not available in this build (see docs/PROVIDERS.md).', 400);
  if (!SOLANA_ADDR.test(address)) throw new ApiError('VALIDATION_FAILED', 'Invalid Solana address', 400);
  const nonce = token(16); const exp = now + CHALLENGE_TTL_MS;
  const message = buildChallenge(domain, origin, address, nonce, now, exp);
  run(db, `INSERT INTO auth_challenges (nonce, chain, address, domain, message, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, nonce, chain, address, domain, message, now, exp);
  return { nonce, message, expiresAt: new Date(exp).toISOString() };
}
export function verifyChallenge(db: DB, input: { nonce: string; address: string; signature: string; domain: string }, now: number): string {
  // Step 1 (own tx): consume the challenge BEFORE checking the signature so a bad signature also burns it (single-use).
  const c = tx(db, () => {
    const c = q1(db, `SELECT * FROM auth_challenges WHERE nonce = ?`, input.nonce);
    if (!c) throw new ApiError('AUTH_REQUIRED', 'Unknown challenge', 401);
    if (c.used_at) throw new ApiError('AUTH_REQUIRED', 'Challenge already used (replay rejected)', 401);
    run(db, `UPDATE auth_challenges SET used_at = ? WHERE nonce = ?`, now, input.nonce);
    return c;
  });
  if (c.expires_at < now) throw new ApiError('AUTH_REQUIRED', 'Challenge expired', 401);
  if (c.domain !== input.domain) throw new ApiError('AUTH_REQUIRED', 'Wrong domain', 401);
  if (c.address !== input.address) throw new ApiError('AUTH_REQUIRED', 'Address mismatch', 401);
  if (typeof input.signature !== 'string' || !verifyEd25519(input.address, c.message, input.signature)) throw new ApiError('AUTH_REQUIRED', 'Invalid signature', 401);
  return tx(db, () => {
    const ident = q1(db, `SELECT user_id FROM identities WHERE chain = 'solana' AND address = ?`, input.address);
    if (ident) return ident.user_id as string;
    const uid = createUser(db, 'wallet', now, input.address.slice(0, 4) + '…' + input.address.slice(-4));
    run(db, `INSERT INTO identities (id, user_id, chain, address, verified_at) VALUES (?, ?, 'solana', ?, ?)`, newId('idn'), uid, input.address, now);
    return uid;
  });
}

// ---------------- JGG API keys (spec §15.4) ----------------
export const API_SCOPES = ['market:read', 'wallet:read', 'signals:read', 'watchlist:write', 'trade:propose', 'trade:execute', 'strategy:manage', 'launch:propose'] as const;
export function createApiKey(db: DB, userId: string, name: string, scopes: string[], ttlDays: number, now: number) {
  for (const s of scopes) if (!(API_SCOPES as readonly string[]).includes(s)) throw new ApiError('VALIDATION_FAILED', `Unknown scope ${s}`);
  const secret = `jgg_${token(30)}`; const id = newId('key');
  run(db, `INSERT INTO api_keys (id, user_id, name, prefix, secret_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, userId, name, secret.slice(0, 8), sha256(secret), JSON.stringify(scopes), now, now + ttlDays * 86_400_000);
  return { id, secret, prefix: secret.slice(0, 8), scopes }; // secret shown once
}
export function resolveApiKey(db: DB, bearer: string, now: number): { userId: string; scopes: Set<string> } | null {
  const k = q1(db, `SELECT * FROM api_keys WHERE secret_hash = ?`, sha256(bearer));
  if (!k || k.revoked_at || k.expires_at < now) return null;
  if (k.used >= k.request_budget) throw new ApiError('RATE_LIMITED', 'API key request budget exhausted', 429, true);
  run(db, `UPDATE api_keys SET used = used + 1, last_used_at = ? WHERE id = ?`, now, k.id);
  return { userId: k.user_id, scopes: new Set(JSON.parse(k.scopes)) };
}
