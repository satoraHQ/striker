// v2 offer covenant (DESIGN.md §3, §4): signed quotes, the fill/owner/exit leaves, and a
// generic builder for fill transactions mixing covenant inputs and plain wallet inputs.
import assert from 'node:assert/strict';
import { arkade, asset, buildOffchainTx, EmulatorPacket, Extension, Transaction, VtxoScript,
  type ArkTxInput, type ExtendedVirtualCoin, type SingleKey, type TapLeafScript, type VirtualCoin } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { coinsAt, covenantTree, exitLeaf, fundedWallet, issueDemoUsd, ownerLeaf, submitToArkd, walletCoins, type Chain, type TestWallet } from './harness.js';

type Ops = Parameters<typeof arkade.ArkadeScript.encode>[0];

// ---------------------------------------------------------------- quote (§3)

/** BTC is the all-zero 34-byte asset id. Demo USD is its serialized asset id (txid ‖ u16 LE gidx). */
export const BTC = new Uint8Array(34);
export const QUOTE_TAG = 'striker/quote/v2';
/** BIP340 tagged-hash prefix: SHA256(tag) ‖ SHA256(tag). The script concatenates it with the quote. */
export const TAG_PREFIX = (() => { const h = sha256(new TextEncoder().encode(QUOTE_TAG)); return concat(h, h); })();
export const MAX_U63 = (1n << 63n) - 1n;

/**
 * Quote byte layout (148 bytes, every integer u64 LE < 2^63 so BIN2NUM reads it as positive):
 *   [0,32)    maker_pubkey (x-only)
 *   [32,40)   epoch
 *   [40,74)   sell_asset (34 bytes; BTC = zeros)
 *   [74,108)  buy_asset
 *   [108,116) rate_num     buy ≥ sell × rate_num / rate_den
 *   [116,124) rate_den
 *   [124,132) floor        change sell-side balance ≥ floor
 *   [132,140) min_fill     sold ≥ min_fill
 *   [140,148) expiry       unix seconds; valid while expiry > emulator time
 * The protocol version lives in the signature tag, not in the message.
 */
export const OFF = { maker: 0, epoch: 32, sell: 40, buy: 74, rateNum: 108, rateDen: 116, floor: 124, minFill: 132, expiry: 140 } as const;
export const QUOTE_LENGTH = 148;

export interface Quote {
  maker: Uint8Array; epoch: bigint; sell: Uint8Array; buy: Uint8Array;
  rateNum: bigint; rateDen: bigint; floor: bigint; minFill: bigint; expiry: bigint;
}

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

export function encodeQuote(q: Quote): Uint8Array {
  assert.equal(q.maker.length, 32); assert.equal(q.sell.length, 34); assert.equal(q.buy.length, 34);
  if (q.rateNum <= 0n || q.rateDen <= 0n || q.minFill <= 0n) throw new RangeError('rate and min_fill must be positive');
  const m = concat(q.maker, u64(q.epoch), q.sell, q.buy, u64(q.rateNum), u64(q.rateDen), u64(q.floor), u64(q.minFill), u64(q.expiry));
  assert.equal(m.length, QUOTE_LENGTH);
  return m;
}
export const quoteHash = (m: Uint8Array) => sha256(concat(TAG_PREFIX, m));
export function signQuote(q: Quote, secret: Uint8Array): { message: Uint8Array; signature: Uint8Array } {
  const message = encodeQuote(q);
  return { message, signature: schnorr.sign(quoteHash(message), secret) };
}
export const verifyQuote = (m: Uint8Array, sig: Uint8Array, pk: Uint8Array) => schnorr.verify(sig, quoteHash(m), pk);

// ------------------------------------------------------------- covenant (§4)

/** Pushes `asset_txid asset_gidx` for the asset opcodes. The VM wants the txid in internal
 * (byte-reversed) order relative to the SDK's serialized asset id; verified on regtest. */
function assetOps(id34: Uint8Array): Ops {
  const gidx = new DataView(id34.buffer, id34.byteOffset + 32, 2).getUint16(0, true);
  return [id34.slice(0, 32).reverse(), gidx];
}
const field = (off: number, len = 8): Ops => ['DUP', off, len, 'SUBSTR'];
const num = (off: number): Ops => [...field(off), 'BIN2NUM'];

/**
 * Fill leaf. Witness: [signature, quote]. Change is at the output whose index equals this
 * input's index. Balance deltas are measured on this input/output pair only, so the covenant
 * never looks at taker outputs.
 */
