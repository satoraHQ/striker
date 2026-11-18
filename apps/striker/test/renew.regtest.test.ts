// Renewal end to end: Striker renews the maker's offer VTXO through a batch (Renew leaf, DESIGN.md §8),
// then fills a swap against the renewed VTXO. Needs `npm run regtest -- start`. Keys 210–219 (shared with e2e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, disposeWallets, hex, secret, waitFor } from '../../../spike/harness.js';
import { demoUsd, ensureFunded } from '../../../spike/offer.js';
import { termsFromWire, swapCovenant, chainParamsFromInfo, type CreateSwapRequest, type SwapView, type BookSnapshot } from '@striker/core';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const PORT = 7181, URL_ = `http://localhost:${PORT}`;
const USD = 100_000_000n;

function run(name: string, script: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim() && !l.includes('Esplora websocket')) console.log(`  [${name}] ${l}`); };
  child.stdout!.on('data', out); child.stderr!.on('data', out);
  return child;
}
const api = async <T>(p: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
  const res = await fetch(`${URL_}${p}`, { ...init, ...(init?.json ? { method: 'POST', body: JSON.stringify(init.json), headers: { 'content-type': 'application/json' } } : {}) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(body)}`);
  return body as T;
};

test('striker renews offer covenants', { timeout: 600_000 }, async t => {
  const children: ChildProcess[] = [];
  t.after(async () => { for (const c of children) c.kill('SIGTERM'); await disposeWallets(); });
  const chain = await connect();
  const maker = await ensureFunded(chain, 210, 3_000_000);
  const user = await ensureFunded(chain, 212, 1_000_000);
  const usd = await demoUsd(chain, maker);
  const userUsd = (await user.wallet.getBalance()).assets?.find(a => a.assetId === usd)?.amount ?? 0;
  if (BigInt(userUsd) < 500n * USD) await maker.wallet.send({ address: user.address, amount: 330, assets: [{ assetId: usd, amount: 1_000n * USD }] });

  const data = mkdtempSync(path.join(tmpdir(), 'striker-e2e-'));
  children.push(run('striker', 'apps/striker/src/main.ts', {
    PORT: String(PORT), STRIKER_DATA: path.join(data, 'striker'), STRIKER_SECRET: hex(secret(211)), ASSET_ID: usd, SWAP_TTL: '60', RENEW_BEFORE: '86400', RENEW_CHECK_MS: '2000',
  }));
  await waitFor(async () => { try { return await api('/v1/info'); } catch { return undefined; } }, 'striker up', 60_000);
  children.push(run('maker', 'apps/maker/src/main.ts', {
    STRIKER_URL: URL_, MAKER_DATA: path.join(data, 'maker'), MAKER_SECRET: hex(secret(210)), FIXED_PRICE: '100000', EPOCH: String(Date.now()),
    OFFER_SATS: '1000000', OFFER_ASSET: String(1_000n * USD),
  }));
  const book = await waitFor(async () => { const b = await api<BookSnapshot>('/v1/book'); return b.asks.length && b.bids.length ? b : undefined; }, 'maker quotes', 60_000);
  console.log(`  book: ask ${book.asks[0]!.price}, bid ${book.bids[0]!.price}`);

  const params = chainParamsFromInfo(chain.info);
  const swapAndWait = async (req: Omit<CreateSwapRequest, 'receiveAddress' | 'refundAddress' | 'refundPubkey' | 'slippageBps'>, send: (v: SwapView) => Promise<unknown>) => {
    const full: CreateSwapRequest = { ...req, slippageBps: 50, receiveAddress: user.address, refundAddress: user.address, refundPubkey: hex(user.publicKey) };
    const preview = await api<Pick<SwapView, 'expected' | 'deposit'>>('/v1/swaps/preview', { json: full });
    const view = await api<SwapView>('/v1/swaps', { json: full });
    // What the web app does: rebuild the covenant from the terms and compare the address.
    assert.equal(swapCovenant(params, termsFromWire(view.terms)).address, view.address);
    assert.deepEqual(view.deposit, preview.deposit);
    await send(view);
    const done = await waitFor(async () => { const v = await api<SwapView>(`/v1/swaps/${view.id}`); return v.status === 'filled' || v.status === 'refunded' ? v : undefined; }, 'swap fill', 60_000);
    assert.equal(done.status, 'filled', done.error);
    console.log(`  ${req.sell} ${req.mode} ${req.amount}: expected ${JSON.stringify(view.expected)} got ${JSON.stringify(done.received)} in ${done.fillTxid}`);
    return { view, done };
  };

  let renewedLog = '';
  children[0]!.stdout!.on('data', (d: Buffer) => { if (/renewed in batch/.test(d.toString())) renewedLog = d.toString().trim(); });
  await t.test('the offer VTXO is renewed into a batch, then fills', async () => {
    await waitFor(async () => renewedLog || undefined, 'renewal', 120_000);
    const offer = book.bids[0]!.address;
    const fresh = await waitFor(async () => {
      const b = await api<BookSnapshot>('/v1/book');
      const e = b.bids.find(x => x.address === offer);
      return e && e.outpoint !== book.bids[0]!.outpoint ? e : undefined;
    }, 'renewed offer coin in the book', 60_000);
    console.log(`  offer moved ${book.bids[0]!.outpoint} → ${fresh.outpoint}`);
    await swapAndWait({ sell: 'BTC', mode: 'exactIn', amount: '50000' }, v => user.wallet.send({ address: v.address, amount: Number(v.deposit.sats) }));
  });
});
