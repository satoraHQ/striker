import { expect, test as base, type Page } from '@playwright/test';
import type { SwapView } from '@striker/core';
import { balanceOf, closeWallets, openWallet, waitFor, type TestWallet } from '../../../scripts/testnet.js';

export const STRIKER = process.env.E2E_STRIKER_URL ?? 'http://localhost:7190';
export const USD_ID = process.env.E2E_USD!;

export const test = base.extend<{}, { user: TestWallet }>({
  user: [async ({}, use) => { await use(await openWallet('web-user')); await closeWallets(); }, { scope: 'worker' }],
});
export { expect, balanceOf, waitFor };

export async function striker<T>(path: string): Promise<T> {
  const res = await fetch(`${STRIKER}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface SwapForm { sell: 'BTC' | 'USD'; mode: 'send' | 'receive'; amount: string; receive: string; slippage?: string }

/** Fills the simple-flow form and waits for the live estimate. */
export async function fillSwap(page: Page, f: SwapForm) {
  await page.getByRole('button', { name: f.sell === 'BTC' ? 'Sell BTC → USD' : 'Sell USD → BTC' }).click();
  await page.getByRole('button', { name: f.mode === 'send' ? 'I send' : 'I receive', exact: true }).click();
  await page.getByLabel('Amount').fill(f.amount);
  if (f.slippage) await page.getByRole('button', { name: f.slippage, exact: true }).click();
  await page.getByLabel(/^Receive .* to \(Ark address\)$/).fill(f.receive);
  await expect(row(page, 'You receive (expected)')).toBeVisible();
}

export const row = (page: Page, label: string) => page.locator(`[data-row="${label}"] > span:last-child`);

/** Creates the swap from a filled form; returns its id and the server's view. */
export async function createSwap(page: Page) {
  await page.getByRole('button', { name: 'Create swap' }).click();
  await expect(page).toHaveURL(/#\/swap\/.+/);
  const id = decodeURIComponent(new URL(page.url()).hash.replace('#/swap/', ''));
  await expect(page.getByText('✓ address verified locally')).toBeVisible();
  const view = await striker<SwapView>(`/v1/swaps/${id}`);
  await expect(page.getByTestId('deposit-address')).toHaveText(view.address);
  return { id, view };
}

/** Pays a swap's deposit instructions from the user wallet. */
export function pay(user: TestWallet, view: SwapView, satsDelta = 0) {
  return user.wallet.send({
    address: view.address, amount: Number(view.deposit.sats) + satsDelta,
    assets: view.deposit.asset ? [{ assetId: view.deposit.asset.id, amount: BigInt(view.deposit.asset.amount) }] : [],
  });
}
