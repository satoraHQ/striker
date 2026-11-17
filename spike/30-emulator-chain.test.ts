// DESIGN.md §13 item 10: off-chain chain depth. A covenant VTXO re-pays itself
// through the emulator N times with no batch in between (VTXO → tx1 → tx2 …),
// like a run of chained partial fills. Records the depth arkd accepts and the
// latency of each emulator SubmitTx (which validates, signs, submits to arkd
// and finalizes in one call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachPrevArkTxs, Transaction } from '@arkade-os/sdk';
import { addressOf, b64, coinAt, connect, covenantTree, disposeWallets, exitLeaf, fundedWallet, unb64 } from './harness.js';
import { percentile, spend, trivial } from './emulator-behaviour.js';

const DEPTH = Number(process.env.CHAIN_DEPTH ?? 1000);

test(`chain depth: ${DEPTH} chained offchain covenant txs without a batch`, { timeout: 1_800_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const dave = await fundedWallet(chain, 43, 100_000);
  const tree = covenantTree(chain, trivial, [exitLeaf(dave.publicKey, 1536n)]);
  const funding = await dave.wallet.send({ address: addressOf(chain, tree), amount: 20_000 });
  let coin = { ...(await coinAt(chain, tree, funding)) };

  const submitMs: number[] = [], prevMs: number[] = [];
  let failure: unknown;
  for (let depth = 1; depth <= DEPTH; depth++) {
    const tx = spend(chain, [{ coin, tree, script: trivial }], [{ script: tree.pkScript, amount: BigInt(coin.value) }]);
    const t0 = performance.now();
    await attachPrevArkTxs(tx.arkTx, [coin.txid], chain.indexer);
    const t1 = performance.now();
    try {
      const res = await chain.emulator.submitTx(b64(tx.arkTx.toPSBT()), tx.checkpoints.map(c => b64(c.toPSBT())));
      submitMs.push(performance.now() - t1);
      prevMs.push(t1 - t0);
      coin = { ...coin, txid: Transaction.fromPSBT(unb64(res.signedArkTx)).id, vout: 0 };
    } catch (e) { failure = e; t.diagnostic(`failed at depth ${depth}: ${e}`); break; }
    if (depth % 100 === 0) {
      const s = submitMs.slice(-100).sort((a, b) => a - b);
      t.diagnostic(`depth ${depth}: last-100 submit p50 ${percentile(s, 0.5).toFixed(0)} ms p95 ${percentile(s, 0.95).toFixed(0)} ms`);
    }
  }
  const s = [...submitMs].sort((a, b) => a - b), p = [...prevMs].sort((a, b) => a - b);
  t.diagnostic(`reached depth ${submitMs.length}; emulator SubmitTx p50 ${percentile(s, 0.5).toFixed(0)} ms, ` +
    `p95 ${percentile(s, 0.95).toFixed(0)} ms, max ${(s.at(-1) ?? NaN).toFixed(0)} ms; indexer prev-tx fetch p50 ${percentile(p, 0.5).toFixed(0)} ms`);
  const [last] = await chain.indexer.getVtxos({ outpoints: [{ txid: coin.txid, vout: 0 }] }).then(r => r.vtxos);
  t.diagnostic(`tip vtxo: preconfirmed=${last?.virtualStatus?.state} spent=${last?.isSpent}`);
  assert.equal(failure, undefined);
  assert.equal(submitMs.length, DEPTH);
});
