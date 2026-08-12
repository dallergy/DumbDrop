/**
 * Share link tests
 * Covers share creation, management, ZIP archives, and per-file downloads.
 */

process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.BASE_URL = 'http://localhost:3000/';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs').promises;
const path = require('path');
const { app, initialize, config } = require('../src/app');
const { archivePath } = require('../src/utils/shareArchives');

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
    await fs.rm(path.join(config.uploadDir, '.metadata'), { recursive: true, force: true });
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

  it('should list shares for management', async () => {
    const response = await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: '/api/files/shares/manage',
      method: 'GET',
    });

    assert.strictEqual(response.status, 200);
    assert.ok(Array.isArray(response.data.shares));
    assert.ok(response.data.shares.length > 0);
  });

  it('should expose recursive share metadata publicly', async () => {
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

  it('should download an individual file from a shared folder', async () => {
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
      path: `/api/shares/${created.data.token}/file/inside.txt`,
      method: 'GET',
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.raw.toString('utf8'), 'Nested file');
  });

  it('should create and reuse a cached ZIP for shared folders', async () => {
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
      path: `/api/shares/${created.data.token}/download`,
      method: 'GET',
    });

    assert.strictEqual(response.status, 200);
    assert.match(response.headers['content-disposition'] || '', /\.zip/);
    assert.strictEqual(response.raw.slice(0, 2).toString('hex'), '504b');

    const zipOnDisk = archivePath(created.data.token);
    await fs.access(zipOnDisk);
  });

  it('should delete a share and remove its cached ZIP', async () => {
    const created = await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: '/api/files/share',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { path: 'share-folder' });

    await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: `/api/shares/${created.data.token}/download`,
      method: 'GET',
    });

    const deleteResponse = await makeRequest({
      host: 'localhost',
      port: server.address().port,
      path: `/api/files/shares/${created.data.token}`,
      method: 'DELETE',
    });

    assert.strictEqual(deleteResponse.status, 200);
    await assert.rejects(() => fs.access(archivePath(created.data.token)));
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
    assert.strictEqual(response.raw.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  });
});
