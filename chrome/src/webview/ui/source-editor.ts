import { createHybridEditor } from './hybrid-editor';
import type { RendererService } from '../../../../src/types/platform';

export const SOURCE_EDITOR_ID = 'mv-source-editor';
export type SourceEditorPresentation = 'hybrid' | 'source';

export interface SourceEditorController {
  setActive(active: boolean): void;
  isActive(): boolean;
  getPresentation(): SourceEditorPresentation;
  setContent(content: string): void;
  getContent(): string;
  setStatus(status: string): void;
  setExternalChangeVisible(visible: boolean): void;
  focus(): void;
}

interface SourceEditorOptions {
  host: HTMLElement;
  renderer: RendererService;
  onInput: (content: string, presentation: SourceEditorPresentation) => void;
  onSave: () => void;
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
  const mode = document.createElement('div');
  mode.className = 'mv-source-editor-mode';
  const previewButton = document.createElement('button');
  previewButton.type = 'button';
  previewButton.id = 'mv-editor-preview-mode';
  previewButton.textContent = 'Preview';
  previewButton.setAttribute('aria-pressed', 'true');
  const sourceButton = document.createElement('button');
  sourceButton.type = 'button';
  sourceButton.id = 'mv-editor-source-mode';
  sourceButton.textContent = 'Source';
  sourceButton.setAttribute('aria-pressed', 'false');
  mode.append(previewButton, sourceButton);
  const status = document.createElement('span');
  status.id = 'mv-source-editor-status';
  status.textContent = 'All changes saved';
  header.append(title, mode, status);

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
  let sourceContent = '';
  let sourceLineEnding: '\n' | '\r\n' = '\n';
  textarea.addEventListener('input', () => {
    // textarea.value always exposes LF. Keep the authoritative source outside
    // the DOM so merely entering Source mode cannot rewrite CRLF (or mixed)
    // line endings; an actual Source edit consistently uses the original style.
    sourceContent = sourceLineEnding === '\r\n'
      ? textarea.value.replace(/\n/g, '\r\n')
      : textarea.value;
    options.onInput(sourceContent, 'source');
  });
  let presentation: SourceEditorPresentation = 'hybrid';
  let syncingContent = true;
  const hybrid = createHybridEditor({
    content: '',
    renderer: options.renderer,
    onInput: (content) => {
      if (syncingContent) return;
      sourceContent = content;
      textarea.value = content;
      options.onInput(content, 'hybrid');
    },
  });
  syncingContent = false;
  const hybridHost = document.createElement('div');
  hybridHost.id = 'mv-hybrid-editor-host';
  hybridHost.hidden = true;
  hybridHost.append(hybrid.element);

  const setPresentation = (value: SourceEditorPresentation): void => {
    presentation = value;
    const isHybrid = value === 'hybrid';
    hybridHost.hidden = !isHybrid;
    textarea.hidden = isHybrid;
    previewButton.setAttribute('aria-pressed', String(isHybrid));
    sourceButton.setAttribute('aria-pressed', String(!isHybrid));
    if (!pane.hidden) {
      document.documentElement.dataset.sourceEditor = value;
      hybrid.setActive(isHybrid);
    }
    if (isHybrid) hybrid.setContent(sourceContent);
  };
  previewButton.addEventListener('click', () => {
    setPresentation('hybrid');
    hybrid.focus();
  });
  sourceButton.addEventListener('click', () => {
    setPresentation('source');
    textarea.focus();
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    event.preventDefault();
    const { selectionStart, selectionEnd } = textarea;
    textarea.setRangeText('  ', selectionStart, selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  pane.append(header, conflict, hybridHost, textarea);
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
        setPresentation(presentation);
      } else {
        hybrid.setActive(false);
        delete document.documentElement.dataset.sourceEditor;
        conflict.hidden = true;
      }
    },
    isActive() {
      return !pane.hidden;
    },
    getPresentation() {
      return presentation;
    },
    setContent(content) {
      syncingContent = true;
      try {
        sourceContent = content;
        sourceLineEnding = content.includes('\r\n') ? '\r\n' : '\n';
        hybrid.setContent(content);
        if (textarea.value !== content) textarea.value = content;
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
    focus() {
      if (presentation === 'hybrid') hybrid.focus();
      else textarea.focus();
    },
  };
}
