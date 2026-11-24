/**
 * Loopback HTTP write-back + external-change watch E2E (phases 2 and 3).
 *
 * Drives the real production seam end to end: the test process runs the
 * production createServeServer() factory from scripts/documd.js (the same
 * code path the `documd serve` CLI uses) over a temp directory, and the built
 * extension takes over its text/plain .md URL exactly as it does for a
 * user-opened documd document.
 *
 * The server half of the contract (204/ETag, tmp+rename, 412/413/415…) is
 * covered directly in browser-contracts/cli-serve.test.ts; the assertions
 * here stay on the extension side: byte-faithful PUT, clean hot-swap with
 * scroll preservation, dirty-draft conflict handling, saved-ETag echo
 * suppression and retargeting the poll after in-place navigation.
 *
 * Needs `npm run build:chrome` + Playwright Chromium. Skip with
 * MV_SKIP_EXT_TESTS=1.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  waitForStable,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';
import { createServeServer } from '../../../scripts/documd.js';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

const ORIGINAL = '# Loopback note\n\nOriginal body line.\n';
// Same shape as the source-editor fixtures (heading, blank line, paragraph,
// trailing newline) plus non-ASCII content so the TextEncoder UTF-8 path is
// exercised through a real keyboard edit rather than a string assignment.
const DRAFT = '# Loopback note\n\nEdited body with 中文 and emoji 🎉\n';
const LONG_BODY = Array.from(
  { length: 80 },
  (_, index) => `Paragraph ${index}: stable external content for scroll preservation.`,
).join('\n\n');
const LONG_A = `# External A\n\n${LONG_BODY}\n`;
const LONG_B = LONG_A.replace('# External A', '# External B');
const LOCAL_DRAFT = '# Local draft\n\nUnsaved **local** draft.\n\n[Open second](second.md)\n';
const DISK_EXTERNAL = '# Disk version\n\nChanged outside the browser.\n';
const SECOND_ORIGINAL = '# Second original\n\nSecond document body.\n';
const SECOND_CHANGED = '# Second changed\n\nPolled after in-place navigation.\n';

type ServeServer = Awaited<ReturnType<typeof createServeServer>>;

describe('installed Chrome extension — loopback PUT write-back', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let server: ServeServer;
  let rootDir = '';
  let notesPath = '';
  let secondPath = '';
  let documentUrl = '';
  let secondUrl = '';
  let downloadStarted = false;

  before(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-loopback-save-'));
    notesPath = path.join(rootDir, 'notes.md');
    secondPath = path.join(rootDir, 'second.md');
    fs.writeFileSync(notesPath, ORIGINAL, 'utf8');
    fs.writeFileSync(secondPath, SECOND_ORIGINAL, 'utf8');

    // The production server on an ephemeral port so the suite never collides
    // with a manually run demo on the default 4317.
    server = await createServeServer(rootDir, { port: 0, maxBodyMb: 1 });
    documentUrl = server.urlFor('notes.md');
    secondUrl = server.urlFor('second.md');

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

    const putRequest = page.waitForRequest((request) => (
      request.url() === documentUrl && request.method() === 'PUT'
    ));
    await page.keyboard.press('Control+s');

    await waitFor(
      page,
      `() => document.getElementById('mv-source-editor-status').textContent === 'Saved to file'`,
    );
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'false'`);
    const expectedOriginalETag = `"${createHash('sha256').update(ORIGINAL, 'utf8').digest('hex')}"`;
    assert.equal((await putRequest).headers()['if-match'], expectedOriginalETag,
      'a normal save is guarded by the watcher baseline ETag');

    // Disk truth: the production server committed our exact UTF-8 bytes via
    // its same-directory tmp+rename sequence.
    const onDisk = fs.readFileSync(notesPath);
    assert.deepEqual(onDisk, Buffer.from(DRAFT, 'utf8'), 'disk content matches the edited bytes verbatim');
    assert.equal(downloadStarted, false, 'a loopback write-back must never trigger a download');
  });

  it('hot-swaps a clean document after an external write and preserves its scroll position', async () => {
    // Scroll preservation is a reading-view concern. Reload into a clean
    // reader so this check does not depend on the previous editing session's
    // teardown; the external write still uses the normal updateContent path.
    await page.reload({ waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);
    await waitFor(page, `() => document.querySelector('#markdown-content h1')?.textContent === 'Loopback note'`);

    fs.writeFileSync(notesPath, LONG_A, 'utf8');
    await waitFor(page, `() => document.querySelector('#markdown-content h1')?.textContent === 'External A'`);
    await waitFor(page, `() => document.querySelectorAll('#markdown-content p').length === 80`);

    // updateContent schedules a bounded series of source-line restore retries.
    // Do not mistake the first painted paragraphs for the end of that work:
    // keep the user scroll only once it survives ten consecutive frames.
    await waitFor(page, `() => new Promise((resolve) => {
      const wrapper = document.getElementById('markdown-wrapper');
      if (!wrapper || wrapper.scrollHeight <= wrapper.clientHeight + 1) {
        resolve(false);
        return;
      }
      wrapper.scrollTop = 1200;
      let stableFrames = 0;
      const verify = () => {
        if (wrapper.scrollTop < 1000) { resolve(false); return; }
        stableFrames += 1;
        if (stableFrames === 10) { resolve(true); return; }
        requestAnimationFrame(verify);
      };
      requestAnimationFrame(verify);
    })`, 10000);
    const scrollBefore = await evalJs<number>(
      page,
      `() => document.getElementById('markdown-wrapper').scrollTop`,
    );
    assert.ok(scrollBefore >= 1000, `the long document is scrollable (got ${scrollBefore})`);

    fs.writeFileSync(notesPath, LONG_B, 'utf8');
    await waitFor(page, `() => document.querySelector('#markdown-content h1')?.textContent === 'External B'`);
    await waitFor(page, `() => document.querySelectorAll('#markdown-content p').length === 80`);
    await waitForStable(page, `() => Math.abs(
      document.getElementById('markdown-wrapper').scrollTop - ${scrollBefore}
    ) <= 100`, 250, 5000);

    const scrollAfter = await evalJs<number>(
      page,
      `() => document.getElementById('markdown-wrapper').scrollTop`,
    );
    assert.ok(Math.abs(scrollAfter - scrollBefore) <= 100,
      `scroll survives the external refresh (before=${scrollBefore}, after=${scrollAfter})`);
    assert.equal(await evalJs<boolean>(page, `() => document.getElementById('mv-source-editor-conflict').hidden`), true);
  });

  it('keeps a dirty draft on an external write, then overwrites only after confirmation', async () => {
    await evalJs(page, `() => { document.getElementById('toggle-edit-btn').click(); return true; }`);
    await waitFor(page, `() => document.documentElement.dataset.sourceEditor === 'hybrid'`);
    await page.locator('#mv-hybrid-editor-input .md-block').first().click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(LOCAL_DRAFT);
    await waitFor(page, `() => document.querySelector(
      '#mv-hybrid-editor-input .md-heading',
    )?.textContent.includes('Local draft') === true`);
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'true'`);

    fs.writeFileSync(notesPath, DISK_EXTERNAL, 'utf8');
    await waitFor(page, `() => !document.getElementById('mv-source-editor-conflict').hidden`);
    assert.match(
      await page.locator('#mv-hybrid-editor-input .md-heading').first().textContent(),
      /Local draft/,
      'the external revision never silently replaces the dirty draft',
    );

    await evalJs(page, `() => {
      Array.from(document.querySelectorAll('#mv-source-editor-conflict button'))
        .find((button) => button.textContent === 'Keep my draft').click();
      return true;
    }`);
    assert.equal(await evalJs<boolean>(page, `() => document.getElementById('mv-source-editor-conflict').hidden`), true);

    // This PUT is the confirmed-overwrite path, so it deliberately omits
    // If-Match. The response's fresh ETag must become the next poll validator;
    // waiting for that exact 304 proves the echo was consumed without a timer.
    const savedETag = `"${createHash('sha256').update(LOCAL_DRAFT, 'utf8').digest('hex')}"`;
    const echoResponse = page.waitForResponse((response) => (
      response.url() === documentUrl
      && response.request().method() === 'GET'
      && response.request().headers()['if-none-match'] === savedETag
    ));
    page.once('dialog', (dialog) => dialog.accept());
    const overwriteRequest = page.waitForRequest((request) => (
      request.url() === documentUrl && request.method() === 'PUT'
    ));
    await page.keyboard.press('Control+s');
    await waitFor(page, `() => document.getElementById('mv-source-editor-status').textContent === 'Saved to file'`);
    await waitFor(page, `() => document.getElementById('save-source-btn').dataset.dirty === 'false'`);
    assert.equal((await overwriteRequest).headers()['if-match'], undefined,
      'the confirmed overwrite deliberately omits If-Match');
    assert.equal((await echoResponse).status(), 304, 'the saved ETag is the next poll baseline');

    assert.deepEqual(fs.readFileSync(notesPath), Buffer.from(LOCAL_DRAFT, 'utf8'));
    assert.equal(await evalJs<boolean>(page, `() => document.getElementById('mv-source-editor-conflict').hidden`), true,
      'our own PUT echo does not resurrect the conflict banner');
    assert.equal(downloadStarted, false);
  });

  it('moves the polling target across an in-place Markdown navigation', async () => {
    await evalJs(page, `() => { document.getElementById('toggle-edit-btn').click(); return true; }`);
    await waitFor(page, `() => !document.documentElement.dataset.sourceEditor`);
    await waitFor(page, `() => document.querySelector('#markdown-content h1')?.textContent === 'Local draft'`);
    await evalJs(page, `() => { window.__mvLoopbackNavigationSentinel = true; return true; }`);

    await page.locator('#markdown-content a').filter({ hasText: 'Open second' }).click();
    await waitFor(page, `() => document.querySelector('#markdown-content h1')?.textContent === 'Second original'`);
    assert.equal(page.url(), documentUrl, 'in-place navigation deliberately keeps the address-bar URL');
    assert.equal(await evalJs<boolean>(page, `() => window.__mvLoopbackNavigationSentinel === true`), true,
      'the link used the in-place navigation path, not a full reload');

    const secondPoll = page.waitForResponse((response) => (
      response.url() === secondUrl
      && response.request().method() === 'GET'
      && Boolean(response.request().headers()['if-none-match'])
      && response.status() === 200
    ));
    fs.writeFileSync(secondPath, SECOND_CHANGED, 'utf8');
    await secondPoll;
    await waitFor(page, `() => document.querySelector('#markdown-content h1')?.textContent === 'Second changed'`);
    assert.deepEqual(fs.readFileSync(secondPath), Buffer.from(SECOND_CHANGED, 'utf8'));
    assert.equal(downloadStarted, false);
  });
});
