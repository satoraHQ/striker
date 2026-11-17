// Offer covenant: quote validity (§13 1), floor + min_fill (3), epoch bump (4), two-asset
// fills in both directions (5), and the maker side of the dust rule (7). Keys 20–29.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { coinAt, coinsAt, connect, disposeWallets, submit, secret, waitFor,
  type Chain, type TestWallet } from './harness.js';
import { BTC, assetBytes, assetIdsOf, buildTx, demoUsd, ensureFunded, sweepOffer, expectError, finalWeight, makerLeg, minReceived, offerTree, ownerInput, signQuote,
  refusedExplained, submitExplained, submitToArkd, usdOf, walletCoins, walletInput, type Coin, type FillPlan, type Offer, type Quote, type TxOutput } from './offer.js';

const USD = 100_000_000n;                     // one demo USD in atomic units (8 decimals)
const now = () => BigInt(Math.floor(Date.now() / 1000));

/** Rate helpers at 100 000 USD/BTC: 1 sat = 100 000 units; 1 unit = 1/100 000 sat. */
const sellBtc = (o: Offer, over: Partial<Quote> = {}): Quote => ({ maker: o.maker, epoch: o.epoch, sell: BTC, buy: assetBytes(o.usd),
  rateNum: 100_000n, rateDen: 1n, floor: 50_000n, minFill: 1_000n, expiry: now() + 600n, ...over });
const sellUsd = (o: Offer, over: Partial<Quote> = {}): Quote => ({ maker: o.maker, epoch: o.epoch, sell: assetBytes(o.usd), buy: BTC,
  rateNum: 1n, rateDen: 100_000n, floor: 500n * USD, minFill: 1n * USD, expiry: now() + 600n, ...over });

