// DESIGN.md §13 item 9 (Renew leaf) and item 11 (L1 exit). Keys 80–99.
//
// Fee note: on this regtest stack arkd's intent fee program is
// `offchainInput: amount * 0.01` (no expiry waiver), so an exact-value OP_TUNNEL
// renewal cannot register. The suite therefore (a) proves the exact-value leaf
// on the emulator and records arkd's fee rejection, running the real batch only
// when the fee program evaluates to 0, and (b) settles a fee-capped variant
// through a real batch. To re-run (a) end to end, start the stack with the
// Mutinynet-style program, e.g. in .env.regtest:
//   ARK_OFFCHAIN_INPUT_FEE="inputType == 'vtxo' && expiry - now() > 518656.0 ? amount * 0.002 : 0.0"
// (applied by the regtest CLI via POST /v1/admin/intentFees; see spike/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArkError, EsploraProvider, Extension, EmulatorPacket, Intent, OnchainWallet, SingleKey, arkade, asset, buildOffchainTx } from '@arkade-os/sdk';
import { RawWitness, ScriptNum } from '@scure/btc-signer';
import { ESPLORA_URL, addressOf, asInput, coinAt, connect, covenantTree, disposeWallets, exitLeaf, fundedWallet, hex, issueDemoUsd,
  refused, regtest, secret, submit, waitFor } from './harness.js';
import { RENEW_LEAF, advanceMedianTime, approveRenewal, delegate, ensureEventSource, exitSpend, expectedIntentFee, preservedOutput,
  renewThroughBatch, renewableCovenant, renewalIntent, renewedCoin, unrollToL1, type RenewalOutput } from './renew.js';

ensureEventSource();
const WEEK = 7n * 86_400n;
const esplora = () => new EsploraProvider(ESPLORA_URL, { forcePolling: true, pollingInterval: 2000 });
// Placeholder for the fill rule: output 0 must carry at least 1000 sats.
const FILL = arkade.ArkadeScript.encode([0, 'INSPECTOUTPUTVALUE', 1000, 'GREATERTHANOREQUAL']);
const expiryOf = (coin: { expiresAt?: Date }) => { assert.ok(coin.expiresAt, 'regtest VTXOs expire by time'); return BigInt(Math.floor(coin.expiresAt.getTime() / 1000)); };

