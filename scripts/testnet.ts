// Regtest test environment shared by the end-to-end suites (Striker e2e, web Playwright) and
// `npm run dev`: named wallets with derived (public) keys, a "bank" wallet topped up from the regtest
// faucet that issues the demo USD asset, and a Striker + maker stack as child processes.
// Start the stack first: `npm run regtest -- start`.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArkAddress, EsploraProvider, InMemoryContractRepository, InMemoryWalletRepository, RestArkProvider, SingleKey, Wallet,
} from '@arkade-os/sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex, type BookSnapshot, type InfoResponse } from '@striker/core';

export const profile = {
  arkUrl: process.env.ARK_URL ?? 'http://localhost:7070',
  emulatorUrl: process.env.EMULATOR_URL ?? 'http://localhost:7073',
  esploraUrl: process.env.ESPLORA_URL ?? 'http://localhost:3000/api',
};
/** Environment for a Striker or maker child process. */
export const netEnv = (): Record<string, string> => ({ ARK_URL: profile.arkUrl, EMULATOR_URL: profile.emulatorUrl, ESPLORA_URL: profile.esploraUrl });

export const root = fileURLToPath(new URL('../', import.meta.url));
export const USD = 100_000_000n;
const log = (...a: unknown[]) => console.log('[testnet]', ...a);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | undefined>, label: string, ms = 60_000, every = 500): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v !== undefined) return v; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${(last as Error).message}` : ''}`);
}

// ------------------------------------------------------------------ keys

/** The secret key of a named test wallet, derived from its name (public test keys, regtest only). */
export const keyOf = (name: string): Uint8Array => sha256(new TextEncoder().encode(`striker-test/${name}`));

// ------------------------------------------------------------------ wallets

export interface TestWallet { name: string; wallet: Wallet; identity: SingleKey; address: string; pkScript: Uint8Array; publicKey: Uint8Array }
const open = new Map<string, Promise<TestWallet>>();

export function openWallet(name: string): Promise<TestWallet> {
  let w = open.get(name);
  if (!w) {
    w = (async () => {
      const identity = SingleKey.fromPrivateKey(keyOf(name));
      const wallet = await Wallet.create({
        identity, arkProvider: new RestArkProvider(profile.arkUrl),
        onchainProvider: new EsploraProvider(profile.esploraUrl, { forcePolling: true, pollingInterval: 5_000 }),
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
        settlementConfig: false,
      });
      const address = await wallet.getAddress();
      return { name, wallet, identity, address, pkScript: ArkAddress.decode(address).pkScript, publicKey: await identity.xOnlyPublicKey() };
    })();
    open.set(name, w);
  }
  return w;
}
export async function closeWallets() {
  const all = [...open.values()]; open.clear();
  await Promise.all(all.map(async w => (await w).wallet.dispose().catch(() => {})));
}

/** Owned offchain sats (settled + preconfirmed; `available` holds back a dust carrier once the
 * wallet holds assets) and asset units. */
export async function balanceOf(w: TestWallet, assetId?: string) {
  const b = await w.wallet.getBalance();
  const asset = assetId ? BigInt(b.assets?.find(a => a.assetId === assetId)?.amount ?? 0) : 0n;
  return { sats: BigInt(b.settled + b.preconfirmed), asset };
}

// ------------------------------------------------------------------ bank

/** The wallet every other test wallet is funded from, and the issuer of the demo USD asset. */
export async function bank(needSats = 0n): Promise<{ w: TestWallet; usd: string }> {
  const w = await openWallet('bank');
  const { sats } = await balanceOf(w);
  if (sats < needSats + 100_000n) {
    const { refillFaucet, regtest } = await import('../spike/harness.js');
    const amount = Number(needSats + 5_000_000n);
    refillFaucet(amount);
    regtest('ark', 'send', '--to', w.address, '--amount', String(amount), '--password', 'secret');
    await waitFor(async () => ((await balanceOf(w)).sats >= sats + BigInt(amount) ? true : undefined), 'bank funding');
  }
  return { w, usd: await demoUsd(w) };
}

/** The demo USD asset (8 decimals) the bank holds, issued on first use. */
async function demoUsd(w: TestWallet): Promise<string> {
  const b = await w.wallet.getBalance();
  const held = (id: string) => BigInt(b.assets?.find(a => a.assetId === id)?.amount ?? 0);
  // Reuse whatever demo USD the bank holds the most of.
  const id = process.env.ASSET_ID ?? [...(b.assets ?? [])].sort((x, y) => (BigInt(y.amount) > BigInt(x.amount) ? 1 : -1))[0]?.assetId;
  if (id && held(id) >= 1_000n * USD) return id;
  const { assetId } = await w.wallet.assetManager.issue({ amount: 1_000_000n * USD, metadata: { name: 'Demo USD', ticker: 'USD', decimals: 8 } });
  await waitFor(async () => ((await balanceOf(w, assetId)).asset > 0n ? true : undefined), 'demo USD issuance');
  log(`issued demo USD ${assetId}`);
  return assetId;
}

