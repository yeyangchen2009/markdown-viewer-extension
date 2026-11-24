import http from 'node:http';
import { after, before, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe v2 — delete before merge.
// Reproduces the two real-suite hang shapes exactly:
//   1. shared server, connection-reuse sequence 200 -> 304 -> 200 -> HEAD
//   2. declared Content-Length larger than the bytes actually sent, server
//      refusing without consuming the body (the CL pre-flight 413 case)

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
          console.log(`PROBE ${label}: ERROR ${String(error && error.code ? error.code : error)}`);
          resolve();
        }
      });
  });
}

describe('fibjs probe v2: real-suite shapes', () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/bad-cl') {
      // Mirror rejectEarly: refuse before touching the request body.
      res.writeHead(413, { connection: 'close', 'content-type': 'text/plain' }).end('too large');
      res.on('finish', () => req.destroy());
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': '12', etag: '"x"' }).end();
      return;
    }
    if (req.url === '/not-modified') {
      res.writeHead(304, { etag: '"x"' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', etag: '"x"' }).end('hello-body');
  });

  let port = 0;
  before(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        port = address && typeof address === 'object' ? address.port : 0;
        resolve();
      }),
    );
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function shortRequest(method: string, urlPath: string, headers?: Record<string, string>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.request({ method, hostname: '127.0.0.1', port, path: urlPath, headers }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, cl: res.headers['content-length'] });
      });
      req.on('error', reject);
      if (method !== 'GET' && method !== 'HEAD') req.write('x');
      req.end();
    });
  }

  function endEventRequest(method: string, urlPath: string, headers?: Record<string, string>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.request({ method, hostname: '127.0.0.1', port, path: urlPath, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks).length }));
        res.on('error', reject);
      });
      req.on('error', reject);
      if (method !== 'GET' && method !== 'HEAD') req.write('x');
      req.end();
    });
  }

  it('sequence 200 -> 304 -> 200 -> HEAD on one shared server (all short)', () =>
    timed('seq-head-short', async () => {
      const r1 = await shortRequest('GET', '/doc');
      const r2 = await shortRequest('GET', '/not-modified');
      const r3 = await shortRequest('GET', '/doc');
      const r4 = await shortRequest('HEAD', '/doc');
      return [r1, r2, r3, r4];
    }));

  it('HEAD alone again (short, control)', () => timed('head-short', () => shortRequest('HEAD', '/doc')));

  it('under-declared-body 413, short style', () =>
    timed('bad-cl-413-short', () =>
      shortRequest('PUT', '/bad-cl', { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) })));

  it('under-declared-body 413, end-event style', () =>
    timed('bad-cl-413-end', () =>
      endEventRequest('PUT', '/bad-cl', { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) })));

  it('normal keep-alive 200 after the 413 storm (pool recovery)', () =>
    timed('recovery-200', () => shortRequest('GET', '/doc')));
});
