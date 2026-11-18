// Offchain tx builder mixing covenant inputs (Arkade script + witness, co-signed by the
// emulator) and plain inputs (signed by an identity), with the asset packet derived from the
// declared input and output balances.
import { asset, attachPrevArkTxs, buildOffchainTx, EmulatorPacket, Extension, Transaction,
  type ArkTxInput, type Identity, type IndexerProvider, type EmulatorProvider, type TapLeafScript, type VirtualCoin } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import type { ChainParams } from './chain.js';
import { b64, unb64 } from './util.js';

export interface AssetAmount { assetId: string; amount: bigint }
export interface Coin extends Pick<VirtualCoin, 'txid' | 'vout' | 'value'> { assets?: { assetId: string; amount: string | number | bigint }[] }
export interface TxInput {
  coin: Coin;
  tapTree: Uint8Array; tapLeafScript: TapLeafScript;
  /** Covenant inputs: Arkade script + witness stack. */
  script?: Uint8Array; witness?: Uint8Array[];
  /** Plain inputs: who signs the ark tx input and its checkpoint. */
  signer?: Identity;
}
export interface TxOutput { script: Uint8Array; amount: bigint; assets?: AssetAmount[] }

export const assetAmount = (coin: Coin, id: string) => BigInt(coin.assets?.find(a => a.assetId === id)?.amount ?? 0);

export function assetPacket(inputs: TxInput[], outputs: TxOutput[]): asset.Packet | undefined {
  const groups = new Map<string, { ins: asset.AssetInput[]; outs: asset.AssetOutput[] }>();
  const g = (id: string) => groups.get(id) ?? groups.set(id, { ins: [], outs: [] }).get(id)!;
  inputs.forEach((inp, vin) => { for (const a of inp.coin.assets ?? []) g(a.assetId).ins.push(asset.AssetInput.create(vin, BigInt(a.amount))); });
  outputs.forEach((out, vout) => { for (const a of out.assets ?? []) if (a.amount > 0n) g(a.assetId).outs.push(asset.AssetOutput.create(vout, a.amount)); });
  if (groups.size === 0) return undefined;
  return asset.Packet.create([...groups].map(([id, { ins, outs }]) => asset.AssetGroup.create(asset.AssetId.fromString(id), null, ins, outs, [])));
}

export interface BuiltTx { arkTx: Transaction; checkpoints: Transaction[]; prevTxids: string[] }

export async function buildTx(chain: ChainParams, inputs: TxInput[], outputs: TxOutput[]): Promise<BuiltTx> {
  const packets: Parameters<typeof Extension.create>[0] = [];
  const assets = assetPacket(inputs, outputs);
  if (assets) packets.push(assets);
  const entries = inputs.flatMap((inp, vin) => inp.script ? [{ vin, script: inp.script, witness: RawWitness.encode(inp.witness ?? []) }] : []);
  if (entries.length) packets.push(EmulatorPacket.create(entries));
  const arkInputs: ArkTxInput[] = inputs.map(inp =>
    ({ txid: inp.coin.txid, vout: inp.coin.vout, value: inp.coin.value, tapTree: inp.tapTree, tapLeafScript: inp.tapLeafScript }));
  let { arkTx, checkpoints } = buildOffchainTx(arkInputs, [
    ...outputs.map(o => ({ script: o.script, amount: o.amount })),
    ...(packets.length ? [Extension.create(packets).txOut()] : []),
  ], chain.checkpoint);
  for (const [vin, inp] of inputs.entries()) {
    if (!inp.signer) continue;
    arkTx = await inp.signer.sign(arkTx, [vin]);
    checkpoints[vin] = await inp.signer.sign(checkpoints[vin]!, [0]);
  }
  return { arkTx, checkpoints, prevTxids: inputs.map(i => i.coin.txid) };
}

/** Covenant path: the emulator runs the scripts, co-signs, submits to arkd and finalizes. */
export async function submitViaEmulator(emulator: EmulatorProvider, indexer: IndexerProvider, built: BuiltTx) {
  await attachPrevArkTxs(built.arkTx, built.prevTxids, indexer);
  const result = await emulator.submitTx(b64(built.arkTx.toPSBT()), built.checkpoints.map(c => b64(c.toPSBT())));
  const signed = Transaction.fromPSBT(unb64(result.signedArkTx));
  return { txid: signed.id, signedArkTx: result.signedArkTx };
}
