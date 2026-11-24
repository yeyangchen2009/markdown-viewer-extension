import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { startLoopbackFileWatch } from '../../../chrome/src/webview/ui/loopback-file-watch.ts';

// The watch module touches only globals that exist in every browser:
// XMLHttpRequest, TextDecoder/TextEncoder, setInterval and document.hidden.
// Each is installed per test; the cadence is driven by node:test mock timers
// (never by wall-clock sleeps), and XHR replies land as microtasks, exactly
// like the production callbacks.

type WatchReply =
  | { kind: 'ok'; status: number; etag?: string | null; text?: string }
  | { kind: 'error' }
  | { kind: 'pending' };

interface RecordedCall {
  url: string;
  ifNoneMatch: string | null;
}

class FakeWatchXHR {
  static calls: RecordedCall[] = [];
  static replies: WatchReply[] = [];
  static instances: FakeWatchXHR[] = [];
  static aborts = 0;

  static reset(): void {
    FakeWatchXHR.calls = [];
    FakeWatchXHR.replies = [];
    FakeWatchXHR.instances = [];
    FakeWatchXHR.aborts = 0;
  }

  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseType = '';
  status = 0;
  response: ArrayBuffer | null = null;
  private etag: string | null = null;
  private aborted = false;
  private reply: WatchReply = { kind: 'ok', status: 304 };

  open(_method: string, _url: string): void {}

  setRequestHeader(_key: string, _value: string): void {}

  getResponseHeader(key: string): string | null {
    return key.toLowerCase() === 'etag' ? this.etag : null;
  }

  send(): void {
    const url = (this as unknown as { url?: string }).url ?? '';
    FakeWatchXHR.calls.push({
      url,
      ifNoneMatch: (this as unknown as { ifNoneMatch?: string | null }).ifNoneMatch ?? null,
    });
    FakeWatchXHR.instances.push(this);
    this.reply = FakeWatchXHR.replies.length
      ? FakeWatchXHR.replies.shift() as WatchReply
      : { kind: 'ok', status: 304 };
    if (this.reply.kind === 'pending') return;
    queueMicrotask(() => this.dispatch());
  }

  /** Fire the queued reply now (also used to settle a 'pending' request). */
  dispatch(reply?: WatchReply): void {
    if (this.aborted) return;
    const active = reply ?? this.reply;
    if (active.kind === 'pending') return;
    if (active.kind === 'error') {
      this.onerror?.();
      return;
    }
    this.status = active.status;
    this.etag = active.etag ?? null;
    this.response = active.text !== undefined
      ? new TextEncoder().encode(active.text).buffer as ArrayBuffer
      : null;
    this.onload?.();
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    FakeWatchXHR.aborts += 1;
    this.onabort?.();
  }
}

// Capture the URL/If-None-Match through the real open()/setRequestHeader()
// surface rather than ad-hoc fields, so the assertions exercise the module's
// actual header usage.
const originalOpen = FakeWatchXHR.prototype.open;
FakeWatchXHR.prototype.open = function open(method: string, url: string): void {
  (this as unknown as { url: string }).url = url;
  originalOpen.call(this, method, url);
};
const originalSetHeader = FakeWatchXHR.prototype.setRequestHeader;
FakeWatchXHR.prototype.setRequestHeader = function setRequestHeader(key: string, value: string): void {
  if (key.toLowerCase() === 'if-none-match') {
    (this as unknown as { ifNoneMatch: string | null }).ifNoneMatch = value;
  }
  originalSetHeader.call(this, key, value);
};

const URL_A = 'http://127.0.0.1:4317/__documd/tok/a.md';
const URL_B = 'http://127.0.0.1:4317/__documd/tok/b.md';

