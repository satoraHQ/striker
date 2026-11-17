// v2 offer covenant (DESIGN.md §3, §4): signed quotes, the fill/owner/exit leaves, and a
// generic builder for fill transactions mixing covenant inputs and plain wallet inputs.
import assert from 'node:assert/strict';
import { arkade, asset, buildOffchainTx, EmulatorPacket, Extension, Transaction, VtxoScript,
  type ArkTxInput, type ExtendedVirtualCoin, type SingleKey, type TapLeafScript, type VirtualCoin } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { coinsAt, covenantLeaf, exitLeaf, fundedWallet, issueDemoUsd, ownerLeaf, submitToArkd, walletCoins, type Chain, type TestWallet } from './harness.js';

type Ops = Parameters<typeof arkade.ArkadeScript.encode>[0];

// ---------------------------------------------------------------- quote (§3)

/** BTC is the all-zero 34-byte asset id. Demo USD is its serialized asset id (txid ‖ u16 LE gidx). */
export const BTC = new Uint8Array(34);
export const QUOTE_TAG = 'striker/quote/v2';
export const MAX_U63 = (1n << 63n) - 1n;

/** Which asset the maker sells. Each side is its own Fill leaf, so the side is bound by the
 * leaf's tag hash rather than by a field in the quote. */
export const SELL_BTC = 0, SELL_USD = 1;
export type Side = typeof SELL_BTC | typeof SELL_USD;

/**
 * Quote byte layout (40 bytes, every integer u64 LE < 2^63 so BIN2NUM reads it as positive):
 *   [0,8)    rate_num     buy ≥ sell × rate_num / rate_den
 *   [8,16)   rate_den
 *   [16,24)  floor        change sell-side balance ≥ floor
 *   [24,32)  min_fill     sold ≥ min_fill
 *   [32,40)  expiry       unix seconds; valid while expiry > emulator time
 * Everything that identifies the covenant — protocol version, maker key, epoch, the USD asset
 * and the side — is in the BIP340 tag instead (`quoteTag`), so a quote verifies only against
 * the one Fill leaf it was signed for and costs nothing in the message.
 */
export const OFF = { rateNum: 0, rateDen: 8, floor: 16, minFill: 24, expiry: 32 } as const;
export const QUOTE_LENGTH = 40;

