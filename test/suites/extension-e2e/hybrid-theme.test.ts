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
const CONTENT = '# Theme canvas\n\n'
  + 'An active paragraph keeps readable text.\n\n'
  + 'Inline `code` keeps the reading code surface.\n\n'
  + '```text\nconst answer = 42;\n```\n';

interface ThemeSnapshot {
  page: string;
  text: string;
  code: string;
  active: string;
  hostPage: string;
  rootPage: string;
  paragraphColor: string;
  activeBackground: string;
  activeShadow: string;
  inlineCodeBackground: string;
  codeBlockBackground: string;
  cursorBackground: string;
}

function contrast(foreground: string, background: string): number {
  const luminance = (color: string): number => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    assert.ok(channels?.length === 3, `not an RGB color: ${color}`);
    const [red, green, blue] = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('installed Chromium extension — hybrid editor themes', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let fixtureDir = '';
  let fileUrl = '';

  before(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-hybrid-theme-'));
    const filename = path.join(fixtureDir, 'theme.md');
    fs.writeFileSync(filename, CONTENT, 'utf8');
    fileUrl = pathToFileURL(filename).href;

    harness = await launchExtensionContext('mv-hybrid-theme-');
    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS, preferredLocale: 'en' });
    await bootstrap.close();

    page = await harness.context.newPage();
    await page.goto(fileUrl, { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);
    await page.locator('#toggle-edit-btn').click();
    await waitFor(page, `() => document.documentElement.dataset.sourceEditor === 'hybrid'`);
    await waitFor(page, `() => document.querySelectorAll('#mv-hybrid-editor-input .md-block').length >= 4`);
  });

  after(async () => {
    await harness?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function setTheme(themeId: string): Promise<void> {
    const worker = harness.context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
    assert.ok(worker, 'extension service worker is available');
    await worker.evaluate(async ({ url, value }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url === url);
      if (!tab?.id) throw new Error('fixture tab not found');
      await chrome.tabs.sendMessage(tab.id, {
        type: 'SETTING_CHANGED',
        payload: { key: 'themeId', value },
      });
    }, { url: fileUrl, value: themeId });
    const dark = themeId === 'midnight';
    await waitFor(page, `() => document.documentElement.classList.contains('dark') === ${dark}
      && document.getElementById('theme-dynamic-style')?.textContent.includes('--md-code-bg') === true`);
  }

  async function snapshot(): Promise<ThemeSnapshot> {
    return evalJs<ThemeSnapshot>(page, `() => {
      const resolve = (name) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(' + name + ')';
        probe.style.display = 'none';
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      const editor = document.getElementById('mv-hybrid-editor-input');
      const host = document.getElementById('mv-hybrid-editor-host');
      const active = editor.querySelector('.md-paragraph.md-block-active');
      const inlineCode = editor.querySelector('.md-paragraph:not(.md-block-active) code');
      const codeBlock = editor.querySelector('.md-code-block');
      const cursor = editor.querySelector('.md-cursor');
      return {
        page: resolve('--md-page-bg'),
        text: resolve('--md-text-color'),
        code: resolve('--md-code-bg'),
        active: resolve('--md-accent-bg'),
        hostPage: getComputedStyle(host).backgroundColor,
        rootPage: getComputedStyle(editor).backgroundColor,
        paragraphColor: getComputedStyle(active).color,
        activeBackground: getComputedStyle(active).backgroundColor,
        activeShadow: getComputedStyle(active).boxShadow,
        inlineCodeBackground: getComputedStyle(inlineCode).backgroundColor,
        codeBlockBackground: getComputedStyle(codeBlock).backgroundColor,
        cursorBackground: cursor ? getComputedStyle(cursor).backgroundColor : '',
      };
    }`);
  }

  it('inherits reading colors through default, midnight and back without losing the draft', async () => {
    const heading = page.locator('#mv-hybrid-editor-input .md-heading').first();
    await heading.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' themed');
    await waitFor(page, `() => document.querySelector(
      '#mv-hybrid-editor-input .md-heading',
    )?.textContent.includes('Theme canvas themed') === true`);
    await page.locator('#mv-hybrid-editor-input .md-paragraph').first().click();
    await waitFor(page, `() => Boolean(document.querySelector(
      '#mv-hybrid-editor-input .md-paragraph.md-block-active',
    ))`);
    await evalJs(page, `() => {
      window.__mvThemeEditorNode = document.getElementById('mv-hybrid-editor-input');
      return true;
    }`);

    const snapshots: ThemeSnapshot[] = [];
    for (const themeId of ['default', 'midnight', 'default']) {
      await setTheme(themeId);
      const current = await snapshot();
      snapshots.push(current);
      assert.equal(current.hostPage, current.page, `${themeId}: host inherits the reading page`);
      assert.equal(current.rootPage, current.page, `${themeId}: editor inherits the reading page`);
      assert.equal(current.paragraphColor, current.text, `${themeId}: body text inherits the theme`);
      assert.equal(current.activeBackground, current.active, `${themeId}: active block uses the theme accent surface`);
      assert.ok(
        current.activeShadow.includes(current.activeBackground),
        `${themeId}: active block shadow does not retain the light default`,
      );
      assert.equal(current.inlineCodeBackground, current.code, `${themeId}: inline code uses the reading code surface`);
      assert.equal(current.codeBlockBackground, current.code, `${themeId}: fenced code uses the reading code surface`);
      assert.equal(current.cursorBackground, current.text, `${themeId}: the painted cursor follows the text color`);
      assert.ok(contrast(current.paragraphColor, current.rootPage) >= 4.5, `${themeId}: text/page contrast`);
      assert.ok(contrast(current.paragraphColor, current.activeBackground) >= 4.5, `${themeId}: text/active contrast`);
      assert.equal(
        await evalJs<boolean>(page, `() => window.__mvThemeEditorNode === document.getElementById('mv-hybrid-editor-input')`),
        true,
        `${themeId}: theme changes do not replace the editor`,
      );
      assert.match(await heading.textContent(), /Theme canvas themed/, `${themeId}: draft survives`);
      assert.equal(await page.locator('#save-source-btn').getAttribute('data-dirty'), 'true');
    }

    assert.notEqual(snapshots[0].hostPage, snapshots[1].hostPage, 'midnight genuinely changes the editor background');
    assert.deepEqual(snapshots[2], snapshots[0], 'returning to default restores the original editor colors');
  });
});
