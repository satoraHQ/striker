// DESIGN §14 open question: does arkd reject an offchain tx that leaves an input's asset out
// of the asset packet? And are the covenants that rely on it sound? Keys 100–109.
//
// Covenants only see the tx's own asset packet (emulator pkg/arkade/asset_opcodes.go:423-543,
// tunnel.go:102-127). These tests show arkd pins that packet to the spent VTXOs' real assets,
// both for plain wallet spends sent straight to arkd and for covenant spends the emulator has
// already co-signed. See asset-claims.ts for the arkd source rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinsAt, disposeWallets, fundedWallet, issueDemoUsd, publicKey, refused, rejectedWith, walletCoins, connect, type Chain, type TestWallet } from './harness.js';
import { assetsOf, BTC, fill, outputAt, planFill, submitViaEmulator, swapCovenant, swapSpend, walletSpend, type CoinLike, type Spend } from './swap.js';
import { ANYONE, probeCovenant, rawViaArkd, rawViaEmulator, tunnelExcept, type Group, type RawOut } from './asset-claims.js';

const now = () => BigInt(Math.floor(Date.now() / 1000));
const amountOf = (c: CoinLike, id: string) => assetsOf(c)[id] ?? 0n;

/** Tops a deterministic wallet up to `sats` (reruns reuse it instead of draining the faucet). */
async function ensureFunded(chain: Chain, n: number, sats: number) {
  const w = await fundedWallet(chain, n, 0);
  const have = (await coinsAt(chain, w)).filter(c => !c.assets?.length).reduce((s, c) => s + c.value, 0);
  return have >= sats ? w : fundedWallet(chain, n, sats - have);
}

/** Spends `inputs` (all of `w`'s) into `planned` outputs, declaring every input asset exactly;
 * whatever isn't planned (sats and assets) goes to a change output for `w`. */
async function split(chain: Chain, w: TestWallet, inputs: CoinLike[], planned: (RawOut & { assets?: Record<string, bigint> })[]) {
  const total: Record<string, bigint> = {};
  for (const c of inputs) for (const [id, a] of Object.entries(assetsOf(c))) total[id] = (total[id] ?? 0n) + a;
  const sats = inputs.reduce((s, c) => s + BigInt(c.value), 0n) - planned.reduce((s, o) => s + o.amount, 0n);
  if (sats < chain.dust) throw new Error('not enough sats for the split');
  const change = planned.length;
  const groups: Group[] = Object.entries(total).map(([id, sum]) => {
    const outputs: [number, bigint][] = planned.flatMap((o, j) => o.assets?.[id] ? [[j, o.assets[id]!] as [number, bigint]] : []);
    const rest = sum - outputs.reduce((s, [, a]) => s + a, 0n);
    if (rest < 0n) throw new Error(`not enough ${id}`);
    if (rest > 0n) outputs.push([change, rest]);
    return { asset: id, inputs: inputs.flatMap((c, i) => amountOf(c, id) ? [[i, amountOf(c, id)] as [number, bigint]] : []), outputs };
  });
  const spends = inputs.map(c => walletSpend({ ...(c as Parameters<typeof walletSpend>[0]), ...w.leaves }, w.identity));
  const txid = await rawViaArkd(chain, spends, [...planned, { script: w.pkScript, amount: sats }], groups);
  return { txid, change };
}

