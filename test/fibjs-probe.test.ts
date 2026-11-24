import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createServeServer } from '../scripts/documd.js';

// TEMPORARY fibjs compatibility probe v9 — delete before merge.
// The chunked mid-stream 413 case is the confirmed hang point. Instrument
// every request/response socket event to see which fire under fibjs and
// which never do. Hard 8s cap so the process always exits with a verdict.

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

describe('fibjs probe v9: chunked mid-stream 413 event trace', () => {
  let rootDir = '';
  let server: Awaited<ReturnType<typeof createServeServer>> | null = null;

  before(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fibjs-probe-'));
    fs.writeFileSync(path.join(rootDir, 'put-chunked.md'), 'small\n');
    server = await createServeServer(rootDir, { port: 0, token: 'fixed-test-token', maxBodyMb: 1 });
    log('runtime', JSON.stringify(process.versions));
  });
  after(async () => {
    log('after-hook enter');
    await server?.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('streams 2 MiB chunked and traces every event', async () => {
    const u = new URL(`${server!.origin}${server!.basePath}/put-chunked.md`);
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        log('HARD-TIMEOUT no settlement');
        resolve({ settled: false });
      }, 8000);

      const request = http.request(
        {
          method: 'PUT',
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
        },
        (response) => {
          log('response-event', `status=${response.statusCode}`);
          response.on('data', () => {});
          response.on('end', () => {
            log('response-end');
            clearTimeout(timer);
            resolve({ settled: true, via: 'response-end', status: response.statusCode });
          });
          response.on('close', () => log('response-close'));
          response.on('error', (error) => log('response-error', String(error)));
        },
      );
      request.on('error', (error) => {
        log('request-error', String((error as Error).message));
        clearTimeout(timer);
        resolve({ settled: true, via: 'request-error', code: (error as { code?: string }).code });
      });
      request.on('close', () => log('request-close'));
      request.on('finish', () => log('request-finish'));
      request.on('socket', (socket) => {
        log('request-socket');
        socket.on('close', (hadError) => log('socket-close', `hadError=${hadError}`));
        socket.on('error', (error) => log('socket-error', String(error)));
        socket.on('end', () => log('socket-end'));
      });

      for (let i = 0; i < 2048; i += 1) request.write(Buffer.alloc(1024, 0x62));
      log('all-writes-issued');
      request.end();
      log('request-end-called');
    });
    log('outcome', JSON.stringify(outcome));
  });
});
