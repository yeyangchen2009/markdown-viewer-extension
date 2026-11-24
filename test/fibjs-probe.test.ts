import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createServeServer } from '../scripts/documd.js';

// TEMPORARY fibjs compatibility probe v5 — delete before merge.
// Part 1: do sibling `it` blocks run concurrently under fibjs node:test?
// Part 2: does concurrent traffic on one shared server make the
// over-declared Content-Length PUT (the real suite's hang point) hang?

function isNoBodyResponse(method: string | undefined, status: number): boolean {
  return (
    (method ?? 'GET').toUpperCase() === 'HEAD' ||
    status === 204 ||
    status === 304 ||
    (status >= 100 && status < 200)
  );
}

describe('probe v5 part 1: node:test scheduling', () => {
  const order: string[] = [];
  it('block A (500ms)', async () => {
    order.push('A-start');
    await new Promise((resolve) => setTimeout(resolve, 500));
    order.push('A-end');
  });
  it('block B (200ms)', async () => {
    order.push('B-start');
    await new Promise((resolve) => setTimeout(resolve, 200));
    order.push('B-end');
  });
  it('block C reports order', () => {
    console.log(`PROBE schedule-order: ${order.join(',')}`);
  });
});

describe('probe v5 part 2: concurrent HTTP on shared server', () => {
  let rootDir = '';
  let server: Awaited<ReturnType<typeof createServeServer>> | null = null;

  function send(relativePath: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<{
    status: number;
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
            resolve({ status: response.statusCode ?? 0, body: Buffer.alloc(0) });
            return;
          }
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
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
    fs.writeFileSync(path.join(rootDir, 'notes.md'), '# Notes\n');
    fs.writeFileSync(path.join(rootDir, 'put-large-cl.md'), 'small\n');
    server = await createServeServer(rootDir, { port: 0, token: 'fixed-test-token', maxBodyMb: 1 });
  });
  after(async () => {
    await server?.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('sibling traffic: 8 rapid GETs', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => send(i % 2 ? 'notes.md' : 'put-large-cl.md')),
    );
    console.log(`PROBE concurrent-gets: ${results.map((r) => r.status).join(',')}`);
  });

  it('the big-CL PUT under concurrency', async () => {
    const startedAt = Date.now();
    const settled = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ hang: true, ms: Date.now() - startedAt }), 4000);
      send('put-large-cl.md', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) },
        body: 'x',
      })
        .then((r) => {
          clearTimeout(timer);
          resolve({ hang: false, status: r.status, disk: fs.readFileSync(path.join(rootDir, 'put-large-cl.md'), 'utf8') });
        })
        .catch((error) => {
          clearTimeout(timer);
          resolve({ hang: false, error: String(error && error.message ? error.message : error) });
        });
    });
    console.log(`PROBE bigcl-under-concurrency: ${JSON.stringify(settled)}`);
  });
});
