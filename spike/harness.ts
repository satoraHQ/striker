// Shared regtest harness for the v2 covenant spike. Start the stack first:
//   npm run regtest -- start
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  arkade, ArkAddress, combineTapscriptSigs, CSVMultisigTapscript, EsploraProvider, InMemoryContractRepository,
  InMemoryWalletRepository, matchServerCheckpoints, MultisigTapscript, RestArkProvider, RestEmulatorProvider,
  RestIndexerProvider, SingleKey, Transaction, VtxoScript, Wallet, attachPrevArkTxs,
  type ArkTxInput, type ExtendedVirtualCoin, type TapLeafScript, type VirtualCoin,
} from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
export const unb64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));

export const ARK_URL = process.env.ARK_URL ?? 'http://localhost:7070';
export const EMULATOR_URL = process.env.EMULATOR_URL ?? 'http://localhost:7073';
export const ESPLORA_URL = process.env.ESPLORA_URL ?? 'http://localhost:3000/api';
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

/** The tap leaves a plain SDK wallet spends its VTXOs with (forfeit leaf for both offchain txs and proofs). */
export interface WalletLeaves { tapTree: Uint8Array; forfeitTapLeafScript: TapLeafScript; proofTapLeafScript: TapLeafScript }
export interface TestWallet { wallet: Wallet; identity: SingleKey; address: string; publicKey: Uint8Array; pkScript: Uint8Array; leaves: WalletLeaves }
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
  const script = wallet.offchainTapscript;
  const leaves: WalletLeaves = { tapTree: script.encode(), forfeitTapLeafScript: script.forfeit(), proofTapLeafScript: script.forfeit() };
  return { wallet, identity, address, publicKey: publicKey(n), pkScript: ArkAddress.decode(address).pkScript, leaves };
}

