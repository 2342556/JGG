// Exercises the real RPC/WebSocket client and the indexer process wiring against a local fake Solana RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { openDb, q1 } from '../../apps/api/src/db.ts';
import { createRpc, subscribeLogs } from '../../packages/providers/src/solana/rpc.ts';
import { startIndexer } from '../../apps/workers/src/indexer.ts';
import * as P from '../../packages/providers/src/solana/pump.ts';
import { Curve, newKey, newSig } from '../helpers/pumpgen.ts';

/** Minimal RFC 6455 server: text frames only (enough for JSON-RPC subscriptions). */
function fakeRpcServer(opts: { onRpc?: (m: any) => any; http429First?: boolean } = {}) {
  const sockets = new Set<any>(); const received: any[] = []; let first429 = !!opts.http429First; let subs = 0;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (d: any) => { body += d; }); req.on('end', () => {
      if (first429) { first429 = false; res.writeHead(429); res.end(); return; }
      const m = JSON.parse(body); const out = opts.onRpc?.(m);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out?.error ? { jsonrpc: '2.0', id: m.id, error: out.error } : { jsonrpc: '2.0', id: m.id, result: out ?? null }));
    });
  });
  server.on('upgrade', (req: any, sock: any) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(sock); sock.on('close', () => sockets.delete(sock));
    sock.on('data', (buf: Buffer) => { // client frames are masked
      const len = buf[1] & 0x7f; let off = 2; let n = len;
      if (len === 126) { n = buf.readUInt16BE(2); off = 4; }
      const mask = buf.subarray(off, off + 4); const payload = Buffer.from(buf.subarray(off + 4, off + 4 + n)).map((b: number, i: number) => b ^ mask[i % 4]);
      if ((buf[0] & 0x0f) !== 1) return;
      const m = JSON.parse(Buffer.from(payload).toString()); received.push(m);
      if (m.method === 'logsSubscribe') { subs++; send(sock, { jsonrpc: '2.0', id: m.id, result: subs }); }
    });
  });
  const send = (sock: any, obj: unknown) => { const p = Buffer.from(JSON.stringify(obj)); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(p.length), 2); return b; })(); sock.write(Buffer.concat([h, p])); };
  return new Promise<{ http: string; ws: string; received: any[]; notify: (v: any, slot: number) => void; dropAll: () => void; close: () => Promise<void>; subs: () => number }>(r => server.listen(0, () => {
    const port = (server.address() as any).port;
    r({ http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, received, subs: () => subs,
      notify: (value, slot) => { for (const s of sockets) send(s, { jsonrpc: '2.0', method: 'logsNotification', params: { result: { context: { slot }, value }, subscription: subs } }); },
      dropAll: () => { for (const s of sockets) s.destroy(); },
      close: () => new Promise(res => { for (const s of sockets) s.destroy(); server.close(() => res()); }) });
  }));
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20); } }

test('HTTP RPC: standard JSON-RPC calls, 429 back-off + retry, RPC errors surfaced, timeouts', async () => {
  const srv = await fakeRpcServer({ http429First: true, onRpc: m => m.method === 'getSlot' ? 42 : m.method === 'boom' ? { error: { code: -32602, message: 'Invalid params' } } : null });
  try {
    const rpc = createRpc(srv.http, { maxRps: 50, timeoutMs: 1000 });
    assert.equal(await rpc.getSlot(), 42, 'retried after 429');
    await assert.rejects(rpc.call('boom', []), (e: any) => e.code === 'RPC_-32602');
  } finally { await srv.close(); }
  const slow = createServer(() => { /* never answers */ }); await new Promise<void>(r => slow.listen(0, () => r()));
  const rpc2 = createRpc(`http://127.0.0.1:${(slow.address() as any).port}`, { timeoutMs: 150 });
  await assert.rejects(rpc2.getSlot(), (e: any) => e.code === 'TIMEOUT'); slow.closeAllConnections?.(); slow.close();
});

