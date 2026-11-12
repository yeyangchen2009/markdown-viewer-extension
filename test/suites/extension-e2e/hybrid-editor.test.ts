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
const ORIGINAL = '# Original\n\nBody text.\n\n- [ ] Task\n';
const DRAFT = '# Draft heading\n\nUnsaved **draft**.\n\n';
const EXTERNAL = '# Disk heading\n\nExternal version.\n';

describe('installed Chromium extension — hybrid Markdown editor', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let fixtureDir = '';
  let fileUrl = '';

  before(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-hybrid-editor-'));
    const filename = path.join(fixtureDir, '混合编辑.md');
    fs.writeFileSync(filename, ORIGINAL, 'utf8');
    fileUrl = pathToFileURL(filename).href;

    harness = await launchExtensionContext('mv-hybrid-editor-');
    page = await harness.context.newPage();
    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS, preferredLocale: 'en' });
    await bootstrap.close();

    await page.addInitScript(`(() => {
      const state = window.__mvHybridSaveTest = { picks: 0, pending: [], writes: [], gates: [] };
      window.__mvReleaseHybridWrite = () => {
        const release = state.gates.shift();
        if (release) release();
      };
      window.showOpenFilePicker = async () => {
        state.picks += 1;
        let pending = '';
        return [{
          name: 'doc.md', kind: 'file',
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          createWritable: async () => ({
            write: async (content) => {
              pending = content;
              state.pending.push(content);
              await new Promise((resolve) => state.gates.push(resolve));
            },
            close: async () => { state.writes.push(pending); },
            abort: async () => undefined,
          }),
        }];
      };
    })()`);

    await page.goto(fileUrl, { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);
    await page.locator('#toggle-edit-btn').click();
    await waitFor(page, `() => document.documentElement.dataset.sourceEditor === 'hybrid'`);
    await waitFor(page, `() => document.querySelectorAll('#mv-hybrid-editor-input .md-block').length > 0`);
  });

  after(async () => {
    await harness?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function showSource(): Promise<void> {
    await page.locator('#mv-editor-source-mode').click();
    await waitFor(page, `() => document.documentElement.dataset.sourceEditor === 'source'`);
  }

  async function showHybrid(): Promise<void> {
    await page.locator('#mv-editor-preview-mode').click();
    await waitFor(page, `() => document.documentElement.dataset.sourceEditor === 'hybrid'`);
  }

  async function readSource(): Promise<string> {
    return evalJs<string>(page, `() => document.getElementById('mv-source-editor-input').value`);
  }

  async function setSource(content: string): Promise<void> {
    await showSource();
    await evalJs(page, `(value) => {
      const input = document.getElementById('mv-source-editor-input');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }`, content);
  }

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

  it('edits a rendered heading with real keyboard input and supports undo/redo', async () => {
    assert.equal(await readSource(), ORIGINAL, 'initial autorun must not erase the source');
    assert.equal(
      await page.locator('#markdown-wrapper').evaluate((element) => getComputedStyle(element).display),
      'none',
      'hybrid mode uses one editor column instead of the legacy preview',
    );

    await page.locator('#mv-hybrid-editor-input .md-heading').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    const edited = ORIGINAL.replace('# Original', '# Original edited');
    await waitFor(page, `() => document.getElementById('mv-source-editor-input').value === ${JSON.stringify(edited)}`);
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'true'`);
    assert.equal(
      await page.locator('#markdown-content h1').textContent(),
      'Original',
      'typing does not repaint the legacy reading DOM',
    );

    for (let index = 0; index < ' edited'.length; index += 1) {
      await page.keyboard.press('Control+z');
    }
    await waitFor(page, `() => document.getElementById('mv-source-editor-input').value === ${JSON.stringify(ORIGINAL)}`);
    for (let index = 0; index < ' edited'.length; index += 1) {
      await page.keyboard.press('Control+y');
    }
    await waitFor(page, `() => document.getElementById('mv-source-editor-input').value === ${JSON.stringify(edited)}`);

    await showSource();
    assert.equal(await readSource(), edited, 'Preview/Source share exact source text');
    const sourcePending = edited.replace('Body text.', 'Source **pending**.');
    await evalJs(page, `(value) => {
      const input = document.getElementById('mv-source-editor-input');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }`, sourcePending);
    await showHybrid();
    assert.equal(await readSource(), sourcePending, 'returning to Preview preserves the edit');
    await page.waitForTimeout(450);
    assert.equal(
      await page.locator('#markdown-content h1').textContent(),
      'Original',
      'a debounced Source render does not follow the user into Preview',
    );
  });

  it('preserves CRLF and trailing newlines across Preview/Source round trips', async () => {
    const content = '# CRLF\r\n\r\nLine one.\r\n\r\n';
    await evalJs(page, `() => {
      const state = window.__mvHybridSaveTest;
      state.pending = [];
      state.writes = [];
      state.gates = [];
      return true;
    }`);
    await sendExternalContent(content);
    await waitFor(page, `() => !document.getElementById('mv-source-editor-conflict').hidden`);
    page.once('dialog', (dialog) => dialog.accept());
    await evalJs(page, `() => {
      Array.from(document.querySelectorAll('#mv-source-editor-conflict button'))
        .find((button) => button.textContent === 'Load disk version').click();
      return true;
    }`);
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'false'`);
    await showHybrid();
    await page.keyboard.press('Control+s');
    await waitFor(page, `() => window.__mvHybridSaveTest.pending.length === 1`);
    assert.equal(
      await evalJs<string>(page, `() => window.__mvHybridSaveTest.pending[0]`),
      content,
      'the hybrid model retains CRLF even though the textarea mirror uses LF',
    );
    await evalJs(page, `() => { window.__mvReleaseHybridWrite(); return true; }`);
    await waitFor(page, `() => document.getElementById('mv-source-editor-status').textContent === 'Saved to file'`);

    await showSource();
    await page.keyboard.press('Control+s');
    await waitFor(page, `() => window.__mvHybridSaveTest.pending.length === 2`);
    assert.equal(
      await evalJs<string>(page, `() => window.__mvHybridSaveTest.pending[1]`),
      content,
      'Source mode also saves its canonical text without a DOM newline round trip',
    );
    await evalJs(page, `() => { window.__mvReleaseHybridWrite(); return true; }`);
    await waitFor(page, `() => document.getElementById('mv-source-editor-status').textContent === 'Saved to file'`);
    await sendExternalContent(ORIGINAL);
    await waitFor(page, `() => document.getElementById('mv-source-editor-input').value === ${JSON.stringify(ORIGINAL)}`);
    await showHybrid();
  });

  it('toggles a rendered task checkbox by editing Markdown source', async () => {
    await setSource('- [ ] Task\n');
    await showHybrid();
    const checkbox = page.locator('#mv-hybrid-editor-input input[type="checkbox"]').first();
    await checkbox.click();
    await waitFor(page, `() => {
      const value = document.getElementById('mv-source-editor-input').value;
      return value === ${JSON.stringify('- [x] Task\n')}
        || value === ${JSON.stringify('- [X] Task\n')};
    }`);
    assert.match(await readSource(), /^- \[[xX]\] Task\n$/);
  });

  it('renders Mermaid blocks in place and reveals the clicked original fence', async () => {
    const content = '# Diagram\n\n'
      + '```mermaid\nflowchart TD\n  A["Start"] --> B["First"]\n```\n\n'
      + 'Between diagrams.\n\n'
      + '```mermaid\nflowchart LR\n  C["Start"] --> D["Second"]\n```\n';
    await setSource(content);
    await showHybrid();
    await waitFor(page, `() => document.querySelectorAll('#mv-hybrid-editor-input .mv-hybrid-diagram img').length === 2`, 30000);

    await page.locator('#mv-hybrid-editor-input .mv-hybrid-diagram').first().click();
    await waitFor(page, `() => document.querySelector(
      '#mv-hybrid-editor-input .md-code-block.md-block-active',
    )?.textContent.includes('First') === true`);
    await page.locator('#mv-hybrid-editor-input .mv-hybrid-diagram').click();
    await waitFor(page, `() => document.querySelector(
      '#mv-hybrid-editor-input .md-code-block.md-block-active',
    )?.textContent.includes('Second') === true`);
    assert.equal(await readSource(), content, 'rendering never round-trips either fence through HTML');
  });

  it('keeps a hybrid draft on external changes and loads disk only on confirmation', async () => {
    await setSource(DRAFT);
    await showHybrid();
    await sendExternalContent(EXTERNAL);
    await waitFor(page, `() => !document.getElementById('mv-source-editor-conflict').hidden`);
    assert.equal(await readSource(), DRAFT);

    await sendExternalContent(EXTERNAL);
    page.once('dialog', (dialog) => dialog.accept());
    await evalJs(page, `() => {
      Array.from(document.querySelectorAll('#mv-source-editor-conflict button'))
        .find((button) => button.textContent === 'Load disk version').click();
      return true;
    }`);
    await waitFor(page, `() => document.getElementById('mv-source-editor-input').value === ${JSON.stringify(EXTERNAL)}`);
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'false'`);
  });

  it('saves a hybrid snapshot while preserving later typing as dirty', async () => {
    await evalJs(page, `() => {
      const state = window.__mvHybridSaveTest;
      state.pending = [];
      state.writes = [];
      state.gates = [];
      return true;
    }`);
    await setSource(DRAFT);
    await showHybrid();
    await waitFor(page, `() => document.documentElement.dataset.mvSourceFileWriter === 'ready'`);
    await page.locator('#save-source-btn').click();
    await waitFor(page, `() => window.__mvHybridSaveTest.pending.length === 1`);

    await page.locator('#mv-hybrid-editor-input .md-heading').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' newer');
    const newerDraft = DRAFT.replace('# Draft heading', '# Draft heading newer');
    await waitFor(page, `() => document.getElementById('mv-source-editor-input').value === ${JSON.stringify(newerDraft)}`);
    await evalJs(page, `() => { window.__mvReleaseHybridWrite(); return true; }`);
    await waitFor(page, `() => document.getElementById('mv-source-editor-status').textContent === 'Earlier draft saved; latest changes unsaved'`);

    await page.locator('#save-source-btn').click();
    await waitFor(page, `() => window.__mvHybridSaveTest.pending.length === 2`);
    await evalJs(page, `() => { window.__mvReleaseHybridWrite(); return true; }`);
    await waitFor(page, `() => document.getElementById('mv-source-editor-status').textContent === 'Saved to file'`);
    const result = await evalJs<{ picks: number; writes: string[] }>(page, `() => ({
      picks: window.__mvHybridSaveTest.picks,
      writes: window.__mvHybridSaveTest.writes,
    })`);
    assert.equal(result.picks, 1);
    assert.deepEqual(result.writes, [DRAFT, newerDraft]);
  });

  it('restores the complete reading preview with the latest hybrid source on exit', async () => {
    await setSource('# Exit preview\n\nLatest **hybrid** text.\n');
    await showHybrid();
    await page.locator('#toggle-edit-btn').click();
    await waitFor(page, `() => !document.documentElement.dataset.sourceEditor`);
    await waitFor(page, `() => document.querySelector('#markdown-content h1')?.textContent === 'Exit preview'`);
    assert.equal(await page.locator('#markdown-content strong').textContent(), 'hybrid');
    await waitFor(page, `() => document.getElementById('markdown-wrapper').checkVisibility()`);
  });
});
