import {
  CodeBlockAstNode,
  EditorController,
  EditorModel,
  EditorView,
  LocalHistoryStrategy,
  OffsetRange,
  Selection,
  StringValue,
  type AstNode,
} from '@vscode/markdown-editor';
import { autorun, observableValue } from '@vscode/observables';
import {
  CODE_BLOCK_LANGUAGE_MAP,
  DIAGRAM_CODE_BLOCK_LANGUAGE_SET,
} from '../../../../src/types/formats';
import type { RendererService } from '../../../../src/types/platform';
import { createPluginResultElement } from '../../../../src/plugins/plugin-html-utils';

export interface HybridEditorController {
  readonly element: HTMLElement;
  getContent(): string;
  setContent(content: string): void;
  setActive(active: boolean): void;
  setLayoutWidth(maxWidth: string): void;
  revealSourceLine(line: number): void;
  captureCurrentLine(): number | null;
  focus(): void;
}

interface HybridEditorOptions {
  content: string;
  renderer: RendererService;
  onInput: (content: string) => void;
}

/** Convert the viewer's zero-based source line without losing CRLF columns. */
function sourceLineToOffset(text: string, line: number): number {
  const targetLine = Math.max(0, Math.floor(line));
  if (targetLine === 0) return 0;
  let currentLine = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    currentLine += 1;
    if (currentLine === targetLine) return match.index + match[0].length;
  }
  return text.length;
}

function offsetToSourceLine(text: string, offset: number): number {
  const targetOffset = Math.max(0, Math.min(text.length, offset));
  let line = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    if (match.index + match[0].length > targetOffset) break;
    line += 1;
  }
  return line;
}

/**
 * Rendered Markdown editing without an HTML-to-Markdown round trip. The model
 * retains the exact source; only the active block reveals its source markers.
 */
