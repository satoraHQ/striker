import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing ${name}`);
  return v;
};

export interface Config {
  port: number;
  arkUrl: string;
  emulatorUrl: string;
  esploraUrl: string;
  dataDir: string;
  secret: Uint8Array;
  asset: { id: string; ticker: string; decimals: number };
  feeBps: bigint;
  swapTtl: number;
  /** Renew window in seconds; part of every offer address, so keep it stable. */
  renewWindow?: bigint;
  /** CSV delays of the offer and swap exit leaves; default to arkd's unilateral exit delay. */
  offerExitSeconds?: bigint;
  swapExitSeconds?: bigint;
  batchWindowMs: number;
  /** Renew an offer VTXO once it has less than this many seconds left (clamped to the window). */
  renewBefore: number;
  renewCheckMs: number;
}

/** Striker's key: tree signer, Renew-leaf key and fee wallet. Kept in `<dataDir>/secret`. */
function loadSecret(dataDir: string) {
  if (process.env.STRIKER_SECRET) return Uint8Array.from(Buffer.from(process.env.STRIKER_SECRET, 'hex'));
  const file = path.join(dataDir, 'secret');
  if (!existsSync(file)) { mkdirSync(dataDir, { recursive: true }); writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 }); }
  return Uint8Array.from(Buffer.from(readFileSync(file, 'utf8').trim(), 'hex'));
}

export function loadConfig(): Config {
  const dataDir = path.resolve(env('STRIKER_DATA', '.striker'));
  mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(env('PORT', '7090')),
    arkUrl: env('ARK_URL', 'http://localhost:7070'),
    emulatorUrl: env('EMULATOR_URL', 'http://localhost:7073'),
    esploraUrl: env('ESPLORA_URL', 'http://localhost:3000/api'),
    dataDir,
    secret: loadSecret(dataDir),
    asset: { id: env('ASSET_ID'), ticker: env('ASSET_TICKER', 'USD'), decimals: Number(env('ASSET_DECIMALS', '8')) },
    feeBps: BigInt(env('FEE_BPS', '30')),
    swapTtl: Number(env('SWAP_TTL', '600')),
    ...(process.env.RENEW_WINDOW ? { renewWindow: BigInt(process.env.RENEW_WINDOW) } : {}),
    ...(process.env.OFFER_EXIT_SECONDS ? { offerExitSeconds: BigInt(process.env.OFFER_EXIT_SECONDS) } : {}),
    ...(process.env.SWAP_EXIT_SECONDS ? { swapExitSeconds: BigInt(process.env.SWAP_EXIT_SECONDS) } : {}),
    batchWindowMs: Number(env('BATCH_WINDOW_MS', '200')),
    renewBefore: Number(env('RENEW_BEFORE', String(6 * 3600))),
    renewCheckMs: Number(env('RENEW_CHECK_MS', '30000')),
  };
}
