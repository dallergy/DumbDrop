/**
 * Share management authorization tests
 * Public token routes stay open. List, update, and delete require the PIN.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-shares-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.DUMBDROP_PIN = '654321';
process.env.NODE_ENV = 'production';
process.env.BASE_URL = 'https://drop.example.com/';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, initialize } = require('../src/app');
const { isPublicShareRequest } = require('../src/routes/shares');
const { clearLoginAttempts } = require('../src/utils/security');

let server;

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

describe('isPublicShareRequest', () => {
  it('allows token reads and the share PIN endpoint only', () => {
    assert.strictEqual(isPublicShareRequest('GET', '/api/shares/abc'), true);
    assert.strictEqual(isPublicShareRequest('GET', '/api/shares/abc/download'), true);
    assert.strictEqual(isPublicShareRequest('GET', '/api/shares/abc/qr.png'), true);
    assert.strictEqual(isPublicShareRequest('GET', '/api/shares/abc/file/a/b.txt'), true);
    assert.strictEqual(isPublicShareRequest('POST', '/api/shares/abc/auth'), true);
    assert.strictEqual(isPublicShareRequest('GET', '/abc/download'), true);
    assert.strictEqual(isPublicShareRequest('GET', '/api/shares/manage'), false);
    assert.strictEqual(isPublicShareRequest('POST', '/api/shares'), false);
    assert.strictEqual(isPublicShareRequest('PATCH', '/api/shares/abc'), false);
    assert.strictEqual(isPublicShareRequest('DELETE', '/api/shares/abc'), false);
    // Express routing ignores case, so these must not look public either.
    assert.strictEqual(isPublicShareRequest('GET', '/api/shares/MANAGE'), false);
    assert.strictEqual(isPublicShareRequest('GET', '/api/shares/Manage/'), false);
    assert.strictEqual(isPublicShareRequest('GET', '/API/SHARES/manage'), false);
  });
});

describe('Share management requires the owner PIN', () => {
  it('returns 401 for list, update, and delete without a PIN', async () => {
    const created = await request('POST', '/api/files/share', {
      headers: { 'Content-Type': 'application/json', 'X-Pin': '654321' },
      body: { path: 'secret.txt', authRequired: true },
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.data.grant, undefined);
    const token = created.data.token;

    const manage = await request('GET', '/api/shares/manage');
    assert.strictEqual(manage.status, 401);

    for (const variant of ['/api/shares/MANAGE', '/api/shares/Manage', '/API/SHARES/MANAGE']) {
      const res = await request('GET', variant);
      assert.strictEqual(res.status, 401, `${variant} must require the PIN`);
      assert.strictEqual(res.data.shares, undefined);
    }

    const ownerManage = await request('GET', '/api/files/shares/manage');
    assert.strictEqual(ownerManage.status, 401);

    const patch = await request('PATCH', `/api/shares/${token}`, {
      headers: { 'Content-Type': 'application/json' },
      body: { authRequired: false },
    });
    assert.strictEqual(patch.status, 401);

    const remove = await request('DELETE', `/api/shares/${token}`);
    assert.strictEqual(remove.status, 401);

    const create = await request('POST', '/api/shares', {
      headers: { 'Content-Type': 'application/json' },
      body: { path: 'secret.txt' },
    });
    assert.strictEqual(create.status, 401);

    const download = await request('GET', `/api/shares/${token}/download`);
    assert.strictEqual(download.status, 401);

    const withPin = await request('GET', '/api/shares/manage', { headers: { 'X-Pin': '654321' } });
    assert.strictEqual(withPin.status, 200);
    assert.ok(withPin.data.shares.some((share) => share.token === token));
    assert.strictEqual(withPin.data.shares.find((share) => share.token === token).grant, undefined);

    const opened = await request('PATCH', `/api/shares/${token}`, {
      headers: { 'Content-Type': 'application/json', 'X-Pin': '654321' },
      body: { authRequired: false },
    });
    assert.strictEqual(opened.status, 200);
    const openedDownload = await request('GET', `/api/shares/${token}/download`);
    assert.strictEqual(openedDownload.status, 200);
    assert.strictEqual(openedDownload.data, 'secret');
  });

  it('sets a Secure share grant cookie when BASE_URL is https', async () => {
    const created = await request('POST', '/api/files/share', {
      headers: { 'Content-Type': 'application/json', 'X-Pin': '654321' },
      body: { path: 'secret.txt', authRequired: true },
    });
    assert.strictEqual(created.status, 201);

    const padded = await request('POST', `/api/shares/${created.data.token}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      body: { pin: '654321 ' },
    });
    assert.strictEqual(padded.status, 401);

    const authed = await request('POST', `/api/shares/${created.data.token}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      body: { pin: '654321' },
    });
    assert.strictEqual(authed.status, 200);
    const cookie = [].concat(authed.headers['set-cookie'] || []).join(';');
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, new RegExp(`DUMBDROP_SHARE_${created.data.token}=`));
  });
});
