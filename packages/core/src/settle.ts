// Settlement planner: fills swap-covenant deposits against one maker offer VTXO in one tx.
//
// Layout for s swaps (each needs the maker's quote side) and one maker input:
//   inputs   0..s-1 swap deposits (those that need a refund output first), s maker offer VTXO
//   outputs  i < s receive of swap i · s maker change (paired with the maker input) ·
//            s+1+i refund of swap i (i + n, n = s + 1) · fee (one output, sub-dust form below dust)
// Each amount mirrors the covenant arithmetic: the swap covenant's min_rate (net of fee) and
// the offer covenant's signed quote. The planner refuses rather than build a tx the emulator
// would reject.
import { ScriptNum } from '@scure/btc-signer';
import type { Offer } from './offer.js';
import { maxSold, minReceived, SELL_ASSET, SELL_BTC, type SignedQuote } from './quote.js';
import { BTC, constants, subdustScript, SWAP_LEAF, type Swap } from './swap.js';
import { assetAmount, type Coin, type TxInput, type TxOutput } from './tx.js';
import { feeOf, invariant } from './util.js';

export class NotFillable extends Error {}

export interface SwapOrder { swap: Swap; coin: Coin }
export interface MakerLeg { offer: Offer; coin: Coin; quote: SignedQuote }

/** One swap's share of a settlement. Maker deltas are signed: + received, − sold. */
export interface Allocation {
  receive: TxOutput; refund?: TxOutput; fee: bigint;
  makerSats: bigint; makerAsset: bigint;
}

/** The maker quote side a swap fills against: a BTC deposit buys the maker's asset. */
export const makerSideFor = (swap: Swap) => swap.terms.sell === BTC ? SELL_ASSET : SELL_BTC;

/** What a swap receives and pays at the maker's quoted rate, or NotFillable. */
export function allocate(order: SwapOrder, quote: SignedQuote, offerAsset: string): Allocation {
  const t = order.swap.terms, q = quote.quote, D = t.dust, m = t.rate;
  const S = BigInt(order.coin.value);
  if (q.side !== makerSideFor(order.swap)) throw new NotFillable('quote side does not match the swap direction');
  const tokenId = t.sell === BTC ? t.buy : t.sell;
  if (tokenId !== offerAsset) throw new NotFillable('swap asset differs from the offer asset');
  const c = constants(t);
  const assets = order.coin.assets ?? [];

  if (t.sell === BTC) {
    if (assets.length) throw new NotFillable('BTC deposit carries an asset');
    if (t.exactOut === undefined) {
      const A = S - D;
      if (A <= 0n) throw new NotFillable('deposit at or below dust');
      const fee = feeOf(A, t.feeBps), makerSats = A - fee;
      const tokens = maxSold(q, makerSats);
      if (tokens * m.den < A * m.num) throw new NotFillable('maker rate below min_rate');
      return { receive: { script: t.receive, amount: D, assets: [{ assetId: tokenId, amount: tokens }] }, fee, makerSats, makerAsset: -tokens };
    }
    const W = t.exactOut, fee = c.fee!, need = minReceived(q, W);
    const spare = S - D - fee - need, owed = S - D - c.maxSpend!;
    if (spare < 0n) throw new NotFillable('deposit too small at the maker rate');
    let refund = 0n;
    if (owed > 0n) {
      // The covenant demands a refund of at least `owed`, and arkd an output of at least dust.
      if (spare < owed || spare < D) throw new NotFillable('remainder below dust; deposit the quoted amount');
      refund = spare;
    } else if (spare >= D) refund = spare; // price improvement back to the user; below dust it stays with the maker
    return {
      receive: { script: t.receive, amount: D, assets: [{ assetId: tokenId, amount: W }] },
      ...(refund > 0n ? { refund: { script: t.refund, amount: refund } } : {}),
      fee, makerSats: S - D - fee - refund, makerAsset: -W,
    };
  }

  if (assets.length !== 1) throw new NotFillable('asset deposit must carry exactly the sell asset');
  const U = assetAmount(order.coin, tokenId);
  if (U <= 0n) throw new NotFillable('no asset deposited');
  if (t.exactOut === undefined) {
    const fee = feeOf(U * m.num / m.den, t.feeBps);
    const user = maxSold(q, U) - fee;
    if (user <= 0n || user * m.den < U * m.num) throw new NotFillable('maker rate below min_rate');
    return { receive: { script: t.receive, amount: S + user }, fee, makerSats: -(user + fee), makerAsset: U };
  }
  const W = t.exactOut, fee = c.fee!, maxSpend = c.maxSpend!;
  if (U > maxSpend) {
    // Covenant branch: the user's carrier moves to the token change at i + n.
    const sold = minReceived(q, W + fee);
    if (sold > maxSpend) throw new NotFillable('maker rate below min_rate');
    return { receive: { script: t.receive, amount: S - D + W }, refund: { script: t.refund, amount: D, assets: [{ assetId: tokenId, amount: U - sold }] },
      fee, makerSats: -(W + fee), makerAsset: sold };
  }
  // No refund required. Return unsold tokens only if they pay for the dust the maker adds.
  const soldWithChange = minReceived(q, W + fee + D);
  if (soldWithChange < U)
    return { receive: { script: t.receive, amount: S + W }, refund: { script: t.refund, amount: D, assets: [{ assetId: tokenId, amount: U - soldWithChange }] },
      fee, makerSats: -(W + fee + D), makerAsset: soldWithChange };
  if (U < minReceived(q, W + fee)) throw new NotFillable('maker rate below min_rate');
  return { receive: { script: t.receive, amount: S + W }, fee, makerSats: -(W + fee), makerAsset: U };
}

