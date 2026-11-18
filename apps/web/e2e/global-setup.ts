import { closeWallets, fund, openWallet, startStack, USD } from '../../../scripts/testnet.js';

const STRIKER_PORT = 7190;

/** Striker + maker for the whole run, and a funded user wallet the tests pay deposits from. */
export default async function globalSetup() {
  // SWAP_TTL is short so the refund test sees a deadline pass.
  const stack = await startStack({ name: 'web', port: STRIKER_PORT, swapTtl: 90, fixedPrice: 100_000 });
  const user = await openWallet('web-user');
  await fund(user, { sats: 600_000n, usd: 200n * USD });
  await closeWallets();
  process.env.E2E_STRIKER_URL = stack.url;
  process.env.E2E_USD = stack.usd;
  return async () => { await stack.stop(); };
}
