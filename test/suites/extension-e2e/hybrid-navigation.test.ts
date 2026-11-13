import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

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

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';
const READING_OFFSET_PX = 120;
const KEYBOARD_HEADING = 'Middle keyboard anchor';
const CRLF_HEADING = 'Middle CRLF anchor';
const REPEATED_HEADING = 'Middle repeated anchor';
const ASYNC_HEADING = 'Middle async anchor';
const USER_SCROLL_HEADING = 'User scroll destination';

interface LongDocument {
  content: string;
  targetLine: number;
  userScrollLine: number;
  endLine: number;
}

function makeLongDocument(
  targetHeading: string,
  lineEnding: '\n' | '\r\n' = '\n',
  delayedImageUrl?: string,
): LongDocument {
  const lines = ['# Long hybrid navigation document', ''];
  let targetLine = -1;
  let userScrollLine = -1;

  for (let section = 0; section < 42; section += 1) {
    if (section === 12 && delayedImageUrl) {
      lines.push(`![Delayed intrinsic size](${delayedImageUrl})`, '');
    }
    const heading = section === 24
      ? targetHeading
      : section === 29
        ? USER_SCROLL_HEADING
        : `Section ${String(section).padStart(2, '0')}`;
    if (section === 24) targetLine = lines.length;
    if (section === 29) userScrollLine = lines.length;
    lines.push(`## ${heading}`, '');
    lines.push(
      `Paragraph ${section}a. This is unique readable content for ${heading}. `
      + 'It is deliberately long enough to make a neighbouring block a different scroll destination. '
      + 'The quick brown fox jumps over the lazy dog while the reader continues through the document.',
      '',
    );
    lines.push(
      `Paragraph ${section}b. More prose keeps every section separated in the viewport. `
      + 'A line-ending conversion must not turn this block into the anchor for the preceding heading.',
      '',
    );
  }

  const endLine = lines.length;
  lines.push('Final paragraph: end of the long navigation fixture.');
  assert.ok(targetLine > 0 && userScrollLine > targetLine && endLine > userScrollLine);
  return {
    content: lines.join(lineEnding) + lineEnding,
    targetLine,
    userScrollLine,
    endLine,
  };
}

interface ElementGeometry {
  offset: number;
  bottom: number;
  height: number;
  viewportHeight: number;
  scrollTop: number;
  visible: boolean;
}

const HYBRID_GEOMETRY_JS = `(title) => {
  const host = document.getElementById('mv-hybrid-editor-host');
  const heading = Array.from(document.querySelectorAll('#mv-hybrid-editor-input .md-heading'))
    .find((element) => element.textContent.includes(title));
  if (!host || !heading) return null;
  const hostRect = host.getBoundingClientRect();
  const rect = heading.getBoundingClientRect();
  return {
    offset: rect.top - hostRect.top,
    bottom: rect.bottom - hostRect.top,
    height: rect.height,
    viewportHeight: host.clientHeight,
    scrollTop: host.scrollTop,
    visible: rect.height > 0 && rect.top >= hostRect.top - 2 && rect.bottom <= hostRect.bottom + 2,
  };
}`;

const READING_GEOMETRY_JS = `(line) => {
  const host = document.getElementById('markdown-wrapper');
  const block = document.querySelector('#markdown-content [data-line="' + line + '"]');
  if (!host || !block) return null;
  const hostRect = host.getBoundingClientRect();
  const rect = block.getBoundingClientRect();
  return {
    offset: rect.top - hostRect.top,
    bottom: rect.bottom - hostRect.top,
    height: rect.height,
    viewportHeight: host.clientHeight,
    scrollTop: host.scrollTop,
    visible: rect.height > 0 && rect.top >= hostRect.top - 2 && rect.bottom <= hostRect.bottom + 2,
  };
}`;

const HYBRID_VISIBLE_JS = (title: string): string => `() => {
  const host = document.getElementById('mv-hybrid-editor-host');
  const heading = Array.from(document.querySelectorAll('#mv-hybrid-editor-input .md-heading'))
    .find((element) => element.textContent.includes(${JSON.stringify(title)}));
  if (!host || !heading) return false;
  const hostRect = host.getBoundingClientRect();
  const rect = heading.getBoundingClientRect();
  return host.scrollTop > 0 && rect.height > 0
    && rect.top >= hostRect.top - 2 && rect.bottom <= hostRect.bottom + 2;
}`;

