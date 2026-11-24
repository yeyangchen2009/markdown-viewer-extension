import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// TEMPORARY fibjs compatibility probe v17 — delete before merge.
// v16 proved awaiting request 'data'/'end' events inside an async handler
// poisons fibjs's response window. The node:http compat layer source is not
// in the OSS tree, so ask the runtime directly: enumerate the IncomingMessage
// and ServerResponse surface (own keys, prototype chain, candidate body
// accessors), try each candidate safely, and dump everything to a file the
// test process reads back.

function log(label: string, extra = '') {
  console.log(`PROBE ${label}${extra ? ' ' + extra : ''}`);
}

const dumpFile = path.join(os.tmpdir(), 'fibjs-v17-dump.json');

function safeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
  const t = typeof value;
  if (t === 'object') {
    try {
      return `${t}:${(value as object).constructor?.name || 'anonymous'}`;
    } catch {
      return `${t}:?`;
    }
  }
  return t;
}

function protoChain(obj: unknown): string[] {
  const out: string[] = [];
  let cur = obj;
  for (let i = 0; i < 6 && cur; i += 1) {
    cur = Object.getPrototypeOf(cur);
    if (!cur) break;
    out.push(`${i}:${cur.constructor?.name || 'anonymous'}[${Object.getOwnPropertyNames(cur).slice(0, 40).join(',')}]`);
  }
  return out;
}

describe('fibjs probe v17: runtime API enumeration', () => {
  let port = 0;
  let server: http.Server;
  const dump: Record<string, unknown> = { versions: process.versions };

  before(async () => {
    server = http.createServer(async (request, response) => {
      try {
        dump.requestOwnKeys = Object.getOwnPropertyNames(request);
        dump.requestProtoChain = protoChain(request);
        dump.responseOwnKeys = Object.getOwnPropertyNames(response);
        dump.responseProtoChain = protoChain(response);
        const candidates = [
          'body', 'rawBody', 'payload', 'message', 'req', 'request',
          'blob', 'arrayBuffer', 'text', 'json', 'read', 'readBody',
          'readable', 'socket', 'stream', 'contentLength', 'headers',
        ];
        const probe: Record<string, string> = {};
        for (const name of candidates) {
          try {
            const value = (request as Record<string, unknown>)[name];
            probe[`typeof.${name}`] = safeType(value);
          } catch (error) {
            probe[`typeof.${name}`] = `THROW ${String(error)}`;
          }
        }
        // Candidate invocation: only things that look like body accessors.
        for (const name of ['blob', 'arrayBuffer', 'text', 'json', 'readBody']) {
          try {
            const fn = (request as Record<string, unknown>)[name];
            if (typeof fn === 'function') {
              const value = await (fn as () => unknown).call(request);
              probe[`call.${name}`] = safeType(value);
            }
          } catch (error) {
            probe[`call.${name}`] = `THROW ${String(error && (error as Error).message)}`;
          }
        }
        if ('body' in request) {
          try {
            const body = (request as Record<string, unknown>).body;
            probe['body.inspect'] = safeType(body);
            if (body && typeof body === 'object') {
              probe['body.keys'] = Object.getOwnPropertyNames(body).slice(0, 30);
              const maybeBuffer = (body as { body?: unknown; data?: unknown }).body ?? (body as { data?: unknown }).data;
              if (maybeBuffer !== undefined) probe['body.body|data'] = safeType(maybeBuffer);
            }
          } catch (error) {
            probe['body.inspect'] = `THROW ${String(error)}`;
          }
        }
        dump.candidateProbe = probe;
        fs.writeFileSync(dumpFile, JSON.stringify(dump, null, 1));
        response.writeHead(200, { 'content-type': 'application/json' }).end('dumped');
      } catch (error) {
        dump.fatal = String(error);
        fs.writeFileSync(dumpFile, JSON.stringify(dump, null, 1));
        response.writeHead(500).end('probe failed');
      }
    });
    port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  });

  after(async () => {
    await new Promise((r) => server.close(() => r()));
  });

  it('dumps the node:http object surface from inside the runtime', async () => {
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ settled: false }), 5000);
      const request = http.request(
        { method: 'GET', hostname: '127.0.0.1', port, path: '/probe' },
        (response) => {
          response.resume();
          response.on('end', () => {
            clearTimeout(timer);
            resolve({ settled: true, status: response.statusCode });
          });
        },
      );
      request.on('error', (error) => {
        clearTimeout(timer);
        resolve({ settled: true, error: String(error) });
      });
      request.end();
    });
    log('client-outcome', JSON.stringify(outcome));
  });

  it('reads back the enumeration dump', () => {
    if (!fs.existsSync(dumpFile)) {
      log('dump MISSING');
      return;
    }
    const text = fs.readFileSync(dumpFile, 'utf8');
    const parsed = JSON.parse(text);
    log('dump-requestOwnKeys', JSON.stringify(parsed.requestOwnKeys));
    for (const line of parsed.requestProtoChain || []) log('dump-requestProto', line);
    log('dump-responseOwnKeys', JSON.stringify(parsed.responseOwnKeys));
    for (const line of parsed.responseProtoChain || []) log('dump-responseProto', line);
    log('dump-candidates', JSON.stringify(parsed.candidateProbe, null, 1));
    if (parsed.fatal) log('dump-fatal', parsed.fatal);
  });
});
