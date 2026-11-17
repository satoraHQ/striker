// Renew leaf and L1 exit for the v2 covenant spike (DESIGN.md §8, §13 items 9 and 11).
//
// Covenant tree (dual-VM model, §2):
//   leaf 0  covenant placeholder   [server, emulator ⊕ fillScript]
//   leaf 1  Renew (delegate)       [server, emulator ⊕ renewScript]   batch registration only
//   leaf 2  Owner                  [owner, server]
//   leaf 3  Exit (L1)              owner + CSV(seconds)
//
// The renew leaf follows the emulator's non-interactive delegate pattern
// (emulator test/delegate_test.go): OP_INSPECTINTENTMESSAGE gates it to batch
// `register` intents with no on-chain outputs and the delegate's tree-signer
// key as the only cosigner, and OP_TUNNEL pins the paired output (i-1 in an
// intent proof, because input 0 is the BIP322 message input) to the input's
// script, value and assets. The time gate uses OP_PUSHEXPIRY so renewal opens
// only `window` seconds before the VTXO expires.
import { EsploraProvider, EmulatorPacket, Estimator, Extension, OnchainWallet, Proof, Transaction, TreeSignerSession,
  Unroll, VtxoScript, arkade, asset, resolvePrevTxs, timelockToSequence, Batch,
  type Network, type SignerSession, type VirtualCoin, type IndexerProvider } from '@arkade-os/sdk';
import { RawTx, RawWitness, SigHash } from '@scure/btc-signer';
import { b64, covenantLeaf, covenantTree, exitLeaf, hex, ownerLeaf, regtest, unhex, waitFor, type Chain } from './harness.js';

export const utf8 = (s: string) => new TextEncoder().encode(s);

export const RENEW_LEAF = 1, OWNER_LEAF = 2, EXIT_LEAF = 3;
/** OP_TUNNEL flag bits (emulator README): 1 scriptPubKey, 2 value, 4 assets. */
const TUNNEL_SCRIPT = 1, TUNNEL_VALUE = 2, TUNNEL_ASSETS = 4;

export interface RenewLeafOptions {
  /** Hex (33-byte compressed) tree-signer key of the delegate: `hex(await session.getPublicKey())`. */
  cosigner: string;
  /** Seconds before VTXO expiry from which renewal is allowed (OP_PUSHEXPIRY - window ≤ now). */
  window: bigint;
  /**
   * Exact-value renewal when omitted (OP_TUNNEL value flag; needs a fee-free
   * intent, see DESIGN.md §8). Otherwise the paired output may be up to `maxFee`
   * sats smaller than the input so arkd's intent fee can be paid from the VTXO.
   */
  maxFee?: bigint;
}

/** Arkade script of the Renew leaf. Witness: []. */
export function renewScript({ cosigner, window, maxFee }: RenewLeafOptions): Uint8Array {
  const preserved = maxFee === undefined ? TUNNEL_SCRIPT | TUNNEL_VALUE | TUNNEL_ASSETS : TUNNEL_SCRIPT | TUNNEL_ASSETS;
  return arkade.ArkadeScript.encode([
    'PUSHEXPIRY', window, 'SUB', 'CHECKTIME', 'VERIFY',
    utf8('type'), 'INSPECTINTENTMESSAGE', 'VERIFY', utf8('register'), 'EQUALVERIFY',
    utf8('onchain_output_indexes'), 'INSPECTINTENTMESSAGE', 'VERIFY', utf8('[]'), 'EQUALVERIFY',
    utf8('cosigners_public_keys.0'), 'INSPECTINTENTMESSAGE', 'VERIFY', utf8(cosigner), 'EQUALVERIFY',
    utf8('cosigners_public_keys.1'), 'INSPECTINTENTMESSAGE', 'NOT', 'VERIFY', 'DROP',
    'PUSHCURRENTINPUTINDEX', '1SUB', preserved, 0, 'TUNNEL',
    ...(maxFee === undefined ? [] : [
      'VERIFY',
      'PUSHCURRENTINPUTINDEX', '1SUB', 'INSPECTOUTPUTVALUE',
      'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTVALUE', maxFee, 'SUB',
      'GREATERTHANOREQUAL',
    ] as const),
  ]);
}

export interface RenewableCovenant { tree: VtxoScript; fill: Uint8Array; renew: Uint8Array; owner: Uint8Array; exitDelay: bigint }
/** Builds the four-leaf covenant tree described at the top of this file. */
export function renewableCovenant(chain: Chain, owner: Uint8Array, fill: Uint8Array, renew: RenewLeafOptions, exitDelay = 1536n): RenewableCovenant {
  const renewBytes = renewScript(renew);
  const tree = covenantTree(chain, fill, [covenantLeaf(chain, renewBytes), ownerLeaf(chain, owner), exitLeaf(owner, exitDelay)]);
  return { tree, fill, renew: renewBytes, owner, exitDelay };
}

