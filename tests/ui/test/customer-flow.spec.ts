import { expect, test, type Page } from '@playwright/test';
import { openCardWithDisputableRow } from '../fixtures/cards.ts';
import { minimalPdf } from '../fixtures/pdf.ts';

const signInAsA = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^A - / }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Hello, / })).toBeVisible();
};

test('customer A disputes a transaction with evidence, sees it listed, withdraws with a warning', async ({ page }) => {
  await signInAsA(page);

  await page.getByRole('list', { name: 'Accounts' }).getByRole('link', { name: /^Cheque account/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Transactions' })).toBeVisible();

  // Expired card first: its rows must never offer a Dispute button.
  await page.getByRole('link', { name: /\(Expired\)/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /\(Expired\)/ })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Dispute .+ on / })).toHaveCount(0);

  // Tokens live in memory, so navigate in-app: a reload would sign the user out.
  await page.goBack();

  // A disputed or withdrawn row stops being disputable and rows run out, so find a card that still has one.
  const disputeLink = (await openCardWithDisputableRow(page)).first();
  const href = await disputeLink.getAttribute('href');
  const transactionId = href?.match(/\/transactions\/([^/]+)\/dispute$/)?.[1];
  expect(transactionId, 'a disputable row on the card').toBeTruthy();
  await disputeLink.click();

  await expect(page.getByRole('heading', { level: 1, name: 'Dispute a transaction' })).toBeVisible();
  await page.getByLabel('Reason').selectOption({ label: 'I was charged more than once' });
  await page.getByLabel('What happened?').fill(`UI smoke test dispute ${new Date().toISOString()}`);
  await page.getByLabel('Evidence (optional)').setInputFiles({
    name: 'receipt.pdf',
    mimeType: 'application/pdf',
    buffer: minimalPdf(),
  });
  await expect(page.getByRole('list', { name: 'Selected files' })).toContainText('receipt.pdf');
  await page.getByRole('button', { name: 'Submit dispute' }).click();

  // The upload to moto completes and the form hands over to the detail page.
  await expect(page).toHaveURL(new RegExp(`/disputes/${transactionId}$`));
  await expect(page.getByRole('heading', { level: 1, name: /^Dispute: / })).toBeVisible();

  // Timeline shows SUBMITTED.
  await expect(page.getByRole('list', { name: 'Dispute timeline' }).getByText('Dispute submitted')).toBeVisible();
  await expect(page.getByText('receipt.pdf').first()).toBeVisible();

  // The transaction row shows the dispute and no longer offers a button.
  await page.goBack();
  const row = page.getByRole('row').filter({ has: page.locator(`a[href="/disputes/${transactionId}"]`) });
  await expect(row.getByRole('link', { name: 'Dispute submitted' })).toBeVisible();
  await expect(row.getByRole('link', { name: /^Dispute .+ on / })).toHaveCount(0);

  // The disputes list includes it.
  await page.getByRole('link', { name: 'Disputes', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your disputes' })).toBeVisible();
  const listed = page.getByRole('list', { name: 'Disputes' }).getByRole('listitem').filter({
    has: page.locator(`a[href="/disputes/${transactionId}"]`),
  });
  await expect(listed).toContainText('Submitted');

  // Withdraw shows the warning.
  await listed.getByRole('link').first().click();
  await page.getByRole('button', { name: 'Withdraw dispute' }).click();
  const warning = page.getByRole('alertdialog', { name: 'Withdraw this dispute?' });
  await expect(warning).toContainText('this transaction can never be disputed again');
});