/** Tops `w` up to at least `sats` spendable sats and `usd` asset units, from the bank. */
export async function fund(w: TestWallet, want: { sats?: bigint; usd?: bigint }) {
  const { w: b, usd } = await bank((want.sats ?? 0n) + 10_000n);
  const have = await balanceOf(w, usd);
  const sats = want.sats && have.sats < want.sats ? want.sats - have.sats : 0n;
  const units = want.usd && have.asset < want.usd ? want.usd - have.asset : 0n;
  if (sats === 0n && units === 0n) return usd;
  const dust = 330n;
  await b.wallet.send({ address: w.address, amount: Number(sats > dust ? sats : dust), assets: units > 0n ? [{ assetId: usd, amount: units }] : [] });
  await waitFor(async () => { const n = await balanceOf(w, usd); return n.sats >= have.sats + (sats > dust ? sats : dust) && n.asset >= have.asset + units ? true : undefined; },
    `funding ${w.name}`);
  log(`funded ${w.name} with ${sats} sats + ${units} USD units`);
  return usd;
}

// ------------------------------------------------------------------ Striker + maker

export interface StackOptions {
  /** Prefix for the Striker and maker wallet names; keeps suites apart. */
  name: string;
  port: number;
  swapTtl?: number;
  /** Quote around this USD/BTC price; live exchange prices when unset. */
  fixedPrice?: number;
  offerSats?: bigint;
  offerUsd?: bigint;
  strikerEnv?: Record<string, string>;
  quiet?: boolean;
}
export interface Stack { url: string; usd: string; info: InfoResponse; stop(): Promise<void> }

export function runChild(name: string, script: string, env: Record<string, string>, quiet = false): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d: Buffer) => { if (!quiet) for (const l of d.toString().split('\n')) if (l.trim() && !l.includes('Esplora websocket')) console.log(`  [${name}] ${l}`); };
  child.stdout!.on('data', out); child.stderr!.on('data', out);
  return child;
}

/** Starts Striker and a maker bot quoting both sides around `fixedPrice`, funded from the bank. */
export async function startStack(o: StackOptions): Promise<Stack> {
  const offerSats = o.offerSats ?? 1_000_000n;
  const offerUsd = o.offerUsd ?? 1_000n * USD;
  const maker = await openWallet(`${o.name}-maker`);
  const usd = await fund(maker, { sats: offerSats + 20_000n, usd: offerUsd });
  const url = `http://localhost:${o.port}`;
  const data = mkdtempSync(path.join(tmpdir(), `striker-${o.name}-`));
  const children: ChildProcess[] = [];
  const stop = async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.all(children.map(c => (c.exitCode !== null ? null : new Promise(r => c.once('exit', r)))));
  };
  try {
    children.push(runChild('striker', 'apps/striker/src/main.ts', {
      ...netEnv(), PORT: String(o.port), STRIKER_DATA: path.join(data, 'striker'), STRIKER_SECRET: hex(keyOf(`${o.name}-striker`)),
      ASSET_ID: usd, SWAP_TTL: String(o.swapTtl ?? 600), ...o.strikerEnv,
    }, o.quiet));
    const info = await waitFor(async () => (await fetch(`${url}/v1/info`)).json() as Promise<InfoResponse>, 'Striker up', 60_000);
    children.push(runChild('maker', 'apps/maker/src/main.ts', {
      ...netEnv(), STRIKER_URL: url, MAKER_DATA: path.join(data, 'maker'), MAKER_SECRET: hex(keyOf(`${o.name}-maker`)),
      ...(o.fixedPrice !== undefined ? { FIXED_PRICE: String(o.fixedPrice) } : {}),
      // A fresh offer per run, so earlier runs' quotes and coins don't interfere.
      EPOCH: String(Date.now()),
      OFFER_SATS: String(offerSats), OFFER_ASSET: String(offerUsd),
    }, o.quiet));
    await waitFor(async () => { const b = await (await fetch(`${url}/v1/book`)).json() as BookSnapshot; return b.asks.length && b.bids.length ? b : undefined; },
      'maker quotes on both sides', 180_000, 1_000);
    return { url, usd, info, stop };
  } catch (e) { await stop(); throw e; }
}
