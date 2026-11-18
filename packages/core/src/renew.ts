// Renew leaf (DESIGN.md §8): batch registration only, Striker the only cosigner, the paired
// proof output keeps script, value and assets. Proven in spike/40-renew.
import { arkade, MultisigTapscript } from '@arkade-os/sdk';
import type { CovenantParams } from './chain.js';
import { utf8 } from './util.js';

/** OP_TUNNEL flag bits (emulator README): 1 scriptPubKey, 2 value, 4 assets. */
const TUNNEL_SCRIPT = 1, TUNNEL_VALUE = 2, TUNNEL_ASSETS = 4;

export interface RenewParams {
  /** 33-byte compressed tree-signer key of Striker, hex. */
  cosigner: string;
  /** x-only signing key of Striker: a key in the Renew leaf, so only Striker can register a renewal. */
  delegateKey: Uint8Array;
  /** Seconds before VTXO expiry from which renewal is allowed. */
  window: bigint;
  /** Fee-capped variant: the renewed output may be up to `maxFee` sats smaller. */
  maxFee?: bigint;
}

export function renewScript({ cosigner, window, maxFee }: RenewParams): Uint8Array {
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
      'INSPECTNUMOUTPUTS', 2, 'NUMEQUALVERIFY',
      'PUSHCURRENTINPUTINDEX', '1SUB', 'INSPECTOUTPUTVALUE',
      'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTVALUE', maxFee, 'SUB',
      'GREATERTHANOREQUAL',
    ] as const),
  ]);
}

/** `[striker, server, emulator ⊕ renewScript]`. */
export function renewLeaf(chain: CovenantParams, params: RenewParams, script = renewScript(params)) {
  return MultisigTapscript.encode({ pubkeys: [params.delegateKey, chain.server, arkade.computeArkadeScriptPublicKey(chain.emulatorKey, script)] }).script;
}
