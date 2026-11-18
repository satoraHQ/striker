// Real swaps through the browser: the page creates and verifies the swap, the user wallet pays the
// deposit address it shows, and the page follows the swap to its end.
import { schnorr } from '@noble/curves/secp256k1.js';
import type { SwapView } from '@striker/core';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { balanceOf, createSwap, expect, fillSwap, pay, row, striker, test, USD_ID, waitFor } from './fixtures.ts';

// One browser context for the whole file: the swaps it creates stay in its local storage, as they
// would for a user, which the reload test relies on.
test.describe.configure({ mode: 'serial' });
let page: Page;
test.beforeAll(async ({ browser }, info) => {
  const { baseURL, serviceWorkers } = info.project.use;
  page = await (await browser.newContext({ baseURL, serviceWorkers })).newPage();
});
test.afterAll(async () => { await page.context().close(); });

const final = (id: string, ms = 120_000) => waitFor(async () => {
  const v = await striker<SwapView>(`/v1/swaps/${id}`);
  return ['filled', 'refunded', 'failed'].includes(v.status) ? v : undefined;
}, `swap ${id}`, ms, 1_000);

test('sell BTC for USD (exact-in)', async ({ user }) => {
  await page.goto('/');
  await fillSwap(page, { sell: 'BTC', mode: 'send', amount: '50000', receive: user.address });
  await expect(row(page, 'You send')).toHaveText('50,000 sats');
  const expected = await row(page, 'You receive (expected)').textContent();
  const { id, view } = await createSwap(page);
  await expect(page.getByText('Send exactly')).toBeVisible();
  await expect(page.getByText('50,000 sats', { exact: true })).toBeVisible();
  await expect(page.getByAltText('Deposit address QR code')).toBeVisible();

  const before = await balanceOf(user, USD_ID);
  await pay(user, view);
  await expect(page.getByText('Swap filled. Funds are at your receive address.')).toBeVisible({ timeout: 60_000 });
  await expect(row(page, 'Received')).toHaveText(expected!);
  const done = await final(id);
  const after = await waitFor(async () => { const b = await balanceOf(user, USD_ID); return b.asset > before.asset ? b : undefined; }, 'USD received');
  expect(after.asset - before.asset).toBe(BigInt(done.received!.asset));
});

test('buy exactly 20 000 sats with USD (exact-out)', async ({ user }) => {
  await page.goto('/');
  await fillSwap(page, { sell: 'USD', mode: 'receive', amount: '20000', receive: user.address });
  const { id, view } = await createSwap(page);
  expect(view.deposit.asset?.id).toBe(USD_ID);
  await expect(page.getByText(/^\$[\d.]+ USD$/)).toBeVisible();
  await pay(user, view);
  await expect(page.getByText('Swap filled. Funds are at your receive address.')).toBeVisible({ timeout: 60_000 });
  const done = await final(id);
  expect(done.status).toBe('filled');
  expect(BigInt(done.received!.sats)).toBeGreaterThanOrEqual(20_000n);
});

test('buy exactly $12.34 with BTC (exact-out)', async ({ user }) => {
  await page.goto('/');
  await fillSwap(page, { sell: 'BTC', mode: 'receive', amount: '12.34', receive: user.address, slippage: '1%' });
  const { id, view } = await createSwap(page);
  await pay(user, view);
  await expect(row(page, 'Received')).toHaveText('$12.34', { timeout: 60_000 });
  expect((await final(id)).received!.asset).toBe('1234000000');
});

test('swaps survive a reload and the refund key backup matches the covenant', async () => {
  await page.goto('/');
  const list = page.getByRole('heading', { name: 'My swaps' }).locator('..');
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByText('filled')).toHaveCount(3);
  await page.reload();
  await list.getByRole('button', { name: /BTC → USD · send 50,000 sats/ }).click();
  await expect(page.getByText('Swap filled.')).toBeVisible();
  await page.getByText('Save this refund key').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
  const backup = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  const pub = Buffer.from(schnorr.getPublicKey(Buffer.from(backup.refundSecretKey, 'hex'))).toString('hex');
  expect(pub).toBe(backup.refundPubkey);
  expect(backup.terms.refundPubkey).toBe(pub);
});

test('an underpaid swap is not filled and refunds after the deadline', async ({ user }) => {
  test.setTimeout(360_000);
  await page.goto('/');
  await fillSwap(page, { sell: 'BTC', mode: 'receive', amount: '5', receive: user.address });
  const { id, view } = await createSwap(page);
  await pay(user, view, -1_000);
  // The panel is the first card; the swap list repeats the badge.
  await expect(page.locator('section').first().getByText('deposited', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Refunded to your refund address.')).toBeVisible({ timeout: 300_000 });
  await expect(row(page, 'Refund tx')).toBeVisible();
  expect((await final(id)).status).toBe('refunded');
});
