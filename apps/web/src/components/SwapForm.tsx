import { schnorr } from '@noble/curves/secp256k1.js';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { hex, type BookSnapshot, type CreateSwapRequest, type InfoResponse } from '@striker/core';
import { api, ApiError, OfflineError } from '../api';
import { usePreview } from '../hooks';
import { saveRefundKey, saveSwap } from '../storage';
import { fmtBtc, fmtPrice, fmtSats, fmtUsd, parseUnits } from '../units';
import { addressError, rateFloor } from '../verify';
import { Card, Row, Seg } from './ui';

type Sell = CreateSwapRequest['sell'];
type Mode = CreateSwapRequest['mode'];

// No 0%: the fee and the maker's payout round to whole units against the user, so a covenant with
// no slippage at all fills only when the fee happens to divide exactly.
const SLIPPAGE = [10, 50, 100] as const;

export function SwapForm({ info, book, onCreated }: { info: InfoResponse | undefined; book: BookSnapshot | undefined; onCreated: (id: string) => void }) {
  const [sell, setSell] = useState<Sell>('BTC');
  const [mode, setMode] = useState<Mode>('exactIn');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippage] = useState<number>(50);
  const [receive, setReceive] = useState('');
  const [refund, setRefund] = useState('');
  const [sameRefund, setSameRefund] = useState(true);

  const decimals = info?.asset.decimals ?? 8;
  const ticker = info?.asset.ticker ?? 'USD';
  // The amount is in the sell unit for exact-in and the buy unit for exact-out.
  const amountIsBtc = (mode === 'exactIn') === (sell === 'BTC');
  const amountBase = amount ? parseUnits(amount, amountIsBtc ? 0 : decimals) : null;
  const amountErr = amount && amountBase === null ? (amountIsBtc ? 'Whole sats only' : `At most ${decimals} decimals`) : null;

  const refundAddr = sameRefund ? receive : refund;
  const receiveErr = receive ? addressError(receive, info) : null;
  const refundErr = !sameRefund && refund ? addressError(refund, info) : null;

  const previewReq: CreateSwapRequest | null = info && amountBase && amountBase > 0n ? {
    sell, mode, amount: String(amountBase), slippageBps,
    receiveAddress: receive && !receiveErr ? receive.trim() : '',
    refundAddress: refundAddr && !addressError(refundAddr, info) ? refundAddr.trim() : '',
    refundPubkey: '',
  } : null;
  const preview = usePreview(previewReq);

  const ready = !!info && !!amountBase && amountBase > 0n && !addressError(receive, info) && !addressError(refundAddr, info);

  const create = useMutation({
    mutationFn: async () => {
      const secret = schnorr.utils.randomSecretKey();
      const req: CreateSwapRequest = { ...previewReq!, receiveAddress: receive.trim(), refundAddress: refundAddr.trim(), refundPubkey: hex(schnorr.getPublicKey(secret)) };
      // Pin the rate the user is agreeing to before asking Striker for terms.
      const minRate = rateFloor(book, sell, info!.feeBps, slippageBps);
      const view = await api.createSwap(req);
      saveRefundKey(view.id, hex(secret));
      saveSwap({ id: view.id, createdAt: Date.now(), request: req, lastStatus: view.status, ...(minRate ? { minRate } : {}) });
      return view;
    },
    onSuccess: (view) => onCreated(view.id),
  });

  const est = previewReq ? preview.data : undefined;
  const estRows = useMemo(() => {
    if (!est) return null;
    const usd = (v: string) => `$${fmtUsd(v, decimals)}`;
    const sats = (v: string) => `${fmtSats(v)} sats`;
    if (sell === 'BTC') return {
      send: sats(est.deposit.sats),
      receive: usd(est.expected.asset) + (BigInt(est.expected.sats) > 0n ? ` + ${sats(est.expected.sats)} back` : ''),
      min: usd(est.minimum.asset),
    };
    return {
      send: est.deposit.asset ? `$${fmtUsd(est.deposit.asset.amount, decimals)} + ${sats(est.deposit.sats)}` : sats(est.deposit.sats),
      receive: sats(est.expected.sats) + (BigInt(est.expected.asset) > 0n ? ` + ${usd(est.expected.asset)} back` : ''),
      min: sats(est.minimum.sats),
    };
  }, [est, sell, decimals]);

  const previewErr = previewReq && preview.error && !(preview.error instanceof OfflineError) ? preview.error.message : null;

  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate(); }}>
        <Seg<Sell> value={sell} onChange={setSell} options={[
          { value: 'BTC', label: `Sell BTC → ${ticker}` },
          { value: 'ASSET', label: `Sell ${ticker} → BTC` },
        ]} />

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label htmlFor="amount" className="text-sm text-slate-400">Amount</label>
            <div className="w-48"><Seg<Mode> value={mode} onChange={setMode} options={[
              { value: 'exactIn', label: 'I send' }, { value: 'exactOut', label: 'I receive' },
            ]} /></div>
          </div>
          <div className="flex items-center rounded-xl border border-line bg-black/30 px-3 focus-within:border-accent">
            {!amountIsBtc && <span className="text-xl text-slate-500">$</span>}
            <input
              id="amount" inputMode={amountIsBtc ? 'numeric' : 'decimal'} autoComplete="off" placeholder="0"
              value={amount} onChange={(e) => setAmount(e.target.value)}
              className="min-w-0 flex-1 bg-transparent px-1 py-3 text-2xl tabular-nums outline-none"
            />
            <span className="text-sm text-slate-400">{amountIsBtc ? 'sats' : ticker}</span>
          </div>
          <p className={`mt-1 text-xs ${amountErr ? 'text-red-400' : 'text-slate-500'}`}>
            {amountErr ?? (amountIsBtc && amountBase ? `= ${fmtBtc(amountBase)} BTC` : mode === 'exactOut' ? 'Exact amount you receive, after fees' : ' ')}
          </p>
        </div>

        <div>
          <div className="mb-1.5 text-sm text-slate-400">Max slippage</div>
          <Seg<number> value={slippageBps} onChange={setSlippage} options={SLIPPAGE.map((b) => ({ value: b, label: `${b / 100}%` }))} />
        </div>

        <AddressInput id="receive" label={`Receive ${sell === 'BTC' ? ticker : 'BTC'} to (Ark address)`} value={receive} onChange={setReceive} error={receiveErr} hrp={info?.network === 'bitcoin' ? 'ark' : 'tark'} />
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={sameRefund} onChange={(e) => setSameRefund(e.target.checked)} className="size-4 accent-amber-500" />
          Refund to the same address
        </label>
        {!sameRefund && <AddressInput id="refund" label="Refund address (Ark address)" value={refund} onChange={setRefund} error={refundErr} hrp={info?.network === 'bitcoin' ? 'ark' : 'tark'} />}

        <div className="rounded-xl bg-black/20 px-3 py-2">
          {estRows && est ? (
            <div className={preview.isFetching ? 'opacity-70' : ''}>
              <Row label="You send">{estRows.send}</Row>
              <Row label="You receive (expected)" strong>{estRows.receive}</Row>
              <Row label="Guaranteed minimum">{estRows.min}</Row>
              <Row label="Fee">{info ? `${Number(info.feeBps) / 100}%` : '–'}</Row>
              <Row label="Maker price">${fmtPrice(est.makerPrice)} / BTC</Row>
            </div>
          ) : (
            <p className="py-2 text-center text-sm text-slate-500">
              {previewErr ?? (preview.isFetching ? 'Getting a quote…' : 'Enter an amount for a live estimate')}
            </p>
          )}
          {estRows && previewErr && <p className="pt-1 text-xs text-red-400">{previewErr}</p>}
        </div>

        {create.error && (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {create.error instanceof ApiError || create.error instanceof OfflineError ? create.error.message : `Failed: ${create.error.message}`}
          </p>
        )}

        <button
          type="submit" disabled={!ready || create.isPending}
          className="w-full rounded-xl bg-accent py-3 text-base font-semibold text-slate-900 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {!info ? 'Striker offline' : create.isPending ? 'Creating…' : 'Create swap'}
        </button>
      </form>
    </Card>
  );
}

function AddressInput({ id, label, value, onChange, error, hrp }: {
  id: string; label: string; value: string; onChange: (v: string) => void; error: string | null; hrp: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm text-slate-400">{label}</label>
      <input
        id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={`${hrp}1…`}
        autoComplete="off" autoCapitalize="off" spellCheck={false}
        className={`w-full rounded-xl border bg-black/30 px-3 py-2.5 font-mono text-sm outline-none ${error ? 'border-red-500/60' : 'border-line focus:border-accent'}`}
      />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
