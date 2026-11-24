import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createServeServer } from '../scripts/documd.js';

// TEMPORARY fibjs compatibility probe v4 — delete before merge.
// Single-it STRICTLY SERIAL replay of the real cli-serve suite's request
// history up to the hanging 413 case. Every step has a 3s hard timeout and
// prints PROBE lines, so the exact blocking step is visible in CI logs.
// If this serial replay does not hang while the real concurrent suite does,
// the difference is node:test scheduling/concurrency, not connection history.

function timed<T>(label: string, work: () => Promise<T>): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.log(`PROBE ${label}: HANG`);
        resolve();
      }
    }, 3000);
    work()
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          console.log(`PROBE ${label}: OK ${JSON.stringify(value)}`);
          resolve();
        }
      })
      .catch((error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          console.log(`PROBE ${label}: ERROR ${String(error && error.message ? error.message : error)}`);
          resolve();
        }
      });
  });
}

function isNoBodyResponse(method: string | undefined, status: number): boolean {
  return (
    (method ?? 'GET').toUpperCase() === 'HEAD' ||
    status === 204 ||
    status === 304 ||
    (status >= 100 && status < 200)
  );
}

describe('fibjs probe v4: serial replay of full suite history', () => {
  let rootDir = '';
  let server: Awaited<ReturnType<typeof createServeServer>> | null = null;
  const NOTES = Buffer.from('# Notes\n\n初始内容 line one\n', 'utf8');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
    await server?.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('replays every request before the 413 case, serially', async () => {
    const etag = `"${crypto.createHash('sha256').update(NOTES).digest('hex')}"`;
    const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

    await timed('01-GET-200', async () => (await send(enc('notes.md'))).status);
    await timed('02-GET-304', async () => (await send(enc('notes.md'), { headers: { 'if-none-match': etag } })).status);
    await timed('03-HEAD', async () => {
      const r = await send(enc('notes.md'), { method: 'HEAD' });
      return { status: r.status, cl: r.headers['content-length'] };
    });
    await timed('04-GET-png', async () => (await send(enc('image.png'))).status);
    await timed('05-GET-unicode', async () => (await send(enc('中文 文档.md'))).status);
    await timed('06-GET-nested', async () => (await send(enc('nested/page.md'))).status);
    await timed('07-GET-directory-404', async () => (await send(enc('nested'))).status);
    await timed('08-GET-missing-404', async () => (await send(enc('nope.md'))).status);
    await timed('09-GET-bad-token-404', async () => {
      const u = new URL(`${server!.origin}/__documd/wrong-token/notes.md`);
      return new Promise<number>((resolve, reject) => {
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
    });
    await timed('10-PUT-204', async () => {
      fs.writeFileSync(path.join(rootDir, 'put-ok.md'), 'old\n');
      return (await send(enc('put-ok.md'), { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'new\n' })).status;
    });
    await timed('11-PUT-no-ct-204', async () => {
      fs.writeFileSync(path.join(rootDir, 'put-no-ct.md'), 'old\n');
      return (await send(enc('put-no-ct.md'), { method: 'PUT', body: 'new\n' })).status;
    });
    await timed('12-PUT-412', async () => {
      fs.writeFileSync(path.join(rootDir, 'put-stale.md'), 'keep\n');
      return (await send(enc('put-stale.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'if-match': '"stale"' },
        body: 'x\n',
      })).status;
    });
    await timed('13-PUT-ifmatch-star-204', async () => {
      fs.writeFileSync(path.join(rootDir, 'put-star.md'), 'old\n');
      return (await send(enc('put-star.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'if-match': '*' },
        body: 'new\n',
      })).status;
    });
    await timed('14-PUT-missing-404', async () =>
      (await send(enc('missing-put.md'), { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x' })).status);
    await timed('15-PUT-json-missing-404', async () =>
      (await send(enc('also-missing.md'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    await timed('16-PUT-bigcl-missing-404', async () =>
      (await send(enc('still-missing.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) },
        body: 'x',
      })).status);
    await timed('17-PUT-415', async () => {
      fs.writeFileSync(path.join(rootDir, 'put-json.md'), 'keep me\n');
      return (await send(enc('put-json.md'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"a":1}'),
      })).status;
    });
    await timed('18-PUT-bigcl-413-HANGPOINT', async () => {
      fs.writeFileSync(path.join(rootDir, 'put-large-cl.md'), 'small\n');
      const r = await send(enc('put-large-cl.md'), {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) },
        body: 'x',
      });
      return { status: r.status, disk: fs.readFileSync(path.join(rootDir, 'put-large-cl.md'), 'utf8') };
    });
    await timed('19-GET-recovery', async () => (await send(enc('notes.md'))).body.length);
  });
});
