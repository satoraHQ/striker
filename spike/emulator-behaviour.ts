// Helpers for the emulator-behaviour spike (DESIGN.md §13 items 2 and 10):
// expiry scripts, single-input covenant spends, emulator-signed intents held
// and settled later, and the non-finalizer offchain path.
import { spawnSync } from 'node:child_process';
import {
  arkade, Batch, buildOffchainTx, combineTapscriptSigs, configureEventSource, EmulatorPacket, Extension, Intent, MultisigTapscript,
  networks, Transaction, VtxoScript, withPrevTxs, type Identity, type SignerSession, type VirtualCoin,
} from '@arkade-os/sdk';
import type { TransactionOutput } from '@scure/btc-signer/psbt.js';
import { RawWitness } from '@scure/btc-signer';
import { asInput, b64, EMULATOR_CONTAINER, hex, submit, unb64, type Chain } from './harness.js';

/** `<expiry> OP_CHECKTIME OP_NOT`: true only while the emulator clock is < expiry (DESIGN.md §3). */
export const beforeExpiry = (expiry: number) => arkade.ArkadeScript.encode([expiry, 'CHECKTIME', 'NOT']);
/** The DESIGN.md §3 expiry plus an offchain-only gate: the script fails when
 * the emulator evaluates it for a batch intent (OP_INSPECTINTENTMESSAGE hits),
 * so no emulator-signed intent proof can be obtained and held. */
export const beforeExpiryOffchainOnly = (expiry: number) => arkade.ArkadeScript.encode([
  new TextEncoder().encode('type'), 'INSPECTINTENTMESSAGE', 'NOT', 'VERIFY', 'DROP',
  expiry, 'CHECKTIME', 'NOT']);
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

/** Emulator log lines since container start; used to tell arkd refusals from script refusals. */
export function emulatorLog() {
  const logs = spawnSync('docker', ['logs', EMULATOR_CONTAINER], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
  return (logs.stdout + logs.stderr).split('\n');
}

export function registerMessage(cosigner: string, expireAt = 0): Intent.RegisterMessage {
  return { type: 'register', onchain_output_indexes: [], valid_at: 0, expire_at: expireAt, cosigners_public_keys: [cosigner] };
}

/**
 * Builds a batch-registration intent proof spending `coin` through covenant
 * leaf 0 and has the emulator execute and sign it. The emulator returns the
 * signed proof to the caller; it does not register it with arkd.
 */
export async function emulatorSignedIntent(chain: Chain, coin: VirtualCoin, tree: VtxoScript, script: Uint8Array,
  outputs: TransactionOutput[], message: Intent.RegisterMessage) {
  const leaf = leafOf(tree);
  const [withPrev] = await withPrevTxs([{ ...coin, tapTree: tree.encode(), intentTapLeafScript: leaf, forfeitTapLeafScript: leaf }], chain.indexer);
  // Proof input 0 is the BIP322 message input; the covenant coin is input 1.
  const proof = Intent.create(message, [withPrev!], [...outputs, emulatorOutput([{ vin: 1, script }])]);
  return { proof: await chain.emulator.submitIntent({ proof: b64(proof.toPSBT()), message }), message };
}

/** Minimal fetch-based EventSource: Node has none without --experimental-eventsource. */
class FetchEventSource {
  private readonly listeners = { message: new Set<(e: MessageEvent) => void>(), error: new Set<(e: MessageEvent) => void>() };
  private readonly abort = new AbortController();
  constructor(url: string) { void this.run(url); }
  addEventListener(type: 'message' | 'error', l: (e: MessageEvent) => void) { this.listeners[type].add(l); }
  removeEventListener(type: 'message' | 'error', l: (e: MessageEvent) => void) { this.listeners[type].delete(l); }
  close() { this.abort.abort(); }
  private emit(type: 'message' | 'error', data?: string) {
    for (const l of this.listeners[type]) l({ data } as MessageEvent);
  }
  private async run(url: string) {
    try {
      const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: this.abort.signal });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = '', data: string[] = [];
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (line === '') { if (data.length) this.emit('message', data.join('\n')); data = []; }
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
      }
      if (!this.abort.signal.aborted) this.emit('error');
    } catch { if (!this.abort.signal.aborted) this.emit('error'); }
  }
}
configureEventSource(url => new FetchEventSource(url));

/** Registers an already-signed intent with arkd and drives it through a batch.
 * The emulator co-signs the forfeit in SubmitFinalization without re-running the script. */
export async function settleIntent(chain: Chain, signed: { proof: string; message: Intent.RegisterMessage }, coin: VirtualCoin,
  tree: VtxoScript, script: Uint8Array, identity: Identity, session: SignerSession, recipients: { address: string; amount: number }[]) {
  const leaf = leafOf(tree);
  const abortController = new AbortController();
  const topics = [hex(await session.getPublicKey()), `${coin.txid}:${coin.vout}`];
  const stream = chain.ark.getEventStream(abortController.signal, topics);
  const first = stream.next();
  void first.catch(() => {});
  const primed = (async function* () { const f = await first; if (!f.done) yield f.value; yield* stream; })();
  const intentId = await chain.ark.registerIntent(signed);
  // The covenant leaf has no user key, so the user "signs" nothing; the emulator signs the forfeit.
  const keyless = Object.assign(Object.create(identity), { sign: async (tx: Transaction) => tx }) as Identity;
  const handler = arkade.createArkadeBatchHandler(intentId,
    [{ ...coin, tapTree: tree.encode(), forfeitTapLeafScript: leaf, intentTapLeafScript: leaf, arkadeScriptBytes: script }],
    keyless, signed.proof, signed.message, session, chain.ark, chain.emulator, networks.regtest, recipients);
  try { return await Batch.join(primed, handler, { abortController }); }
  finally { abortController.abort(); }
}

/** A covenant leaf where the emulator is NOT the last signer: [server, emulator(script), user]. */
export function threeKeyLeaf(chain: Chain, script: Uint8Array, user: Uint8Array) {
  return MultisigTapscript.encode({ pubkeys: [chain.server, arkade.computeArkadeScriptPublicKey(chain.emulatorKey, script), user] }).script;
}

/** Submits an ark tx the caller already holds emulator signatures for, straight to arkd. */
export async function submitHeldToArkd(chain: Chain, held: { signedArkTx: string; signedCheckpointTxs: string[] },
  unsignedCheckpoints: Transaction[], identity: Identity) {
  const arkTx = await identity.sign(Transaction.fromPSBT(unb64(held.signedArkTx)));
  const userCheckpoints = await Promise.all(held.signedCheckpointTxs.map(c => identity.sign(Transaction.fromPSBT(unb64(c)))));
  const { arkTxid, signedCheckpointTxs } = await chain.ark.submitTx(b64(arkTx.toPSBT()), unsignedCheckpoints.map(c => b64(c.toPSBT())));
  const byId = new Map(userCheckpoints.map(c => [c.id, c]));
  const final = signedCheckpointTxs.map(s => {
    const server = Transaction.fromPSBT(unb64(s));
    combineTapscriptSigs(byId.get(server.id)!, server);
    return b64(server.toPSBT());
  });
  await chain.ark.finalizeTx(arkTxid, final);
  return arkTxid;
}

export function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN;
}