export interface Settlement {
  inputs: TxInput[]; outputs: TxOutput[];
  /** Orders in input order, with their allocation. */
  filled: (SwapOrder & { allocation: Allocation })[];
  makerChange: TxOutput;
  fee: bigint;
}

/** Plans one tx filling `orders` against `maker`. Orders that can't fill at the maker's rate are
 * dropped into `skipped` (the caller retries them or lets them refund). */
export function planSettlement(orders: SwapOrder[], maker: MakerLeg, feeScript: Uint8Array, dust: bigint):
  { settlement?: Settlement; skipped: { order: SwapOrder; reason: string }[] } {
  const skipped: { order: SwapOrder; reason: string }[] = [];
  const ok: (SwapOrder & { allocation: Allocation })[] = [];
  for (const order of orders) {
    try { ok.push({ ...order, allocation: allocate(order, maker.quote, maker.offer.asset) }); }
    catch (e) { if (e instanceof NotFillable) skipped.push({ order, reason: e.message }); else throw e; }
  }
  if (!ok.length) return { skipped };

  // The maker's leg must satisfy its quote in aggregate: sold ≥ min_fill, sell-side change ≥ floor.
  const q = maker.quote.quote, id = maker.offer.asset;
  const satsIn = BigInt(maker.coin.value), assetIn = assetAmount(maker.coin, id);
  // Drop orders from the end until the maker's balances and floor hold.
  const fits = (set: typeof ok) => {
    const dS = set.reduce((s, o) => s + o.allocation.makerSats, 0n), dA = set.reduce((s, o) => s + o.allocation.makerAsset, 0n);
    const sats = satsIn + dS, tokens = assetIn + dA;
    const sold = q.side === SELL_BTC ? -dS : -dA, sellBal = q.side === SELL_BTC ? sats : tokens;
    return sats >= dust && tokens >= 0n && sellBal >= q.floor && sold >= q.minFill ? { sats, tokens } : undefined;
  };
  let balances = fits(ok);
  while (!balances && ok.length) {
    const dropped = ok.pop()!;
    skipped.push({ order: dropped, reason: 'maker balance, floor or min_fill' });
    balances = ok.length ? fits(ok) : undefined;
  }
  if (!balances) return { skipped };

  // Swaps that need a refund output first, so refunds sit contiguously at s+1..
  ok.sort((a, b) => Number(!!b.allocation.refund) - Number(!!a.allocation.refund));
  const s = ok.length, n = s + 1;
  const otherAssets = (maker.coin.assets ?? []).filter(a => a.assetId !== id).map(a => ({ assetId: a.assetId, amount: BigInt(a.amount) }));
  const makerChange: TxOutput = { script: maker.offer.tree.pkScript, amount: balances.sats,
    assets: [...(balances.tokens > 0n ? [{ assetId: id, amount: balances.tokens }] : []), ...otherAssets] };
  const fee = ok.reduce((sum, o) => sum + o.allocation.fee, 0n);
  const refunds = ok.filter(o => o.allocation.refund).map(o => o.allocation.refund!);
  const outputs: TxOutput[] = [...ok.map(o => o.allocation.receive), makerChange, ...refunds];
  const feeIndex = outputs.length;
  if (fee > 0n) outputs.push({ script: fee < dust ? subdustScript(feeScript) : feeScript, amount: fee });
  ok.forEach((o, i) => { if (o.allocation.refund) invariant(outputs[i + n] === o.allocation.refund, 'refund pairing'); });

  const inputs: TxInput[] = [
    ...ok.map(o => {
      const sw = o.swap, leaf = sw.tree.leaves[SWAP_LEAF.fill]!;
      if (sw.terms.feeBps > 0n) invariant(fee > 0n && sw.terms.feeScript.every((b, j) => b === feeScript[j]), 'fee script');
      return { coin: o.coin, tapTree: sw.tree.encode(), tapLeafScript: leaf, script: sw.fill,
        witness: sw.terms.feeBps > 0n ? [ScriptNum().encode(BigInt(feeIndex))] : [] };
    }),
    { coin: maker.coin, tapTree: maker.offer.tree.encode(), tapLeafScript: maker.offer.tree.leaves[q.side]!,
      script: maker.offer.fill[q.side], witness: [maker.quote.signature, maker.quote.message] },
  ];
  return { settlement: { inputs, outputs, filled: ok, makerChange, fee }, skipped };
}

/** Refund-anyone spend after the deadline: the whole coin goes to the refund script. */
export function refundInput(swap: Swap, coin: Coin): { input: TxInput; output: TxOutput } {
  return {
    input: { coin, tapTree: swap.tree.encode(), tapLeafScript: swap.tree.leaves[SWAP_LEAF.refundAnyone]!, script: swap.refund, witness: [] },
    output: { script: swap.terms.refund, amount: BigInt(coin.value),
      assets: (coin.assets ?? []).map(a => ({ assetId: a.assetId, amount: BigInt(a.amount) })) },
  };
}
