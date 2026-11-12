import {
  CodeBlockAstNode,
  EditorController,
  EditorModel,
  EditorView,
  LocalHistoryStrategy,
  Selection,
  StringValue,
  type AstNode,
} from '@vscode/markdown-editor';
import { autorun } from '@vscode/observables';
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
  focus(): void;
}

interface HybridEditorOptions {
  content: string;
  renderer: RendererService;
  onInput: (content: string) => void;
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

  const view = new EditorView(model, {
    classNames: ['github-markdown-theme', 'mv-hybrid-editor'],
    presentation: 'editing',
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
  let previousContent = options.content;
  const observer = autorun((reader) => {
    const content = reader.readObservable(model.sourceText).value;
    if (!applyingAuthoritativeContent && content !== previousContent) {
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
      if (model.sourceText.get().value === content) return;
      applyingAuthoritativeContent = true;
      try {
        model.replaceSourceText(new StringValue(content));
      } finally {
        applyingAuthoritativeContent = false;
      }
    },
    setActive(active) {
      model.readonlyMode.set(!active, undefined);
      if (!active) model.selection.set(undefined, undefined);
    },
    focus() {
      view.focus();
    },
  };
}
