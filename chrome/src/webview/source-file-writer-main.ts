import {
  SOURCE_FILE_SAVE_REQUEST_EVENT,
  SOURCE_FILE_SAVE_RESPONSE_EVENT,
  sourceFilePickerOptions,
  writeSourceFileHandle,
  type SourceSaveRequest,
} from './ui/source-file-writer';

interface MainWorldSaveRequest extends SourceSaveRequest {
  requestId: string;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
};

const HANDLE_DATABASE = 'markdown-viewer-source-editor';
const HANDLE_STORE = 'file-handles';
let handleDatabase: Promise<IDBDatabase> | null = null;

function openHandleDatabase(): Promise<IDBDatabase> {
  if (handleDatabase) return handleDatabase;
  handleDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('File handle database is blocked'));
  });
  handleDatabase.catch(() => {
    handleDatabase = null;
  });
  return handleDatabase;
}

async function restoreFileHandle(documentKey: string): Promise<FileSystemFileHandle | null> {
  const database = await openHandleDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(HANDLE_STORE, 'readonly')
      .objectStore(HANDLE_STORE).get(documentKey);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function persistFileHandle(documentKey: string, handle: FileSystemFileHandle): Promise<void> {
  const database = await openHandleDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(HANDLE_STORE, 'readwrite');
    transaction.objectStore(HANDLE_STORE).put(handle, documentKey);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * Owns local file handles in the page's MAIN world. The isolated-world viewer
 * sends only text requests; live FileSystemFileHandle objects never cross the
 * extension messaging boundary. Handles are scoped by document URL because
 * Markdown links can navigate in place without destroying this script.
 */
if (document.documentElement.dataset.mvSourceFileWriter !== 'ready') {
  const pickerWindow = window as PickerWindow;
  // The ready guard retains this closure across reinjection. Do not expose live
  // write-capable handles as window properties readable by other page scripts.
  const handles = new Map<string, FileSystemFileHandle>();

  const respond = (requestId: string, status: 'written' | 'cancelled' | 'failed', error?: string): void => {
    document.dispatchEvent(new CustomEvent(SOURCE_FILE_SAVE_RESPONSE_EVENT, {
      detail: { requestId, status, ...(error ? { error } : {}) },
    }));
  };

  document.addEventListener(SOURCE_FILE_SAVE_REQUEST_EVENT, async (event: Event) => {
    const request = (event as CustomEvent<MainWorldSaveRequest>).detail;
    if (!request?.writeBack || typeof request.requestId !== 'string') return;

    const documentKey = request.documentUrl || window.location.href;
    try {
      if (!pickerWindow.showOpenFilePicker) {
        throw new Error('This browser does not provide local file write-back');
      }
      let handle = handles.get(documentKey) ?? null;
      let selected = false;
      if (!handle) {
        // FileSystemFileHandle is structured-cloneable. IndexedDB preserves it
        // across reloads; the normal write path below revalidates readwrite
        // permission instead of asking the user to locate the file again.
        handle = await restoreFileHandle(documentKey).catch(() => null);
      }
      if (!handle) {
        [handle] = await pickerWindow.showOpenFilePicker({
          ...sourceFilePickerOptions(request),
          multiple: false,
        });
        selected = true;
      }
      handles.set(documentKey, handle);
      if (selected) {
        // Persistence is best-effort: private modes and test doubles may not
        // accept a handle, but that must not turn a valid in-memory save into a
        // failure. The next save still hits the window registry above.
        await persistFileHandle(documentKey, handle).catch((error: unknown) => {
          console.warn('[SourceEditor] File handle persistence unavailable:', error);
        });
      }
      await writeSourceFileHandle(handle, request.content);
      respond(request.requestId, 'written');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        respond(request.requestId, 'cancelled');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      respond(request.requestId, 'failed', error instanceof DOMException
        ? `${error.name}: ${message}`
        : message);
    }
  });

  document.documentElement.dataset.mvSourceFileWriter = 'ready';
}
