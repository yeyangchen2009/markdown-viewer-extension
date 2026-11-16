import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { type Page } from 'playwright-core';

import {
  VIEWER_UNVEILED_JS,
  WAIT_STANDALONE_READY_JS,
  evalJs,
  launchExtensionContext,
  waitFor,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';
const SCREENSHOT_DIR = process.env.MV_E2E_SCREENSHOT_DIR?.trim();

const STATE_JS = `() => {
  const header = document.getElementById('page-header');
  const toc = document.getElementById('table-of-contents');
  const trigger = document.getElementById('toggle-toc-btn');
  const triggerRect = trigger.getBoundingClientRect();
  return {
    bodyTocHidden: document.body.classList.contains('toc-hidden'),
    headerDisplay: getComputedStyle(header).display,
    tocHidden: toc.classList.contains('hidden'),
    contentTop: document.getElementById('page-content').getBoundingClientRect().top,
    triggerPosition: getComputedStyle(trigger).position,
    triggerRight: innerWidth - triggerRect.right,
    triggerBottom: innerHeight - triggerRect.bottom,
    triggerOutsideHeader: !header.contains(trigger),
  };
}`;

describe('minimal reader controls', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness | undefined;
  let page: Page;
  const pageErrors: string[] = [];

  before(async () => {
    harness = await launchExtensionContext('mv-minimal-controls-');
    page = await harness.context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto('file://' + path.resolve('test/fixtures/layout/headings.md'), { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);
    await waitFor(page, `() => document.querySelectorAll('#table-of-contents a').length >= 6`);
  });

  after(async () => {
    await harness?.close();
  });

  async function screenshot(name: string): Promise<void> {
    if (!SCREENSHOT_DIR) return;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
  }

  it('uses one trigger to hide and show the toolbar with the TOC', async () => {
    const initial = await evalJs<any>(page, STATE_JS);
    assert.equal(initial.bodyTocHidden, true);
    assert.equal(initial.headerDisplay, 'none');
    assert.equal(initial.tocHidden, true);
    assert.equal(initial.contentTop, 0);
    assert.equal(initial.triggerPosition, 'fixed');
    assert.equal(initial.triggerOutsideHeader, true);
    assert.equal(initial.triggerRight, 20);
    assert.equal(initial.triggerBottom, 20);
    await waitFor(page, `() => document.getElementById('table-of-contents').getBoundingClientRect().right <= 0`);
    await screenshot('minimal-closed');

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => !document.body.classList.contains('toc-hidden')
      && getComputedStyle(document.getElementById('page-header')).display === 'flex'
      && !document.getElementById('table-of-contents').classList.contains('hidden')`);
    const opened = await evalJs<any>(page, STATE_JS);
    assert.equal(opened.contentTop, 50);
    await screenshot('minimal-open');

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => document.body.classList.contains('toc-hidden')
      && getComputedStyle(document.getElementById('page-header')).display === 'none'
      && document.getElementById('table-of-contents').classList.contains('hidden')`);
    assert.deepEqual(pageErrors, []);
  });
});
