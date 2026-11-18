// Asset-claim probes (DESIGN.md §14: "does arkd reject an asset left out of a tx's asset
// claim?"). A tiny offchain-tx builder that takes the asset packet verbatim, so tests can
// omit, under/over-declare or misplace asset claims, and submit either straight to arkd
// (plain wallet inputs, no emulator) or through the emulator (covenant inputs).
//
// arkd's rules (arkd v0.9.25, pkg/ark-lib/asset/tx_validation.go):
//   - spending asset VTXOs needs an asset packet (:38)
//   - every asset each input holds must appear in a group (:204) that lists that input (:228)
//     with exactly the held amount (:218)
//   - every group input must hold that asset (:321, :351) with exactly that amount (:336)
//   - group outputs are not checked against inputs: sum(out) < sum(in) burns the rest,
//     sum(out) > sum(in) is a reissuance and needs the control asset (asset_group.go:79, tx_validation.go:91)
//   - output VTXOs get exactly the packet's declared outputs (internal/core/application/utils.go:343)
import { arkade, asset, buildOffchainTx, EmulatorPacket, Extension, VtxoScript } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { covenantLeaf, ownerLeaf, submit, submitToArkd, type Chain } from './harness.js';
import { assetIdOps, type Spend } from './swap.js';

type Ops = Parameters<typeof arkade.ArkadeScript.encode>[0];

/** One asset group, written out by hand. `asset: null` is an issuance (new asset id). */
export interface Group { asset: string | null; inputs?: [vin: number, amount: bigint][]; outputs?: [vout: number, amount: bigint][] }
export interface RawOut { script: Uint8Array; amount: bigint }

/** Builds the ark tx + checkpoints with exactly `groups` as the asset packet (`undefined` =
 * no asset packet at all), plus an emulator packet for covenant inputs; signs wallet inputs. */
export async function buildRaw(chain: Chain, spends: Spend[], outs: RawOut[], groups?: Group[]) {
  const packets = [];
  if (groups) packets.push(asset.Packet.create(groups.map(g => asset.AssetGroup.create(
    g.asset === null ? null : asset.AssetId.fromString(g.asset), null,
    (g.inputs ?? []).map(([vin, a]) => asset.AssetInput.create(vin, a)),
    (g.outputs ?? []).map(([vout, a]) => asset.AssetOutput.create(vout, a)), []))));
  const entries = spends.flatMap((s, vin) => s.arkade ? [{ vin, script: s.arkade.script, witness: RawWitness.encode(s.arkade.witness) }] : []);
  if (entries.length) packets.push(EmulatorPacket.create(entries));
  const outputs = outs.map(o => ({ script: o.script, amount: o.amount }));
  if (packets.length) outputs.push(Extension.create(packets).txOut());
  let { arkTx, checkpoints } = buildOffchainTx(spends.map(s => s.input), outputs, chain.checkpoint);
  for (const [i, s] of spends.entries()) {
    if (!s.signer) continue;
    arkTx = await s.signer.sign(arkTx, [i]);
    checkpoints[i] = await s.signer.sign(checkpoints[i]!, [0]);
  }
  return { arkTx, checkpoints, prevTxids: spends.map(s => s.coin.txid) };
}

/** Straight to arkd: wallet / key leaves only (no covenant inputs). */
export async function rawViaArkd(chain: Chain, spends: Spend[], outs: RawOut[], groups?: Group[]) {
  const { arkTx, checkpoints } = await buildRaw(chain, spends, outs, groups);
  return (await submitToArkd(chain, arkTx, checkpoints)).txid;
}
/** Through the emulator: it runs the covenant inputs' scripts, co-signs and finalizes with arkd. */
export async function rawViaEmulator(chain: Chain, spends: Spend[], outs: RawOut[], groups?: Group[]) {
  const { arkTx, checkpoints, prevTxids } = await buildRaw(chain, spends, outs, groups);
  return (await submit(chain, arkTx, checkpoints, prevTxids)).txid;
}

/** A covenant tree around `script` with an owner leaf, and a Spend of `coin` through the covenant leaf. */
export function probeCovenant(chain: Chain, script: Ops, owner: Uint8Array) {
  const encoded = arkade.ArkadeScript.encode(script);
  const tree = new VtxoScript([covenantLeaf(chain, encoded), ownerLeaf(chain, owner)]);
  const spend = (coin: Spend['coin'], witness: Uint8Array[] = []): Spend => ({
    coin, input: { txid: coin.txid, vout: coin.vout, value: coin.value, tapTree: tree.encode(), tapLeafScript: tree.leaves[0]! },
    arkade: { script: encoded, witness },
  });
  return { tree, script: encoded, spend };
}

/** Accept-all covenant: the script never looks at assets, so only arkd judges the packet. */
export const ANYONE: Ops = [1];
/** The offer covenant's preservation clause on its own: the paired output keeps this input's
 * script and every asset except `traded` (OP_TUNNEL flags 5 = script | assets). */
export const tunnelExcept = (traded: string): Ops => ['PUSHCURRENTINPUTINDEX', 5, ...assetIdOps(traded), 1, 'TUNNEL'];