test('WebSocket: logsSubscribe with mentions filter + confirmed commitment; notifications delivered; resubscribes after a drop', async () => {
  const srv = await fakeRpcServer(); const got: string[] = []; const states: string[] = [];
  const sub = subscribeLogs(srv.ws, P.PUMP_PROGRAM_ID, v => got.push(v.signature), { onState: s => states.push(s) });
  try {
    await until(() => srv.subs() === 1);
    const req = srv.received.find(m => m.method === 'logsSubscribe');
    assert.deepEqual(req.params, [{ mentions: [P.PUMP_PROGRAM_ID] }, { commitment: 'confirmed' }]);
    srv.notify({ signature: 'sigA', err: null, logs: [] }, 1); await until(() => got.length === 1);
    srv.dropAll(); await until(() => srv.subs() === 2, 5000); // reconnect + resubscribe
    srv.notify({ signature: 'sigB', err: null, logs: [] }, 2); await until(() => got.length === 2);
    assert.deepEqual(got, ['sigA', 'sigB']); assert.ok(states.includes('reconnecting'));
  } finally { sub.stop(); await srv.close(); }
});

test('indexer process wiring: WS events are ingested; emit_cpi-only txs are fetched via getTransaction; heartbeat + SOL/USD recorded', async () => {
  const c = new Curve(); const buyer = newKey();
  const trade = c.trade(buyer, true, 2_000_000_000n, Math.floor(Date.now() / 1000));
  // A second trade delivered only as an emit_cpi inner instruction (logs show the instruction but no Program data line).
  const c2 = new Curve(); c2.mint = c.mint; Object.assign(c2, { vs: c.vs, vt: c.vt, rs: c.rs, rt: c.rt });
  const cpiTrade = c2.trade(newKey(), true, 1_000_000_000n, Math.floor(Date.now() / 1000));
  const payloadB64 = cpiTrade.logs.find(l => l.startsWith('Program data: '))!.slice(14);
  const cpiData = P.b58encode(Buffer.concat([Buffer.from(P.EVENT_IX_TAG), Buffer.from(payloadB64, 'base64')]));
  const cpiSig = newSig();
  const srv = await fakeRpcServer({ onRpc: m => m.method === 'getTransaction' && m.params[0] === cpiSig
    ? { slot: 99, meta: { err: null, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, data: cpiData }] }] }, transaction: { message: { accountKeys: [newKey(), P.PUMP_PROGRAM_ID] } } }
    : null });
  const db = openDb(':memory:');
  const ix = startIndexer(db, { JGG_SOLANA_RPC_HTTP: srv.http, JGG_SOLANA_RPC_WS: srv.ws, JGG_SOL_USD_MANUAL: '150', JGG_RPC_MAX_RPS: '50' });
  try {
    await until(() => srv.subs() === 1);
    srv.notify({ signature: newSig(), err: null, logs: c.createLogs() }, 10);
    srv.notify({ signature: newSig(), err: null, logs: trade.logs }, 11);
    srv.notify({ signature: cpiSig, err: null, logs: [`Program ${P.PUMP_PROGRAM_ID} invoke [1]`, 'Program log: Instruction: Buy', `Program ${P.PUMP_PROGRAM_ID} success`] }, 12);
    await until(() => q1(db, `SELECT COUNT(*) n FROM live_trades`).n === 2, 4000);
    assert.equal(q1(db, `SELECT seen_from_creation s FROM live_tokens WHERE mint = ?`, c.mint).s, 1);
    assert.equal(ix.stats.txFetchQueued, 1);
    await until(() => !!q1(db, `SELECT 1 FROM worker_state WHERE key = 'indexer'`), 4000);
    assert.equal(JSON.parse(q1(db, `SELECT value FROM worker_state WHERE key = 'sol_usd'`).value).source, 'manual (JGG_SOL_USD_MANUAL)');
  } finally { ix.stop(); await srv.close(); }
});
