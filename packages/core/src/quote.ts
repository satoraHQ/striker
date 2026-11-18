// Signed quote (DESIGN.md §3). 40 bytes: five u63 LE fields. Maker key, epoch, traded asset and
// side live in the BIP340 tag, so a quote verifies only against the one Fill leaf it was signed for.
import { asset } from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, hex, invariant, readU64, u64, unhex, utf8 } from './util.js';

export const QUOTE_TAG = 'striker/quote/v2';
export const QUOTE_LENGTH = 40;
/** Which asset the maker sells. Each side is its own Fill leaf. */
export const SELL_BTC = 0, SELL_ASSET = 1;
export type Side = typeof SELL_BTC | typeof SELL_ASSET;

/**
 *   [0,8)    rate_num     buy ≥ sell × rate_num / rate_den
 *   [8,16)   rate_den
 *   [16,24)  floor        change sell-side balance ≥ floor
 *   [24,32)  min_fill     sold ≥ min_fill
 *   [32,40)  expiry       unix seconds; valid while expiry > emulator time
 */
export const OFF = { rateNum: 0, rateDen: 8, floor: 16, minFill: 24, expiry: 32 } as const;

export interface Quote { side: Side; rateNum: bigint; rateDen: bigint; floor: bigint; minFill: bigint; expiry: bigint }
/** What the signature tag binds a quote to. `asset` is the SDK asset id string. */
export interface QuoteContext { maker: Uint8Array; epoch: bigint; asset: string }

export const assetBytes = (id: string) => asset.AssetId.fromString(id).serialize();

/** `"striker/quote/v2" ‖ maker(32) ‖ epoch(u64 LE) ‖ asset(34) ‖ side(1)`. */
export function quoteTag(ctx: QuoteContext, side: Side): Uint8Array {
  invariant(ctx.maker.length === 32, 'maker key must be x-only');
  const id = assetBytes(ctx.asset);
  invariant(id.length === 34, 'asset id must serialize to 34 bytes');
  return concat(utf8(QUOTE_TAG), ctx.maker, u64(ctx.epoch), id, Uint8Array.of(side));
}
export const quoteTagHash = (ctx: QuoteContext, side: Side) => sha256(quoteTag(ctx, side));

export function encodeQuote(q: Quote): Uint8Array {
  if (q.rateNum <= 0n || q.rateDen <= 0n || q.minFill <= 0n) throw new RangeError('rate and min_fill must be positive');
  return concat(u64(q.rateNum), u64(q.rateDen), u64(q.floor), u64(q.minFill), u64(q.expiry));
}
export function decodeQuote(side: Side, m: Uint8Array): Quote {
  invariant(m.length === QUOTE_LENGTH, 'quote must be 40 bytes');
  const q: Quote = { side, rateNum: readU64(m, OFF.rateNum), rateDen: readU64(m, OFF.rateDen), floor: readU64(m, OFF.floor),
    minFill: readU64(m, OFF.minFill), expiry: readU64(m, OFF.expiry) };
  encodeQuote(q); // range checks, same as the Fill leaf
  return q;
}

const quoteHash = (ctx: QuoteContext, side: Side, m: Uint8Array) => { const h = quoteTagHash(ctx, side); return sha256(concat(h, h, m)); };
export function signQuote(ctx: QuoteContext, q: Quote, secret: Uint8Array): SignedQuote {
  const message = encodeQuote(q);
  return { quote: q, message, signature: schnorr.sign(quoteHash(ctx, q.side, message), secret) };
}
export const verifyQuote = (ctx: QuoteContext, side: Side, m: Uint8Array, sig: Uint8Array) => schnorr.verify(sig, quoteHash(ctx, side, m), ctx.maker);

export interface SignedQuote { quote: Quote; message: Uint8Array; signature: Uint8Array }

/** Wire form (JSON): hex message and signature, side as a number. */
export interface QuoteWire { side: Side; message: string; signature: string }
export const quoteToWire = (q: SignedQuote): QuoteWire => ({ side: q.quote.side, message: hex(q.message), signature: hex(q.signature) });
export function quoteFromWire(ctx: QuoteContext, w: QuoteWire): SignedQuote {
  if (w.side !== SELL_BTC && w.side !== SELL_ASSET) throw new Error('bad side');
  const message = unhex(w.message), signature = unhex(w.signature);
  if (!verifyQuote(ctx, w.side, message, signature)) throw new Error('bad quote signature');
  return { quote: decodeQuote(w.side, message), message, signature };
}

/** Smallest `received` satisfying the quote for `sold` (rounded up: maker's favour). */
export const minReceived = (q: Quote, sold: bigint) => (sold * q.rateNum + q.rateDen - 1n) / q.rateDen;
/** Largest `sold` the quote allows for `received` (rounded down: maker's favour). */
export const maxSold = (q: Quote, received: bigint) => received * q.rateDen / q.rateNum;
