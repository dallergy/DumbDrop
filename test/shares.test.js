/**
 * Share link tests
 * Covers share creation, public access, QR PNG output, and folder archives.
 */

process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.BASE_URL = 'http://localhost:3000/';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs').promises;
const path = require('path');
const { app, initialize, config } = require('../src/app');

let server;
let testFilePath;
let testFolderPath;

before(async () => {
  await initialize();
  testFilePath = path.join(config.uploadDir, 'share-test.txt');
  testFolderPath = path.join(config.uploadDir, 'share-folder');
  await fs.writeFile(testFilePath, 'Share me');
  await fs.mkdir(testFolderPath, { recursive: true });
  await fs.writeFile(path.join(testFolderPath, 'inside.txt'), 'Nested file');

  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, resolve);
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  try {
    await fs.rm(path.join(config.uploadDir, '.metadata', 'shares.json'), { force: true });
    await fs.rm(testFolderPath, { recursive: true, force: true });
    await fs.rm(testFilePath, { force: true });
  } catch {
    // Ignore cleanup errors
  }
});

async function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || '';
        let data = buffer;
        if (contentType.includes('application/json')) {
          try {
            data = JSON.parse(buffer.toString('utf8') || '{}');
          } catch {
            data = buffer.toString('utf8');
          }
        }
        resolve({ status: res.statusCode, data, headers: res.headers, raw: buffer });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('Share API Tests', () => {
  it('should create a file share with QR metadata', async () => {
    const response = await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: '/api/files/share',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { path: 'share-test.txt', expiresIn: 3600 });

    assert.strictEqual(response.status, 201);
    assert.match(response.data.url, /\/share\//);
    assert.match(response.data.qrUrl, /\/api\/shares\/.+\/qr\.png$/);
    assert.strictEqual(response.data.type, 'file');
  });

  it('should create a folder share', async () => {
    const response = await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: '/api/files/share',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { path: 'share-folder' });

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.data.type, 'directory');
  });

  it('should expose share metadata publicly', async () => {
    const created = await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: '/api/files/share',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { path: 'share-folder' });

    const response = await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: `/api/shares/${created.data.token}`,
      method: 'GET',
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.name, 'share-folder');
    assert.ok(Array.isArray(response.data.items));
    assert.ok(response.data.items.some((item) => item.name === 'inside.txt'));
  });

  it('should return a PNG QR code for a share', async () => {
    const created = await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: '/api/files/share',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { path: 'share-test.txt' });

    const response = await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: `/api/shares/${created.data.token}/qr.png`,
      method: 'GET',
    });

    assert.strictEqual(response.status, 200);
    assert.match(response.headers['content-type'], /image\/png/);
    assert.ok(response.raw.length > 100);
    assert.strictEqual(response.raw.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  });
});