export interface Quote { side: Side; rateNum: bigint; rateDen: bigint; floor: bigint; minFill: bigint; expiry: bigint }
/** What the signature tag binds a quote to: one maker key, one epoch, one demo-USD asset. */
export interface QuoteContext { maker: Uint8Array; epoch: bigint; usd: string | Uint8Array }

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function u64(v: bigint): Uint8Array {
  if (v < 0n || v > MAX_U63) throw new RangeError(`u63 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
export const assetBytes = (id: string | Uint8Array) => typeof id === 'string' ? asset.AssetId.fromString(id).serialize() : id;

/** `"striker/quote/v2" ‖ maker(32) ‖ epoch(u64 LE) ‖ usd_asset(34) ‖ side(1)`. */
export function quoteTag(ctx: QuoteContext, side: Side): Uint8Array {
  assert.equal(ctx.maker.length, 32);
  const usd = assetBytes(ctx.usd);
  assert.equal(usd.length, 34);
  return concat(new TextEncoder().encode(QUOTE_TAG), ctx.maker, u64(ctx.epoch), usd, Uint8Array.of(side));
}
/** SHA256(tag): the one 32-byte constant the Fill leaf carries for the hash. */
export const quoteTagHash = (ctx: QuoteContext, side: Side) => sha256(quoteTag(ctx, side));

export function encodeQuote(q: Quote): Uint8Array {
  if (q.rateNum <= 0n || q.rateDen <= 0n || q.minFill <= 0n) throw new RangeError('rate and min_fill must be positive');
  const m = concat(u64(q.rateNum), u64(q.rateDen), u64(q.floor), u64(q.minFill), u64(q.expiry));
  assert.equal(m.length, QUOTE_LENGTH);
  return m;
}
/** BIP340 tagged hash: SHA256(SHA256(tag) ‖ SHA256(tag) ‖ quote). */
export const quoteHash = (ctx: QuoteContext, side: Side, m: Uint8Array) => { const h = quoteTagHash(ctx, side); return sha256(concat(h, h, m)); };
export function signQuote(ctx: QuoteContext, q: Quote, secret: Uint8Array): { message: Uint8Array; signature: Uint8Array } {
  const message = encodeQuote(q);
  return { message, signature: schnorr.sign(quoteHash(ctx, q.side, message), secret) };
}
export const verifyQuote = (ctx: QuoteContext, side: Side, m: Uint8Array, sig: Uint8Array) => schnorr.verify(sig, quoteHash(ctx, side, m), ctx.maker);

// ------------------------------------------------------------- covenant (§4)

/** Pushes `asset_txid asset_gidx` for the asset opcodes. The VM wants the txid in internal
 * (byte-reversed) order relative to the SDK's serialized asset id; verified on regtest. */
function assetOps(id34: Uint8Array): Ops {
  const gidx = new DataView(id34.buffer, id34.byteOffset + 32, 2).getUint16(0, true);
  return [id34.slice(0, 32).reverse(), gidx];
}
/** Reads an 8-byte quote field as a number; expects the quote on top, keeps it. */
const num = (off: number): Ops => ['DUP', off, 8, 'SUBSTR', 'BIN2NUM'];
const sats = (op: 'INSPECTINPUTVALUE' | 'INSPECTOUTPUTVALUE'): Ops => ['PUSHCURRENTINPUTINDEX', op];
/** USD balance of this input/output. The asset id lives on the altstack as [gidx txid] (txid on
 * top); it is pulled, copied back, and consumed by the lookup. 0 when the asset is absent. */
const usd = (op: 'INSPECTINASSETLOOKUP' | 'INSPECTOUTASSETLOOKUP'): Ops =>
  ['FROMALTSTACK', 'FROMALTSTACK', '2DUP', 'TOALTSTACK', 'TOALTSTACK', 'PUSHCURRENTINPUTINDEX', 'ROT', 'ROT', op, 'DROP'];

/**
 * One-direction Fill leaf. Witness: [signature, quote]. Change is at the output whose index
 * equals this input's index. Balance deltas are measured on this input/output pair only, so the
 * covenant never looks at taker outputs. Maker key, epoch, asset and side are bound through the
 * tag hash constant: a quote for another epoch, asset or side fails the signature check.
 */
export function fillScript(ctx: QuoteContext, side: Side): Uint8Array {
  const [sellIn, sellOut, buyIn, buyOut] = side === SELL_BTC
    ? [sats('INSPECTINPUTVALUE'), sats('INSPECTOUTPUTVALUE'), usd('INSPECTINASSETLOOKUP'), usd('INSPECTOUTASSETLOOKUP')]
    : [usd('INSPECTINASSETLOOKUP'), usd('INSPECTOUTASSETLOOKUP'), sats('INSPECTINPUTVALUE'), sats('INSPECTOUTPUTVALUE')];
  return arkade.ArkadeScript.encode([
    // --- offchain only: an intent proof must never satisfy this leaf (see the emulator findings in
    //     README.md: a proof co-signed before expiry can be registered in a batch after it).
    new TextEncoder().encode('type'), 'INSPECTINTENTMESSAGE', 'NOT', 'VERIFY', 'DROP',
    // --- quote authenticity: BIP340 over tagged_hash(tag, quote); SHA256(tag) pushed once, doubled with CAT
    'DUP', 'TOALTSTACK', quoteTagHash(ctx, side), 'DUP', 'CAT', 'SWAP', 'CAT', 'SHA256', ctx.maker, 'CHECKSIGFROMSTACK', 'VERIFY',
    'FROMALTSTACK', 'SIZE', QUOTE_LENGTH, 'EQUALVERIFY',                                   // [q]
    ...num(OFF.expiry), 'CHECKTIME', 'NOT', 'VERIFY',                                      // valid only before expiry
    ...assetOps(assetBytes(ctx.usd)), 'TOALTSTACK', 'TOALTSTACK',                           // USD id parked on the altstack
    // --- sold = sell_in − sell_out, with the floor on the sell-side change balance
    ...sellIn, ...sellOut, 'TUCK', 'SUB',                                                   // [q sell_out sold]
    'SWAP', 2, 'PICK', OFF.floor, 8, 'SUBSTR', 'BIN2NUM', 'GREATERTHANOREQUAL', 'VERIFY',    // sell_out ≥ floor      → [q sold]
    'DUP', 2, 'PICK', OFF.minFill, 8, 'SUBSTR', 'BIN2NUM', 'GREATERTHANOREQUAL', 'VERIFY',   // sold ≥ min_fill
    // --- received = buy_out − buy_in, then received × rate_den ≥ sold × rate_num (maker's favour)
    ...buyOut, ...buyIn, 'SUB',                                                             // [q sold received]
    'ROT', ...num(OFF.rateDen), 'ROT', 'MUL',                                               // [sold q received×den]
    'SWAP', OFF.rateNum, 8, 'SUBSTR', 'BIN2NUM', 'ROT', 'MUL',                              // [received×den sold×num]
    'GREATERTHANOREQUAL', 'VERIFY',
    // --- change keeps this exact script (same covenant, same epoch) and every non-USD asset.
    'PUSHCURRENTINPUTINDEX', 5, 'FROMALTSTACK', 'FROMALTSTACK', 1, 'TUNNEL',
  ]);
}

export interface Offer extends QuoteContext {
  usd: string;
  /** Fill scripts by side: `fill[SELL_BTC]`, `fill[SELL_USD]`. */
  fill: [Uint8Array, Uint8Array];
  tree: VtxoScript; address: string;
}
/** Leaf index of each spend path in the offer tree. */
export const LEAF = { sellBtc: 0, sellUsd: 1, owner: 2, exit: 3 } as const;
/** Leaves: 0 fill sell-BTC, 1 fill sell-USD (server + emulator⊕script), 2 owner (maker + server), 3 exit (maker, CSV seconds). */
export function offerTree(chain: Chain, maker: Uint8Array, epoch: bigint, usd: string, exitSeconds = 1536n): Offer {
  const ctx = { maker, epoch, usd };
  const fill: [Uint8Array, Uint8Array] = [fillScript(ctx, SELL_BTC), fillScript(ctx, SELL_USD)];
  const tree = new VtxoScript([...fill.map(s => covenantLeaf(chain, s)), ownerLeaf(chain, maker), exitLeaf(maker, exitSeconds)]);
  return { ...ctx, fill, tree, address: tree.address('tark', chain.server).encode() };
}

// ------------------------------------------------------------ tx builder

export interface Coin extends Pick<VirtualCoin, 'txid' | 'vout' | 'value'> { assets?: { assetId: string; amount: string | number | bigint }[] }
export interface TxInput {
  coin: Coin;
  tapTree: Uint8Array; tapLeafScript: TapLeafScript;
  /** Covenant inputs: Arkade script + witness stack. */
  script?: Uint8Array; witness?: Uint8Array[];
  /** Plain wallet inputs: who signs the ark tx input and its checkpoint. */
  signer?: SingleKey;
  /** Override the declared input assets (default: the coin's). */
  assets?: { assetId: string; amount: bigint }[];
}
export function covenantInput(coin: Coin, tree: VtxoScript, script: Uint8Array, witness: Uint8Array[], leaf = 0): TxInput {
  const tapLeafScript = tree.leaves[leaf];
  if (!tapLeafScript) throw new Error('Missing spend leaf');
  return { coin, tapTree: tree.encode(), tapLeafScript, script, witness };
}
/** A plain wallet VTXO spent through its forfeit (owner + server) leaf, signed by `signer`. */
export function walletInput(coin: ExtendedVirtualCoin, signer: SingleKey): TxInput {
  return { coin, tapTree: coin.tapTree, tapLeafScript: coin.forfeitTapLeafScript, signer };
}
/** The owner leaf of a covenant VTXO (maker + server), signed by the maker. */
export function ownerInput(coin: Coin, tree: VtxoScript, signer: SingleKey): TxInput {
  return { coin, tapTree: tree.encode(), tapLeafScript: tree.leaves[LEAF.owner]!, signer };
}
export interface TxOutput { script: Uint8Array; amount: bigint; assets?: { assetId: string; amount: bigint }[] }

export function assetPacket(inputs: TxInput[], outputs: TxOutput[]): asset.Packet | undefined {
  const groups = new Map<string, { ins: asset.AssetInput[]; outs: asset.AssetOutput[] }>();
  const g = (id: string) => groups.get(id) ?? groups.set(id, { ins: [], outs: [] }).get(id)!;
  inputs.forEach((inp, vin) => { for (const a of inp.assets ?? inp.coin.assets ?? []) g(a.assetId).ins.push(asset.AssetInput.create(vin, BigInt(a.amount))); });
  outputs.forEach((out, vout) => { for (const a of out.assets ?? []) g(a.assetId).outs.push(asset.AssetOutput.create(vout, a.amount)); });
  if (groups.size === 0) return undefined;
  return asset.Packet.create([...groups].map(([id, { ins, outs }]) => asset.AssetGroup.create(asset.AssetId.fromString(id), null, ins, outs, [])));
}

/** Builds the ark tx + checkpoints, appends the asset/emulator extension, signs wallet inputs. */
export async function buildTx(chain: Chain, inputs: TxInput[], outputs: TxOutput[]) {
  const packets: Parameters<typeof Extension.create>[0] = [];
  const assets = assetPacket(inputs, outputs);
  if (assets) packets.push(assets);
  const entries = inputs.flatMap((inp, vin) => inp.script ? [{ vin, script: inp.script, witness: RawWitness.encode(inp.witness ?? []) }] : []);
  if (entries.length) packets.push(EmulatorPacket.create(entries));
  const arkInputs: ArkTxInput[] = inputs.map(inp =>
    ({ txid: inp.coin.txid, vout: inp.coin.vout, value: inp.coin.value, tapTree: inp.tapTree, tapLeafScript: inp.tapLeafScript }));
  let { arkTx, checkpoints } = buildOffchainTx(arkInputs, [
    ...outputs.map(o => ({ script: o.script, amount: o.amount })),
    ...(packets.length ? [Extension.create(packets).txOut()] : []),
  ], chain.checkpoint);
  for (const [vin, inp] of inputs.entries()) {
    if (!inp.signer) continue;
    arkTx = await inp.signer.sign(arkTx, [vin]);
    checkpoints[vin] = await inp.signer.sign(checkpoints[vin]!, [0]);
  }
  return { arkTx, checkpoints, prevTxids: inputs.map(i => i.coin.txid) };
}

// ------------------------------------------------------------ fill helper

export interface FillPlan {
  offer: Offer; coin: Coin; quote: Quote; signature: Uint8Array; message: Uint8Array;
  /** Maker sells `sold` of the quote's sell side and receives `received` of the other asset. */
  sold: bigint; received: bigint;
}
export const usdOf = (coin: Coin, usd: string) => BigInt(coin.assets?.find(a => a.assetId === usd)?.amount ?? 0);

/** Maker input (the Fill leaf of the quote's side) + its paired change output, with the payment folded into the change. */
export function makerLeg(p: FillPlan): { input: TxInput; change: TxOutput } {
  const sats = BigInt(p.coin.value), usd = usdOf(p.coin, p.offer.usd);
  const sellBtc = p.quote.side === SELL_BTC;
  const satsOut = sellBtc ? sats - p.sold : sats + p.received;
  const usdOut = sellBtc ? usd + p.received : usd - p.sold;
  return {
    input: covenantInput(p.coin, p.offer.tree, p.offer.fill[p.quote.side], [p.signature, p.message], p.quote.side),
    change: { script: p.offer.tree.pkScript, amount: satsOut, assets: usdOut > 0n ? [{ assetId: p.offer.usd, amount: usdOut }] : [] },
  };
}
/** Smallest `received` satisfying the rate for `sold` (rounded up: maker's favour). */
export const minReceived = (q: Quote, sold: bigint) => (sold * q.rateNum + q.rateDen - 1n) / q.rateDen;

/** Weight of a finalized ark tx returned by the emulator (base64 PSBT). */
export function finalWeight(signedArkTx: string) {
  const tx = Transaction.fromPSBT(Uint8Array.from(Buffer.from(signedArkTx, 'base64')));
  tx.finalize();
  return { weight: tx.weight, vsize: tx.vsize, txid: tx.id };
}

/** `fundedWallet`, but only tops up the shortfall below `min` sats: test keys are deterministic, so
 * reruns reuse the balance they already hold and spare the regtest faucet. */
export async function ensureFunded(chain: Chain, n: number, min: number): Promise<TestWallet> {
  const w = await fundedWallet(chain, n, 0);
  const have = (await w.wallet.getBalance()).total;
  if (have >= min) return w;
  return fundedWallet(chain, n, min - have);
}

/** Owner-leaf withdrawal of every spendable VTXO at `offer` back to the maker wallet, in chunks.
 * Keeps reruns from stranding sats in offer addresses (the regtest faucet is small). */
export async function sweepOffer(chain: Chain, offer: Offer, w: TestWallet, chunk = 30) {
  const coins = await coinsAt(chain, offer.tree);
  for (let i = 0; i < coins.length; i += chunk) {
    const part = coins.slice(i, i + chunk);
    const assets = new Map<string, bigint>();
    for (const c of part) for (const a of c.assets ?? []) assets.set(a.assetId, (assets.get(a.assetId) ?? 0n) + BigInt(a.amount));
    const built = await buildTx(chain, part.map(c => ownerInput(c, offer.tree, w.identity)),
      [{ script: w.pkScript, amount: part.reduce((s, c) => s + BigInt(c.value), 0n), assets: [...assets].map(([assetId, amount]) => ({ assetId, amount })) }]);
    await submitToArkd(chain, built.arkTx, built.checkpoints);
  }
  return coins.length;
}

/** Distinct asset ids held by a wallet. */
export async function assetIdsOf(chain: Chain, w: TestWallet) {
  return [...new Set((await walletCoins(chain, w)).flatMap(c => (c.assets ?? []).map(a => a.assetId)))];
}
/** Reuses the demo USD the wallet already holds the most of (keeps offer addresses stable across
 * reruns, so `sweepOffer` can reclaim them); issues a fresh one only on a clean stack. */
export async function demoUsd(chain: Chain, w: TestWallet, minBalance = 10_000n * 100_000_000n) {
  const totals = new Map<string, bigint>();
  for (const c of await walletCoins(chain, w)) for (const a of c.assets ?? []) totals.set(a.assetId, (totals.get(a.assetId) ?? 0n) + BigInt(a.amount));
  const best = [...totals].sort((a, b) => (b[1] > a[1] ? 1 : -1))[0];
  return best && best[1] >= minBalance ? best[0] : issueDemoUsd(chain, w);
}