test('renew leaf (§13 item 9): Striker renews a covenant VTXO through a batch; misuse is refused', { timeout: 600_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const owner = await fundedWallet(chain, 80, 300_000);
  const usd = await issueDemoUsd(owner);
  // Striker: a separate key with no funds and no leaf in the covenant.
  const striker = await delegate(SingleKey.fromPrivateKey(secret(81)));
  const network = (await OnchainWallet.create(striker.identity, 'regtest', esplora())).network;
  const fund = async (covenant: ReturnType<typeof renewableCovenant>, sats: number, usdAmount?: bigint) => {
    const txid = await owner.wallet.send({ address: addressOf(chain, covenant.tree), amount: sats,
      assets: usdAmount ? [{ assetId: usd, amount: usdAmount }] : undefined });
    return coinAt(chain, covenant.tree, txid);
  };

  await t.test('OP_PUSHEXPIRY pushes the VTXO expiry the indexer reports', async () => {
    const script = arkade.ArkadeScript.encode(['PUSHEXPIRY', 'EQUAL']);
    const tree = covenantTree(chain, script, [exitLeaf(owner.publicKey, 1536n)]);
    const txid = await owner.wallet.send({ address: addressOf(chain, tree), amount: 2_000 });
    const coin = await coinAt(chain, tree, txid);
    const expiry = expiryOf(coin);
    const build = (claimed: bigint) => buildOffchainTx([asInput(coin, tree)], [{ script: owner.pkScript, amount: 2_000n },
      Extension.create([EmulatorPacket.create([{ vin: 0, script, witness: RawWitness.encode([ScriptNum().encode(claimed)]) }])]).txOut()], chain.checkpoint);
    const wrong = build(expiry + 1n);
    await refused(() => submit(chain, wrong.arkTx, wrong.checkpoints, [coin.txid]));
    const right = build(expiry);
    const { txid: spent } = await submit(chain, right.arkTx, right.checkpoints, [coin.txid]);
    assert.match(spent, /^[0-9a-f]{64}$/);
    t.diagnostic(`OP_PUSHEXPIRY == ${expiry} (${coin.expiresAt!.toISOString()}), ${Number(expiry) - Math.floor(Date.now() / 1000)} s ahead`);
  });

  // Exact-value leaf: the DESIGN.md §8 variant (renewal must be fee-free).
  const exact = renewableCovenant(chain, owner.publicKey, FILL, { cosigner: striker.cosigner, window: WEEK });
  const exactCoin = await fund(exact, 20_000, 42n);
  assert.equal(exactCoin.value, 20_000);
  assert.deepEqual(exactCoin.assets?.map(a => [a.assetId, BigInt(a.amount)]), [[usd, 42n]]);

  await t.test('the emulator approves an exact-value renewal proof and refuses every mutation', async () => {
    const good = preservedOutput(exact.tree, exactCoin);
    const approved = await approveRenewal(chain, await renewalIntent(chain, exact, exactCoin, striker.cosigner, good));
    assert.ok(approved.length > 0, 'emulator returned a co-signed proof');
    const mutations: [string, RenewalOutput][] = [
      ['value - 1', { ...good, amount: good.amount - 1n }],
      ['other script', { ...good, script: owner.pkScript }],
      ['assets - 1', { ...good, assets: [{ assetId: usd, amount: 41n }] }],
    ];
    for (const [label, output] of mutations) {
      const errors = await refused(async () => approveRenewal(chain, await renewalIntent(chain, exact, exactCoin, striker.cosigner, output)));
      t.diagnostic(`${label}: ${errors.at(-1)?.replace(/^.*error=/, '')}`);
    }
    // OP_TUNNEL's asset flag compares packet-local amounts only: a proof with
    // no asset packet at all passes the covenant. arkd refuses it instead
    // (`asset packet not found`), checked in the fee-capped subtest below.
    await approveRenewal(chain, await renewalIntent(chain, exact, exactCoin, striker.cosigner, { ...good, assets: [] }));
    t.diagnostic('assets dropped (no asset packet): approved by the emulator; conservation is enforced by arkd, not OP_TUNNEL');
    // Wrong cosigner, and a second cosigner, are refused by the intent-message gate.
    const other = await delegate(SingleKey.fromPrivateKey(secret(82)));
    await refused(async () => approveRenewal(chain, await renewalIntent(chain, exact, exactCoin, other.cosigner, good)));
    await refused(async () => {
      const intent = await renewalIntent(chain, exact, exactCoin, striker.cosigner, good);
      intent.message.cosigners_public_keys.push(other.cosigner);
      const outputs = Array.from({ length: intent.proof.outputsLength }, (_, i) => {
        const o = intent.proof.getOutput(i); return { script: o.script!, amount: o.amount! }; });
      intent.proof = Intent.create(intent.message, [intent.input], outputs);
      return approveRenewal(chain, intent);
    });
  });

  await t.test('off-chain (non-batch) spend through the renew leaf is refused', async () => {
    const assets = asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(usd), null, [asset.AssetInput.create(0, 42n)], [asset.AssetOutput.create(0, 42n)], [])]);
    const emu = EmulatorPacket.create([{ vin: 0, script: exact.renew, witness: RawWitness.encode([]) }]);
    const tx = buildOffchainTx([asInput(exactCoin, exact.tree, RENEW_LEAF)], [{ script: exact.tree.pkScript, amount: 20_000n }, Extension.create([assets, emu]).txOut()], chain.checkpoint);
    const errors = await refused(() => submit(chain, tx.arkTx, tx.checkpoints, [exactCoin.txid]));
    t.diagnostic(`offchain misuse: ${errors.at(-1)?.replace(/^.*error=/, '')}`);
  });

  await t.test('renewal before the window opens is refused (OP_PUSHEXPIRY time gate)', async () => {
    const early = renewableCovenant(chain, owner.publicKey, FILL, { cosigner: striker.cosigner, window: 1024n });
    const coin = await fund(early, 5_000);
    assert.ok(expiryOf(coin) - 1024n > BigInt(Math.floor(Date.now() / 1000)), 'window has not opened');
    await refused(async () => approveRenewal(chain, await renewalIntent(chain, early, coin, striker.cosigner, preservedOutput(early.tree, coin))));
  });

  await t.test('exact-value renewal: arkd fee program decides', async () => {
    const good = preservedOutput(exact.tree, exactCoin);
    const fee = expectedIntentFee(chain, exactCoin, good);
    const program = chain.info.fees?.intentFee?.offchainInput;
    t.diagnostic(`arkd offchainInput fee program: ${JSON.stringify(program)} → ${fee} sats for this input`);
    const intent = await renewalIntent(chain, exact, exactCoin, striker.cosigner, good);
    const approved = await approveRenewal(chain, intent);
    if (fee > 0n) {
      // The covenant passed (emulator co-signed); only arkd's fee check blocks registration.
      await assert.rejects(chain.ark.registerIntent({ proof: approved, message: intent.message }), (e: unknown) => {
        assert.ok(e instanceof ArkError, `ArkError expected, got ${String(e)}`);
        assert.match(`${e.name} ${e.message}`, /INSUFFICIENT_FEE/i);
        t.diagnostic(`arkd rejection: ${e.name}: ${e.message}`);
        return true;
      });
      t.diagnostic('exact-value batch renewal skipped: arkd charges a fee on this stack (see header for the fee-free re-run)');
      return;
    }
    const commitment = await renewThroughBatch(chain, striker, intent, approved, network);
    const renewed = await renewedCoin(chain, exact.tree, exactCoin, commitment);
    assert.equal(renewed.value, exactCoin.value);
    assert.equal(renewed.script, hex(exact.tree.pkScript));
    assert.deepEqual(renewed.assets?.map(a => [a.assetId, BigInt(a.amount)]), [[usd, 42n]]);
    assert.ok(expiryOf(renewed) > expiryOf(exactCoin), 'later expiry');
    assert.equal(renewed.isPreconfirmed, false);
  });

  await t.test('fee-capped renewal: Striker renews sats + USD through a real batch', async () => {
    // Allow arkd's fee to be taken from the VTXO, bounded by the covenant.
    const capped = renewableCovenant(chain, owner.publicKey, FILL, { cosigner: striker.cosigner, window: WEEK, maxFee: 250n });
    const coin = await fund(capped, 20_000, 42n);
    const fee = expectedIntentFee(chain, coin, preservedOutput(capped.tree, coin));
    assert.ok(fee <= 250n, `fee ${fee} exceeds the covenant cap; adjust maxFee for this fee program`);
    // Deducting more than the cap is refused.
    await refused(async () => approveRenewal(chain, await renewalIntent(chain, capped, coin, striker.cosigner, preservedOutput(capped.tree, coin, 251n))));
    // Dropping the asset packet passes the covenant but not arkd.
    const burning = await renewalIntent(chain, capped, coin, striker.cosigner, { ...preservedOutput(capped.tree, coin, fee), assets: [] });
    const burningProof = await approveRenewal(chain, burning);
    await assert.rejects(chain.ark.registerIntent({ proof: burningProof, message: burning.message }), (e: unknown) => {
      assert.ok(e instanceof ArkError, `ArkError expected, got ${String(e)}`);
      t.diagnostic(`arkd on a renewal without the asset packet: ${e.name}: ${e.message}`);
      return /ASSET/i.test(`${e.name} ${e.message}`);
    });
    const intent = await renewalIntent(chain, capped, coin, striker.cosigner, preservedOutput(capped.tree, coin, fee));
    const approved = await approveRenewal(chain, intent);
    const started = Date.now();
    const commitment = await renewThroughBatch(chain, striker, intent, approved, network);
    t.diagnostic(`batch ${commitment} settled in ${Math.round((Date.now() - started) / 1000)} s, fee ${fee} sats`);
    const renewed = await renewedCoin(chain, capped.tree, coin, commitment);
    assert.equal(BigInt(renewed.value), BigInt(coin.value) - fee);
    assert.equal(renewed.script, hex(capped.tree.pkScript));
    assert.deepEqual(renewed.assets?.map(a => [a.assetId, BigInt(a.amount)]), [[usd, 42n]]);
    assert.ok(expiryOf(renewed) > expiryOf(coin), `later expiry: ${renewed.expiresAt?.toISOString()} > ${coin.expiresAt?.toISOString()}`);
    assert.equal(renewed.isPreconfirmed, false);
    const old = (await chain.indexer.getVtxos({ scripts: [hex(capped.tree.pkScript)] })).vtxos.find(v => v.txid === coin.txid && v.vout === coin.vout);
    assert.equal(old?.settledBy, commitment);
    t.diagnostic(`renewed ${renewed.txid}:${renewed.vout} expires ${renewed.expiresAt?.toISOString()} (was ${coin.expiresAt?.toISOString()})`);
  });
});

