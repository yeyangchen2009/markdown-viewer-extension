import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createServeServer } from '../scripts/documd.js';

// TEMPORARY fibjs compatibility probe v6 — delete before merge.
// v4 proved the same 19 requests do NOT hang inside ONE it. v6 splits them
// into 19 sibling its (real suite shape) and makes the HEAD it fail the same
// content-length assertion. Goal: decide whether it-boundary/resource
// accumulation or the failing HEAD it is the hang trigger.

function isNoBodyResponse(method: string | undefined, status: number): boolean {
  return (
    (method ?? 'GET').toUpperCase() === 'HEAD' ||
    status === 204 ||
    status === 304 ||
    (status >= 100 && status < 200)
  );
}

describe('fibjs probe v6: 19 sibling its mirroring the real suite', () => {
  let rootDir = '';
  let server: Awaited<ReturnType<typeof createServeServer>> | null = null;
  const NOTES = Buffer.from('# Notes\n\n初始内容 line one\n', 'utf8');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

  function send(relativePath: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const target = new URL(`${server!.origin}${server!.basePath}/${relativePath}`);
      const request = http.request(
        {
          method: options.method ?? 'GET',
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          headers: options.headers,
        },
        (response) => {
          if (isNoBodyResponse(options.method, response.statusCode ?? 0)) {
            response.resume();
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.alloc(0) });
            return;
          }
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      if (options.body !== undefined) request.write(options.body);
      request.end();
    });
  }

  before(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fibjs-probe-'));
    fs.writeFileSync(path.join(rootDir, 'notes.md'), NOTES);
    fs.mkdirSync(path.join(rootDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'nested', 'page.md'), 'nested page\n');
    fs.writeFileSync(path.join(rootDir, 'image.png'), PNG);
    fs.writeFileSync(path.join(rootDir, '中文 文档.md'), 'unicode\n');
    server = await createServeServer(rootDir, { port: 0, token: 'fixed-test-token', maxBodyMb: 1 });
  });
  after(async () => {
    console.log('PROBE v6: after-hook entered');
    await server?.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const etag = () => `"${crypto.createHash('sha256').update(NOTES).digest('hex')}"`;
  const mark = (label: string) => async () => {
    console.log(`PROBE start ${label}`);
    return label;
  };

  it('01 GET 200', async () => {
    assert.equal((await send(enc('notes.md'))).status, 200);
  });
  it('02 GET 304', async () => {
    assert.equal((await send(enc('notes.md'), { headers: { 'if-none-match': etag() } })).status, 304);
  });
  it('03 HEAD with failing cl assertion (mirrors real suite failure)', async () => {
    const r = await send(enc('notes.md'), { method: 'HEAD' });
    assert.equal(r.status, 200);
    // Same assertion as cli-serve.test.ts:196 — fails under fibjs (cl "0").
    assert.equal(Number(r.headers['content-length']), NOTES.length);
  });
  it('04 GET png', async () => {
    assert.equal((await send(enc('image.png'))).status, 200);
  });
  it('05 GET unicode', async () => {
    assert.equal((await send(enc('中文 文档.md'))).status, 200);
  });
  it('06 GET nested', async () => {
    assert.equal((await send(enc('nested/page.md'))).status, 200);
  });
  it('07 GET directory 404', async () => {
    assert.equal((await send(enc('nested'))).status, 404);
  });
  it('08 GET missing 404', async () => {
    assert.equal((await send(enc('nope.md'))).status, 404);
  });
  it('09 GET bad token 404', async () => {
    const u = new URL(`${server!.origin}/__documd/wrong-token/notes.md`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 404);
  });
  it('10 PUT 204', async () => {
    fs.writeFileSync(path.join(rootDir, 'put-ok.md'), 'old\n');
    assert.equal((await send(enc('put-ok.md'), { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'new\n' })).status, 204);
  });
  it('11 PUT no content-type 204', async () => {
    fs.writeFileSync(path.join(rootDir, 'put-no-ct.md'), 'old\n');
    assert.equal((await send(enc('put-no-ct.md'), { method: 'PUT', body: 'new\n' })).status, 204);
  });
  it('12 PUT stale If-Match 412', async () => {
    fs.writeFileSync(path.join(rootDir, 'put-stale.md'), 'keep\n');
    assert.equal((await send(enc('put-stale.md'), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-match': '"stale"' },
      body: 'x\n',
    })).status, 412);
  });
  it('13 PUT If-Match star 204', async () => {
    fs.writeFileSync(path.join(rootDir, 'put-star.md'), 'old\n');
    assert.equal((await send(enc('put-star.md'), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-match': '*' },
      body: 'new\n',
    })).status, 204);
  });
  it('14 PUT missing 404', async () => {
    assert.equal((await send(enc('missing-put.md'), { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 404);
  });
  it('15 PUT json missing 404', async () => {
    assert.equal((await send(enc('also-missing.md'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  });
  it('16 PUT big CL missing 404', async () => {
    assert.equal((await send(enc('still-missing.md'), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) },
      body: 'x',
    })).status, 404);
  });
  it('17 PUT non-text 415', async () => {
    fs.writeFileSync(path.join(rootDir, 'put-json.md'), 'keep me\n');
    assert.equal((await send(enc('put-json.md'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"a":1}'),
    })).status, 415);
  });
  it('18 PUT big CL existing — HANG POINT', async () => {
    fs.writeFileSync(path.join(rootDir, 'put-large-cl.md'), 'small\n');
    console.log('PROBE 18 before-send');
    const r = await send(enc('put-large-cl.md'), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) },
      body: 'x',
    });
    console.log(`PROBE 18 after-send status=${r.status}`);
    assert.equal(r.status, 413);
  });
  it('19 GET recovery', async () => {
    assert.equal((await send(enc('notes.md'))).body.length, NOTES.length);
  });

  void mark;
});
