import http from 'node:http';
import { after, before, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe v15 — delete before merge.
// v14 proved the real documd response path settles under fibjs while minimal
// servers get their headers replaced (cl=0) and never end. Factor hunt with
// bare GETs on shared long-lived servers, varying one thing at a time:
// sync vs async handler, Buffer vs string body, header set shape, explicit CL.

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

const PAYLOAD = 'probe-body-payload';
const SINGLE_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };
const RICH_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-type': 'text/plain; charset=utf-8',
  etag: '"deadbeef"',
  'last-modified': 'Tue, 24 Nov 2026 04:00:00 GMT',
};

function makeServer(kind: string): http.Server {
  return http.createServer((request, response) => {
    const respond = () => {
      if (kind === 'T1') {
        response.writeHead(200, SINGLE_HEADERS).end(Buffer.from(PAYLOAD));
      } else if (kind === 'T2') {
        response.writeHead(200, SINGLE_HEADERS).end(PAYLOAD);
      } else if (kind === 'T3') {
        response.writeHead(200, RICH_HEADERS).end(Buffer.from(PAYLOAD));
      } else if (kind === 'T4') {
        response.writeHead(200, SINGLE_HEADERS).end(Buffer.from(PAYLOAD));
      } else if (kind === 'T5') {
        response.writeHead(200, { ...SINGLE_HEADERS, 'content-length': Buffer.byteLength(PAYLOAD) }).end(Buffer.from(PAYLOAD));
      }
    };
    if (kind === 'T4') {
      respond(); // sync handler, answer immediately on the request event
    } else {
      // async handler shape: hop a microtask/timer like awaiting fs.readFile
      setTimeout(respond, 5);
    }
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function bareGet(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const result: Record<string, unknown> = { settled: false };
    const timer = setTimeout(() => resolve(result), 5000);
    const request = http.request(
      { method: 'GET', hostname: '127.0.0.1', port, path: '/doc' },
      (response) => {
        log('response', `status=${response.statusCode} cl=${response.headers['content-length']} ct=${response.headers['content-type']} keys=${Object.keys(response.headers).join(',')}`);
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          clearTimeout(timer);
          resolve({ settled: true, status: response.statusCode, bytes: Buffer.concat(chunks).length });
        });
        response.on('error', (error) => log('response-error', String(error)));
      },
    );
    request.on('error', (error) => {
      clearTimeout(timer);
      resolve({ settled: true, via: 'request-error', code: (error as { code?: string }).code });
    });
    request.end();
  });
}

describe('fibjs probe v15: response factor hunt', () => {
  const servers: http.Server[] = [];
  const ports: Record<string, number> = {};
  before(async () => {
    for (const kind of ['T1', 'T2', 'T3', 'T4', 'T5']) {
      const server = makeServer(kind);
      servers.push(server);
      ports[kind] = await listen(server);
    }
    log('runtime', JSON.stringify({ fibjs: process.versions.fibjs || null, node: process.versions.node }));
  });
  after(async () => {
    log('after-hook enter');
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
  });

  const cases = [
    ['T1', 'async + Buffer + single headers'],
    ['T2', 'async + string + single headers'],
    ['T3', 'async + Buffer + rich headers'],
    ['T4', 'sync + Buffer + single headers'],
    ['T5', 'async + Buffer + explicit content-length'],
  ] as const;

  for (const [kind, desc] of cases) {
    it(`${kind}: ${desc}`, async () => {
      log(`case-start ${kind}`);
      log(`case-outcome ${kind}`, JSON.stringify(await bareGet(ports[kind])));
    });
  }
});
