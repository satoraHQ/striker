// Shared regtest harness for the v2 covenant spike. Start the stack first:
//   npm run regtest -- start
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  arkade, ArkAddress, CSVMultisigTapscript, EsploraProvider, InMemoryContractRepository,
  InMemoryWalletRepository, MultisigTapscript, RestArkProvider, RestEmulatorProvider,
  RestIndexerProvider, SingleKey, Transaction, VtxoScript, Wallet, attachPrevArkTxs,
  type ArkTxInput, type VirtualCoin,
} from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
export const unb64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));

export const ARK_URL = process.env.ARK_URL ?? 'http://localhost:7070';
export const EMULATOR_URL = process.env.EMULATOR_URL ?? 'http://localhost:7073';
export const ESPLORA_URL = process.env.ESPLORA_URL ?? 'http://localhost:3000/api';
export const EMULATOR_CONTAINER = process.env.EMULATOR_CONTAINER ?? 'striker-poc-emulator';
// Pinned regtest emulator identity; never trust a remote key in tests.
export const EMULATOR_KEY = unhex('999413c46fa10ada5cbc4bcc79a1d09160c2ba3cfc812705d7a13e5e545fb2a9');
export const REGTEST_SCRIPT = fileURLToPath(new URL('../scripts/regtest.mjs', import.meta.url));

/** Deterministic public test keys. Use distinct `n` per test file to avoid
 * interference between suites (see spike/README.md for the allocation). */
export const secret = (n: number) => new Uint8Array(32).fill(n);
export const publicKey = (n: number) => schnorr.getPublicKey(secret(n));

export type Chain = Awaited<ReturnType<typeof connect>>;
export async function connect() {
  const ark = new RestArkProvider(ARK_URL);
  const indexer = new RestIndexerProvider(ARK_URL);
  const emulator = new RestEmulatorProvider(EMULATOR_URL);
  let info;
  try { info = await ark.getInfo(); await emulator.getInfo(); }
  catch (cause) { throw new Error('Start the stack with: npm run regtest -- start', { cause }); }
  assert.equal(info.network, 'regtest');
  const server = unhex(info.signerPubkey).slice(-32);
  const checkpoint = CSVMultisigTapscript.decode(unhex(info.checkpointTapscript));
  const dust = BigInt(info.dust);
  return { ark, indexer, emulator, info, server, emulatorKey: EMULATOR_KEY, checkpoint, dust };
}

