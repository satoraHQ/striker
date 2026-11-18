// Swap covenant (DESIGN.md §5) plus a small offchain-tx builder that mixes
// covenant inputs with plain wallet inputs (a maker signing its own VTXOs).
//
// Leaves:
//   0 Fill          covenant  before deadline; receive/fee/refund rules below
//   1 Refund-anyone covenant  after deadline; paired output = refund script, same value + assets
//   2 Refund-key    [refund_pubkey, arkd] plain collaborative leaf (no emulator)
//   3 Exit          refund_pubkey + seconds CSV (L1)
//
// Output pairing for a swap input at index i in a tx with n inputs:
//   output i       receive_address   (unique per input, so two deposits never share it)
//   output i + n   refund_address    (exact-out remainder; also unique)
//   any output     fee script, index passed as the only witness item (sharing it only hurts Striker)
//
// "Input amount" is read from the spent coin itself: INSPECTINPUTVALUE (pinned by the
// emulator's checkpoint validation to the VTXO value) and INSPECTINASSETLOOKUP (the asset
// packet's declared input amount, which arkd checks against the VTXO). Rates are per unit
// actually deposited, so slightly more or less than quoted still fills fairly.
import {
  arkade, asset, buildOffchainTx, EmulatorPacket, Extension, MultisigTapscript, Transaction,
  VtxoScript, type ArkTxInput, type ExtendedVirtualCoin, type SingleKey,
} from '@arkade-os/sdk';
import { RawWitness, ScriptNum } from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2.js';
import { covenantLeaf, exitLeaf, hex, submit, submitToArkd, waitFor, walletCoins, type Chain, type TestWallet } from './harness.js';

type Ops = Parameters<typeof arkade.ArkadeScript.encode>[0];
export const BTC = 'BTC' as const;
export type AssetRef = typeof BTC | string;

export interface SwapTerms {
  receive: Uint8Array;        // P2TR scriptPubKey of the payout
  refund: Uint8Array;         // P2TR scriptPubKey for refunds and exact-out remainders
  feeScript: Uint8Array;      // Striker's fee P2TR scriptPubKey
  sell: AssetRef;             // what the user deposits (BTC or an asset id)
  buy: AssetRef;              // what the user receives
  rate: { num: bigint; den: bigint }; // min_rate: buy units per sell unit = num / den
  feeBps: bigint;             // fee in sats, see feeFor()
  deadline: bigint;           // unix seconds (emulator clock)
  refundPubkey: Uint8Array;   // x-only
  exactOut?: bigint;          // want, in buy units, net of fee; omitted = exact-in (sell everything)
  dust: bigint;               // arkd /v1/info dust
  exitDelay: bigint;          // seconds, multiple of 512
}

const CUR = 'PUSHCURRENTINPUTINDEX' as const;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const feeOf = (base: bigint, bps: bigint) => ceilDiv(base * bps, 10_000n);

