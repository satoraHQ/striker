// Swap covenant (DESIGN.md §5), identical to spike/swap.ts.
//   leaf 0 Fill          covenant, offchain only, before the deadline
//   leaf 1 Refund-anyone covenant, offchain only, after the deadline; paired output = refund
//   leaf 2 Refund-key    [refund_pubkey, arkd]
//   leaf 3 Exit          refund_pubkey + seconds CSV (L1)
// Output pairing for swap input i of n inputs: receive at i, exact-out refund at i + n, fee
// anywhere (its index is the only witness item).
import { arkade, asset, MultisigTapscript, VtxoScript } from '@arkade-os/sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { addressOf, covenantLeaf, exitLeaf, type ChainParams } from './chain.js';
import { offchainOnly } from './offer.js';
import { feeOf, hex, unhex } from './util.js';

type Ops = Parameters<typeof arkade.ArkadeScript.encode>[0];
export const BTC = 'BTC' as const;
export type AssetRef = typeof BTC | string;

export interface SwapTerms {
  receive: Uint8Array;        // P2TR scriptPubKey of the payout
  refund: Uint8Array;         // P2TR scriptPubKey for refunds and exact-out remainders
  feeScript: Uint8Array;      // Striker's fee P2TR scriptPubKey
  sell: AssetRef;
  buy: AssetRef;
  /** min_rate, net of the fee: buy units per sell unit = num / den. */
  rate: { num: bigint; den: bigint };
  feeBps: bigint;
  deadline: bigint;           // unix seconds (emulator clock)
  refundPubkey: Uint8Array;   // x-only
  exactOut?: bigint;          // want, in buy units, net of fee
  dust: bigint;
  exitDelay: bigint;          // seconds, multiple of 512
}

const CUR = 'PUSHCURRENTINPUTINDEX' as const;

