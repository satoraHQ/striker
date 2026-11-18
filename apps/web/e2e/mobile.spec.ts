import { expect, test } from './fixtures.ts';

test('fits a phone screen and keeps the book collapsed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create swap' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator('details').filter({ hasText: 'Order book' })).not.toHaveAttribute('open', '');
  await page.getByText('Order book').click();
  await expect(page.getByText('$100,500.00').first()).toBeVisible();
});
