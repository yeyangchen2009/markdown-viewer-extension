import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
const ORIGINAL = '# Original\n\nBody text.\n\n';
const DRAFT = '# Draft heading\n\nUnsaved **draft**.\n\n';
const EXTERNAL = '# Disk heading\n\nExternal version.\n';

describe('installed Chrome extension — Markdown source editor', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let fixtureDir = '';
  let fileUrl = '';

  before(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-source-editor-'));
    const filename = path.join(fixtureDir, 'doc.md');
    fs.writeFileSync(filename, ORIGINAL, 'utf8');
    fileUrl = pathToFileURL(filename).href;

    harness = await launchExtensionContext('mv-source-editor-');
    page = await harness.context.newPage();
    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS, preferredLocale: 'en' });
    await bootstrap.close();

    await page.goto(fileUrl, { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);
    await evalJs(page, `() => { document.getElementById('toggle-edit-btn').click(); return true; }`);
    await waitFor(page, `() => document.documentElement.dataset.sourceEditor === '1'`);
  });

  after(async () => {
    await harness?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function sendExternalContent(content: string): Promise<void> {
    const worker = harness.context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
    assert.ok(worker, 'extension service worker is available');
    await worker.evaluate(async ({ url, text }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url === url);
      if (!tab?.id) throw new Error('fixture tab not found');
      await chrome.tabs.sendMessage(tab.id, {
        type: 'FILE_CHANGED',
        payload: { url, content: text },
      });
    }, { url: fileUrl, text: content });
  }

  it('keeps exact source bytes and updates the preview without replacing the editor', async () => {
    const initial = await evalJs<string>(page, `() => document.getElementById('mv-source-editor-input').value`);
    assert.equal(initial, ORIGINAL, 'including both trailing newlines');

    await evalJs(page, `(content) => {
      const input = document.getElementById('mv-source-editor-input');
      input.value = content;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(4, 4);
      return true;
    }`, DRAFT);
    await waitFor(page, `() => document.querySelector('#markdown-content h1')?.textContent === 'Draft heading'`);
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'true'`);

    const state = await evalJs<{ value: string; caret: number; split: boolean }>(page, `() => {
      const input = document.getElementById('mv-source-editor-input');
      return {
        value: input.value,
        caret: input.selectionStart,
        split: getComputedStyle(document.getElementById('viewer-main-column')).gridTemplateColumns.split(' ').length === 2,
      };
    }`);
    assert.equal(state.value, DRAFT);
    assert.equal(state.caret, 4, 'preview render preserves the caret');
    assert.equal(state.split, true, 'editor and preview are both visible on desktop');
  });

  it('preserves a dirty draft on external changes and loads disk only on confirmation', async () => {
    await sendExternalContent(EXTERNAL);
    await waitFor(page, `() => !document.getElementById('mv-source-editor-conflict').hidden`);
    assert.equal(
      await evalJs<string>(page, `() => document.getElementById('mv-source-editor-input').value`),
      DRAFT,
      'external content never silently replaces the draft',
    );

    await evalJs(page, `() => {
      Array.from(document.querySelectorAll('#mv-source-editor-conflict button'))
        .find((button) => button.textContent === 'Keep my draft').click();
      return true;
    }`);
    assert.equal(await evalJs<boolean>(page, `() => document.getElementById('mv-source-editor-conflict').hidden`), true);

    await sendExternalContent(EXTERNAL);
    await waitFor(page, `() => !document.getElementById('mv-source-editor-conflict').hidden`);
    page.once('dialog', (dialog) => dialog.accept());
    await evalJs(page, `() => {
      Array.from(document.querySelectorAll('#mv-source-editor-conflict button'))
        .find((button) => button.textContent === 'Load disk version').click();
      return true;
    }`);
    await waitFor(page, `() => document.getElementById('mv-source-editor-input').value === ${JSON.stringify(EXTERNAL)}`);
    await waitFor(page, `() => document.querySelector('#markdown-content h1')?.textContent === 'Disk heading'`);
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'false'`);
  });
});
