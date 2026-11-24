import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe v18 — delete before merge.
// v17 found the compat-layer request is a native fibjs HttpRequest/Message
// with one-shot body accessors (arrayBuffer/blob/readAll) that work inside the
// async handler window, unlike data/end events which poison the response.
// Verify end to end: body fidelity, over-limit 413, UTF-8 bytes, chunked
// behaviour, and the shape of request.body on a body-bearing request.

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

const LIMIT = 1024 * 1024;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function requestOnce(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: Buffer; chunked?: boolean },
): Promise<{ settled: boolean; status?: number; headers?: http.IncomingHttpHeaders; data?: Buffer; code?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ settled: false }), 5000);
    const req = http.request(
      {
        method: options.method ?? 'PUT',
        hostname: '127.0.0.1',
        port,
        path: options.path ?? '/doc',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          clearTimeout(timer);
          resolve({ settled: true, status: response.statusCode, headers: response.headers, data: Buffer.concat(chunks) });
        });
        response.on('error', (error) => log('client-response-error', String(error)));
      },
    );
    req.on('error', (error) => {
      clearTimeout(timer);
      resolve({ settled: true, code: (error as { code?: string }).code });
    });
    if (options.chunked && options.body) {
      for (let i = 0; i < options.body.length; i += 512) req.write(options.body.subarray(i, i + 512));
      req.end();
    } else if (options.body) {
      req.end(options.body);
    } else {
      req.end();
    }
  });
}

describe('fibjs probe v18: native body accessor end to end', () => {
  let port = 0;
  let server: http.Server;

  before(async () => {
    server = http.createServer(async (request, response) => {
      const report = (patch: Record<string, unknown>) => {
        log('server-report', JSON.stringify(patch));
      };
      try {
        if (request.url === '/body-shape') {
          report({ bodyType: typeof (request as { body?: unknown }).body, bodyValue: String((request as { body?: unknown }).body) });
        }
        // Native one-shot accessor, no data/end event listeners.
        const data = Buffer.from(await (request as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer());
        if (request.url === '/oversize') {
          if (data.length > LIMIT) {
            response.writeHead(413, { connection: 'close', 'x-probe': 'rejected' }).end('too large');
            return;
          }
        }
        const digest = crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
        response
          .writeHead(200, { 'content-type': 'text/plain', 'x-probe-length': String(data.length), 'x-probe-hash': digest })
          .end(Buffer.from(`got ${data.length} ${digest}`));
      } catch (error) {
        log('server-throw', String(error));
        response.writeHead(500, { connection: 'close' }).end(`probe error: ${String(error)}`);
      }
    });
    port = await listen(server);
    log('runtime', JSON.stringify({ fibjs: process.versions.fibjs || null, node: process.versions.node }));
  });

  after(async () => {
    await new Promise((r) => server.close(() => r()));
  });

  it('1: small Content-Length PUT round-trips with headers intact', async () => {
    const body = Buffer.from('hello fibjs compat\n', 'utf8');
    const r = await requestOnce(port, { headers: { 'content-type': 'text/plain' }, body });
    log('case-1', JSON.stringify({ ...r, headers: r.headers && { 'x-probe-length': r.headers['x-probe-length'], 'x-probe-hash': r.headers['x-probe-hash'] }, data: r.data?.toString() }));
  });

  it('2: over-limit body is rejected with a real 413 carrying custom headers', async () => {
    const body = Buffer.alloc(LIMIT + 1024, 0x61);
    const r = await requestOnce(port, { headers: { 'content-type': 'text/plain' }, body });
    log('case-2', JSON.stringify({ settled: r.settled, status: r.status, xProbe: r.headers?.['x-probe'], code: r.code }));
  });

  it('3: UTF-8 body bytes survive intact', async () => {
    const body = Buffer.from('# 中文标题\n\r\n第二行 CRLF\n', 'utf8');
    const expectHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
    const r = await requestOnce(port, { headers: { 'content-type': 'text/plain' }, body });
    log('case-3', JSON.stringify({ hashHeader: r.headers?.['x-probe-hash'], expectHash, match: r.headers?.['x-probe-hash'] === expectHash }));
  });

  it('4: chunked PUT behaviour under fibjs', async () => {
    const body = Buffer.alloc(4096, 0x63);
    const r = await requestOnce(port, {
      headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
      body,
      chunked: true,
    });
    log('case-4', JSON.stringify({ settled: r.settled, status: r.status, code: r.code, data: r.data?.toString().slice(0, 40) }));
  });

  it('5: request.body shape on a body-bearing request', async () => {
    const r = await requestOnce(port, {
      path: '/body-shape',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('shape-check'),
    });
    log('case-5', JSON.stringify({ settled: r.settled, status: r.status }));
  });
});
