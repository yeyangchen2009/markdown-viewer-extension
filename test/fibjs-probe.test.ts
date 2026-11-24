import http from 'node:http';
import { after, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe v12 — delete before merge.
// v11 found two independent defects: (1) every chunked request gets a
// framework 400; (2) a normal Content-Length upload answered 200 server-side
// never produced a client response event at all. v12 isolates (2) with a
// fresh server per case (no connection-pool history) and varies the
// Connection header, body size, and listens on the response socket directly.

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

interface EchoOptions {
  connection: 'close' | 'keep-alive' | 'default';
  size: number;
}

function runOne(opts: EchoOptions): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const result: Record<string, unknown> = { settled: false };
    let done = false;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        log('server-end', `bytes=${body.length}`);
        const headers: Record<string, string> = { 'content-type': 'text/plain' };
        if (opts.connection === 'close') headers.connection = 'close';
        if (opts.connection === 'keep-alive') headers.connection = 'keep-alive';
        response.writeHead(200, headers).end(`got ${body.length}`);
      });
      request.on('error', (error) => log('server-request-error', String(error)));
    });
    server.on('clientError', (error) => log('server-clientError', String(error)));
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
      const headers: Record<string, string> = {
        'content-type': 'text/plain',
        'content-length': String(opts.size),
      };
      if (opts.connection !== 'default') headers.connection = opts.connection;
      const request = http.request(
        {
          method: 'PUT',
          hostname: '127.0.0.1',
          port,
          path: '/upload',
          headers,
        },
        (response) => {
          log('client-response', `status=${response.statusCode} cl=${response.headers['content-length']} conn=${response.headers.connection}`);
          response.socket?.on('end', () => log('socket-end'));
          response.socket?.on('close', (hadError) => log('socket-close', `hadError=${hadError}`));
          response.resume();
          response.on('end', () => finish({ settled: true, via: 'response-end', status: response.statusCode }));
          response.on('error', (error) => log('client-response-error', String(error)));
        },
      );
      request.on('error', (error) =>
        finish({ settled: true, via: 'request-error', code: (error as { code?: string }).code }),
      );
      request.write(Buffer.alloc(opts.size, 0x62));
      request.end();
    });
  });
}

describe('fibjs probe v12: isolated Content-Length upload responses', () => {
  after(() => log('after-hook enter'));

  const cases: Array<[string, EchoOptions]> = [
    ['1KiB-connection-close', { connection: 'close', size: 1024 }],
    ['1KiB-keep-alive', { connection: 'keep-alive', size: 1024 }],
    ['1KiB-default', { connection: 'default', size: 1024 }],
    ['2MiB-connection-close', { connection: 'close', size: 2 * 1024 * 1024 }],
    ['2MiB-keep-alive', { connection: 'keep-alive', size: 2 * 1024 * 1024 }],
  ];

  for (const [name, opts] of cases) {
    it(name, async () => {
      log(`case-start ${name}`);
      const outcome = await runOne(opts);
      log(`case-outcome ${name}`, JSON.stringify(outcome));
    });
  }
});