export interface RenewalOutput { script: Uint8Array; amount: bigint; assets: { assetId: string; amount: bigint }[] }
/** The output a faithful renewal declares: same script, same assets, value minus `fee`. */
export function preservedOutput(tree: VtxoScript, coin: VirtualCoin, fee = 0n): RenewalOutput {
  return { script: tree.pkScript, amount: BigInt(coin.value) - fee, assets: (coin.assets ?? []).map(a => ({ assetId: a.assetId, amount: BigInt(a.amount) })) };
}

export interface RenewalIntent {
  proof: Transaction;
  message: Proof.RegisterMessage;
  input: arkade.ArkadeExtendedVirtualCoin;
}
/**
 * Builds the unsigned intent proof registering `coin` into a batch through the
 * Renew leaf. Input 1 (the VTXO) carries the funding ark tx for OP_TUNNEL and
 * the emulator packet; `output` becomes proof output 0.
 */
export async function renewalIntent(chain: Chain, covenant: RenewableCovenant, coin: VirtualCoin, cosigner: string, output: RenewalOutput): Promise<RenewalIntent> {
  const prevTx = (await resolvePrevTxs([coin.txid], chain.indexer)).get(coin.txid);
  if (!prevTx) throw new Error('Missing funding ark tx');
  const leaf = covenant.tree.leaves[RENEW_LEAF]!;
  const input: arkade.ArkadeExtendedVirtualCoin & { prevTx: Uint8Array } = { ...coin, tapTree: covenant.tree.encode(), forfeitTapLeafScript: leaf,
    proofTapLeafScript: leaf, prevTx, arkadeScriptBytes: covenant.renew };
  const message: Proof.RegisterMessage = { type: 'register', onchain_output_indexes: [], valid_at: 0, expire_at: 0, cosigners_public_keys: [cosigner] };
  // Asset packet indexes refer to proof inputs (1 = the VTXO) and proof outputs (0).
  const packets = [
    ...(output.assets.length ? [asset.Packet.create(output.assets.map(a => asset.AssetGroup.create(asset.AssetId.fromString(a.assetId), null,
      [asset.AssetInput.create(1, BigInt(coin.assets!.find(c => c.assetId === a.assetId)!.amount))], [asset.AssetOutput.create(0, a.amount)], [])))] : []),
    EmulatorPacket.create([{ vin: 1, script: covenant.renew, witness: RawWitness.encode([]) }]),
  ];
  const proof = Proof.create(message, [input], [{ script: output.script, amount: output.amount }, Extension.create(packets).txOut()]);
  return { proof, message, input };
}

/** Asks the emulator to run the Renew leaf and co-sign the proof. Throws on a covenant miss. */
export async function approveRenewal(chain: Chain, intent: RenewalIntent) {
  return chain.emulator.submitIntent({ proof: b64(intent.proof.toPSBT()), message: intent.message });
}

/** arkd's intent fee for this renewal under its current fee program (`/v1/info`). */
export function expectedIntentFee(chain: Chain, coin: VirtualCoin, output: RenewalOutput): bigint {
  const estimator = new Estimator(chain.info.fees?.intentFee ?? {});
  const fee = estimator.evaluate([{ amount: BigInt(coin.value), type: coin.isSwept ? 'recoverable' : 'vtxo', weight: 0,
    birth: coin.createdAt, expiry: coin.expiresAt }], [], [{ amount: output.amount, script: hex(output.script) }], []);
  return BigInt(fee.satoshis);
}

/** Striker's tree-signer identity. The Renew leaf pins `cosigner`, so the key must be stable
 * across batches (`TreeSignerSession` takes a secret directly, SDK ≥ 0.5.4) — but each batch
 * needs a *fresh* session: a session's musig2 nonces must never be reused. `session()` makes one
 * per round from the same secret, so the cosigner stays the pinned key. The delegate holds no key
 * in the covenant; forfeits are signed by arkd and the emulator. */
export interface Delegate { secret: Uint8Array; session: () => SignerSession; cosigner: string }
export async function delegate(treeSignerSecret: Uint8Array): Promise<Delegate> {
  const session = () => new TreeSignerSession(treeSignerSecret);
  return { secret: treeSignerSecret, session, cosigner: hex(await session().getPublicKey()) };
}

/**
 * Registers an emulator-approved renewal with arkd and drives the batch as the
 * delegate (tree cosigner + finalization through the emulator). Resolves with
 * the commitment txid. Mirrors `Wallet.settle`: the event stream is primed
 * before registration so a round starting immediately is not missed.
 */