test('L1 exit (§13 item 11): unroll a covenant VTXO and spend the exit leaf with the owner key', { timeout: 600_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const owner = await fundedWallet(chain, 90, 100_000);
  // Faucet-funded VTXOs sit on a chain of ~50 off-chain hops (every `ark send`
  // chains the faucet's change), so an exit from them would need ~100 packages.
  // Settle first: the covenant then hangs off a fresh batch leaf, the shape a
  // renewed offer VTXO has after one fill.
  const depthBefore = (await chain.indexer.getVtxoChain({ txid: (await owner.wallet.getVtxos())[0]!.txid, vout: (await owner.wallet.getVtxos())[0]!.vout })).chain.length;
  await owner.wallet.settle();
  await waitFor(async () => (await owner.wallet.getVtxos()).every(v => !v.isPreconfirmed) ? true : undefined, 'owner settlement');
  const usd = await issueDemoUsd(owner);
  const striker = await delegate(SingleKey.fromPrivateKey(secret(92)));
  const covenant = renewableCovenant(chain, owner.publicKey, FILL, { cosigner: striker.cosigner, window: WEEK, maxFee: 250n }, 1536n);
  const txid = await owner.wallet.send({ address: addressOf(chain, covenant.tree), amount: 30_000, assets: [{ assetId: usd, amount: 7n }] });
  const coin = await coinAt(chain, covenant.tree, txid);
  assert.equal(coin.isPreconfirmed, true, 'exit a pre-confirmed (off-chain) covenant VTXO');
  t.diagnostic(`faucet-funded VTXO chain depth before settling: ${depthBefore} virtual txs`);

  // The exit is paid by an on-chain wallet the owner controls (P2A fee bumping).
  const explorer = esplora();
  const bumper = await OnchainWallet.create(SingleKey.fromPrivateKey(secret(91)), 'regtest', explorer);
  const prior = await bumper.getBalance();
  regtest('faucet', bumper.address, '0.01', '--confirm');
  const before = await waitFor(async () => {
    const coins = await bumper.getCoins();
    const total = coins.reduce((sum, c) => sum + c.value, 0);
    return total >= prior + 1_000_000 && coins.every(c => c.status.confirmed) ? total : undefined;
  }, 'bumper funding', 60_000);
  regtest('mine', '1');

  const chainTxs = (await chain.indexer.getVtxoChain({ txid: coin.txid, vout: coin.vout })).chain;
  t.diagnostic(`virtual chain: ${chainTxs.map(c => c.type.replace('INDEXER_CHAINED_TX_TYPE_', '')).join(' → ')}`);
  const report = await unrollToL1(chain, coin, bumper, explorer);
  const after = await bumper.getBalance();
  t.diagnostic(`unrolled with ${report.packages.length} 1C1P packages (${report.packages.map(p => `${p.parentVsize}+${p.childVsize} vB`).join(', ')}), ` +
    `${report.waits} confirmations awaited, ${before - after} sats of fees paid by the bumper`);
  const status = await explorer.getTxStatus(coin.txid);
  assert.equal(status.confirmed, true, 'the ark tx holding the covenant output is confirmed');

  // Before the CSV delay the exit leaf is not final (the explorer hides bitcoind's reason; ask the node).
  const early = exitSpend(covenant.tree, coin, secret(90), 1536n, bumper.address, bumper.network);
  const verdict = (JSON.parse(regtest('rpc', 'testmempoolaccept', JSON.stringify([early.hex]))) as { allowed: boolean; 'reject-reason'?: string }[])[0]!;
  t.diagnostic(`early exit: allowed=${verdict.allowed} reason=${verdict['reject-reason']}`);
  assert.equal(verdict.allowed, false);
  assert.match(verdict['reject-reason'] ?? '', /non-BIP68-final/);

  const target = advanceMedianTime(1536 + 60);
  t.diagnostic(`median time advanced to ${new Date(target * 1000).toISOString()}`);
  const exit = exitSpend(covenant.tree, coin, secret(90), 1536n, bumper.address, bumper.network);
  assert.equal(exit.inputsLength, 1);
  await explorer.broadcastTransaction(exit.hex);
  regtest('mine', '1');
  await waitFor(async () => (await explorer.getTxStatus(exit.id)).confirmed ? true : undefined, 'exit confirmation', 60_000);
  t.diagnostic(`exit tx ${exit.id}: ${exit.vsize} vB, owner key only, ${coin.value - 1_000} sats to ${bumper.address}`);
  const unrolled = await waitFor(async () => {
    const { vtxos } = await chain.indexer.getVtxos({ scripts: [hex(covenant.tree.pkScript)] });
    const v = vtxos.find(v => v.txid === coin.txid && v.vout === coin.vout);
    return v?.isUnrolled ? v : undefined;
  }, 'indexer marks the coin unrolled', 30_000).catch(() => undefined);
  t.diagnostic(`indexer isUnrolled: ${unrolled ? 'yes' : 'not reported within 30 s'}`);
});
