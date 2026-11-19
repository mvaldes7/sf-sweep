import { test, expect } from '@playwright/test';

test('house-number lookup, unit normalization, side selection and street search', async ({ page }, info) => {
  let addressRequests = 0;
  page.on('request', r => { if (r.url().endsWith('/addresses.json')) addressRequests++; });
  await page.goto('/');
  const input = page.locator('#q');
  // Street-only search keeps working without paying the address-index download cost.
  await input.fill('30th ave');
  await expect(page.locator('#results li').first()).toBeVisible();
  expect(addressRequests).toBe(0);
  for (const [query, title, side] of [
    ['534 30th ave', '30th Ave', 'EAST'],
    ['1000 Valencia Street Apt 3', 'Valencia St', 'WEST'],
  ]) {
    await input.fill(query);
    await expect(page.locator('#results li').first()).toBeVisible();
    expect(await page.locator('#results li').first().textContent()).toContain(query.startsWith('534') ? '534 30TH AVE' : '1000 VALENCIA ST');
    await page.screenshot({ path: `address-shots/${info.project.name}-${query.startsWith('534') ? '534-30th' : '1000-valencia'}-results.png` });
    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'search-0');
    await input.press('Enter');
    await expect(page.locator('#detail h2')).toHaveText(title);
    await expect(page.locator('#detail .picked .side-h')).toContainText(side);
    await expect(page.locator('#results')).toBeHidden();
    // Allow the camera animation and tile rendering to settle for evidence, not assertions.
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `address-shots/${info.project.name}-${query.startsWith('534') ? '534-30th' : '1000-valencia'}-selected.png` });
    await page.locator('#detail .close').click();
  }
  expect(addressRequests).toBe(1);
  await input.fill('534A 30th Avenue #2');
  await expect(page.locator('#results li').first()).toContainText('Base address; suffix not found');
  await input.fill('99999 30th Ave');
  await expect(page.locator('#search-status')).toContainText('No address found');
  await input.fill('30th ave');
  await expect(page.locator('#results li').first()).toBeVisible();
  await input.press('Escape');
  await expect(page.locator('#results')).toBeHidden();
});
