#!/usr/bin/env node
// JGG CLI + MCP server (T50). Both call the public HTTP API with a scoped API key, so scopes, validation,
// budgets and revocation are identical to the UI. There is no alternate execution path.
//   JGG_API_KEY=jgg_... JGG_URL=http://localhost:8787 node apps/cli/jgg.mjs skills
//   node apps/cli/jgg.mjs run C05 chain=solana address=<mint>
//   node apps/cli/jgg.mjs mcp            # MCP server over stdio (JSON-RPC 2.0)
const BASE = (process.env.JGG_URL ?? 'http://localhost:8787').replace(/\/$/, '') + '/api/v1';
const KEY = process.env.JGG_API_KEY;
async function api(path, body) {
  if (!KEY) throw new Error('Set JGG_API_KEY (create one in Settings → API keys).');
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(`${j.error?.code ?? r.status}: ${j.error?.message ?? 'request failed'}`); e.details = j.error?.details; throw e; }
  return j;
}
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'mcp') mcp();
else main().catch(e => { console.error(e.message); if (e.details) console.error(JSON.stringify(e.details)); process.exit(1); });

async function main() {
  if (cmd === 'skills') { const { skills } = await api('/skills'); for (const s of skills) console.log(`${s.id}\t${s.title}\t${s.status.demo}/${s.status.live}`); return; }
  if (cmd === 'run') { const [id, ...kv] = rest; const inputs = Object.fromEntries(kv.map(x => { const i = x.indexOf('='); const v = x.slice(i + 1); return [x.slice(0, i), /^\d+$/.test(v) && !x.startsWith('address') ? Number(v) : v]; })); console.log(JSON.stringify(await api(`/skills/${id}/run`, { inputs }), null, 2)); return; }
  if (cmd === 'health') { console.log(JSON.stringify(await (await fetch(BASE + '/health')).json())); return; }
  console.log('usage: jgg.mjs skills | run <C##> key=value… | health | mcp');
}

// ---- Minimal MCP (Model Context Protocol) stdio server: tools = JGG skills ----
function mcp() {
  let buf = ''; let skills = null;
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const schema = (s) => ({ type: 'object', additionalProperties: false, required: s.inputs.filter(f => f.required).map(f => f.name),
    properties: Object.fromEntries(s.inputs.map(f => [f.name, { type: f.type === 'int' ? 'integer' : f.type === 'bool' ? 'boolean' : 'string', ...(f.options ? { enum: f.options } : {}), ...(f.help ? { description: f.help } : {}) }])) });
  async function handle(m) {
    try {
      if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jgg', version: '0.1.0' } } });
      if (m.method === 'notifications/initialized' || m.id === undefined) return;
      if (m.method === 'tools/list') { skills ??= (await api('/skills')).skills; return send({ jsonrpc: '2.0', id: m.id, result: { tools: skills.map(s => ({ name: s.id, title: s.title, description: `${s.summary} [${s.status.demo}; live: ${s.status.live}]`, inputSchema: schema(s) })) } }); }
      if (m.method === 'tools/call') {
        try { const r = await api(`/skills/${encodeURIComponent(m.params.name)}/run`, { inputs: m.params.arguments ?? {} });
          return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: r.status, data: r.data, error: r.error, meta: r.meta }) }], isError: r.status !== 'succeeded' } }); }
        catch (e) { return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: e.message }], isError: true } }); }
      }
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    } catch (e) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: e.message } }); }
  }
  process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { handle(JSON.parse(line)); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); } } } });
}