/** Issues a fresh demo USD asset (8 decimals) to `owner`. Returns its asset id string. */
export async function issueDemoUsd(chain: Chain, owner: TestWallet, amount = 1_000_000n * 100_000_000n) {
  const { assetId } = await owner.wallet.assetManager.issue({ amount,
    metadata: { name: 'Demo USD', ticker: 'USD', decimals: 8 } });
  await waitFor(async () => (await coinsAt(chain, owner)).some(v => v.assets?.some(a => a.assetId === assetId)) ? true : undefined, 'asset issuance');
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

/** Every spendable coin at `pkScript` from arkd's indexer. It pages at 100 and `pageIndex` is
 * 1-based (0 and 1 return the same page), so walk 1..total and dedupe by outpoint. */
export async function coinsAt(chain: Chain, tree: Pick<VtxoScript, 'pkScript'>): Promise<VirtualCoin[]> {
  const out = new Map<string, VirtualCoin>();
  for (let pageIndex = 1, total = 1; pageIndex <= total; pageIndex++) {
    const { vtxos, page } = await chain.indexer.getVtxos({ scripts: [hex(tree.pkScript)], spendableOnly: true, pageIndex, pageSize: 100 });
    for (const v of vtxos) out.set(`${v.txid}:${v.vout}`, v);
    total = page?.total ?? 1;
  }
  return [...out.values()];
}
export function coinAt(chain: Chain, tree: Pick<VtxoScript, 'pkScript'>, txid?: string): Promise<VirtualCoin> {
  return waitFor(async () => (await coinsAt(chain, tree)).find(v => !txid || v.txid === txid), 'covenant coin');
}
/** A plain wallet's spendable coins straight from arkd's indexer (the SDK wallet's own view is a
 * polled snapshot that misses spends made around it), carrying the wallet's tap leaves. */
export async function walletCoins(chain: Chain, w: TestWallet): Promise<ExtendedVirtualCoin[]> {
  return (await coinsAt(chain, w)).map(c => ({ ...c, ...w.leaves }));
}

/** Wraps a coin as an offchain-tx input spending `tree.leaves[leaf]`. */
export function asInput(coin: Pick<VirtualCoin, 'txid' | 'vout' | 'value'>, tree: VtxoScript, leaf = 0): ArkTxInput {
  if (!tree.leaves[leaf]) throw new Error('Missing spend leaf');
  return { txid: coin.txid, vout: coin.vout, value: coin.value, tapTree: tree.encode(), tapLeafScript: tree.leaves[leaf] };
}

export interface BuiltTx { arkTx: Transaction; checkpoints: Transaction[]; prevTxids: string[] }
/** Submits an emulator-validated offchain tx. Returns the final ark txid. */
export async function submit(chain: Chain, arkTx: Transaction, checkpoints: Transaction[], prevTxids: string[]) {
  await attachPrevArkTxs(arkTx, prevTxids, chain.indexer);
  const result = await chain.emulator.submitTx(b64(arkTx.toPSBT()), checkpoints.map(c => b64(c.toPSBT())));
  return { txid: Transaction.fromPSBT(unb64(result.signedArkTx)).id, result };
}
export const submitBuilt = (chain: Chain, built: BuiltTx) => submit(chain, built.arkTx, built.checkpoints, built.prevTxids);

/**
 * Plain arkd path for txs without covenant inputs (owner leaf, exit-style spends, held
 * signatures): `checkpoints` already carry every non-arkd signature. arkd ≥ 0.9.22 then
 * finalizes inside `submitTx` ("one shot") and echoes those signatures back; re-signing the
 * echoed checkpoint would collide on the same (key, leaf) PSBT entry. Only when arkd did not
 * finalize are the signatures merged and `finalizeTx` called.
 */
export async function submitToArkd(chain: Chain, arkTx: Transaction, checkpoints: Transaction[]) {
  const res = await chain.ark.submitTx(b64(arkTx.toPSBT()), checkpoints.map(c => b64(c.toPSBT())));
  const matched = matchServerCheckpoints(res.signedCheckpointTxs, checkpoints, 'submitTx');
  const sigs = (t: Transaction) => (t.getInput(0).tapScriptSig ?? []).map(([k, s]) => hex(k.pubKey) + hex(k.leafHash) + hex(s));
  const finalizedOnSubmit = matched.every(({ server, local }) => { const have = new Set(sigs(server)); return sigs(local).every(e => have.has(e)); });
  if (!finalizedOnSubmit) {
    await chain.ark.finalizeTx(res.arkTxid, matched.map(({ server, local }) => b64(combineTapscriptSigs(local, server).toPSBT())));
  }
  return { txid: res.arkTxid, finalizedOnSubmit };
}

// ------------------------------------------------------------- refusals

/**
 * What the emulator (or arkd through it) answered. The SDK throws
 * `Failed to submit <kind> to emulator: {"code":<grpc code>,"message":"..."}`; covenant
 * refusals read `emulate offchain tx ark_txid=…: input i: failed to execute arkade script:
 * script=1 opcode=OP_X position=n: <reason>` (intents: `emulate batch registration proof_txid=…`),
 * arkd rejections are passed through with arkd's own status text (e.g. `TX_TOO_LARGE (46): …`).
 */
export interface Rejection { code?: number; message: string }
export function rejectionOf(e: unknown): Rejection {
  const text = e instanceof Error ? (e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message) : String(e);
  const body = /to emulator: (\{.*\})\s*$/s.exec(text)?.[1];
  if (body) {
    try { const { code, message } = JSON.parse(body) as { code?: number; message?: string }; return { code, message: String(message ?? body) }; }
    catch { /* not JSON: keep the raw text */ }
  }
  return { message: text };
}
export const COVENANT_REFUSAL = /failed to execute arkade script/;
const asRegExp = (t: string | RegExp) => typeof t === 'string' ? new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : t;

/** Asserts `fn` is refused by Arkade-script execution (not by transport, preflight or arkd),
 * optionally with `expect` in the refusal text (opcode or reason). Returns the rejection. */
export async function refused(fn: () => Promise<unknown>, expect?: string | RegExp): Promise<Rejection> {
  let error: unknown;
  await assert.rejects(fn, e => { error = e; return true; });
  const r = rejectionOf(error);
  assert.match(r.message, COVENANT_REFUSAL, `Rejected, but not by covenant execution: ${r.message}`);
  if (expect !== undefined) assert.match(r.message, asRegExp(expect), `Expected a covenant refusal matching ${expect}`);
  return r;
}
/** Asserts `fn` is rejected with `text` somewhere in the error: emulator preflight checks and
 * arkd rejections relayed by the emulator (ASSET_*, TX_TOO_LARGE, …) included. */
export async function rejectedWith(text: string | RegExp, fn: () => Promise<unknown>): Promise<Rejection> {
  let error: unknown;
  await assert.rejects(fn, e => { error = e; return true; });
  const r = rejectionOf(error);
  assert.match(r.message, asRegExp(text), `Expected a rejection matching ${text}`);
  return r;
}
