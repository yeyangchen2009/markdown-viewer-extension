export const SOURCE_EDITOR_ID = 'mv-source-editor';

export interface SourceEditorController {
  setActive(active: boolean): void;
  isActive(): boolean;
  setContent(content: string): void;
  getContent(): string;
  setStatus(status: string): void;
  setExternalChangeVisible(visible: boolean): void;
  focus(): void;
}

interface SourceEditorOptions {
  host: HTMLElement;
  onInput: (content: string) => void;
  onReloadExternal: () => void;
  onDismissExternal: () => void;
}

/**
 * A persistent Markdown source pane. It lives outside #markdown-wrapper so the
 * preview renderer can replace its own DOM without destroying focus or edits.
 */
export function createSourceEditor(options: SourceEditorOptions): SourceEditorController {
  const pane = document.createElement('section');
  pane.id = SOURCE_EDITOR_ID;
  pane.hidden = true;
  pane.setAttribute('aria-label', 'Markdown editor');

  const header = document.createElement('div');
  header.className = 'mv-source-editor-header';
  const title = document.createElement('span');
  title.textContent = 'Markdown';
  const status = document.createElement('span');
  status.id = 'mv-source-editor-status';
  status.textContent = 'All changes saved';
  header.append(title, status);

  const conflict = document.createElement('div');
  conflict.id = 'mv-source-editor-conflict';
  conflict.className = 'mv-source-editor-conflict';
  conflict.hidden = true;
  const conflictText = document.createElement('span');
  conflictText.textContent = 'This file changed on disk. Your draft has not been overwritten.';
  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.textContent = 'Load disk version';
  reloadButton.addEventListener('click', options.onReloadExternal);
  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.textContent = 'Keep my draft';
  dismissButton.addEventListener('click', options.onDismissExternal);
  conflict.append(conflictText, reloadButton, dismissButton);

  const textarea = document.createElement('textarea');
  textarea.id = 'mv-source-editor-input';
  textarea.setAttribute('aria-label', 'Markdown source');
  textarea.spellcheck = false;
  textarea.wrap = 'off';
  textarea.autocapitalize = 'off';
  textarea.autocomplete = 'off';
  textarea.addEventListener('input', () => options.onInput(textarea.value));
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    event.preventDefault();
    const { selectionStart, selectionEnd } = textarea;
    textarea.setRangeText('  ', selectionStart, selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  pane.append(header, conflict, textarea);
  options.host.prepend(pane);

  return {
    setActive(active) {
      pane.hidden = !active;
      if (active) {
        document.documentElement.dataset.sourceEditor = '1';
      } else {
        delete document.documentElement.dataset.sourceEditor;
        conflict.hidden = true;
      }
    },
    isActive() {
      return !pane.hidden;
    },
    setContent(content) {
      // Incremental preview renders call back into the viewer. Avoid replacing
      // the value when it already matches, which would reset the caret.
      if (textarea.value !== content) {
        textarea.value = content;
      }
    },
    getContent() {
      return textarea.value;
    },
    setStatus(value) {
      status.textContent = value;
    },
    setExternalChangeVisible(visible) {
      conflict.hidden = !visible;
    },
    focus() {
      textarea.focus();
    },
  };
}
