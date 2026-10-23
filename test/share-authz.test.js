/**
 * Share authorization tests.
 * Public share links stay open; management (create, list, update, delete)
 * exists only behind the PIN; shares never expose app data or symlink targets.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-shares-'));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-outside-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.DUMBDROP_PIN = '654321';
process.env.NODE_ENV = 'production';
process.env.BASE_URL = 'https://drop.example.com/';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, initialize } = require('../src/app');
const { clearLoginAttempts } = require('../src/utils/security');

const PIN = '654321';
let server;

before(async () => {
  await initialize();
  await fs.promises.writeFile(path.join(uploadDir, 'secret.txt'), 'secret');
  await fs.promises.mkdir(path.join(uploadDir, 'album', 'nested'), { recursive: true });
  await fs.promises.writeFile(path.join(uploadDir, 'album', 'a.txt'), 'a');
  await fs.promises.writeFile(path.join(uploadDir, 'album', 'nested', 'b.txt'), 'b');
  await fs.promises.writeFile(path.join(uploadDir, 'album', '.hidden'), 'hidden');
  await fs.promises.writeFile(path.join(outsideDir, 'passwd'), 'outside-secret');
  await fs.promises.symlink(path.join(outsideDir, 'passwd'), path.join(uploadDir, 'album', 'link'));
  await fs.promises.symlink(outsideDir, path.join(uploadDir, 'album', 'linkdir'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  clearLoginAttempts();
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.promises.rm(uploadDir, { recursive: true, force: true });
  await fs.promises.rm(outsideDir, { recursive: true, force: true });
});

beforeEach(() => clearLoginAttempts());

function request(method, requestPath, { headers = {}, body = null, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: requestPath,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (raw) return resolve({ status: res.statusCode, buffer, headers: res.headers });
          const text = buffer.toString('utf8');
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const owner = { 'Content-Type': 'application/json', 'X-Pin': PIN };

async function createShare(sharePath, extra = {}) {
  const created = await request('POST', '/api/files/share', {
    headers: owner,
    body: { path: sharePath, ...extra },
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

/** Entry names in a ZIP, read from its central directory. */
function zipEntryNames(buffer) {
  const names = [];
  let offset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(offset + 10);
  offset = buffer.readUInt32LE(offset + 16);
  for (let i = 0; i < count; i++) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names.sort();
}

describe('Share management is never reachable through the public mount', () => {
  it('has no list, update, delete or create routes under /api/shares, in any casing', async () => {
    const share = await createShare('secret.txt', { authRequired: true });
    assert.strictEqual(share.grant, undefined);

    const attempts = [
      ['GET', '/api/shares/manage'],
      ['GET', '/api/shares/MANAGE'],
      ['GET', '/API/SHARES/Manage'],
      ['GET', '/api/shares/manage/'],
      ['PATCH', `/api/shares/${share.token}`],
      ['DELETE', `/api/shares/${share.token}`],
      ['POST', '/api/shares'],
    ];
    for (const [method, url] of attempts) {
      for (const headers of [{}, owner]) {
        const res = await request(method, url, {
          headers: { 'Content-Type': 'application/json', ...headers },
          body: ['GET', 'DELETE'].includes(method)
            ? null
            : { authRequired: false, path: 'secret.txt' },
        });
        assert.ok([401, 404].includes(res.status), `${method} ${url} gave ${res.status}`);
        assert.strictEqual(res.data.shares, undefined, `${method} ${url} leaked the list`);
      }
    }

    // The share is unchanged: still protected, still there.
    const download = await request('GET', `/api/shares/${share.token}/download`);
    assert.strictEqual(download.status, 401);
  });

  it('requires the PIN on the owner mount', async () => {
    const share = await createShare('secret.txt', { authRequired: true });

    for (const url of ['/api/files/shares/manage', '/API/FILES/SHARES/MANAGE']) {
      const res = await request('GET', url);
      assert.strictEqual(res.status, 401, url);
    }
    const patch = await request('PATCH', `/api/files/shares/${share.token}`, {
      headers: { 'Content-Type': 'application/json' },
      body: { authRequired: false },
    });
    assert.strictEqual(patch.status, 401);

    const list = await request('GET', '/api/files/shares/manage', { headers: owner });
    assert.strictEqual(list.status, 200);
    const listed = list.data.shares.find((item) => item.token === share.token);
    assert.ok(listed);
    assert.strictEqual(listed.grant, undefined);

    const opened = await request('PATCH', `/api/files/shares/${share.token}`, {
      headers: owner,
      body: { authRequired: false },
    });
    assert.strictEqual(opened.status, 200);
    const download = await request('GET', `/api/shares/${share.token}/download`);
    assert.strictEqual(download.status, 200);
    assert.strictEqual(download.data, 'secret');
  });

  it('treats "__proto__" and malformed tokens as missing', async () => {
    for (const token of ['__proto__', 'constructor', 'toString', 'x']) {
      const view = await request('GET', `/api/shares/${token}`);
      assert.strictEqual(view.status, 404, token);
      const patch = await request('PATCH', `/api/files/shares/${token}`, {
        headers: owner,
        body: { expiresIn: 60 },
      });
      assert.strictEqual(patch.status, 404, token);
    }
    assert.strictEqual({}.expiresAt, undefined, 'Object.prototype must not be modified');
  });
});

