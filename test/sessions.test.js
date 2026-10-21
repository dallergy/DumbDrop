/**
 * Signed session tests.
 * The cookie carries a signed token instead of the PIN; tokens are checked
 * before the lockout; logout and PIN changes end sessions.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-sessions-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.DUMBDROP_PIN = '482913';
process.env.NODE_ENV = 'test';
process.env.SHOW_FILE_LIST = 'true';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, initialize } = require('../src/app');
const { clearLoginAttempts, isLockedOut } = require('../src/utils/security');

const PIN = '482913';
const REPO_ROOT = path.join(__dirname, '..');
let server;

before(async () => {
  await initialize();
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

function cookieFrom(response, name) {
  const header = []
    .concat(response.headers['set-cookie'] || [])
    .find((c) => c.startsWith(`${name}=`));
  return header ? header.split(';')[0] : null;
}

async function login(pin = PIN) {
  const response = await request('POST', '/api/auth/verify-pin', { body: { pin } });
  return { response, cookie: cookieFrom(response, 'DUMBDROP_SESSION') };
}

describe('Session cookie', () => {
  it('holds a signed token, never the PIN', async () => {
    const { response, cookie } = await login();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.role, 'upload');
    assert.ok(cookie, 'session cookie is set');
    assert.ok(!cookie.includes(PIN), 'cookie must not contain the PIN');
    const setCookie = [].concat(response.headers['set-cookie']).join(';');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.doesNotMatch(setCookie, /DUMBDROP_PIN=\d/);

    const files = await request('GET', '/api/files', { headers: { Cookie: cookie } });
    assert.strictEqual(files.status, 200);
  });

  it('no longer accepts the old raw-PIN cookie', async () => {
    const res = await request('GET', '/api/files', { headers: { Cookie: `DUMBDROP_PIN=${PIN}` } });
    assert.strictEqual(res.status, 401);
  });

  it('rejects tampered tokens', async () => {
    const { cookie } = await login();
    const token = cookie.split('=')[1];
    const parts = token.split('.');
    const forgeries = [
      [parts[0], 'admin', ...parts.slice(2)].join('.'),
      [parts[0], parts[1], String(Date.now() + 1e10), parts[3], parts[4]].join('.'),
      `${token.slice(0, -2)}AA`,
      'v1.upload.9999999999999.abc.def',
      '',
    ];
    for (const forged of forgeries) {
      const res = await request('GET', '/api/files', {
        headers: { Cookie: `DUMBDROP_SESSION=${forged}` },
      });
      assert.strictEqual(res.status, 401, forged);
    }
  });

  it('ends on logout, even if the old cookie is replayed', async () => {
    const { cookie } = await login();
    const out = await request('POST', '/api/auth/logout', { headers: { Cookie: cookie } });
    assert.strictEqual(out.status, 200);
    const replay = await request('GET', '/api/files', { headers: { Cookie: cookie } });
    assert.strictEqual(replay.status, 401);
  });

  it('reports the session state', async () => {
    const anonymous = await request('GET', '/api/auth/session');
    assert.deepStrictEqual(anonymous.data, { authenticated: false, role: null, canManage: false });
    const { cookie } = await login();
    const signedIn = await request('GET', '/api/auth/session', { headers: { Cookie: cookie } });
    assert.deepStrictEqual(signedIn.data, { authenticated: true, role: 'upload', canManage: true });
  });
});

describe('Lockout and sessions', () => {
  it('does not count stale or forged session cookies as PIN guesses', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request('GET', '/api/files', {
        headers: { Cookie: `DUMBDROP_SESSION=v1.upload.1.x.y${i}` },
      });
      assert.strictEqual(res.status, 401);
    }
    assert.strictEqual(isLockedOut('127.0.0.1'), false);
    assert.strictEqual(isLockedOut('::ffff:127.0.0.1'), false);
  });

  it('keeps a signed-in user working while someone on the same IP is locked out', async () => {
    const { cookie } = await login();
    for (let i = 0; i < 6; i++) {
      await request('GET', '/api/files', { headers: { 'X-Pin': '000000' } });
    }
    const guess = await request('GET', '/api/files', { headers: { 'X-Pin': PIN } });
    assert.strictEqual(guess.status, 429, 'the guesser is locked out, even with the right PIN');
    const owner = await request('GET', '/api/files', { headers: { Cookie: cookie } });
    assert.strictEqual(owner.status, 200, 'an existing session is not');
  });

  it('never throttles repeated successful logins', async () => {
    for (let i = 0; i < 8; i++) {
      const { response } = await login();
      assert.strictEqual(response.status, 200, `login ${i + 1}`);
    }
  });
});

describe('Pages', () => {
  it('sends visitors without a session to the login page, from / and /index.html', async () => {
    for (const page of ['/', '/index.html']) {
      const res = await request('GET', page);
      assert.strictEqual(res.status, 302, page);
      assert.match(res.headers.location, /login\.html$/);
    }
    const { cookie } = await login();
    const res = await request('GET', '/index.html', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 200);
    assert.match(res.data, /"signedIn":true/);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
  });

  it('does not serve .html files from outside public/', async () => {
    const probe = path.join(REPO_ROOT, '__traversal_probe.html');
    fs.writeFileSync(probe, 'TRAVERSAL-PROBE');
    try {
      for (const target of ['/../__traversal_probe.html', '/js/../../__traversal_probe.html']) {
        const res = await request('GET', target);
        assert.ok(!String(res.data).includes('TRAVERSAL-PROBE'), target);
      }
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  it('answers unknown API routes with JSON 404', async () => {
    const { cookie } = await login();
    const res = await request('GET', '/api/nope', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.data, { error: 'Not found' });
  });
});

describe('Session lifetime across restarts and PIN changes', () => {
  const script = `
    process.env.DISABLE_BATCH_CLEANUP = 'true';
    process.env.DISABLE_SECURITY_CLEANUP = 'true';
    const s = require('./src/utils/sessions');
    const mode = process.argv[1];
    if (mode === 'issue') { process.stdout.write(s.createSession('upload')); process.exit(0); }
    process.stdout.write(s.verifySession(process.argv[2]) ? 'valid' : 'invalid');
    process.exit(0);
  `;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-restart-'));
  const run = (pin, ...args) =>
    spawnSync(process.execPath, ['-e', script, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, UPLOAD_DIR: dir, DUMBDROP_PIN: pin, NODE_ENV: 'test' },
    })
      .stdout.trim()
      .split('\n')
      .pop();

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('survives a restart and ends when the PIN changes', () => {
    const token = run('1111', 'issue');
    assert.match(token, /^v1\.upload\.\d+\.[\w-]+\.[\w-]+$/);
    assert.strictEqual(run('1111', 'verify', token), 'valid', 'same PIN after restart');
    assert.strictEqual(run('2222', 'verify', token), 'invalid', 'new PIN');
    const keyFile = path.join(dir, '.metadata', 'session.key');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(keyFile).mode & 0o077, 0, 'key file is private');
    }
  });
});
