// What every covenant script and address depends on: the Ark server's signer key, the
// emulator key, the checkpoint tapscript, dust and the address prefix. Read once from
// arkd's /v1/info; the emulator key is pinned by configuration, never trusted from a server.
import { arkade, CSVMultisigTapscript, defaultEmulatorPubkey, MultisigTapscript, RestArkProvider, VtxoScript, type Network, networks } from '@arkade-os/sdk';
import { unhex } from './util.js';

export interface ChainParams {
  /** x-only arkd signer key. */
  server: Uint8Array;
  /** x-only emulator key (pinned). */
  emulatorKey: Uint8Array;
  checkpoint: CSVMultisigTapscript.Type;
  dust: bigint;
  /** Bech32m prefix of Ark addresses: 'tark' on test networks, 'ark' on mainnet. */
  hrp: string;
  network: Network;
  networkName: string;
}

/** What covenant scripts and addresses need: enough for a browser to rebuild and check an address. */
export type CovenantParams = Pick<ChainParams, 'server' | 'emulatorKey' | 'hrp'>;

export async function fetchChainParams(arkUrl: string, emulatorKeyHex?: string): Promise<ChainParams> {
  const info = await new RestArkProvider(arkUrl).getInfo();
  return chainParamsFromInfo(info, emulatorKeyHex);
}

export function chainParamsFromInfo(info: { signerPubkey: string; checkpointTapscript: string; dust: bigint | number | string; network: string },
  emulatorKeyHex?: string): ChainParams {
  const networkName = info.network;
  const network = (networks as Record<string, Network>)[networkName];
  if (!network) throw new Error(`Unknown network ${networkName}`);
  return {
    server: unhex(info.signerPubkey).slice(-32),
    // The SDK pins the emulator key per network; an override is only for a rotated key.
    emulatorKey: unhex(emulatorKeyHex ?? defaultEmulatorPubkey(network)).slice(-32),
    checkpoint: CSVMultisigTapscript.decode(unhex(info.checkpointTapscript)),
    dust: BigInt(info.dust),
    hrp: networkName === 'bitcoin' ? 'ark' : 'tark',
    network,
    networkName,
  };
}

/** Covenant leaf: `[server, emulator ⊕ script]`, the emulator key last so it finalizes (DESIGN.md §2). */
export function covenantLeaf(chain: CovenantParams, script: Uint8Array) {
  return MultisigTapscript.encode({ pubkeys: [chain.server, arkade.computeArkadeScriptPublicKey(chain.emulatorKey, script)] }).script;
}
export function ownerLeaf(chain: CovenantParams, owner: Uint8Array) {
  return MultisigTapscript.encode({ pubkeys: [owner, chain.server] }).script;
}
/** arkd only accepts seconds-based CSV exits (multiple of 512, ≥ unilateralExitDelay). */
export function exitLeaf(owner: Uint8Array, seconds: bigint) {
  return CSVMultisigTapscript.encode({ pubkeys: [owner], timelock: { type: 'seconds', value: seconds } }).script;
}
export const addressOf = (chain: CovenantParams, tree: VtxoScript) => tree.address(chain.hrp, chain.server).encode();
