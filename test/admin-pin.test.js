/**
 * DUMBDROP_ADMIN_PIN tests.
 * With an admin PIN, DUMBDROP_PIN only uploads; file management needs admin.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-admin-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.DUMBDROP_PIN = '111111';
process.env.DUMBDROP_ADMIN_PIN = '999999';
process.env.NODE_ENV = 'test';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, initialize } = require('../src/app');
const { clearLoginAttempts, isLockedOut } = require('../src/utils/security');

const UPLOAD_PIN = '111111';
const ADMIN_PIN = '999999';
let server;

before(async () => {
  await initialize();
  await fs.promises.writeFile(path.join(uploadDir, 'report.txt'), 'report');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  clearLoginAttempts();
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.promises.rm(uploadDir, { recursive: true, force: true });
});

beforeEach(() => clearLoginAttempts());

function request(method, requestPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: requestPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              ...headers,
            }
          : headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = text;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = text;
          }
          resolve({ status: res.statusCode, data, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(pin) {
  const response = await request('POST', '/api/auth/verify-pin', { body: { pin } });
  const header = []
    .concat(response.headers['set-cookie'] || [])
    .find((c) => c.startsWith('DUMBDROP_SESSION='));
  return { response, cookie: header ? header.split(';')[0] : null };
}

function appConfig(html) {
  const match = String(html).match(/window\.APP_CONFIG\s*=\s*(\{.*?\});|(\{"autoUpload".*?\})/s);
  return JSON.parse(match[1] || match[2]);
}

describe('Upload PIN', () => {
  it('signs in with the upload role and can upload', async () => {
    const { response, cookie } = await login(UPLOAD_PIN);
    assert.strictEqual(response.data.role, 'upload');
    const init = await request('POST', '/api/upload/init', {
      headers: { Cookie: cookie },
      body: { filename: 'drop.txt', fileSize: 0 },
    });
    assert.strictEqual(init.status, 200);
  });

  it('cannot list, download, rename, delete or manage shares', async () => {
    const { cookie } = await login(UPLOAD_PIN);
    const attempts = [
      ['GET', '/api/files'],
      ['GET', '/api/files/download/report.txt'],
      ['DELETE', '/api/files/report.txt'],
      ['PUT', '/api/files/rename/report.txt', { newName: 'x.txt' }],
      ['GET', '/api/files/shares/manage'],
      ['POST', '/api/files/share', { path: 'report.txt' }],
    ];
    for (const [method, url, body] of attempts) {
      const res = await request(method, url, { headers: { Cookie: cookie }, body });
      assert.strictEqual(res.status, 403, `${method} ${url}`);
    }
    assert.ok(fs.existsSync(path.join(uploadDir, 'report.txt')));
  });

  it('sees the upload page without the library, with an admin sign-in link', async () => {
    const { cookie } = await login(UPLOAD_PIN);
    const page = await request('GET', '/', { headers: { Cookie: cookie } });
    const config = appConfig(page.data);
    assert.strictEqual(config.showFileList, false);
    assert.strictEqual(config.uploadOnly, true);
    assert.strictEqual(config.adminSignIn, true);
    assert.strictEqual(config.role, 'upload');
  });

  it('via X-Pin gets 403 on management without counting as a wrong guess', async () => {
    for (let i = 0; i < 8; i++) {
      const res = await request('GET', '/api/files', { headers: { 'X-Pin': UPLOAD_PIN } });
      assert.strictEqual(res.status, 403);
    }
    assert.strictEqual(isLockedOut('127.0.0.1') || isLockedOut('::ffff:127.0.0.1'), false);
  });
});

describe('Admin PIN', () => {
  it('signs in with the admin role and can do everything', async () => {
    const { response, cookie } = await login(ADMIN_PIN);
    assert.strictEqual(response.data.role, 'admin');

    const files = await request('GET', '/api/files', { headers: { Cookie: cookie } });
    assert.strictEqual(files.status, 200);
    assert.ok(JSON.stringify(files.data).includes('report.txt'));

    const share = await request('POST', '/api/files/share', {
      headers: { Cookie: cookie },
      body: { path: 'report.txt' },
    });
    assert.strictEqual(share.status, 201);
    const publicView = await request('GET', `/api/shares/${share.data.token}/download`);
    assert.strictEqual(publicView.status, 200);

    const init = await request('POST', '/api/upload/init', {
      headers: { Cookie: cookie },
      body: { filename: 'admin.txt', fileSize: 0 },
    });
    assert.strictEqual(init.status, 200);

    const page = await request('GET', '/', { headers: { Cookie: cookie } });
    const config = appConfig(page.data);
    assert.strictEqual(config.showFileList, true, 'the library is on for the admin');
    assert.strictEqual(config.adminSignIn, false);
  });

  it('works through X-Pin for scripts', async () => {
    const res = await request('GET', '/api/files', { headers: { 'X-Pin': ADMIN_PIN } });
    assert.strictEqual(res.status, 200);
  });

  it('is advertised on the login status endpoint', async () => {
    const res = await request('GET', '/api/auth/pin-required');
    assert.deepStrictEqual(res.data, { required: true, adminLogin: true });
  });
});
