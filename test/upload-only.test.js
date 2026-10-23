/**
 * Upload-only mode tests
 * Listing, download, rename, delete, and shares return 404. Uploads stay up.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-upload-only-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.UPLOAD_ONLY = 'true';
process.env.SHOW_FILE_LIST = 'true';
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
  await fs.promises.writeFile(path.join(uploadDir, 'secret.txt'), 'secret');
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
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('UPLOAD_ONLY', () => {
  it('hides file management and shares but keeps upload and health', async () => {
    const hidden = [
      ['GET', '/api/files'],
      ['GET', '/api/files/download/secret.txt'],
      ['DELETE', '/api/files/secret.txt'],
      ['GET', '/api/shares/manage'],
      ['GET', '/api/shares/not-a-real-token'],
      ['POST', '/api/files/share'],
    ];
    for (const [method, requestPath] of hidden) {
      const response = await request(method, requestPath, method === 'POST' ? { path: 'secret.txt' } : null);
      assert.strictEqual(response.status, 404, `${method} ${requestPath}`);
    }

    const sharePage = await request('GET', '/share/not-a-real-token');
    assert.strictEqual(sharePage.status, 404);
    const shareHtml = await request('GET', '/share.html');
    assert.strictEqual(shareHtml.status, 404);

    const health = await request('GET', '/health');
    assert.strictEqual(health.status, 200);

    const init = await request('POST', '/api/upload/init', { filename: 'note.txt', fileSize: 4 });
    assert.strictEqual(init.status, 200);

    const home = await request('GET', '/');
    assert.strictEqual(home.status, 200);
    assert.match(home.body, /"uploadOnly":true/);
    assert.match(home.body, /"showFileList":false/);
  });
});
