/**
 * Storage quota tests
 * In-progress uploads count against MAX_STORAGE_MB until cancel or completion.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-quota-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.MAX_STORAGE_MB = '1';
process.env.NODE_ENV = 'test';
process.env.ALLOW_INSECURE_NO_PIN = 'true';
process.env.BASE_URL = 'http://localhost:3000/';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, initialize } = require('../src/app');

let server;

before(async () => {
  await initialize();
  await fs.promises.writeFile(path.join(uploadDir, 'existing.bin'), Buffer.alloc(200 * 1024));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.promises.rm(uploadDir, { recursive: true, force: true });
});

function request(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: requestPath,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = raw;
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const openSessions = [];

async function cancelOpenSessions() {
  for (const uploadId of openSessions) {
    await request('POST', `/api/upload/cancel/${uploadId}`);
  }
  openSessions.length = 0;
}

function remember(response) {
  if (response.status === 200 && response.data.uploadId) openSessions.push(response.data.uploadId);
  return response;
}

describe('MAX_STORAGE_MB', () => {
  it('rejects an init that would exceed the quota and releases the reservation on cancel', async () => {
    const first = remember(await request('POST', '/api/upload/init', {
      filename: 'one.bin',
      fileSize: 500 * 1024,
    }));
    assert.strictEqual(first.status, 200);

    const second = await request('POST', '/api/upload/init', {
      filename: 'two.bin',
      fileSize: 500 * 1024,
    });
    assert.strictEqual(second.status, 507);
    assert.strictEqual(second.data.error, 'Storage quota exceeded');

    const cancelled = await request('POST', `/api/upload/cancel/${first.data.uploadId}`);
    assert.strictEqual(cancelled.status, 200);

    const third = remember(await request('POST', '/api/upload/init', {
      filename: 'three.bin',
      fileSize: 500 * 1024,
    }));
    assert.strictEqual(third.status, 200);
  });

  it('frees quota when a stored file is deleted', async () => {
    await cancelOpenSessions();
    const blocked = await request('POST', '/api/upload/init', {
      filename: 'blocked.bin',
      fileSize: 900 * 1024,
    });
    assert.strictEqual(blocked.status, 507);

    const removed = await request('DELETE', '/api/files/existing.bin');
    assert.strictEqual(removed.status, 200);

    const allowed = remember(await request('POST', '/api/upload/init', {
      filename: 'after-delete.bin',
      fileSize: 400 * 1024,
    }));
    assert.strictEqual(allowed.status, 200);
  });

  it('does not let two concurrent inits oversubscribe the quota', async () => {
    await cancelOpenSessions();
    const [left, right] = await Promise.all([
      request('POST', '/api/upload/init', { filename: 'race-a.bin', fileSize: 600 * 1024 }),
      request('POST', '/api/upload/init', { filename: 'race-b.bin', fileSize: 600 * 1024 }),
    ]);
    const statuses = [left.status, right.status].sort();
    assert.deepStrictEqual(statuses, [200, 507]);
  });
});
