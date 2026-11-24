import http from 'node:http';
import { after, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe v13 — delete before merge.
// v12: minimal-server responses never emit client 'end' and report cl=0, while
// the real documd server (v4) settles fine. Leading hypothesis: fibjs's
// node:http layer only frames a response body correctly when the JS handler
// sets Content-Length explicitly. Matrix: explicit CL x Connection header x
// body type. Fresh server per case, 5 s hard cap, forced teardown.

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

interface Case {
  name: string;
  explicitCl: boolean;
  connection: 'close' | 'keep-alive' | 'none';
  bodyKind: 'string' | 'buffer';
}

function runOne(c: Case): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const result: Record<string, unknown> = { settled: false };
    let done = false;
    const bodyText = 'got-body-payload';
    const body = c.bodyKind === 'buffer' ? Buffer.from(bodyText) : bodyText;
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
        if (c.explicitCl) headers['content-length'] = String(Buffer.byteLength(bodyText));
        if (c.connection !== 'none') headers.connection = c.connection;
        response.writeHead(200, headers).end(body);
      });
      request.on('error', (error) => log(`${c.name}-server-req-error`, String(error)));
    });
    server.on('clientError', (error) => log(`${c.name}-clientError`, String(error)));
    const finish = (patch: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      Object.assign(result, patch);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve(result));
    };
    const timer = setTimeout(() => finish({ settled: false, timeout: true }), 5000);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const reqHeaders: Record<string, string> = { 'content-type': 'text/plain', 'content-length': '0' };
      if (c.connection !== 'none') reqHeaders.connection = c.connection;
      const request = http.request(
        { method: 'GET', hostname: '127.0.0.1', port, path: '/doc', headers: reqHeaders },
        (response) => {
          log(`${c.name}-response`, `status=${response.statusCode} cl=${response.headers['content-length']} conn=${response.headers.connection} te=${response.headers['transfer-encoding']}`);
          response.socket?.on('close', (hadError) => log(`${c.name}-socket-close`, `hadError=${hadError}`));
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            finish({ settled: true, via: 'response-end', status: response.statusCode, bytes: Buffer.concat(chunks).length }),
          );
          response.on('error', (error) => log(`${c.name}-response-error`, String(error)));
        },
      );
      request.on('error', (error) =>
        finish({ settled: true, via: 'request-error', code: (error as { code?: string }).code }),
      );
      request.end();
    });
  });
}

describe('fibjs probe v13: response framing matrix', () => {
  after(() => log('after-hook enter'));

  const cases: Case[] = [
    { name: 'A-noCL-close-string', explicitCl: false, connection: 'close', bodyKind: 'string' },
    { name: 'B-CL-close-string', explicitCl: true, connection: 'close', bodyKind: 'string' },
    { name: 'C-noCL-keepalive-string', explicitCl: false, connection: 'keep-alive', bodyKind: 'string' },
    { name: 'D-CL-keepalive-string', explicitCl: true, connection: 'keep-alive', bodyKind: 'string' },
    { name: 'E-noCL-none-buffer', explicitCl: false, connection: 'none', bodyKind: 'buffer' },
    { name: 'F-CL-none-buffer', explicitCl: true, connection: 'none', bodyKind: 'buffer' },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      log(`case-start ${c.name}`);
      const outcome = await runOne(c);
      log(`case-outcome ${c.name}`, JSON.stringify(outcome));
    });
  }
});