export async function waitFor<T>(fn: () => Promise<T | undefined>, label: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Runs the upstream regtest CLI (e.g. `ark send`, `bitcoin ...`). */
export function regtest(...args: string[]) {
  return execFileSync(process.execPath, [REGTEST_SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

export interface TestWallet { wallet: Wallet; identity: SingleKey; address: string; publicKey: Uint8Array; pkScript: Uint8Array }
const wallets: Wallet[] = [];
export async function disposeWallets() { await Promise.all(wallets.splice(0).map(w => w.dispose())); }

/** A standard Ark wallet for key `n`, funded from the regtest faucet. */
export async function fundedWallet(chain: Chain, n: number, sats = 1_000_000): Promise<TestWallet> {
  const identity = SingleKey.fromPrivateKey(secret(n));
  const wallet = await Wallet.create({
    identity, arkProvider: chain.ark,
    onchainProvider: new EsploraProvider(ESPLORA_URL, { forcePolling: true, pollingInterval: 2000 }),
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: false,
  });
  wallets.push(wallet);
  const address = await wallet.getAddress();
  const before = (await wallet.getBalance()).total;
  if (sats > 0) {
    regtest('ark', 'send', '--to', address, '--amount', String(sats), '--password', 'secret');
    await waitFor(async () => (await wallet.getBalance()).total >= before + sats ? true : undefined, 'wallet funding');
  }
  return { wallet, identity, address, publicKey: publicKey(n), pkScript: ArkAddress.decode(address).pkScript };
}

/** Issues a fresh demo USD asset (8 decimals) to `owner`. Returns its asset id string. */
export async function issueDemoUsd(owner: TestWallet, amount = 1_000_000n * 100_000_000n) {
  const { assetId } = await owner.wallet.assetManager.issue({ amount,
    metadata: { name: 'Demo USD', ticker: 'USD', decimals: 8 } });
  await waitFor(async () => (await owner.wallet.getVtxos()).some(v => v.assets?.some(a => a.assetId === assetId)) ? true : undefined,
    'asset issuance');
  return assetId;
}

/**
 * A covenant VTXO tree following the dual-VM model in DESIGN.md §2:
 *   leaf 0: [server, emulator tweaked by `script`]   covenant (off-chain only)
 *   extra leaves: whatever the caller passes (owner, renew, exit, ...)
 * Use `exitLeaf(owner, delay)` for the plain-tapscript L1 exit.
 */
export function covenantTree(chain: Chain, script: Uint8Array, extraLeaves: Uint8Array[] = []) {
  return new VtxoScript([covenantLeaf(chain, script), ...extraLeaves]);
}
export function covenantLeaf(chain: Chain, script: Uint8Array) {
  return MultisigTapscript.encode({ pubkeys: [chain.server, arkade.computeArkadeScriptPublicKey(chain.emulatorKey, script)] }).script;
}
export function ownerLeaf(chain: Chain, owner: Uint8Array) {
  return MultisigTapscript.encode({ pubkeys: [owner, chain.server] }).script;
}
/** arkd only accepts seconds-based CSV exits (multiple of 512, ≥ unilateralExitDelay). */
export function exitLeaf(owner: Uint8Array, seconds: bigint) {
  return CSVMultisigTapscript.encode({ pubkeys: [owner], timelock: { type: 'seconds', value: seconds } }).script;
}
export function addressOf(chain: Chain, tree: VtxoScript) {
  return tree.address('tark', chain.server).encode();
}

export async function coinsAt(chain: Chain, tree: Pick<VtxoScript, 'pkScript'>) {
  const { vtxos } = await chain.indexer.getVtxos({ scripts: [hex(tree.pkScript)], spendableOnly: true });
  return vtxos;
}
export function coinAt(chain: Chain, tree: Pick<VtxoScript, 'pkScript'>, txid?: string): Promise<VirtualCoin> {
  return waitFor(async () => (await coinsAt(chain, tree)).find(v => !txid || v.txid === txid), 'covenant coin');
}

/** Wraps a coin as an offchain-tx input spending `tree.leaves[leaf]`. */
export function asInput(coin: Pick<VirtualCoin, 'txid' | 'vout' | 'value'>, tree: VtxoScript, leaf = 0): ArkTxInput {
  if (!tree.leaves[leaf]) throw new Error('Missing spend leaf');
  return { txid: coin.txid, vout: coin.vout, value: coin.value, tapTree: tree.encode(), tapLeafScript: tree.leaves[leaf] };
}

/** Submits an emulator-validated offchain tx. Returns the final ark txid. */
export async function submit(chain: Chain, arkTx: Transaction, checkpoints: Transaction[], prevTxids: string[]) {
  await attachPrevArkTxs(arkTx, prevTxids, chain.indexer);
  const result = await chain.emulator.submitTx(b64(arkTx.toPSBT()), checkpoints.map(c => b64(c.toPSBT())));
  return { txid: Transaction.fromPSBT(unb64(result.signedArkTx)).id, result };
}

/** Emulator log lines for failed Arkade-script executions. The emulator returns
 * a generic error over HTTP, so negative tests must also see a new log line;
 * otherwise a transport/preflight error could masquerade as a covenant refusal. */
export function executionErrors() {
  const logs = spawnSync('docker', ['logs', EMULATOR_CONTAINER], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(logs.status, 0, 'Cannot read emulator logs');
  return (logs.stdout + logs.stderr).split('\n').filter(l => l.includes('failed to execute arkade script'));
}
/** Asserts `fn` is rejected by covenant execution (not by transport or arkd). */
export async function refused(fn: () => Promise<unknown>) {
  const before = executionErrors().length;
  await assert.rejects(fn);
  await waitFor(async () => executionErrors().length > before ? true : undefined, 'emulator execution error', 5_000);
  return executionErrors().slice(before);
}
