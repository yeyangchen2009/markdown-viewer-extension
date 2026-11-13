import { createHybridEditor } from './hybrid-editor';
import type { RendererService } from '../../../../src/types/platform';

export const SOURCE_EDITOR_ID = 'mv-source-editor';

export interface SourceEditorController {
  setActive(active: boolean): void;
  isActive(): boolean;
  setContent(content: string): void;
  getContent(): string;
  setStatus(status: string): void;
  setExternalChangeVisible(visible: boolean): void;
  setLayoutWidth(maxWidth: string): void;
  revealSourceLine(line: number): void;
  captureCurrentLine(): number | null;
  focus(): void;
}

interface SourceEditorOptions {
  host: HTMLElement;
  renderer: RendererService;
  onInput: (content: string) => void;
  onSave: () => void;
  onReloadExternal: () => void;
  onDismissExternal: () => void;
}

/**
 * A persistent rendered Markdown editor. It lives outside #markdown-wrapper so
 * the preview renderer can replace its own DOM without destroying focus or edits.
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

  let sourceContent = '';
  let syncingContent = true;
  const hybrid = createHybridEditor({
    content: '',
    renderer: options.renderer,
    onInput: (content) => {
      if (syncingContent) return;
      sourceContent = content;
      options.onInput(content);
    },
  });
  syncingContent = false;
  const hybridHost = document.createElement('div');
  hybridHost.id = 'mv-hybrid-editor-host';
  hybridHost.append(hybrid.element);

  pane.append(header, conflict, hybridHost);
  options.host.prepend(pane);

  // Bind when the editor is created, not after the viewer's asynchronous boot.
  // Capture prevents Edge's native Save Page shortcut and the toolbar's later
  // bubble listener from turning an active editor save into Save As/DOCX.
  document.addEventListener('keydown', (event) => {
    if (pane.hidden || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    options.onSave();
  }, true);

  return {
    setActive(active) {
      pane.hidden = !active;
      if (active) {
        document.documentElement.dataset.sourceEditor = 'hybrid';
        hybrid.setActive(true);
        hybrid.setContent(sourceContent);
      } else {
        hybrid.setActive(false);
        delete document.documentElement.dataset.sourceEditor;
        conflict.hidden = true;
      }
    },
    isActive() {
      return !pane.hidden;
    },
    setContent(content) {
      syncingContent = true;
      try {
        sourceContent = content;
        hybrid.setContent(content);
      } finally {
        syncingContent = false;
      }
    },
    getContent() {
      return sourceContent;
    },
    setStatus(value) {
      status.textContent = value;
    },
    setExternalChangeVisible(visible) {
      conflict.hidden = !visible;
    },
    setLayoutWidth(maxWidth) {
      hybrid.setLayoutWidth(maxWidth);
    },
    revealSourceLine(line) {
      hybrid.revealSourceLine(line);
    },
    captureCurrentLine() {
      return hybrid.captureCurrentLine();
    },
    focus() {
      hybrid.focus();
    },
  };
}
