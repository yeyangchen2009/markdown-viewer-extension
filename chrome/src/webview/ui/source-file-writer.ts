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
}

export interface SourceSaveResult {
  status: 'written' | 'downloaded' | 'cancelled';
  handle: FileSystemFileHandle | null;
}

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
};

function pickerOptions(target: SourceSaveTarget, suggestedName?: string): Record<string, unknown> {
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

async function writeHandle(handle: FileSystemFileHandle, content: string): Promise<void> {
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

/**
 * Save through an explicitly user-authorized File System Access handle. The
 * browser cannot derive a writable handle from file:// alone, so the first
 * write-back asks the user to select the target. Remote documents use Save As;
 * browsers without the picker APIs retain the original download fallback.
 */
export async function saveSourceFile(request: SourceSaveRequest): Promise<SourceSaveResult> {
  const pickerWindow = window as FilePickerWindow;
  let handle = request.handle;

  try {
    if (!handle) {
      if (request.writeBack && pickerWindow.showOpenFilePicker) {
        [handle] = await pickerWindow.showOpenFilePicker({
          ...pickerOptions(request),
          multiple: false,
        });
      } else if (!request.writeBack && pickerWindow.showSaveFilePicker) {
        handle = await pickerWindow.showSaveFilePicker(pickerOptions(request, request.filename));
      }
    }
  } catch (error) {
    if (isPickerCancel(error)) {
      return { status: 'cancelled', handle: request.handle };
    }
    // Some content-script/page contexts expose the API but disallow invoking
    // it there. Keep a usable copy path instead of losing the edited text.
    if (!(error instanceof DOMException) || error.name !== 'SecurityError') {
      throw error;
    }
  }

  if (handle) {
    await writeHandle(handle, request.content);
    return { status: 'written', handle };
  }

  await deliverFile({
    filename: request.filename,
    mimeType: request.mimeType,
    content: request.content,
  });
  return { status: 'downloaded', handle: null };
}