const READING_VISIBLE_JS = (line: number): string => `() => {
  const host = document.getElementById('markdown-wrapper');
  const block = document.querySelector('#markdown-content [data-line="${line}"]');
  if (!host || !block) return false;
  const hostRect = host.getBoundingClientRect();
  const rect = block.getBoundingClientRect();
  return host.scrollTop > 0 && rect.height > 0
    && rect.top >= hostRect.top - 2 && rect.bottom <= hostRect.bottom + 2;
}`;

async function hybridGeometry(page: Page, title: string): Promise<ElementGeometry> {
  const geometry = await evalJs<ElementGeometry | null>(page, HYBRID_GEOMETRY_JS, title);
  assert.ok(geometry, `hybrid heading is mounted: ${title}`);
  return geometry;
}

async function readingGeometry(page: Page, line: number): Promise<ElementGeometry> {
  const geometry = await evalJs<ElementGeometry | null>(page, READING_GEOMETRY_JS, line);
  assert.ok(geometry, `reading block is mounted at data-line=${line}`);
  return geometry;
}

async function scrollReadingBlock(page: Page, line: number): Promise<number> {
  await evalJs(page, `(line) => {
    const host = document.getElementById('markdown-wrapper');
    const block = document.querySelector('#markdown-content [data-line="' + line + '"]');
    const hostRect = host.getBoundingClientRect();
    const rect = block.getBoundingClientRect();
    host.scrollTop = Math.max(0, rect.top - hostRect.top + host.scrollTop - ${READING_OFFSET_PX});
    return host.scrollTop;
  }`, line);
  await waitFor(page, `() => {
    const host = document.getElementById('markdown-wrapper');
    const block = document.querySelector('#markdown-content [data-line="${line}"]');
    if (!host || !block) return false;
    return Math.abs(block.getBoundingClientRect().top - host.getBoundingClientRect().top - ${READING_OFFSET_PX}) <= 2;
  }`);
  const geometry = await readingGeometry(page, line);
  assert.ok(geometry.scrollTop > 1000, 'the fixture is read in the middle, not at the document top');
  return geometry.offset;
}

async function enterHybrid(page: Page, title: string): Promise<void> {
  await page.locator('#toggle-edit-btn').click();
  await waitFor(page, `() => document.documentElement.dataset.sourceEditor === 'hybrid'`);
  await waitFor(page, `() => document.querySelectorAll('#mv-hybrid-editor-input .md-block').length > 0`);
  await waitFor(page, HYBRID_VISIBLE_JS(title));
  await waitForStable(page, HYBRID_VISIBLE_JS(title), 250, 5000);
}

async function exitHybrid(page: Page, line: number): Promise<void> {
  await page.locator('#toggle-edit-btn').click();
  await waitFor(page, `() => !document.documentElement.dataset.sourceEditor`);
  await waitFor(page, READING_VISIBLE_JS(line));
  await waitForStable(page, READING_VISIBLE_JS(line), 250, 5000);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A real decodable image whose intrinsic height creates a large late layout shift. */
function makePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = 40;
      raw[pixel + 1] = 110;
      raw[pixel + 2] = 180;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, 'ascii');
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface DelayedImage {
  url: string;
  requestCount(): number;
  release(): void;
  close(): Promise<void>;
}

