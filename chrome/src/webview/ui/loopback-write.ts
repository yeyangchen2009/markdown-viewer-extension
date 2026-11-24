/**
 * Same-origin PUT write-back for a `documd serve` loopback document.
 *
 * The page itself is served from the loopback origin, so this XHR is a
 * same-origin request: it needs no host permission, no CORS headers on the
 * server and no preflight, mirroring readSameOriginHttpUrl() in api-impl.ts
 * (a content script may always talk to its own origin, and doing it here
 * keeps the worker's connect-src CSP out of the path). It deliberately does
 * NOT fall back to a download: a failed write must surface as an error so the
 * editor keeps its dirty draft, never silently replace in-place save with a
 * Save-As copy.
 */

export interface LoopbackPutResult {
  /** Strong ETag returned by the server for the new revision, or null. */
  etag: string | null;
}

/**
 * Raised for every failed write. `statusCode` carries the HTTP status when
 * the server answered (412/413/415/5xx, …), or 0 when no response arrived
 * (network drop, timeout), so callers can branch on the concrete status.
 */
export class LoopbackWriteError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LoopbackWriteError';
    this.statusCode = statusCode;
  }
}

const PUT_TIMEOUT_MS = 30_000;

/**
 * PUT `content` to the loopback document's own URL.
 *
 * The body is sent as UTF-8 bytes rather than a JS string so CRLF line ends
 * and trailing newlines survive byte-for-byte; the server stores the bytes
 * verbatim and hashes them for the returned ETag.
 *
 * @param url Absolute loopback document URL (http://127.0.0.1|::1|localhost).
 * @param content Full replacement document text.
 * @param expectedETag When set, sent as If-Match for optimistic concurrency.
 */
export function putLoopbackSource(
  url: string,
  content: string,
  expectedETag?: string | null,
): Promise<LoopbackPutResult> {
  return new Promise<LoopbackPutResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    // Normalise once so a relative or oddly shaped input fails here instead
    // of reaching open() with an opaque target.
    request.open('PUT', new URL(url).href, true);
    request.timeout = PUT_TIMEOUT_MS;
    request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
    if (expectedETag) {
      request.setRequestHeader('If-Match', expectedETag);
    }

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        // XHR header lookup is case-insensitive.
        resolve({ etag: request.getResponseHeader('ETag') });
        return;
      }
      reject(new LoopbackWriteError(
        `HTTP ${request.status}: ${request.statusText || 'write rejected'}`,
        request.status,
      ));
    };
    request.onerror = () => {
      reject(new LoopbackWriteError('NetworkError when writing the loopback resource', 0));
    };
    request.ontimeout = () => {
      reject(new LoopbackWriteError(`Timed out after ${PUT_TIMEOUT_MS}ms writing the loopback resource`, 0));
    };

    request.send(new TextEncoder().encode(content));
  });
}
