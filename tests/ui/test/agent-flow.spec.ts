import { expect, test, type Page } from '@playwright/test';
import { openCardWithDisputableRow } from '../fixtures/cards.ts';

const AGENT_NAME = 'Naledi M.';

// Created through the customer UI in its own context: an agent tab must never hold a customer session.
const customerRaisesDispute = async (page: Page): Promise<string> => {
  await page.goto('/');
  await page.getByRole('button', { name: /^A - / }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Hello, / })).toBeVisible();
  const link = (await openCardWithDisputableRow(page)).last();
  const transactionId = (await link.getAttribute('href'))?.match(/\/transactions\/([^/]+)\/dispute$/)?.[1];
  if (transactionId === undefined) throw new Error('no transaction id on the dispute link');
  await link.click();
  await page.getByLabel('Reason').selectOption({ label: 'I was charged more than once' });
  await page.getByLabel('What happened?').fill(`UI back-office test ${new Date().toISOString()}`);
  await page.getByRole('button', { name: 'Submit dispute' }).click();
  await expect(page).toHaveURL(new RegExp(`/disputes/${transactionId}$`));
  return transactionId;
};

// The queue is oldest first and shared with every earlier run, so page until the row appears.
const openFromQueue = async (page: Page, transactionId: string) => {
  const open = page.locator(`a[href="/agent/disputes/${transactionId}"]`);
  const loadMore = page.getByRole('button', { name: 'Load more' });
  await expect(page.getByRole('heading', { level: 1, name: 'Review queue' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  for (let pageNo = 0; pageNo < 20 && !(await open.isVisible()); pageNo++) {
    if (!(await loadMore.isVisible())) break;
    await loadMore.click();
    await expect(loadMore.or(open)).toBeVisible();
  }
  await expect(open).toBeVisible();
  await open.click();
};

test('agent signs in, opens the dispute from the queue, picks it up and resolves it', async ({ browser, page }) => {
  test.setTimeout(150_000);
  const customer = await browser.newContext();
  const transactionId = await customerRaisesDispute(await customer.newPage());
  await customer.close();

  await page.goto('/agent');
  await page.getByRole('button', { name: 'Agent sign-in' }).click();
  await page.getByRole('button', { name: /^E - / }).click();
  await expect(page).toHaveURL(/\/agent(\?.*)?$/);

  await page.getByLabel('Status').selectOption({ label: 'Submitted' });
  await openFromQueue(page, transactionId);

  await expect(page).toHaveURL(new RegExp(`/agent/disputes/${transactionId}$`));
  const details = page.getByRole('region', { name: 'Dispute details' });
  await expect(details).toContainText('Submitted');

  await page.getByRole('button', { name: 'Pick up' }).click();
  await expect(page.getByRole('status')).toHaveText('You picked up this dispute.');
  await expect(details).toContainText(`Picked up by ${AGENT_NAME}`);
  await expect(details).toContainText('Under review');

  const note = `Refund approved in the UI test ${Date.now()}`;
  await page.getByRole('radio', { name: 'Accept: the customer is refunded' }).check();
  await page.getByLabel('Note to the customer').fill(note);
  await page.getByRole('button', { name: 'Resolve dispute' }).click();

  await expect(page.getByRole('status')).toHaveText('Dispute resolved: accepted.');
  await expect(details).toContainText('Resolved: accepted');
  await expect(details).toContainText(`Resolution note: ${note}`);
  await expect(page.getByRole('button', { name: 'Pick up' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Resolve dispute' })).toHaveCount(0);
});
