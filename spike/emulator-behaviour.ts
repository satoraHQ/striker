// Helpers for the emulator-behaviour spike (DESIGN.md §13 items 2 and 10):
// expiry scripts, single-input covenant spends, emulator-signed intents held
// and settled later, and the non-finalizer offchain path.
import {
  arkade, attachPrevoutTxs, Batch, buildOffchainTx, EmulatorPacket, Extension, MultisigTapscript,
  networks, Proof, resolvePrevTxs, Transaction, VtxoScript, withPrevTxs, type Identity, type SignerSession, type VirtualCoin,
} from '@arkade-os/sdk';
import { Script } from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { TransactionOutput } from '@scure/btc-signer/psbt.js';
import { RawWitness } from '@scure/btc-signer';
import { asInput, b64, hex, submit, submitToArkd, unb64, type Chain } from './harness.js';

/** `<expiry> OP_CHECKTIME OP_NOT`: true only while the emulator clock is < expiry (DESIGN.md §3). */
export const beforeExpiry = (expiry: number) => arkade.ArkadeScript.encode([expiry, 'CHECKTIME', 'NOT']);
/** The DESIGN.md §3 expiry plus an offchain-only gate: the script fails when
 * the emulator evaluates it for a batch intent (OP_INSPECTINTENTMESSAGE hits),
 * so no emulator-signed intent proof can be obtained and held. */
export const beforeExpiryOffchainOnly = (expiry: number) => arkade.ArkadeScript.encode([
  new TextEncoder().encode('type'), 'INSPECTINTENTMESSAGE', 'NOT', 'VERIFY', 'DROP',
  expiry, 'CHECKTIME', 'NOT']);
/** The gate DESIGN.md §2 settles on: `OP_PUSHEXPIRY OP_DROP` fails on the emulator's on-chain
 * path (no VTXO expiry there: "OP_PUSHEXPIRY expiry not set"), the intent check fails on the
 * batch-intent path, leaving only the one-shot offchain SubmitTx. */
export const offchainOnlyGate = [
  'PUSHEXPIRY', 'DROP', new TextEncoder().encode('type'), 'INSPECTINTENTMESSAGE', 'NOT', 'VERIFY', 'DROP'] as const;
export const beforeExpiryGated = (expiry: number) => arkade.ArkadeScript.encode([...offchainOnlyGate, expiry, 'CHECKTIME', 'NOT']);
/** Trivial covenant: output 0 carries ≥ 1 sat. */
export const trivial = arkade.ArkadeScript.encode([0, 'INSPECTOUTPUTVALUE', 1, 'GREATERTHANOREQUAL']);

export const emulatorOutput = (entries: { vin: number; script: Uint8Array }[]) =>
  Extension.create([EmulatorPacket.create(entries.map(e => ({ ...e, witness: RawWitness.encode([]) })))]).txOut();

function leafOf(tree: VtxoScript) {
  const leaf = tree.leaves[0];
  if (!leaf) throw new Error('Missing covenant leaf');
  return leaf;
}

type Spendable = Pick<VirtualCoin, 'txid' | 'vout' | 'value'>;
/** An offchain tx spending each coin through covenant leaf 0 of its tree. */
export function spend(chain: Chain, inputs: { coin: Spendable; tree: VtxoScript; script: Uint8Array }[], outputs: TransactionOutput[]) {
  return buildOffchainTx(inputs.map(i => asInput(i.coin, i.tree)),
    [...outputs, emulatorOutput(inputs.map((i, vin) => ({ vin, script: i.script })))], chain.checkpoint);
}
export function submitSpend(chain: Chain, inputs: { coin: Spendable; tree: VtxoScript; script: Uint8Array }[], outputs: TransactionOutput[]) {
  const tx = spend(chain, inputs, outputs);
  return submit(chain, tx.arkTx, tx.checkpoints, inputs.map(i => i.coin.txid));
}

export function registerMessage(cosigner: string, expireAt = 0): Proof.RegisterMessage {
  return { type: 'register', onchain_output_indexes: [], valid_at: 0, expire_at: expireAt, cosigners_public_keys: [cosigner] };
}

/**
 * Builds a batch-registration intent proof spending `coin` through covenant
 * leaf 0 and has the emulator execute and sign it. The emulator returns the
 * signed proof to the caller; it does not register it with arkd.
 */
export async function emulatorSignedIntent(chain: Chain, coin: VirtualCoin, tree: VtxoScript, script: Uint8Array,
  outputs: TransactionOutput[], message: Proof.RegisterMessage, opts: { leaf?: number; witness?: Uint8Array[] } = {}) {
  const leaf = tree.leaves[opts.leaf ?? 0];
  if (!leaf) throw new Error('Missing covenant leaf');
  const [withPrev] = await withPrevTxs([{ ...coin, tapTree: tree.encode(), proofTapLeafScript: leaf, forfeitTapLeafScript: leaf }], chain.indexer);
  // Proof input 0 is the BIP322 message input; the covenant coin is input 1.
  const packet = Extension.create([EmulatorPacket.create([{ vin: 1, script, witness: RawWitness.encode(opts.witness ?? []) }])]).txOut();
  const proof = Proof.create(message, [withPrev!], [...outputs, packet]);
  return { proof: await chain.emulator.submitIntent({ proof: b64(proof.toPSBT()), message }), message };
}


