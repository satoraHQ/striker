// Offline tests for the browser's amount handling and its local verification of swap addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArkAddress } from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { BTC, hex, minRateFor, swapCovenant, termsToWire, type BookSnapshot, type CreateSwapRequest, type InfoResponse, type SwapTerms, type SwapView } from '@striker/core';
import { fmtCountdown, formatUnits, parseUnits, toMs } from '../src/units.ts';
import { addressError, pinnedEmulatorKey, rateFloor, verifySwap } from '../src/verify.ts';

test('parseUnits / formatUnits', () => {
  assert.equal(parseUnits('12.34', 8), 1_234_000_000n);
  assert.equal(parseUnits('1,000', 0), 1000n);
  assert.equal(parseUnits('.5', 2), 50n);
  assert.equal(parseUnits('1.5', 0), null);
  assert.equal(parseUnits('1.123456789', 8), null);
  for (const bad of ['', '.', 'abc', '1.2.3', '-1', '1e5']) assert.equal(parseUnits(bad, 8), null, bad);
  assert.equal(formatUnits(1_234_000_000n, 8, 2), '12.34');
  assert.equal(formatUnits('123456789', 0), '123,456,789');
  assert.equal(formatUnits(999_999_999n, 8, 2, 2), '10.00', 'rounds half up into the integer part');
  assert.equal(formatUnits(-150n, 2, 2), '-1.50');
  for (let i = 0; i < 500; i++) {
    const v = BigInt(Math.floor(Math.random() * 1e15));
    assert.equal(parseUnits(formatUnits(v, 8), 8), v, 'round trip');
  }
  assert.equal(fmtCountdown(0), '0:00');
  assert.equal(fmtCountdown(65_000), '1:05');
  assert.equal(fmtCountdown(3_725_000), '1:02:05');
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000);
});

// A regtest-like setup with the SDK-pinned regtest emulator key, as the page uses.
const server = schnorr.getPublicKey(new Uint8Array(32).fill(1));
const chain = { server, emulatorKey: pinnedEmulatorKey('regtest'), hrp: 'tark' };
const addr = (n: number) => new ArkAddress(server, new Uint8Array(32).fill(n), 'tark').encode();
const script = (a: string) => ArkAddress.decode(a).pkScript;
const ASSET = 'ab'.repeat(32) + '0000';
const info = { network: 'regtest', serverKey: hex(server), feeBps: '30', feeScript: hex(script(addr(9))), asset: { id: ASSET, ticker: 'USD', decimals: 8 } } as InfoResponse;
const refundKey = hex(schnorr.getPublicKey(new Uint8Array(32).fill(3)));
const req: CreateSwapRequest = { sell: 'BTC', mode: 'exactIn', amount: '100000', slippageBps: 50, receiveAddress: addr(5), refundAddress: addr(6), refundPubkey: refundKey };
const bid = { rateNum: '1', rateDen: '99500' };
const book = { asset: ASSET, asks: [{ rateNum: '100500', rateDen: '1' }], bids: [bid], updatedAt: 0 } as unknown as BookSnapshot;
const floor = rateFloor(book, 'BTC', info.feeBps, req.slippageBps)!;

function termsWith(t: Partial<SwapTerms> = {}): SwapTerms {
  return {
    receive: script(req.receiveAddress), refund: script(req.refundAddress), feeScript: script(addr(9)), sell: BTC, buy: ASSET,
    rate: minRateFor({ rateNum: 1n, rateDen: 99_500n }, 30n, 50n), feeBps: 30n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    refundPubkey: Uint8Array.from(Buffer.from(refundKey, 'hex')), dust: 330n, exitDelay: 1536n, ...t,
  };
}
function viewFor(t: Partial<SwapTerms> = {}, address?: string): SwapView {
  const terms = termsWith(t);
  return { id: 'x', address: address ?? swapCovenant(chain, terms).address, status: 'awaiting_deposit', terms: termsToWire(terms),
    deposit: { sats: '100000' } } as SwapView;
}

test('verifySwap accepts honest terms', () => {
  assert.deepEqual(verifySwap(viewFor(), info, req, 100_000n, floor), []);
});

test('verifySwap catches each kind of tampering, even with a consistent address', () => {
  const cases: [string, SwapView, RegExp][] = [
    ['rate', viewFor({ rate: { num: 9n, den: 1_000_000n } }), /worse rate/],
    ['receive', viewFor({ receive: script(addr(7)) }), /different receive/],
    ['refund', viewFor({ refund: script(addr(7)) }), /refunds to a different/],
    ['refund key', viewFor({ refundPubkey: new Uint8Array(32).fill(8) }), /different refund key/],
    ['fee script', viewFor({ feeScript: script(addr(7)) }), /unexpected script/],
    ['fee bps', viewFor({ feeBps: 100n }), /differs from the advertised/],
    ['direction', viewFor({ sell: ASSET, buy: BTC }), /wrong direction/],
    ['exact-out', viewFor({ exactOut: 10n * 100_000_000n }), /unexpectedly has an exact-out/],
    ['deadline', viewFor({ deadline: 1n }), /past/],
    ['address', viewFor({}, addr(4)), /does not match the covenant/],
  ];
  for (const [what, view, msg] of cases) {
    const errs = verifySwap(view, info, req, 100_000n, floor);
    assert.ok(errs.some(e => msg.test(e)), `${what}: ${JSON.stringify(errs)}`);
  }
  // A covenant built for another emulator key doesn't match the pinned one.
  const other = viewFor({}, swapCovenant({ ...chain, emulatorKey: schnorr.getPublicKey(new Uint8Array(32).fill(2)) }, termsWith()).address);
  assert.ok(verifySwap(other, info, req, 100_000n, floor).some(e => /does not match/.test(e)));
});

test('rateFloor uses the side that buys what the user sells, net of fee and slippage', () => {
  assert.deepEqual(rateFloor(book, 'BTC', '30', 50), (({ num, den }) => ({ num: String(num), den: String(den) }))(minRateFor({ rateNum: 1n, rateDen: 99_500n }, 30n, 50n)));
  assert.deepEqual(rateFloor(book, 'ASSET', '30', 0), (({ num, den }) => ({ num: String(num), den: String(den) }))(minRateFor({ rateNum: 100_500n, rateDen: 1n }, 30n, 0n)));
  assert.equal(rateFloor({ ...book, bids: [] }, 'BTC', '30', 50), undefined);
  // Exactly the floor passes; one unit worse fails.
  const r = minRateFor({ rateNum: 1n, rateDen: 99_500n }, 30n, 50n);
  assert.deepEqual(verifySwap(viewFor({ rate: r }), info, req, 100_000n, floor), []);
  assert.ok(verifySwap(viewFor({ rate: { num: r.num * 1_000_000n - 1n, den: r.den * 1_000_000n } }), info, req, 100_000n, floor).length === 1);
});

test('addressError', () => {
  assert.equal(addressError(addr(5), info), null);
  assert.equal(addressError('', info), 'Required');
  assert.equal(addressError('tark1xyz', info), 'Not a valid Ark address');
  assert.match(addressError(new ArkAddress(server, new Uint8Array(32).fill(5), 'ark').encode(), info)!, /tark1/);
  assert.match(addressError(new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(5), 'tark').encode(), info)!, /different Ark server/);
});
