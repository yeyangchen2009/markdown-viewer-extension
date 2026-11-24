import http from 'node:http';
import net from 'node:net';
import { after, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe v10 — delete before merge.
// v9 showed: rejecting mid-stream (even without request.destroy()) makes the
// fibjs server framework answer 400 and its client never settles. This probe
// compares rejection timings against a minimal http server, and separately
// checks whether node:net can send a dishonest Content-Length under fibjs.

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

const LIMIT = 1024 * 1024; // 1 MiB
const TOTAL = 2 * 1024 * 1024; // 2 MiB chunked upload

function startServer(kind: 'early' | 'after-end'): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      let size = 0;
      let tooLarge = false;
      let answered = false;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > LIMIT) tooLarge = true;
        if (tooLarge && kind === 'early' && !answered) {
          // Replicates current documd behaviour: answer as soon as the cap trips.
          answered = true;
          response.writeHead(413, { connection: 'close' }).end('too large');
        }
      });
      request.on('end', () => {
        if (answered) return;
        if (tooLarge) {
          response.writeHead(413, { connection: 'close' }).end('too large');
        } else {
          response.writeHead(200, { connection: 'close' }).end('ok');
        }
      });
      request.on('error', (error) => log(`${kind}-request-error`, String(error)));
    });
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

function chunkedPut(port: number): Promise<{ settled: boolean; via?: string; status?: number; code?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ settled: false }), 5000);
    const request = http.request(
      {
        method: 'PUT',
        hostname: '127.0.0.1',
        port,
        path: '/upload',
        headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
      },
      (response) => {
        log('response-event', `status=${response.statusCode}`);
        response.resume();
        response.on('end', () => {
          clearTimeout(timer);
          resolve({ settled: true, via: 'response-end', status: response.statusCode });
        });
        response.on('error', (error) => log('response-error', String(error)));
      },
    );
    request.on('error', (error) => {
      clearTimeout(timer);
      resolve({ settled: true, via: 'request-error', code: (error as { code?: string }).code });
    });
    for (let i = 0; i < TOTAL / 1024; i += 1) request.write(Buffer.alloc(1024, 0x62));
    request.end();
  });
}

describe('fibjs probe v10: rejection timing and raw net', () => {
  const servers: Array<() => Promise<void>> = [];
  after(async () => {
    log('after-hook enter');
    for (const close of servers) await close();
  });

  it('A: early 413 while the body is still streaming', async () => {
    const s = await startServer('early');
    servers.push(s.close);
    log('A-start');
    const outcome = await chunkedPut(s.port);
    log('A-outcome', JSON.stringify(outcome));
  });

  it('E: 413 only after the request body end event', async () => {
    const s = await startServer('after-end');
    servers.push(s.close);
    log('E-start');
    const outcome = await chunkedPut(s.port);
    log('E-outcome', JSON.stringify(outcome));
  });

  it('N: raw net socket can send a Content-Length larger than the real body', async () => {
    const s = await startServer('after-end');
    servers.push(s.close);
    log('N-start');
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ settled: false }), 5000);
      const socket = net.connect(s.port, '127.0.0.1', () => {
        log('N-connected');
        socket.write(
          [
            'PUT /upload HTTP/1.1',
            `Host: 127.0.0.1:${s.port}`,
            'Content-Type: text/plain',
            `Content-Length: ${TOTAL}`,
            'Connection: close',
            '',
            '',
          ].join('\r\n'),
        );
        socket.end(Buffer.from('x'));
      });
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString('latin1');
        log('N-raw-response', JSON.stringify(raw.split('\r\n')[0]));
        resolve({ settled: true, statusLine: raw.split('\r\n')[0] });
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        log('N-socket-error', String(error));
        resolve({ settled: true, error: String(error) });
      });
    });
    log('N-outcome', JSON.stringify(outcome));
  });
});
