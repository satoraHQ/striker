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
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { b64, covenantLeaf, EMULATOR_CONTAINER, exitLeaf, hex, submit, unb64, waitFor, type Chain, type TestWallet } from './harness.js';

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
const paysFee = (script: Uint8Array): Ops => [
  'DUP', 'INSPECTOUTPUTSCRIPTPUBKEY', 'DUP', 1, 'EQUAL',
  'IF', 'DROP', program(script), 'EQUALVERIFY',
  'ELSE', -1, 'EQUALVERIFY', sha256(subdustScript(script)), 'EQUALVERIFY', 'ENDIF',
];

/** Constants the fill leaf bakes in, mirrored off-chain by planFill(). */
export function constants(t: SwapTerms) {
  const { num, den } = t.rate;
  if (num <= 0n || den <= 0n || t.feeBps < 0n || t.feeBps >= 10_000n) throw new Error('Invalid rate or fee');
  if ((t.sell === BTC) === (t.buy === BTC)) throw new Error('Spike swaps are BTC <-> one asset');
  if (t.exactOut === undefined) return {};
  const want = t.exactOut;
  if (t.sell === BTC) {
    // Buy `want` tokens; pay at most maxSell sats plus a fee on maxSell.
    const maxSell = ceilDiv(want * den, num);
    return { maxSell, fee: feeOf(maxSell, t.feeBps) };
  }
  // Buy `want` sats net; the fee is on the sats, the maker pays want + fee.
  if (want < t.dust) throw new Error('exact-out sats must be at least dust');
  const fee = feeOf(want, t.feeBps);
  return { fee, maxSell: ceilDiv((want + fee) * den, num) };
}

/**
 * Fill leaf. Failure classes (the emulator log shows the opcode):
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
      'DUP', bps, 'MUL', 9999, 'ADD', 10_000, 'DIV',                  // F = ceil(A·bps/1e4)
      '2DUP', 'SUB', num, 'MUL',                                      // need = (A − F)·num
      CUR, ...buy, 'INSPECTOUTASSETLOOKUP', 'DROP', den, 'MUL',       // have = tokens·den
      'LESSTHANOREQUAL', 'VERIFY', 'NIP',
      ...tail,
    ]);
    return arkade.ArkadeScript.encode([
      ...common,
      CUR, ...buy, 'INSPECTOUTASSETLOOKUP', 'DROP', t.exactOut, 'GREATERTHANOREQUAL', 'VERIFY',
      CUR, 'INSPECTINPUTVALUE', D + c.maxSell! + c.fee!, 'SUB',        // R = unused sats
      'DUP', D, 'GREATERTHANOREQUAL',
      'IF',
        ...refundIdx, 'DUP', 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', program(t.refund), 'EQUALVERIFY',
        'INSPECTOUTPUTVALUE', 'LESSTHANOREQUAL', 'NOTIF', 'RETURN', 'ENDIF',
      'ELSE', 'DROP', 'ENDIF',                                         // sub-dust R is slippage
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
    'DUP', num, 'MUL', den, 'DIV', bps, 'MUL', 9999, 'ADD', 10_000, 'DIV', // F on floor(U·rate)
    CUR, 'INSPECTOUTPUTVALUE', CUR, 'INSPECTINPUTVALUE', 'SUB',        // received − own carrier
    'OVER', 'ADD', den, 'MUL',                                         // (recv − c + F)·den
    'ROT', num, 'MUL', 'GREATERTHANOREQUAL', 'VERIFY',                 //   ≥ U·num
    ...tail,
  ]);
  return arkade.ArkadeScript.encode([
    ...common,
    c.maxSell!, 'SUB',                                                 // R = unused tokens
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

/** Plain arkd path (no covenant inputs): submit, co-sign the checkpoints, finalize. */
export async function submitViaArkd(chain: Chain, spends: Spend[], outs: Out[]) {
  const { arkTx, checkpoints } = await buildTx(chain, spends, outs);
  const res = await chain.ark.submitTx(b64(arkTx.toPSBT()), checkpoints.map(c => b64(c.toPSBT())));
  const final = await Promise.all(res.signedCheckpointTxs.map(async (cp, i) => {
    const signer = spends[i]?.signer;
    const tx = Transaction.fromPSBT(unb64(cp));
    return b64((signer ? await signer.sign(tx, [0]) : tx).toPSBT());
  }));
  await chain.ark.finalizeTx(res.arkTxid, final);
  return res.arkTxid;
}

