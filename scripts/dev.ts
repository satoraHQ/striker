// Local prototype on the regtest stack (`npm run regtest -- start` first).
//   npm run dev                         fund a dev maker, start Striker + maker bot (+ web if present)
//   npm run dev -- faucet <ark address> [sats] [usd]
//                                       send regtest sats and demo USD to a wallet (e.g. the stack's
//                                       arkade wallet), to try the simple flow by hand
// Dev keys 220–229 (public test keys, regtest only). LIVE_PRICE=1 quotes around Binance instead of $100k.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, hex, secret } from '../spike/harness.js';
import { demoUsd, ensureFunded } from '../spike/offer.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const USD = 100_000_000n;
const chain = await connect();
const maker = await ensureFunded(chain, 220, 5_000_000);
const usd = await demoUsd(chain, maker);
const [command, ...args] = process.argv.slice(2);

if (command === 'faucet') {
  const [address, sats = '200000', dollars = '500'] = args;
  if (!address) throw new Error('usage: npm run dev -- faucet <ark address> [sats] [usd]');
  await maker.wallet.send({ address, amount: Number(sats), assets: BigInt(dollars) > 0n ? [{ assetId: usd, amount: BigInt(dollars) * USD }] : [] });
  console.log(`sent ${sats} sats + $${dollars} demo USD to ${address}`);
  await maker.wallet.dispose();
  process.exit(0);
}

const children: ChildProcess[] = [];
const run = (name: string, cmd: string, argv: string[], env: Record<string, string> = {}) => {
  const child = spawn(cmd, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim() && !l.includes('Esplora websocket')) console.log(`[${name}] ${l}`); };
  child.stdout!.on('data', out); child.stderr!.on('data', out);
  child.on('exit', code => console.log(`[${name}] exited ${code}`));
  children.push(child);
};
const shutdown = () => { for (const c of children) c.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
await maker.wallet.dispose();

console.log(`demo USD asset ${usd}`);
run('striker', process.execPath, ['--import', 'tsx', 'apps/striker/src/main.ts'], { ASSET_ID: usd, STRIKER_SECRET: hex(secret(221)) });
await new Promise(r => setTimeout(r, 3_000));
run('maker', process.execPath, ['--import', 'tsx', 'apps/maker/src/main.ts'], {
  MAKER_SECRET: hex(secret(220)), ...(process.env.LIVE_PRICE ? {} : { FIXED_PRICE: process.env.FIXED_PRICE ?? '100000' }),
  OFFER_SATS: '2000000', OFFER_ASSET: String(2_000n * USD),
});
if (existsSync(`${root}apps/web/package.json`)) run('web', 'npm', ['run', 'dev', '-w', 'apps/web']);