describe('What can be shared', () => {
  it('refuses the upload root, app data, hidden names and traversal', async () => {
    for (const sharePath of [
      '.',
      './',
      '',
      '.metadata',
      '.metadata/shares.json',
      'album/..',
      '../x',
      'album/.hidden',
    ]) {
      const res = await request('POST', '/api/files/share', {
        headers: owner,
        body: { path: sharePath },
      });
      assert.strictEqual(res.status, 400, `sharing "${sharePath}" gave ${res.status}`);
    }
  });

  it('refuses a symlink that points outside the upload directory', async () => {
    const res = await request('POST', '/api/files/share', {
      headers: owner,
      body: { path: 'album/link' },
    });
    assert.strictEqual(res.status, 400);
  });
});

describe('Shared folders', () => {
  it('list and zip only regular files, never symlinks or hidden files', async () => {
    const share = await createShare('album');

    const view = await request('GET', `/api/shares/${share.token}`);
    assert.strictEqual(view.status, 200);
    const names = JSON.stringify(view.data.items);
    assert.match(names, /a\.txt/);
    assert.match(names, /b\.txt/);
    assert.doesNotMatch(names, /link|hidden/);

    for (const file of ['link', 'linkdir/passwd', '.hidden', 'nested/../../secret.txt']) {
      const res = await request('GET', `/api/shares/${share.token}/file/${file}`);
      assert.notStrictEqual(res.status, 200, `${file} should not be downloadable`);
    }

    const zip = await request('GET', `/api/shares/${share.token}/download`, { raw: true });
    assert.strictEqual(zip.status, 200);
    assert.deepStrictEqual(zipEntryNames(zip.buffer), ['a.txt', 'nested/', 'nested/b.txt']);
    assert.ok(!zip.buffer.includes(Buffer.from('outside-secret')));
  });

  it('rebuilds the ZIP when a file deep in the folder changes', async () => {
    const share = await createShare('album');
    const first = await request('GET', `/api/shares/${share.token}/download`, { raw: true });
    assert.deepStrictEqual(zipEntryNames(first.buffer), ['a.txt', 'nested/', 'nested/b.txt']);

    // A new file two levels down does not change the top folder's mtime.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.promises.writeFile(path.join(uploadDir, 'album', 'nested', 'c.txt'), 'c');
    const second = await request('GET', `/api/shares/${share.token}/download`, { raw: true });
    assert.deepStrictEqual(zipEntryNames(second.buffer), [
      'a.txt',
      'nested/',
      'nested/b.txt',
      'nested/c.txt',
    ]);
  });

  it('serves concurrent downloads of a new share from one complete build', async () => {
    const share = await createShare('album');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request('GET', `/api/shares/${share.token}/download`, { raw: true })
      )
    );
    for (const res of results) {
      assert.strictEqual(res.status, 200);
      assert.ok(zipEntryNames(res.buffer).includes('a.txt'));
    }
  });
});

describe('Protected shares', () => {
  it('sets a Secure, HttpOnly grant cookie and refuses padded PINs', async () => {
    const share = await createShare('secret.txt', { authRequired: true });

    const padded = await request('POST', `/api/shares/${share.token}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      body: { pin: `${PIN} ` },
    });
    assert.strictEqual(padded.status, 401);

    const authed = await request('POST', `/api/shares/${share.token}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      body: { pin: PIN },
    });
    assert.strictEqual(authed.status, 200);
    const cookie = [].concat(authed.headers['set-cookie'] || []).join(';');
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, new RegExp(`DUMBDROP_SHARE_${share.token}=`));

    const grant = cookie.match(new RegExp(`DUMBDROP_SHARE_${share.token}=([^;]+)`))[1];
    const download = await request('GET', `/api/shares/${share.token}/download`, {
      headers: { Cookie: `DUMBDROP_SHARE_${share.token}=${grant}` },
    });
    assert.strictEqual(download.status, 200);

    // Turning protection off and on again rotates the grant.
    for (const authRequired of [false, true]) {
      const res = await request('PATCH', `/api/files/shares/${share.token}`, {
        headers: owner,
        body: { authRequired },
      });
      assert.strictEqual(res.status, 200);
    }
    const stale = await request('GET', `/api/shares/${share.token}/download`, {
      headers: { Cookie: `DUMBDROP_SHARE_${share.token}=${grant}` },
    });
    assert.strictEqual(stale.status, 401);
  });

  it('opens for a signed-in owner without asking for the PIN again', async () => {
    const share = await createShare('secret.txt', { authRequired: true });
    const login = await request('POST', '/api/auth/verify-pin', {
      headers: { 'Content-Type': 'application/json' },
      body: { pin: PIN },
    });
    const session = []
      .concat(login.headers['set-cookie'])
      .find((c) => c.startsWith('DUMBDROP_SESSION='));
    const res = await request('GET', `/api/shares/${share.token}/download`, {
      headers: { Cookie: session.split(';')[0] },
    });
    assert.strictEqual(res.status, 200);
  });
});
