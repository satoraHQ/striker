// DESIGN.md §7 / §13 item 6 (size): how many outputs and covenant inputs fit in
// one offchain tx through the emulator before arkd's maxTxWeight (40 000 WU)
// or the emulator's compute limits refuse it. One emulator entry per input.
// Searches downwards from above the expected limit; refused attempts spend
// nothing, so the first accepted size is the maximum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachPrevArkTxs, Transaction, type VtxoScript } from '@arkade-os/sdk';
import { addressOf, b64, coinAt, connect, covenantTree, disposeWallets, exitLeaf, fundedWallet, unb64, type Chain } from './harness.js';
import { beforeExpiryOffchainOnly, emulatorLog, spend, trivial } from './emulator-behaviour.js';

type Coin = { txid: string; vout: number; value: number };
function finalWeight(signedArkTx: string) {
  const tx = Transaction.fromPSBT(unb64(signedArkTx));
  try { tx.finalize(); return tx.weight; } catch { return NaN; }
}
/** Submits inputs → outputs; times only the emulator call. */
async function attempt(chain: Chain, inputs: { coin: Coin; tree: VtxoScript; script: Uint8Array }[], outputs: { script: Uint8Array; amount: bigint }[]) {
  const tx = spend(chain, inputs, outputs);
  await attachPrevArkTxs(tx.arkTx, inputs.map(i => i.coin.txid), chain.indexer);
  const t0 = performance.now();
  const res = await chain.emulator.submitTx(b64(tx.arkTx.toPSBT()), tx.checkpoints.map(c => b64(c.toPSBT())));
  return { ms: performance.now() - t0, txid: Transaction.fromPSBT(unb64(res.signedArkTx)).id, weight: finalWeight(res.signedArkTx) };
}
async function largest(from: number, run: (n: number) => ReturnType<typeof attempt>) {
  const logStart = emulatorLog().length;
  for (let n = from; n > 0; n--) {
    try {
      const ok = await run(n);
      // Other suites share the emulator; keep only the refusal kinds this search can cause.
      const reasons = new Set(emulatorLog().slice(logStart).flatMap(l =>
        /TX_TOO_LARGE \(46\): ark tx weight is too high|exceeded (request )?execution limit of \d+/.exec(l)?.[0] ?? []));
      return { n, ...ok, reasons: [...reasons].join('; ') };
    } catch { /* refused: try one smaller */ }
  }
  throw new Error('nothing fits');
}

test('size: max outputs and covenant inputs per offchain tx', { timeout: 900_000 }, async t => {
  t.after(disposeWallets);
  const chain = await connect();
  const erin = await fundedWallet(chain, 44, 300_000);
  const tree = covenantTree(chain, trivial, [exitLeaf(erin.publicKey, 1536n)]);
  const total = 200_000, PIECE = 400;
  const coin = await coinAt(chain, tree, await erin.wallet.send({ address: addressOf(chain, tree), amount: total }));

  // 1. Fan out: one covenant input, K outputs back to the covenant (rest on output 0).
  const out = await largest(260, k => attempt(chain, [{ coin, tree, script: trivial }],
    Array.from({ length: k }, (_, i) => ({ script: tree.pkScript, amount: BigInt(i === 0 ? total - PIECE * (k - 1) : PIECE) }))));
  t.diagnostic(`max outputs (1 covenant input): ${out.n}; ${out.weight} WU; emulator ${out.ms.toFixed(0)} ms; refusals: ${out.reasons}`);

  // 2. Fan in: M trivial-covenant inputs, one output.
  const pieces = Array.from({ length: out.n - 1 }, (_, i) => ({ txid: out.txid, vout: i + 1, value: PIECE }));
  const inp = await largest(120, m => attempt(chain, pieces.slice(0, m).map(c => ({ coin: c, tree, script: trivial })),
    [{ script: erin.pkScript, amount: BigInt(PIECE * m) }]));
  t.diagnostic(`max covenant inputs (1 output): ${inp.n}; ${inp.weight} WU; emulator ${inp.ms.toFixed(0)} ms; refusals: ${inp.reasons}`);

  // 3. Inputs gated with OP_INSPECTINTENTMESSAGE (the late-submission fix): the
  // emulator's request-wide budget allows 4 × 16 = 64 executions per tx.
  const gatedScript = beforeExpiryOffchainOnly(Math.floor(Date.now() / 1000) + 3600);
  const gated = covenantTree(chain, gatedScript, [exitLeaf(erin.publicKey, 1536n)]);
  const rest = { txid: out.txid, vout: 0, value: total - PIECE * (out.n - 1) };
  const GATED = 70;
  const split = await attempt(chain, [{ coin: rest, tree, script: trivial }],
    Array.from({ length: GATED }, (_, i) => ({ script: gated.pkScript, amount: BigInt(i === 0 ? rest.value - PIECE * (GATED - 1) : PIECE) })));
  const gatedCoins = Array.from({ length: GATED - 1 }, (_, i) => ({ txid: split.txid, vout: i + 1, value: PIECE }));
  const g = await largest(GATED - 1, m => attempt(chain, gatedCoins.slice(0, m).map(c => ({ coin: c, tree: gated, script: gatedScript })),
    [{ script: erin.pkScript, amount: BigInt(PIECE * m) }]));
  t.diagnostic(`max intent-gated covenant inputs: ${g.n}; ${g.weight} WU; emulator ${g.ms.toFixed(0)} ms; refusals: ${g.reasons}`);
  assert.equal(g.n, 64);
});
