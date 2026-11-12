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

/**
 * Owns local file handles in the page's MAIN world. The isolated-world viewer
 * sends only text requests; live FileSystemFileHandle objects never cross the
 * extension messaging boundary. Handles are scoped by document URL because
 * Markdown links can navigate in place without destroying this script.
 */
if (document.documentElement.dataset.mvSourceFileWriter !== 'ready') {
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
      const pickerWindow = window as PickerWindow;
      if (!pickerWindow.showOpenFilePicker) {
        throw new Error('This browser does not provide local file write-back');
      }
      let handle = handles.get(documentKey) ?? null;
      if (!handle) {
        [handle] = await pickerWindow.showOpenFilePicker({
          ...sourceFilePickerOptions(request),
          multiple: false,
        });
        handles.set(documentKey, handle);
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
