import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { saveSourceFile } from '../../../chrome/src/webview/ui/source-file-writer.ts';
import { LoopbackWriteError } from '../../../chrome/src/webview/ui/loopback-write.ts';

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window }).window;
  } else {
    globalThis.window = originalWindow;
  }
});

function mockHandle(name: string, writes: string[]): FileSystemFileHandle {
  let pending = '';
  return {
    name,
    kind: 'file',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => ({
      write: async (content: string) => { pending = content; },
      close: async () => { writes.push(pending); },
    }),
  } as unknown as FileSystemFileHandle;
}

describe('source-file-writer', () => {
  it('writes exact source through the authorized local handle and reuses it', async () => {
    const writes: string[] = [];
    const handle = mockHandle('doc.md', writes);
    let picks = 0;
    (globalThis as { window?: unknown }).window = {
      showOpenFilePicker: async () => { picks += 1; return [handle]; },
    };

    const first = await saveSourceFile({
      filename: 'doc.md', mimeType: 'text/markdown', content: '# Draft\n\n', writeBack: true, handle: null,
    });
    const second = await saveSourceFile({
      filename: 'doc.md', mimeType: 'text/markdown', content: '# Newer\n', writeBack: true, handle: first.handle,
    });

    assert.equal(first.status, 'written');
    assert.equal(second.status, 'written');
    assert.equal(picks, 1, 'only the first save needs a picker');
    assert.deepEqual(writes, ['# Draft\n\n', '# Newer\n'], 'write() receives unnormalised text');
  });

  it('uses Save As for a remote document', async () => {
    const writes: string[] = [];
    const handle = mockHandle('copy.md', writes);
    let suggestedName = '';
    (globalThis as { window?: unknown }).window = {
      showSaveFilePicker: async (options: { suggestedName: string }) => {
        suggestedName = options.suggestedName;
        return handle;
      },
    };

    const result = await saveSourceFile({
      filename: 'remote.md', mimeType: 'text/markdown', content: 'remote draft\n', writeBack: false, handle: null,
    });

    assert.equal(result.status, 'written');
    assert.equal(suggestedName, 'remote.md');
    assert.deepEqual(writes, ['remote draft\n']);
  });

  it('aborts instead of committing a partial file when writing fails', async () => {
    let aborted = false;
    let closed = false;
    const handle = {
      name: 'doc.md', kind: 'file',
      queryPermission: async () => 'granted',
      createWritable: async () => ({
        write: async () => { throw new Error('disk full'); },
        close: async () => { closed = true; },
        abort: async () => { aborted = true; },
      }),
    } as unknown as FileSystemFileHandle;
    (globalThis as { window?: unknown }).window = {
      showOpenFilePicker: async () => [handle],
    };

    await assert.rejects(saveSourceFile({
      filename: 'doc.md', mimeType: 'text/markdown', content: 'draft', writeBack: true, handle,
    }), /disk full/);
    assert.equal(aborted, true);
    assert.equal(closed, false, 'a failed write must not close and commit the temporary file');
  });

  it('does not silently turn a local picker security failure into a download', async () => {
    (globalThis as { window?: unknown }).window = {
      showOpenFilePicker: async () => { throw new DOMException('blocked', 'SecurityError'); },
    };
    await assert.rejects(saveSourceFile({
      filename: 'doc.md', mimeType: 'text/markdown', content: 'draft', writeBack: true, handle: null,
    }), /SecurityError|blocked/);
  });

  it('keeps edits unsaved when the picker is cancelled', async () => {
    (globalThis as { window?: unknown }).window = {
      showOpenFilePicker: async () => { throw new DOMException('cancelled', 'AbortError'); },
    };
    const result = await saveSourceFile({
      filename: 'doc.md', mimeType: 'text/markdown', content: 'draft', writeBack: true, handle: null,
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.handle, null);
  });
});

// ---------------------------------------------------------------------------
// Loopback PUT branch. Node has no global XMLHttpRequest/chrome/document, so
// every browser surface is installed explicitly per case and restored after.
// ---------------------------------------------------------------------------

interface RecordedXhr {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  timeoutMs: number;
}

type XhrBehavior = {
  mode: 'load' | 'error' | 'timeout';
  status?: number;
  statusText?: string;
  etag?: string | null;
};

class FakeXHR {
  static calls: RecordedXhr[] = [];
  static behavior: XhrBehavior = { mode: 'load', status: 204 };

  static reset(behavior?: XhrBehavior): void {
    FakeXHR.calls = [];
    FakeXHR.behavior = behavior ?? { mode: 'load', status: 204 };
  }

  method = '';
  url = '';
  private timeoutMs = 0;
  private headers: Record<string, string> = {};
  private body: Uint8Array | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  set timeout(value: number) { this.timeoutMs = value; }
  get timeout(): number { return this.timeoutMs; }
  get status(): number { return FakeXHR.behavior.status ?? 0; }
  get statusText(): string { return FakeXHR.behavior.statusText ?? ''; }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string): void {
    this.headers[key] = value;
  }
  getResponseHeader(key: string): string | null {
    return key.toLowerCase() === 'etag' ? (FakeXHR.behavior.etag ?? null) : null;
  }
  send(body: Uint8Array): void {
    this.body = body ?? null;
    FakeXHR.calls.push({
      method: this.method,
      url: this.url,
      headers: { ...this.headers },
      body: this.body,
      timeoutMs: this.timeoutMs,
    });
    const behavior = FakeXHR.behavior;
    queueMicrotask(() => {
      if (behavior.mode === 'error') this.onerror?.();
      else if (behavior.mode === 'timeout') this.ontimeout?.();
      else this.onload?.();
    });
  }
}

