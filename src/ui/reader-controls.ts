export const READER_CONTROLS_OPEN_CLASS = 'reader-controls-open';

/** Keep the floating trigger and the toolbar/TOC presentation in sync. */
export function setReaderControlsOpen(open: boolean): void {
  document.body.classList.toggle(READER_CONTROLS_OPEN_CLASS, open);
  document.getElementById('toggle-toc-btn')?.setAttribute('aria-expanded', String(open));
}

export function areReaderControlsOpen(): boolean {
  return document.body.classList.contains(READER_CONTROLS_OPEN_CLASS);
}