export function fillScript(maker: Uint8Array, epoch: bigint, usd: Uint8Array): Uint8Array {
  const U = assetOps(usd);
  const i: Ops = ['PUSHCURRENTINPUTINDEX'];
  const satsIn: Ops = [...i, 'INSPECTINPUTVALUE'];
  const satsOut: Ops = [...i, 'INSPECTOUTPUTVALUE'];
  const usdIn: Ops = [...i, ...U, 'INSPECTINASSETLOOKUP', 'DROP'];    // 0 when the asset is absent
  const usdOut: Ops = [...i, ...U, 'INSPECTOUTASSETLOOKUP', 'DROP'];
  return arkade.ArkadeScript.encode([
    // --- offchain only: an intent proof must never satisfy this leaf (see the emulator findings in
    //     README.md: a proof co-signed before expiry can be registered in a batch after it).
    new TextEncoder().encode('type'), 'INSPECTINTENTMESSAGE', 'NOT', 'VERIFY', 'DROP',
    // --- quote authenticity: sig over tagged_hash(TAG, quote) by the maker key baked in here
    'DUP', 'TOALTSTACK', TAG_PREFIX, 'SWAP', 'CAT', 'SHA256', maker, 'CHECKSIGFROMSTACK', 'VERIFY',
    'FROMALTSTACK', 'SIZE', QUOTE_LENGTH, 'EQUALVERIFY',
    ...field(OFF.maker, 32), maker, 'EQUALVERIFY',
    ...field(OFF.epoch), u64(epoch), 'EQUALVERIFY',               // epoch is part of the script
    ...num(OFF.expiry), 'CHECKTIME', 'NOT', 'VERIFY',             // valid only before expiry
    // --- direction: stack [q] → [q sold received], and floor on the sell-side change balance
    ...field(OFF.sell, 34), BTC, 'EQUAL',
    'IF',                                                          // maker sells BTC, buys USD
      ...field(OFF.buy, 34), usd, 'EQUALVERIFY',
      ...satsIn, ...satsOut, 'SUB',                                // sold = sats_in − sats_out
      ...usdOut, ...usdIn, 'SUB',                                  // received = usd_out − usd_in
      ...satsOut, 3, 'PICK', OFF.floor, 8, 'SUBSTR', 'BIN2NUM', 'GREATERTHANOREQUAL', 'VERIFY',
    'ELSE',                                                        // maker sells USD, buys BTC
      ...field(OFF.sell, 34), usd, 'EQUALVERIFY',
      ...field(OFF.buy, 34), BTC, 'EQUALVERIFY',
      ...usdIn, ...usdOut, 'SUB',                                  // sold = usd_in − usd_out
      ...satsOut, ...satsIn, 'SUB',                                // received = sats_out − sats_in
      ...usdOut, 3, 'PICK', OFF.floor, 8, 'SUBSTR', 'BIN2NUM', 'GREATERTHANOREQUAL', 'VERIFY',
    'ENDIF',
    // --- fill rules, stack [q sold received]
    'OVER', 3, 'PICK', OFF.minFill, 8, 'SUBSTR', 'BIN2NUM', 'GREATERTHANOREQUAL', 'VERIFY',   // sold ≥ min_fill
    'DUP', 3, 'PICK', OFF.rateDen, 8, 'SUBSTR', 'BIN2NUM', 'MUL',                           // received × rate_den
    2, 'PICK', 4, 'PICK', OFF.rateNum, 8, 'SUBSTR', 'BIN2NUM', 'MUL',                       // sold × rate_num
    'GREATERTHANOREQUAL', 'VERIFY',                                                          // rounded in the maker's favour
    '2DROP', 'DROP',
    // --- change keeps this exact script (same covenant, same epoch) and every non-USD asset.
    ...i, 5, ...U, 1, 'TUNNEL',
  ]);
}

export interface Offer { maker: Uint8Array; epoch: bigint; usd: string; script: Uint8Array; tree: VtxoScript; address: string }
/** Leaves: 0 fill (server + emulator⊕script), 1 owner (maker + server), 2 exit (maker, CSV seconds). */
export function offerTree(chain: Chain, maker: Uint8Array, epoch: bigint, usd: string, exitSeconds = 1536n): Offer {
  const script = fillScript(maker, epoch, assetBytes(usd));
  const tree = covenantTree(chain, script, [ownerLeaf(chain, maker), exitLeaf(maker, exitSeconds)]);
  return { maker, epoch, usd, script, tree, address: tree.address('tark', chain.server).encode() };
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
  return { coin, tapTree: tree.encode(), tapLeafScript: tree.leaves[1]!, signer };
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
  /** Maker sells `sold` of quote.sell and receives `received` of quote.buy. */
  sold: bigint; received: bigint;
}
export const usdOf = (coin: Coin, usd: string) => BigInt(coin.assets?.find(a => a.assetId === usd)?.amount ?? 0);
export const isBtc = (id: Uint8Array) => id.every(b => b === 0);

/** Maker input + its paired change output, with the payment folded into the change. */
export function makerLeg(p: FillPlan): { input: TxInput; change: TxOutput } {
  const sats = BigInt(p.coin.value), usd = usdOf(p.coin, p.offer.usd);
  const sellBtc = isBtc(p.quote.sell);
  const satsOut = sellBtc ? sats - p.sold : sats + p.received;
  const usdOut = sellBtc ? usd + p.received : usd - p.sold;
  return {
    input: covenantInput(p.coin, p.offer.tree, p.offer.script, [p.signature, p.message]),
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
