// From a maker quote to the swap terms Striker offers a user (DESIGN.md §5).
import type { Quote } from './quote.js';

const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };
export const reduce = (r: { num: bigint; den: bigint }) => { const g = gcd(r.num, r.den); return { num: r.num / g, den: r.den / g }; };

/**
 * The user's min_rate, net of fee and slippage, in buy units per sell unit. Whichever side the
 * maker sells, the user gets `rate_den / rate_num` of it per unit the maker receives:
 * min_rate = maker_rate × (1 − fee) × (1 − slippage).
 */
export function minRateFor(q: Pick<Quote, 'rateNum' | 'rateDen'>, feeBps: bigint, slippageBps: bigint) {
  if (feeBps < 0n || feeBps >= 10_000n || slippageBps < 0n || slippageBps >= 10_000n) throw new RangeError('bps out of range');
  return reduce({ num: q.rateDen * (10_000n - feeBps) * (10_000n - slippageBps), den: q.rateNum * 100_000_000n });
}

/** The maker's rate, as the user sees it: buy units per sell unit before fee. */
export const userRate = (q: Quote) => Number(q.rateDen) / Number(q.rateNum);
