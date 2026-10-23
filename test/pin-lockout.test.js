/**
 * PIN brute-force lockout tests
 * Failed X-Pin and share-PIN guesses share the login lockout.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-lockout-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.DUMBDROP_PIN = '123456';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'http://localhost:3000/';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, initialize } = require('../src/app');
const { clearLoginAttempts, isLockedOut } = require('../src/utils/security');

let server;

function lockedLocally() {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].some((ip) => isLockedOut(ip));
}

before(async () => {
  await initialize();
  await fs.promises.writeFile(path.join(uploadDir, 'secret.txt'), 'secret');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  clearLoginAttempts();
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.promises.rm(uploadDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearLoginAttempts();
});

function request(method, requestPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: requestPath,
      method,
      headers,
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
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('X-Pin lockout', () => {
  it('does not count requests that present no credential', async () => {
    for (let i = 0; i < 8; i += 1) {
      const response = await request('GET', '/api/files');
      assert.strictEqual(response.status, 401);
    }
    assert.strictEqual(lockedLocally(), false);
    const guessed = await request('GET', '/api/files', { headers: { 'X-Pin': '000000' } });
    assert.strictEqual(guessed.status, 401);
  });

  it('locks out after repeated wrong X-Pin guesses', async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await request('GET', '/api/files', { headers: { 'X-Pin': '000000' } });
      assert.strictEqual(response.status, 401, `attempt ${i + 1}`);
    }
    assert.strictEqual(lockedLocally(), true);
    const blocked = await request('GET', '/api/files', { headers: { 'X-Pin': '123456' } });
    assert.strictEqual(blocked.status, 429);
  });

  it('resets the lockout after a successful X-Pin', async () => {
    const wrong = await request('GET', '/api/files', { headers: { 'X-Pin': '000000' } });
    assert.strictEqual(wrong.status, 401);

    const ok = await request('GET', '/api/files', { headers: { 'X-Pin': '123456' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(lockedLocally(), false);

    for (let i = 0; i < 4; i += 1) {
      const response = await request('POST', '/api/upload/init', {
        headers: { 'X-Pin': '111111', 'Content-Type': 'application/json' },
        body: { filename: 'x.txt', fileSize: 1 },
      });
      assert.strictEqual(response.status, 401);
    }
    assert.strictEqual(lockedLocally(), false);
  });
});

describe('Share PIN lockout', () => {
  it('locks out wrong guesses on POST /api/shares/:token/auth', async () => {
    const created = await request('POST', '/api/files/share', {
      headers: { 'Content-Type': 'application/json', 'X-Pin': '123456' },
      body: { path: 'secret.txt', authRequired: true },
    });
    assert.strictEqual(created.status, 201);
    clearLoginAttempts();

    const authPath = `/api/shares/${created.data.token}/auth`;
    for (let i = 0; i < 5; i += 1) {
      const response = await request('POST', authPath, {
        headers: { 'Content-Type': 'application/json' },
        body: { pin: '000000' },
      });
      assert.strictEqual(response.status, 401, `share attempt ${i + 1}`);
    }
    assert.strictEqual(lockedLocally(), true);
    const blocked = await request('POST', authPath, {
      headers: { 'Content-Type': 'application/json' },
      body: { pin: '123456' },
    });
    assert.strictEqual(blocked.status, 429);
  });
});
