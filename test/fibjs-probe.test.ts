import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe v16 — delete before merge.
// v15: a response written inside the handler's synchronous stack settles
// correctly (T4); anything deferred through setTimeout gets replaced by the
// framework default response (cl=0). Yet documd's `await fs.readFile` path
// works. Pin the boundary: microtask, request-event Promise, and native fs
// Promise as the deferral source, inside async vs plain handlers.

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

const PAYLOAD = Buffer.from('probe-body-payload');

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (c) => chunks.push(c));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function makeServer(kind: string, probeFile: string): http.Server {
  if (kind === 'U1') {
    // Plain handler, respond from a request 'end' event callback (v12 shape).
    return http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(PAYLOAD);
      });
    });
  }
  if (kind === 'U2') {
    // async handler awaiting a request-event Promise.
    return http.createServer(async (request, response) => {
      await new Promise((r) => {
        request.resume();
        request.on('end', r);
      });
      response.writeHead(200, { 'content-type': 'text/plain' }).end(PAYLOAD);
    });
  }
  if (kind === 'U3') {
    // async handler awaiting a native fs promise (documd GET shape).
    return http.createServer(async (request, response) => {
      request.resume();
      await fs.promises.stat(probeFile);
      response.writeHead(200, { 'content-type': 'text/plain' }).end(PAYLOAD);
    });
  }
  if (kind === 'U4') {
    // Full documd PUT shape: event-driven body read, then fs, then respond.
    return http.createServer(async (request, response) => {
      await readBody(request);
      await fs.promises.readFile(probeFile);
      response.writeHead(200, { 'content-type': 'text/plain' }).end(PAYLOAD);
    });
  }
  // U5: async handler, pure microtask hop, no timer, no event.
  return http.createServer(async (request, response) => {
    request.resume();
    await Promise.resolve();
    response.writeHead(200, { 'content-type': 'text/plain' }).end(PAYLOAD);
  });
}

function bareGet(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const result: Record<string, unknown> = { settled: false };
    const timer = setTimeout(() => resolve(result), 5000);
    const request = http.request(
      { method: 'GET', hostname: '127.0.0.1', port, path: '/doc' },
      (response) => {
        log('response', `status=${response.statusCode} cl=${response.headers['content-length']} ct=${response.headers['content-type']}`);
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

describe('fibjs probe v16: async boundary hunt', () => {
  const servers: http.Server[] = [];
  const ports: Record<string, number> = {};
  let probeFile = '';
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fibjs-v16-'));
    probeFile = path.join(dir, 'probe.txt');
    fs.writeFileSync(probeFile, 'x');
    for (const kind of ['U1', 'U2', 'U3', 'U4', 'U5']) {
      const server = makeServer(kind, probeFile);
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
    ['U1', 'plain handler + request-end event respond'],
    ['U2', 'async handler + request-event Promise'],
    ['U3', 'async handler + native fs.promises.stat'],
    ['U4', 'async handler + body event + fs.readFile (documd PUT shape)'],
    ['U5', 'async handler + pure microtask'],
  ] as const;

  for (const [kind, desc] of cases) {
    it(`${kind}: ${desc}`, async () => {
      log(`case-start ${kind}`);
      log(`case-outcome ${kind}`, JSON.stringify(await bareGet(ports[kind])));
    });
  }
});
