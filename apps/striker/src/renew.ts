// Renew delegate (DESIGN.md §8): registers an offer covenant VTXO in a batch through its Renew
// leaf, so it gets a fresh expiry (and chain depth 1). Ported from spike/renew.ts, where it was
// proven against arkd + emulator (40-renew).
import {
  arkade, asset, Batch, EmulatorPacket, Estimator, Extension, Proof, resolvePrevTxs, Transaction, TreeSignerSession,
  type ArkProvider, type EmulatorProvider, type IndexerProvider, type Network, type SingleKey, type VirtualCoin,
} from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { b64, hex, OFFER_LEAF, unb64, type Offer } from '@striker/core';

export interface RenewDeps {
  ark: ArkProvider; indexer: IndexerProvider; emulator: EmulatorProvider; network: Network;
  identity: SingleKey; secret: Uint8Array; cosigner: string;
  fees: ConstructorParameters<typeof Estimator>[0];
}

/** arkd's intent fee for renewing `coin` under its current fee program. Renewal must be free:
 * the exact-value Renew leaf can't pay a fee. */
export function renewalFee(deps: RenewDeps, coin: VirtualCoin) {
  const fee = new Estimator(deps.fees).evaluate([{ amount: BigInt(coin.value), type: coin.isSwept ? 'recoverable' : 'vtxo', weight: 0,
    birth: coin.createdAt, expiry: coin.expiresAt }], [], [{ amount: BigInt(coin.value), script: '' }], []);
  return BigInt(fee.satoshis);
}

/** Builds the renewal proof, has the emulator run the Renew leaf, signs as Striker, and joins the
 * next batch as the tree cosigner. Resolves with the commitment txid. */
export async function renewOffer(deps: RenewDeps, offer: Offer, coin: VirtualCoin): Promise<string> {
  const prevTx = (await resolvePrevTxs([coin.txid], deps.indexer)).get(coin.txid);
  if (!prevTx) throw new Error('missing funding ark tx');
  const leaf = offer.tree.leaves[OFFER_LEAF.renew]!;
  const input: arkade.ArkadeExtendedVirtualCoin & { prevTx: Uint8Array } = { ...coin, tapTree: offer.tree.encode(), forfeitTapLeafScript: leaf,
    proofTapLeafScript: leaf, prevTx, arkadeScriptBytes: offer.renewScript };
  const message: Proof.RegisterMessage = { type: 'register', onchain_output_indexes: [], valid_at: 0, expire_at: 0, cosigners_public_keys: [deps.cosigner] };
  const assets = coin.assets ?? [];
  // Proof input 1 is the VTXO (input 0 is the BIP322 message input); output 0 is the renewed VTXO.
  const packets = [
    ...(assets.length ? [asset.Packet.create(assets.map(a => asset.AssetGroup.create(asset.AssetId.fromString(a.assetId), null,
      [asset.AssetInput.create(1, BigInt(a.amount))], [asset.AssetOutput.create(0, BigInt(a.amount))], [])))] : []),
    EmulatorPacket.create([{ vin: 1, script: offer.renewScript, witness: RawWitness.encode([]) }]),
  ];
  const proof = Proof.create(message, [input], [{ script: offer.tree.pkScript, amount: BigInt(coin.value) }, Extension.create(packets).txOut()]);
  const approved = await deps.emulator.submitIntent({ proof: b64(proof.toPSBT()), message });
  const signed = b64((await deps.identity.sign(Transaction.fromPSBT(unb64(approved)))).toPSBT());

  const abort = new AbortController();
  const stream = deps.ark.getEventStream(abort.signal, [deps.cosigner, `${coin.txid}:${coin.vout}`]);
  // Prime the stream before registering so a round starting right away is not missed.
  const first = stream.next();
  void first.catch(() => {});
  const primed = (async function* () { const f = await first; if (!f.done) yield f.value; yield* stream; })();
  try {
    const intentId = await deps.ark.registerIntent({ proof: signed, message });
    // A fresh session per batch from the same secret: the pinned cosigner key, new musig2 nonces.
    const handler = arkade.createArkadeBatchHandler(intentId, [input], deps.identity, signed, message,
      new TreeSignerSession(deps.secret), deps.ark, deps.emulator, deps.network);
    return await Batch.join(primed, handler, { abortController: abort });
  } finally { abort.abort(); }
}

export const outpoint = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`;
export { hex };