/**
 * The same intent proof, but signed through the emulator's *on-chain* endpoint (SubmitOnchainTx).
 * That path runs the script with no intent message (so an intent-only gate passes) and checks
 * prevout txs only by hash, so the proof's synthetic BIP322 `toSpend` tx is accepted as a prevout.
 * The returned proof carries the emulator's signatures and registers with arkd like any other.
 */
export async function onchainSignedIntent(chain: Chain, coin: VirtualCoin, tree: VtxoScript, script: Uint8Array,
  outputs: TransactionOutput[], message: Proof.RegisterMessage) {
  const leaf = leafOf(tree);
  const [withPrev] = await withPrevTxs([{ ...coin, tapTree: tree.encode(), proofTapLeafScript: leaf, forfeitTapLeafScript: leaf }], chain.indexer);
  // Both proof inputs (0 = toSpend, 1 = the coin) run the covenant, so the emulator signs both.
  const packet = Extension.create([EmulatorPacket.create([0, 1].map(vin => ({ vin, script, witness: RawWitness.encode([]) })))]).txOut();
  const proof = Proof.create(message, [withPrev!], [...outputs, packet]);
  // Rebuild the BIP322 toSpend tx exactly as Proof.create does (TAG "ark-intent-proof-message").
  const encoded = JSON.stringify({ type: 'register', onchain_output_indexes: message.onchain_output_indexes,
    valid_at: message.valid_at, expire_at: message.expire_at, cosigners_public_keys: message.cosigners_public_keys });
  const toSpend = new Transaction({ version: 0 });
  toSpend.addInput({ txid: new Uint8Array(32), index: 0xffffffff, sequence: 0 });
  toSpend.addOutput({ amount: 0n, script: tree.pkScript });
  toSpend.updateInput(0, { finalScriptSig: Script.encode(['OP_0', schnorr.utils.taggedHash('ark-intent-proof-message', new TextEncoder().encode(encoded))]) });
  if (toSpend.id !== hex(proof.getInput(0).txid!)) throw new Error('toSpend reconstruction does not match the proof');
  const raw = new Map([[toSpend.id, toSpend.toBytes(true, false)], ...(await resolvePrevTxs([coin.txid], chain.indexer))]);
  await attachPrevoutTxs(proof, { getRawTransaction: async txid => { const r = raw.get(txid); if (!r) throw new Error(`no raw tx ${txid}`); return r; } });
  const { signedTx } = await chain.emulator.submitOnchainTx(b64(proof.toPSBT()));
  return { proof: signedTx, message };
}

/** Registers an already-signed intent with arkd and drives it through a batch.
 * The emulator co-signs the forfeit in SubmitFinalization without re-running the script. */
export async function settleIntent(chain: Chain, signed: { proof: string; message: Proof.RegisterMessage }, coin: VirtualCoin,
  tree: VtxoScript, script: Uint8Array, session: SignerSession, recipients: { address: string; amount: number }[]) {
  const leaf = leafOf(tree);
  const abortController = new AbortController();
  const topics = [hex(await session.getPublicKey()), `${coin.txid}:${coin.vout}`];
  const stream = chain.ark.getEventStream(abortController.signal, topics);
  const first = stream.next();
  void first.catch(() => {});
  const primed = (async function* () { const f = await first; if (!f.done) yield f.value; yield* stream; })();
  const intentId = await chain.ark.registerIntent(signed);
  // The covenant leaf has no user key (signer `undefined`); the emulator signs the forfeit.
  const handler = arkade.createArkadeBatchHandler(intentId,
    [{ ...coin, tapTree: tree.encode(), forfeitTapLeafScript: leaf, proofTapLeafScript: leaf, arkadeScriptBytes: script }],
    undefined, signed.proof, signed.message, session, chain.ark, chain.emulator, networks.regtest, recipients);
  try { return await Batch.join(primed, handler, { abortController }); }
  finally { abortController.abort(); }
}

/** A covenant leaf where the emulator is NOT the last signer: [server, emulator(script), user]. */
export function threeKeyLeaf(chain: Chain, script: Uint8Array, user: Uint8Array) {
  return MultisigTapscript.encode({ pubkeys: [chain.server, arkade.computeArkadeScriptPublicKey(chain.emulatorKey, script), user] }).script;
}

/** Submits an ark tx the caller already holds emulator signatures for, straight to arkd:
 * the user adds its own signatures to the ark tx and the checkpoints, arkd finalizes on submit. */
export async function submitHeldToArkd(chain: Chain, held: { signedArkTx: string; signedCheckpointTxs: string[] }, identity: Identity) {
  const arkTx = await identity.sign(Transaction.fromPSBT(unb64(held.signedArkTx)));
  const checkpoints = await Promise.all(held.signedCheckpointTxs.map(c => identity.sign(Transaction.fromPSBT(unb64(c)))));
  return (await submitToArkd(chain, arkTx, checkpoints)).txid;
}

export function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN;
}
