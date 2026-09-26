import { useEffect, useState, Fragment } from 'react';
const FEE_LABEL: Record<string, string> = { dex: 'Pool fee', jgg: 'JGG fee', token_tax: 'Token tax', network: 'Network fee', priority: 'Priority fee', provider: 'Provider fee' };
import { api, newKey } from '../api.ts';
import { useApp, useApi, toast, errMsg, errCode, NATIVE, short, cls, Seg, Drawer, ModeBadge, I, price } from '../lib.tsx';

type Quote = any;
/** Full manual trade: quote preview → intent (reserves funds) → approval dialog → execute. No step is skipped. */
export function TradeTicket({ chain, address, symbol, compact }: { chain: string; address: string; symbol: string; compact?: boolean }) {
  const { me, openAuth, dataSource } = useApp();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.1'); const [slip, setSlip] = useState(300); const [walletId, setWalletId] = useState('');
  const [preset, setPreset] = useState('P1');
  const wallets = useApi<any[]>(me ? '/wallets' : null, [me?.user.id]);
  const presets = useApi<any[]>(me ? '/presets' : null, [me?.user.id]);
  const pos = useApi<any>(me ? `/portfolio?chain=${chain}` : null, [me?.user.id, chain]);
  const [review, setReview] = useState<{ quote: Quote; intent: any } | null>(null); const [busy, setBusy] = useState(false);
  const mode0 = me?.settings.mode ?? 'demo';
  const paper = (wallets.data ?? []).filter(w => w.chain === chain && w.custody === (mode0 === 'live' ? 'hosted' : 'paper'));
  useEffect(() => { if (paper.length && !paper.find(w => w.id === walletId)) setWalletId(paper[0].id); }, [paper.length, chain]);
  const p = presets.data?.find(x => x.chain === chain && x.slot === preset)?.config;
  useEffect(() => { if (p) setSlip(p.slippageBps); }, [preset, p?.slippageBps]);
  const held = pos.data?.balances?.find((b: any) => b.wallet_id === walletId && b.asset === address);
  const nativeBal = pos.data?.balances?.find((b: any) => b.wallet_id === walletId && b.asset === NATIVE[chain]);
  const mode = me?.settings.mode ?? 'demo';
  const tradable = mode === 'demo' || mode === 'paper' || mode === 'live';

  async function preview() {
    if (!me) return openAuth();
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) return toast('Enter a positive amount', 'warn');
    setBusy(true);
    try {
      const quote = await api('/quotes', { method: 'POST', body: { chain, tokenAddress: address, side, amount, slippageBps: slip, walletId, explicitHighSlippage: slip > 1500 } });
      const intent = await api('/trade-intents', { method: 'POST', body: { quoteId: quote.id, source: 'manual' }, idem: newKey() });
      setReview({ quote, intent });
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  return <div className={cls('ticket', compact && 'compact')} aria-label="Trade ticket">
    <div className="ticket-head"><Seg label="Side" items={[{ id: 'buy', label: 'Buy' }, { id: 'sell', label: 'Sell' }]} value={side} onChange={v => { setSide(v as any); setAmount(v === 'buy' ? (p?.buyAmounts?.[0] ?? '0.1') : ''); }} /><ModeBadge mode={mode} /></div>
    {!tradable && <p className="note warn">Live read-only: trading is disconnected. Switch to Paper in Settings to practice.</p>}{mode === 'live' && <p className="note err"><strong>LIVE — real SOL</strong> from your JGG trading wallet.</p>}
    <label className="field"><span>Wallet</span><select value={walletId} onChange={e => setWalletId(e.target.value)} disabled={!me}>{paper.map(w => <option key={w.id} value={w.id}>{w.label} · {short(w.address, 5)}</option>)}{!me && <option>Sign in for a virtual wallet</option>}</select></label>
    <div className="bal muted">Available: {side === 'buy' ? `${nativeBal ? Number(nativeBal.qty) - Number(nativeBal.reserved) : '—'} ${NATIVE[chain]}` : `${held ? Number(held.qty) - Number(held.reserved) : 0} ${symbol}`}</div>
    <label className="field"><span>Amount ({side === 'buy' ? NATIVE[chain] : symbol})</span><input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Amount" /></label>
    <div className="chips">{side === 'buy' ? (p?.buyAmounts ?? ['0.1', '0.5', '1']).map((a: string) => <button key={a} className={cls('chip', amount === a && 'on')} onClick={() => setAmount(a)}>{a}</button>)
      : [2500, 5000, 10000].map(b => <button key={b} className="chip" disabled={!held} onClick={() => held && setAmount(String((Number(held.qty) - Number(held.reserved)) * b / 10000))}>{b / 100}%</button>)}</div>
    <div className="row gap"><Seg label="Preset" items={['P1', 'P2', 'P3']} value={preset} onChange={setPreset} /><label className="field inline"><span>Slippage %</span><input value={slip / 100} onChange={e => setSlip(Math.round(Number(e.target.value || 0) * 100))} aria-label="Slippage percent" /></label></div>
    {slip > 1500 && <p className="note warn">High slippage ({slip / 100}%): you may receive far less. You will confirm this explicitly.</p>}
    <button className={cls('btn big', side === 'buy' ? 'buy' : 'sell')} disabled={busy || !tradable || (me ? !walletId : false)} onClick={preview}>{busy ? 'Quoting…' : !me ? 'Log in to trade' : `Review ${side}`}</button>
    <p className="fine muted">Quotes expire in 15 s. Nothing is sent until you approve. {dataSource === 'solana_live' ? 'Paper fills are priced on live pump.fun curve reserves — no real transaction.' : 'Demo/Paper executions are simulated with the disclosed CPMM model.'}</p>
    {review && <ApproveDialog chain={chain} symbol={symbol} review={review} onClose={() => setReview(null)} onDone={() => { pos.reload(true); setReview(null); }} />}
  </div>;
}

export function ApproveDialog({ chain, symbol, review, onClose, onDone }: { chain: string; symbol: string; review: { quote: any; intent: any }; onClose: () => void; onDone: () => void }) {
  const { quote: q, intent } = review; const [deadline] = useState(() => Date.now() + (q.ttlMs ?? 15_000)); const [left, setLeft] = useState(() => Math.max(0, Math.round((deadline - Date.now()) / 1000)));
  const [busy, setBusy] = useState(false); const [ack, setAck] = useState(q.slippageBps <= 1500); const [result, setResult] = useState<any>(null);
  useEffect(() => { const iv = setInterval(() => setLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000))), 500); return () => clearInterval(iv); }, [deadline]);
  const unit = q.side === 'buy' ? NATIVE[chain] : symbol; const outUnit = q.side === 'buy' ? symbol : NATIVE[chain];
  async function approveAndSend() {
    setBusy(true);
    try {
      await api(`/trade-intents/${intent.id}/approve`, { method: 'POST', body: { maxSlippageBps: q.slippageBps } });
      const o = await api(`/trade-intents/${intent.id}/execute`, { method: 'POST', body: {}, idem: `exec-${intent.id}` });
      setResult(o);
      toast(o.state === 'finalized' ? `Filled: ${Number(o.filledOut).toLocaleString()} ${outUnit} (simulated)` : o.state === 'reconciliation_required' ? 'Outcome uncertain — JGG will reconcile before any retry.' : `Order ${o.state}${o.error ? ': ' + o.error : ''}`, o.state === 'finalized' ? 'ok' : 'warn');
    } catch (e) { toast(errCode(e) === 'QUOTE_EXPIRED' ? 'Quote expired — nothing was sent. Request a new quote.' : errMsg(e), 'err'); } finally { setBusy(false); }
  }
  async function reject() { try { await api(`/trade-intents/${intent.id}/reject`, { method: 'POST', body: {} }); } catch { /* already terminal */ } onClose(); }
  return <Drawer open onClose={result ? onDone : reject} title={result ? 'Order result' : `Approve ${q.side}`}>
    {!result ? <>
      <dl className="kv">
        <dt>Chain</dt><dd>{chain}</dd><dt>Token</dt><dd className="mono">{symbol} · {short(q.token ?? intent.token, 6)}</dd>
        <dt>You pay</dt><dd>{q.amountIn} {unit}</dd><dt>Expected</dt><dd>{Number(q.expectedOut).toLocaleString()} {outUnit}</dd>
        <dt>Minimum received</dt><dd className="strong">{Number(q.minOut).toLocaleString()} {outUnit}</dd><dt>Slippage</dt><dd>{q.slippageBps / 100}%</dd>
        <dt>Price impact</dt><dd>{q.priceImpactBps !== undefined ? `${(q.priceImpactBps / 100).toFixed(2)}%` : '—'}</dd><dt>Exec price</dt><dd>{price(q.executionPriceUsd ?? null)}</dd>
        {(q.fees ?? []).map((f: any) => <Fragment key={f.kind}><dt title={f.note}>{FEE_LABEL[f.kind] ?? f.kind}</dt><dd>{f.amount} {f.kind === 'token_tax' ? '' : f.asset}{f.includedInQuotedOutput ? ' (in quote)' : ' (extra)'}</dd></Fragment>)}
        <dt>Route</dt><dd>{q.route ?? 'JGG paper simulator'}</dd><dt>Expires</dt><dd className={cls(left < 5 && 'neg')}>{left}s</dd>
      </dl>
      {q.slippageBps > 1500 && <label className="check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> I accept {q.slippageBps / 100}% slippage and may receive much less.</label>}
      <p className="note">Paper execution — no blockchain transaction, no real funds.</p>
      <div className="row gap end"><button className="btn ghost" onClick={reject}>Cancel</button><button className={cls('btn', q.side === 'buy' ? 'buy' : 'sell')} disabled={busy || left === 0 || !ack} onClick={approveAndSend}>{left === 0 ? 'Quote expired' : busy ? 'Sending…' : `Approve & ${q.side}`}</button></div>
    </> : <>
      <p className={cls('big-state', result.state === 'finalized' ? 'pos' : 'neg')}>{result.state.replace(/_/g, ' ')}</p>
      <dl className="kv"><dt>Order</dt><dd className="mono">{result.id}</dd><dt>Filled</dt><dd>{result.filledOut ?? '—'} {outUnit}</dd><dt>Network fee</dt><dd>{result.feeNative ?? '—'} {NATIVE[chain]}</dd><dt>Tx ref</dt><dd className="mono">{short(result.txRef, 8)}</dd></dl>
      <details><summary>Lifecycle ({result.events.length} events)</summary><ol className="events">{result.events.map((e: any) => <li key={e.version}>{e.to_state}</li>)}</ol></details>
      <div className="row end"><button className="btn" onClick={onDone}>Done</button></div>
    </>}
  </Drawer>;
}

