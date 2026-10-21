/**
 * File-management routes must never touch the upload root or app data
 * (.metadata holds the share list and the session key), and must not
 * follow symlinks out of the upload directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-internal-'));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-outside-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.DUMBDROP_PIN = '';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, initialize } = require('../src/app');

let server;

before(async () => {
  await initialize();
  await fs.promises.writeFile(path.join(uploadDir, 'keep.txt'), 'keep');
  await fs.promises.mkdir(path.join(uploadDir, '.metadata'), { recursive: true });
  await fs.promises.writeFile(path.join(uploadDir, '.metadata', 'shares.json'), '{"secret":true}');
  await fs.promises.writeFile(path.join(outsideDir, 'outside.txt'), 'outside');
  await fs.promises.symlink(outsideDir, path.join(uploadDir, 'escape'));
  // A link back to the upload root used to make the listing recurse forever.
  await fs.promises.symlink(uploadDir, path.join(uploadDir, 'loop'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.promises.rm(uploadDir, { recursive: true, force: true });
  await fs.promises.rm(outsideDir, { recursive: true, force: true });
});

function request(method, requestPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: requestPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
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
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Upload root and app data', () => {
  it('cannot be deleted', async () => {
    for (const target of [
      '/api/files/.',
      '/api/files/./',
      '/api/files/.metadata',
      '/api/files/%2e',
    ]) {
      const res = await request('DELETE', target);
      assert.notStrictEqual(res.status, 200, target);
    }
    assert.ok(fs.existsSync(path.join(uploadDir, 'keep.txt')), 'upload directory survived');
    assert.ok(fs.existsSync(path.join(uploadDir, '.metadata', 'shares.json')), 'metadata survived');
  });

  it('cannot be downloaded, inspected or renamed', async () => {
    const attempts = [
      ['GET', '/api/files/download/.metadata/shares.json'],
      ['GET', '/api/files/info/.metadata/shares.json'],
      ['GET', '/api/files/info/.'],
      ['PUT', '/api/files/rename/.metadata', { newName: 'stolen' }],
    ];
    for (const [method, url, body] of attempts) {
      const res = await request(method, url, body);
      assert.strictEqual(res.status, 404, `${method} ${url}`);
      assert.ok(!JSON.stringify(res.data).includes('secret'), `${method} ${url} leaked`);
    }
    assert.ok(fs.existsSync(path.join(uploadDir, '.metadata')));
  });

  it('rejects traversal with 403', async () => {
    const res = await request('GET', '/api/files/download/..%2f..%2fetc%2fpasswd');
    assert.ok([403, 404].includes(res.status));
    const dotdot = await request('GET', '/api/files/info/keep.txt/..');
    assert.strictEqual(dotdot.status, 403);
  });
});

describe('Folders named like share routes', () => {
  it('can still be deleted from', async () => {
    for (const folder of ['share', 'shares']) {
      await fs.promises.mkdir(path.join(uploadDir, folder), { recursive: true });
      await fs.promises.writeFile(path.join(uploadDir, folder, 'photo.jpg'), 'x');
      const res = await request('DELETE', `/api/files/${folder}/photo.jpg`);
      assert.strictEqual(res.status, 200, folder);
      assert.ok(!fs.existsSync(path.join(uploadDir, folder, 'photo.jpg')), folder);
    }
  });
});

describe('Symlinks', () => {
  it('are left out of the listing, which finishes even with a link loop', async () => {
    const res = await request('GET', '/api/files');
    assert.strictEqual(res.status, 200);
    const listed = JSON.stringify(res.data.items);
    assert.match(listed, /keep\.txt/);
    assert.doesNotMatch(listed, /outside\.txt|"escape"|"loop"/);
  });

  it('cannot be followed out of the upload directory', async () => {
    const download = await request('GET', '/api/files/download/escape/outside.txt');
    assert.strictEqual(download.status, 403);
    const info = await request('GET', '/api/files/info/escape/outside.txt');
    assert.strictEqual(info.status, 403);
    const del = await request('DELETE', '/api/files/escape/outside.txt');
    assert.strictEqual(del.status, 403);
    assert.ok(fs.existsSync(path.join(outsideDir, 'outside.txt')));
  });
});
