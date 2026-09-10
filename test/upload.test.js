/**
 * Upload functionality tests
 * Tests file upload initialization, chunked uploads, and batch operations
 */

// Disable batch cleanup for tests
process.env.DISABLE_BATCH_CLEANUP = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Import the app
const { app, initialize, config } = require('../src/app');

let server;
let baseUrl;

before(async () => {
  // Initialize app
  await initialize();
  
  // Start server on random port
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

after(async () => {
  // Close server
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  
  // Clean up test uploads
  try {
    const testFiles = await fs.readdir(config.uploadDir);
    for (const file of testFiles) {
      if (file !== '.metadata') {
        const filePath = path.join(config.uploadDir, file);
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          await fs.unlink(filePath);
        }
      }
    }
  } catch (err) {
    // Ignore cleanup errors
  }
});

/**
 * Helper function to make HTTP requests
 */
async function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    
    req.end();
  });
}

describe('Upload API Tests', () => {
  describe('GET /health', () => {
    it('should report ok without authentication', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/health',
        method: 'GET',
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.data.status, 'ok');
    });
  });
  describe('POST /api/upload/init', () => {
    it('should initialize a new upload', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'test.txt',
        fileSize: 100,
      });
      
      assert.strictEqual(response.status, 200);
      assert.ok(response.data.uploadId);
    });
    
    it('should reject uploads without filename', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        fileSize: 100,
      });
      
      assert.strictEqual(response.status, 400);
      assert.ok(response.data.error);
    });
    
    it('should reject uploads without fileSize', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'test.txt',
      });
      
      assert.strictEqual(response.status, 400);
      assert.ok(response.data.error);
    });
    
    it('should handle zero-byte files', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'empty.txt',
        fileSize: 0,
      });
      
      assert.strictEqual(response.status, 200);
      assert.ok(response.data.uploadId);
    });
  });
  
  describe('POST /api/upload/chunk/:uploadId', () => {
    it('should accept chunks for a valid upload', async () => {
      // Initialize upload first
      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'chunk-test.txt',
        fileSize: 50,
      });
      
      const { uploadId } = initResponse.data;
      
      // Send chunk
      const chunk = Buffer.from('Hello, World!');
      const chunkResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      }, chunk);
      
      assert.strictEqual(chunkResponse.status, 200);
      assert.ok(chunkResponse.data.bytesReceived > 0);
    });

    it('should accept large chunks and ignore duplicate offsets', async () => {
      const payload = Buffer.alloc(2 * 1024 * 1024, 7);
      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, {
        filename: 'large-chunk.bin',
        fileSize: payload.length,
      });

      const { uploadId } = initResponse.data;
      const firstHalf = payload.subarray(0, payload.length / 2);
      const sendChunk = (body, offset) => makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Offset': String(offset),
        },
      }, body);

      const first = await sendChunk(firstHalf, 0);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.data.bytesReceived, firstHalf.length);

      const duplicate = await sendChunk(firstHalf, 0);
      assert.strictEqual(duplicate.status, 200);
      assert.strictEqual(duplicate.data.bytesReceived, firstHalf.length);

      const rest = await sendChunk(payload.subarray(firstHalf.length), firstHalf.length);
      assert.strictEqual(rest.status, 200);
      assert.strictEqual(rest.data.bytesReceived, payload.length);
      assert.strictEqual(rest.data.progress, 100);
    });

    it('should accept parallel out-of-order chunks and assemble the file', async () => {
      const payload = crypto.randomBytes(3 * 1024 * 1024 + 123);
      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, {
        filename: 'parallel.bin',
        fileSize: payload.length,
      });
      const { uploadId } = initResponse.data;
      assert.ok(uploadId);

      const chunkSize = 1024 * 1024;
      const chunks = [];
      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        chunks.push([offset, payload.subarray(offset, Math.min(offset + chunkSize, payload.length))]);
      }
      // Send the last chunk first and everything else concurrently
      chunks.reverse();
      const responses = await Promise.all(chunks.map(([offset, body]) => makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          'X-Chunk-Offset': String(offset),
        },
      }, body)));

      responses.forEach((r) => assert.strictEqual(r.status, 200));
      const finished = responses.filter((r) => r.data.complete);
      assert.ok(finished.length >= 1, 'the last chunk(s) to land should report completion');
      const notFinished = responses.filter((r) => !r.data.complete);
      notFinished.forEach((r) => assert.ok(r.data.bytesReceived < payload.length));

      const written = await fs.readFile(path.join(config.uploadDir, 'parallel.bin'));
      assert.ok(written.equals(payload), 'assembled file must match the original bytes');

      // A late duplicate after completion is answered cleanly, not with 404
      const late = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunks[0][1].length,
          'X-Chunk-Offset': String(chunks[0][0]),
        },
      }, chunks[0][1]);
      assert.strictEqual(late.status, 200);
      assert.strictEqual(late.data.complete, true);
    });

    it('should report missing ranges via the status endpoint', async () => {
      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, { filename: 'status.bin', fileSize: 100 });
      const { uploadId } = initResponse.data;

      await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Offset': '40',
        },
      }, Buffer.alloc(20, 1));

      const status = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/status/${uploadId}`,
        method: 'GET',
      });
      assert.strictEqual(status.status, 200);
      assert.strictEqual(status.data.bytesReceived, 20);
      assert.deepStrictEqual(status.data.ranges, [[40, 60]]);
      assert.deepStrictEqual(status.data.missing, [[0, 40], [60, 100]]);
      assert.strictEqual(status.data.complete, false);

      const missing = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/status/does-not-exist',
        method: 'GET',
      });
      assert.strictEqual(missing.status, 404);
    });

    it('should reject chunks that overrun the declared file size', async () => {
      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, { filename: 'overrun.bin', fileSize: 10 });
      const { uploadId } = initResponse.data;

      const body = Buffer.alloc(8, 2);
      const overrun = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          'X-Chunk-Offset': '5',
        },
      }, body);
      assert.strictEqual(overrun.status, 400);

      const beyond = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Offset': '10',
        },
      }, Buffer.alloc(1));
      assert.strictEqual(beyond.status, 400);

      const badOffset = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Offset': 'abc',
        },
      }, Buffer.alloc(1));
      assert.strictEqual(badOffset.status, 400);
    });

    it('should reject chunks for invalid uploadId', async () => {
      const chunk = Buffer.from('Test data');
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/chunk/invalid-id',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      }, chunk);
      
      assert.strictEqual(response.status, 404);
    });
  });
  
  describe('POST /api/upload/cancel/:uploadId', () => {
    it('should cancel an active upload', async () => {
      // Initialize upload
      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'cancel-test.txt',
        fileSize: 100,
      });
      
      const { uploadId } = initResponse.data;
      
      // Cancel upload
      const cancelResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/cancel/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      assert.strictEqual(cancelResponse.status, 200);
    });
  });
  
  describe('Batch uploads', () => {
    it('should handle multiple files with same batch ID', async () => {
      const batchId = `${Date.now()}-${crypto.randomBytes(5).toString('hex').slice(0, 9)}`;
      
      // Initialize first file
      const file1Response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Batch-Id': batchId,
        },
      }, {
        filename: 'batch-file1.txt',
        fileSize: 50,
      });
      
      assert.strictEqual(file1Response.status, 200);
      
      // Initialize second file
      const file2Response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Batch-Id': batchId,
        },
      }, {
        filename: 'batch-file2.txt',
        fileSize: 50,
      });
      
      assert.strictEqual(file2Response.status, 200);
      assert.notStrictEqual(file1Response.data.uploadId, file2Response.data.uploadId);
    });
  });
});

