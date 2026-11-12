import { deliverFile } from '../../../../src/utils/file-download';

export interface SourceSaveTarget {
  filename: string;
  mimeType: string;
}

export interface SourceSaveRequest extends SourceSaveTarget {
  content: string;
  /** True for file:// documents, false for remote documents. */
  writeBack: boolean;
  handle: FileSystemFileHandle | null;
  /** Separates in-place Markdown navigation within the same page. */
  documentUrl?: string;
}

export const SOURCE_FILE_SAVE_REQUEST_EVENT = 'mv:source-file-save-request';
export const SOURCE_FILE_SAVE_RESPONSE_EVENT = 'mv:source-file-save-response';

interface SourceFileSaveResponse {
  requestId: string;
  status: 'written' | 'cancelled' | 'failed';
  error?: string;
}

export interface SourceSaveResult {
  status: 'written' | 'downloaded' | 'cancelled';
  handle: FileSystemFileHandle | null;
}

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
};

export function sourceFilePickerOptions(target: SourceSaveTarget, suggestedName?: string): Record<string, unknown> {
  return {
    id: 'markdown-viewer-source-editor',
    ...(suggestedName ? { suggestedName } : {}),
    types: [{
      description: 'Markdown',
      accept: { 'text/markdown': ['.md', '.markdown'] },
    }],
  };
}

function isPickerCancel(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function writeSourceFileHandle(handle: FileSystemFileHandle, content: string): Promise<void> {
  const permission = { mode: 'readwrite' as const };
  if (await handle.queryPermission(permission) !== 'granted') {
    if (await handle.requestPermission(permission) !== 'granted') {
      throw new Error('Write permission was not granted');
    }
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    // close() commits the temporary file. Abort a failed write instead of
    // committing a partial draft over the user's original Markdown.
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

function saveThroughMainWorld(request: SourceSaveRequest): Promise<SourceSaveResult> {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const onResponse = (event: Event) => {
      const detail = (event as CustomEvent<SourceFileSaveResponse>).detail;
      if (!detail || detail.requestId !== requestId) return;
      document.removeEventListener(SOURCE_FILE_SAVE_RESPONSE_EVENT, onResponse);
      if (detail.status === 'written') {
        // FileSystemFileHandle is intentionally kept in the MAIN world. Chrome
        // extension messages/events cannot transfer a live handle between worlds.
        resolve({ status: 'written', handle: null });
      } else if (detail.status === 'cancelled') {
        resolve({ status: 'cancelled', handle: null });
      } else {
        reject(new Error(detail.error || 'Could not write the local Markdown file'));
      }
    };
    document.addEventListener(SOURCE_FILE_SAVE_RESPONSE_EVENT, onResponse);
    document.dispatchEvent(new CustomEvent(SOURCE_FILE_SAVE_REQUEST_EVENT, {
      detail: { ...request, requestId },
    }));
  });
}

/**
 * Save through an explicitly user-authorized File System Access handle. The
 * browser cannot derive a writable handle from file:// alone, so the first
 * write-back asks the user to select the target. Remote documents use Save As;
 * browsers without the picker APIs retain the original download fallback.
 */
export async function saveSourceFile(request: SourceSaveRequest): Promise<SourceSaveResult> {
  const pickerWindow = window as FilePickerWindow;
  let handle = request.handle;

  // Edge can reject a picker invoked from the extension's isolated world. The
  // MAIN-world writer owns local handles for this page and performs the same
  // explicit picker → permission → atomic write sequence there instead.
  if (request.writeBack && !handle
    && typeof document !== 'undefined'
    && document.documentElement.dataset.mvSourceFileWriter === 'ready') {
    return saveThroughMainWorld(request);
  }

  try {
    if (!handle) {
      if (request.writeBack && pickerWindow.showOpenFilePicker) {
        [handle] = await pickerWindow.showOpenFilePicker({
          ...sourceFilePickerOptions(request),
          multiple: false,
        });
      } else if (!request.writeBack && pickerWindow.showSaveFilePicker) {
        handle = await pickerWindow.showSaveFilePicker(sourceFilePickerOptions(request, request.filename));
      }
    }
  } catch (error) {
    if (isPickerCancel(error)) {
      return { status: 'cancelled', handle: request.handle };
    }
    // Some content-script/page contexts expose the API but disallow invoking
    // it there. Keep a usable copy path instead of losing the edited text.
    if (!(error instanceof DOMException) || error.name !== 'SecurityError' || request.writeBack) {
      throw error;
    }
  }

  if (handle) {
    await writeSourceFileHandle(handle, request.content);
    return { status: 'written', handle };
  }

  if (request.writeBack) {
    throw new Error('Local file write-back is unavailable. Reload the Markdown page and try again; no copy was downloaded.');
  }

  await deliverFile({
    filename: request.filename,
    mimeType: request.mimeType,
    content: request.content,
  });
  return { status: 'downloaded', handle: null };
}