function program(script: Uint8Array) {
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) throw new Error('Expected a P2TR scriptPubKey');
  return script.slice(2);
}
/** Canonical asset id as two stack items: internal-order txid, group index. */
export function assetIdOps(id: string): Ops {
  const a = asset.AssetId.fromString(id);
  return [a.txid.slice().reverse(), a.groupIndex];
}
/** Fails with "OP_EQUALVERIFY failed" when output `idx` doesn't pay `script`. */
const pays = (idx: Ops, script: Uint8Array): Ops => [...idx, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', program(script), 'EQUALVERIFY'];

/** arkd only accepts outputs below dust as `OP_RETURN <taproot key>` ("subdust" VTXOs,
 * recoverable by the key holder in a batch). Fees can be tiny, so accept both forms. */
export const subdustScript = (p2tr: Uint8Array) => Uint8Array.from([0x6a, 0x20, ...program(p2tr)]);
/** Output at the index on the stack pays `script`'s key, as P2TR or (below dust) its sub-dust form; keeps the index. */
const paysEither = (script: Uint8Array): Ops => [
  'DUP', 'INSPECTOUTPUTSCRIPTPUBKEY', 'DUP', 1, 'EQUAL',
  'IF', 'DROP', program(script), 'EQUALVERIFY',
  'ELSE', -1, 'EQUALVERIFY', sha256(subdustScript(script)), 'EQUALVERIFY', 'ENDIF',
];
const paysFee = (script: Uint8Array): Ops => [
  'DUP', 'INSPECTOUTPUTSCRIPTPUBKEY', 'DUP', 1, 'EQUAL',
  'IF', 'DROP', program(script), 'EQUALVERIFY',
  'ELSE', -1, 'EQUALVERIFY', sha256(subdustScript(script)), 'EQUALVERIFY', 'ENDIF',
];

/** Leaves only the one-shot offchain SubmitTx path. OP_PUSHEXPIRY fails on the emulator's on-chain
 * endpoint (no VTXO expiry there), the intent check fails for batch intents; both of those return a
 * signature the caller can register in a batch after the deadline (arkd never re-runs the script),
 * and a registered intent blocks both refund paths. See DESIGN.md §2. */
const offchainOnly: Ops = ['PUSHEXPIRY', 'DROP', new TextEncoder().encode('type'), 'INSPECTINTENTMESSAGE', 'NOT', 'VERIFY', 'DROP'];

/**
 * Constants the fill leaf bakes in, mirrored off-chain by planFill().
 *
 * `min_rate` is net of the fee (like Uniswap's amountOutMinimum): what the user receives per
 * unit the user gives up, fee included. Striker quotes min_rate = maker rate × (1 − fee) ×
 * (1 − slippage). Exact-out: the user gives up at most `maxSpend = floor(want / min_rate)`
 * (rounded in the user's favour), so want / maxSpend ≥ min_rate.
 */
export function constants(t: SwapTerms) {
  const { num, den } = t.rate;
  if (num <= 0n || den <= 0n || t.feeBps < 0n || t.feeBps >= 10_000n) throw new Error('Invalid rate or fee');
  if ((t.sell === BTC) === (t.buy === BTC)) throw new Error('Spike swaps are BTC <-> one asset');
  if (t.exactOut === undefined) return {};
  const want = t.exactOut, maxSpend = want * den / num;
  if (t.sell === BTC) {
    // Buy `want` tokens for at most maxSpend sats, the fee (on maxSpend) included.
    const fee = feeOf(maxSpend, t.feeBps);
    if (maxSpend <= fee) throw new Error('exact-out amount too small for the fee');
    return { maxSpend, fee };
  }
  // Buy `want` sats net for at most maxSpend tokens; the maker pays the fee (on the sats) on top.
  if (want < t.dust) throw new Error('exact-out sats must be at least dust');
  if (maxSpend <= 0n) throw new Error('exact-out amount too small for the rate');
  return { maxSpend, fee: feeOf(want, t.feeBps) };
}

/**
 * Fill leaf. Failure classes (the emulator log shows the opcode):
 *   on-chain endpoint         OP_PUSHEXPIRY expiry not set (the offchain-only gate)
 *   batch intent              OP_VERIFY failed (the offchain-only gate)
 *   deadline passed           OP_NUMEQUALVERIFY failed
 *   wrong destination script  OP_EQUALVERIFY failed
 *   rate / receive amount     OP_VERIFY failed
 *   exact-out refund short    script returned early
 *   fee short                 false stack entry at end of script execution
 */
export function fillScript(t: SwapTerms): Uint8Array {
  const { num, den } = t.rate, D = t.dust, bps = t.feeBps, hasFee = bps > 0n;
  const c = constants(t);
  const head: Ops = [
    ...offchainOnly,
    t.deadline, 'CHECKTIME', 0, 'NUMEQUALVERIFY',
    ...(hasFee ? paysFee(t.feeScript) : []),          // witness: [fee_index]
    ...pays([CUR], t.receive),
  ];
  // Leaves [.. F] -> fee check as the final stack element.
  const tail: Ops = hasFee ? ['SWAP', 'INSPECTOUTPUTVALUE', 'LESSTHANOREQUAL'] : ['DROP', 1];
  const refundIdx: Ops = [CUR, 'INSPECTNUMINPUTS', 'ADD'];

  if (t.sell === BTC) {
    const buy = assetIdOps(t.buy);
    const common: Ops = [
      ...head,
      CUR, 'INSPECTINASSETCOUNT', 0, 'NUMEQUAL', 'VERIFY',          // pure-sats deposit
      CUR, 'INSPECTOUTPUTVALUE', D, 'GREATERTHANOREQUAL', 'VERIFY', // token carrier from the input
    ];
    if (t.exactOut === undefined) return arkade.ArkadeScript.encode([
      ...common,
      CUR, 'INSPECTINPUTVALUE', D, 'SUB',                             // A = deposit − carrier
      'DUP', 0, 'GREATERTHAN', 'VERIFY',
      'DUP', bps, 'MUL', 9999, 'ADD', 10_000, 'DIV',                  // F = ceil(A·bps/1e4), out of A
      'OVER', num, 'MUL',                                             // need = A·num (net: fee included)
      CUR, ...buy, 'INSPECTOUTASSETLOOKUP', 'DROP', den, 'MUL',       // have = tokens·den
      'LESSTHANOREQUAL', 'VERIFY', 'NIP',
      ...tail,
    ]);
    return arkade.ArkadeScript.encode([
      ...common,
      CUR, ...buy, 'INSPECTOUTASSETLOOKUP', 'DROP', t.exactOut, 'GREATERTHANOREQUAL', 'VERIFY',
      CUR, 'INSPECTINPUTVALUE', D + c.maxSpend!, 'SUB',                // R = unused sats
      'DUP', 0, 'GREATERTHAN',
      'IF',                                                            // any R goes back; below dust as OP_RETURN <key>
        ...refundIdx, ...paysEither(t.refund),
        'INSPECTOUTPUTVALUE', 'LESSTHANOREQUAL', 'NOTIF', 'RETURN', 'ENDIF',
      'ELSE', 'DROP', 'ENDIF',
      c.fee!, ...tail,
    ]);
  }

  const sell = assetIdOps(t.sell);
  const common: Ops = [
    ...head,
    CUR, 'INSPECTINASSETCOUNT', 1, 'NUMEQUAL', 'VERIFY',               // only the sell asset
    CUR, ...sell, 'INSPECTINASSETLOOKUP', 'VERIFY',                    // U = tokens deposited
  ];
  if (t.exactOut === undefined) return arkade.ArkadeScript.encode([
    ...common,
    'DUP', 0, 'GREATERTHAN', 'VERIFY',
    'DUP', num, 'MUL', den, 'DIV', bps, 'MUL', 9999, 'ADD', 10_000, 'DIV', // F on floor(U·rate), paid by the maker
    CUR, 'INSPECTOUTPUTVALUE', CUR, 'INSPECTINPUTVALUE', 'SUB',        // net = received − own carrier
    den, 'MUL',                                                        // net·den
    'ROT', num, 'MUL', 'GREATERTHANOREQUAL', 'VERIFY',                 //   ≥ U·num
    ...tail,
  ]);
  return arkade.ArkadeScript.encode([
    ...common,
    c.maxSpend!, 'SUB',                                                // R = unused tokens
    'DUP', 0, 'GREATERTHAN',
    'IF',
      ...refundIdx,
      'DUP', 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', program(t.refund), 'EQUALVERIFY',
      'DUP', 'INSPECTOUTPUTVALUE', D, 'GREATERTHANOREQUAL', 'NOTIF', 'RETURN', 'ENDIF',
      ...sell, 'INSPECTOUTASSETLOOKUP', 'DROP', 'LESSTHANOREQUAL', 'NOTIF', 'RETURN', 'ENDIF',
      t.exactOut - D,                                                  // change carries D of the user's sats
    'ELSE', 'DROP', t.exactOut, 'ENDIF',
    CUR, 'INSPECTOUTPUTVALUE', CUR, 'INSPECTINPUTVALUE', 'SUB',
    'LESSTHANOREQUAL', 'VERIFY',
    c.fee!, ...tail,
  ]);
}

/** Refund-anyone leaf: after the deadline, the paired output takes the whole coin to refund. */
export function refundScript(t: SwapTerms): Uint8Array {
  return arkade.ArkadeScript.encode([
    ...offchainOnly,
    t.deadline, 'CHECKTIME', 1, 'NUMEQUALVERIFY',
    ...pays([CUR], t.refund),
    CUR, 6, 0, 'TUNNEL',             // same value (2) and assets (4) as this input
  ]);
}

export interface Swap { terms: SwapTerms; fill: Uint8Array; refund: Uint8Array; tree: VtxoScript; address: string }
export const LEAF = { fill: 0, refundAnyone: 1, refundKey: 2, exit: 3 } as const;

export function swapCovenant(chain: Chain, terms: SwapTerms): Swap {
  const fill = fillScript(terms), refund = refundScript(terms);
  const tree = new VtxoScript([
    covenantLeaf(chain, fill),
    covenantLeaf(chain, refund),
    MultisigTapscript.encode({ pubkeys: [terms.refundPubkey, chain.server] }).script,
    exitLeaf(terms.refundPubkey, terms.exitDelay),
  ]);
  return { terms, fill, refund, tree, address: tree.address('tark', chain.server).encode() };
}

// ---------------------------------------------------------------- tx building

export interface CoinLike { txid: string; vout: number; value: number; assets?: { assetId: string; amount: bigint | number | string }[] }
export interface Spend {
  coin: CoinLike;
  input: ArkTxInput;
  arkade?: { script: Uint8Array; witness: Uint8Array[] };
  signer?: SingleKey;
  /** Override the asset amounts declared for this input (negative tests only). */
  declared?: Record<string, bigint>;
}
export interface Out { script: Uint8Array; amount: bigint; assets?: Record<string, bigint> }

export const num = (n: bigint | number) => ScriptNum().encode(BigInt(n));
export const assetsOf = (c: CoinLike) => Object.fromEntries((c.assets ?? []).map(a => [a.assetId, BigInt(a.amount)]));

export function walletSpend(coin: ExtendedVirtualCoin, signer: SingleKey): Spend {
  return { coin, signer, input: { txid: coin.txid, vout: coin.vout, value: coin.value, tapTree: coin.tapTree, tapLeafScript: coin.forfeitTapLeafScript } };
}
export function swapSpend(swap: Swap, coin: CoinLike, leaf: keyof typeof LEAF, witness: Uint8Array[] = []): Spend {
  const tapLeafScript = swap.tree.leaves[LEAF[leaf]]!;
  const script = leaf === 'fill' ? swap.fill : leaf === 'refundAnyone' ? swap.refund : undefined;
  return { coin, input: { txid: coin.txid, vout: coin.vout, value: coin.value, tapTree: swap.tree.encode(), tapLeafScript },
    ...(script ? { arkade: { script, witness } } : {}) };
}

/** Builds the ark tx + checkpoints, with an asset packet derived from inputs/outputs and
 * an emulator packet for covenant inputs, then signs wallet inputs and their checkpoints. */
export async function buildTx(chain: Chain, spends: Spend[], outs: Out[]) {
  const ids = new Set<string>();
  spends.forEach(s => Object.keys(s.declared ?? assetsOf(s.coin)).forEach(id => ids.add(id)));
  outs.forEach(o => Object.keys(o.assets ?? {}).forEach(id => ids.add(id)));
  const groups = [...ids].map(id => asset.AssetGroup.create(asset.AssetId.fromString(id), null,
    spends.flatMap((s, i) => { const a = (s.declared ?? assetsOf(s.coin))[id]; return a ? [asset.AssetInput.create(i, a)] : []; }),
    outs.flatMap((o, j) => { const a = o.assets?.[id]; return a ? [asset.AssetOutput.create(j, a)] : []; }), []));
  const packets = [];
  if (groups.length) packets.push(asset.Packet.create(groups));
  const entries = spends.flatMap((s, vin) => s.arkade ? [{ vin, script: s.arkade.script, witness: RawWitness.encode(s.arkade.witness) }] : []);
  if (entries.length) packets.push(EmulatorPacket.create(entries));
  const outputs = outs.map(o => ({ script: o.script, amount: o.amount }));
  if (packets.length) outputs.push(Extension.create(packets).txOut());
  let { arkTx, checkpoints } = buildOffchainTx(spends.map(s => s.input), outputs, chain.checkpoint);
  for (const [i, s] of spends.entries()) {
    if (!s.signer) continue;
    arkTx = await s.signer.sign(arkTx, [i]);
    checkpoints[i] = await s.signer.sign(checkpoints[i]!, [0]);
  }
  return { arkTx, checkpoints, prevTxids: spends.map(s => s.coin.txid) };
}

/** Covenant path: the emulator validates, co-signs and finalizes with arkd. */
export async function submitViaEmulator(chain: Chain, spends: Spend[], outs: Out[]) {
  const { arkTx, checkpoints, prevTxids } = await buildTx(chain, spends, outs);
  return (await submit(chain, arkTx, checkpoints, prevTxids)).txid;
}

/** Plain arkd path (no covenant inputs): the checkpoints are signed by `buildTx`, arkd finalizes on submit. */
export async function submitViaArkd(chain: Chain, spends: Spend[], outs: Out[]) {
  const { arkTx, checkpoints } = await buildTx(chain, spends, outs);
  return (await submitToArkd(chain, arkTx, checkpoints)).txid;
}

// ---------------------------------------------------------------- fill planning

/** Outputs the swap side of a fill needs, before the maker's balancing output. */
export interface FillPlan { receive: Out; fee?: Out; refund?: Out; feeIndexOverride?: number }

/**
 * Mirrors the covenant arithmetic at `rate`, the user's all-in rate the filler offers (≥
 * min_rate). Price improvement goes to the user: more of buy_asset on exact-in, a smaller spend
 * on exact-out. Amounts are rounded so the covenant's own (min_rate) check always passes, and
 * exact-out branches on the covenant's remainder, not the planned one.
 */
export function planFill(swap: Swap, coin: CoinLike, rate = swap.terms.rate): FillPlan {
  const t = swap.terms, D = t.dust, c = constants(t);
  if (rate.num <= 0n || rate.den <= 0n) throw new Error('Invalid rate');
  if (rate.num * t.rate.den < t.rate.num * rate.den) throw new Error('Rate below min_rate');
  const fee = (sats: bigint): Out | undefined => t.feeBps > 0n
    ? { script: sats < D ? subdustScript(t.feeScript) : t.feeScript, amount: sats } : undefined;
  /** buy units for `x` sell units: floor at `rate`, but never below the covenant's ceil at min_rate. */
  const atLeast = (x: bigint) => {
    const offered = x * rate.num / rate.den, needed = ceilDiv(x * t.rate.num, t.rate.den);
    return offered > needed ? offered : needed;
  };
  const S = BigInt(coin.value);
  if (t.sell === BTC) {
    if (t.exactOut === undefined) {
      const A = S - D;
      return { receive: { script: t.receive, amount: D, assets: { [t.buy]: atLeast(A) } }, fee: fee(feeOf(A, t.feeBps)) };
    }
    const spend = t.exactOut * rate.den / rate.num, R = S - D - spend;   // spend ≤ maxSpend, fee included
    if (R < 0n) throw new Error('Deposit too small for the exact-out amount');
    // Every unspent sat goes back: below dust as the refund key's sub-dust (OP_RETURN) output.
    return { receive: { script: t.receive, amount: D, assets: { [t.buy]: t.exactOut } }, fee: fee(c.fee!),
      ...(R > 0n ? { refund: { script: R < D ? subdustScript(t.refund) : t.refund, amount: R } } : {}) };
  }
  const U = assetsOf(coin)[t.sell] ?? 0n;
  if (t.exactOut === undefined)
    return { receive: { script: t.receive, amount: S + atLeast(U) }, fee: fee(feeOf(U * t.rate.num / t.rate.den, t.feeBps)) };
  // The user sells at most floor(want / rate) tokens (≤ maxSpend), the rest comes back.
  const sold = t.exactOut * rate.den / rate.num, keep = U - sold;
  // The covenant takes the token-change branch iff U > maxSpend, moving the carrier to the change;
  // otherwise the carrier stays on the receive output and any change's dust is funded by the maker.
  if (U > c.maxSpend!)
    return { receive: { script: t.receive, amount: S - D + t.exactOut }, fee: fee(c.fee!),
      refund: { script: t.refund, amount: D, assets: { [t.sell]: keep } } };
  return { receive: { script: t.receive, amount: S + t.exactOut }, fee: fee(c.fee!),
    ...(keep > 0n ? { refund: { script: t.refund, amount: D, assets: { [t.sell]: keep } } } : {}) };
}

const add = (a: Record<string, bigint>, b: Record<string, bigint> = {}, sign = 1n) => {
  const r = { ...a };
  for (const [k, v] of Object.entries(b)) r[k] = (r[k] ?? 0n) + sign * v;
  return r;
};

export interface Order { swap: Swap; coin: CoinLike; plan: FillPlan; declared?: Record<string, bigint> }

/** Single-swap fill: see fillMany. */
export function fill(chain: Chain, swap: Swap, coin: CoinLike, maker: TestWallet, plan: FillPlan,
  opts: { declared?: Record<string, bigint> } = {}) {
  return fillMany(chain, [{ swap, coin, plan, ...opts }], maker);
}

/**
 * Assembles a fill of k swap coins against one plain-wallet maker: swap coins at inputs
 * 0..k-1, maker coins after them; receive i at output i, refund i at output i + n_inputs,
 * fees and one balancing maker output in the free slots. The maker signs its inputs with its
 * wallet identity; the emulator co-signs the covenant inputs and finalizes with arkd.
 * `layout` may rearrange outputs (negative tests); fee indices follow the Out objects.
 */
export async function fillMany(chain: Chain, orders: Order[], maker: TestWallet,
  layout?: (outs: Out[]) => Out[]) {
  const swapOut = [...new Set(orders.flatMap(o => [o.plan.receive, o.plan.fee, o.plan.refund]))].filter((o): o is Out => !!o);
  const outSats = swapOut.reduce((s, o) => s + o.amount, 0n);
  const outAssets = swapOut.reduce((s, o) => add(s, o.assets), {} as Record<string, bigint>);
  const coins = await walletCoins(chain, maker);
  const makerCoins: ExtendedVirtualCoin[] = [];
  let sats = orders.reduce((s, o) => s + BigInt(o.coin.value), 0n);
  let assets = orders.reduce((s, o) => add(s, o.declared ?? assetsOf(o.coin)), {} as Record<string, bigint>);
  const short = () => sats - outSats < chain.dust || Object.entries(outAssets).some(([k, v]) => (assets[k] ?? 0n) < v);
  for (const c of [...coins].sort((a, b) => b.value - a.value)) {
    if (!short()) break;
    makerCoins.push(c); sats += BigInt(c.value); assets = add(assets, assetsOf(c));
  }
  if (short()) throw new Error('Maker cannot cover the fill');
  const makerOut: Out = { script: maker.pkScript, amount: sats - outSats,
    assets: Object.fromEntries(Object.entries(add(assets, outAssets, -1n)).filter(([, v]) => v > 0n)) };

  const n = orders.length + makerCoins.length;
  const outs: (Out | undefined)[] = orders.map(o => o.plan.receive);
  orders.forEach((o, i) => { if (o.plan.refund) outs[i + n] = o.plan.refund; });
  const rest = [makerOut, ...new Set(orders.flatMap(o => o.plan.fee ? [o.plan.fee] : []))];
  // Free slots take the fees and maker change first; any remaining gap before a refund
  // index (several maker coins push refunds further out) gets a dust output carved
  // from the maker's change.
  const pad = (): Out => {
    if (makerOut.amount - chain.dust < chain.dust) throw new Error('Maker change too small to pad outputs');
    makerOut.amount -= chain.dust;
    return { script: maker.pkScript, amount: chain.dust };
  };
  for (let i = 0; rest.length || i < outs.length; i++) if (!outs[i]) outs[i] = rest.shift() ?? pad();
  if (outs.some(o => !o) || outs.length !== new Set(outs).size) throw new Error('Refund index beyond the outputs; add padding');
  const final = layout ? layout(outs as Out[]) : outs as Out[];
  const spends = [
    ...orders.map(o => {
      const feeIndex = o.plan.feeIndexOverride ?? (o.plan.fee ? final.indexOf(o.plan.fee) : -1);
      const witness = o.swap.terms.feeBps > 0n ? [num(feeIndex)] : [];
      return { ...swapSpend(o.swap, o.coin, 'fill', witness), ...(o.declared ? { declared: o.declared } : {}) };
    }),
    ...makerCoins.map(c => walletSpend(c, maker.identity)),
  ];
  return { txid: await submitViaEmulator(chain, spends, final), outs: final };
}

/** Deposits like any Ark wallet would: a plain send to the covenant address. */
export async function deposit(chain: Chain, from: TestWallet, swap: Swap, sats: number, assets: { assetId: string; amount: bigint }[] = []) {
  const txid = await from.wallet.send({ address: swap.address, amount: sats, ...(assets.length ? { assets } : {}) });
  return waitFor(async () => {
    const { vtxos } = await chain.indexer.getVtxos({ scripts: [hex(swap.tree.pkScript)], spendableOnly: true });
    return vtxos.find(v => v.txid === txid);
  }, 'swap deposit');
}

/** The VTXO at `txid:vout`, with its value and assets as the indexer sees it. */
export async function outputAt(chain: Chain, txid: string, vout: number) {
  return waitFor(async () => (await chain.indexer.getVtxos({ outpoints: [{ txid, vout }] })).vtxos[0], `output ${txid}:${vout}`);
}
