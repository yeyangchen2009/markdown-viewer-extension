import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createServeServer } from '../scripts/documd.js';

// TEMPORARY fibjs compatibility probe v3 — delete before merge.
// Drives the REAL createServeServer with the two cases that hang in the
// full suite (HEAD, under-declared CL 413) plus a 304 control. The helper is
// copied verbatim from cli-serve.test.ts so semantics match exactly.

function timed(label: string, work: () => Promise<unknown>): Promise<void> {
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

describe('fibjs probe v3: real createServeServer', () => {
  let rootDir = '';
  let server: Awaited<ReturnType<typeof createServeServer>> | null = null;
  let notesUrl = '';
  const NOTES = Buffer.from('# Notes\n\n初始内容 line one\n', 'utf8');

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
    server = await createServeServer(rootDir, { port: 0, token: 'fixed-test-token', maxBodyMb: 1 });
    notesUrl = 'notes.md';
  });
  after(async () => {
    await server?.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('304 control (known good)', () =>
    timed('real-304', async () => {
      const etag = `"${crypto.createHash('sha256').update(NOTES).digest('hex')}"`;
      const r = await send(notesUrl, { headers: { 'if-none-match': etag } });
      return { status: r.status, etag: r.headers.etag };
    }));

  it('real HEAD case', () =>
    timed('real-head', async () => {
      const r = await send(notesUrl, { method: 'HEAD' });
      return { status: r.status, cl: r.headers['content-length'], etag: r.headers.etag };
    }));

  it('real under-declared CL 413', () =>
    timed('real-413', async () => {
      const target = 'put-large-cl.md';
      fs.writeFileSync(path.join(rootDir, target), 'small\n');
      const r = await send(target, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) },
        body: 'x',
      });
      return { status: r.status, disk: fs.readFileSync(path.join(rootDir, target), 'utf8') };
    }));

  it('ordinary GET after the hard cases (recovery)', () =>
    timed('real-recovery', async () => {
      const r = await send(notesUrl);
      return { status: r.status, bytes: r.body.length };
    }));
});