/** Flush XHR microtasks without touching the mocked interval timers. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface WatchFixture {
  currentUrl: string;
  changes: string[];
  start: (overrides?: { isRelevant?: (url: string) => boolean }) => ReturnType<typeof startLoopbackFileWatch>;
}

function makeFixture(): WatchFixture {
  const globals = globalThis as Record<string, unknown>;
  const savedXHR = globals.XMLHttpRequest;
  const savedDocument = globals.document;
  const savedWarn = console.warn;
  const warnings: unknown[][] = [];
  globals.XMLHttpRequest = FakeWatchXHR;
  console.warn = (...args: unknown[]) => { warnings.push(args); };

  const fixture: WatchFixture = {
    currentUrl: URL_A,
    changes: [],
    start(overrides = {}) {
      return startLoopbackFileWatch({
        getUrl: () => fixture.currentUrl,
        intervalMs: 1000,
        onChange: (content) => { fixture.changes.push(content); },
        isRelevant: overrides.isRelevant ?? (() => true),
      });
    },
  };
  (fixture as unknown as { warnings: unknown[][] }).warnings = warnings;

  // Restore via the test's own teardown: makeFixture is called inside it().
  (globalThis as Record<string, unknown>).__mvWatchTeardown = () => {
    if (savedXHR === undefined) delete globals.XMLHttpRequest;
    else globals.XMLHttpRequest = savedXHR;
    if (savedDocument === undefined) delete globals.document;
    else globals.document = savedDocument;
    console.warn = savedWarn;
    FakeWatchXHR.reset();
  };
  return fixture;
}

function teardown(): void {
  const globals = globalThis as Record<string, unknown>;
  const fn = globals.__mvWatchTeardown as (() => void) | undefined;
  fn?.();
  delete globals.__mvWatchTeardown;
}

describe('loopback-file-watch', () => {
  it('issues an immediate unconditional baseline GET without firing onChange', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    FakeWatchXHR.replies = [{ kind: 'ok', status: 200, etag: '"a1"', text: 'alpha' }];

    const controller = fixture.start();
    assert.equal(FakeWatchXHR.calls.length, 1, 'baseline GET is issued at start, not on the first tick');
    assert.equal(FakeWatchXHR.calls[0].ifNoneMatch, null, 'baseline GET is unconditional');
    await flush();
    assert.deepEqual(fixture.changes, [], 'the baseline is not an external edit');
    assert.equal(controller.getETag(), '"a1"');
    controller.stop();
  });

  it('polls on the configured cadence with If-None-Match and stays silent on 304', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    FakeWatchXHR.replies = [{ kind: 'ok', status: 200, etag: '"a1"', text: 'alpha' }];
    const controller = fixture.start();
    await flush();

    t.mock.timers.tick(999);
    await flush();
    assert.equal(FakeWatchXHR.calls.length, 1, 'no request before the interval elapses');

    t.mock.timers.tick(1);
    await flush();
    assert.equal(FakeWatchXHR.calls.length, 2);
    assert.equal(FakeWatchXHR.calls[1].ifNoneMatch, '"a1"');
    assert.deepEqual(fixture.changes, [], '304 is silent');
    assert.equal(controller.getETag(), '"a1"');
    controller.stop();
  });

  it('fires onChange only for 200 responses whose text differs from the baseline', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    FakeWatchXHR.replies = [
      { kind: 'ok', status: 200, etag: '"a1"', text: 'alpha' },
      { kind: 'ok', status: 200, etag: '"a2"', text: 'beta' },
      { kind: 'ok', status: 200, etag: '"a3"', text: 'beta' },
    ];
    const controller = fixture.start();
    await flush();

    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(fixture.changes, ['beta'], 'changed text is handed over verbatim');
    assert.equal(controller.getETag(), '"a2"');

    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(fixture.changes, ['beta'], 'a 200 with identical text stays silent');
    assert.equal(controller.getETag(), '"a3"', 'the ETag still tracks the latest response');
    controller.stop();
  });

  it('skips ticks while the document is hidden and resumes afterwards', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    const controller = fixture.start();
    await flush();
    const baselineCalls = FakeWatchXHR.calls.length;

    (globalThis as Record<string, unknown>).document = { hidden: true };
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(FakeWatchXHR.calls.length, baselineCalls, 'hidden tabs generate no traffic');

    (globalThis as Record<string, unknown>).document = { hidden: false };
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(FakeWatchXHR.calls.length, baselineCalls + 1);
    controller.stop();
  });

  it('never overlaps requests: a tick with one in flight is a no-op', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    FakeWatchXHR.replies = [{ kind: 'pending' }];
    const controller = fixture.start();
    assert.equal(FakeWatchXHR.calls.length, 1);

    t.mock.timers.tick(1000);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(FakeWatchXHR.calls.length, 1, 'ticks are skipped while the baseline request is in flight');

    FakeWatchXHR.instances[0].dispatch({ kind: 'ok', status: 200, etag: '"a1"', text: 'alpha' });
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(FakeWatchXHR.calls.length, 2, 'polling resumes after the in-flight request settles');
    controller.stop();
  });

  it('re-baselines immediately when the watched URL changes', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    FakeWatchXHR.replies = [{ kind: 'ok', status: 200, etag: '"a1"', text: 'alpha' }];
    const controller = fixture.start();
    await flush();

    fixture.currentUrl = URL_B;
    FakeWatchXHR.replies = [{ kind: 'ok', status: 200, etag: '"b1"', text: 'bravo' }];
    t.mock.timers.tick(1000);
    await flush();
    const last = FakeWatchXHR.calls.at(-1);
    assert.equal(last?.url, URL_B, 'the next poll targets the new document');
    assert.equal(last?.ifNoneMatch, null, 'a navigation resets the validator');
    assert.deepEqual(fixture.changes, [], 'the new document baseline is not an external edit');
    assert.equal(controller.getETag(), '"b1"');
    controller.stop();
  });

  it('stays dormant while the URL is not relevant', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    const controller = fixture.start({ isRelevant: () => false });
    await flush();
    const baselineCalls = FakeWatchXHR.calls.length;

    t.mock.timers.tick(5000);
    await flush();
    assert.equal(FakeWatchXHR.calls.length, baselineCalls);
    controller.stop();
  });

  it('warns once per outage, keeps polling and recovers silently', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    FakeWatchXHR.replies = [{ kind: 'ok', status: 200, etag: '"a1"', text: 'alpha' }];
    const controller = fixture.start();
    await flush();
    const warnings = (fixture as unknown as { warnings: unknown[][] }).warnings;

    FakeWatchXHR.replies = [{ kind: 'error' }, { kind: 'error' }];
    t.mock.timers.tick(1000);
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(warnings.length, 1, 'one warning per outage, not one per tick');

    FakeWatchXHR.replies = [{ kind: 'ok', status: 200, etag: '"a2"', text: 'recovered' }];
    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(fixture.changes, ['recovered'], 'the first successful poll after recovery delivers content');
    assert.equal(controller.getETag(), '"a2"');
    controller.stop();
  });

  it('stop is idempotent, aborts in flight and ends all traffic', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    FakeWatchXHR.replies = [{ kind: 'pending' }];
    const controller = fixture.start();
    assert.equal(FakeWatchXHR.calls.length, 1);

    controller.stop();
    controller.stop();
    assert.equal(FakeWatchXHR.aborts, 1, 'the in-flight request is aborted exactly once');
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(FakeWatchXHR.calls.length, 1, 'no requests after stop');
    assert.deepEqual(fixture.changes, []);
  });

  it('noteSavedState re-pins both the validator and the baseline after our own PUT', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = makeFixture();
    t.after(teardown);
    FakeWatchXHR.replies = [{ kind: 'ok', status: 200, etag: '"a1"', text: 'alpha' }];
    const controller = fixture.start();
    await flush();

    controller.noteSavedState('"saved"', 'saved draft');
    assert.equal(controller.getETag(), '"saved"');

    FakeWatchXHR.replies = [{ kind: 'ok', status: 200, etag: '"saved"', text: 'saved draft' }];
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(FakeWatchXHR.calls.at(-1)?.ifNoneMatch, '"saved"');
    assert.deepEqual(fixture.changes, [], 'our own saved revision is not reported as external');
    controller.stop();
  });
});
