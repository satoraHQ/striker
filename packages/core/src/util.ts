import { base64, hex as hexCoder } from '@scure/base';

export const hex = (b: Uint8Array) => hexCoder.encode(b);
export const unhex = (s: string) => hexCoder.decode(s);
export const b64 = (b: Uint8Array) => base64.encode(b);
export const unb64 = (s: string) => base64.decode(s);
export const utf8 = (s: string) => new TextEncoder().encode(s);

export const MAX_U63 = (1n << 63n) - 1n;

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** u64 little endian, restricted to < 2^63 (BIN2NUM reads a set top bit as a sign). */
export function u64(v: bigint): Uint8Array {
  if (v < 0n || v > MAX_U63) throw new RangeError(`u63 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
export function readU64(b: Uint8Array, off: number): bigint {
  return new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, true);
}

export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Fee in sats: ceil(base · bps / 10 000), as the swap covenant computes it. */
export const feeOf = (base: bigint, bps: bigint) => ceilDiv(base * bps, 10_000n);
export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);

export const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export class Invariant extends Error {}
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Invariant(message);
}

export const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));
