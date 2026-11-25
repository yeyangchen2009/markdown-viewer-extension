import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { type Page } from 'playwright-core';

import {
  FIXED_SETTINGS,
  POST_OPEN_DOCUMENT_JS,
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
const SCREENSHOT_DIR = process.env.MV_E2E_SCREENSHOT_DIR?.trim();

const STATE_JS = `() => {
  const header = document.getElementById('page-header');
  const toc = document.getElementById('table-of-contents');
  const trigger = document.getElementById('toggle-toc-btn');
  const edit = document.getElementById('toggle-edit-btn');
  const controls = document.getElementById('reader-controls');
  const page = document.getElementById('markdown-page');
  const wrapper = document.getElementById('markdown-wrapper');
  const triggerRect = trigger.getBoundingClientRect();
  const editRect = edit.getBoundingClientRect();
  const controlsRect = controls.getBoundingClientRect();
  return {
    readerOpen: document.body.classList.contains('reader-controls-open'),
    bodyTocHidden: document.body.classList.contains('toc-hidden'),
    headerDisplay: getComputedStyle(header).display,
    tocHidden: toc.classList.contains('hidden') || getComputedStyle(toc).display === 'none',
    contentTop: document.getElementById('page-content').getBoundingClientRect().top,
    controlsPosition: getComputedStyle(controls).position,
    controlsDisplay: getComputedStyle(controls).display,
    controlsLeft: controlsRect.left,
    controlsBottom: innerHeight - controlsRect.bottom,
    controlsOutsideHeader: !header.contains(controls),
    triggerExpanded: trigger.getAttribute('aria-expanded'),
    editPressed: edit.getAttribute('aria-pressed'),
    editDisplay: getComputedStyle(edit).display,
    editAboveTrigger: editRect.bottom <= triggerRect.top,
    buttonsAligned: Math.abs(editRect.left - triggerRect.left) < 1,
    inlineMaxWidth: page.style.maxWidth,
    pageWidth: page.getBoundingClientRect().width,
    wrapperWidth: wrapper.getBoundingClientRect().width,
  };
}`;

describe('minimal reader controls', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let hasEditContext = false;
  const pageErrors: string[] = [];
  const headingsUrl = pathToFileURL(path.resolve('test/fixtures/layout/headings.md')).href;

  before(async () => {
    harness = await launchExtensionContext('mv-minimal-controls-');

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
    await openFixture(headingsUrl, true);
    hasEditContext = await evalJs<boolean>(page, `() => typeof window.EditContext === 'function'`);
    if (hasEditContext) {
      await waitFor(page, `() => getComputedStyle(document.getElementById('toggle-edit-btn')).display !== 'none'`);
    }
  });

  after(async () => {
    await harness?.close();
  });

  async function openFixture(url: string, expectToc = false): Promise<void> {
    await page.goto(url, { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);
    if (expectToc) {
      await waitFor(page, `() => document.querySelectorAll('#table-of-contents a').length >= 6`);
    }
  }

  async function screenshot(name: string): Promise<void> {
    if (!SCREENSHOT_DIR) return;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
  }

  it('opens fullscreen with only the left-bottom edit and TOC controls', async () => {
    const initial = await evalJs<any>(page, STATE_JS);
    assert.equal(initial.readerOpen, false);
    assert.equal(initial.bodyTocHidden, true);
    assert.equal(initial.headerDisplay, 'none');
    assert.equal(initial.tocHidden, true);
    assert.equal(initial.contentTop, 0);
    assert.equal(initial.controlsPosition, 'fixed');
    assert.equal(initial.controlsOutsideHeader, true);
    assert.equal(initial.controlsLeft, 20);
    assert.equal(initial.controlsBottom, 20);
    if (hasEditContext) {
      assert.equal(initial.editAboveTrigger, true);
      assert.equal(initial.buttonsAligned, true);
    }
    assert.equal(initial.editDisplay, hasEditContext ? 'flex' : 'none');
    assert.equal(initial.triggerExpanded, 'false');
    assert.equal(initial.inlineMaxWidth, '100%');
    assert.ok(Math.abs(initial.pageWidth - initial.wrapperWidth) < 1);
    await screenshot('minimal-closed');
  });

  it('uses the trigger and Ctrl+B to open and close the header with the TOC', async () => {
    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => document.body.classList.contains('reader-controls-open')
      && getComputedStyle(document.getElementById('page-header')).display === 'flex'
      && !document.getElementById('table-of-contents').classList.contains('hidden')`);
    const opened = await evalJs<any>(page, STATE_JS);
    assert.equal(opened.contentTop, 50);
    assert.equal(opened.triggerExpanded, 'true');
    await screenshot('minimal-open');

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => !document.body.classList.contains('reader-controls-open')
      && document.body.classList.contains('toc-hidden')`);
    await page.keyboard.press('Control+b');
    await waitFor(page, `() => document.body.classList.contains('reader-controls-open')
      && getComputedStyle(document.getElementById('page-header')).display === 'flex'`);
    await page.keyboard.press('Control+b');
    await waitFor(page, `() => !document.body.classList.contains('reader-controls-open')
      && document.body.classList.contains('toc-hidden')`);
  });

  it('enters and exits the existing Preview editor through the floating pen', async (t) => {
    if (!hasEditContext) {
      t.skip('EditContext is unavailable in this browser');
      return;
    }
    await page.locator('#toggle-edit-btn').click();
    await waitFor(page, `() => document.documentElement.dataset.sourceEditor === 'hybrid'
      && document.getElementById('toggle-edit-btn').getAttribute('aria-pressed') === 'true'`);
    assert.equal(
      await page.locator('#markdown-wrapper').evaluate((element) => getComputedStyle(element).display),
      'none',
    );
    assert.equal(await page.locator('#toggle-edit-btn').getAttribute('title'), 'Close Editor');

    await page.locator('#toggle-edit-btn').click();
    await waitFor(page, `() => !document.documentElement.dataset.sourceEditor
      && document.getElementById('toggle-edit-btn').getAttribute('aria-pressed') === 'false'`);
    assert.notEqual(
      await page.locator('#markdown-wrapper').evaluate((element) => getComputedStyle(element).display),
      'none',
    );
  });

  it('opens the header even when a Markdown document has no headings', async () => {
    await openFixture(pathToFileURL(path.resolve('test/fixtures/layout/no-headings.md')).href);
    await waitFor(page, `() => getComputedStyle(document.getElementById('table-of-contents')).display === 'none'`);

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => getComputedStyle(document.getElementById('page-header')).display === 'flex'`);
    const opened = await evalJs<any>(page, STATE_JS);
    assert.equal(opened.readerOpen, true);
    assert.equal(opened.triggerExpanded, 'true');
    assert.equal(opened.tocHidden, true);

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => getComputedStyle(document.getElementById('page-header')).display === 'none'`);
  });

  it('keeps the trigger available for source-only documents while hiding the pen', async () => {
    await openFixture(pathToFileURL(path.resolve('test/fixtures/layout/source.txt')).href);
    await waitFor(page, `() => getComputedStyle(document.getElementById('toggle-edit-btn')).display === 'none'`);

    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => getComputedStyle(document.getElementById('page-header')).display === 'flex'`);
    const opened = await evalJs<any>(page, STATE_JS);
    assert.equal(opened.readerOpen, true);
    assert.equal(opened.editDisplay, 'none');
    assert.equal(opened.tocHidden, true);
  });

  it('restores persisted normal and expanded state without changing other new documents', async () => {
    await openFixture(headingsUrl, true);
    await page.locator('#toggle-toc-btn').click();
    await waitFor(page, `() => getComputedStyle(document.getElementById('page-header')).display === 'flex'`);
    await page.locator('#layout-toggle-btn').click();
    await page.locator('#layout-toggle-btn').click();
    await waitFor(page, `() => document.getElementById('markdown-page').style.maxWidth === '1360px'`);

    const storagePage = await harness.context.newPage();
    await storagePage.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(storagePage, VIEWER_EMBED_READY_JS);
    await waitFor(storagePage, `() => new Promise((resolve) => {
      chrome.storage.local.get('markdownFileStates', (data) => {
        const state = data.markdownFileStates?.[${JSON.stringify(headingsUrl)}];
        resolve(state?.layoutMode === 'normal' && state?.tocVisible === true);
      });
    })`);
    await storagePage.close();

    await openFixture(headingsUrl, true);
    const restored = await evalJs<any>(page, STATE_JS);
    assert.equal(restored.inlineMaxWidth, '1360px');
    assert.equal(restored.headerDisplay, 'flex');
    assert.equal(restored.readerOpen, true);
    assert.equal(restored.tocHidden, false);

    await openFixture(pathToFileURL(path.resolve('test/fixtures/layout/body-text.md')).href);
    const fresh = await evalJs<any>(page, STATE_JS);
    assert.equal(fresh.inlineMaxWidth, '100%');
    assert.equal(fresh.headerDisplay, 'none');
    assert.equal(fresh.readerOpen, false);
  });

  it('stays inside a narrow viewport and disappears for embed and print', async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    const narrow = await evalJs<any>(page, STATE_JS);
    assert.equal(narrow.controlsLeft, 16);
    assert.equal(narrow.controlsBottom, 16);
    assert.ok(narrow.controlsLeft >= 0 && narrow.controlsBottom >= 0);
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.emulateMedia({ media: 'print' });
    assert.equal(
      await page.locator('#reader-controls').evaluate((element) => getComputedStyle(element).display),
      'none',
    );
    await page.emulateMedia({ media: 'screen' });

    const embed = await harness.context.newPage();
    await embed.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(embed, VIEWER_EMBED_READY_JS);
    await evalJs(embed, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT',
      filename: 'embedded.md',
      content: '# Embedded document\n\nEmbedded body.\n',
      fileDir: '',
    });
    await embed.waitForSelector('#reader-controls', { state: 'attached' });
    assert.equal(
      await embed.locator('#reader-controls').evaluate((element) => getComputedStyle(element).display),
      'none',
    );
    await embed.close();
    assert.deepEqual(pageErrors, []);
  });
});
