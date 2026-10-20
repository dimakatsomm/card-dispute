import { expect, type Locator, type Page } from '@playwright/test';

const accountLinks = (page: Page): Locator => page.getByRole('list', { name: 'Accounts' }).locator('a[href^="/accounts/"]');

const loadMore = (page: Page): Locator => page.getByRole('button', { name: 'Load more transactions' });

// Rows arrive after the table renders and later pages sit behind "Load more", so wait and page before giving up.
const hasDisputableRow = async (page: Page, disputeLinks: Locator): Promise<boolean> => {
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const found = await disputeLinks
      .first()
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (found) return true;
    if (!(await loadMore(page).isVisible())) return false;
    await loadMore(page).click();
  }
  return false;
};

// Disputes are never deleted, so a card's disputable rows run out: walk accounts and cards for one that still has some.
export const openCardWithDisputableRow = async (page: Page): Promise<Locator> => {
  const disputeLinks = page.getByRole('link', { name: /^Dispute .+ on / });
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await expect(accountLinks(page).first()).toBeVisible();
  const accountCount = await accountLinks(page).count();
  for (let account = 0; account < accountCount; account++) {
    await page.getByRole('link', { name: 'Accounts', exact: true }).click();
    await accountLinks(page).nth(account).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Transactions' })).toBeVisible();
    const cards = page.getByRole('list', { name: /^Cards on / }).getByRole('link');
    const cardCount = await cards.count();
    for (let card = 0; card < cardCount; card++) {
      if ((await cards.nth(card).textContent())?.includes('(Expired)')) continue;
      await cards.nth(card).click();
      await expect(page.getByRole('table')).toBeVisible();
      if (await hasDisputableRow(page, disputeLinks)) return disputeLinks;
      await page.goBack();
    }
  }
  throw new Error('No disputable transaction left for customer A: reseed the local stack');
};
