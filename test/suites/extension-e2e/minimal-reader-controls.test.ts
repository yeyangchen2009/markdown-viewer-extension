import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { type Page } from 'playwright-core';

import {
  VIEWER_UNVEILED_JS,
  WAIT_STANDALONE_READY_JS,
  evalJs,
  installPageDiagnostics,
  launchExtensionContext,
  waitFor,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';
const LAYOUT_DIR = path.resolve('test/fixtures/layout');
const SCREENSHOT_DIR = process.env.MV_E2E_SCREENSHOT_DIR?.trim();

const STATE_JS = `() => {
  const header = document.getElementById('page-header');
  const toc = document.getElementById('table-of-contents');
  const trigger = document.getElementById('toggle-toc-btn');
  const zoom = document.getElementById('zoom-level');
  const download = document.getElementById('download-btn');
  const triggerRect = trigger.getBoundingClientRect();
  const visibleBox = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  return {
    controlsOpen: document.body.classList.contains('reader-controls-open'),
    headerDisplay: getComputedStyle(header).display,
    tocHidden: toc.classList.contains('hidden'),
    tocDisplay: getComputedStyle(toc).display,
    tocLeft: toc.getBoundingClientRect().left,
    tocRight: toc.getBoundingClientRect().right,
    tocLinks: toc.querySelectorAll('a').length,
    triggerDisplay: getComputedStyle(trigger).display,
    triggerPosition: getComputedStyle(trigger).position,
    triggerRight: innerWidth - triggerRect.right,
    triggerBottom: innerHeight - triggerRect.bottom,
    triggerExpanded: trigger.getAttribute('aria-expanded'),
    triggerOutsideHeader: !header.contains(trigger),
    zoomVisible: visibleBox(zoom),
    downloadVisible: visibleBox(download),
    contentTop: document.getElementById('page-content').getBoundingClientRect().top,
  };
}`;

describe('minimal reader controls', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness | undefined;
  let page: Page;
  let pageErrors: string[] = [];

  before(async () => {
    harness = await launchExtensionContext('mv-minimal-controls-');
    page = await harness.context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    installPageDiagnostics(page, 'minimal-controls');
  });

  after(async () => {
    await harness?.close();
  });

  async function openFixture(name: string): Promise<void> {
    await page.goto('file://' + path.join(LAYOUT_DIR, name), { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);
  }

  async function screenshot(name: string): Promise<void> {
    if (!SCREENSHOT_DIR) return;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
  }

  it('keeps only the floating trigger until TOC and toolbar are requested', async () => {
    await openFixture('headings.md');
    await waitFor(page, `() => document.querySelectorAll('#table-of-contents a').length >= 6`);

    const initial = await evalJs<any>(page, STATE_JS);
    assert.equal(initial.controlsOpen, false);
    assert.equal(initial.headerDisplay, 'none');
    assert.equal(initial.tocHidden, true);
    assert.equal(initial.zoomVisible, false);
    assert.equal(initial.downloadVisible, false);
    assert.equal(initial.contentTop, 0);
    assert.equal(initial.triggerDisplay, 'flex');
    assert.equal(initial.triggerPosition, 'fixed');
    assert.equal(initial.triggerOutsideHeader, true);
    assert.equal(initial.triggerExpanded, 'false');
    assert.ok(initial.triggerRight >= 15 && initial.triggerRight <= 25);
    assert.ok(initial.triggerBottom >= 15 && initial.triggerBottom <= 25);
    await waitFor(page, `() => document.getElementById('table-of-contents').getBoundingClientRect().right <= 0`);
    await screenshot('minimal-closed');

    await evalJs(page, `() => { window.__minimalControlsMarker = 'still-alive'; return true; }`);
    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => document.body.classList.contains('reader-controls-open')
      && getComputedStyle(document.getElementById('page-header')).display === 'flex'
      && !document.getElementById('table-of-contents').classList.contains('hidden')`);

    const opened = await evalJs<any>(page, STATE_JS);
    assert.equal(opened.triggerExpanded, 'true');
    assert.equal(opened.zoomVisible, true);
    assert.equal(opened.downloadVisible, true);
    assert.equal(opened.contentTop, 50);
    assert.ok(opened.tocLinks >= 6);
    await screenshot('minimal-open');

    await page.locator('#table-of-contents a', { hasText: 'Heading Two' }).click();
    await waitFor(page, `() => location.hash === '#heading-two'`);
    assert.equal(
      await evalJs(page, `() => window.__minimalControlsMarker`),
      'still-alive',
      'TOC navigation must not reload the reader',
    );

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => !document.body.classList.contains('reader-controls-open')
      && getComputedStyle(document.getElementById('page-header')).display === 'none'
      && document.getElementById('table-of-contents').classList.contains('hidden')`);
    const closed = await evalJs<any>(page, STATE_JS);
    assert.equal(closed.triggerExpanded, 'false');
    assert.equal(closed.zoomVisible, false);
    assert.equal(closed.downloadVisible, false);
    assert.equal(closed.contentTop, 0);
    assert.equal(await evalJs(page, `() => window.__minimalControlsMarker`), 'still-alive');
    assert.deepEqual(pageErrors, []);
  });

  it('opens the toolbar even when the document has no TOC', async () => {
    await openFixture('no-headings.md');
    await waitFor(page, `() => getComputedStyle(document.getElementById('table-of-contents')).display === 'none'`);

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => getComputedStyle(document.getElementById('page-header')).display === 'flex'`);
    const opened = await evalJs<any>(page, STATE_JS);
    assert.equal(opened.tocDisplay, 'none');
    assert.equal(opened.tocHidden, true);
    assert.equal(opened.zoomVisible, true);
    assert.equal(opened.downloadVisible, true);
    assert.equal(opened.triggerExpanded, 'true');

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => getComputedStyle(document.getElementById('page-header')).display === 'none'`);
    assert.deepEqual(pageErrors, []);
  });
});
