import http from 'node:http';
import { after, before, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe — delete before merge.
// Goal: decide whether the hang is tied to Connection: close responses and
// whether the 'response' event fires at all for each shape. Every case has a
// hard 3 s timeout so a hang surfaces as a logged HANG instead of a 60-min stall.

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
          console.log(`PROBE ${label}: ERROR ${String(error && error.code ? error.code : error)}`);
          resolve();
        }
      });
  });
}

describe('fibjs no-body / close connection probe', () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      // Let the framework take its native HEAD path (force close, header only).
      res.writeHead(200, { 'content-length': '12' }).end();
      return;
    }
    if (req.url === '/close-413') {
      res.writeHead(413, { connection: 'close', 'content-type': 'text/plain' }).end('too large');
      res.on('finish', () => req.destroy());
      return;
    }
    if (req.url === '/close-200') {
      res.writeHead(200, { connection: 'close', 'content-type': 'text/plain' }).end('bye');
      return;
    }
    if (req.url === '/ka-304') {
      res.writeHead(304, { etag: '"x"' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('hello-body');
  });

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function port(): number {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  function request(
    method: string,
    urlPath: string,
    settleStyle: 'short' | 'end-event',
  ): Promise<{ status: number; gotResponseEvent: boolean }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { method, hostname: '127.0.0.1', port: port(), path: urlPath },
        (res) => {
          if (settleStyle === 'short') {
            res.resume();
            resolve({ status: res.statusCode ?? 0, gotResponseEvent: true });
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, gotResponseEvent: true }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('keep-alive 200 with body, end-event style (control)', () =>
    timed('ka-200-end', () => request('GET', '/ka-200', 'end-event')));

  it('keep-alive 304, short-circuit style', () =>
    timed('ka-304-short', () => request('GET', '/ka-304', 'short')));

  it('HEAD native path, short-circuit style', () =>
    timed('head-short', () => request('HEAD', '/ka-200', 'short')));

  it('HEAD native path, end-event style', () =>
    timed('head-end', () => request('HEAD', '/ka-200', 'end-event')));

  it('Connection: close 200 with body, end-event style', () =>
    timed('close-200-end', () => request('GET', '/close-200', 'end-event')));

  it('Connection: close 200 with body, short-circuit style', () =>
    timed('close-200-short', () => request('GET', '/close-200', 'short')));

  it('Connection: close 413 with body + destroy, end-event style', () =>
    timed('close-413-end', () => request('GET', '/close-413', 'end-event')));

  it('Connection: close 413 with body + destroy, short-circuit style', () =>
    timed('close-413-short', () => request('GET', '/close-413', 'short')));
});
