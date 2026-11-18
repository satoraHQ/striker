// Local prototype on the regtest stack (`npm run regtest -- start` first): Striker (:7090), a maker
// bot and the web app (:5173).
//   npm run dev                                       start everything
//   npm run dev -- faucet <ark address> [sats] [usd]  send regtest sats and demo USD from the bank
//                                                     wallet to a wallet you want to swap from
// LIVE_PRICE=1 quotes around Binance instead of $100k.
import { spawn, type ChildProcess } from 'node:child_process';
import { bank, closeWallets, root, startStack, USD } from './testnet.js';

const [command, ...args] = process.argv.slice(2);

if (command === 'faucet') {
  const [address, sats = '200000', dollars = '500'] = args;
  if (!address) throw new Error('usage: npm run dev -- faucet <ark address> [sats] [usd]');
  const { w, usd } = await bank(BigInt(sats));
  await w.wallet.send({ address, amount: Number(sats), assets: BigInt(dollars) > 0n ? [{ assetId: usd, amount: BigInt(dollars) * USD }] : [] });
  console.log(`sent ${sats} sats + $${dollars} demo USD (${usd}) to ${address}`);
  await closeWallets();
  process.exit(0);
}

const stack = await startStack({
  name: 'dev', port: Number(process.env.PORT ?? 7090),
  ...(process.env.LIVE_PRICE ? {} : { fixedPrice: Number(process.env.FIXED_PRICE ?? 100_000) }),
});
await closeWallets();
console.log(`Striker ${stack.url} on ${stack.info.network}, demo USD ${stack.usd}`);
const children: ChildProcess[] = [];
const web = spawn('npm', ['run', 'dev', '-w', 'apps/web'], { cwd: root, env: { ...process.env, VITE_STRIKER_URL: stack.url }, stdio: ['ignore', 'pipe', 'pipe'] });
const out = (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) console.log(`  [web] ${l}`); };
web.stdout!.on('data', out); web.stderr!.on('data', out);
children.push(web);
const shutdown = async () => { for (const c of children) c.kill('SIGTERM'); await stack.stop(); process.exit(0); };
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
