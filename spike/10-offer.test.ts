// Offer covenant: quote validity (§13 1), floor + min_fill (3), epoch bump (4), two-asset
// fills in both directions (5), and the maker side of the dust rule (7). Keys 20–29.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { attachPrevArkTxs, Transaction } from '@arkade-os/sdk';
import { b64, coinAt, coinsAt, connect, disposeWallets, refused, regtest, secret, submitBuilt, submitToArkd, unb64, waitFor, walletCoins } from './harness.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { OFF, SELL_BTC, SELL_USD, assetIdsOf, buildTx, demoUsd, encodeQuote, ensureFunded, sweepOffer, finalWeight, makerLeg, minReceived, offerTree, ownerInput, quoteHash, signQuote,
  usdOf, walletInput, type Coin, type FillPlan, type Offer, type Quote, type QuoteContext, type TxOutput } from './offer.js';

const USD = 100_000_000n;                     // one demo USD in atomic units (8 decimals)
const now = () => BigInt(Math.floor(Date.now() / 1000));

/** Rate helpers at 100 000 USD/BTC: 1 sat = 100 000 units; 1 unit = 1/100 000 sat. */
const sellBtc = (over: Partial<Quote> = {}): Quote => ({ side: SELL_BTC, rateNum: 100_000n, rateDen: 1n, floor: 50_000n, minFill: 1_000n, expiry: now() + 600n, ...over });
const sellUsd = (over: Partial<Quote> = {}): Quote => ({ side: SELL_USD, rateNum: 1n, rateDen: 100_000n, floor: 500n * USD, minFill: 1n * USD, expiry: now() + 600n, ...over });