export async function renewThroughBatch(chain: Chain, striker: Delegate, intent: RenewalIntent, approvedProof: string, network: Network) {
  const abort = new AbortController();
  const topics = [striker.cosigner, `${intent.input.txid}:${intent.input.vout}`];
  const stream = chain.ark.getEventStream(abort.signal, topics);
  const first = stream.next();
  void first.catch(() => {});
  const primed = (async function* () { const f = await first; if (!f.done) yield f.value; yield* stream; })();
  try {
    const intentId = await chain.ark.registerIntent({ proof: approvedProof, message: intent.message });
    const handler = arkade.createArkadeBatchHandler(intentId, [intent.input], undefined, approvedProof, intent.message,
      striker.session(), chain.ark, chain.emulator, network);
    return await Batch.join(primed, handler, { abortController: abort });
  } finally { abort.abort(); }
}

/** Waits for the batch leaf that renewed `spent` at the covenant script. */
export function renewedCoin(chain: Chain, tree: VtxoScript, spent: VirtualCoin, commitmentTxid: string) {
  return waitFor(async () => {
    const { vtxos } = await chain.indexer.getVtxos({ scripts: [hex(tree.pkScript)] });
    return vtxos.find(v => v.commitmentTxIds?.includes(commitmentTxid) && !(v.txid === spent.txid && v.vout === spent.vout) && !v.isSpent);
  }, 'renewed covenant coin', 60_000);
}

// ---------------------------------------------------------------- L1 exit (§13 item 11)

export interface UnrollReport { packages: { txid: string; parentVsize: number; childVsize: number }[]; waits: number }
/** Virtual size of a raw transaction hex (BIP141: (3 × stripped + total) / 4). */
export function vsize(rawHex: string) {
  const bytes = unhex(rawHex);
  const decoded = RawTx.decode(bytes);
  const stripped = RawTx.encode({ ...decoded, segwitFlag: undefined, witnesses: undefined }).length;
  return Math.ceil((3 * stripped + bytes.length) / 4);
}
/**
 * Unilaterally unrolls `coin` to L1 with the SDK's exit session, mining a
 * regtest block every few seconds so each 1C1P package confirms. The bumper
 * pays every package's fee from its own on-chain coins.
 */
export async function unrollToL1(chain: Chain, coin: { txid: string; vout: number }, bumper: OnchainWallet, explorer: EsploraProvider): Promise<UnrollReport> {
  const session = await Unroll.Session.create(coin, bumper, explorer, chain.indexer as IndexerProvider);
  const report: UnrollReport = { packages: [], waits: 0 };
  const miner = setInterval(() => { try { regtest('mine', '1'); } catch {} }, 3_000);
  try {
    for await (const step of session) {
      if (step.type === Unroll.StepType.UNROLL) {
        const [parent, child] = step.pkg;
        report.packages.push({ txid: step.tx.id, parentVsize: vsize(parent), childVsize: vsize(child) });
      } else if (step.type === Unroll.StepType.WAIT) report.waits++;
    }
  } finally { clearInterval(miner); }
  return report;
}

/** Builds and signs the exit-leaf spend (owner key + CSV) of an unrolled covenant output. */
export function exitSpend(tree: VtxoScript, coin: { txid: string; vout: number; value: number }, ownerSecret: Uint8Array, exitDelay: bigint,
  to: string, network: Network, fee = 1_000n) {
  const tx = new Transaction({ version: 2 });
  tx.addInput({ txid: coin.txid, index: coin.vout, witnessUtxo: { script: tree.pkScript, amount: BigInt(coin.value) },
    tapLeafScript: [tree.leaves[EXIT_LEAF]!], sequence: timelockToSequence({ type: 'seconds', value: exitDelay }), sighashType: SigHash.DEFAULT });
  tx.addOutputAddress(to, BigInt(coin.value) - fee, network);
  if (!tx.signIdx(ownerSecret, 0)) throw new Error('Owner key did not sign the exit leaf');
  tx.finalize();
  return tx;
}

/**
 * Advances regtest median-time-past by at least `seconds` (BIP68 seconds-based
 * CSV is judged against MTP): mine 12 blocks at a mocked future time, then
 * restore the node clock.
 */
export function advanceMedianTime(seconds: number) {
  const info = JSON.parse(regtest('rpc', 'getblockchaininfo')) as { mediantime: number };
  const now = Math.floor(Date.now() / 1000);
  const target = Math.max(info.mediantime, now) + seconds;
  // bitcoind rejects blocks more than 2 h ahead of its clock. Each run moves the chain
  // forward by `seconds`, so back-to-back runs eventually stall mining until the wall
  // clock catches up.
  if (target - now > 7_000) throw new Error(`Regtest chain time is ${info.mediantime - now} s ahead of the wall clock; ` +
    `advancing another ${seconds} s would exceed bitcoind's 2 h future limit. Wait ${target - now - 7_000} s and rerun.`);
  try { regtest('rpc', 'setmocktime', String(target)); regtest('mine', '12'); }
  finally { regtest('rpc', 'setmocktime', '0'); }
  return target;
}
