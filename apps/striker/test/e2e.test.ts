// End to end on the regtest stack (`npm run regtest -- start`): Striker server + maker bot as child
// processes, swaps created over HTTP, deposits from a plain Ark wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchChainParams, hex, swapCovenant, termsFromWire, type CreateSwapRequest, type PreviewResponse, type SwapView } from '@striker/core';
import { balanceOf, closeWallets, fund, openWallet, profile, startStack, USD, waitFor, type Stack } from '../../../scripts/testnet.js';

const api = (stack: Stack) => async <T>(p: string, json?: unknown): Promise<T> => {
  const res = await fetch(`${stack.url}${p}`, json ? { method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json' } } : {});
  const body = await res.json();
  if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(body)}`);
  return body as T;
};
const SATS = 100_000n;

test(`striker + maker bot: simple-flow swaps end to end`, { timeout: 900_000 }, async t => {
  const stack = await startStack({ name: 'e2e', port: 7180, swapTtl: 60, fixedPrice: 100_000 });
  t.after(async () => { await stack.stop(); await closeWallets(); });
  const call = api(stack);
  const user = await openWallet('e2e-user');
  const usd = await fund(user, { sats: 4n * SATS, usd: 100n * USD });
  const chain = await fetchChainParams(profile.arkUrl);

  const swapAndWait = async (req: Pick<CreateSwapRequest, 'sell' | 'mode' | 'amount'>, send: (v: SwapView) => Promise<unknown>) => {
    const full: CreateSwapRequest = { ...req, slippageBps: 50, receiveAddress: user.address, refundAddress: user.address, refundPubkey: hex(user.publicKey) };
    const preview = await call<PreviewResponse>('/v1/swaps/preview', full);
    const view = await call<SwapView>('/v1/swaps', full);
    // What the web app does: rebuild the covenant from the terms and compare the address.
    assert.equal(swapCovenant(chain, termsFromWire(view.terms)).address, view.address);
    assert.deepEqual(view.deposit, preview.deposit);
    await send(view);
    const done = await waitFor(async () => { const v = await call<SwapView>(`/v1/swaps/${view.id}`); return v.status === 'filled' || v.status === 'refunded' ? v : undefined; },
      'swap fill', 120_000);
    assert.equal(done.status, 'filled', done.error);
    assert.deepEqual(done.received, view.expected, 'received what the preview promised at an unchanged quote');
    console.log(`  ${req.sell} ${req.mode} ${req.amount}: got ${JSON.stringify(done.received)} in ${done.fillTxid}`);
    return { view, done };
  };
  const payBtc = (v: SwapView) => user.wallet.send({ address: v.address, amount: Number(v.deposit.sats) });
  const payUsd = (v: SwapView) => user.wallet.send({ address: v.address, amount: Number(v.deposit.sats), assets: [{ assetId: usd, amount: BigInt(v.deposit.asset!.amount) }] });

  await t.test(`sell ${SATS} sats for USD (exact-in)`, async () => {
    const before = await balanceOf(user, usd);
    const { view, done } = await swapAndWait({ sell: 'BTC', mode: 'exactIn', amount: String(SATS) }, payBtc);
    assert.ok(BigInt(done.received!.asset) >= BigInt(view.minimum.asset));
    const after = await waitFor(async () => { const b = await balanceOf(user, usd); return b.asset > before.asset ? b : undefined; }, 'USD arrives');
    assert.equal(after.asset - before.asset, BigInt(done.received!.asset));
  });

  await t.test('buy $10 with BTC (exact-out) and sell $15 for BTC (exact-in), filled concurrently', async () => {
    const [a, b] = await Promise.all([
      swapAndWait({ sell: 'BTC', mode: 'exactOut', amount: String(10n * USD) }, payBtc),
      swapAndWait({ sell: 'ASSET', mode: 'exactIn', amount: String(15n * USD) }, payUsd),
    ]);
    assert.equal(a.done.received!.asset, String(10n * USD));
    assert.ok(BigInt(b.done.received!.sats) >= BigInt(b.view.minimum.sats));
  });

  await t.test('buy 10 000 sats with USD (exact-out, token change)', async () => {
    const { done } = await swapAndWait({ sell: 'ASSET', mode: 'exactOut', amount: '10000' }, payUsd);
    assert.ok(BigInt(done.received!.sats) >= 10_000n);
  });

  await t.test('an underpaid exact-out swap is not filled and refunds after the deadline', async () => {
    const full: CreateSwapRequest = { sell: 'BTC', mode: 'exactOut', amount: String(5n * USD), slippageBps: 50,
      receiveAddress: user.address, refundAddress: user.address, refundPubkey: hex(user.publicKey) };
    const view = await call<SwapView>('/v1/swaps', full);
    await user.wallet.send({ address: view.address, amount: Number(view.deposit.sats) - 1_000 });
    const done = await waitFor(async () => { const v = await call<SwapView>(`/v1/swaps/${view.id}`); return v.status === 'refunded' || v.status === 'filled' ? v : undefined; },
      'refund', 240_000, 1_000);
    assert.equal(done.status, 'refunded');
    console.log(`  underpaid swap refunded in ${done.refundTxid}`);
  });

  await t.test('rejects bad requests', async () => {
    const base: CreateSwapRequest = { sell: 'BTC', mode: 'exactIn', amount: '50000', slippageBps: 50,
      receiveAddress: user.address, refundAddress: user.address, refundPubkey: hex(user.publicKey) };
    await assert.rejects(call('/v1/swaps', { ...base, slippageBps: 501 }), /slippageBps/);
    await assert.rejects(call('/v1/swaps', { ...base, amount: '100' }), /dust/);
    await assert.rejects(call('/v1/swaps', { ...base, refundPubkey: 'zz' }), /refundPubkey/);
    await assert.rejects(call('/v1/swaps', { ...base, receiveAddress: 'tark1nope' }), /receive address/);
    await assert.rejects(call('/v1/swaps/00000000-0000-0000-0000-000000000000'), /404/);
  });
});
