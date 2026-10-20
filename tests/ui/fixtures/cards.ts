import { expect, type Locator, type Page } from '@playwright/test';

const accountLinks = (page: Page): Locator => page.getByRole('list', { name: 'Accounts' }).locator('a[href^="/accounts/"]');

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
      if ((await disputeLinks.count()) > 0) return disputeLinks;
      await page.goBack();
    }
  }
  throw new Error('No disputable transaction left for customer A: reseed the local stack');
};
