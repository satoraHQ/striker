// A dishonest Striker: the page must refuse to show a deposit address whose covenant doesn't match
// what the user asked for, even when the server makes the address consistent with altered terms.
import { fetchChainParams, swapCovenant, termsFromWire, termsToWire, type SwapView, type SwapTerms } from '@striker/core';
import type { Page } from '@playwright/test';
import { expect, fillSwap, test } from './fixtures.ts';

const chain = fetchChainParams(process.env.ARK_URL ?? 'http://localhost:7070');

/** Rewrites every swap view the page receives, re-deriving the address from the altered terms. */
async function tamper(page: Page, edit: (t: SwapTerms) => SwapTerms, rebuild = true) {
  const params = await chain;
  await page.route(/\/v1\/swaps(\/[^/]+)?$/, async route => {
    if (route.request().url().endsWith('/preview')) return route.continue();
    const res = await route.fetch();
    const view = await res.json() as SwapView;
    const terms = edit(termsFromWire(view.terms));
    const out = { ...view, terms: termsToWire(terms), ...(rebuild ? { address: swapCovenant(params, terms).address } : {}) };
    await route.fulfill({ response: res, json: out });
  });
}

async function attempt(page: Page, address: string) {
  await page.goto('/');
  await fillSwap(page, { sell: 'BTC', mode: 'send', amount: '50000', receive: address });
  await page.getByRole('button', { name: 'Create swap' }).click();
  await expect(page.getByText('Do not pay this swap.')).toBeVisible();
  await expect(page.getByTestId('deposit-address')).toHaveCount(0);
  await expect(page.getByText('✓ address verified locally')).toHaveCount(0);
}

test('a worse guaranteed rate than quote − slippage', async ({ page, user }) => {
  await tamper(page, t => ({ ...t, rate: { num: t.rate.num * 9n, den: t.rate.den * 10n } }));
  await attempt(page, user.address);
  await expect(page.getByText('Covenant guarantees a worse rate than the quote minus your slippage')).toBeVisible();
});

test('a different receive script', async ({ page, user }) => {
  await tamper(page, t => ({ ...t, receive: t.feeScript }));
  await attempt(page, user.address);
  await expect(page.getByText('Covenant pays a different receive address')).toBeVisible();
});

test('a higher fee', async ({ page, user }) => {
  await tamper(page, t => ({ ...t, feeBps: t.feeBps + 100n }));
  await attempt(page, user.address);
  await expect(page.getByText('Fee differs from the advertised fee')).toBeVisible();
});

test('a different refund key', async ({ page, user }) => {
  await tamper(page, t => ({ ...t, refundPubkey: new Uint8Array(32).fill(9) }));
  await attempt(page, user.address);
  await expect(page.getByText('Covenant uses a different refund key')).toBeVisible();
});

test('an address that does not match its terms', async ({ page, user }) => {
  await tamper(page, t => ({ ...t, deadline: t.deadline + 1n }), false);
  await attempt(page, user.address);
  await expect(page.getByText('Deposit address does not match the covenant built from its terms')).toBeVisible();
});
