import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { saveSourceFile } from '../../../chrome/src/webview/ui/source-file-writer.ts';

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
