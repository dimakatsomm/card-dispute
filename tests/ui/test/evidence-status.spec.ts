import { expect, test, type Locator, type Page } from '@playwright/test';
import { eicarBytes } from '../fixtures/eicar.ts';
import { openCardWithDisputableRow } from '../fixtures/cards.ts';
import { minimalPdf } from '../fixtures/pdf.ts';

const SCAN_BUDGET_MS = 75_000;

const signInAs = async (page: Page, user: 'A' | 'B') => {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(`^${user} - `) }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Hello, / })).toBeVisible();
};

type File = { readonly name: string; readonly mimeType: string; readonly buffer: Buffer };

// Last disputable row: the M1 smoke and parallel runs take the first ones.
const createDispute = async (page: Page, file?: File) => {
  const links = await openCardWithDisputableRow(page);
  await links.last().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dispute a transaction' })).toBeVisible();
  await page.getByLabel('Reason').selectOption({ label: 'I was charged more than once' });
  await page.getByLabel('What happened?').fill(`UI evidence status test ${new Date().toISOString()}`);
  if (file) {
    await page.getByLabel('Evidence (optional)').setInputFiles(file);
    await expect(page.getByRole('list', { name: 'Selected files' })).toContainText(file.name);
  }
  await page.getByRole('button', { name: 'Submit dispute' }).click();
  await expect(page).toHaveURL(/\/disputes\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1, name: /^Dispute: / })).toBeVisible();
};

const evidenceItem = (page: Page, fileName: string): Locator =>
  page.getByRole('list', { name: 'Evidence' }).getByRole('listitem').filter({ hasText: fileName });

// The detail screen stops polling after 20 polls and offers Refresh; use it instead of a reload.
const waitForStatus = async (page: Page, item: Locator, status: string) => {
  await expect(async () => {
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    if (await refresh.isVisible()) await refresh.click();
    await expect(item).toContainText(status, { timeout: 5_000 });
  }).toPass({ timeout: SCAN_BUDGET_MS, intervals: [1_000] });
};

const uniqueName = (prefix: string, ext: string) => `${prefix}-${Date.now()}.${ext}`;

test.describe('evidence status', () => {
  test.setTimeout(180_000);

  test('a clean PDF shows Scanning, then Stored and "Evidence added" without a reload', async ({ page }) => {
    const name = uniqueName('clean', 'pdf');
    await signInAs(page, 'B');
    await createDispute(page, { name, mimeType: 'application/pdf', buffer: minimalPdf() });

    const item = evidenceItem(page, name);
    await expect(item).toContainText('Scanning');
    await waitForStatus(page, item, 'Stored');
    await expect(page.getByRole('list', { name: 'Dispute timeline' }).getByText('Evidence added')).toBeVisible();
  });

  test('an EICAR file declared as a PDF is Rejected with the malware message', async ({ page }) => {
    const name = uniqueName('eicar', 'pdf');
    await signInAs(page, 'B');
    await createDispute(page, { name, mimeType: 'application/pdf', buffer: eicarBytes() });

    const item = evidenceItem(page, name);
    await waitForStatus(page, item, 'Rejected');
    await expect(item).toContainText('the file failed the security scan');
    await expect(item).not.toContainText('Stored');
  });

  test('a seeded resolved dispute shows its resolution note', async ({ page }) => {
    await signInAs(page, 'A');
    await page.getByRole('link', { name: 'Disputes', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your disputes' })).toBeVisible();
    const resolved = page.getByRole('list', { name: 'Disputes' }).getByRole('listitem');
    await expect(resolved.first()).toBeVisible();
    const filter = page.getByRole('checkbox', { name: 'Resolved in your favour' });
    await filter.click();
    await expect(filter).toBeChecked();
    await expect(resolved.first()).toContainText('Resolved in your favour');
    const loadMore = page.getByRole('button', { name: 'Load more' });
    while (await loadMore.isVisible()) {
      const before = await resolved.count();
      await loadMore.click();
      await expect.poll(() => resolved.count()).toBeGreaterThan(before);
    }

    // Other runs may leave resolved disputes with no note; the seeded one has this note.
    const note = 'Note from the bank: Merchant confirmed the cancellation; full amount refunded.';
    const count = await resolved.count();
    let found = false;
    for (let index = 0; index < count && !found; index++) {
      await resolved.nth(index).getByRole('link').first().click();
      const resolution = page.getByRole('region', { name: 'Resolution' });
      await expect(resolution).toContainText('Resolved in your favour');
      found = ((await resolution.textContent()) ?? '').includes(note);
      if (!found) await page.goBack();
    }
    expect(found, 'a resolved dispute with the seeded note').toBe(true);
    await expect(page.getByRole('region', { name: 'Resolution' })).toContainText(note);
  });

  test('the add-evidence screen adds a file to an open dispute and it reaches Stored', async ({ page }) => {
    const name = uniqueName('later', 'pdf');
    await signInAs(page, 'B');
    await createDispute(page);
    await expect(page.getByText('No evidence attached.')).toBeVisible();

    await page.getByRole('link', { name: 'Add evidence' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add evidence' })).toBeVisible();
    await page.getByLabel('Files').setInputFiles({ name, mimeType: 'application/pdf', buffer: minimalPdf() });
    await page.getByRole('button', { name: 'Add files' }).click();

    await expect(page.getByRole('heading', { level: 1, name: /^Dispute: / })).toBeVisible({ timeout: 30_000 });
    const item = evidenceItem(page, name);
    await expect(item).toBeVisible();
    await waitForStatus(page, item, 'Stored');
    await expect(page.getByRole('list', { name: 'Dispute timeline' }).getByText('Evidence added')).toBeVisible();
  });
});
