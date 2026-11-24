import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createServeServer } from '../scripts/documd.js';

// TEMPORARY fibjs compatibility probe v14 — delete before merge.
// v13 ruled out explicit Content-Length: every minimal-server response arrives
// with headers defaulted (cl=0, conn/te undefined) and no body 'end'. Yet the
// real documd server in v4 settled serial GETs fine. Remaining variables:
// sync vs async request handler, bare GET vs header-carrying GET, shared long
// lived server vs per-case server. Print the FULL header set this time.

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function bareGet(port: number, withHeaders: boolean, reqPath = '/doc'): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const result: Record<string, unknown> = { settled: false };
    const timer = setTimeout(() => resolve(result), 5000);
    const request = http.request(
      {
        method: 'GET',
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        headers: withHeaders ? { 'content-type': 'text/plain', 'content-length': '0' } : undefined,
      },
      (response) => {
        log('bareGet-response', `status=${response.statusCode} headers=${JSON.stringify(response.headers)}`);
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          clearTimeout(timer);
          resolve({ settled: true, status: response.statusCode, bytes: Buffer.concat(chunks).length });
        });
        response.on('error', (error) => log('bareGet-response-error', String(error)));
      },
    );
    request.on('error', (error) => {
      clearTimeout(timer);
      resolve({ settled: true, via: 'request-error', code: (error as { code?: string }).code });
    });
    request.end();
  });
}

describe('fibjs probe v14: handler shape and request shape quadrant', () => {
  let syncPort = 0;
  let asyncPort = 0;
  let realServer: Awaited<ReturnType<typeof createServeServer>> | null = null;
  let rootDir = '';
  const syncServer = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('sync-payload');
    });
  });
  const asyncServer = http.createServer(async (request, response) => {
    await new Promise((r) => {
      request.resume();
      request.on('end', r);
    });
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('async-payload');
  });

  before(async () => {
    syncPort = await listen(syncServer);
    asyncPort = await listen(asyncServer);
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fibjs-v14-'));
    fs.writeFileSync(path.join(rootDir, 'notes.md'), 'real-server-payload\n');
    realServer = await createServeServer(rootDir, { port: 0, token: 'fixed-test-token' });
    log('runtime', JSON.stringify({ fibjs: process.versions.fibjs || null, node: process.versions.node }));
  });

  after(async () => {
    log('after-hook enter');
    await new Promise((r) => syncServer.close(() => r()));
    await new Promise((r) => asyncServer.close(() => r()));
    await realServer?.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('1: bare GET on shared sync server', async () => {
    log('case-start 1');
    log('case-outcome 1', JSON.stringify(await bareGet(syncPort, false)));
  });

  it('2: bare GET on shared async server', async () => {
    log('case-start 2');
    log('case-outcome 2', JSON.stringify(await bareGet(asyncPort, false)));
  });

  it('3: bare GET on the real createServeServer', async () => {
    log('case-start 3');
    const u = new URL(`${realServer!.origin}${realServer!.basePath}/notes.md`);
    const outcome = await bareGet(Number(u.port), false, u.pathname);
    log('case-outcome 3', JSON.stringify({ ...outcome, path: u.pathname }));
  });

  it('4: header-carrying GET on shared sync server', async () => {
    log('case-start 4');
    log('case-outcome 4', JSON.stringify(await bareGet(syncPort, true)));
  });
});
