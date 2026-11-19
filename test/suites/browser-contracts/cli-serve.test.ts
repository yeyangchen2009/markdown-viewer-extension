import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createServeServer } from '../../../scripts/documd.js';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface ServeHandle {
  origin: string;
  basePath: string;
  port: number;
  close: () => Promise<void>;
}

function sendRequest(
  port: number,
  pathname: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let incoming: http.IncomingMessage | null = null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        incoming = res;
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', (error) => {
      // A 413/415 refusal ends with an explicit socket reset; once the full
      // response was delivered the late RST is transport noise, not a failure.
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET' && incoming) return;
      reject(error);
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

// Stream a body without Content-Length (chunked) and stop pumping once the
// limit is crossed; the server must answer 413 and tear the socket down.
// Used to prove the streaming 413 path, not just the Content-Length pre-check.
function streamOversized(port: number, pathname: string, totalBytes: number, limitBytes: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, response?: RawResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(() => finish(new Error('streamOversized: server did not answer 413 in time')), 15_000);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'PUT',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          finish(null, { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', (error) => finish(error));
      },
    );
    req.on('error', (error) => {
      // A reset after the 413 response was delivered is the expected socket end.
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') finish(error);
    });
    const block = Buffer.alloc(4096, 'a');
    let written = 0;
    const pump = () => {
      if (settled) return;
      while (written < totalBytes) {
        // Past the limit: stop sending and wait for the server's 413.
        if (written > limitBytes) return;
        if (!req.write(block)) {
          written += block.length;
          req.once('drain', pump);
          return;
        }
        written += block.length;
      }
      req.end();
    };
    pump();
  });
}

// Declare an oversized Content-Length and send just one byte so the headers
// are flushed: the server must refuse on the headers alone before the rest of
// the body is ever written. The request is never ended on purpose.
function declaredOversizedRequest(port: number, pathname: string, declaredLength: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('declaredOversizedRequest: no 413 response in time'));
      }
    }, 15_000);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'content-length': String(declaredLength) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            req.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
          }
        });
      },
    );
    req.on('error', (error) => {
      // The expected socket teardown after the 413 response; anything else fails.
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET' && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    // A single write flushes the headers without finishing the request.
    req.write(Buffer.from('x'));
  });
}

// Raw socket probe for hosts the http client would normalise away, e.g. an
// empty Host header (a rebinding attacker may simply omit it).
function rawRequest(port: number, raw: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => {
      const headerEnd = data.indexOf('\r\n\r\n');
      const head = headerEnd === -1 ? data : data.slice(0, headerEnd);
      const body = headerEnd === -1 ? '' : data.slice(headerEnd + 4);
      const lines = head.split('\r\n');
      const statusLine = lines[0]?.match(/HTTP\/1\.\d (\d+)/);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(':');
        if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }
      resolve({ status: statusLine ? Number(statusLine[1]) : 0, headers, body });
    });
    socket.on('error', reject);
    socket.end(raw);
  });
}

