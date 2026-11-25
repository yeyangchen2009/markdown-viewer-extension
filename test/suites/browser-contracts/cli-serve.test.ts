import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createServeServer } from '../../../scripts/documd.js';

const IS_FIBJS = Boolean(process.versions.fibjs);

type ServeServer = Awaited<ReturnType<typeof createServeServer>>;

interface SendResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  // When set, it replaces the request target verbatim (used to send raw
  // `/../` or encoded paths without the client's URL normalisation).
  rawPath?: string;
}

/**
 * RFC 9110 responses that carry no message body: 1xx/204/304 status codes,
 * plus any response to a HEAD request. fibjs's node:http compatibility layer
 * builds no body stream for these (its client sets m_bNoBody and skips the
 * BodyStream wrapper), so the stream-event bridge never emits 'end' there:
 * waiting on it hangs the suite. Settle such responses without stream events.
 */
function isNoBodyResponse(method: string | undefined, status: number): boolean {
  return (
    (method ?? 'GET').toUpperCase() === 'HEAD' ||
    status === 204 ||
    status === 304 ||
    (status >= 100 && status < 200)
  );
}

/**
 * node:http request helper (no global fetch, so the suite stays compatible
 * with the fibjs runtime that runs test:unit in CI).
 */
function send(targetUrl: string, options: SendOptions = {}): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const request = http.request(
      {
        method: options.method ?? 'GET',
        hostname: target.hostname,
        port: target.port,
        path: options.rawPath ?? `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (response) => {
        if (isNoBodyResponse(options.method, response.statusCode ?? 0)) {
          response.resume();
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.alloc(0),
          });
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** Encodes each path segment (keeps slashes) for a valid loopback URL. */
function docUrl(server: ServeServer, relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `${server.origin}${server.basePath}/${encoded}`;
}

function sha256Etag(buffer: Buffer): string {
  return `"${crypto.createHash('sha256').update(buffer).digest('hex')}"`;
}

describe('documd serve — createServeServer loopback contract', () => {
  let rootDir: string;
  let outsideDir: string;
  let server: ServeServer;
  let notesPath: string;
  let nestedPath: string;
  let unicodePath: string;
  let imagePath: string;
  let outsidePath: string;

  const ORIGINAL_NOTES = Buffer.from('# Notes\n\n初始内容 line one\n', 'utf8');
  const NESTED_CONTENT = Buffer.from('nested page\n', 'utf8');
  const UNICODE_CONTENT = Buffer.from('# 中文标题\n\n空格 与 emoji 🎉\n', 'utf8');
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const OUTSIDE_CONTENT = Buffer.from('must never be touched\n', 'utf8');

  before(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'documd-serve-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'documd-serve-outside-'));
    fs.mkdirSync(path.join(rootDir, 'sub'));
    notesPath = path.join(rootDir, 'notes.md');
    nestedPath = path.join(rootDir, 'sub', 'nested.md');
    unicodePath = path.join(rootDir, '中文 文档.md');
    imagePath = path.join(rootDir, 'image.png');
    outsidePath = path.join(outsideDir, 'outside.md');
    fs.writeFileSync(notesPath, ORIGINAL_NOTES);
    fs.writeFileSync(nestedPath, NESTED_CONTENT);
    fs.writeFileSync(unicodePath, UNICODE_CONTENT);
    fs.writeFileSync(imagePath, PNG_BYTES);
    fs.writeFileSync(outsidePath, OUTSIDE_CONTENT);

    // Fixed token for wrong-token URLs; a 1 MiB ceiling keeps the 413 cases fast.
    server = await createServeServer(rootDir, { port: 0, token: 'fixed-test-token', maxBodyMb: 1 });
  });

  after(async () => {
    await server?.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  describe('server shape and binding', () => {
    it('exposes origin, token namespace, port and a urlFor helper', () => {
      assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(server.basePath, '/__documd/fixed-test-token');
      assert.equal(server.token, 'fixed-test-token');
      assert.ok(Number.isInteger(server.port) && server.port > 0);
      assert.equal(
        server.urlFor(path.join('sub', 'nested.md')),
        `${server.origin}${server.basePath}/sub/nested.md`,
      );
    });

    it('generates a 36-hex-char random token when none is supplied', async () => {
      const random = await createServeServer(rootDir, { port: 0 });
      try {
        assert.match(random.token, /^[0-9a-f]{36}$/);
        assert.equal(random.basePath, `/__documd/${random.token}`);
      } finally {
        await random.close();
      }
    });
  });

  describe('GET/HEAD read contract', () => {
    it('serves Markdown as text/plain with no-store, no-referrer and a sha256 ETag', async () => {
      const response = await send(docUrl(server, 'notes.md'));
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.ok(response.headers['last-modified'], 'a Last-Modified validator is present');
      assert.deepEqual(response.body, ORIGINAL_NOTES);
      assert.equal(response.headers.etag, sha256Etag(ORIGINAL_NOTES));
    });

    it('answers 304 without a body when If-None-Match matches the current ETag', async () => {
      const etag = sha256Etag(ORIGINAL_NOTES);
      const response = await send(docUrl(server, 'notes.md'), {
        headers: { 'if-none-match': etag },
      });
      assert.equal(response.status, 304);
      assert.equal(response.body.length, 0);
      assert.equal(response.headers.etag, etag);
    });

    it('serves the full body when If-None-Match is stale', async () => {
      const response = await send(docUrl(server, 'notes.md'), {
        headers: { 'if-none-match': '"stale-etag"' },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, ORIGINAL_NOTES);
    });

    it('HEAD returns headers and content-length but no body', async () => {
      const response = await send(docUrl(server, 'notes.md'), { method: 'HEAD' });
      assert.equal(response.status, 200);
      assert.equal(response.body.length, 0);
      if (IS_FIBJS) {
        // fibjs's compat layer forces Content-Length: 0 on every HEAD
        // response regardless of the JS-set header; pin that behaviour
        // explicitly instead of asserting the Node contract.
        assert.equal(response.headers['content-length'], '0');
      } else {
        assert.equal(Number(response.headers['content-length']), ORIGINAL_NOTES.length);
      }
      assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(response.headers.etag, sha256Etag(ORIGINAL_NOTES));
    });

    it('keeps the original MIME table for non-text assets', async () => {
      const response = await send(docUrl(server, 'image.png'));
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'image/png');
      assert.deepEqual(response.body, PNG_BYTES);
    });

    it('round-trips a path containing Chinese characters and a space', async () => {
      const response = await send(docUrl(server, '中文 文档.md'));
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, UNICODE_CONTENT);
    });

    it('serves files from nested directories', async () => {
      const response = await send(docUrl(server, 'sub/nested.md'));
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, NESTED_CONTENT);
    });

    it('returns 404 for a directory, a missing file, and a wrong token namespace', async () => {
      const directory = await send(docUrl(server, 'sub'));
      assert.equal(directory.status, 404);

      const missing = await send(docUrl(server, 'no-such-file.md'));
      assert.equal(missing.status, 404);

      const wrongToken = await send(
        `${server.origin}/__documd/wrong-token/notes.md`,
      );
      assert.equal(wrongToken.status, 404);
    });

    it('decodes percent-encoded dots and then reports a normal missing-file 404', async () => {
      // Proves decodeURIComponent runs before the filesystem lookup: an encoded
      // dot in a non-existent name is a plain ENOENT, not a routing error.
      const response = await send(docUrl(server, 'missing%2emd'));
      assert.equal(response.status, 404);
    });
  });

  describe('PUT write-back contract', () => {
    it('writes the body verbatim, answers 204 with the new ETag and leaves no temp file', async () => {
      const target = path.join(rootDir, 'put-ok.md');
      fs.writeFileSync(target, 'before\n');
      const replacement = Buffer.from('# 新内容\n\r\n第二行 CRLF 保真传\n', 'utf8');

      const response = await send(docUrl(server, 'put-ok.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: replacement,
      });

      assert.equal(response.status, 204);
      assert.equal(response.body.length, 0);
      assert.equal(response.headers.etag, sha256Etag(replacement));
      assert.deepEqual(fs.readFileSync(target), replacement);
      for (const name of [...fs.readdirSync(rootDir), ...fs.readdirSync(path.join(rootDir, 'sub'))]) {
        assert.ok(!name.endsWith('.tmp'), `no atomic-write temp file may remain: ${name}`);
      }
    });

    it('accepts a PUT without a Content-Type header', async () => {
      const target = path.join(rootDir, 'put-no-ct.md');
      fs.writeFileSync(target, 'before\n');
      const response = await send(docUrl(server, 'put-no-ct.md'), {
        method: 'PUT',
        body: Buffer.from('no content type\n'),
      });
      assert.equal(response.status, 204);
      assert.equal(fs.readFileSync(target, 'utf8'), 'no content type\n');
    });

    it('honours a matching If-Match and rejects a stale one with 412 without touching disk', async () => {
      const target = path.join(rootDir, 'put-precondition.md');
      const initial = Buffer.from('version one\n', 'utf8');
      fs.writeFileSync(target, initial);
      const initialEtag = sha256Etag(initial);

      const ok = await send(docUrl(server, 'put-precondition.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'if-match': initialEtag },
        body: Buffer.from('version two\n'),
      });
      assert.equal(ok.status, 204);
      assert.equal(fs.readFileSync(target, 'utf8'), 'version two\n');

      // The disk moved on; replaying the old ETag must fail and preserve bytes.
      const stale = await send(docUrl(server, 'put-precondition.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'if-match': initialEtag },
        body: Buffer.from('version three that must not land\n'),
      });
      assert.equal(stale.status, 412);
      assert.equal(stale.headers.etag, sha256Etag(Buffer.from('version two\n')));
      assert.equal(fs.readFileSync(target, 'utf8'), 'version two\n');
    });

    it('treats If-Match: * as matching any existing revision', async () => {
      const target = path.join(rootDir, 'put-star.md');
      fs.writeFileSync(target, 'old\n');
      const response = await send(docUrl(server, 'put-star.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'if-match': '*' },
        body: Buffer.from('star matched\n'),
      });
      assert.equal(response.status, 204);
      assert.equal(fs.readFileSync(target, 'utf8'), 'star matched\n');
    });

    it('never creates files: PUT to a missing path is 404', async () => {
      const response = await send(docUrl(server, 'brand-new.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('should not exist\n'),
      });
      assert.equal(response.status, 404);
      assert.ok(!fs.existsSync(path.join(rootDir, 'brand-new.md')));
    });

    it('checks target existence before content type or body limits', async () => {
      // Pins the frozen guard order: a missing target is a 404 even when the
      // same request would otherwise fail with 415/413.
      const badType = await send(docUrl(server, 'also-missing.md'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}'),
      });
      assert.equal(badType.status, 404);

      const overLimit = await send(docUrl(server, 'still-missing.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) },
        body: 'x',
      });
      assert.equal(overLimit.status, 404);
      assert.ok(!fs.existsSync(path.join(rootDir, 'still-missing.md')));
    });

    it('rejects a non-text Content-Type with 415 and keeps the file intact', async () => {
      const target = path.join(rootDir, 'put-json.md');
      fs.writeFileSync(target, 'keep me\n');
      const response = await send(docUrl(server, 'put-json.md'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"a":1}'),
      });
      assert.equal(response.status, 415);
      assert.equal(fs.readFileSync(target, 'utf8'), 'keep me\n');
    });

    // fibjs-only skip: its http client rewrites a declared Content-Length to
    // the number of bytes actually written, so the "declare 2 MiB, send one
    // byte" shape cannot be constructed there (probe v18, 2026-11). The
    // pre-flight 413 branch stays fully covered under Node.
    (IS_FIBJS ? it.skip : it)('rejects an incomplete over-limit Content-Length with 413 after the idle fallback', async () => {
      const target = path.join(rootDir, 'put-large-cl.md');
      fs.writeFileSync(target, 'small\n');
      const response = await send(docUrl(server, 'put-large-cl.md'), {
        method: 'PUT',
        // Declares 2 MiB against a 1 MiB ceiling while sending one byte.
        headers: { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) },
        body: 'x',
      });
      assert.equal(response.status, 413);
      assert.equal(fs.readFileSync(target, 'utf8'), 'small\n');
    });

    it('returns a readable 413 for a complete over-limit Content-Length body', async () => {
      const target = path.join(rootDir, 'put-large-body.md');
      fs.writeFileSync(target, 'small\n');
      const response = await send(docUrl(server, 'put-large-body.md'), {
        method: 'PUT',
        headers: {
          'content-type': 'text/plain',
          'content-length': String(64 * 1024 * 1024 + 1),
        },
        body: Buffer.alloc(64 * 1024 * 1024 + 1, 0x62),
      });
      assert.equal(response.status, 413);
      assert.equal(response.body.toString('utf8'), 'Request body too large');
      assert.equal(fs.readFileSync(target, 'utf8'), 'small\n');
    });

    // fibjs-only skip: the compat layer answers every Transfer-Encoding:
    // chunked request with a framework-level 400 whose response never settles
    // on the client (probe v18 case-5), a framework defect no JS can route
    // around. Chunked mid-stream capping stays fully covered under Node.
    (IS_FIBJS ? it.skip : it)('caps a chunked body mid-stream and never writes the overflow', async () => {
      const target = path.join(rootDir, 'put-chunked.md');
      fs.writeFileSync(target, 'small\n');

      // Real Transfer-Encoding: chunked stream (a buffered body would make the
      // client add Content-Length and exercise the pre-flight 413 path instead).
      const streamed = new Promise<{ status?: number; reset: boolean }>((resolve) => {
        const u = new URL(docUrl(server, 'put-chunked.md'));
        const request = http.request(
          {
            method: 'PUT',
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
          },
          (response) => {
            response.resume();
            response.on('end', () => resolve({ status: response.statusCode, reset: false }));
          },
        );
        request.on('error', (error) =>
          resolve({ status: undefined, reset: (error as { code?: string }).code === 'ECONNRESET' }),
        );
        for (let i = 0; i < 2048; i += 1) request.write(Buffer.alloc(1024, 0x62));
        request.end();
      });
      const outcome = await streamed;

      // The server stops reading and destroys an over-limit chunked request:
      // either the 413 response flushed first or the socket was reset mid-stream.
      assert.ok(
        outcome.status === 413 || outcome.reset,
        `expected 413 or connection reset, got status=${outcome.status} reset=${outcome.reset}`,
      );
      assert.equal(fs.readFileSync(target, 'utf8'), 'small\n');
      assert.ok(
        fs.readdirSync(rootDir).every((name) => !name.endsWith('.tmp')),
        'a failed streamed write must not leave a temp file behind',
      );
    });

    it('round-trips a UTF-8 write through a Chinese, space-containing path', async () => {
      const replacement = Buffer.from('# 改后的中文标题\n\n第二行 🚀\n', 'utf8');
      const response = await send(docUrl(server, '中文 文档.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: replacement,
      });
      assert.equal(response.status, 204);
      assert.deepEqual(fs.readFileSync(unicodePath), replacement);
    });
  });

  describe('method and routing guards', () => {
    it('answers OPTIONS with 204 and the allow header', async () => {
      const response = await send(docUrl(server, 'notes.md'), { method: 'OPTIONS' });
      assert.equal(response.status, 204);
      assert.equal(response.headers.allow, 'GET, HEAD, PUT, OPTIONS');
    });

    it('rejects other methods with 405 and the allow header', async () => {
      for (const method of ['POST', 'DELETE', 'PATCH']) {
        const response = await send(docUrl(server, 'notes.md'), { method });
        assert.equal(response.status, 405, `${method} must be refused`);
        assert.equal(response.headers.allow, 'GET, HEAD, PUT, OPTIONS');
      }
      assert.deepEqual(fs.readFileSync(notesPath), ORIGINAL_NOTES);
    });

    it('refuses every non-loopback or wrong-port Host header before any filesystem access', async () => {
      // 1. A foreign hostname (the DNS-rebinding shape).
      const foreignHost = await send(docUrl(server, 'notes.md'), {
        headers: { host: 'evil.example' },
      });
      assert.equal(foreignHost.status, 403);

      // 2. A loopback name but the wrong port.
      const wrongPort = await send(docUrl(server, 'notes.md'), {
        headers: { host: `127.0.0.1:${server.port + 1}` },
      });
      assert.equal(wrongPort.status, 403);

      // 3. A loopback name with no port: the explicit listening port is required.
      //    (A wholly absent Host header cannot be sent by node:http, which always
      //    synthesises one. The raw-socket manual matrix covers that branch:
      //    an HTTP/1.0 request without Host reaches the handler's 403; an
      //    HTTP/1.1 request without Host is refused earlier by Node's parser
      //    with 400 — both are non-200.)
      const missingPort = await send(docUrl(server, 'notes.md'), {
        headers: { host: '127.0.0.1' },
      });
      assert.equal(missingPort.status, 403);

      // All refusals happen before the read: the file is untouched and valid.
      assert.deepEqual(fs.readFileSync(notesPath), ORIGINAL_NOTES);
    });

    it('blocks percent-encoded path traversal at the root boundary (403)', async () => {
      // WHATWG URL keeps %2f encoded, so the raw segment reaches the server,
      // which decodes it and then confines the target with isWithin.
      const encoded = await send(docUrl(server, 'notes.md'), {
        rawPath: `${server.basePath}/..%2f..%2f..%2f${path.basename(outsidePath)}`,
      });
      assert.equal(encoded.status, 403);
      assert.deepEqual(fs.readFileSync(outsidePath), OUTSIDE_CONTENT);
    });

    it('neutralises a literal /../ segment via URL normalisation (never 200)', async () => {
      // The client request target keeps the literal dots; the server's URL
      // parser collapses them, which removes the token segment, so the request
      // falls at the namespace check (404) rather than escaping the root.
      const literal = await send(docUrl(server, 'notes.md'), {
        rawPath: `${server.basePath}/../../../../${path.basename(outsidePath)}`,
      });
      assert.notEqual(literal.status, 200);
      assert.deepEqual(fs.readFileSync(outsidePath), OUTSIDE_CONTENT);
    });
  });
});
