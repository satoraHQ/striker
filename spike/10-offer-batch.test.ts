// Offer covenant batching (§13 6): two makers and two takers in one tx, the index-pairing
// attack, and the practical input/output limit against arkd's maxTxWeight. Keys 30–39.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinAt, coinsAt, connect, disposeWallets, refused, rejectionOf, secret, submitBuilt, waitFor, walletCoins } from './harness.js';
import { QUOTE_LENGTH, SELL_BTC, SELL_USD, assetIdsOf, buildTx, demoUsd, ensureFunded, sweepOffer, finalWeight, makerLeg, minReceived, offerTree, signQuote,
  usdOf, walletInput, type Coin, type FillPlan, type Offer, type Quote, type TxInput, type TxOutput } from './offer.js';
import type { ExtendedVirtualCoin } from '@arkade-os/sdk';

const USD = 100_000_000n;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const sellBtc = (over: Partial<Quote> = {}): Quote => ({ side: SELL_BTC, rateNum: 100_000n, rateDen: 1n, floor: 1_000n, minFill: 100n, expiry: now() + 600n, ...over });
const sellUsd = (over: Partial<Quote> = {}): Quote => ({ side: SELL_USD, rateNum: 1n, rateDen: 100_000n, floor: 1n * USD, minFill: USD / 1000n, expiry: now() + 600n, ...over });

