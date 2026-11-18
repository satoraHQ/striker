// Swap deposits filled against a maker's offer covenant (core settle.ts) on the regtest stack.
// Needs `npm run regtest -- start`. Keys 200–209.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeSignerSession } from '@arkade-os/sdk';
import { coinAt, connect, disposeWallets, publicKey, refused, secret, waitFor } from '../../../spike/harness.js';
import { deposit, outputAt } from '../../../spike/swap.js';
import { demoUsd, ensureFunded } from '../../../spike/offer.js';
import {
  BTC, buildTx, chainParamsFromInfo, hex, minRateFor, offerCovenant, planSettlement, refundInput, SELL_ASSET, SELL_BTC,
  signQuote, submitViaEmulator, swapCovenant, type Offer, type Quote, type SwapTerms,
} from '../src/index.js';

const USD = 100_000_000n;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const usdOf = (v: { assets?: { assetId: string; amount: unknown }[] }, id: string) => BigInt(String(v.assets?.find(a => a.assetId === id)?.amount ?? 0));

test('core settlement: swaps against an offer covenant', { timeout: 900_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const params = chainParamsFromInfo(chain.info);
  assert.equal(hex(params.emulatorKey), hex(chain.emulatorKey));
  const D = params.dust;
  const maker = await ensureFunded(chain, 200, 3_000_000);
  const user = await ensureFunded(chain, 201, 2_000_000);
  const striker = await ensureFunded(chain, 202, 0);
  const usd = await demoUsd(chain, maker);
  const userUsd = (await user.wallet.getBalance()).assets?.find(a => a.assetId === usd)?.amount ?? 0;
  if (BigInt(userUsd) < 5_000n * USD) await maker.wallet.send({ address: user.address, amount: Number(D), assets: [{ assetId: usd, amount: 5_000n * USD }] });

  const renew = { cosigner: hex(await new TreeSignerSession(secret(203)).getPublicKey()), delegateKey: publicKey(203), window: 3_600n };
  const offer: Offer = offerCovenant(params, { maker: maker.publicKey, epoch: BigInt(Date.now()), asset: usd, renew, exitSeconds: 1536n });
  const fundOffer = async (sats: number, tokens: bigint) =>
    coinAt(chain, offer.tree, await maker.wallet.send({ address: offer.address, amount: sats, assets: tokens > 0n ? [{ assetId: usd, amount: tokens }] : [] }));
  // $100k/BTC, 1 sat = 100 000 USD units. Maker sells USD at 1.01 × and sells BTC at 0.99 × mid.
  const quote = (side: 0 | 1, over: Partial<Quote> = {}) => signQuote(offer, {
    side, ...(side === SELL_ASSET ? { rateNum: 101n, rateDen: 10_000_000n } : { rateNum: 101_000n, rateDen: 1n }),
    floor: 0n, minFill: 1n, expiry: now() + 300n, ...over,
  }, secret(200));
  const terms = (q: Quote, over: Partial<SwapTerms>): SwapTerms => ({
    receive: user.pkScript, refund: user.pkScript, feeScript: striker.pkScript, sell: BTC, buy: usd,
    rate: minRateFor(q, 30n, 50n), feeBps: 30n, deadline: now() + 600n, refundPubkey: publicKey(204), dust: D, exitDelay: 1536n, ...over,
  });
  const settle = async (orders: Parameters<typeof planSettlement>[0], makerCoin: Awaited<ReturnType<typeof fundOffer>>, q: ReturnType<typeof quote>) => {
    const { settlement, skipped } = planSettlement(orders, { offer, coin: makerCoin, quote: q }, striker.pkScript, D);
    assert.deepEqual(skipped.map(s => s.reason), []);
    const built = await buildTx(params, settlement!.inputs, settlement!.outputs);
    return { ...(await submitViaEmulator(chain.emulator, chain.indexer, built)), settlement: settlement! };
  };

  await t.test('two BTC→USD swaps (exact-in, exact-out) in one tx against the maker selling USD', async () => {
    const q = quote(SELL_ASSET);
    const makerCoin = await fundOffer(100_000, 2_000n * USD);
    const exactIn = swapCovenant(params, terms(q.quote, {}));
    const exactOut = swapCovenant(params, terms(q.quote, { exactOut: 100n * USD }));
    const a = await deposit(chain, user, exactIn, 150_000);
    // Exact-out: deposit dust + max_spend, as Striker tells the user.
    const maxSpend = 100n * USD * exactOut.terms.rate.den / exactOut.terms.rate.num;
    const b = await deposit(chain, user, exactOut, Number(D + maxSpend));
    const { txid, settlement } = await settle([{ swap: exactIn, coin: a }, { swap: exactOut, coin: b }], makerCoin, q);
    const byScript = settlement.filled.map(f => f.swap);
    const iIn = byScript.indexOf(exactIn), iOut = byScript.indexOf(exactOut);
    const gotIn = await outputAt(chain, txid, iIn), gotOut = await outputAt(chain, txid, iOut);
    assert.equal(BigInt(gotIn.value), D);
    const A = 150_000n - D;
    assert.ok(usdOf(gotIn, usd) * exactIn.terms.rate.den >= A * exactIn.terms.rate.num, 'exact-in meets min_rate');
    assert.equal(usdOf(gotOut, usd), 100n * USD);
    const change = await coinAt(chain, offer.tree, txid);
    assert.equal(BigInt(change.value), settlement.makerChange.amount);
    console.log(`  exact-in got ${usdOf(gotIn, usd)} units for ${A} sats; fee ${settlement.fee}; maker change ${change.value} sats`);
  });

  await t.test('two USD→BTC swaps (exact-in, exact-out with token change) against the maker selling BTC', async () => {
    const q = quote(SELL_BTC);
    const makerCoin = await fundOffer(1_000_000, 0n);
    const sellUsd = (over: Partial<SwapTerms>) => terms(q.quote, { sell: usd, buy: BTC, ...over });
    const exactIn = swapCovenant(params, sellUsd({}));
    const exactOut = swapCovenant(params, sellUsd({ exactOut: 50_000n }));
    const a = await deposit(chain, user, exactIn, Number(D), [{ assetId: usd, amount: 100n * USD }]);
    const b = await deposit(chain, user, exactOut, Number(D), [{ assetId: usd, amount: 100n * USD }]); // more than needed
    const { txid, settlement } = await settle([{ swap: exactIn, coin: a }, { swap: exactOut, coin: b }], makerCoin, q);
    const i = (s: typeof exactIn) => settlement.filled.findIndex(f => f.swap === s);
    const gotIn = await outputAt(chain, txid, i(exactIn)), gotOut = await outputAt(chain, txid, i(exactOut));
    assert.ok(BigInt(gotIn.value) - D >= 100n * USD * exactIn.terms.rate.num / exactIn.terms.rate.den);
    assert.ok(BigInt(gotOut.value) >= 50_000n);
    const refund = await outputAt(chain, txid, i(exactOut) + settlement.inputs.length);
    assert.ok(usdOf(refund, usd) > 0n, 'unsold USD comes back');
    console.log(`  exact-in got ${BigInt(gotIn.value) - D} sats for 100 USD; exact-out returned ${usdOf(refund, usd)} units`);
  });

  await t.test('a stale maker quote is refused by the offer covenant, the deposit refunds after the deadline', async () => {
    const q = quote(SELL_ASSET, { expiry: now() - 5n });
    const makerCoin = await fundOffer(50_000, 100n * USD);
    const swap = swapCovenant(params, terms(quote(SELL_ASSET).quote, { deadline: now() + 8n }));
    const coin = await deposit(chain, user, swap, 20_000);
    const { settlement } = planSettlement([{ swap, coin }], { offer, coin: makerCoin, quote: q }, striker.pkScript, D);
    await refused(async () => submitViaEmulator(chain.emulator, chain.indexer, await buildTx(params, settlement!.inputs, settlement!.outputs)), 'OP_VERIFY');
    await waitFor(async () => now() > swap.terms.deadline + 1n ? true : undefined, 'deadline', 30_000);
    const { input, output } = refundInput(swap, coin);
    const { txid } = await submitViaEmulator(chain.emulator, chain.indexer, await buildTx(params, [input], [output]));
    const back = await outputAt(chain, txid, 0);
    assert.equal(back.value, 20_000);
  });
});
