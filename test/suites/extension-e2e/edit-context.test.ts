import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { type Page } from 'playwright-core';

import {
  FIXED_SETTINGS,
  SET_STORAGE_JS,
  VIEWER_EMBED_READY_JS,
  VIEWER_UNVEILED_JS,
  WAIT_STANDALONE_READY_JS,
  evalJs,
  launchExtensionContext,
  waitFor,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

describe('installed Chrome extension — EditContext capability gate', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  const pageErrors: string[] = [];

  before(async () => {
    harness = await launchExtensionContext('mv-edit-context-');

    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS, preferredLocale: 'en' });
    await bootstrap.close();

    page = await harness.context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
  });

  after(async () => {
    await harness?.close();
  });

  it('keeps reading available without EditContext and Preview editing available with it', async () => {
    const fixtureUrl = pathToFileURL(path.resolve('test/fixtures/layout/headings.md')).href;
    await page.goto(fixtureUrl, { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);

    const hasEditContext = await evalJs<boolean>(
      page,
      `() => typeof window.EditContext === 'function'`,
    );
    assert.equal(await page.locator('#markdown-content h1').nth(1).textContent(), 'Heading One');

    if (hasEditContext) {
      assert.equal(await page.locator('#mv-source-editor').count(), 1);
      await waitFor(page, `() => getComputedStyle(document.getElementById('toggle-edit-btn')).display !== 'none'`);
      await page.locator('#toggle-edit-btn').click();
      await waitFor(page, `() => document.documentElement.dataset.sourceEditor === 'hybrid'
        && Boolean(document.getElementById('mv-hybrid-editor-input'))`);
      await page.locator('#toggle-edit-btn').click();
      await waitFor(page, `() => !document.documentElement.dataset.sourceEditor`);
    } else {
      assert.equal(await page.locator('#mv-source-editor').count(), 0);
      assert.equal(
        await page.locator('#toggle-edit-btn').evaluate((element) => getComputedStyle(element).display),
        'none',
      );
      assert.equal(
        await page.locator('#save-source-btn').evaluate((element) => getComputedStyle(element).display),
        'none',
      );
    }

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => getComputedStyle(document.getElementById('page-header')).display === 'flex'`);
    await page.locator('#toggle-source-view-btn').click();
    await waitFor(page, `() => document.documentElement.dataset.sourceView === '1'
      && document.querySelector('#mv-source-view pre code')?.textContent.includes('# Heading One')`);
    assert.deepEqual(pageErrors, []);
  });
});