test('offer covenant: batching, index pairing, size limit', { timeout: 900_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const makerA = await ensureFunded(chain, 30, 900_000);     // funds the USD issuance/sends below; topped up again after the sweep
  const makerB = await ensureFunded(chain, 31, 0);
  const taker1 = await ensureFunded(chain, 32, 500_000);
  const taker2 = await ensureFunded(chain, 33, 600_000);
  const usd = await demoUsd(chain, makerA);
  // makerB funds offers in USD, taker1 pays USD for every sell-BTC fill (≈ 1 000 USD per maker input in the
  // size probe). Top up only the shortfall below 50 000 USD: the USD circulates back to makerA via the sweep.
  const usdBalance = async (w: typeof taker1) => (await walletCoins(chain, w)).reduce((s, v) => s + usdOf(v, usd), 0n);
  for (const w of [makerB, taker1]) {
    const short = 50_000n * USD - await usdBalance(w);
    if (short > 0n) await makerA.wallet.send({ address: w.address, amount: 1_000, assets: [{ assetId: usd, amount: short }] });
  }
  const usdCoin = async (w: typeof taker1) => waitFor(async () => (await walletCoins(chain, w)).find(v => usdOf(v, usd) > 0n), 'USD coin');
  const satsCoins = async (w: typeof taker1, n: number, min = 1_000) =>
    waitFor(async () => { const c = (await walletCoins(chain, w)).filter(v => v.value >= min); return c.length >= n ? c.slice(0, n) : undefined; }, `${n} coins >= ${min} sats`);

  const A = offerTree(chain, makerA.publicKey, 0n, usd), B = offerTree(chain, makerB.publicKey, 0n, usd);
  console.log(`  fill scripts: sell-BTC ${A.fill[SELL_BTC].length} bytes, sell-USD ${A.fill[SELL_USD].length} bytes; quote ${QUOTE_LENGTH} bytes`);
  // Reclaim offer VTXOs left by earlier runs (owner leaf), then top up the maker wallets if still short.
  for (const [w, o] of [[makerA, A], [makerB, B]] as const) {
    let swept = 0;
    for (const id of await assetIdsOf(chain, w)) swept += await sweepOffer(chain, offerTree(chain, w.publicKey, 0n, id), w);
    if (swept) console.log(`  swept ${swept} leftover offer VTXOs of key ${w === makerA ? 30 : 31}`);
  }
  await ensureFunded(chain, 30, 900_000); await ensureFunded(chain, 31, 200_000);
  const fund = async (w: typeof makerA, o: Offer, sats: number, usdAmount: bigint): Promise<Coin> =>
    coinAt(chain, o.tree, await w.wallet.send({ address: o.address, amount: sats, assets: usdAmount > 0n ? [{ assetId: usd, amount: usdAmount }] : [] }));
  const plan = (offer: Offer, coin: Coin, quote: Quote, key: number, sold: bigint): FillPlan => {
    const { message, signature } = signQuote(offer, quote, secret(key));
    return { offer, coin, quote, message, signature, sold, received: minReceived(quote, sold) };
  };
  /** Taker leg: pays sats (maker sells USD) or USD (maker sells BTC) from `coin`, one output that
   * also carries whatever other assets the coin holds. */
  const takerOut = (w: typeof taker1, coin: Coin, p: FillPlan): TxOutput => {
    const btcSide = p.quote.side === SELL_BTC;
    const assets = new Map((coin.assets ?? []).map(a => [a.assetId, BigInt(a.amount)]));
    assets.set(usd, (assets.get(usd) ?? 0n) + (btcSide ? -p.received : p.sold));
    return { script: w.pkScript, amount: BigInt(coin.value) + (btcSide ? p.sold : -p.received),
      assets: [...assets].filter(([, amount]) => amount > 0n).map(([assetId, amount]) => ({ assetId, amount })) };
  };
  await t.test('two makers, two takers, one transaction', async () => {
    const a = await fund(makerA, A, 100_000, 100n * USD), b = await fund(makerB, B, 50_000, 500n * USD);
    const pa = plan(A, a, sellBtc(), 30, 20_000n);                        // A sells 20 000 sats, taker1 pays USD
    const pb = plan(B, b, sellUsd(), 31, 100n * USD);                     // B sells 100 USD, taker2 pays sats
    const t1 = await usdCoin(taker1), [t2] = await satsCoins(taker2, 1, 200_000);
    const la = makerLeg(pa), lb = makerLeg(pb);
    const built = await buildTx(chain, [la.input, lb.input, walletInput(t1, taker1.identity), walletInput(t2!, taker2.identity)],
      [la.change, lb.change, takerOut(taker1, t1, pa), takerOut(taker2, t2!, pb)]);
    const { txid, result } = await submitBuilt(chain, built);
    console.log(`  2 makers + 2 takers: weight=${finalWeight(result.signedArkTx).weight}`);
    const [na, nb] = [await coinAt(chain, A.tree, txid), await coinAt(chain, B.tree, txid)];
    assert.equal(na.value, 80_000); assert.equal(usdOf(na, usd), 100n * USD + 20_000n * 100_000n);
    assert.equal(nb.value, 150_000); assert.equal(usdOf(nb, usd), 400n * USD);
  });

  await t.test('index pairing: two identical covenants cannot both count one change output', async () => {
    // Two VTXOs of the same offer (identical script). Output 0 satisfies BOTH fill checks on its
    // own (each input holds 100 000 sats + 100 USD; output 0 = 90 000 sats + 110 USD), and the
    // taker keeps the second maker's entire balance. Fixed pairing makes input 1 look at output 1.
    const a1 = await fund(makerA, A, 100_000, 100n * USD), a2 = await fund(makerA, A, 100_000, 100n * USD);
    const q = sellBtc();
    const p1 = plan(A, a1, q, 30, 10_000n), p2 = plan(A, a2, q, 30, 10_000n);
    const tc = await usdCoin(taker1);
    const change = makerLeg(p1).change;
    const stolen = { sats: 10_000n + 100_000n, usd: 100n * USD - p1.received };
    // (a) Output 1 is the taker's loot: input 1's balance arithmetic fails against it.
    await refused(async () => submitBuilt(chain, await buildTx(chain,
      [makerLeg(p1).input, makerLeg(p2).input, walletInput(tc, taker1.identity)],
      [change, { script: taker1.pkScript, amount: BigInt(tc.value) + stolen.sats, assets: [{ assetId: usd, amount: usdOf(tc, usd) + stolen.usd }] }])),
      /input 1: .*OP_VERIFY failed/);
    // (b) Output 1 is a decoy with exactly a valid change's balances but the taker's script: only
    //     the script check stands between the maker and the loss.
    const decoy: TxOutput = { ...change, script: taker1.pkScript };
    await refused(async () => submitBuilt(chain, await buildTx(chain,
      [makerLeg(p1).input, makerLeg(p2).input, walletInput(tc, taker1.identity)],
      [change, decoy, { script: taker1.pkScript, amount: BigInt(tc.value) + 20_000n, assets: [{ assetId: usd, amount: usdOf(tc, usd) - 2n * p1.received }] }])),
      /input 1: .*does not preserve source script/);
    // The honest version: each maker's change at its own index.
    const l1 = makerLeg(p1), l2 = makerLeg(p2);
    const honest: TxOutput = { script: taker1.pkScript, amount: BigInt(tc.value) + 20_000n, assets: [{ assetId: usd, amount: usdOf(tc, usd) - p1.received - p2.received }] };
    const { txid } = await submitBuilt(chain, await buildTx(chain, [l1.input, l2.input, walletInput(tc, taker1.identity)], [l1.change, l2.change, honest]));
    await waitFor(async () => (await coinsAt(chain, A.tree)).filter(c => c.txid === txid).length === 2 ? true : undefined, 'two maker changes');
  });

  await t.test('size limit: takers per maker and makers per tx vs maxTxWeight', async () => {
    const max = Number(chain.info.maxTxWeight ?? 40_000);
    const tooLarge = /TX_TOO_LARGE/;
    /** Walks n upward from `from` until arkd refuses; returns the last accepted and first refused sizes. */
    const probe = async (label: string, from: number, build: (n: number) => Promise<Awaited<ReturnType<typeof buildTx>>>) => {
      let accepted = { n: 0, weight: 0 };
      for (let n = from; ; n++) {
        try {
          const { result } = await submitBuilt(chain, await build(n));
          accepted = { n, weight: finalWeight(result.signedArkTx).weight };
          console.log(`  ${label}: n=${n} accepted at ${accepted.weight} WU`);
        } catch (e) {
          assert.match(rejectionOf(e).message, tooLarge, `expected TX_TOO_LARGE at n=${n}`);
          console.log(`  ${label}: n=${n} refused by arkd (TX_TOO_LARGE); max=${max}`);
          return { accepted, refused: n };
        }
      }
    };
    // --- N takers against one maker selling USD; every taker pays 1 000 sats from a 2 000-sat coin.
    const small = async () => (await walletCoins(chain, taker2)).filter(v => v.value >= 2_000 && v.value < 10_000);
    const ensureCoins = async (n: number) => {
      for (let have = (await small()).length; have < n; have++) await taker2.wallet.send({ address: taker2.address, amount: 2_000 });
      return waitFor(async () => { const c = await small(); return c.length >= n ? c.slice(0, n) : undefined; }, `${n} small coins`);
    };
    const perTaker = async (n: number) => {
      const coins = await ensureCoins(n);
      assert.equal(coins.length, n);
      const m = await fund(makerA, A, 20_000, 1_000n * USD);
      const p = plan(A, m, sellUsd(), 30, BigInt(n) * USD);                // 1 USD per taker = 1 000 sats
      const leg = makerLeg(p);
      const outs: TxOutput[] = [leg.change, ...coins.map(c => takerOut(taker2, c, { ...p, sold: 1n * USD, received: 1_000n }))];
      const ins: TxInput[] = [leg.input, ...coins.map(c => walletInput(c, taker2.identity))];
      return buildTx(chain, ins, outs);
    };
    const w1 = finalWeight((await submitBuilt(chain, await perTaker(1))).result.signedArkTx).weight;
    const w2 = finalWeight((await submitBuilt(chain, await perTaker(2))).result.signedArkTx).weight;
    const takerWu = w2 - w1;
    console.log(`  1 maker + 1 taker: ${w1} WU; per extra taker: ${takerWu} WU`);
    const takers = await probe('takers', Math.floor((max - (w1 - takerWu)) / takerWu), perTaker);
    assert.ok(takers.accepted.n >= 55, `expected ≥ 55 takers per tx, got ${takers.accepted.n}`);

    // --- N makers (identical offer, one 10 000-sat VTXO each, all selling BTC) against one taker paying USD.
    const makerCoins = async (n: number) => {
      const mine = async () => (await coinsAt(chain, A.tree)).filter(c => c.value === 10_000 && usdOf(c, usd) === 0n);
      for (let have = (await mine()).length; have < n; have++) await fund(makerA, A, 10_000, 0n);
      return (await mine()).slice(0, n);
    };
    const perMaker = async (n: number) => {
      const coins = await makerCoins(n);
      assert.equal(coins.length, n, 'maker VTXOs');
      const tc = await usdCoin(taker1);
      const q = sellBtc({ floor: 5_000n });
      const legs = coins.map(c => makerLeg(plan(A, c, q, 30, 1_000n)));
      const paid = legs.reduce(s => s + 1_000n * 100_000n, 0n);
      const out: TxOutput = { script: taker1.pkScript, amount: BigInt(tc.value) + 1_000n * BigInt(n), assets: [{ assetId: usd, amount: usdOf(tc, usd) - paid }] };
      return buildTx(chain, [...legs.map(l => l.input), walletInput(tc, taker1.identity)], [...legs.map(l => l.change), out]);
    };
    const m1 = finalWeight((await submitBuilt(chain, await perMaker(1))).result.signedArkTx).weight;
    const m2 = finalWeight((await submitBuilt(chain, await perMaker(2))).result.signedArkTx).weight;
    const makerWu = m2 - m1;
    console.log(`  1 maker + 1 taker: ${m1} WU; per extra maker: ${makerWu} WU (fill script ${A.fill[SELL_BTC].length} B, witness ${64 + QUOTE_LENGTH} B)`);
    const makers = await probe('makers', Math.floor((max - (m1 - makerWu)) / makerWu), perMaker);
    assert.ok(makers.accepted.n >= 18, `expected ≥ 18 makers per tx, got ${makers.accepted.n}`);
  });
});