// ---------------------------------------------------------------- fill planning

/** Outputs the swap side of a fill needs, before the maker's balancing output. */
export interface FillPlan { receive: Out; fee?: Out; refund?: Out; feeIndexOverride?: number }

/**
 * Mirrors the covenant arithmetic at the maker's actual rate (≥ min_rate). Price
 * improvement goes to the user: more of buy_asset on exact-in, a larger refund on exact-out.
 */
export function planFill(swap: Swap, coin: CoinLike, rate = swap.terms.rate): FillPlan {
  const t = swap.terms, D = t.dust, c = constants(t);
  const fee = (sats: bigint): Out | undefined => t.feeBps > 0n
    ? { script: sats < D ? subdustScript(t.feeScript) : t.feeScript, amount: sats } : undefined;
  const S = BigInt(coin.value);
  if (t.sell === BTC) {
    if (t.exactOut === undefined) {
      const A = S - D, F = feeOf(A, t.feeBps);
      return { receive: { script: t.receive, amount: D, assets: { [t.buy]: ceilDiv((A - F) * rate.num, rate.den) } }, fee: fee(F) };
    }
    const sold = ceilDiv(t.exactOut * rate.den, rate.num), R = S - D - sold - c.fee!;
    return { receive: { script: t.receive, amount: D, assets: { [t.buy]: t.exactOut } }, fee: fee(c.fee!),
      ...(R >= D ? { refund: { script: t.refund, amount: R } } : {}) };
  }
  const U = assetsOf(coin)[t.sell] ?? 0n;
  if (t.exactOut === undefined) {
    const F = feeOf(U * t.rate.num / t.rate.den, t.feeBps);
    const gross = U * rate.num / rate.den;
    return { receive: { script: t.receive, amount: S + gross - F }, fee: fee(F) };
  }
  const sold = ceilDiv((t.exactOut + c.fee!) * rate.den, rate.num), R = U - sold;
  return R > 0n
    ? { receive: { script: t.receive, amount: S - D + t.exactOut }, fee: fee(c.fee!), refund: { script: t.refund, amount: D, assets: { [t.sell]: R } } }
    : { receive: { script: t.receive, amount: S + t.exactOut }, fee: fee(c.fee!) };
}

const add = (a: Record<string, bigint>, b: Record<string, bigint> = {}, sign = 1n) => {
  const r = { ...a };
  for (const [k, v] of Object.entries(b)) r[k] = (r[k] ?? 0n) + sign * v;
  return r;
};

/** Spendable VTXOs of a wallet, re-read from the indexer (wallet state lags custom txs). */
const templates = new WeakMap<TestWallet, ExtendedVirtualCoin>();
export async function walletCoins(chain: Chain, w: TestWallet): Promise<ExtendedVirtualCoin[]> {
  if (!templates.has(w)) {
    const tpl = (await w.wallet.getVtxos()).find(v => v.script === hex(w.pkScript));
    if (!tpl) throw new Error('Wallet has no coin to learn its tapscripts from');
    templates.set(w, tpl);
  }
  const tpl = templates.get(w)!;
  const { vtxos } = await chain.indexer.getVtxos({ scripts: [hex(w.pkScript)], spendableOnly: true });
  return vtxos.map(v => ({ ...v, tapTree: tpl.tapTree, forfeitTapLeafScript: tpl.forfeitTapLeafScript, intentTapLeafScript: tpl.intentTapLeafScript }));
}

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
  for (let i = 0; rest.length; i++) if (!outs[i]) outs[i] = rest.shift();
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

/** Every emulator "failed to process transaction" line (script failures *and* arkd
 * rejections relayed by the emulator, e.g. ASSET_INPUT_INVALID). Belongs in the harness. */
export function emulatorFailures() {
  const logs = spawnSync('docker', ['logs', EMULATOR_CONTAINER], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(logs.status, 0, 'Cannot read emulator logs');
  return (logs.stdout + logs.stderr).split('\n').filter(l => l.includes('failed to process transaction'));
}
/** Asserts `fn` is rejected and a new emulator failure line contains `text`. */
export async function rejectedWith(text: string, fn: () => Promise<unknown>) {
  const before = emulatorFailures().length;
  await assert.rejects(fn);
  const lines = await waitFor(async () => {
    const l = emulatorFailures().slice(before);
    return l.some(x => x.includes(text)) ? l : undefined;
  }, `emulator failure containing "${text}"`, 5_000);
  return lines.filter(x => x.includes(text));
}
