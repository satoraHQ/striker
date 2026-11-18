import { useMemo, useState } from 'react';
import type { InfoResponse, SwapView } from '@striker/core';
import { isTerminal, OfflineError } from '../api';
import { useNow, useSwap } from '../hooks';
import { loadRefundKey, type SwapRecord } from '../storage';
import { fmtBtc, fmtCountdown, fmtPrice, fmtSats, fmtUsd, toMs } from '../units';
import { covenantPrice, verifySwap } from '../verify';
import { Card, CopyButton, Qr, Row, short, StatusBadge } from './ui';

export function SwapPanel({ record, info, onClose }: { record: SwapRecord; info: InfoResponse | undefined; onClose: () => void }) {
  const q = useSwap(record.id);
  const view = q.data;
  const decimals = info?.asset.decimals ?? 8;
  const ticker = info?.asset.ticker ?? 'USD';

  const amountBase = useMemo(() => BigInt(record.request.amount), [record.request.amount]);
  // Re-run whenever the server's terms or address could differ (they never should).
  const errors = useMemo(
    () => (view && info ? verifySwap(view, info, record.request, amountBase) : null),
    [view?.address, JSON.stringify(view?.terms), info, record.request, amountBase],
  );

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {record.request.sell === 'BTC' ? `Sell BTC → ${ticker}` : `Sell ${ticker} → BTC`}
        </h2>
        <button type="button" onClick={onClose} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-white/5">New swap</button>
      </div>

      {!view && (q.error ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {q.error instanceof OfflineError ? 'Striker offline — retrying…' : q.error.message}
        </p>
      ) : <p className="text-sm text-slate-400">Loading swap…</p>)}

      {view && !info && <p className="text-sm text-slate-400">Waiting for Striker info to verify this address…</p>}

      {view && errors && errors.length > 0 && (
        <div className="rounded-xl border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-200">
          <p className="font-semibold text-red-300">Do not pay this swap. The address failed local verification:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      {view && errors && errors.length === 0 && info && <Verified view={view} info={info} decimals={decimals} ticker={ticker} stale={!!q.error} />}

      <RefundKey record={record} view={view} />
    </Card>
  );
}

