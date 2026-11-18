// Offline unit and property tests for the quote codec, pricing and the settlement planner. Every
// allocation is checked against the inequalities the covenants enforce on chain (DESIGN.md §4, §5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  allocate, BTC, constants, decodeQuote, encodeQuote, feeOf, hex, maxSold, minRateFor, minReceived, NotFillable, offerCovenant,
  planSettlement, quoteFromWire, quoteToWire, reduce, SELL_ASSET, SELL_BTC, signQuote, swapCovenant, termsFromWire, termsToWire,
  verifyQuote, type Coin, type Quote, type SignedQuote, type SwapTerms,
} from '../src/index.js';

// Deterministic PRNG (mulberry32), so failures reproduce.
let seed = 0x5eed;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (lo: number, hi: number) => BigInt(Math.floor(lo + rnd() * (hi - lo)));

const key = (n: number) => schnorr.getPublicKey(new Uint8Array(32).fill(n));
const chain = { server: key(1), emulatorKey: key(2), hrp: 'tark' };
const p2tr = (n: number) => Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(n)]);
const ASSET = 'ab'.repeat(32) + '0000';
const D = 330n, FEE = 30n;
const USD = 100_000_000n;

/** Maker quotes at a USD/BTC price for an 8-decimal asset (as apps/maker does). */
function quotes(ask: bigint, bid: bigint, expiry = 4_000_000_000n): Record<'sellBtc' | 'sellAsset', Quote> {
  // 8 decimals: asset units per sat equals USD per BTC. Maker sells BTC: units ≥ sats · ask;
  // maker sells the asset: sats ≥ units / bid.
  const sb = reduce({ num: ask, den: 1n });
  const sa = reduce({ num: 1n, den: bid });
  return {
    sellBtc: { side: SELL_BTC, rateNum: sb.num, rateDen: sb.den, floor: D, minFill: 1n, expiry },
    sellAsset: { side: SELL_ASSET, rateNum: sa.num, rateDen: sa.den, floor: 0n, minFill: 1n, expiry },
  };
}
const signed = (q: Quote): SignedQuote => ({ quote: q, message: encodeQuote(q), signature: new Uint8Array(64) });

function terms(sellBtc: boolean, q: Quote, slip: bigint, exactOut?: bigint): SwapTerms {
  return {
    receive: p2tr(10), refund: p2tr(11), feeScript: p2tr(12), sell: sellBtc ? BTC : ASSET, buy: sellBtc ? ASSET : BTC,
    rate: minRateFor(q, FEE, slip), feeBps: FEE, deadline: 2_000_000_000n, refundPubkey: key(3), dust: D, exitDelay: 1536n,
    ...(exactOut !== undefined ? { exactOut } : {}),
  };
}
const order = (t: SwapTerms, sats: bigint, units?: bigint) => {
  const coin: Coin = { txid: 'cd'.repeat(32), vout: 0, value: Number(sats), ...(units !== undefined ? { assets: [{ assetId: ASSET, amount: units.toString() }] } : {}) } as Coin;
  return { swap: swapCovenant(chain, t), coin };
};

test('quote codec: round trip, signature binds maker, epoch, asset and side', () => {
  const offer = { maker: key(4), epoch: 7n, asset: ASSET };
  const q = quotes(100_500n, 99_500n).sellBtc;
  assert.deepEqual(decodeQuote(SELL_BTC, encodeQuote(q)), q);
  const s = signQuote(offer, q, new Uint8Array(32).fill(4));
  assert.ok(verifyQuote(offer, SELL_BTC, s.message, s.signature));
  assert.deepEqual(quoteFromWire(offer, quoteToWire(s)).quote, q);
  assert.ok(!verifyQuote({ ...offer, epoch: 8n }, SELL_BTC, s.message, s.signature), 'other epoch');
  assert.ok(!verifyQuote({ ...offer, asset: 'cd'.repeat(32) + '0000' }, SELL_BTC, s.message, s.signature), 'other asset');
  assert.ok(!verifyQuote(offer, SELL_ASSET, s.message, s.signature), 'other side');
  assert.ok(!verifyQuote({ ...offer, maker: key(5) }, SELL_BTC, s.message, s.signature), 'other maker');
  const tampered = encodeQuote({ ...q, rateNum: q.rateNum + 1n });
  assert.throws(() => quoteFromWire(offer, { ...quoteToWire(s), message: hex(tampered) }));
});