export function createHybridEditor(options: HybridEditorOptions): HybridEditorController {
  let applyingAuthoritativeContent = false;
  const model = new EditorModel();
  model.sourceText.set(new StringValue(options.content), undefined);
  model.readonlyMode.set(true, undefined);
  model.presentation.set('editing', undefined);

  const diagramSourceOffsets = (): number[] => {
    const offsets: number[] = [];
    const activeBlocks = model.activeBlocks.get();
    const visit = (nodes: readonly AstNode[], baseOffset: number): void => {
      let offset = baseOffset;
      for (const node of nodes) {
        if (node instanceof CodeBlockAstNode
          && !activeBlocks.has(node)
          && DIAGRAM_CODE_BLOCK_LANGUAGE_SET.has(node.language.trim().split(/\s+/)[0]?.toLowerCase() ?? '')) {
          offsets.push(offset + node.codeOffset);
        }
        visit(node.children, offset);
        offset += node.length;
      }
    };
    visit(model.document.get().children, 0);
    return offsets;
  };

  const renderDiagram = (language: string, content: string): HTMLElement | undefined => {
    const normalized = language.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!DIAGRAM_CODE_BLOCK_LANGUAGE_SET.has(normalized)) return undefined;
    const placeholder = document.createElement('div');
    placeholder.className = 'mv-hybrid-diagram';
    placeholder.textContent = `Rendering ${normalized}…`;
    const type = CODE_BLOCK_LANGUAGE_MAP[normalized] || normalized;
    void options.renderer.render(type, content).then((result) => {
      if (!placeholder.isConnected) return;
      if (!result.base64) throw new Error(result.error || 'Diagram renderer returned no image');
      const rendered = createPluginResultElement({
        type: 'image',
        content: result,
        display: { inline: false, alignment: 'center' },
      }, type);
      if (rendered) placeholder.replaceChildren(rendered);
    }).catch((error: unknown) => {
      if (!placeholder.isConnected) return;
      placeholder.classList.add('mv-hybrid-diagram-error');
      placeholder.textContent = `${normalized}: ${error instanceof Error ? error.message : String(error)}`;
    });
    placeholder.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // The package's source-less custom-block hit testing can select the next
      // block. Map this rendered result to its AST explicitly; the normal
      // selection/active-block machinery then reveals the exact fence source.
      const placeholders = Array.from(view.element.querySelectorAll('.mv-hybrid-diagram'));
      const offset = diagramSourceOffsets()[placeholders.indexOf(placeholder)];
      if (offset === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      view.focus();
      model.selection.set(Selection.collapsed(offset), undefined);
    });
    return placeholder;
  };

  const limitedWidth = observableValue<number | undefined>('markdownViewerLimitedWidth', 1360);
  const view = new EditorView(model, {
    classNames: ['github-markdown-theme', 'mv-hybrid-editor'],
    presentation: 'editing',
    limitedWidth,
    showReadonlyToggle: false,
    renderCustomCodeBlock: renderDiagram,
    onToggleCheckbox: (item, checked) => model.setTaskCheckboxChecked(item, checked),
    onOpenLink: (url) => {
      // Match the existing standalone viewer: local links navigate in place;
      // remote links never replace the document containing unsaved edits.
      if (/^https?:/i.test(url)) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      window.location.assign(new URL(url, window.location.href).href);
    },
  });
  view.element.id = 'mv-hybrid-editor-input';
  view.element.setAttribute('aria-label', 'Rendered Markdown editor');
  const history = new LocalHistoryStrategy(model);
  const controller = new EditorController(model, view, { historyStrategy: history });
  let active = false;
  let revealVersion = 0;
  let revealFrame: number | undefined;
  let pendingReveal: { dispose(): void } | undefined;
  let preservedSourceLine: number | null = null;
  let preservedScrollTop = 0;
  const revealInterruptEvents = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
  const removeRevealInterruptListeners = (): void => {
    for (const event of revealInterruptEvents) {
      document.removeEventListener(event, interruptReveal, true);
    }
  };
  const cancelReveal = (): void => {
    revealVersion += 1;
    if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
    revealFrame = undefined;
    pendingReveal?.dispose();
    pendingReveal = undefined;
    removeRevealInterruptListeners();
  };
  function interruptReveal(): void {
    cancelReveal();
  }
  let previousContent = options.content;
  const observer = autorun((reader) => {
    const content = reader.readObservable(model.sourceText).value;
    if (!applyingAuthoritativeContent && content !== previousContent) {
      // Edits can insert lines above the anchor. Re-capture from the current
      // document instead of returning the pre-edit source line on exit.
      preservedSourceLine = null;
      options.onInput(content);
    }
    previousContent = content;
  });
  // These objects own the editor's DOM listeners and observable subscription
  // for the lifetime of the persistent pane.
  void controller;
  void observer;

  return {
    element: view.element,
    getContent: () => model.sourceText.get().value,
    setContent(content) {
      cancelReveal();
      preservedSourceLine = null;
      if (model.sourceText.get().value === content) return;
      applyingAuthoritativeContent = true;
      try {
        model.replaceSourceText(new StringValue(content));
      } finally {
        applyingAuthoritativeContent = false;
      }
    },
    setActive(value) {
      cancelReveal();
      preservedSourceLine = null;
      active = value;
      model.readonlyMode.set(!value, undefined);
      if (!value) model.selection.set(undefined, undefined);
    },
    setLayoutWidth(maxWidth) {
      const width = maxWidth.trim();
      const pixels = width.endsWith('px') ? Number.parseFloat(width) : Number.NaN;
      limitedWidth.set(Number.isFinite(pixels) && pixels > 0 ? pixels : undefined, undefined);
    },
    revealSourceLine(line) {
      if (!active || !Number.isFinite(line)) return;
      cancelReveal();
      const version = revealVersion;
      const source = model.sourceText.get();
      const offset = sourceLineToOffset(source.value, line);
      const selection = Selection.collapsed(offset);
      const range = OffsetRange.emptyAt(offset);
      const host = view.element.closest<HTMLElement>('#mv-hybrid-editor-host') ?? view.element;
      preservedSourceLine = line;
      model.selection.set(selection, undefined);
      for (const event of revealInterruptEvents) {
        document.addEventListener(event, interruptReveal, { capture: true, passive: true });
      }
      let attemptsRemaining = 60;
      const reveal = (): void => {
        if (version !== revealVersion || !active) return;
        if (model.sourceText.get() !== source || model.selection.get() !== selection) {
          cancelReveal();
          return;
        }
        pendingReveal?.dispose();
        pendingReveal = view.revealRangeAtTop(range, 'instant');
        preservedScrollTop = host.scrollTop;
        attemptsRemaining -= 1;
        if (attemptsRemaining > 0) {
          revealFrame = requestAnimationFrame(reveal);
        } else {
          revealFrame = undefined;
          // The package still owns its final post-scroll correction and input
          // cancellation; only our bounded retry loop finishes here.
          removeRevealInterruptListeners();
        }
      };
      revealFrame = requestAnimationFrame(reveal);
    },
    captureCurrentLine() {
      const host = view.element.closest<HTMLElement>('#mv-hybrid-editor-host') ?? view.element;
      // Reading lines include fractional progress inside a block. Preserve that
      // exact anchor across a no-scroll round trip instead of repeatedly
      // truncating it to the first source line of the visible editor block.
      if (preservedSourceLine !== null && Math.abs(host.scrollTop - preservedScrollTop) < 1) {
        return preservedSourceLine;
      }
      const blocks = view.documentViewNode.get()?.blocks
        .filter(({ node }) => node.block.kind !== 'emptyBlock');
      if (!blocks || blocks.length === 0) return null;
      const viewport = host.getBoundingClientRect();
      const visible = blocks.find(({ node }) => {
        const rect = node.element.getBoundingClientRect();
        return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
      });
      const block = visible ?? blocks[blocks.length - 1];
      return offsetToSourceLine(model.sourceText.get().value, block.absoluteStart);
    },
    focus() {
      view.focus();
    },
  };
}
