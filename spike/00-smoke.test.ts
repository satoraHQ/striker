// Harness smoke test: fund a wallet, issue demo USD, lock sats + USD in a
// trivial covenant, spend it through the emulator, and see a covenant refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arkade, asset, buildOffchainTx, EmulatorPacket, Extension } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { addressOf, asInput, coinAt, connect, covenantTree, disposeWallets, exitLeaf, fundedWallet,
  issueDemoUsd, refused, submit } from './harness.js';

test('harness: covenant with sats + demo USD settles through the emulator', { timeout: 180_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const alice = await fundedWallet(chain, 10);
  const usd = await issueDemoUsd(alice);

  // Covenant: output 0 must have value >= 1000 sats. Nothing else.
  const script = arkade.ArkadeScript.encode([0, 'INSPECTOUTPUTVALUE', 1000, 'GREATERTHANOREQUAL']);
  const tree = covenantTree(chain, script, [exitLeaf(alice.publicKey, 1536n)]);
  const txid = await alice.wallet.send({ address: addressOf(chain, tree), amount: 5_000, assets: [{ assetId: usd, amount: 42n }] });
  const coin = await coinAt(chain, tree, txid);
  assert.equal(coin.value, 5_000);
  assert.deepEqual(coin.assets?.map(a => [a.assetId, BigInt(a.amount)]), [[usd, 42n]]);

  const build = (outValue: bigint) => {
    const assets = asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(usd), null,
      [asset.AssetInput.create(0, 42n)], [asset.AssetOutput.create(0, 42n)], [])]);
    const emu = EmulatorPacket.create([{ vin: 0, script, witness: RawWitness.encode([]) }]);
    return buildOffchainTx([asInput(coin, tree)], [
      { script: alice.pkScript, amount: outValue },
      ...(outValue < 5_000n ? [{ script: alice.pkScript, amount: 5_000n - outValue }] : []),
      Extension.create([assets, emu]).txOut(),
    ], chain.checkpoint);
  };

  const bad = build(500n);
  await refused(() => submit(chain, bad.arkTx, bad.checkpoints, [coin.txid]));
  const good = build(5_000n);
  const { txid: spent } = await submit(chain, good.arkTx, good.checkpoints, [coin.txid]);
  assert.match(spent, /^[0-9a-f]{64}$/);
});