test('offer covenant: quotes, floor, epoch, two assets, dust', { timeout: 600_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const maker = await ensureFunded(chain, 20, 0);
  const taker = await ensureFunded(chain, 21, 0);
  // Reclaim offer VTXOs left by earlier runs (owner leaf, epochs 0 and 1), then top up if short.
  for (const id of await assetIdsOf(chain, maker)) for (const epoch of [0n, 1n]) await sweepOffer(chain, offerTree(chain, maker.publicKey, epoch, id), maker);
  await ensureFunded(chain, 20, 400_000);
  // The taker pays two 100 000-sat fills from one coin; give it a fresh 400 000-sat coin when no coin can.
  // Tests 5 and 7 pay two ~100 000-sat fills from one coin, so the taker needs a single large
  // sats VTXO — a high *total* balance spread over small coins is not enough. Send one from the
  // faucet and wait until the indexer exposes it (the SDK wallet's own balance view lags).
  // One run pays 100 000 sats from it (test 5) and still needs a ≥ 250 000-sat coin afterwards, so start from ≥ 350 000.
  const bigSats = async () => (await walletCoins(chain, taker)).filter(v => v.value >= 350_000).sort((a, b) => b.value - a.value)[0];
  if (!(await bigSats())) {
    regtest('ark', 'send', '--to', taker.address, '--amount', '450000', '--password', 'secret');
    await waitFor(bigSats, 'taker large sats coin', 60_000);
  }
  const usd = await demoUsd(chain, maker);
  // Taker holds USD on a separate VTXO (1000 sats carrier + 50 000 USD).
  await maker.wallet.send({ address: taker.address, amount: 1_000, assets: [{ assetId: usd, amount: 50_000n * USD }] });
  // The dedicated USD carrier (least sats of the taker's USD-bearing coins), so the big sats
  // coin a reverse fill produces — which now also carries USD — is never spent as the USD leg.
  const takerUsdCoin = async () => waitFor(async () => (await walletCoins(chain, taker)).filter(v => usdOf(v, usd) > 0n).sort((a, b) => a.value - b.value)[0], 'taker USD coin');
  /** The taker's biggest coin able to pay a 100 000-sat fill; it may carry USD, which the fill helper passes through. */
  const takerSatsCoin = async () => waitFor(async () => (await walletCoins(chain, taker)).filter(v => v.value >= 250_000).sort((a, b) => b.value - a.value)[0], 'taker sats coin');

  let offer = offerTree(chain, maker.publicKey, 0n, usd);
  const fundTxid = await maker.wallet.send({ address: offer.address, amount: 100_000, assets: [{ assetId: usd, amount: 1_000n * USD }] });
  let coin: Coin = await coinAt(chain, offer.tree, fundTxid);
  assert.equal(coin.value, 100_000);
  assert.equal(usdOf(coin, usd), 1_000n * USD);

  /** Taker pays `pay` of the asset the maker sells for, receives `get` of the asset the maker sells. */
  async function fill(plan: FillPlan, takerCoin: Awaited<ReturnType<typeof takerUsdCoin>>, mutate?: (outs: TxOutput[]) => void) {
    const leg = makerLeg(plan);
    const btcSide = plan.quote.side === SELL_BTC;
    const tSats = BigInt(takerCoin.value), tUsd = usdOf(takerCoin, usd);
    const takerOut: TxOutput = btcSide
      ? { script: taker.pkScript, amount: tSats + plan.sold, assets: tUsd - plan.received > 0n ? [{ assetId: usd, amount: tUsd - plan.received }] : [] }
      : { script: taker.pkScript, amount: tSats - plan.received, assets: [{ assetId: usd, amount: tUsd + plan.sold }] };
    const outs = [leg.change, takerOut];
    mutate?.(outs);
    return buildTx(chain, [leg.input, walletInput(takerCoin, taker.identity)], outs);
  }
  /** Signs `quote` for the current offer (or `under`: another maker/epoch/asset context) and plans a fill against the current coin. */
  const plan = (quote: Quote, sold: bigint, o: { signature?: Uint8Array; received?: bigint; under?: QuoteContext } = {}): FillPlan => {
    const { message, signature } = signQuote(o.under ?? offer, quote, secret(20));
    return { offer, coin, quote, message, signature: o.signature ?? signature, sold, received: o.received ?? minReceived(quote, sold) };
  };
  const latency: number[] = [];                                            // ms per emulator submitTx (script + sign + arkd submit + finalize)
  const settle = async (built: Awaited<ReturnType<typeof buildTx>>) => {
    await attachPrevArkTxs(built.arkTx, built.prevTxids, chain.indexer);  // the indexer fetch is timed separately in the emulator suite
    const t0 = performance.now();
    const result = await chain.emulator.submitTx(b64(built.arkTx.toPSBT()), built.checkpoints.map(c => b64(c.toPSBT())));
    latency.push(performance.now() - t0);
    const txid = Transaction.fromPSBT(unb64(result.signedArkTx)).id;
    coin = await coinAt(chain, offer.tree, txid);
    return { ...finalWeight(result.signedArkTx), txid };
  };
  t.after(() => {
    const s = [...latency].sort((a, b) => a - b), at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(0);
    console.log(`  emulator submitTx latency over ${s.length} fills: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${s.at(-1)!.toFixed(0)} ms`);
  });
  /** Asserts the covenant refuses the fill, with `expect` in the emulator's refusal text. */
  const refusedFill = (built: Promise<Awaited<ReturnType<typeof buildTx>>>, expect: string | RegExp) =>
    refused(async () => submitBuilt(chain, await built), expect);

  await t.test('1. quote validity', async () => {
    const q = sellBtc();
    const badSig = 'signature verification failed';
    await refusedFill(fill(plan(q, 10_000n, { signature: randomBytes(64) }), await takerUsdCoin()), badSig);
    // Epoch, asset and side are bound by the signature tag: a quote signed for another epoch, for
    // another USD asset, or for the other side (a sell-USD rate replayed on the sell-BTC leaf, which
    // would hand out BTC at 1/100 000 of the price) all fail the signature check.
    await refusedFill(fill(plan(q, 10_000n, { under: { ...offer, epoch: 1n } }), await takerUsdCoin()), badSig);
    await refusedFill(fill(plan(q, 10_000n, { under: { ...offer, usd: randomBytes(34) } }), await takerUsdCoin()), badSig);
    const cheap: Quote = { ...sellUsd(), side: SELL_BTC, floor: 50_000n, minFill: 1_000n };   // a sell-USD rate presented on the sell-BTC leaf
    const sellUsdSig = signQuote(offer, { ...cheap, side: SELL_USD }, secret(20)).signature;  // ... carrying the maker's genuine sell-USD signature
    await refusedFill(fill(plan(cheap, 10_000n, { signature: sellUsdSig }), await takerUsdCoin()), badSig);
    await refusedFill(fill(plan(sellBtc({ expiry: now() - 5n }), 10_000n), await takerUsdCoin()), /OP_VERIFY failed/);
    // A field ≥ 2^63 would read as negative (BIN2NUM takes the top bit as the sign) and void its
    // check, e.g. a negative rate_num sells for nothing. The covenant range-checks every field, so
    // even a maker signer that skipped the u63 rule cannot be filled on such a quote.
    for (const [field, off] of Object.entries({ rateNum: OFF.rateNum, rateDen: OFF.rateDen, floor: OFF.floor, minFill: OFF.minFill })) {
      const message = encodeQuote(q);
      message[off + 7] = message[off + 7]! | 0x80;
      const signature = schnorr.sign(quoteHash(offer, SELL_BTC, message), secret(20));
      const p = { ...plan(q, 10_000n, field === 'rateNum' ? { received: 0n } : {}), message, signature };
      await refusedFill(fill(p, await takerUsdCoin()), /OP_VERIFY failed/);
    }
    // Underpayment by one unit is refused; the exact rounded-up amount fills.
    await refusedFill(fill(plan(q, 10_000n, { received: minReceived(q, 10_000n) - 1n }), await takerUsdCoin()), /OP_VERIFY failed/);
    const r = await settle(await fill(plan(q, 10_000n), await takerUsdCoin()));
    console.log(`  fill tx (1 maker, 1 taker): weight=${r.weight} vsize=${r.vsize}`);
    assert.equal(coin.value, 90_000);
    assert.equal(usdOf(coin, usd), 1_000n * USD + 10_000n * 100_000n);     // payment landed in the change
    assert.equal(usdOf(await takerUsdCoin(), usd), 50_000n * USD - 10_000n * 100_000n);
  });

  await t.test('3. floor across chained partial fills, min_fill', async () => {
    const q = sellBtc();                                                    // floor 50 000, min_fill 1 000
    for (const sold of [10_000n, 10_000n, 10_000n]) await settle(await fill(plan(q, sold), await takerUsdCoin()));
    assert.equal(coin.value, 60_000);
    await refusedFill(fill(plan(q, 10_001n), await takerUsdCoin()), /OP_VERIFY failed/);   // crosses the floor
    await refusedFill(fill(plan(q, 999n), await takerUsdCoin()), /OP_VERIFY failed/);      // below min_fill
    await settle(await fill(plan(q, 10_000n), await takerUsdCoin()));       // exactly onto the floor is fine
    assert.equal(coin.value, 50_000);
  });

  await t.test('4. epoch bump via the owner leaf cancels outstanding quotes', async () => {
    const old = sellBtc({ floor: 10_000n });
    const bumped = offerTree(chain, maker.publicKey, 1n, usd);
    const built = await buildTx(chain, [ownerInput(coin, offer.tree, maker.identity)],
      [{ script: bumped.tree.pkScript, amount: BigInt(coin.value), assets: [{ assetId: usd, amount: usdOf(coin, usd) }] }]);
    const { txid } = await submitToArkd(chain, built.arkTx, built.checkpoints);
    const previous = offer;
    offer = bumped;
    coin = await coinAt(chain, offer.tree, txid);
    assert.equal((await coinsAt(chain, previous.tree)).length, 0);
    // A quote signed under the old epoch no longer verifies against the bumped covenant's tag.
    await refusedFill(fill(plan(old, 10_000n, { under: previous }), await takerUsdCoin()), 'signature verification failed');
    await settle(await fill(plan(sellBtc({ floor: 10_000n }), 10_000n), await takerUsdCoin()));
    assert.equal(coin.value, 40_000);
  });

  await t.test('5. the same two-asset VTXO fills in the other direction', async () => {
    const q = sellUsd();                                                    // maker sells USD for sats
    const before = { sats: BigInt(coin.value), usd: usdOf(coin, usd) };
    const r = await settle(await fill(plan(q, 100n * USD), await takerSatsCoin()));
    console.log(`  reverse fill tx: weight=${r.weight}`);
    assert.equal(BigInt(coin.value), before.sats + 100_000n);              // 100 USD → 100 000 sats
    assert.equal(usdOf(coin, usd), before.usd - 100n * USD);
    // ... and straight back the other way on the new change.
    await settle(await fill(plan(sellBtc({ floor: 10_000n }), 5_000n), await takerUsdCoin()));
    assert.equal(BigInt(coin.value), before.sats + 95_000n);
    // Floor on the USD side: a quote whose floor sits 50 USD below the balance refuses a 51 USD sale.
    const floored = sellUsd({ floor: usdOf(coin, usd) - 50n * USD });
    await refusedFill(fill(plan(floored, 51n * USD), await takerSatsCoin()), /OP_VERIFY failed/);
  });

  await t.test('7. the maker never funds taker dust', async () => {
    // Selling USD: the taker's USD output carries 330 sats of dust taken from the maker's change.
    let q = sellUsd();
    await refusedFill(fill(plan(q, 100n * USD), await takerSatsCoin(), outs => { outs[0]!.amount -= chain.dust; outs[1]!.amount += chain.dust; }), /OP_VERIFY failed/);
    // Selling BTC: the taker takes `sold` + dust but pays only for `sold`.
    q = sellBtc({ floor: 10_000n });
    await refusedFill(fill(plan(q, 5_000n), await takerUsdCoin(), outs => { outs[0]!.amount -= chain.dust; outs[1]!.amount += chain.dust; }), /OP_VERIFY failed/);
    // Paying for the dust at the quoted rate is just a bigger fill, and that is allowed.
    await settle(await fill(plan(q, 5_000n + chain.dust), await takerUsdCoin()));
  });
});