function sha256Hex(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

describe('documd serve: loopback editing server contract', () => {
  let tempRoot: string;
  let outsideRoot: string;
  let server: ServeHandle;
  let smallLimitServer: ServeHandle;
  const token = 'testtoken0123456789abcdef';
  const notesRelative = 'notes.md';
  const nestedRelative = path.join('sub', 'nested.md').replace(/\\/g, '/');
  const unicodeRelative = encodeURI('中文 文档.md');
  const initialNotes = '# Title\n\nLine with CRLF\r\n';
  const nestedContent = 'nested body\n';

  before(async () => {
    tempRoot = syncFs.mkdtempSync(path.join(os.tmpdir(), 'documd-serve-'));
    outsideRoot = syncFs.mkdtempSync(path.join(os.tmpdir(), 'documd-serve-out-'));
    await fs.mkdir(path.join(tempRoot, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, notesRelative), initialNotes, 'utf8');
    await fs.writeFile(path.join(tempRoot, 'sub', 'nested.md'), nestedContent, 'utf8');
    await fs.writeFile(path.join(tempRoot, '中文 文档.md'), 'unicode body\n', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'asset.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(outsideRoot, 'secret.md'), 'outside root\n', 'utf8');

    server = await createServeServer(tempRoot, { port: 0, token });
    smallLimitServer = await createServeServer(tempRoot, { port: 0, token, maxBodyMb: 1 });
  });

  after(async () => {
    await server?.close();
    await smallLimitServer?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  const fileUrl = (relative: string) => `${server.basePath}/${relative}`;

  it('serves markdown as text/plain with no-store, no-referrer and a quoted sha256 ETag', async () => {
    const res = await sendRequest(server.port, fileUrl(notesRelative));
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers.etag, `"${sha256Hex(Buffer.from(initialNotes, 'utf8'))}"`);
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(initialNotes, 'utf8')));
    assert.ok(res.headers['last-modified']);
    assert.deepEqual(res.body.toString('utf8'), initialNotes);
  });

  it('keeps the generic MIME table for non-text assets', async () => {
    const res = await sendRequest(server.port, fileUrl('asset.png'));
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
  });

  it('answers 304 without a body when If-None-Match carries the current ETag or *', async () => {
    const etag = `"${sha256Hex(Buffer.from(initialNotes, 'utf8'))}"`;
    for (const ifNoneMatch of [etag, '*']) {
      const res = await sendRequest(server.port, fileUrl(notesRelative), { headers: { 'if-none-match': ifNoneMatch } });
      assert.equal(res.status, 304);
      assert.equal(res.body.length, 0);
      assert.equal(res.headers.etag, etag);
    }
    const stale = await sendRequest(server.port, fileUrl(notesRelative), {
      headers: { 'if-none-match': '"deadbeef"' },
    });
    assert.equal(stale.status, 200);
  });

  it('answers HEAD with full headers and no body', async () => {
    const res = await sendRequest(server.port, fileUrl(notesRelative), { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(initialNotes, 'utf8')));
    assert.ok(res.headers.etag);
  });

  it('PUT writes the bytes back verbatim, returns 204 and the new ETag, and leaves no tmp file', async () => {
    const replacement = '# Saved\r\n\nUTF-8 内容 and trailing newline\n';
    const res = await sendRequest(server.port, fileUrl(notesRelative), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
      body: replacement,
    });
    assert.equal(res.status, 204);
    assert.equal(res.body.length, 0);
    assert.equal(res.headers.etag, `"${sha256Hex(Buffer.from(replacement, 'utf8'))}"`);
    assert.equal(res.headers['cache-control'], 'no-store');
    const onDisk = await fs.readFile(path.join(tempRoot, notesRelative), 'utf8');
    assert.deepEqual(onDisk, replacement, 'disk content must match the PUT body byte for byte');
    const entries = await fs.readdir(tempRoot, { recursive: true });
    assert.ok(entries.every((entry) => !String(entry).endsWith('.tmp')), 'no tmp file may survive a save');
  });

  it('refuses a stale If-Match with 412 and keeps the disk file untouched', async () => {
    const target = path.join(tempRoot, 'sub', 'nested.md');
    const before = await fs.readFile(target, 'utf8');
    const res = await sendRequest(server.port, fileUrl(nestedRelative), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-match': '"0000000000000000"' },
      body: 'clobber attempt\n',
    });
    assert.equal(res.status, 412);
    assert.equal(res.headers.etag, `"${sha256Hex(Buffer.from(nestedContent, 'utf8'))}"`);
    assert.deepEqual(await fs.readFile(target, 'utf8'), before);
  });

  it('accepts If-Match * and the current ETag, then serves the new ETag on the next GET', async () => {
    const first = await sendRequest(server.port, fileUrl(nestedRelative), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-match': '*' },
      body: 'star write\n',
    });
    assert.equal(first.status, 204);
    const currentEtag = first.headers.etag!;
    const second = await sendRequest(server.port, fileUrl(nestedRelative), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-match': currentEtag },
      body: 'etag write\n',
    });
    assert.equal(second.status, 204);
    const readBack = await sendRequest(server.port, fileUrl(nestedRelative));
    assert.equal(readBack.status, 200);
    assert.equal(readBack.headers.etag, second.headers.etag);
    assert.deepEqual(readBack.body.toString('utf8'), 'etag write\n');
  });

  it('rejects an oversized declared body with 413 without buffering it', async () => {
    const target = path.join(tempRoot, notesRelative);
    const before = await fs.readFile(target);
    const res = await declaredOversizedRequest(
      smallLimitServer.port,
      `${smallLimitServer.basePath}/${notesRelative}`,
      2 * 1024 * 1024,
    );
    assert.equal(res.status, 413);
    assert.deepEqual(await fs.readFile(target), before);
  });

  it('rejects a chunked stream that crosses the body limit with 413', async () => {
    const res = await streamOversized(
      smallLimitServer.port,
      `${smallLimitServer.basePath}/${notesRelative}`,
      2 * 1024 * 1024,
      1024 * 1024,
    );
    assert.equal(res.status, 413);
  });

  it('rejects non-text Content-Type with 415', async () => {
    const res = await sendRequest(server.port, fileUrl('asset.png'), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'binary',
    });
    assert.equal(res.status, 415);
  });

  it('allows a PUT with no Content-Type (curl-style clients)', async () => {
    const res = await sendRequest(server.port, fileUrl(nestedRelative), {
      method: 'PUT',
      body: 'untyped write\n',
    });
    assert.equal(res.status, 204);
    assert.deepEqual(await fs.readFile(path.join(tempRoot, 'sub', 'nested.md'), 'utf8'), 'untyped write\n');
  });

  it('answers 405 with an Allow header for unsupported methods and 204 for OPTIONS', async () => {
    const deleted = await sendRequest(server.port, fileUrl(notesRelative), { method: 'DELETE' });
    assert.equal(deleted.status, 405);
    assert.equal(deleted.headers.allow, 'GET, HEAD, PUT, OPTIONS');
    const options = await sendRequest(server.port, fileUrl(notesRelative), { method: 'OPTIONS' });
    assert.equal(options.status, 204);
  });

  it('rejects forged Host headers, including an empty one, before any token check', async () => {
    const foreignHost = await sendRequest(server.port, fileUrl(notesRelative), {
      headers: { host: 'evil.example' },
    });
    assert.equal(foreignHost.status, 403);
    const wrongPort = await sendRequest(server.port, fileUrl(notesRelative), {
      headers: { host: `127.0.0.1:${server.port + 1}` },
    });
    assert.equal(wrongPort.status, 403);
    const emptyHost = await rawRequest(
      server.port,
      `GET ${fileUrl(notesRelative)} HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(emptyHost.status, 403);
  });

  it('keeps root confinement: plain traversal 404s, encoded traversal 403s', async () => {
    const plain = await sendRequest(server.port, `${server.basePath}/../secret.md`);
    assert.equal(plain.status, 404);
    // One encoded hop resolves exactly to the sibling temp directory: if the
    // root-confinement check ever failed, this request would hit secret.md.
    const encoded = await sendRequest(
      server.port,
      `${server.basePath}/..%2f${path.basename(outsideRoot)}%2fsecret.md`,
    );
    assert.equal(encoded.status, 403);
    assert.deepEqual(
      await fs.readFile(path.join(outsideRoot, 'secret.md'), 'utf8'),
      'outside root\n',
      'traversal must never touch files outside the root',
    );
  });

  it('returns 404 for a wrong token, a missing file, a directory, and a PUT that would create a file', async () => {
    const wrongToken = await sendRequest(server.port, '/__documd/wrongtoken0000000000000/notes.md');
    assert.equal(wrongToken.status, 404);
    const missing = await sendRequest(server.port, fileUrl('does-not-exist.md'));
    assert.equal(missing.status, 404);
    const directory = await sendRequest(server.port, `${server.basePath}/sub`);
    assert.equal(directory.status, 404);
    const create = await sendRequest(server.port, fileUrl('brand-new.md'), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'no creation\n',
    });
    assert.equal(create.status, 404);
    assert.equal(syncFs.existsSync(path.join(tempRoot, 'brand-new.md')), false);
  });

  it('round-trips unicode and space paths through GET and PUT', async () => {
    const get = await sendRequest(server.port, fileUrl(unicodeRelative));
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.toString('utf8'), 'unicode body\n');
    const replacement = '中文内容 with spaces 保留\n';
    const put = await sendRequest(server.port, fileUrl(unicodeRelative), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: replacement,
    });
    assert.equal(put.status, 204);
    assert.deepEqual(await fs.readFile(path.join(tempRoot, '中文 文档.md'), 'utf8'), replacement);
  });

  it('attaches the security headers to error responses too', async () => {
    const missing = await sendRequest(server.port, '/__documd/wrongtoken0000000000000/notes.md');
    assert.equal(missing.headers['cache-control'], 'no-store');
    assert.equal(missing.headers['referrer-policy'], 'no-referrer');
  });
});
