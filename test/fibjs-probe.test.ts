import http from 'node:http';
import { after, before, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe v11 — delete before merge.
// v10 proved the framework 400 is independent of JS response timing: even a
// server that only counts bytes and answers after 'end' gets a 400 on a 2 MiB
// chunked upload. Matrix probe: size x transfer encoding to locate the real
// trigger (chunked parsing, byte threshold, or write count).

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
      });
      request.on('end', () => {
        log('server-end', `bytes=${size}`);
        response.writeHead(200, { connection: 'close' }).end(`got ${size}`);
      });
      request.on('error', (error) => log('server-request-error', String(error)));
    });
    server.on('clientError', (error) => log('server-clientError', String(error)));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function upload(
  port: number,
  size: number,
  chunked: boolean,
  writes: number,
): Promise<{ settled: boolean; via?: string; status?: number; code?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ settled: false }), 5000);
    const payload = Buffer.alloc(size, 0x62);
    const headers: Record<string, string> = { 'content-type': 'text/plain' };
    if (chunked) headers['transfer-encoding'] = 'chunked';
    const request = http.request(
      { method: 'PUT', hostname: '127.0.0.1', port, path: '/upload', headers },
      (response) => {
        log('client-response', `status=${response.statusCode}`);
        response.resume();
        response.on('end', () => {
          clearTimeout(timer);
          resolve({ settled: true, via: 'response-end', status: response.statusCode });
        });
        response.on('error', (error) => log('client-response-error', String(error)));
      },
    );
    request.on('error', (error) => {
      clearTimeout(timer);
      resolve({ settled: true, via: 'request-error', code: (error as { code?: string }).code });
    });
    if (chunked) {
      const piece = Buffer.alloc(Math.floor(size / writes), 0x62);
      for (let i = 0; i < writes; i += 1) request.write(piece);
      const written = piece.length * writes;
      if (written < size) request.write(payload.subarray(written));
    } else {
      request.write(payload);
    }
    request.end();
  });
}

describe('fibjs probe v11: upload size and encoding matrix', () => {
  let port = 0;
  let closeServer: () => Promise<void>;
  before(async () => {
    const s = await startEchoServer();
    port = s.port;
    closeServer = s.close;
    log('runtime', JSON.stringify({ fibjs: process.versions.fibjs || null, node: process.versions.node }));
  });
  after(async () => {
    log('after-hook enter');
    await closeServer();
  });

  const cases: Array<[string, number, boolean, number]> = [
    ['1KiB-chunked-1write', 1024, true, 1],
    ['256KiB-chunked-256writes', 256 * 1024, true, 256],
    ['1MiB-chunked-1024writes', 1024 * 1024, true, 1024],
    ['2MiB-chunked-2048writes', 2 * 1024 * 1024, true, 2048],
    ['2MiB-cl-1write', 2 * 1024 * 1024, false, 1],
    ['2MiB-chunked-1write', 2 * 1024 * 1024, true, 1],
  ];

  for (const [name, size, chunked, writes] of cases) {
    it(name, async () => {
      log(`case-start ${name}`);
      const outcome = await upload(port, size, chunked, writes);
      log(`case-outcome ${name}`, JSON.stringify(outcome));
    });
  }
});