test('pricing: min_rate is the maker rate less fee and slippage, rounded down', () => {
  const q = quotes(100_500n, 99_500n).sellAsset;
  const r = minRateFor(q, 30n, 50n);
  // User gets den/num per unit at the maker rate; min_rate is (1 − 0.3%)(1 − 0.5%) of that.
  assert.equal(r.num * q.rateNum * 100_000_000n, q.rateDen * 9_970n * 9_950n * r.den);
  assert.throws(() => minRateFor(q, 10_000n, 0n), RangeError);
  assert.throws(() => minRateFor(q, 0n, -1n), RangeError);
  assert.equal(feeOf(1n, 30n), 1n);
  assert.equal(feeOf(10_000n, 30n), 30n);
  assert.equal(minReceived(q, 3n), (3n * q.rateNum + q.rateDen - 1n) / q.rateDen);
  assert.equal(maxSold(q, 10n), 10n * q.rateDen / q.rateNum);
});

test('swap terms survive the wire format', () => {
  const t = terms(true, quotes(100_500n, 99_500n).sellAsset, 50n, 25n * USD);
  assert.deepEqual(termsFromWire(termsToWire(t)), t);
  assert.equal(swapCovenant(chain, termsFromWire(termsToWire(t))).address, swapCovenant(chain, t).address);
});

/** The on-chain inequalities for one allocation. */
function checkAllocation(t: SwapTerms, q: Quote, sats: bigint, units: bigint | undefined, a: ReturnType<typeof allocate>) {
  const { num, den } = t.rate;
  const recvUnits = BigInt(a.receive.assets?.find(x => x.assetId === ASSET)?.amount ?? 0n);
  const refundSats = a.refund?.amount ?? 0n, refundUnits = BigInt(a.refund?.assets?.[0]?.amount ?? 0n);
  assert.ok(a.receive.amount >= D, 'receive output at least dust');
  if (a.refund) assert.ok(a.refund.amount >= D, 'refund output at least dust');
  if (t.sell === BTC) {
    const spent = sats - D - refundSats - a.fee;
    // User: tokens ≥ spent·min_rate (net of fee), or exactly the exact-out amount.
    if (t.exactOut === undefined) assert.ok(recvUnits * den >= (sats - D) * num, 'user min_rate');
    else assert.equal(recvUnits, t.exactOut);
    // Maker (SELL_ASSET): sats received ≥ tokens · num / den.
    assert.equal(a.makerSats, spent);
    assert.ok(a.makerSats * q.rateDen >= recvUnits * q.rateNum, 'maker quote');
    assert.equal(a.makerAsset, -recvUnits);
    assert.equal(a.fee, feeOf(t.exactOut === undefined ? sats - D : constants(t).maxSpend!, t.feeBps), 'fee');
  } else {
    const sold = units! - refundUnits, gained = a.receive.amount - sats + (a.refund ? D : 0n);
    if (t.exactOut === undefined) assert.ok(gained * den >= units! * num, 'user min_rate');
    else assert.ok(gained >= t.exactOut, 'exact-out sats');
    // Maker (SELL_BTC): tokens received ≥ sats · num / den, for what it paid out (user + fee).
    assert.equal(a.makerAsset, sold);
    assert.ok(sold * q.rateDen >= -a.makerSats * q.rateNum, 'maker quote');
  }
}

test('allocate: random swaps satisfy both covenants or are NotFillable', () => {
  let filled = 0, refused = 0;
  for (let i = 0; i < 1_000; i++) {
    const mid = between(20_000, 200_000), spread = between(0, 200);
    const qs = quotes(mid + spread, mid - spread);
    const slip = between(0, 501), sellBtc = rnd() < 0.5, exact = rnd() < 0.5;
    const q = sellBtc ? qs.sellAsset : qs.sellBtc;
    try {
      if (sellBtc) {
        const t = terms(true, q, slip, exact ? between(1, 200) * USD / 100n : undefined);
        const sats = exact ? D + constants(t).maxSpend! + (rnd() < 0.3 ? between(0, 5_000) : 0n) : between(400, 2_000_000);
        const a = allocate(order(t, sats), signed(q), ASSET);
        checkAllocation(t, q, sats, undefined, a); filled++;
      } else {
        const t = terms(false, q, slip, exact ? between(330, 500_000) : undefined);
        const units = exact ? constants(t).maxSpend! + (rnd() < 0.3 ? between(0, 1_000_000) : 0n) : between(100_000, 1e11);
        const a = allocate(order(t, D, units), signed(q), ASSET);
        checkAllocation(t, q, D, units, a); filled++;
      }
    } catch (e) {
      if (e instanceof NotFillable || /too small|at least dust/.test((e as Error).message)) { refused++; continue; }
      throw e;
    }
  }
  assert.ok(filled > 750, `most random swaps fill (${filled} filled, ${refused} refused)`);
});