function program(script: Uint8Array) {
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) throw new Error('Expected a P2TR scriptPubKey');
  return script.slice(2);
}
export function assetIdOps(id: string): Ops {
  const a = asset.AssetId.fromString(id);
  return [a.txid.slice().reverse(), a.groupIndex];
}
const pays = (idx: Ops, script: Uint8Array): Ops => [...idx, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', program(script), 'EQUALVERIFY'];

/** arkd only accepts outputs below dust as `OP_RETURN <taproot key>` (sub-dust VTXOs). */
export const subdustScript = (p2tr: Uint8Array) => Uint8Array.from([0x6a, 0x20, ...program(p2tr)]);
const paysFee = (script: Uint8Array): Ops => [
  'DUP', 'INSPECTOUTPUTSCRIPTPUBKEY', 'DUP', 1, 'EQUAL',
  'IF', 'DROP', program(script), 'EQUALVERIFY',
  'ELSE', -1, 'EQUALVERIFY', sha256(subdustScript(script)), 'EQUALVERIFY', 'ENDIF',
];

/** Constants the fill leaf bakes in: exact-out `maxSpend` (sell units, fee included on the BTC side) and fee. */
export function constants(t: SwapTerms): { maxSpend?: bigint; fee?: bigint } {
  const { num, den } = t.rate;
  if (num <= 0n || den <= 0n || t.feeBps < 0n || t.feeBps >= 10_000n) throw new Error('Invalid rate or fee');
  if ((t.sell === BTC) === (t.buy === BTC)) throw new Error('Swaps are BTC <-> one asset');
  if (t.exactOut === undefined) return {};
  const want = t.exactOut, maxSpend = want * den / num;
  if (t.sell === BTC) {
    const fee = feeOf(maxSpend, t.feeBps);
    if (maxSpend <= fee) throw new Error('exact-out amount too small for the fee');
    return { maxSpend, fee };
  }
  if (want < t.dust) throw new Error('exact-out sats must be at least dust');
  if (maxSpend <= 0n) throw new Error('exact-out amount too small for the rate');
  return { maxSpend, fee: feeOf(want, t.feeBps) };
}

export function fillScript(t: SwapTerms): Uint8Array {
  const { num, den } = t.rate, D = t.dust, bps = t.feeBps, hasFee = bps > 0n;
  const c = constants(t);
  const head: Ops = [
    ...offchainOnly,
    t.deadline, 'CHECKTIME', 0, 'NUMEQUALVERIFY',
    ...(hasFee ? paysFee(t.feeScript) : []),
    ...pays([CUR], t.receive),
  ];
  const tail: Ops = hasFee ? ['SWAP', 'INSPECTOUTPUTVALUE', 'LESSTHANOREQUAL'] : ['DROP', 1];
  const refundIdx: Ops = [CUR, 'INSPECTNUMINPUTS', 'ADD'];

  if (t.sell === BTC) {
    const buy = assetIdOps(t.buy);
    const common: Ops = [
      ...head,
      CUR, 'INSPECTINASSETCOUNT', 0, 'NUMEQUAL', 'VERIFY',
      CUR, 'INSPECTOUTPUTVALUE', D, 'GREATERTHANOREQUAL', 'VERIFY',
    ];
    if (t.exactOut === undefined) return arkade.ArkadeScript.encode([
      ...common,
      CUR, 'INSPECTINPUTVALUE', D, 'SUB',
      'DUP', 0, 'GREATERTHAN', 'VERIFY',
      'DUP', bps, 'MUL', 9999, 'ADD', 10_000, 'DIV',
      'OVER', num, 'MUL',
      CUR, ...buy, 'INSPECTOUTASSETLOOKUP', 'DROP', den, 'MUL',
      'LESSTHANOREQUAL', 'VERIFY', 'NIP',
      ...tail,
    ]);
    return arkade.ArkadeScript.encode([
      ...common,
      CUR, ...buy, 'INSPECTOUTASSETLOOKUP', 'DROP', t.exactOut, 'GREATERTHANOREQUAL', 'VERIFY',
      CUR, 'INSPECTINPUTVALUE', D + c.maxSpend!, 'SUB',
      'DUP', 0, 'GREATERTHAN',
      'IF',
        ...refundIdx, ...pays(['DUP'], t.refund),
        'INSPECTOUTPUTVALUE', 'LESSTHANOREQUAL', 'NOTIF', 'RETURN', 'ENDIF',
      'ELSE', 'DROP', 'ENDIF',
      c.fee!, ...tail,
    ]);
  }

  const sell = assetIdOps(t.sell);
  const common: Ops = [
    ...head,
    CUR, 'INSPECTINASSETCOUNT', 1, 'NUMEQUAL', 'VERIFY',
    CUR, ...sell, 'INSPECTINASSETLOOKUP', 'VERIFY',
  ];
  if (t.exactOut === undefined) return arkade.ArkadeScript.encode([
    ...common,
    'DUP', 0, 'GREATERTHAN', 'VERIFY',
    'DUP', num, 'MUL', den, 'DIV', bps, 'MUL', 9999, 'ADD', 10_000, 'DIV',
    CUR, 'INSPECTOUTPUTVALUE', CUR, 'INSPECTINPUTVALUE', 'SUB',
    den, 'MUL',
    'ROT', num, 'MUL', 'GREATERTHANOREQUAL', 'VERIFY',
    ...tail,
  ]);
  return arkade.ArkadeScript.encode([
    ...common,
    c.maxSpend!, 'SUB',
    'DUP', 0, 'GREATERTHAN',
    'IF',
      ...refundIdx,
      'DUP', 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', program(t.refund), 'EQUALVERIFY',
      'DUP', 'INSPECTOUTPUTVALUE', D, 'GREATERTHANOREQUAL', 'NOTIF', 'RETURN', 'ENDIF',
      ...sell, 'INSPECTOUTASSETLOOKUP', 'DROP', 'LESSTHANOREQUAL', 'NOTIF', 'RETURN', 'ENDIF',
      t.exactOut - D,
    'ELSE', 'DROP', t.exactOut, 'ENDIF',
    CUR, 'INSPECTOUTPUTVALUE', CUR, 'INSPECTINPUTVALUE', 'SUB',
    'LESSTHANOREQUAL', 'VERIFY',
    c.fee!, ...tail,
  ]);
}

export function refundScript(t: SwapTerms): Uint8Array {
  return arkade.ArkadeScript.encode([
    ...offchainOnly,
    t.deadline, 'CHECKTIME', 1, 'NUMEQUALVERIFY',
    ...pays([CUR], t.refund),
    CUR, 6, 0, 'TUNNEL',
  ]);
}

export interface Swap { terms: SwapTerms; fill: Uint8Array; refund: Uint8Array; tree: VtxoScript; address: string }
export const SWAP_LEAF = { fill: 0, refundAnyone: 1, refundKey: 2, exit: 3 } as const;

export function swapCovenant(chain: ChainParams, terms: SwapTerms): Swap {
  const fill = fillScript(terms), refund = refundScript(terms);
  const tree = new VtxoScript([
    covenantLeaf(chain, fill),
    covenantLeaf(chain, refund),
    MultisigTapscript.encode({ pubkeys: [terms.refundPubkey, chain.server] }).script,
    exitLeaf(terms.refundPubkey, terms.exitDelay),
  ]);
  return { terms, fill, refund, tree, address: addressOf(chain, tree) };
}

// ---------------------------------------------------------------- wire form

export interface SwapTermsWire {
  receive: string; refund: string; feeScript: string; sell: AssetRef; buy: AssetRef;
  rate: { num: string; den: string }; feeBps: string; deadline: string; refundPubkey: string;
  exactOut?: string; dust: string; exitDelay: string;
}
export const termsToWire = (t: SwapTerms): SwapTermsWire => ({
  receive: hex(t.receive), refund: hex(t.refund), feeScript: hex(t.feeScript), sell: t.sell, buy: t.buy,
  rate: { num: String(t.rate.num), den: String(t.rate.den) }, feeBps: String(t.feeBps), deadline: String(t.deadline),
  refundPubkey: hex(t.refundPubkey), ...(t.exactOut === undefined ? {} : { exactOut: String(t.exactOut) }),
  dust: String(t.dust), exitDelay: String(t.exitDelay),
});
export const termsFromWire = (w: SwapTermsWire): SwapTerms => ({
  receive: unhex(w.receive), refund: unhex(w.refund), feeScript: unhex(w.feeScript), sell: w.sell, buy: w.buy,
  rate: { num: BigInt(w.rate.num), den: BigInt(w.rate.den) }, feeBps: BigInt(w.feeBps), deadline: BigInt(w.deadline),
  refundPubkey: unhex(w.refundPubkey), ...(w.exactOut === undefined ? {} : { exactOut: BigInt(w.exactOut) }),
  dust: BigInt(w.dust), exitDelay: BigInt(w.exitDelay),
});
