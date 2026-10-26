/**
 * Regression tests for the October maintenance pass:
 *  - PIN lockout must cover a whole IPv6 /56, the same bucket the rate
 *    limiters use, or rotating addresses gives unlimited X-Pin guesses.
 *  - Concurrent uploads with the same name must not share a .partial file
 *    or overwrite each other on finalize.
 *  - Upload IDs are server-generated hex; anything else is rejected.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-maint-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.DUMBDROP_PIN = '246810';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'http://localhost:3000/';
// Behind a reverse proxy: client addresses come from X-Forwarded-For.
process.env.TRUST_PROXY = 'true';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, initialize } = require('../src/app');
const { clearLoginAttempts } = require('../src/utils/security');

const PIN = '246810';
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

beforeEach(() => {
  clearLoginAttempts();
});

function request(method, requestPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: requestPath,
        method,
        headers: payload ? { 'Content-Length': payload.length, ...headers } : headers,
      },
      (res) => {
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
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const fromIp = (ip, extra = {}) => ({ 'X-Forwarded-For': ip, ...extra });

describe('PIN lockout across an IPv6 prefix', () => {
  it('locks the whole /56 after five wrong guesses from rotating addresses', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const response = await request('GET', '/api/upload/storage', {
        headers: fromIp(`2001:db8:aa:${i}::${i}`, { 'X-Pin': '000000' }),
      });
      assert.strictEqual(response.status, 401, `guess ${i} should be a plain 401`);
    }

    // A fresh address in the same /56 is still locked, even with the right PIN.
    const next = await request('GET', '/api/upload/storage', {
      headers: fromIp('2001:db8:aa:ff::99', { 'X-Pin': PIN }),
    });
    assert.strictEqual(next.status, 429);
  });

  it('keeps other prefixes and IPv4 clients unaffected', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await request('GET', '/api/upload/storage', {
        headers: fromIp(`2001:db8:bb::${i}`, { 'X-Pin': '000000' }),
      });
    }
    const otherPrefix = await request('GET', '/api/upload/storage', {
      headers: fromIp('2001:db8:cc::1', { 'X-Pin': PIN }),
    });
    assert.strictEqual(otherPrefix.status, 200);
    const ipv4 = await request('GET', '/api/upload/storage', {
      headers: fromIp('203.0.113.7', { 'X-Pin': PIN }),
    });
    assert.strictEqual(ipv4.status, 200);
  });

  it('applies the same prefix lockout to the login form', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await request('POST', '/api/auth/verify-pin', {
        headers: fromIp(`2001:db8:dd::${i}`, { 'Content-Type': 'application/json' }),
        body: { pin: '000000' },
      });
    }
    const response = await request('POST', '/api/auth/verify-pin', {
      headers: fromIp('2001:db8:dd::abcd', { 'Content-Type': 'application/json' }),
      body: { pin: PIN },
    });
    assert.strictEqual(response.status, 429);
  });
});

describe('concurrent uploads with the same name', () => {
  const auth = (extra = {}) => fromIp('198.51.100.20', { 'X-Pin': PIN, ...extra });

  async function init(name, size) {
    const response = await request('POST', '/api/upload/init', {
      headers: auth({ 'Content-Type': 'application/json' }),
      body: { filename: name, fileSize: size },
    });
    assert.strictEqual(response.status, 200, JSON.stringify(response.data));
    return response.data.uploadId;
  }

  async function sendAll(uploadId, content) {
    const response = await request('POST', `/api/upload/chunk/${uploadId}`, {
      headers: auth({ 'Content-Type': 'application/octet-stream', 'X-Chunk-Offset': '0' }),
      body: content,
    });
    assert.strictEqual(response.status, 200, JSON.stringify(response.data));
    assert.strictEqual(response.data.complete, true);
  }

  it('gives each upload its own file and keeps both contents intact', async () => {
    const first = Buffer.from('A'.repeat(4096));
    const second = Buffer.from('B'.repeat(4096));
    // Both inits are in flight at once, as when two people drop the same file.
    const [idA, idB] = await Promise.all([
      init('same-name.bin', first.length),
      init('same-name.bin', second.length),
    ]);
    await sendAll(idA, first);
    await sendAll(idB, second);

    const names = fs.readdirSync(uploadDir).filter((name) => name.startsWith('same-name'));
    assert.deepStrictEqual(names.sort(), ['same-name (1).bin', 'same-name.bin']);
    const contents = names.map((name) => fs.readFileSync(path.join(uploadDir, name), 'utf8'));
    assert.deepStrictEqual(contents.sort(), [first.toString(), second.toString()].sort());
  });

  it('does not overwrite a file that appeared after init', async () => {
    const content = Buffer.from('new upload');
    const id = await init('late.txt', content.length);
    // Someone (another upload, or a file copied in over SMB) takes the name meanwhile.
    fs.writeFileSync(path.join(uploadDir, 'late.txt'), 'existing data');
    await sendAll(id, content);

    assert.strictEqual(fs.readFileSync(path.join(uploadDir, 'late.txt'), 'utf8'), 'existing data');
    assert.strictEqual(
      fs.readFileSync(path.join(uploadDir, 'late (1).txt'), 'utf8'),
      content.toString()
    );
  });

  it('gives concurrent zero-byte uploads distinct names', async () => {
    await Promise.all([init('empty.txt', 0), init('empty.txt', 0)]);
    const names = fs.readdirSync(uploadDir).filter((name) => name.startsWith('empty'));
    assert.deepStrictEqual(names.sort(), ['empty (1).txt', 'empty.txt']);
  });
});

describe('upload id validation', () => {
  const auth = fromIp('198.51.100.30', { 'X-Pin': PIN });

  for (const bad of ['not-hex', 'a'.repeat(31), `${'a'.repeat(32)}%2F..`, 'ABCDEF'.repeat(6)]) {
    it(`rejects ${bad} with 404`, async () => {
      const status = await request('GET', `/api/upload/status/${bad}`, { headers: auth });
      assert.strictEqual(status.status, 404);
      const cancel = await request('POST', `/api/upload/cancel/${bad}`, { headers: auth });
      assert.strictEqual(cancel.status, 404);
    });
  }
});

describe('moving finished uploads into place', () => {
  const { moveIntoPlace } = require('../src/routes/upload');
  const fsp = require('fs').promises;

  it('falls back to rename when the filesystem has no hard links', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-nolink-'));
    const partial = path.join(dir, 'clip.mp4.partial');
    fs.writeFileSync(partial, 'video');
    fs.writeFileSync(path.join(dir, 'clip.mp4'), 'already here');
    const realLink = fsp.link;
    fsp.link = async () => {
      throw Object.assign(new Error('not supported'), { code: 'EPERM' });
    };
    try {
      const finalPath = await moveIntoPlace(partial, path.join(dir, 'clip.mp4'));
      assert.strictEqual(finalPath, path.join(dir, 'clip (1).mp4'));
      assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), 'video');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'clip.mp4'), 'utf8'), 'already here');
      assert.strictEqual(fs.existsSync(partial), false);
    } finally {
      fsp.link = realLink;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unwritable upload directory', () => {
  const { ensureDirectoryExists } = require('../src/utils/fileUtils');
  const logger = require('../src/utils/logger');
  const fsp = require('fs').promises;

  it('logs which user needs access and how to fix it', async () => {
    const realAccess = fsp.access;
    const realError = logger.error;
    const logged = [];
    fsp.access = async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    logger.error = (message) => logged.push(message);
    try {
      await assert.rejects(ensureDirectoryExists(uploadDir), /Failed to access or create/);
    } finally {
      fsp.access = realAccess;
      logger.error = realError;
    }
    const hint = logged.find((line) => line.includes('chown'));
    assert.ok(hint, `expected a chown hint in ${JSON.stringify(logged)}`);
    assert.match(hint, /uid \d+/);
  });
});
