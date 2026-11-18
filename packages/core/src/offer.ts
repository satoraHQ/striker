// Offer covenant (DESIGN.md §4). One VTXO holds the maker's liquidity, sats plus the asset.
//   leaf 0  Fill sell-BTC     [server, emulator ⊕ fillScript(SELL_BTC)]
//   leaf 1  Fill sell-asset   [server, emulator ⊕ fillScript(SELL_ASSET)]
//   leaf 2  Renew             [striker, server, emulator ⊕ renewScript]
//   leaf 3  Owner             [maker, server]
//   leaf 4  Exit (L1)         maker + CSV seconds
import { arkade, VtxoScript } from '@arkade-os/sdk';
import { addressOf, covenantLeaf, exitLeaf, ownerLeaf, type CovenantParams } from './chain.js';
import { assetBytes, OFF, QUOTE_LENGTH, quoteTagHash, SELL_BTC, SELL_ASSET, type QuoteContext, type Side } from './quote.js';
import { renewLeaf, renewScript, type RenewParams } from './renew.js';
import { utf8 } from './util.js';

type Ops = Parameters<typeof arkade.ArkadeScript.encode>[0];

/** Offchain-only gate (DESIGN.md §2): OP_PUSHEXPIRY fails on the emulator's on-chain endpoint,
 * the intent check fails for batch intents. Only the one-shot SubmitTx path remains. */
export const offchainOnly: Ops = ['PUSHEXPIRY', 'DROP', utf8('type'), 'INSPECTINTENTMESSAGE', 'NOT', 'VERIFY', 'DROP'];

/** Pushes `asset_txid asset_gidx`; the VM wants the txid byte-reversed relative to the SDK serialization. */
function assetOps(id34: Uint8Array): Ops {
  const gidx = new DataView(id34.buffer, id34.byteOffset + 32, 2).getUint16(0, true);
  return [id34.slice(0, 32).reverse(), gidx];
}
const num = (off: number): Ops => ['DUP', off, 8, 'SUBSTR', 'BIN2NUM'];
const positive: Ops = ['DUP', 0, 'GREATERTHAN', 'VERIFY'];
const topBitClear = (off: number): Ops => ['DUP', off + 7, 1, 'SUBSTR', 1, 'CAT', 'BIN2NUM', 384, 'LESSTHAN', 'VERIFY'];
const sats = (op: 'INSPECTINPUTVALUE' | 'INSPECTOUTPUTVALUE'): Ops => ['PUSHCURRENTINPUTINDEX', op];
const tokens = (op: 'INSPECTINASSETLOOKUP' | 'INSPECTOUTASSETLOOKUP'): Ops =>
  ['FROMALTSTACK', 'FROMALTSTACK', '2DUP', 'TOALTSTACK', 'TOALTSTACK', 'PUSHCURRENTINPUTINDEX', 'ROT', 'ROT', op, 'DROP'];

/** One-direction Fill leaf, identical to spike/offer.ts. Witness: [signature, quote]. */
export function fillScript(ctx: QuoteContext, side: Side): Uint8Array {
  const [sellIn, sellOut, buyIn, buyOut] = side === SELL_BTC
    ? [sats('INSPECTINPUTVALUE'), sats('INSPECTOUTPUTVALUE'), tokens('INSPECTINASSETLOOKUP'), tokens('INSPECTOUTASSETLOOKUP')]
    : [tokens('INSPECTINASSETLOOKUP'), tokens('INSPECTOUTASSETLOOKUP'), sats('INSPECTINPUTVALUE'), sats('INSPECTOUTPUTVALUE')];
  return arkade.ArkadeScript.encode([
    ...offchainOnly,
    'DUP', 'TOALTSTACK', quoteTagHash(ctx, side), 'DUP', 'CAT', 'SWAP', 'CAT', 'SHA256', ctx.maker, 'CHECKSIGFROMSTACK', 'VERIFY',
    'FROMALTSTACK', 'SIZE', QUOTE_LENGTH, 'EQUALVERIFY',
    ...num(OFF.expiry), 'CHECKTIME', 'NOT', 'VERIFY',
    ...assetOps(assetBytes(ctx.asset)), 'TOALTSTACK', 'TOALTSTACK',
    ...sellIn, ...sellOut, 'TUCK', 'SUB',
    'SWAP', 2, 'PICK', ...topBitClear(OFF.floor), OFF.floor, 8, 'SUBSTR', 'BIN2NUM', 'GREATERTHANOREQUAL', 'VERIFY',
    'DUP', 2, 'PICK', OFF.minFill, 8, 'SUBSTR', 'BIN2NUM', ...positive, 'GREATERTHANOREQUAL', 'VERIFY',
    ...buyOut, ...buyIn, 'SUB',
    'ROT', ...num(OFF.rateDen), ...positive, 'ROT', 'MUL',
    'SWAP', OFF.rateNum, 8, 'SUBSTR', 'BIN2NUM', ...positive, 'ROT', 'MUL',
    'GREATERTHANOREQUAL', 'VERIFY',
    'PUSHCURRENTINPUTINDEX', 5, 'FROMALTSTACK', 'FROMALTSTACK', 1, 'TUNNEL',
  ]);
}

export const OFFER_LEAF = { sellBtc: 0, sellAsset: 1, renew: 2, owner: 3, exit: 4 } as const;
export const DEFAULT_EXIT_SECONDS = 1536n;

/** Everything that determines an offer address. Public: anyone can rebuild and check it. */
export interface OfferParams extends QuoteContext { renew: RenewParams; exitSeconds: bigint }

export interface Offer extends OfferParams {
  fill: [Uint8Array, Uint8Array];
  renewScript: Uint8Array;
  tree: VtxoScript;
  address: string;
}

export function offerCovenant(chain: CovenantParams, p: OfferParams): Offer {
  const fill: [Uint8Array, Uint8Array] = [fillScript(p, SELL_BTC), fillScript(p, SELL_ASSET)];
  const renew = renewScript(p.renew);
  const tree = new VtxoScript([
    ...fill.map(s => covenantLeaf(chain, s)),
    renewLeaf(chain, p.renew, renew),
    ownerLeaf(chain, p.maker),
    exitLeaf(p.maker, p.exitSeconds),
  ]);
  return { ...p, fill, renewScript: renew, tree, address: addressOf(chain, tree) };
}
