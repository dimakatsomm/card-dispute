import { expect, test, type Locator, type Page } from '@playwright/test';
import { openCardWithDisputableRow } from '../../ui/fixtures/cards.ts';
import { minimalPdf } from '../../ui/fixtures/pdf.ts';
import { personaACredentials } from './credentials.ts';
import { uiEnv } from './env.ts';
import { claimSlot } from './ledger.ts';

const EVIDENCE_BUDGET_MS = 150_000;
const FILE_NAME = `e2e-ui-${Date.now()}.pdf`;

// fill() errors echo the typed value, so secrets go through this and failures are sanitised.
const typeSecret = async (field: Locator, value: string, what: string): Promise<void> => {
  await expect(field, `${what} field on the hosted login`).toBeVisible();
  try {
    await field.fill(value);
  } catch {
    throw new Error(`could not fill the ${what} field on the hosted login`);
  }
};

const signInThroughHostedUi = async (page: Page): Promise<void> => {
  const { webOrigin } = uiEnv();
  const credentials = await personaACredentials();
  await page.goto('/');

  const signInEntry = page.getByRole('button', { name: /^sign in$/i });
  if (new URL(page.url()).origin === webOrigin && (await signInEntry.isVisible().catch(() => false)))
    await signInEntry.click();

  // The classic hosted UI renders a hidden duplicate form, so only visible inputs count.
  const username = page.locator('input[name="username"]:visible, input[type="email"]:visible').first();
  const password = page.locator('input[type="password"]:visible').first();
  await typeSecret(username, credentials.username, 'username');
  await typeSecret(password, credentials.password, 'password');
  await page
    .getByRole('button', { name: /^(sign in|log in|continue)$/i })
    .locator(':visible')
    .first()
    .click();

  await expect(
    page.getByRole('heading', { level: 1, name: /^Hello, / }),
    'landed on the app after login',
  ).toBeVisible({
    timeout: 60_000,
  });
  expect(new URL(page.url()).origin).toBe(webOrigin);
};

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  if (new URL(page.url()).origin !== uiEnv().webOrigin) return;
  await page.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => undefined);
});

test('customer A signs in with Cognito, disputes with evidence, sees Submitted, withdraws with a warning', async ({
  page,
}) => {
  await signInThroughHostedUi(page);

  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Accounts' }).locator('a[href^="/accounts/"]').first(),
  ).toBeVisible();

  // Tokens live in memory, so only navigate in-app: a reload would sign the user out.
  const disputeLink = (await openCardWithDisputableRow(page)).first();
  const transactionId = (await disputeLink.getAttribute('href'))?.match(
    /\/transactions\/([^/]+)\/dispute$/,
  )?.[1];
  expect(transactionId, 'a disputable row on the card').toBeTruthy();

  claimSlot();
  await disputeLink.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dispute a transaction' })).toBeVisible();
  await page.getByLabel('Reason').selectOption({ label: 'I was charged more than once' });
  await page.getByLabel('What happened?').fill(`AWS UI e2e dispute ${new Date().toISOString()}`);
  await page.getByLabel('Evidence (optional)').setInputFiles({
    name: FILE_NAME,
    mimeType: 'application/pdf',
    buffer: minimalPdf(),
  });
  await expect(page.getByRole('list', { name: 'Selected files' })).toContainText(FILE_NAME);
  await page.getByRole('button', { name: 'Submit dispute' }).click();

  await expect(page).toHaveURL(new RegExp(`/disputes/${transactionId}$`), { timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1, name: /^Dispute: / })).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Dispute timeline' });
  await expect(timeline.getByText('Dispute submitted')).toBeVisible();

  // The detail screen stops polling after a while and offers Refresh; use it instead of a reload.
  const evidence = page
    .getByRole('list', { name: 'Evidence' })
    .getByRole('listitem')
    .filter({ hasText: FILE_NAME });
  await expect(async () => {
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    if (await refresh.isVisible()) await refresh.click();
    await expect(evidence).toContainText('Stored', { timeout: 5_000 });
  }).toPass({ timeout: EVIDENCE_BUDGET_MS, intervals: [2_000] });
  await expect(timeline.getByText('Evidence added')).toBeVisible();

  await page.getByRole('button', { name: 'Withdraw dispute' }).click();
  const warning = page.getByRole('alertdialog', { name: 'Withdraw this dispute?' });
  await expect(warning).toContainText('this transaction can never be disputed again');
  await warning.getByRole('button', { name: 'Withdraw dispute' }).click();
  await expect(page.getByText('Your dispute has been withdrawn.')).toBeVisible();
  await expect(timeline.getByText('Dispute withdrawn')).toBeVisible();
});
