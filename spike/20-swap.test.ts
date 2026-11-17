// Spike items 7 (taker dust) and 8 (swap covenant). Keys 60–79.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, disposeWallets, fundedWallet, issueDemoUsd, publicKey, refused, rejectedWith, secret } from './harness.js';
import { SingleKey } from '@arkade-os/sdk';
import { BTC, deposit, fill, fillMany, outputAt, planFill, submitViaArkd, submitViaEmulator, swapCovenant, swapSpend, type SwapTerms } from './swap.js';

// $100,000 / BTC with an 8-decimal USD: 1 sat = 100_000 USD base units.
const BTC_USD = { num: 100_000n, den: 1n };
const USD_BTC = { num: 1n, den: 100_000n };
const now = () => BigInt(Math.floor(Date.now() / 1000));
const usdOf = (v: { assets?: { assetId: string; amount: unknown }[] }, id: string) =>
  BigInt(String(v.assets?.find(a => a.assetId === id)?.amount ?? 0));
/** Covenant refusal whose emulator error names the failing check (see `fillScript`'s failure classes). */
const refusedWith = (text: string, fn: () => Promise<unknown>) => refused(fn, text);

test('swap covenant (DESIGN §5) and taker dust (§6)', { timeout: 900_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const D = chain.dust;
  const maker = await fundedWallet(chain, 60, 8_000_000);
  const user = await fundedWallet(chain, 61, 3_000_000);
  const striker = await fundedWallet(chain, 64, 0);
  const refundKey = SingleKey.fromPrivateKey(secret(63));
  const usd = await issueDemoUsd(chain, maker);
  // Give the user some USD for the sell-USD direction.
  await maker.wallet.send({ address: user.address, amount: Number(D), assets: [{ assetId: usd, amount: 10_000n * 100_000_000n }] });

  const terms = (over: Partial<SwapTerms>): SwapTerms => ({
    receive: user.pkScript, refund: user.pkScript, feeScript: striker.pkScript,
    sell: BTC, buy: usd, rate: BTC_USD, feeBps: 30n, deadline: now() + 600n,
    refundPubkey: publicKey(63), dust: D, exitDelay: 1536n, ...over,
  });

  await t.test('BTC→USD: below min_rate and short/missing fee refused, at min_rate fills exactly', async () => {
    const swap = swapCovenant(chain, terms({}));
    const coin = await deposit(chain, user, swap, 200_123);
    const plan = planFill(swap, coin);
    const A = 200_123n - D, F = (A * 30n + 9_999n) / 10_000n;
    assert.equal(plan.fee!.amount, F);
    assert.equal(plan.receive.assets![usd], (A - F) * 100_000n);

    const below = { ...plan, receive: { ...plan.receive, assets: { [usd]: plan.receive.assets![usd]! - 1n } } };
    await refusedWith('OP_VERIFY failed', () => fill(chain, swap, coin, maker, below));
    const shortFee = { ...plan, fee: { ...plan.fee!, amount: F - 1n } };
    await refusedWith('false stack entry', () => fill(chain, swap, coin, maker, shortFee));
    // No fee output: the witness can only point at some other output, whose script differs.
    const noFee = { receive: plan.receive, feeIndexOverride: 1 };
    await refusedWith('OP_EQUALVERIFY failed', () => fill(chain, swap, coin, maker, noFee));

    const { txid } = await fill(chain, swap, coin, maker, plan);
    const got = await outputAt(chain, txid, 0);
    assert.equal(BigInt(got.value), D, 'receive carries exactly the taker-funded dust');
    assert.equal(usdOf(got, usd), (A - F) * 100_000n);
    const fee = await outputAt(chain, txid, 2);
    assert.equal(BigInt(fee.value), F);
  });

  await t.test('BTC→USD above min_rate: the improvement goes to the user', async () => {
    const swap = swapCovenant(chain, terms({}));
    const coin = await deposit(chain, user, swap, 150_000);
    const better = planFill(swap, coin, { num: 101_000n, den: 1n });
    const atMin = planFill(swap, coin);
    assert.ok(better.receive.assets![usd]! > atMin.receive.assets![usd]!);
    const { txid } = await fill(chain, swap, coin, maker, better);
    assert.equal(usdOf(await outputAt(chain, txid, 0), usd), better.receive.assets![usd]);
  });

  await t.test('USD→BTC: below min_rate refused; at and above min_rate fill; own carrier returned', async () => {
    const swap = swapCovenant(chain, terms({ sell: usd, buy: BTC, rate: USD_BTC }));
    const U = 1_000n * 100_000_000n;                  // $1,000 → 1,000,000 sats at min_rate
    const coin = await deposit(chain, user, swap, Number(D), [{ assetId: usd, amount: U }]);
    assert.equal(usdOf(coin, usd), U);
    const plan = planFill(swap, coin);
    const F = (1_000_000n * 30n + 9_999n) / 10_000n;
    assert.equal(plan.receive.amount, D + 1_000_000n - F);
    const below = { ...plan, receive: { ...plan.receive, amount: plan.receive.amount - 1n } };
    await refusedWith('OP_VERIFY failed', () => fill(chain, swap, coin, maker, below));
    const { txid } = await fill(chain, swap, coin, maker, plan);
    assert.equal(BigInt((await outputAt(chain, txid, 0)).value), D + 1_000_000n - F);

    const coin2 = await deposit(chain, user, swap, Number(D), [{ assetId: usd, amount: U }]);
    const better = planFill(swap, coin2, { num: 101n, den: 10_000_000n });
    assert.equal(better.receive.amount, D + 1_010_000n - F);
    const { txid: txid2 } = await fill(chain, swap, coin2, maker, better);
    assert.equal(BigInt((await outputAt(chain, txid2, 0)).value), D + 1_010_000n - F);
  });

  await t.test('exact-out BTC→USD: unused sats return to refund_address in the fill', async () => {
    const want = 500n * 100_000_000n;                 // $500 = 500,000 sats at min_rate
    const swap = swapCovenant(chain, terms({ exactOut: want }));
    const coin = await deposit(chain, user, swap, 600_000);   // the user overpays
    const plan = planFill(swap, coin);
    const F = 1_500n, R = 600_000n - D - 500_000n - F;
    assert.equal(plan.refund!.amount, R);
    const short = { ...plan, refund: { ...plan.refund!, amount: R - 1n } };
    await refusedWith('script returned early', () => fill(chain, swap, coin, maker, short));
    const { txid } = await fill(chain, swap, coin, maker, plan);   // inputs [swap, maker]: refund at output 2
    assert.equal(usdOf(await outputAt(chain, txid, 0), usd), want);
    const refund = await outputAt(chain, txid, 2);
    assert.equal(refund.script, Buffer.from(user.pkScript).toString('hex'));
    assert.equal(BigInt(refund.value), R);
  });

  await t.test('exact-out USD→BTC: token change + taker dust return to refund_address', async () => {
    const want = 200_000n;
    const swap = swapCovenant(chain, terms({ sell: usd, buy: BTC, rate: USD_BTC, exactOut: want }));
    const U = 3_000n * 100_000_000n;
    const coin = await deposit(chain, user, swap, Number(D), [{ assetId: usd, amount: U }]);
    const plan = planFill(swap, coin);
    const F = 600n, sold = (want + F) * 100_000n;
    assert.equal(plan.receive.amount, want);           // carrier moved to the token change
    assert.deepEqual(plan.refund!.assets, { [usd]: U - sold });
    const { txid } = await fill(chain, swap, coin, maker, plan);
    assert.equal(BigInt((await outputAt(chain, txid, 0)).value), want);
    const change = await outputAt(chain, txid, 2);
    assert.equal(BigInt(change.value), D);
    assert.equal(usdOf(change, usd), U - sold);
  });

  await t.test('deadline: refund-anyone refused before, fill refused after, refund-anyone after', async () => {
    const swap = swapCovenant(chain, terms({ sell: usd, buy: BTC, rate: USD_BTC, deadline: now() + 12n }));
    const U = 10n * 100_000_000n;
    const tokens = await deposit(chain, user, swap, Number(D), [{ assetId: usd, amount: U }]);
    const sats = await deposit(chain, user, swap, 7_777);            // wrong asset for this swap
    const refundAll = () => submitViaEmulator(chain,
      [swapSpend(swap, tokens, 'refundAnyone'), swapSpend(swap, sats, 'refundAnyone')],
      [{ script: user.pkScript, amount: D, assets: { [usd]: U } }, { script: user.pkScript, amount: 7_777n }]);
    await refusedWith('OP_NUMEQUALVERIFY failed', refundAll);
    const plan = planFill(swap, tokens);
    while (now() <= swap.terms.deadline + 1n) await new Promise(r => setTimeout(r, 1000));
    await refusedWith('OP_NUMEQUALVERIFY failed', () => fill(chain, swap, tokens, maker, plan));
    // Refund must keep value and assets: skimming one sat is refused.
    await refusedWith('does not preserve source value', () => submitViaEmulator(chain,
      [swapSpend(swap, tokens, 'refundAnyone')],
      [{ script: user.pkScript, amount: D - 1n, assets: { [usd]: U } }, { script: maker.pkScript, amount: 1n }]));
    const txid = await refundAll();
    const [a, b] = [await outputAt(chain, txid, 0), await outputAt(chain, txid, 1)];
    assert.equal(usdOf(a, usd), U);
    assert.equal(BigInt(a.value), D);
    assert.equal(BigInt(b.value), 7_777n);
  });

  await t.test('fee below dust is paid to the fee key\'s subdust (OP_RETURN) script', async () => {
    const swap = swapCovenant(chain, terms({}));
    const coin = await deposit(chain, user, swap, 20_000);
    const plan = planFill(swap, coin);
    assert.ok(plan.fee!.amount < D);
    const { txid } = await fill(chain, swap, coin, maker, plan);
    assert.equal(BigInt((await outputAt(chain, txid, 2)).value), plan.fee!.amount);
  });

  await t.test('refund-key: the user cancels before the deadline, arkd-only (no emulator)', async () => {
    const swap = swapCovenant(chain, terms({}));
    const coin = await deposit(chain, user, swap, 12_345);
    const txid = await submitViaArkd(chain, [{ ...swapSpend(swap, coin, 'refundKey'), signer: refundKey }],
      [{ script: user.pkScript, amount: 12_345n }]);
    assert.equal(BigInt((await outputAt(chain, txid, 0)).value), 12_345n);
  });

  await t.test('input amount is read from the coin: under-declaring tokens or sats is rejected', async () => {
    const swap = swapCovenant(chain, terms({ sell: usd, buy: BTC, rate: USD_BTC }));
    const U = 1_000n * 100_000_000n;
    const coin = await deposit(chain, user, swap, Number(D), [{ assetId: usd, amount: U }]);
    const lie = { ...coin, assets: [{ assetId: usd, amount: U / 2n }] };
    // A consistent packet that claims the deposit held half: the user would get half the sats
    // and the other half of the tokens would be burned or land with the maker.
    // The emulator runs the script on the lie (and co-signs); arkd then rejects the packet.
    await rejectedWith('ASSET_INPUT_INVALID', () => fill(chain, swap, coin, maker, planFill(swap, lie), { declared: { [usd]: U / 2n } }));
    const { txid } = await fill(chain, swap, coin, maker, planFill(swap, coin));
    assert.ok(txid);

    // Same for sats: claim the BTC deposit is 1,000 sats smaller than it is.
    const btcSwap = swapCovenant(chain, terms({}));
    const sats = await deposit(chain, user, btcSwap, 300_000);
    const small = { ...sats, value: sats.value - 1_000 };
    // The emulator checks the PSBT prevout against the previous ark tx before running any script.
    await rejectedWith('prevout tx value mismatch', () => fill(chain, btcSwap, small, maker, planFill(btcSwap, small)));
  });

  await t.test('batching: two deposits fill in one tx; index pairing stops them sharing a receive output', async () => {
    const swap = swapCovenant(chain, terms({}));
    const [a, b] = [await deposit(chain, user, swap, 100_000), await deposit(chain, user, swap, 110_000)];
    const [pa, pb] = [planFill(swap, a), planFill(swap, b)];
    // Striker pays the user once for both deposits (one receive output carrying a's amount).
    const shared = { ...pb, receive: { ...pa.receive } };
    await refusedWith('OP_EQUALVERIFY failed', () => fillMany(chain, [{ swap, coin: a, plan: pa }, { swap, coin: b, plan: shared }], maker,
      outs => outs.filter(o => o !== shared.receive)));
    const fee = { script: striker.pkScript, amount: pa.fee!.amount + pb.fee!.amount };   // one shared fee output
    const { txid } = await fillMany(chain, [{ swap, coin: a, plan: { ...pa, fee } }, { swap, coin: b, plan: { ...pb, fee } }], maker);
    assert.equal(usdOf(await outputAt(chain, txid, 0), usd), pa.receive.assets![usd]);
    assert.equal(usdOf(await outputAt(chain, txid, 1), usd), pb.receive.assets![usd]);
  });

  await t.test('taker dust (§13 item 7): sell all but dust, buy back with the whole token VTXO', async () => {
    const holder = await fundedWallet(chain, 62, 0);           // only ever holds the bought token VTXO
    const S = 200_000n;
    const buy = swapCovenant(chain, terms({ receive: holder.pkScript }));
    const coin = await deposit(chain, user, buy, Number(S));
    const p1 = planFill(buy, coin), F1 = p1.fee!.amount;
    const { txid } = await fill(chain, buy, coin, maker, p1);
    const tokenVtxo = await outputAt(chain, txid, 0);
    const X = (S - D - F1) * 100_000n;
    assert.equal(BigInt(tokenVtxo.value), D);
    assert.equal(usdOf(tokenVtxo, usd), X);

    // Holder pays the whole token VTXO (X USD + D sats) into a sell swap from its plain wallet.
    const sell = swapCovenant(chain, terms({ sell: usd, buy: BTC, rate: USD_BTC, receive: holder.pkScript, refund: holder.pkScript }));
    const coin2 = await deposit(chain, holder, sell, Number(D), [{ assetId: usd, amount: X }]);
    assert.equal(BigInt(coin2.value), D, 'the whole token VTXO moved, carrier included');
    const p2 = planFill(sell, coin2), F2 = p2.fee!.amount;
    assert.equal(p2.receive.amount, S - F1 - F2, 'own dust back on top of the bought sats');
    // Maker funds its USD carrier from the taker's dust: refused.
    const makerTakesDust = { ...p2, receive: { ...p2.receive, amount: p2.receive.amount - D } };
    await refusedWith('OP_VERIFY failed', () => fill(chain, sell, coin2, maker, makerTakesDust));
    const { txid: txid2 } = await fill(chain, sell, coin2, maker, p2);
    assert.equal(BigInt((await outputAt(chain, txid2, 0)).value), S - F1 - F2);
    assert.equal(BigInt((await outputAt(chain, txid2, 1)).value) >= D, true);
  });
});