/** One-tap quick buy from lists: still creates a quote + intent and asks for approval in a dialog. */
export function QuickBuy({ chain, address, symbol, amount }: { chain: string; address: string; symbol: string; amount: string }) {
  const { me, openAuth } = useApp(); const [review, setReview] = useState<any>(null); const [busy, setBusy] = useState(false);
  const go = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation(); if (!me) return openAuth();
    setBusy(true);
    try {
      const ws = await api<any[]>('/wallets'); const w = ws.find(x => x.chain === chain && x.custody === (me.settings.mode === 'live' ? 'hosted' : 'paper')); if (!w) throw new Error(me.settings.mode === 'live' ? 'No trading wallet — create one in Settings' : 'No paper wallet on this chain');
      const pr = await api<any[]>('/presets'); const slip = pr.find(x => x.chain === chain && x.slot === 'P1')?.config.slippageBps ?? 300;
      const quote = await api('/quotes', { method: 'POST', body: { chain, tokenAddress: address, side: 'buy', amount, slippageBps: slip, walletId: w.id } });
      const intent = await api('/trade-intents', { method: 'POST', body: { quoteId: quote.id, source: 'quick_buy' }, idem: newKey() });
      setReview({ quote, intent });
    } catch (err) { toast(errMsg(err), 'err'); } finally { setBusy(false); }
  };
  return <>
    <button className="qbuy" onClick={go} disabled={busy} aria-label={`Quick buy ${amount} ${NATIVE[chain]} of ${symbol}`}><I.bolt />{busy ? '…' : amount}</button>
    {review && <ApproveDialog chain={chain} symbol={symbol} review={review} onClose={() => setReview(null)} onDone={() => setReview(null)} />}
  </>;
}
