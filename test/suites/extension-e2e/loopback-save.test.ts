/**
 * Loopback HTTP write-back E2E (phase 2 of the documd serve plan).
 *
 * Drives the real production seam end to end: the test process runs the
 * production createServeServer() factory from scripts/documd.js (the same
 * code path the `documd serve` CLI uses) over a temp directory, the built
 * extension takes over its text/plain .md URL exactly as it does for a
 * user-opened documd document, and a real keyboard edit plus Ctrl+S must
 * reach the disk through the isolated-world XHR PUT — no picker, no MAIN
 * world bridge, no download.
 *
 * The server half of the contract (204/ETag, tmp+rename, 412/413/415…) is
 * covered directly in browser-contracts/cli-serve.test.ts; the assertions
 * here stay on the extension side: branch selection, a byte-faithful UTF-8
 * round trip, the save status line and dirty-state clearing.
 *
 * Needs `npm run build:chrome` + Playwright Chromium. Skip with
 * MV_SKIP_EXT_TESTS=1.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { createServeServer } from '../../../scripts/documd.js';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

const ORIGINAL = '# Loopback note\n\nOriginal body line.\n';
// Same shape as the source-editor fixtures (heading, blank line, paragraph,
// trailing newline) plus non-ASCII content so the TextEncoder UTF-8 path is
// exercised through a real keyboard edit rather than a string assignment.
const DRAFT = '# Loopback note\n\nEdited body with 中文 and emoji 🎉\n';

type ServeServer = Awaited<ReturnType<typeof createServeServer>>;

describe('installed Chrome extension — loopback PUT write-back', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let server: ServeServer;
  let rootDir = '';
  let notesPath = '';
  let documentUrl = '';
  let downloadStarted = false;

  before(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-loopback-save-'));
    notesPath = path.join(rootDir, 'notes.md');
    fs.writeFileSync(notesPath, ORIGINAL, 'utf8');

    // The production server on an ephemeral port so the suite never collides
    // with a manually run demo on the default 4317.
    server = await createServeServer(rootDir, { port: 0, maxBodyMb: 1 });
    documentUrl = server.urlFor('notes.md');

    harness = await launchExtensionContext('mv-loopback-save-');
    page = await harness.context.newPage();
    // Sentinels: a write-back must never degrade into a browser download.
    page.on('download', () => {
      downloadStarted = true;
    });

    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS, preferredLocale: 'en' });
    await bootstrap.close();

    await page.goto(documentUrl, { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);
    await evalJs(page, `() => { document.getElementById('toggle-edit-btn').click(); return true; }`);
    await waitFor(page, `() => document.documentElement.dataset.sourceEditor === 'hybrid'`);
  });

  after(async () => {
    await harness?.close();
    await server?.close();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('PUTs the edited bytes straight to the loopback origin and clears the dirty state', async () => {
    // The MAIN-world writer marks this page ready as well. Waiting for it
    // proves the isolated PUT branch wins even when the bridge is available:
    // branch ordering is locked in source-file-writer.ts, and no picker can
    // succeed in a headless profile anyway.
    await waitFor(page, `() => document.documentElement.dataset.mvSourceFileWriter === 'ready'`);

    await page.locator('#mv-hybrid-editor-input .md-block').first().click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(DRAFT);
    await waitFor(
      page,
      `() => document.getElementById('mv-hybrid-editor-input')?.textContent.includes('Edited body with 中文 and emoji') === true`,
    );
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'true'`);

    await page.keyboard.press('Control+s');

    await waitFor(
      page,
      `() => document.getElementById('mv-source-editor-status').textContent === 'Saved to file'`,
    );
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'false'`);

    // Disk truth: the production server committed our exact UTF-8 bytes via
    // its same-directory tmp+rename sequence.
    const onDisk = fs.readFileSync(notesPath);
    assert.deepEqual(onDisk, Buffer.from(DRAFT, 'utf8'), 'disk content matches the edited bytes verbatim');
    assert.equal(downloadStarted, false, 'a loopback write-back must never trigger a download');
  });
});
