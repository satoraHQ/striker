// DESIGN.md §13 item 2: late submission. `<expiry> OP_CHECKTIME OP_NOT` is
// evaluated by the emulator when it signs. Can a signature obtained before
// expiry be used after it?
//   - offchain, emulator is the finalizer ([server, emulator] leaf): no. The
//     emulator submits to arkd and finalizes inside the same SubmitTx call.
//   - offchain, emulator is NOT the last signer ([server, emulator, user]): yes.
//     The emulator returns its signatures and the user submits to arkd later.
//   - batch intent: yes. SubmitIntent returns the signed proof to the caller;
//     arkd accepts it until its expire_at (0 = never) and SubmitFinalization
//     signs the forfeit without re-running the script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachPrevArkTxs, Transaction, VtxoScript, type VirtualCoin } from '@arkade-os/sdk';
import { addressOf, b64, coinAt, coinsAt, connect, covenantTree, disposeWallets, exitLeaf, fundedWallet, hex,
  refused, unb64, waitFor, type Chain, type TestWallet } from './harness.js';
import { beforeExpiry, beforeExpiryOffchainOnly, emulatorSignedIntent, registerMessage, settleIntent, spend, submitHeldToArkd, submitSpend,
  threeKeyLeaf } from './emulator-behaviour.js';

const now = () => Math.floor(Date.now() / 1000);
async function fund(chain: Chain, w: TestWallet, tree: VtxoScript, amount: number): Promise<VirtualCoin> {
  const txid = await w.wallet.send({ address: addressOf(chain, tree), amount });
  return coinAt(chain, tree, txid);
}
const unspent = async (chain: Chain, tree: VtxoScript, coin: VirtualCoin) =>
  (await coinsAt(chain, tree)).some(v => v.txid === coin.txid && v.vout === coin.vout);

test('late submission: CHECKTIME expiry vs held emulator signatures', { timeout: 600_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const alice = await fundedWallet(chain, 40, 200_000);
  const bob = await fundedWallet(chain, 41, 0);

  // Funding four covenant coins takes a few seconds; leave room before expiry.
  const expiry = now() + 40;
  const script = beforeExpiry(expiry);
  const tree = covenantTree(chain, script, [exitLeaf(alice.publicKey, 1536n)]);
  const held3 = new VtxoScript([threeKeyLeaf(chain, script, bob.publicKey), exitLeaf(bob.publicKey, 1536n)]);
  const [timely, intentCoin, lateCoin, lateIntentCoin] = [
    await fund(chain, alice, tree, 10_000), await fund(chain, alice, tree, 10_000),
    await fund(chain, alice, tree, 10_000), await fund(chain, alice, tree, 10_000)];
  const heldCoin = await fund(chain, alice, held3, 10_000);
  assert.ok(now() < expiry - 5, `funding took too long (${expiry - now()} s left)`);

  // Before expiry: an offchain spend through the emulator succeeds.
  await submitSpend(chain, [{ coin: timely, tree, script }], [{ script: alice.pkScript, amount: 10_000n }]);

  // Before expiry: the emulator signs a batch intent and hands it back.
  const session = alice.identity.signerSession();
  const cosigner = hex(await session.getPublicKey());
  const intentOutputs = [{ script: alice.pkScript, amount: 9_800n }]; // regtest intent fee: 1 % of offchain inputs
  const heldIntent = await emulatorSignedIntent(chain, intentCoin, tree, script, intentOutputs, registerMessage(cosigner));
  assert.equal(Transaction.fromPSBT(unb64(heldIntent.proof)).getInput(1).tapScriptSig?.length, 1, 'emulator signed the proof');

  // Before expiry: with a [server, emulator, bob] leaf the emulator is not the
  // finalizer, so SubmitTx returns its signatures without touching arkd.
  const late3 = spend(chain, [{ coin: heldCoin, tree: held3, script }], [{ script: bob.pkScript, amount: 10_000n }]);
  await attachPrevArkTxs(late3.arkTx, [heldCoin.txid], chain.indexer);
  const heldSigs = await chain.emulator.submitTx(b64(late3.arkTx.toPSBT()), late3.checkpoints.map(c => b64(c.toPSBT())));
  assert.ok(await unspent(chain, held3, heldCoin), 'emulator did not submit the non-finalizer tx');

  // Wait past expiry on the emulator's clock (wall clock; same host as arkd).
  await new Promise(r => setTimeout(r, (expiry - now() + 2) * 1000));
  t.diagnostic(`expired: now=${now()} expiry=${expiry}`);

  // After expiry: fresh offchain spends and fresh intents are refused by the script.
  await refused(() => submitSpend(chain, [{ coin: lateCoin, tree, script }], [{ script: alice.pkScript, amount: 10_000n }]));
  await refused(() => emulatorSignedIntent(chain, lateIntentCoin, tree, script, intentOutputs, registerMessage(cosigner)));

  // After expiry: the held non-finalizer signatures are accepted by arkd.
  const lateTxid = await submitHeldToArkd(chain, heldSigs, late3.checkpoints, bob.identity);
  t.diagnostic(`late offchain tx accepted by arkd ${now() - expiry} s after expiry: ${lateTxid}`);
  await waitFor(async () => (await unspent(chain, held3, heldCoin)) ? undefined : true, 'held coin spent');

  // After expiry: the held intent registers and settles in a batch.
  const commitment = await settleIntent(chain, heldIntent, intentCoin, tree, script, alice.identity, session,
    [{ address: alice.address, amount: 9_800 }]);
  t.diagnostic(`late intent settled ${now() - expiry} s after expiry in commitment ${commitment}`);
  assert.ok(!(await unspent(chain, tree, intentCoin)), 'expired covenant coin was spent by the held intent');
});

test('late submission fix: an intent gate makes the fill leaf offchain-only', { timeout: 180_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const carol = await fundedWallet(chain, 42, 100_000);
  const script = beforeExpiryOffchainOnly(now() + 3600);
  const tree = covenantTree(chain, script, [exitLeaf(carol.publicKey, 1536n)]);
  const [a, b] = [await fund(chain, carol, tree, 10_000), await fund(chain, carol, tree, 10_000)];

  // The emulator refuses to sign a batch intent even before expiry ...
  const session = carol.identity.signerSession();
  const message = registerMessage(hex(await session.getPublicKey()));
  await refused(() => emulatorSignedIntent(chain, a, tree, script, [{ script: carol.pkScript, amount: 9_800n }], message));
  // ... while offchain fills (which the emulator submits itself) still work.
  await submitSpend(chain, [{ coin: b, tree, script }], [{ script: carol.pkScript, amount: 10_000n }]);
});
