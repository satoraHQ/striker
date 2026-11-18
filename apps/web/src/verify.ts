// Trust minimisation: rebuild the swap covenant from its terms and our own inputs before showing
// the deposit address. The emulator key comes from the SDK's pinned key, never from the server.
import { ArkAddress, defaultEmulatorPubkey, networks, type Network } from '@arkade-os/sdk';
import {
  BTC, equalBytes, hex, minRateFor, swapCovenant, termsFromWire, unhex,
  type BookSnapshot, type CreateSwapRequest, type InfoResponse, type SwapView,
} from '@striker/core';

export function pinnedEmulatorKey(networkName: string): Uint8Array {
  const network = (networks as Record<string, Network>)[networkName];
  if (!network) throw new Error(`Unknown network ${networkName}`);
  return unhex(defaultEmulatorPubkey(network)).slice(-32);
}
export const hrpFor = (networkName: string) => (networkName === 'bitcoin' ? 'ark' : 'tark');

/** Decode and check an Ark address for this network; returns an error string or null. */
export function addressError(addr: string, info: Pick<InfoResponse, 'network' | 'serverKey'> | undefined): string | null {
  if (!addr.trim()) return 'Required';
  let a: ArkAddress;
  try { a = ArkAddress.decode(addr.trim()); } catch { return 'Not a valid Ark address'; }
  if (info && a.hrp !== hrpFor(info.network)) return `Expected a ${hrpFor(info.network)}1… address`;
  if (info && hex(a.serverPubKey) !== hex(unhex(info.serverKey).slice(-32))) return 'Address belongs to a different Ark server';
  return null;
}

export interface Rate { num: string; den: string }

/**
 * The least rate the user accepts: the best quote in the book the user is looking at (the maker
 * side that buys what the user sells), net of Striker's fee and the user's slippage. Undefined
 * without a quote on that side.
 */
export function rateFloor(book: BookSnapshot | undefined, sell: CreateSwapRequest['sell'], feeBps: string, slippageBps: number): Rate | undefined {
  // The user sells BTC to makers who sell the asset (bids), and the asset to makers who sell BTC (asks).
  const best = (sell === 'BTC' ? book?.bids : book?.asks)?.[0];
  if (!best) return undefined;
  const r = minRateFor({ rateNum: BigInt(best.rateNum), rateDen: BigInt(best.rateDen) }, BigInt(feeBps), BigInt(slippageBps));
  return { num: String(r.num), den: String(r.den) };
}

/** Returns the list of failed checks; empty means the address is safe to show. */
export function verifySwap(view: SwapView, info: InfoResponse, req: CreateSwapRequest, amountBase: bigint, floor?: Rate): string[] {
  const errs: string[] = [];
  const check = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };
  try {
    const terms = termsFromWire(view.terms);
    const chain = { server: unhex(info.serverKey).slice(-32), emulatorKey: pinnedEmulatorKey(info.network), hrp: hrpFor(info.network) };
    const rebuilt = swapCovenant(chain, terms).address;
    check(rebuilt === view.address, 'Deposit address does not match the covenant built from its terms');

    const receive = ArkAddress.decode(req.receiveAddress).pkScript;
    const refund = ArkAddress.decode(req.refundAddress).pkScript;
    check(equalBytes(terms.receive, receive), 'Covenant pays a different receive address');
    check(equalBytes(terms.refund, refund), 'Covenant refunds to a different address');
    check(hex(terms.refundPubkey) === req.refundPubkey.toLowerCase(), 'Covenant uses a different refund key');
    check(hex(terms.feeScript) === info.feeScript.toLowerCase(), 'Fee goes to an unexpected script');
    check(terms.feeBps === BigInt(info.feeBps), 'Fee differs from the advertised fee');

    const [sell, buy] = req.sell === 'BTC' ? [BTC, info.asset.id] : [info.asset.id, BTC];
    check(terms.sell === sell && terms.buy === buy, 'Covenant trades the wrong direction or asset');
    if (req.mode === 'exactOut') check(terms.exactOut === amountBase, 'Exact-out amount does not match');
    else check(terms.exactOut === undefined, 'Covenant unexpectedly has an exact-out amount');

    if (view.deposit.asset) check(view.deposit.asset.id === info.asset.id, 'Deposit asks for an unexpected asset');
    check(req.sell === 'ASSET' ? !!view.deposit.asset : !view.deposit.asset, 'Deposit instructions do not match the direction');
    // The guaranteed rate (buy units per sell unit) must be at least what the user agreed to.
    if (floor) check(terms.rate.num * BigInt(floor.den) >= BigInt(floor.num) * terms.rate.den,
      'Covenant guarantees a worse rate than the quote minus your slippage');
    check(Number(terms.deadline) * 1000 > Date.now(), 'Deadline is already in the past');
  } catch (e) {
    errs.push(`Could not verify the address: ${(e as Error).message}`);
  }
  return errs;
}

/**
 * The rate the covenant actually guarantees, as USD per BTC: a floor when selling BTC,
 * a ceiling when selling USD. Display only (floats are fine for prices).
 */
export function covenantPrice(view: SwapView, decimals: number): number {
  const num = Number(view.terms.rate.num), den = Number(view.terms.rate.den);
  const scale = 10 ** (8 - decimals);
  return view.terms.sell === BTC ? (num / den) * scale : (den / num) * scale;
}