test('allocate: refuses wrong side, wrong asset, a worse quote and an exact-out remainder below dust', () => {
  const qs = quotes(100_500n, 99_500n);
  const t = terms(true, qs.sellAsset, 50n);
  assert.throws(() => allocate(order(t, 100_000n), signed(qs.sellBtc), ASSET), /side/);
  assert.throws(() => allocate(order(t, 100_000n), signed(qs.sellAsset), 'cd'.repeat(32) + '0000'), /asset/);
  // The maker now bids 1% lower than the swap was priced at with 0.5% slippage.
  assert.throws(() => allocate(order(t, 100_000n), signed(quotes(100_500n, 98_500n).sellAsset), ASSET), /min_rate/);
  assert.throws(() => allocate(order(t, D), signed(qs.sellAsset), ASSET), /dust/);
  const xo = terms(true, qs.sellAsset, 50n, 25n * USD);
  // Over-paying by less than dust: the covenant demands the excess back, arkd a dust-sized output.
  assert.throws(() => allocate(order(xo, D + constants(xo).maxSpend! + 100n), signed(qs.sellAsset), ASSET), /below dust/);
});

test('planSettlement: layout, conservation and the maker floor', () => {
  const qs = quotes(100_500n, 99_500n);
  const maker = key(20);
  const offer = offerCovenant(chain, { maker, epoch: 1n, asset: ASSET, exitSeconds: 1536n,
    renew: { cosigner: hex(Uint8Array.from([2, ...key(21)])), delegateKey: key(21), window: 518_656n } });
  const q = qs.sellBtc;
  // Users sell USD for BTC; one exact-out with token change.
  const orders = [
    order(terms(false, q, 50n), D, 40n * USD),
    order(terms(false, q, 50n, 10_000n), D, 20n * USD),
    order(terms(false, q, 50n), D, 15n * USD),
  ];
  const makerCoin = { txid: 'ef'.repeat(32), vout: 1, value: 1_000_000, assets: [{ assetId: ASSET, amount: String(1_000n * USD) }] } as Coin;
  const { settlement, skipped } = planSettlement(orders, { offer, coin: makerCoin, quote: signed(q) }, p2tr(12), D);
  assert.equal(skipped.length, 0);
  const s = settlement!, n = s.filled.length;
  assert.equal(s.inputs.length, n + 1);
  assert.equal(s.outputs[n], s.makerChange, 'maker change at index s');
  s.filled.forEach((o, i) => {
    assert.equal(s.outputs[i], o.allocation.receive, 'receive i at i');
    if (o.allocation.refund) assert.equal(s.outputs[i + n + 1], o.allocation.refund, 'refund i at s+1+i');
  });
  // Refund-carrying swaps come first.
  const firstPlain = s.filled.findIndex(o => !o.allocation.refund);
  assert.ok(s.filled.slice(firstPlain === -1 ? n : firstPlain).every(o => !o.allocation.refund));
  const satsIn = s.inputs.reduce((x, i) => x + BigInt(i.coin.value), 0n), satsOut = s.outputs.reduce((x, o) => x + o.amount, 0n);
  assert.equal(satsOut, satsIn, 'sats conserved');
  const unitsIn = s.inputs.reduce((x, i) => x + BigInt(i.coin.assets?.find(a => a.assetId === ASSET)?.amount ?? 0), 0n);
  const unitsOut = s.outputs.reduce((x, o) => x + BigInt(o.assets?.find(a => a.assetId === ASSET)?.amount ?? 0n), 0n);
  assert.equal(unitsOut, unitsIn, 'asset conserved');
  assert.equal(s.outputs.at(-1)!.amount, s.fee, 'fee output last');

  // A maker with too few sats: orders drop from the end until its floor holds.
  const poor = { ...makerCoin, value: 30_000 } as Coin;
  const r = planSettlement(orders, { offer, coin: poor, quote: signed(q) }, p2tr(12), D);
  assert.ok(r.skipped.length > 0 && r.skipped.every(x => /floor|balance/.test(x.reason)));
  if (r.settlement) assert.ok(r.settlement.makerChange.amount >= q.floor);
});

test('rounding: 0% slippage fills only when the fee divides; 0.1% fills realistic sizes', () => {
  const q = quotes(100_500n, 99_500n).sellAsset;
  const fills = (slip: bigint, sats: bigint) => { try { allocate(order(terms(true, q, slip), sats), signed(q), ASSET); return true; } catch { return false; } };
  // The fee rounds up and the maker's payout down, both against the user.
  assert.equal(fills(0n, 100_000n), false);
  assert.equal(fills(0n, D + 100_000n), true, 'fee of exactly 300 sats');
  for (const sats of [20_000n, 50_000n, 100_000n, 1_234_567n]) assert.ok(fills(10n, sats), `${sats} at 0.1%`);
});
