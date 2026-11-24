/**
 * External-modification watch for a `documd serve` loopback document.
 *
 * The isolated world polls the document's own URL with a conditional GET
 * (If-None-Match against the strong sha256 ETag the serve factory issues).
 * A 304 means the disk is unchanged; a 200 hands the decoded text to
 * onChange, which is viewer-main's handleFileChanged — every conflict rule
 * (echo suppression, clean hot-swap with scroll preservation, dirty-draft
 * banner) is reused there rather than reimplemented here.
 *
 * Deliberately independent of the file:// tracking stack: no service-worker
 * alarms, no background.ts involvement, no host permissions (same-origin
 * XHR, mirroring loopback-write.ts).
 */

export interface LoopbackWatchController {
  /** Idempotent: clears the interval and aborts any in-flight request. */
  stop(): void;
  /** Current strong ETag to send as If-Match on the next PUT, or null. */
  getETag(): string | null;
  /**
   * Adopt the revision our own PUT just committed (response ETag plus the
   * saved text) so the next poll's 304 baseline and the next save's If-Match
   * both match disk — without this, back-to-back saves would race the poll
   * and surface a spurious 412.
   */
  noteSavedState(etag: string | null, content: string): void;
}

export interface LoopbackWatchDeps {
  /** Dynamic getter (never a snapshot) so in-place navigation is picked up. */
  getUrl: () => string;
  /** Poll cadence; defaults to 6000 ms, aligned with the alarms-based file:// tracker. */
  intervalMs?: number;
  /** Called only when a 200 brings content that differs from the baseline. */
  onChange: (content: string) => void;
  /** Loopback predicate; polling stays dormant while it returns false. */
  isRelevant: (url: string) => boolean;
}

const DEFAULT_INTERVAL_MS = 6_000;

interface WatchResponse {
  status: number;
  etag: string | null;
  text: string | null;
}

/** One conditional GET. onDone(null) means no response arrived. */
function requestOnce(
  url: string,
  ifNoneMatch: string | null,
  onDone: (response: WatchResponse | null) => void,
): XMLHttpRequest {
  const request = new XMLHttpRequest();
  request.open('GET', new URL(url).href, true);
  // Bytes + explicit decode, symmetric with the read path in api-impl.ts:
  // the text handed to onChange must survive verbatim.
  request.responseType = 'arraybuffer';
  if (ifNoneMatch) {
    request.setRequestHeader('If-None-Match', ifNoneMatch);
  }
  let settled = false;
  const finish = (response: WatchResponse | null): void => {
    if (settled) return;
    settled = true;
    onDone(response);
  };
  request.onload = () => {
    let text: string | null = null;
    if (request.status === 200 && request.response) {
      text = new TextDecoder().decode(request.response);
    }
    finish({
      status: request.status,
      etag: request.getResponseHeader('ETag'),
      text,
    });
  };
  request.onerror = () => finish(null);
  request.ontimeout = () => finish(null);
  request.onabort = () => finish(null);
  request.send();
  return request;
}

export function startLoopbackFileWatch(deps: LoopbackWatchDeps): LoopbackWatchController {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let watchedUrl = deps.getUrl();
  let etag: string | null = null;
  let baselineContent: string | null = null;
  let inFlight: XMLHttpRequest | null = null;
  let stopped = false;
  // Log a refused/unreachable server once per outage instead of once per
  // tick; the flag resets on the first response after recovery.
  let outageWarned = false;

  const warnOutage = (): void => {
    if (outageWarned) return;
    outageWarned = true;
    // eslint-disable-next-line no-console
    console.warn('[Viewer] Loopback file watch: server unreachable; will retry on the next tick.');
  };

  const poll = (rebaseline: boolean): void => {
    if (stopped || inFlight) return;
    const url = watchedUrl;
    // A rebaseline GET is unconditional: whatever is on disk right now IS the
    // freshly opened document, so it must not surface as an external edit.
    const ifNoneMatch = rebaseline ? null : etag;
    inFlight = requestOnce(url, ifNoneMatch, (response) => {
      inFlight = null;
      if (stopped || url !== watchedUrl) return;
      if (!response) {
        warnOutage();
        return;
      }
      outageWarned = false;
      if (response.status === 304) return;
      if (response.status !== 200 || response.text === null) return;
      const previousBaseline = baselineContent;
      etag = response.etag;
      baselineContent = response.text;
      if (rebaseline) return;
      if (previousBaseline !== null && response.text === previousBaseline) return;
      try {
        deps.onChange(response.text);
      } catch (error) {
        // A viewer-side failure must not kill the polling loop.
        // eslint-disable-next-line no-console
        console.warn('[Viewer] Loopback file watch onChange failed:', error);
      }
    });
  };

  const tick = (): void => {
    if (stopped) return;
    const url = deps.getUrl();
    if (!deps.isRelevant(url)) return;
    if (url !== watchedUrl) {
      // Defensive layer: resetSourceEditorForDocument already restarts the
      // watch on navigation, but if the URL ever moves without that hook,
      // drop the old baseline immediately instead of comparing across files.
      watchedUrl = url;
      etag = null;
      baselineContent = null;
      inFlight?.abort();
      inFlight = null;
      poll(true);
      return;
    }
    // Hidden tabs keep their state but skip the traffic; the next visible
    // tick's conditional GET catches up on anything missed.
    if (typeof document !== 'undefined' && document.hidden) return;
    poll(false);
  };

  poll(true);
  const timer = setInterval(tick, intervalMs);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      inFlight?.abort();
      inFlight = null;
    },
    getETag(): string | null {
      return etag;
    },
    noteSavedState(savedETag: string | null, content: string): void {
      if (stopped) return;
      if (savedETag) etag = savedETag;
      baselineContent = content;
    },
  };
}