async function startDelayedImage(): Promise<DelayedImage> {
  const png = makePng(900, 1400);
  const pending = new Set<http.ServerResponse>();
  let released = false;
  let requests = 0;
  const respond = (response: http.ServerResponse): void => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': png.length,
      'cache-control': 'no-store',
    });
    response.end(png);
  };
  const server = http.createServer((request, response) => {
    if (request.url !== '/slow.png') {
      response.writeHead(404).end('Not found');
      return;
    }
    requests += 1;
    pending.add(response);
    response.on('close', () => pending.delete(response));
    if (released) respond(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const release = (): void => {
    if (released) return;
    released = true;
    for (const response of pending) respond(response);
  };
  return {
    url: `http://127.0.0.1:${address.port}/slow.png`,
    requestCount: () => requests,
    release,
    close: async () => {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForNodeCondition(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('installed Chromium extension — hybrid reading continuity', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let fixtureDir = '';

  before(async () => {
    harness = await launchExtensionContext('mv-hybrid-navigation-');
    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS, preferredLocale: 'en' });
    await bootstrap.close();
  });

  after(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-hybrid-navigation-doc-'));
    page = await harness.context.newPage();
  });

  afterEach(async () => {
    await page?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function openDocument(document: LongDocument): Promise<void> {
    const filename = path.join(fixtureDir, 'long-navigation.md');
    fs.writeFileSync(filename, document.content, 'utf8');
    await page.goto(pathToFileURL(filename).href, { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, VIEWER_UNVEILED_JS);
    await waitFor(page, `() => Boolean(document.querySelector(
      '#markdown-content [data-line="${document.endLine}"]',
    ))`);
  }

  it('keeps the middle heading visible through a real keyboard edit and exit', async () => {
    const document = makeLongDocument(KEYBOARD_HEADING);
    await openDocument(document);
    await scrollReadingBlock(page, document.targetLine);
    await enterHybrid(page, KEYBOARD_HEADING);

    const entered = await hybridGeometry(page, KEYBOARD_HEADING);
    assert.ok(entered.visible, 'the corresponding heading is fully inside the hybrid viewport');
    assert.ok(entered.scrollTop > 1000, 'entering hybrid did not jump back to the document top');

    const heading = page.locator('#mv-hybrid-editor-input .md-heading')
      .filter({ hasText: KEYBOARD_HEADING });
    await heading.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await waitFor(page, `() => Array.from(document.querySelectorAll(
      '#mv-hybrid-editor-input .md-heading',
    )).some((element) => element.textContent.includes(
      ${JSON.stringify(`${KEYBOARD_HEADING} edited`)},
    ))`);

    await exitHybrid(page, document.targetLine);
    await waitFor(page, `() => document.querySelector(
      '#markdown-content [data-line="${document.targetLine}"]',
    )?.textContent.includes(${JSON.stringify(`${KEYBOARD_HEADING} edited`)}) === true`);
    await waitForStable(page, READING_VISIBLE_JS(document.targetLine), 300, 5000);
    const exited = await readingGeometry(page, document.targetLine);
    assert.ok(exited.visible, 'the edited reading block remains visible after leaving hybrid');
  });

  it('applies normal, fullscreen and narrow widths in the toolbar cycle', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const document = makeLongDocument('Middle layout anchor');
    await openDocument(document);
    await scrollReadingBlock(page, document.targetLine);
    await enterHybrid(page, 'Middle layout anchor');

    const widthJs = `() => {
      const content = document.querySelector('#mv-hybrid-editor-input .md-editor-content');
      if (!content) return null;
      return { maxWidth: getComputedStyle(content).maxWidth, width: content.getBoundingClientRect().width };
    }`;
    const normal = await evalJs<{ maxWidth: string; width: number }>(page, widthJs);
    assert.equal(normal.maxWidth, '1360px');

    await page.locator('#layout-toggle-btn').click();
    await waitForStable(page, `() => {
      const content = document.querySelector('#mv-hybrid-editor-input .md-editor-content');
      return content && content.getBoundingClientRect().width > ${normal.width + 80};
    }`, 200, 5000);
    const fullscreen = await evalJs<{ maxWidth: string; width: number }>(page, widthJs);
    assert.ok(fullscreen.width > 900, `fullscreen content is genuinely wide: ${fullscreen.width}px`);
    assert.ok(
      fullscreen.maxWidth === 'none'
        || fullscreen.maxWidth === '100%'
        || fullscreen.width > normal.width + 80,
      `normal -> fullscreen removes the normal cap, got ${fullscreen.maxWidth}`,
    );

    await page.locator('#layout-toggle-btn').click();
    await waitFor(page, `() => getComputedStyle(document.querySelector(
      '#mv-hybrid-editor-input .md-editor-content',
    )).maxWidth === '680px'`);
    const narrow = await evalJs<{ maxWidth: string; width: number }>(page, widthJs);
    assert.equal(narrow.maxWidth, '680px');

    await page.locator('#layout-toggle-btn').click();
    await waitFor(page, `() => getComputedStyle(document.querySelector(
      '#mv-hybrid-editor-input .md-editor-content',
    )).maxWidth === '1360px'`);
    const backToNormal = await evalJs<{ maxWidth: string; width: number }>(page, widthJs);
    assert.equal(backToNormal.maxWidth, '1360px', 'the cycle is normal -> fullscreen -> narrow -> normal');
  });

  it('maps a CRLF middle heading to its own block rather than an adjacent paragraph', async () => {
    const document = makeLongDocument(CRLF_HEADING, '\r\n');
    await openDocument(document);
    await scrollReadingBlock(page, document.targetLine);
    await enterHybrid(page, CRLF_HEADING);

    const entered = await hybridGeometry(page, CRLF_HEADING);
    assert.ok(entered.visible, 'CRLF navigation lands on the requested heading');
    assert.ok(
      entered.offset >= -2 && entered.offset <= READING_OFFSET_PX + 96,
      `CRLF did not shift the anchor to a neighbouring block: offset ${entered.offset}`,
    );
    await exitHybrid(page, document.targetLine);
    const exited = await readingGeometry(page, document.targetLine);
    assert.ok(exited.visible, 'CRLF reading position also survives the return trip');
  });

  it('does not accumulate scroll drift over repeated enter/exit cycles', async () => {
    const document = makeLongDocument(REPEATED_HEADING);
    await openDocument(document);
    await scrollReadingBlock(page, document.targetLine);
    let settledOffset: number | undefined;

    for (let cycle = 1; cycle <= 4; cycle += 1) {
      await enterHybrid(page, REPEATED_HEADING);
      const entered = await hybridGeometry(page, REPEATED_HEADING);
      assert.ok(entered.visible, `cycle ${cycle}: target stays visible on entry`);
      assert.ok(entered.scrollTop > 1000, `cycle ${cycle}: entry never resets to the top`);

      await exitHybrid(page, document.targetLine);
      const exited = await readingGeometry(page, document.targetLine);
      assert.ok(exited.visible, `cycle ${cycle}: target stays visible on exit`);
      if (settledOffset === undefined) {
        settledOffset = exited.offset;
      } else {
        assert.ok(
          Math.abs(exited.offset - settledOffset) <= 4,
          `cycle ${cycle}: reading offset ${exited.offset} drifted from the first round trip's ${settledOffset}`,
        );
      }
    }
  });

  it('finishes at the same middle anchor after a delayed image expands above it', async () => {
    const image = await startDelayedImage();
    try {
      const document = makeLongDocument(ASYNC_HEADING, '\n', image.url);
      await openDocument(document);
      await scrollReadingBlock(page, document.targetLine);
      await waitForNodeCondition(() => image.requestCount() > 0, 'the delayed reading image request');
      await enterHybrid(page, ASYNC_HEADING);
      await waitFor(page, `() => {
        const image = document.querySelector('#mv-hybrid-editor-input img');
        return image && !image.complete && image.naturalWidth === 0;
      }`);

      image.release();
      await waitFor(page, `() => {
        const image = document.querySelector('#mv-hybrid-editor-input img');
        return image && image.complete && image.naturalWidth === 900;
      }`);
      await waitForStable(page, HYBRID_VISIBLE_JS(ASYNC_HEADING), 350, 10000);
      const settled = await hybridGeometry(page, ASYNC_HEADING);
      assert.ok(settled.visible, 'late intrinsic image size does not lose the hybrid anchor');
      assert.ok(settled.scrollTop > 1000, 'async correction does not reset the document to its top');

      await exitHybrid(page, document.targetLine);
      assert.ok((await readingGeometry(page, document.targetLine)).visible);
    } finally {
      await image.close();
    }
  });

  it('does not let an older image correction pull back a deliberate user scroll', async () => {
    const image = await startDelayedImage();
    try {
      const document = makeLongDocument(ASYNC_HEADING, '\n', image.url);
      await openDocument(document);
      await scrollReadingBlock(page, document.targetLine);
      await waitForNodeCondition(() => image.requestCount() > 0, 'the delayed reading image request');
      await enterHybrid(page, ASYNC_HEADING);
      await waitFor(page, `() => Boolean(document.querySelector('#mv-hybrid-editor-input img'))`);

      const destinationBeforeWheel = await hybridGeometry(page, USER_SCROLL_HEADING);
      const wheelDelta = Math.round(destinationBeforeWheel.offset - READING_OFFSET_PX);
      assert.ok(wheelDelta > 400, 'the user destination is a genuinely different part of the document');
      const host = await page.locator('#mv-hybrid-editor-host').boundingBox();
      assert.ok(host);
      await page.mouse.move(host.x + host.width / 2, host.y + Math.min(host.height / 2, 300));
      await page.mouse.wheel(0, wheelDelta);
      await waitForStable(page, HYBRID_VISIBLE_JS(USER_SCROLL_HEADING), 250, 5000);
      const userPosition = await hybridGeometry(page, USER_SCROLL_HEADING);
      assert.ok(userPosition.visible, 'the real wheel gesture reaches the later heading');

      image.release();
      await waitFor(page, `() => {
        const image = document.querySelector('#mv-hybrid-editor-input img');
        return image && image.complete && image.naturalWidth === 900;
      }`);
      // A negative assertion needs a bounded observation window: allow image
      // decode, ResizeObserver and any already queued correction frames to run.
      await page.waitForTimeout(700);
      const afterImage = await hybridGeometry(page, USER_SCROLL_HEADING);
      assert.ok(afterImage.visible, 'the stale correction did not restore the old heading');
      assert.ok(
        Math.abs(afterImage.offset - userPosition.offset) <= 160,
        `the user destination moved from ${userPosition.offset} to ${afterImage.offset} after the old correction window`,
      );
    } finally {
      await image.close();
    }
  });
});