test('offer covenant: quotes, floor, epoch, two assets, dust', { timeout: 600_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const maker = await ensureFunded(chain, 20, 0);
  const taker = await ensureFunded(chain, 21, 0);
  // Reclaim offer VTXOs left by earlier runs (owner leaf, epochs 0 and 1), then top up if short.
  for (const id of await assetIdsOf(chain, maker)) for (const epoch of [0n, 1n]) await sweepOffer(chain, offerTree(chain, maker.publicKey, epoch, id), maker);
  await ensureFunded(chain, 20, 400_000); await ensureFunded(chain, 21, 400_000);
  const usd = await demoUsd(chain, maker);
  // Taker holds USD on a separate VTXO (1000 sats carrier + 50 000 USD).
  await maker.wallet.send({ address: taker.address, amount: 1_000, assets: [{ assetId: usd, amount: 50_000n * USD }] });
  const takerUsdCoin = async () => waitFor(async () => (await walletCoins(chain, taker)).find(v => usdOf(v, usd) > 0n), 'taker USD coin');
  /** The taker's biggest coin; it may carry USD, which the fill helper passes through. */
  const takerSatsCoin = async () => waitFor(async () => (await walletCoins(chain, taker)).filter(v => v.value >= 500_000).sort((a, b) => b.value - a.value)[0], 'taker sats coin');

  let offer = offerTree(chain, maker.publicKey, 0n, usd);
  const fundTxid = await maker.wallet.send({ address: offer.address, amount: 100_000, assets: [{ assetId: usd, amount: 1_000n * USD }] });
  let coin: Coin = await coinAt(chain, offer.tree, fundTxid);
  assert.equal(coin.value, 100_000);
  assert.equal(usdOf(coin, usd), 1_000n * USD);

  /** Taker pays `pay` of the asset the maker sells for, receives `get` of the asset the maker sells. */
  async function fill(plan: FillPlan, takerCoin: Awaited<ReturnType<typeof takerUsdCoin>>, mutate?: (outs: TxOutput[]) => void) {
    const leg = makerLeg(plan);
    const btcSide = plan.quote.sell.every(b => b === 0);
    const tSats = BigInt(takerCoin.value), tUsd = usdOf(takerCoin, usd);
    const takerOut: TxOutput = btcSide
      ? { script: taker.pkScript, amount: tSats + plan.sold, assets: tUsd - plan.received > 0n ? [{ assetId: usd, amount: tUsd - plan.received }] : [] }
      : { script: taker.pkScript, amount: tSats - plan.received, assets: [{ assetId: usd, amount: tUsd + plan.sold }] };
    const outs = [leg.change, takerOut];
    mutate?.(outs);
    return buildTx(chain, [leg.input, walletInput(takerCoin, taker.identity)], outs);
  }
  const plan = (quote: Quote, sold: bigint, signatureOverride?: Uint8Array, received = minReceived(quote, sold)): FillPlan => {
    const { message, signature } = signQuote(quote, secret(20));
    return { offer, coin, quote, message, signature: signatureOverride ?? signature, sold, received };
  };
  const settle = async (built: Awaited<ReturnType<typeof buildTx>>) => {
    const { txid, result } = await submitExplained(chain, built);
    coin = await coinAt(chain, offer.tree, txid);
    return { ...finalWeight(result.signedArkTx), txid };
  };

  await t.test('1. quote validity', async () => {
    const q = sellBtc(offer);
    let lines = await refusedExplained(async () => { const b = await fill(plan(q, 10_000n, randomBytes(64)), await takerUsdCoin()); return submit(chain, b.arkTx, b.checkpoints, b.prevTxids); });
    expectError(lines, 'signature verification failed');
    lines = await refusedExplained(async () => { const b = await fill(plan(sellBtc(offer, { epoch: 1n }), 10_000n), await takerUsdCoin()); return submit(chain, b.arkTx, b.checkpoints, b.prevTxids); });
    expectError(lines, /EQUALVERIFY/);
    lines = await refusedExplained(async () => { const b = await fill(plan(sellBtc(offer, { expiry: now() - 5n }), 10_000n), await takerUsdCoin()); return submit(chain, b.arkTx, b.checkpoints, b.prevTxids); });
    expectError(lines, /OP_VERIFY|VERIFY failed/);
    // Underpayment by one unit is refused; the exact rounded-up amount fills.
    lines = await refusedExplained(async () => { const b = await fill(plan(q, 10_000n, undefined, minReceived(q, 10_000n) - 1n), await takerUsdCoin()); return submit(chain, b.arkTx, b.checkpoints, b.prevTxids); });
    expectError(lines, /VERIFY/);
    const r = await settle(await fill(plan(q, 10_000n), await takerUsdCoin()));
    console.log(`  fill tx (1 maker, 1 taker): weight=${r.weight} vsize=${r.vsize}`);
    assert.equal(coin.value, 90_000);
    assert.equal(usdOf(coin, usd), 1_000n * USD + 10_000n * 100_000n);     // payment landed in the change
    assert.equal(usdOf(await takerUsdCoin(), usd), 50_000n * USD - 10_000n * 100_000n);
  });

  await t.test('3. floor across chained partial fills, min_fill', async () => {
    const q = sellBtc(offer);                                               // floor 50 000, min_fill 1 000
    for (const sold of [10_000n, 10_000n, 10_000n]) await settle(await fill(plan(q, sold), await takerUsdCoin()));
    assert.equal(coin.value, 60_000);
    let lines = await refusedExplained(async () => { const b = await fill(plan(q, 10_001n), await takerUsdCoin()); return submit(chain, b.arkTx, b.checkpoints, b.prevTxids); });
    expectError(lines, /VERIFY/);                                           // crosses the floor
    lines = await refusedExplained(async () => { const b = await fill(plan(q, 999n), await takerUsdCoin()); return submit(chain, b.arkTx, b.checkpoints, b.prevTxids); });
    expectError(lines, /VERIFY/);                                           // below min_fill
    await settle(await fill(plan(q, 10_000n), await takerUsdCoin()));       // exactly onto the floor is fine
    assert.equal(coin.value, 50_000);
  });

  await t.test('4. epoch bump via the owner leaf cancels outstanding quotes', async () => {
    const old = sellBtc(offer, { floor: 10_000n });
    const bumped = offerTree(chain, maker.publicKey, 1n, usd);
    const built = await buildTx(chain, [ownerInput(coin, offer.tree, maker.identity)],
      [{ script: bumped.tree.pkScript, amount: BigInt(coin.value), assets: [{ assetId: usd, amount: usdOf(coin, usd) }] }]);
    const txid = await submitToArkd(chain, built.arkTx, built.checkpoints, maker.identity);
    const previous = offer;
    offer = bumped;
    coin = await coinAt(chain, offer.tree, txid);
    assert.equal((await coinsAt(chain, previous.tree)).length, 0);
    const lines = await refusedExplained(async () => { const b = await fill({ ...plan(old, 10_000n), offer }, await takerUsdCoin()); return submit(chain, b.arkTx, b.checkpoints, b.prevTxids); });
    expectError(lines, /EQUALVERIFY/);
    await settle(await fill(plan(sellBtc(offer, { floor: 10_000n }), 10_000n), await takerUsdCoin()));
    assert.equal(coin.value, 40_000);
  });

  await t.test('5. the same two-asset VTXO fills in the other direction', async () => {
    const q = sellUsd(offer);                                               // maker sells USD for sats
    const before = { sats: BigInt(coin.value), usd: usdOf(coin, usd) };
    const r = await settle(await fill(plan(q, 100n * USD), await takerSatsCoin()));
    console.log(`  reverse fill tx: weight=${r.weight}`);
    assert.equal(BigInt(coin.value), before.sats + 100_000n);              // 100 USD → 100 000 sats
    assert.equal(usdOf(coin, usd), before.usd - 100n * USD);
    // ... and straight back the other way on the new change.
    await settle(await fill(plan(sellBtc(offer, { floor: 10_000n }), 5_000n), await takerUsdCoin()));
    assert.equal(BigInt(coin.value), before.sats + 95_000n);
    // Floor on the USD side: selling down to below 500 USD is refused.
    const lines = await refusedExplained(async () => { const b = await fill(plan(q, usdOf(coin, usd) - 499n * USD), await takerSatsCoin()); return submit(chain, b.arkTx, b.checkpoints, b.prevTxids); });
    expectError(lines, /VERIFY/);
  });

  await t.test('7. the maker never funds taker dust', async () => {
    // Selling USD: the taker's USD output carries 330 sats of dust taken from the maker's change.
    let q = sellUsd(offer);
    let lines = await refusedExplained(async () => {
      const b = await fill(plan(q, 100n * USD), await takerSatsCoin(), outs => { outs[0]!.amount -= chain.dust; outs[1]!.amount += chain.dust; });
      return submit(chain, b.arkTx, b.checkpoints, b.prevTxids);
    });
    expectError(lines, /VERIFY/);
    // Selling BTC: the taker takes `sold` + dust but pays only for `sold`.
    q = sellBtc(offer, { floor: 10_000n });
    lines = await refusedExplained(async () => {
      const b = await fill(plan(q, 5_000n), await takerUsdCoin(), outs => { outs[0]!.amount -= chain.dust; outs[1]!.amount += chain.dust; });
      return submit(chain, b.arkTx, b.checkpoints, b.prevTxids);
    });
    expectError(lines, /VERIFY/);
    // Paying for the dust at the quoted rate is just a bigger fill, and that is allowed.
    await settle(await fill(plan(q, 5_000n + chain.dust), await takerUsdCoin()));
  });
});
