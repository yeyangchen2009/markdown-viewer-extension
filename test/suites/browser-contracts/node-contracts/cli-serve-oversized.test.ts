import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { createServeServer } from '../../../../scripts/documd.js';

it('returns a readable 413 for a complete over-limit Content-Length body', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'documd-serve-oversized-'));
  const target = path.join(rootDir, 'oversized.md');
  fs.writeFileSync(target, 'small\n');
  const server = await createServeServer(rootDir, { port: 0, maxBodyMb: 64 });

  try {
    const url = new URL(server.urlFor('oversized.md'));
    const payload = Buffer.alloc(64 * 1024 * 1024 + 1, 0x62);
    const response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const request = http.request(
        {
          method: 'PUT',
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: {
            'content-type': 'text/plain',
            'content-length': String(payload.length),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          incoming.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(payload);
    });

    assert.equal(response.status, 413);
    assert.equal(response.body.toString('utf8'), 'Request body too large');
    assert.equal(fs.readFileSync(target, 'utf8'), 'small\n');
  } finally {
    await server.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