function Verified({ view, info, decimals, ticker, stale }: { view: SwapView; info: InfoResponse; decimals: number; ticker: string; stale: boolean }) {
  const now = useNow();
  const left = toMs(view.deadline) - now;
  const sellBtc = view.terms.sell === 'BTC';
  const usd = (v: string) => `$${fmtUsd(v, decimals)}`;
  const sats = (v: string) => `${fmtSats(v)} sats`;
  const recv = (r: { sats: string; asset: string }) =>
    sellBtc ? usd(r.asset) + (BigInt(r.sats) > 0n ? ` + ${sats(r.sats)} back` : '')
      : sats(r.sats) + (BigInt(r.asset) > 0n ? ` + ${usd(r.asset)} back` : '');
  const awaiting = view.status === 'awaiting_deposit';

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={view.status} />
        {!isTerminal(view.status) && <span className="tabular-nums text-slate-400">{left > 0 ? `${fmtCountdown(left)} left` : 'deadline passed'}</span>}
        {stale && <span className="text-xs text-amber-400">connection lost, retrying</span>}
        <span className="ml-auto text-xs text-emerald-400" title="Rebuilt from the covenant terms in your browser">✓ address verified locally</span>
      </div>

      {awaiting && left > 0 && (
        <div className="space-y-3">
          <div className="rounded-xl bg-black/30 p-3 text-center">
            <div className="text-xs uppercase tracking-wide text-slate-400">Send exactly</div>
            {view.deposit.asset ? (
              <>
                <div className="text-2xl font-semibold tabular-nums">{usd(view.deposit.asset.amount)} {ticker}</div>
                <div className="text-sm tabular-nums text-slate-300">+ {sats(view.deposit.sats)}</div>
                <div className="mt-1 break-all font-mono text-[11px] text-slate-500">asset {view.deposit.asset.id}</div>
              </>
            ) : (
              <>
                <div className="text-2xl font-semibold tabular-nums">{sats(view.deposit.sats)}</div>
                <div className="text-sm tabular-nums text-slate-400">{fmtBtc(view.deposit.sats)} BTC</div>
              </>
            )}
            <div className="mt-1 text-xs text-slate-500">in one payment, from any Ark wallet (e.g. arkade.money)</div>
          </div>
          <Qr text={view.address} />
          <div className="flex items-center gap-2 rounded-xl border border-line bg-black/30 p-2">
            <code className="min-w-0 flex-1 break-all text-xs">{view.address}</code>
            <CopyButton text={view.address} />
          </div>
        </div>
      )}

      <div className="rounded-xl bg-black/20 px-3 py-2">
        <Row label="Expected">{recv(view.expected)}</Row>
        <Row label="Guaranteed minimum">{recv(view.minimum)}</Row>
        <Row label={sellBtc ? 'Covenant floor price' : 'Covenant max price'}>${fmtPrice(covenantPrice(view, decimals))}</Row>
        <Row label="Maker price">${fmtPrice(view.makerPrice)}</Row>
        <Row label="Fee">{Number(view.feeBps) / 100}%</Row>
        {view.depositOutpoint && <Row label="Deposit"><code className="text-xs">{short(view.depositOutpoint, 10)}</code></Row>}
        {view.received && <Row label="Received" strong>{recv(view.received)}</Row>}
        {view.fillTxid && <Row label="Fill tx"><TxId id={view.fillTxid} /></Row>}
        {view.refundTxid && <Row label="Refund tx"><TxId id={view.refundTxid} /></Row>}
      </div>

      {view.status === 'deposited' && <p className="text-sm text-amber-300">Deposit seen — filling against maker offers…</p>}
      {view.status === 'filled' && <p className="text-sm text-emerald-300">Swap filled. Funds are at your receive address.</p>}
      {view.status === 'refunding' && <p className="text-sm text-orange-300">Not filled before the deadline — refunding.</p>}
      {view.status === 'refunded' && <p className="text-sm text-slate-300">Refunded to your refund address.</p>}
      {view.status === 'expired' && <p className="text-sm text-slate-400">Expired without a deposit. Don't pay this address.</p>}
      {awaiting && left <= 0 && <p className="text-sm text-slate-400">Deadline passed. Don't pay this address; a late deposit refunds.</p>}
      {view.status === 'failed' && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">Failed: {view.error ?? 'unknown error'}</p>}
      {view.error && view.status !== 'failed' && <p className="text-xs text-red-300">{view.error}</p>}
    </>
  );
}

function TxId({ id }: { id: string }) {
  return <span className="inline-flex items-center gap-2"><code className="text-xs">{short(id, 8)}</code><CopyButton text={id} /></span>;
}

function RefundKey({ record, view }: { record: SwapRecord; view: SwapView | undefined }) {
  const secret = useMemo(() => loadRefundKey(record.id), [record.id]);
  const [show, setShow] = useState(false);
  if (!secret) return (
    <p className="text-xs text-slate-500">No refund key stored in this browser for this swap.</p>
  );
  const backup = JSON.stringify({
    swapId: record.id, address: view?.address, refundPubkey: record.request.refundPubkey, refundSecretKey: secret,
    terms: view?.terms, note: 'Striker refund key: only needed for an L1 exit if Arkade disappears before the swap settles.',
  }, null, 2);
  const download = () => {
    const url = URL.createObjectURL(new Blob([backup], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `striker-refund-${record.id}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <details className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm" open={view?.status === 'awaiting_deposit'}>
      <summary className="cursor-pointer font-medium text-amber-300">Save this refund key</summary>
      <p className="mt-2 text-slate-300">
        It's stored in this browser only. You don't need it while Arkade is up — refunds happen automatically.
        It matters only for an on-chain exit if Arkade disappears before the swap settles.
      </p>
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-black/30 p-2">
        <code className="min-w-0 flex-1 break-all text-xs">{show ? secret : '•'.repeat(32)}</code>
        <button type="button" className="shrink-0 text-xs text-slate-400 underline" onClick={() => setShow(!show)}>{show ? 'hide' : 'show'}</button>
      </div>
      <div className="mt-2 flex gap-2">
        <CopyButton text={secret} label="Copy key" />
        <button type="button" onClick={download} className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:bg-white/5">Download backup</button>
      </div>
    </details>
  );
}