test('asset claims: arkd pins the packet to the spent VTXOs (DESIGN §14)', { timeout: 600_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const D = chain.dust;
  const W = await ensureFunded(chain, 100, 300_000);
  const M = await ensureFunded(chain, 101, 150_000);
  const A = await issueDemoUsd(chain, W, 10_000_000n);
  const B = await issueDemoUsd(chain, W, 10_000_000n);

  const anyone = probeCovenant(chain, ANYONE, W.publicKey);
  const tunnel = probeCovenant(chain, tunnelExcept(A), W.publicKey);
  const wallet = (c: CoinLike): Spend => walletSpend({ ...(c as Parameters<typeof walletSpend>[0]), ...W.leaves }, W.identity);
  const at = (p: Uint8Array) => ({ script: p });

  // One split tx lays out every coin the suite needs.
  const all = await walletCoins(chain, W);
  const inputs = [...all.filter(c => amountOf(c, A) || amountOf(c, B)),
    ...all.filter(c => !c.assets?.length).sort((x, y) => y.value - x.value)];
  const layout = [
    { ...at(W.pkScript), amount: D, assets: { [A]: 1_000n, [B]: 2_000n } },               // 0 both
    { ...at(W.pkScript), amount: D, assets: { [B]: 3_000n } },                            // 1 onlyB
    { ...at(W.pkScript), amount: 5_000n },                                                 // 2 plain sats
    { ...at(anyone.tree.pkScript), amount: 20_000n, assets: { [A]: 1_000n, [B]: 2_000n } }, // 3 covenant both
    { ...at(anyone.tree.pkScript), amount: 20_000n, assets: { [B]: 3_000n } },             // 4 covenant onlyB
    { ...at(tunnel.tree.pkScript), amount: 20_000n, assets: { [A]: 1_000n, [B]: 2_000n } }, // 5 offer-style TUNNEL
    { ...at(M.pkScript), amount: D, assets: { [A]: 1_000_000n } },                       // 6 maker's A
    { ...at(W.pkScript), amount: 60_000n, assets: { [B]: 500n } },                          // 7 BTC deposit funding (+ junk B)
  ];
  const chosen: CoinLike[] = [];
  const need = layout.reduce((s, o) => s + o.amount, 0n) + D;
  for (const c of inputs) { chosen.push(c); if (chosen.reduce((s, x) => s + BigInt(x.value), 0n) >= need && chosen.some(x => amountOf(x, A)) && chosen.some(x => amountOf(x, B))) break; }
  const { txid: setup } = await split(chain, W, chosen, layout);
  const coin = (vout: number) => outputAt(chain, setup, vout) as Promise<CoinLike>;
  const [both, onlyB, plain, covBoth, covOnlyB, offer, , funding] = await Promise.all(layout.map((_, i) => coin(i)));
  assert.equal(amountOf(both!, B), 2_000n);
  t.diagnostic(`A=${A} B=${B}`);

  const missing = (id: string, vin = 0) => `input ${vin} owns asset ${id} but it's not present in the packet`;
  const notInGroup = (id: string, vin = 0) => `input ${vin} owns asset ${id} but it's not present in the asset group inputs`;
  const mismatch = (id: string, declared: bigint, held: bigint, vin = 0) => `input ${vin} owns asset ${id} but amount mismatch: ${declared} != ${held}`;
  const note = (label: string, r: { message: string }) => t.diagnostic(`${label}: ${r.message}`);

  // Each variant runs twice: a plain wallet input straight to arkd (no emulator anywhere), and
  // an accept-all covenant input through the emulator (it co-signs, arkd still refuses).
  for (const path of ['arkd', 'emulator'] as const) {
    const via = path === 'arkd' ? rawViaArkd : rawViaEmulator;
    const spend = (c: CoinLike) => path === 'arkd' ? wallet(c) : anyone.spend(c);
    const [ab, b] = path === 'arkd' ? [both!, onlyB!] : [covBoth!, covOnlyB!];
    const out = (amount: bigint): RawOut[] => [{ script: W.pkScript, amount }];
    const v = BigInt(ab.value), vb = BigInt(b.value);

    await t.test(`${path}: (a) input holds A+B, packet lists only A → rejected`, async () => {
      note('a', await rejectedWith(`ASSET_NOT_FOUND (34): ${missing(B)}`, () =>
        via(chain, [spend(ab)], out(v), [{ asset: A, inputs: [[0, 1_000n]], outputs: [[0, 1_000n]] }])));
    });
    await t.test(`${path}: (b) asset input, no asset packet at all → rejected`, async () => {
      note('b', await rejectedWith(/ASSET_VALIDATION_FAILED \(33\): asset packet not found in tx [0-9a-f]{64}/, () =>
        via(chain, [spend(ab)], out(v))));
    });
    await t.test(`${path}: (c) packet present (an issuance) but no group lists the input → rejected`, async () => {
      note('c', await rejectedWith(`ASSET_NOT_FOUND (34): ${missing(B)}`, () =>
        via(chain, [spend(b)], out(vb), [{ asset: null, outputs: [[0, 1n]] }])));
    });
    await t.test(`${path}: (c') B's group exists but lists only another input → rejected`, async () => {
      note("c'", await rejectedWith(`ASSET_INPUT_INVALID (35): ${notInGroup(B)}`, () =>
        via(chain, [spend(b), spend(ab)], out(vb + v),
          [{ asset: A, inputs: [[1, 1_000n]], outputs: [[0, 1_000n]] }, { asset: B, inputs: [[1, 2_000n]], outputs: [[0, 2_000n]] }])));
    });
    await t.test(`${path}: (d) declared amount higher than held → rejected`, async () => {
      note('d', await rejectedWith(`ASSET_INPUT_INVALID (35): ${mismatch(A, 1_001n, 1_000n)}`, () =>
        via(chain, [spend(ab)], out(v), [{ asset: A, inputs: [[0, 1_001n]], outputs: [[0, 1_001n]] }, { asset: B, inputs: [[0, 2_000n]], outputs: [[0, 2_000n]] }])));
    });
    await t.test(`${path}: (d') claiming an asset on an input that holds none / holds another → rejected`, async () => {
      note("d' none", await rejectedWith('ASSET_INPUT_INVALID (35): asset input 1 references input 1 which does not contain any assets', () =>
        via(chain, [spend(ab), wallet(plain!)], out(v + BigInt(plain!.value)),
          [{ asset: A, inputs: [[0, 1_000n], [1, 5n]], outputs: [[0, 1_005n]] }, { asset: B, inputs: [[0, 2_000n]], outputs: [[0, 2_000n]] }])));
      note("d' other", await rejectedWith(`ASSET_INPUT_INVALID (35): asset input 0 references input with asset ${A} but asset not found in tx input 0`, () =>
        via(chain, [spend(b)], out(vb), [{ asset: B, inputs: [[0, 3_000n]], outputs: [[0, 3_000n]] }, { asset: A, inputs: [[0, 7n]], outputs: [[0, 7n]] }])));
    });
    await t.test(`${path}: (e) outputs declaring more than the inputs is a reissuance → rejected without the control asset`, async () => {
      note('e+', await rejectedWith(`CONTROL_ASSET_INVALID (37): asset ${A} does not have a control asset`, () =>
        via(chain, [spend(ab)], out(v), [{ asset: A, inputs: [[0, 1_000n]], outputs: [[0, 1_001n]] }, { asset: B, inputs: [[0, 2_000n]], outputs: [[0, 2_000n]] }])));
    });
    await t.test(`${path}: (e) assets only exist where declared: under-declared outputs burn the rest`, async () => {
      // Input fully claimed, 400 of 1 000 A declared on an output, B not given any output.
      const txid = await via(chain, [spend(ab)], out(v),
        [{ asset: A, inputs: [[0, 1_000n]], outputs: [[0, 400n]] }, { asset: B, inputs: [[0, 2_000n]] }]);
      const got = await outputAt(chain, txid, 0) as CoinLike;
      assert.equal(amountOf(got, A), 400n, '600 A burned');
      assert.equal(amountOf(got, B), 0n, 'all 2 000 B burned (a group with inputs and no outputs is valid)');
      assert.equal(BigInt(got.value), v, 'sats untouched');
    });
  }

  await t.test('swap BTC-sell: "no assets on the deposit" holds; omitting the junk asset is rejected by arkd', async () => {
    const swap = swapCovenant(chain, {
      receive: W.pkScript, refund: W.pkScript, feeScript: W.pkScript, sell: BTC, buy: A,
      rate: { num: 1n, den: 1n }, feeBps: 30n, deadline: now() + 25n, refundPubkey: publicKey(102),
      dust: D, exitDelay: 1536n,
    });
    // Deposit 20 000 sats + 500 B (like a wallet that sends an asset along by mistake) and a pure 20 000 sats.
    const { txid: dep } = await split(chain, W, [funding!], [
      { script: swap.tree.pkScript, amount: 20_000n, assets: { [B]: 500n } },
      { script: swap.tree.pkScript, amount: 20_000n },
    ]);
    const [dirty, clean] = [await outputAt(chain, dep, 0) as CoinLike, await outputAt(chain, dep, 1) as CoinLike];
    assert.equal(amountOf(dirty, B), 500n);
    // Honest packet (B declared on the deposit, sent on to the maker): the covenant's count check refuses.
    await refused(() => fill(chain, swap, dirty, M, planFill(swap, dirty)), 'OP_VERIFY failed');
    // Attack: leave B out of the packet so INSPECTINASSETCOUNT sees 0. The emulator co-signs; arkd refuses.
    note('swap omit', await rejectedWith(`ASSET_NOT_FOUND (34): ${missing(B)}`, () => fill(chain, swap, dirty, M, planFill(swap, dirty), { declared: {} })));
    // Control: the pure-sats deposit fills.
    const { txid } = await fill(chain, swap, clean, M, planFill(swap, clean));
    assert.ok(amountOf(await outputAt(chain, txid, 0) as CoinLike, A) > 0n);
    // The dirty deposit refunds after the deadline with its B intact (refund-anyone, TUNNEL flags 6).
    while (now() <= swap.terms.deadline + 1n) await new Promise(r => setTimeout(r, 1000));
    const r = await submitViaEmulator(chain, [swapSpend(swap, dirty, 'refundAnyone')], [{ script: W.pkScript, amount: 20_000n, assets: { [B]: 500n } }]);
    assert.equal(amountOf(await outputAt(chain, r, 0) as CoinLike, B), 500n);
  });

  await t.test('offer "other assets preserved" (TUNNEL flags 5, A excepted) holds; omitting B is rejected by arkd', async () => {
    const v = BigInt(offer!.value);
    const self = { script: tunnel.tree.pkScript };
    // Covenant-level: B declared on the input and moved to a taker → the covenant refuses.
    await refused(() => rawViaEmulator(chain, [tunnel.spend(offer!)], [{ ...self, amount: v - D }, { script: W.pkScript, amount: D }],
      [{ asset: A, inputs: [[0, 1_000n]], outputs: [[0, 1_000n]] }, { asset: B, inputs: [[0, 2_000n]], outputs: [[0, 1_000n], [1, 1_000n]] }]),
    'selected output does not preserve source assets');
    // Burn: B omitted on both sides → TUNNEL sees B = 0 = 0 and passes; arkd refuses.
    note('offer burn', await rejectedWith(`ASSET_NOT_FOUND (34): ${missing(B)}`, () =>
      rawViaEmulator(chain, [tunnel.spend(offer!)], [{ ...self, amount: v }], [{ asset: A, inputs: [[0, 1_000n]], outputs: [[0, 1_000n]] }])));
    // Theft: B left off the input, declared on the taker's output → TUNNEL passes; arkd refuses.
    note('offer steal', await rejectedWith(`ASSET_INPUT_INVALID (35): ${notInGroup(B)}`, () =>
      rawViaEmulator(chain, [tunnel.spend(offer!)], [{ ...self, amount: v - D }, { script: W.pkScript, amount: D }],
        [{ asset: A, inputs: [[0, 1_000n]], outputs: [[0, 1_000n]] }, { asset: B, outputs: [[1, 2_000n]] }])));
    // Honest self-spend keeping B (A may change: here it moves 1 to the taker).
    const txid = await rawViaEmulator(chain, [tunnel.spend(offer!)], [{ ...self, amount: v - D }, { script: W.pkScript, amount: D }],
      [{ asset: A, inputs: [[0, 1_000n]], outputs: [[0, 999n], [1, 1n]] }, { asset: B, inputs: [[0, 2_000n]], outputs: [[0, 2_000n]] }]);
    const kept = await outputAt(chain, txid, 0) as CoinLike;
    assert.equal(amountOf(kept, B), 2_000n);
  });
});