const LOOPBACK_URL = 'http://127.0.0.1:4317/__documd/tok/notes.md';

type SaveRequestInput = Parameters<typeof saveSourceFile>[0];

function loopbackRequest(overrides: Partial<SaveRequestInput> = {}): SaveRequestInput {
  return {
    filename: 'notes.md',
    mimeType: 'text/markdown',
    content: '# 标题\n\r\n第二行\n',
    writeBack: true,
    handle: null,
    documentUrl: LOOPBACK_URL,
    ...overrides,
  };
}

describe('source-file-writer loopback PUT branch', () => {
  const globals = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  let mainBridgeCount = 0;

  function install(
    chromeValue: unknown = { runtime: { id: 'test-extension' } },
    options: { mainWriterReady?: boolean } = {},
  ): void {
    for (const key of ['chrome', 'XMLHttpRequest', 'document', 'window']) {
      saved[key] = globals[key];
    }
    mainBridgeCount = 0;
    globals.chrome = chromeValue;
    globals.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    // The MAIN-world marker is "ready" on every injected page, including a
    // loopback one: dispatching the save event means the branch order regressed.
    // Picker-fallback cases disable it so they reach the picker instead of
    // waiting on the MAIN bridge's never-emitted response.
    const dataset = options.mainWriterReady === false ? {} : { mvSourceFileWriter: 'ready' };
    globals.document = {
      documentElement: { dataset },
      addEventListener(): void {},
      removeEventListener(): void {},
      dispatchEvent(): boolean { mainBridgeCount += 1; return true; },
    } as unknown as Document;
    globals.window = {};
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });

  it('PUTs bytes to the loopback origin without a picker or MAIN bridge', async () => {
    FakeXHR.reset({ mode: 'load', status: 204, etag: '"new-etag"' });
    install();
    const request = loopbackRequest();

    const result = await saveSourceFile(request);

    assert.equal(result.status, 'written');
    assert.equal(result.handle, null);
    assert.equal(FakeXHR.calls.length, 1);
    const call = FakeXHR.calls[0];
    assert.equal(call.method, 'PUT');
    assert.equal(call.url, new URL(LOOPBACK_URL).href);
    assert.equal(call.headers['Content-Type'], 'text/plain;charset=UTF-8');
    assert.equal(call.headers['If-Match'], undefined);
    // UTF-8 bytes preserve CRLF and the trailing newline byte-for-byte.
    assert.deepEqual(call.body, new TextEncoder().encode(request.content));
    assert.equal(mainBridgeCount, 0, 'the loopback branch must run before the MAIN-world bridge');
  });

  it('sends If-Match when an expected ETag is supplied', async () => {
    FakeXHR.reset();
    install();
    await saveSourceFile(loopbackRequest({ expectedETag: '"revision-1"' }));

    assert.equal(FakeXHR.calls[0].headers['If-Match'], '"revision-1"');
  });

  it('rejects with the server status on 412 and never reaches a download', async () => {
    FakeXHR.reset({ mode: 'load', status: 412, statusText: 'Precondition Failed' });
    install();

    await assert.rejects(
      saveSourceFile(loopbackRequest()),
      (error: unknown) => error instanceof LoopbackWriteError && error.statusCode === 412,
    );
    assert.equal(FakeXHR.calls.length, 1, 'the PUT was attempted');
  });

  it('rejects with statusCode 0 on a network drop', async () => {
    FakeXHR.reset({ mode: 'error' });
    install();

    await assert.rejects(
      saveSourceFile(loopbackRequest()),
      (error: unknown) => error instanceof LoopbackWriteError && error.statusCode === 0,
    );
  });

  it('rejects with statusCode 0 on timeout and applies the 30s budget', async () => {
    FakeXHR.reset({ mode: 'timeout' });
    install();

    await assert.rejects(
      saveSourceFile(loopbackRequest()),
      (error: unknown) => error instanceof LoopbackWriteError && error.statusCode === 0,
    );
    assert.equal(FakeXHR.calls[0].timeoutMs, 30_000);
  });

  it('falls back to the picker when the extension context has no runtime id', async () => {
    FakeXHR.reset();
    install({ runtime: {} }, { mainWriterReady: false });
    const writes: string[] = [];
    let picks = 0;
    globals.window = {
      showOpenFilePicker: async () => { picks += 1; return [mockHandle('notes.md', writes)]; },
    };

    const result = await saveSourceFile(loopbackRequest());

    assert.equal(result.status, 'written');
    assert.equal(picks, 1);
    assert.equal(FakeXHR.calls.length, 0, 'no PUT without an extension runtime id');
  });

  it('does not use the PUT path for a non-loopback http URL', async () => {
    FakeXHR.reset();
    install({ runtime: { id: 'test-extension' } }, { mainWriterReady: false });
    const writes: string[] = [];
    let picks = 0;
    globals.window = {
      showOpenFilePicker: async () => { picks += 1; return [mockHandle('remote.md', writes)]; },
    };

    const result = await saveSourceFile(loopbackRequest({ documentUrl: 'https://example.com/a.md' }));

    assert.equal(result.status, 'written');
    assert.equal(picks, 1);
    assert.equal(FakeXHR.calls.length, 0);
  });

  it('does not use the PUT path when the chrome global is absent', async () => {
    FakeXHR.reset();
    install(undefined, { mainWriterReady: false });
    delete globals.chrome;
    const writes: string[] = [];
    let picks = 0;
    globals.window = {
      showOpenFilePicker: async () => { picks += 1; return [mockHandle('notes.md', writes)]; },
    };

    const result = await saveSourceFile(loopbackRequest());

    assert.equal(result.status, 'written');
    assert.equal(picks, 1);
    assert.equal(FakeXHR.calls.length, 0);
  });
});
