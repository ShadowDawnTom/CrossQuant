import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe.serial('local trading terminal', () => {
  test('onboards safely and contains modal focus', async ({ page }) => {
    await page.goto('/');

    const dialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    const acknowledgement = dialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' });
    await expect(dialog).toBeVisible();
    await expect(acknowledgement).toBeFocused();

    await acknowledgement.check();
    await dialog.getByRole('button', { name: /Continue in read-only mode/ }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Switch trading mode', exact: true })).toHaveText('Read-only');
    await expect(page.getByText('Reference data', { exact: true })).toHaveCount(0);
    await expect(page.locator('.headline-price span')).toHaveCount(0);

    const venueTrigger = page.getByRole('button', { name: 'Execution venue: Gate.io' });
    await venueTrigger.click({ position: { x: 8, y: 8 } });
    const venueMenu = page.getByRole('menu', { name: 'Execution venue' });
    await expect(venueMenu).toBeVisible();
    await expect(venueMenu.getByRole('menuitemradio', { name: /Gate\.io/ })).toHaveAttribute('aria-checked', 'true');
    const venueLogos = venueMenu.locator('.venue-icon img');
    await expect(venueLogos).toHaveCount(7);
    expect(await venueLogos.evaluateAll((images) => images.map((image) => image.getAttribute('src'))))
      .toEqual(expect.not.arrayContaining([expect.stringMatching(/^https?:\/\//)]));
  });

  test('guides live-mode users through missing Gate credential setup', async ({ page }) => {
    await page.goto('/');
    // The accessible dialog name changes with the selected language, so keep a stable container.
    const dialog = page.locator('.disclaimer-modal');
    const modeBadge = page.getByRole('button', { name: 'Switch trading mode', exact: true });
    await expect(dialog.or(modeBadge)).toBeVisible();
    if (!await dialog.isVisible()) await modeBadge.click();

    await dialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
    await dialog.getByRole('button', { name: /Enable live trading/ }).click();

    await expect(dialog.getByRole('heading', { name: 'Add your Gate API credentials' })).toBeVisible();
    await expect(dialog).toContainText('protected local .env file');
    await expect(dialog).not.toContainText('credential not configured');

    await dialog.getByRole('button', { name: '中文', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '添加 Gate API 密钥' })).toBeVisible();
    const popupPromise = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: /打开Gate API 密钥设置/ }).click();
    const credentialPage = await popupPromise;
    await expect(credentialPage).toHaveURL(/\/secure\/credentials\?intent=live-trading&lang=zh$/);
    await expect(credentialPage.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(credentialPage.getByRole('heading', { name: '添加 Gate API 密钥' })).toBeVisible();
    await expect(credentialPage.getByText(/您正在设置实盘交易/)).toBeVisible();
    await credentialPage.close();
    await dialog.getByRole('button', { name: 'EN', exact: true }).click();

    await page.route('**/api/onboarding/connection', async (route) => route.fulfill({ json: {
      configured: true,
      storage: 'env_file',
      label: 'Gate CrossEx (.env)',
      lastVerifiedAt: '2030-01-01T00:00:00.000Z',
      secureEntryPath: '/secure/credentials',
      readOnly: true,
    } }));
    await page.route('**/api/trading-mode', async (route) => {
      if (route.request().method() === 'POST') await route.fulfill({ json: { mode: 'live' } });
      else await route.continue();
    });

    await dialog.getByRole('button', { name: "I've saved credentials — enable live trading" }).click();
    await expect(dialog).toBeHidden();
    await expect(modeBadge).toHaveText('Live trading');
  });

  test('supports keyboard navigation for custom selectors and menus', async ({ page }) => {
    await page.goto('/');

    const marketTrigger = page.getByRole('button', { name: /BTCUSDT.*Bitcoin perpetual/ });
    await marketTrigger.click();
    const search = page.getByRole('combobox', { name: 'Search asset' });
    await expect(search).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('option')).not.toHaveCount(0);

    const firstActive = await search.getAttribute('aria-activedescendant');
    const firstOptionId = await page.getByRole('option').first().getAttribute('id');
    await search.press('End');
    await expect.poll(() => search.getAttribute('aria-activedescendant')).not.toBe(firstActive);
    await search.press('Home');
    await expect(search).toHaveAttribute('aria-activedescendant', firstOptionId ?? '');
    await search.press('Escape');
    await expect(marketTrigger).toBeFocused();

    const strategyTrigger = page.getByRole('button', { name: '⇄ Strategy', exact: true });
    await strategyTrigger.press('ArrowDown');
    const firstStrategy = page.getByRole('menuitem', { name: /Cross-exchange hedge/ });
    await expect(firstStrategy).toBeFocused();
    await firstStrategy.press('End');
    const finalStrategy = page.getByRole('menuitem', { name: /SK hynix premium bot/ });
    await expect(finalStrategy).toBeFocused();
    await finalStrategy.press('Escape');
    await expect(strategyTrigger).toBeFocused();

    const groupingTrigger = page.getByRole('button', { name: '0.1', exact: true });
    await groupingTrigger.click();
    const firstGrouping = page.getByRole('menuitemradio', { name: '0.1', exact: true });
    await expect(firstGrouping).toBeFocused();
    await firstGrouping.press('End');
    const finalGrouping = page.getByRole('menuitemradio', { name: '100', exact: true });
    await expect(finalGrouping).toBeFocused();
    await finalGrouping.press('Escape');
    await expect(groupingTrigger).toBeFocused();

    const venueTrigger = page.getByRole('button', { name: 'Execution venue: Gate.io' });
    await venueTrigger.press('ArrowDown');
    const firstVenue = page.getByRole('menuitemradio', { name: /Gate\.io/ });
    await expect(firstVenue).toBeFocused();
    await firstVenue.press('End');
    const finalVenue = page.getByRole('menuitemradio', { name: /Deribit/ });
    await expect(finalVenue).toBeFocused();
    await finalVenue.press('Escape');
    await expect(venueTrigger).toBeFocused();
  });

  test('shows total funding fees for grouped positions and preserves each venue leg', async ({ page }) => {
    await page.request.post('/__e2e/grouped-positions');
    try {
      await page.goto('/');
      const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
      if (await riskDialog.isVisible()) {
        await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
        await riskDialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
      }

      const groupedPosition = page.locator('.aggregate-row').filter({ hasText: 'HYPE PERP' });
      await expect(page.getByRole('columnheader', { name: 'Funding fee' })).toBeVisible();
      await expect(groupedPosition).toContainText('+1 USDT');

      await groupedPosition.locator('.expand-position').click();
      const legs = page.locator('.position-leg');
      await expect(legs).toHaveCount(2);
      await expect(legs.filter({ hasText: 'Hyperliquid' })).toContainText('+1.25 USDC');
      await expect(legs.filter({ hasText: 'Bybit' })).toContainText('-0.25 USDT');
    } finally {
      await page.request.delete('/__e2e/grouped-positions');
    }
  });

  test('loads route code on demand and passes automated accessibility checks', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /BTCUSDT/ })).toBeVisible();

    const loadedScripts = () => page.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => entry.name));
    await expect.poll(loadedScripts).toEqual(expect.arrayContaining([expect.stringContaining('trade-route-')]));
    expect(await loadedScripts()).not.toEqual(expect.arrayContaining([expect.stringContaining('funding-route-')]));
    await expect(page.getByText('View candle data', { exact: true })).toHaveCount(0);
    const chartBands = await page.evaluate(() => {
      const ohlc = document.querySelector('.ohlc')?.getBoundingClientRect();
      const chart = document.querySelector('.price-chart')?.getBoundingClientRect();
      return ohlc && chart ? { ohlcBottom: ohlc.bottom, chartTop: chart.top } : null;
    });
    expect(chartBands).not.toBeNull();
    expect(chartBands!.ohlcBottom).toBeLessThanOrEqual(chartBands!.chartTop);
    await expect(page.locator('.ohlc')).toHaveCSS('border-bottom-width', '0px');

    await page.getByRole('button', { name: '% Funding Rates', exact: true }).click();
    await expect(page).toHaveURL(/\/funding-rates$/);
    await expect(page.getByRole('heading', { name: 'Funding rate matrix.' })).toBeVisible();
    await expect.poll(loadedScripts).toEqual(expect.arrayContaining([expect.stringContaining('funding-route-')]));

    const results = await new AxeBuilder({ page })
      .exclude('.tv-lightweight-charts')
      .analyze();
    expect(results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }))).toEqual([]);

  });

  test('reviews transfers and exposes dedicated funding-fee plus account-ledger history on the portfolio page', async ({ page }) => {
    await page.route('**/api/trading-mode', async (route) => route.fulfill({ json: { mode: 'live' } }));
    await page.route('**/api/crossex/transfer-coins', async (route) => route.fulfill({ json: {
      items: [
        { coin: 'BTC', minimumAmount: '0.0001', estimatedFee: '0.00001', precision: 8, disabled: false },
        { coin: 'USDC', minimumAmount: '11', estimatedFee: '1', precision: 5, disabled: false },
        { coin: 'USDT', minimumAmount: '1', estimatedFee: '0', precision: 6, disabled: false },
      ],
      fetchedAt: '2030-01-01T00:00:00.000Z',
      cacheStatus: 'fresh',
    } }));
    await page.route('**/api/crossex/transfer-balances', async (route) => route.fulfill({ json: {
      items: [
        { account: 'CROSSEX_DERIBIT', coin: 'USDC', available: '21.03646747' },
        { account: 'SPOT', coin: 'USDC', available: '19.98' },
        { account: 'SPOT', coin: 'USDT', available: '250.125000' },
        { account: 'CROSSEX', coin: 'USDT', available: '1200' },
      ],
      fetchedAt: '2030-01-01T00:00:00.000Z',
    } }));
    await page.route('**/api/crossex/portfolio-activity?**', async (route) => route.fulfill({ json: {
      transfers: [{
        id: 'tx-1', text: 'portfolio_1', from: 'SPOT', to: 'CROSSEX', coin: 'USDT', amount: '250',
        actualReceive: '250', status: 'SUCCESS', failureReason: null,
        createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:01.000Z',
      }],
      accountBook: [{
        id: 'book-1', businessId: 'funding-1', statementType: 'FUNDING_FEE', venue: 'BINANCE',
        coin: 'USDT', symbol: 'BINANCE_FUTURE_BTC_USDT', change: '-0.002', balance: '249.998',
        createdAt: '2030-01-01T00:05:00.000Z',
      }],
      fundingFees: [{
        id: 'book-1', businessId: 'funding-1', statementType: 'FUNDING_FEE', venue: 'BINANCE',
        coin: 'USDT', symbol: 'BINANCE_FUTURE_BTC_USDT', change: '-0.002', balance: '249.998',
        createdAt: '2030-01-01T00:05:00.000Z',
      }],
      fetchedAt: '2030-01-01T00:05:00.000Z',
    } }));
    await page.route('**/api/crossex/transfers', async (route) => route.fulfill({ json: {
      transactionId: 'tx-2', text: 'portfolio_2',
    } }));

    await page.goto('/portfolio');
    const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    await riskDialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
      await riskDialog.getByRole('button', { name: /Enable live trading/ }).click();
    }
    await expect(page.getByRole('heading', { name: 'Transfer funds' })).toBeVisible();
    await expect(page.getByText('portfolio_1', { exact: true })).toBeVisible();
    const transferButton = page.locator('.transfer-submit');
    if ((await transferButton.textContent())?.includes('Enable live mode')) {
      await transferButton.click();
      await riskDialog.waitFor({ state: 'visible', timeout: 500 }).catch(() => undefined);
      if (await riskDialog.isVisible()) {
        const acknowledgement = riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' });
        if (!await acknowledgement.isChecked()) await acknowledgement.check();
        await riskDialog.getByRole('button', { name: /Enable live trading/ }).click();
      }
    }
    await expect(page.getByRole('button', { name: 'Review transfer' })).toBeVisible();
    await page.getByLabel('Asset').selectOption('USDC');
    const documentedUsdcAccounts = [
      'Gate Spot',
      'CrossEx · Binance',
      'CrossEx · OKX',
      'CrossEx · Gate.io',
      'CrossEx · Bybit',
      'CrossEx · Hyperliquid',
      'CrossEx · Deribit',
    ];
    await expect(page.getByLabel('From account').locator('option')).toHaveText(documentedUsdcAccounts);
    await expect(page.getByLabel('To account').locator('option')).toHaveText(documentedUsdcAccounts);
    await page.getByLabel('From account').selectOption('CROSSEX_DERIBIT');
    await page.getByLabel('To account').selectOption('SPOT');
    await expect(page.getByText('Available 21.03647 USDC', { exact: true })).toBeVisible();
    await expect(page.locator('.transfer-specs')).toContainText('11 USDC');
    await expect(page.locator('.transfer-specs')).toContainText('1 USDC');
    await expect(page.locator('.transfer-specs')).toContainText('5');
    await page.getByLabel('Asset').selectOption('USDT');
    await expect(page.getByText('Available 250.125 USDT', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Max amount' }).click();
    await expect(page.getByLabel('Transfer amount')).toHaveValue('250.125');
    await page.getByRole('button', { name: /Funding fees/ }).click();
    await expect(page.getByText('Funding Fee', { exact: true })).toBeVisible();
    await expect(page.getByText('BINANCE_FUTURE_BTC_USDT', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Account ledger/ }).click();
    await expect(page.getByText('Funding Fee', { exact: true })).toBeVisible();
    await expect(page.getByText('BINANCE_FUTURE_BTC_USDT', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Transfers/ }).click();

    await page.getByLabel('Transfer amount').fill('25');
    await page.getByRole('button', { name: 'Review transfer' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm fund transfer' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('25 USDT');
    await expect(dialog).toContainText('Gate Spot');
    await expect(dialog).toContainText('CrossEx');
    const submitted = page.waitForRequest((request) => request.url().endsWith('/api/crossex/transfers') && request.method() === 'POST');
    await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
    expect((await submitted).postDataJSON()).toMatchObject({ coin: 'USDT', amount: '25', from: 'SPOT', to: 'CROSSEX' });
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Transfer submitted · tx-2/)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }))).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(widths.root).toBe(widths.viewport);
    expect(widths.body).toBe(widths.viewport);
  });

  test('places funding search and period controls below the filters', async ({ page }) => {
    await page.goto('/funding-rates');

    const toolbarOrder = await page.locator('.funding-toolbar').evaluate((toolbar) =>
      [...toolbar.children].map((child) => child.className));
    expect(toolbarOrder).toEqual(['funding-search', 'metric-switch', 'funding-last-updated']);
    await expect(page.locator('.funding-context')).toHaveCount(0);
    await expect(page.locator('.funding-countdown')).toHaveCount(0);
    await expect(page.locator('.funding-last-updated')).toContainText('Last updated at');
    const fundingControlOrder = await page.locator('.funding-card').evaluate((card) =>
      [...card.children].slice(0, 3).map((child) => child.className));
    expect(fundingControlOrder).toEqual(['exchange-filter', 'oi-filter', 'funding-toolbar']);
    const toolbarGap = await page.locator('.funding-toolbar').evaluate((toolbar) => {
      const [search, periods] = [...toolbar.children].map((child) => child.getBoundingClientRect());
      return periods.left - search.right;
    });
    expect(toolbarGap).toBeLessThanOrEqual(12);
    const timestampRightOffset = await page.locator('.funding-toolbar').evaluate((toolbar) => {
      const toolbarBounds = toolbar.getBoundingClientRect();
      const timestampBounds = toolbar.lastElementChild?.getBoundingClientRect();
      return timestampBounds ? Math.abs(toolbarBounds.right - 18 - timestampBounds.right) : Number.POSITIVE_INFINITY;
    });
    expect(timestampRightOffset).toBeLessThanOrEqual(1);
  });

  test('preserves the selected funding period after viewing pair details', async ({ page }) => {
    await page.goto('/funding-rates');
    const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    await riskDialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
      await riskDialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
    }

    const thirtyDays = page.getByRole('button', { name: 'Cumulative 30d', exact: true });
    await thirtyDays.click();
    await expect(thirtyDays).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.funding-clickable-row').first().click();
    await expect(page).toHaveURL(/\/funding-rates\/[A-Z0-9]+$/);
    await page.getByRole('button', { name: 'Back to funding rates' }).click();

    await expect(page).toHaveURL(/\/funding-rates$/);
    await expect(page.getByRole('button', { name: 'Cumulative 30d', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('opens a paired position with the funding-arbitrage pair preconfigured', async ({ page }) => {
    await page.goto('/funding-rates');
    const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    await riskDialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
      await riskDialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
    }

    await expect(page.getByRole('button', { name: '$5M', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('textbox', { name: 'Min average OI' })).toHaveValue('5');
    const arbHeaderCenterOffset = await page.locator('.arb-sort').evaluate((header) => {
      const headerBounds = header.getBoundingClientRect();
      const labelBounds = header.firstElementChild?.getBoundingClientRect();
      return labelBounds ? Math.abs((headerBounds.left + headerBounds.width / 2) - (labelBounds.left + labelBounds.width / 2)) : Number.POSITIVE_INFINITY;
    });
    expect(arbHeaderCenterOffset).toBeLessThanOrEqual(1);
    await page.getByRole('textbox', { name: 'Search asset' }).fill('HYPE');

    const openStrategy = page.getByRole('button', { name: 'Open hedge strategy: HYPE, Long Bybit, Short Hyperliquid' });
    await expect(openStrategy).toBeVisible();
    await openStrategy.click();

    await expect(page).toHaveURL(/\/strategies\/paired-position$/);
    await expect(page.getByRole('combobox', { name: 'Search asset' })).toHaveAttribute('placeholder', 'HYPEUSDC ↔ HYPEUSDT');
    await expect(page.getByRole('combobox', { name: 'Exchange A' })).toHaveValue('hyperliquid');
    await expect(page.getByRole('combobox', { name: 'Exchange B' })).toHaveValue('bybit');
    await expect(page.getByLabel('Per-order quantity')).toHaveValue('');
    await expect(page.getByLabel('Per-order quantity')).toHaveAttribute('placeholder', 'e.g. 0.10');
    await expect(page.getByLabel('Total amount')).toHaveValue('');
    await expect(page.getByLabel('Total amount')).toHaveAttribute('placeholder', 'e.g. 1.00');
    await expect(page.getByLabel('Entry threshold')).toHaveValue('0');
    await expect(page.locator('.strategy-leg').first().locator('.leg-top em')).toHaveText('Sell HYPEUSDC');
    await expect(page.locator('.strategy-leg').last().locator('.leg-top em')).toHaveText('Buy HYPEUSDT');
    await expect(page.locator('.strategy-leg').first()).toContainText('36.55');
    await expect(page.locator('.strategy-leg').first()).toContainText('+0.0200%');
    await expect(page.locator('.strategy-leg').last()).toContainText('36.5');
    await expect(page.locator('.strategy-leg').last()).toContainText('-0.0100%');
    await expect(page.getByRole('button', { name: 'Exchange A leverage: 1×' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exchange B leverage: 1×' })).toBeVisible();
    await expect(page.locator('.strategy-history-tabs > button')).toHaveText([
      'Positions (0)',
      'Running (0)',
      'Historical (0)',
    ]);
    await expect(page.getByText('View chart data', { exact: true })).toHaveCount(0);
    await expect(page.getByText('View latest funding data', { exact: true })).toHaveCount(0);
    const fundingHistoryPanel = page.locator('.strategy-funding-history');
    const fundingDuration = fundingHistoryPanel.getByRole('group', { name: 'Duration' });
    await expect(fundingDuration.getByRole('button')).toHaveText(['24H', '7D', '30D']);
    await expect(fundingDuration.getByRole('button', { name: '30D' })).toHaveAttribute('aria-pressed', 'true');
    const oneDayHistory = page.waitForRequest((request) => request.url().endsWith('/api/markets/funding-history/series')
      && request.method() === 'POST' && request.postDataJSON().durationDays === 1);
    await fundingDuration.getByRole('button', { name: '24H' }).click();
    await oneDayHistory;
    await expect(fundingDuration.getByRole('button', { name: '24H' })).toHaveAttribute('aria-pressed', 'true');
    await expect(fundingHistoryPanel.getByRole('heading', { name: /Cumulative funding/ })).toContainText('24H');
    const pnlLegend = page.locator('.funding-detail-legend > span').filter({ hasText: 'Cumulative funding PnL' });
    await expect(pnlLegend).toBeVisible();
    await expect(pnlLegend.locator('i')).toHaveCSS('background-color', 'rgb(24, 214, 173)');
    await expect.poll(() => page.evaluate(async () => {
      const response = await fetch('/api/markets');
      const snapshot = await response.json() as { markets: Array<{ asset: string; venue: string }> };
      return snapshot.markets.filter((market) => market.asset === 'HYPE').map((market) => market.venue);
    })).toEqual(expect.arrayContaining(['HYPERLIQUID', 'BYBIT']));
  });

  test('fits a narrow viewport and matches the mobile baseline', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /BTCUSDT/ })).toBeVisible();
    await expect(page.locator('.ohlc')).not.toContainText('—');

    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(widths.root).toBe(widths.viewport);
    expect(widths.body).toBe(widths.viewport);

    const snapshotName = process.platform === 'linux' ? 'trade-mobile-linux.png' : 'trade-mobile.png';
    await expect(page).toHaveScreenshot(snapshotName, {
      mask: [
        page.locator('.market-stats > div:last-child dd'),
        page.locator('.statusbar'),
      ],
      maskColor: '#0b1118',
    });
  });
});
