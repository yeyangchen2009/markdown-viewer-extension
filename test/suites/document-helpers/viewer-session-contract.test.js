import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  resolveDefaultTocVisibility,
  resolveTocPresentation,
} from '../../../src/core/viewer/viewer-session-contract.ts';
import { createViewerSession } from '../../../src/core/viewer/viewer-session.ts';

describe('viewer container defaults', () => {
  it('uses hidden TOC by default for browser mode', () => {
    assert.strictEqual(resolveDefaultTocVisibility('browser'), false);
  });

  it('uses hidden TOC by default for panel mode', () => {
    assert.strictEqual(resolveDefaultTocVisibility('panel'), false);
  });

  it('keeps embedded mode collapsed by default', () => {
    assert.strictEqual(resolveDefaultTocVisibility('embedded'), false);
  });

  it('maps browser mode to sidebar TOC presentation', () => {
    assert.strictEqual(resolveTocPresentation('browser'), 'sidebar');
  });

  it('maps panel mode to floating TOC presentation', () => {
    assert.strictEqual(resolveTocPresentation('panel'), 'floating');
  });
});

describe('viewer reading defaults', () => {
  const document = {
    documentKey: 'file:///tmp/doc.md',
    displayName: 'doc.md',
    format: 'markdown',
    sourceToggleSupported: true,
    containerMode: 'browser',
    embedded: false,
  };

  it('opens a new browser document fullscreen with the reading controls collapsed', () => {
    const session = createViewerSession();
    session.dispatch({ type: 'open-document', document, content: '# Hi\n' });

    const snapshot = session.getSnapshot();
    assert.strictEqual(snapshot.layoutMode, 'fullscreen');
    assert.strictEqual(snapshot.tocVisible, false);
  });

  it('keeps a persisted normal layout and expanded controls above the new defaults', () => {
    const session = createViewerSession();
    session.dispatch({
      type: 'open-document',
      document,
      content: '# Hi\n',
      persistedState: { layoutMode: 'normal', tocVisible: true },
    });

    const snapshot = session.getSnapshot();
    assert.strictEqual(snapshot.layoutMode, 'normal');
    assert.strictEqual(snapshot.tocVisible, true);
  });
});
