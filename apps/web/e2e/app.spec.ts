import { ArkAddress } from '@arkade-os/sdk';
import { expect, test } from './fixtures.ts';

test('shows the network, the live book and the mid price', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('regtest', { exact: true })).toBeVisible();
  // The maker quotes ±50 bps around $100,000.
  await expect(page.getByText('$100,000.00')).toBeVisible();
  await expect(page.getByText('$100,500.00').first()).toBeVisible();
  await expect(page.getByText('$99,500.00').first()).toBeVisible();
  await expect(page.getByRole('group').filter({ hasText: 'Order book' }).getByText('live')).toBeVisible();
});

test('validates amounts and addresses before enabling the swap', async ({ page, user }) => {
  await page.goto('/');
  const create = page.getByRole('button', { name: 'Create swap' });
  const receive = page.getByLabel(/^Receive .* to \(Ark address\)$/);

  await page.getByLabel('Amount').fill('1.5');
  await expect(page.getByText('Whole sats only')).toBeVisible();
  await page.getByRole('button', { name: 'I receive', exact: true }).click();
  await page.getByLabel('Amount').fill('1.123456789');
  await expect(page.getByText('At most 8 decimals')).toBeVisible();
  await page.getByLabel('Amount').fill('10');
  await expect(page.getByText('Exact amount you receive, after fees')).toBeVisible();

  await receive.fill('hello');
  await expect(page.getByText('Not a valid Ark address')).toBeVisible();
  const a = ArkAddress.decode(user.address);
  await receive.fill(new ArkAddress(a.serverPubKey, a.vtxoTaprootKey, 'ark').encode());
  await expect(page.getByText('Expected a tark1… address')).toBeVisible();
  await receive.fill(new ArkAddress(new Uint8Array(32).fill(7), a.vtxoTaprootKey, 'tark').encode());
  await expect(page.getByText('Address belongs to a different Ark server')).toBeVisible();
  await expect(create).toBeDisabled();

  await receive.fill(user.address);
  await page.getByLabel('Refund to the same address').uncheck();
  await page.getByLabel('Refund address (Ark address)').fill('nope');
  await expect(create).toBeDisabled();
  await page.getByLabel('Refund address (Ark address)').fill(user.address);
  await expect(create).toBeEnabled();
});

test('the live estimate follows the amount and slippage', async ({ page, user }) => {
  await page.goto('/');
  await page.getByLabel('Amount').fill('100000');
  await page.getByLabel(/^Receive .* to \(Ark address\)$/).fill(user.address);
  // 100 000 sats less the 330-sat carrier of the USD output, at the $99,500 bid, less the 0.3% fee.
  await expect(page.locator('[data-row="You receive (expected)"] > span:last-child')).toHaveText('$98.87');
  const min = page.locator('[data-row="Guaranteed minimum"] > span:last-child');
  await expect(page.getByRole('button', { name: '0%', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '0.1%', exact: true }).click();
  await expect(min).toHaveText(/^\$98\.7\d$/);
  await page.getByRole('button', { name: '1%', exact: true }).click();
  await expect(min).toHaveText(/^\$97\.8\d$/);
  await expect(page.locator('[data-row="Maker price"] > span:last-child')).toHaveText('$99,500.00 / BTC');
});

test('shows a banner and recovers when Striker is unreachable', async ({ page }) => {
  test.setTimeout(60_000);
  await page.route('**/v1/**', route => route.abort('connectionrefused'));
  await page.goto('/');
  await expect(page.getByText("Striker offline: can't reach the server")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Striker offline' })).toBeDisabled();
  await page.unroute('**/v1/**');
  await expect(page.getByText("Striker offline: can't reach the server")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText('$100,000.00')).toBeVisible();
});

test.describe('PWA', () => {
  test.use({ serviceWorkers: 'allow' });
  test('serves a manifest and registers a service worker', async ({ page }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifest = await (await page.request.get(href!)).json();
    expect(manifest).toMatchObject({ name: 'Striker', display: 'standalone' });
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active)).toBe(true);
  });
});
