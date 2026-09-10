/**
 * Upload file-handle cache and byte-range tracking for parallel chunk uploads.
 * Keeps file descriptors open during active uploads and defers metadata writes.
 */

const fs = require('fs').promises;
const logger = require('./logger');

/** @type {Map<string, { handle: import('fs').promises.FileHandle, lastUsed: number, chunksSinceMeta: number }>} */
const activeHandles = new Map();

const HANDLE_IDLE_MS = 60 * 1000;
const META_WRITE_INTERVAL_CHUNKS = 5;

let handleCleanupInterval;

/**
 * Merge a new byte range into sorted, non-overlapping ranges.
 * @param {Array<[number, number]>} ranges
 * @param {number} start
 * @param {number} end
 * @returns {Array<[number, number]>}
 */
function mergeRange(ranges, start, end) {
  const next = [...ranges, [start, end]].sort((a, b) => a[0] - b[0]);
  const merged = [];

  for (const range of next) {
    if (!merged.length) {
      merged.push(range);
      continue;
    }

    const last = merged[merged.length - 1];
    if (range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push(range);
    }
  }

  return merged;
}

/**
 * Sum bytes covered by merged ranges.
 * @param {Array<[number, number]>} ranges
 * @returns {number}
 */
function totalRangeBytes(ranges) {
  return ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
}

/**
 * Open or reuse a cached file handle for an upload session.
 * @param {string} uploadId
 * @param {string} partialFilePath
 * @returns {Promise<import('fs').promises.FileHandle>}
 */
async function getUploadHandle(uploadId, partialFilePath) {
  const existing = activeHandles.get(uploadId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.handle;
  }

  const handle = await fs.open(partialFilePath, 'r+');
  activeHandles.set(uploadId, {
    handle,
    lastUsed: Date.now(),
    chunksSinceMeta: 0
  });

  return handle;
}

/**
 * Close and remove a cached upload handle.
 * @param {string} uploadId
 */
async function releaseUploadHandle(uploadId) {
  const entry = activeHandles.get(uploadId);
  if (!entry) return;

  activeHandles.delete(uploadId);
  try {
    await entry.handle.close();
  } catch (err) {
    logger.warn(`Failed to close upload handle for ${uploadId}: ${err.message}`);
  }
}

/**
 * Track whether metadata should be flushed to disk on this chunk.
 * @param {string} uploadId
 * @param {boolean} force
 * @returns {boolean}
 */
function shouldPersistMetadata(uploadId, force = false) {
  const entry = activeHandles.get(uploadId);
  if (!entry) return true;

  entry.chunksSinceMeta += 1;
  entry.lastUsed = Date.now();

  if (force || entry.chunksSinceMeta >= META_WRITE_INTERVAL_CHUNKS) {
    entry.chunksSinceMeta = 0;
    return true;
  }

  return false;
}

function startHandleCleanup() {
  if (handleCleanupInterval) clearInterval(handleCleanupInterval);

  handleCleanupInterval = setInterval(async () => {
    const now = Date.now();
    for (const [uploadId, entry] of activeHandles.entries()) {
      if (now - entry.lastUsed < HANDLE_IDLE_MS) continue;
      await releaseUploadHandle(uploadId);
    }
  }, 30 * 1000);

  handleCleanupInterval.unref();
}

function stopHandleCleanup() {
  if (handleCleanupInterval) {
    clearInterval(handleCleanupInterval);
    handleCleanupInterval = null;
  }
}

if (!process.env.DISABLE_BATCH_CLEANUP) {
  startHandleCleanup();
}

module.exports = {
  mergeRange,
  totalRangeBytes,
  getUploadHandle,
  releaseUploadHandle,
  shouldPersistMetadata,
  startHandleCleanup,
  stopHandleCleanup
};
