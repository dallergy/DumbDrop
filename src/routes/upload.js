/**
 * File upload route handlers and batch upload management.
 * Streams chunks straight from the socket to disk at any offset so a client
 * can push several chunks of one file in parallel and saturate the link.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises; // Use promise-based fs
const fsSync = require('fs'); // For sync checks like existsSync
const { config } = require('../config');
const logger = require('../utils/logger');
const { getUniqueFolderPath, sanitizePathPreserveDirsSafe, isValidBatchId, isPathWithinUploadDir } = require('../utils/fileUtils');
const { sendNotification } = require('../services/notifications');
const { isDemoMode } = require('../utils/demoMode');
const { mergeRange, coveredBytes, firstGap, isComplete, missingRanges } = require('../utils/byteRanges');

// --- Persistence Setup ---
const METADATA_DIR = path.join(config.uploadDir, '.metadata');

// --- In-Memory Maps (Still useful for session-level data) ---
// Store folder name mappings for batch uploads (avoids FS lookups during session)
const folderMappings = new Map();
// In-flight mapping resolutions, so parallel inits of one batch share a folder
const folderMappingPending = new Map();
// Store batch activity timestamps (for cleaning up stale batches/folder mappings)
const batchActivity = new Map();

const BATCH_TIMEOUT = 30 * 60 * 1000; // 30 minutes for batch/folderMapping cleanup
// Chunks are streamed to disk, so this only bounds how much a single retry
// costs the client, not server memory.
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
// Coalesce socket reads into larger positional writes to cut syscalls ~50x
const WRITE_COALESCE_BYTES = 1024 * 1024;
// Browsers open at most 6 connections per host; allow a little headroom
const MAX_INFLIGHT_PER_UPLOAD = 8;
const META_FLUSH_INTERVAL_MS = 2000;
const META_FLUSH_BYTES = 32 * 1024 * 1024;
// Remember finished uploads briefly so late duplicate/retried chunks get a
// clean "complete" answer instead of a confusing 404.
const COMPLETED_TTL_MS = 5 * 60 * 1000;

// Keep partial-file handles open across chunks to avoid open/close per chunk
const openHandles = new Map();
const metadataCache = new Map();
const recentlyCompleted = new Map();

// --- Helper Functions for Metadata ---

async function readUploadMetadata(uploadId) {
  if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
    logger.warn(`Attempted to read metadata with invalid uploadId: ${uploadId}`);
    return null;
  }
  const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
  try {
    const data = await fs.readFile(metaFilePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null; // Metadata file doesn't exist - normal case for new/finished uploads
    }
    logger.error(`Error reading metadata for ${uploadId}: ${err.message}`);
    throw err; // Rethrow other errors
  }
}

async function writeUploadMetadata(uploadId, metadata) {
  if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
    logger.error(`Attempted to write metadata with invalid uploadId: ${uploadId}`);
    return; // Prevent writing
  }
  const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
  metadata.lastActivity = Date.now(); // Update timestamp on every write
  const tempMetaPath = `${metaFilePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  // Runtime-only fields (inflight counters, flags) must not be persisted
  const { inflight, finalizing, ...persistable } = metadata; // eslint-disable-line no-unused-vars
  try {
    // Write atomically if possible (write to temp then rename) for more safety
    await fs.mkdir(METADATA_DIR, { recursive: true });
    await fs.writeFile(tempMetaPath, JSON.stringify(persistable, null, 2));
    await fs.rename(tempMetaPath, metaFilePath);
  } catch (err) {
    logger.error(`Error writing metadata for ${uploadId}: ${err.message}`);
    // Attempt to clean up temp file if rename failed
    try { await fs.unlink(tempMetaPath); } catch {/* ignore */}
    throw err;
  }
}

function publicErrorDetails(err) {
  return config.nodeEnv === 'development' ? err.message : undefined;
}

/**
 * Read the chunk offset from X-Chunk-Offset or a Content-Range header.
 * Returns null when the header is present but malformed.
 */
function parseChunkOffset(req, fallback) {
  const header = req.headers['x-chunk-offset'] || req.headers['content-range'];
  if (header === undefined) return fallback;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bytes ')) {
    const start = Number(header.slice(6).split('-')[0]);
    return Number.isInteger(start) && start >= 0 ? start : null;
  }
  const offset = Number(header);
  return Number.isInteger(offset) && offset >= 0 ? offset : null;
}

/**
 * Metadata written by older versions only tracked a contiguous byte count.
 * Upgrade it in place to the range list used for parallel chunks.
 */
function ensureRanges(metadata) {
  if (!Array.isArray(metadata.ranges)) {
    metadata.ranges = metadata.bytesReceived > 0 ? [[0, metadata.bytesReceived]] : [];
  }
  if (typeof metadata.inflight !== 'number') metadata.inflight = 0;
  return metadata;
}

/**
 * Resolve (and create) the on-disk folder for a batch's top-level folder.
 * Parallel clients fire many inits at once; without a shared promise each
 * one would race mkdir and scatter files across "folder (1)", "folder (2)"...
 */
function resolveBatchFolder(originalFolderName, batchId) {
  const key = `${originalFolderName}-${batchId}`;
  const known = folderMappings.get(key);
  if (known) return Promise.resolve(known);
  let pending = folderMappingPending.get(key);
  if (pending) return pending;

  pending = (async () => {
    const baseFolderPath = path.join(config.uploadDir, originalFolderName);
    await fs.mkdir(path.dirname(baseFolderPath), { recursive: true });
    let newFolderName;
    try {
      await fs.mkdir(baseFolderPath, { recursive: false });
      newFolderName = originalFolderName;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const uniqueFolderPath = await getUniqueFolderPath(baseFolderPath);
      newFolderName = path.basename(uniqueFolderPath);
      logger.info(`Folder "${originalFolderName}" exists or conflict, using unique "${newFolderName}" for batch ${batchId}`);
    }
    folderMappings.set(key, newFolderName);
    return newFolderName;
  })().finally(() => folderMappingPending.delete(key));

  folderMappingPending.set(key, pending);
  return pending;
}

function progressOf(metadata) {
  if (metadata.fileSize === 0) return 100;
  return Math.min(Math.round((metadata.bytesReceived / metadata.fileSize) * 100), 100);
}

function statusPayload(metadata) {
  return {
    uploadId: metadata.uploadId,
    fileSize: metadata.fileSize,
    bytesReceived: metadata.bytesReceived,
    progress: progressOf(metadata),
    ranges: metadata.ranges,
    missing: missingRanges(metadata.ranges, metadata.fileSize),
    complete: isComplete(metadata.ranges, metadata.fileSize),
  };
}

function rememberCompleted(uploadId, fileSize) {
  recentlyCompleted.set(uploadId, { fileSize, at: Date.now() });
  const timer = setTimeout(() => recentlyCompleted.delete(uploadId), COMPLETED_TTL_MS);
  timer.unref();
}

function completedPayload(uploadId, entry) {
  return {
    uploadId,
    fileSize: entry.fileSize,
    bytesReceived: entry.fileSize,
    progress: 100,
    ranges: [[0, entry.fileSize]],
    missing: [],
    complete: true,
  };
}

async function getFileHandle(uploadId, partialFilePath) {
  const existing = openHandles.get(uploadId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.handle;
  }
  const handle = await fs.open(partialFilePath, 'r+');
  openHandles.set(uploadId, { handle, lastUsed: Date.now() });
  return handle;
}

async function closeFileHandle(uploadId) {
  const existing = openHandles.get(uploadId);
  if (!existing) return;
  openHandles.delete(uploadId);
  try {
    await existing.handle.close();
  } catch (err) {
    if (err.code !== 'ERR_INVALID_ARG_VALUE') {
      logger.debug(`Handle close for ${uploadId}: ${err.message}`);
    }
  }
}

async function closeAllFileHandles() {
  const ids = [...openHandles.keys()];
  await Promise.all(ids.map((id) => closeFileHandle(id)));
}

async function getCachedMetadata(uploadId) {
  if (metadataCache.has(uploadId)) {
    return metadataCache.get(uploadId);
  }
  const metadata = await readUploadMetadata(uploadId);
  if (metadata) metadataCache.set(uploadId, ensureRanges(metadata));
  return metadata;
}

async function persistMetadata(uploadId, metadata, { force = false } = {}) {
  metadataCache.set(uploadId, metadata);
  const last = metadata.lastPersistedAt || 0;
  const bytesSince = metadata.bytesReceived - (metadata.lastPersistedBytes || 0);
  if (!force && Date.now() - last < META_FLUSH_INTERVAL_MS && bytesSince < META_FLUSH_BYTES) {
    return;
  }
  metadata.lastPersistedAt = Date.now();
  metadata.lastPersistedBytes = metadata.bytesReceived;
  await writeUploadMetadata(uploadId, metadata);
}

async function forgetUpload(uploadId) {
  metadataCache.delete(uploadId);
  await closeFileHandle(uploadId);
}

async function deleteUploadMetadata(uploadId) {
  if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
    logger.warn(`Attempted to delete metadata with invalid uploadId: ${uploadId}`);
    return;
  }
  const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
  try {
    await fs.unlink(metaFilePath);
    logger.debug(`Deleted metadata file for upload: ${uploadId}.meta`);
  } catch (err) {
    if (err.code !== 'ENOENT') { // Ignore if already deleted
      logger.error(`Error deleting metadata file ${uploadId}.meta: ${err.message}`);
    }
  }
}

/**
 * Move the finished .partial file into place and clean up session state.
 * Only called once all in-flight chunk requests for the upload have drained.
 */
async function finalizeUpload(uploadId, metadata) {
  metadata.finalizing = true;
  await closeFileHandle(uploadId);
  metadataCache.delete(uploadId);
  rememberCompleted(uploadId, metadata.fileSize);
  try {
    await fs.rename(metadata.partialFilePath, metadata.filePath);
    logger.success(`Upload completed and finalized: ${metadata.originalFilename} as ${metadata.filePath} (${metadata.fileSize} bytes)`);
    await deleteUploadMetadata(uploadId);
    sendNotification(metadata.originalFilename, metadata.fileSize, config);
  } catch (renameErr) {
    if (renameErr.code === 'ENOENT') {
      logger.warn(`Partial file ${metadata.partialFilePath} not found during finalization for ${uploadId}.`);
      await deleteUploadMetadata(uploadId).catch(() => {});
    } else {
      logger.error(`CRITICAL: Failed to rename partial file ${metadata.partialFilePath} to ${metadata.filePath}: ${renameErr.message}`);
    }
  }
}

// --- Batch Cleanup (Focuses on batchActivity map, not primary upload state) ---
let batchCleanupInterval;
function startBatchCleanup() {
  if (batchCleanupInterval) clearInterval(batchCleanupInterval);
  batchCleanupInterval = setInterval(() => {
    const now = Date.now();
    logger.info(`Running batch cleanup, checking ${batchActivity.size} active batch sessions`);
    let cleanedCount = 0;
    for (const [batchId, lastActivity] of batchActivity.entries()) {
      if (now - lastActivity >= BATCH_TIMEOUT) {
        logger.info(`Cleaning up inactive batch session: ${batchId}`);
        batchActivity.delete(batchId);
        // Clean up associated folder mappings for this batch
        for (const key of folderMappings.keys()) {
          if (key.endsWith(`-${batchId}`)) {
            folderMappings.delete(key);
          }
        }
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) logger.info(`Cleaned up ${cleanedCount} inactive batch sessions.`);
  }, 5 * 60 * 1000); // Check every 5 minutes
  batchCleanupInterval.unref(); // Allow process to exit if this is the only timer
  return batchCleanupInterval;
}
function stopBatchCleanup() {
  if (batchCleanupInterval) {
    clearInterval(batchCleanupInterval);
    batchCleanupInterval = null;
  }
}
if (!process.env.DISABLE_BATCH_CLEANUP) {
  startBatchCleanup();
}

// --- Routes ---

// Initialize upload
router.post('/init', async (req, res) => {
  // DEMO MODE CHECK - Bypass persistence if in demo mode
  if (isDemoMode()) {
    const { filename, fileSize } = req.body;
    const sanitizedDemoFilename = sanitizePathPreserveDirsSafe(filename);
    const uploadId = 'demo-' + crypto.randomBytes(16).toString('hex');
    
    // Log if the filename was changed during sanitization
    if (filename !== sanitizedDemoFilename) {
      logger.info(`[DEMO] Filename sanitized: "${filename}" -> "${sanitizedDemoFilename}"`);
    }
    
    logger.info(`[DEMO] Initialized upload for ${sanitizedDemoFilename} (${fileSize} bytes) with ID ${uploadId}`);
    // Simulate zero-byte completion for demo
    if (Number(fileSize) === 0) {
      logger.success(`[DEMO] Completed zero-byte file upload: ${sanitizedDemoFilename}`);
      sendNotification(sanitizedDemoFilename, 0, config); // Still send notification if configured
    }
    return res.json({ uploadId, maxChunkBytes: MAX_CHUNK_BYTES });
  }

  const { filename, fileSize } = req.body;
  const clientBatchId = req.headers['x-batch-id'];

  // --- Basic validations ---
  if (!filename) return res.status(400).json({ error: 'Missing filename' });
  if (fileSize === undefined || fileSize === null) return res.status(400).json({ error: 'Missing fileSize' });
  const size = Number(fileSize);
  if (isNaN(size) || size < 0) return res.status(400).json({ error: 'Invalid file size' });
  const maxSizeInBytes = config.maxFileSize;
  if (size > maxSizeInBytes) return res.status(413).json({ error: 'File too large', limit: maxSizeInBytes });

  const batchId = clientBatchId || `${Date.now()}-${crypto.randomBytes(4).toString('hex').substring(0, 9)}`;
  if (clientBatchId && !isValidBatchId(batchId)) return res.status(400).json({ error: 'Invalid batch ID format' });
  batchActivity.set(batchId, Date.now()); // Track batch session activity

  try {
    // --- Path handling and Sanitization ---
    const sanitizedFilename = sanitizePathPreserveDirsSafe(filename);
    const safeFilename = path.normalize(sanitizedFilename)
      .replace(/^(\.\.(\/|\\|$))+/, '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    
    // Log if the filename was changed during sanitization
    if (filename !== safeFilename) {
      logger.info(`Upload filename sanitized: "${filename}" -> "${safeFilename}"`);
    } else {
      logger.info(`Upload init request for: ${safeFilename}`);
    }

    // --- Extension Check ---
    if (config.allowedExtensions) {
      const fileExt = path.extname(safeFilename).toLowerCase();
      if (fileExt && !config.allowedExtensions.includes(fileExt)) {
        logger.warn(`File type not allowed: ${safeFilename} (Extension: ${fileExt})`);
        return res.status(400).json({ error: 'File type not allowed', receivedExtension: fileExt });
      }
    }

    // --- Determine Paths & Handle Folders ---
    const uploadId = crypto.randomBytes(16).toString('hex');
    let finalFilePath = path.join(config.uploadDir, safeFilename);
    
    // Validate that the constructed path is within the upload directory
    if (!isPathWithinUploadDir(finalFilePath, config.uploadDir, false)) {
      logger.error(`Path traversal detected in upload init: ${safeFilename} -> ${finalFilePath}`);
      return res.status(403).json({ error: 'Invalid file path' });
    }
    
    const pathParts = safeFilename.split('/').filter(Boolean);

    if (pathParts.length > 1) {
      pathParts[0] = await resolveBatchFolder(pathParts[0], batchId);
      finalFilePath = path.join(config.uploadDir, ...pathParts);
      
      // Validate the updated path
      if (!isPathWithinUploadDir(finalFilePath, config.uploadDir, false)) {
        logger.error(`Path traversal detected after folder mapping: ${pathParts.join('/')} -> ${finalFilePath}`);
        return res.status(403).json({ error: 'Invalid file path' });
      }
      
      await fs.mkdir(path.dirname(finalFilePath), { recursive: true });
    } else {
      await fs.mkdir(config.uploadDir, { recursive: true }); // Ensure base upload dir exists
    }

    // --- Check Final Path Collision & Get Unique Name if Needed ---
    let checkPath = finalFilePath;
    let counter = 1;
    while (fsSync.existsSync(checkPath)) {
      logger.warn(`Final destination file already exists: ${checkPath}. Generating unique name.`);
      const dir = path.dirname(finalFilePath);
      const ext = path.extname(finalFilePath);
      const baseName = path.basename(finalFilePath, ext);
      checkPath = path.join(dir, `${baseName} (${counter})${ext}`);
      counter++;
    }
    if (checkPath !== finalFilePath) {
      logger.info(`Using unique final path: ${checkPath}`);
      finalFilePath = checkPath;
      
      // Validate the unique path
      if (!isPathWithinUploadDir(finalFilePath, config.uploadDir, false)) {
        logger.error(`Path traversal detected in unique path: ${finalFilePath}`);
        return res.status(403).json({ error: 'Invalid file path' });
      }
      
      // If path changed, ensure directory exists (might be needed if baseName contained '/')
      await fs.mkdir(path.dirname(finalFilePath), { recursive: true });
    }

    const partialFilePath = finalFilePath + '.partial';
    
    // Validate the partial file path as well
    if (!isPathWithinUploadDir(partialFilePath, config.uploadDir, false)) {
      logger.error(`Path traversal detected in partial path: ${partialFilePath}`);
      return res.status(403).json({ error: 'Invalid file path' });
    }

    // --- Create and Persist Metadata ---
    const metadata = {
      uploadId,
      originalFilename: safeFilename, // Store the path as received by client
      filePath: finalFilePath, // The final, possibly unique, path
      partialFilePath,
      fileSize: size,
      bytesReceived: 0,
      ranges: [],
      batchId,
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    await writeUploadMetadata(uploadId, metadata);
    metadataCache.set(uploadId, ensureRanges(metadata));
    logger.info(`Initialized persistent upload: ${uploadId} for ${safeFilename} -> ${finalFilePath}`);

    if (size > 0) {
      await fs.writeFile(partialFilePath, '');
    }

    // --- Handle Zero-Byte Files --- // (Important: Handle *after* metadata potentially exists)
    if (size === 0) {
      try {
        await fs.writeFile(finalFilePath, ''); // Create the empty file
        logger.success(`Completed zero-byte file upload: ${metadata.originalFilename} as ${finalFilePath}`);
        await deleteUploadMetadata(uploadId); // Clean up metadata since it's done
        metadataCache.delete(uploadId);
        rememberCompleted(uploadId, 0);
        sendNotification(metadata.originalFilename, 0, config);
      } catch (writeErr) {
        logger.error(`Failed to create zero-byte file ${finalFilePath}: ${writeErr.message}`);
        await deleteUploadMetadata(uploadId).catch(() => {}); // Attempt cleanup on error
        throw writeErr; // Let the main catch block handle it
      }
    }

    res.json({ uploadId, maxChunkBytes: MAX_CHUNK_BYTES });

  } catch (err) {
    logger.error(`Upload initialization failed: ${err.message} ${err.stack}`);
    return res.status(500).json({ error: 'Failed to initialize upload', details: publicErrorDetails(err) });
  }
});

// Upload status (lets a client resume or verify which byte ranges are missing)
router.get('/status/:uploadId', async (req, res) => {
  const { uploadId } = req.params;
  if (isDemoMode()) {
    return res.json({ uploadId, complete: true, progress: 100, bytesReceived: 0, ranges: [], missing: [] });
  }
  try {
    const metadata = await getCachedMetadata(uploadId);
    if (metadata) return res.json(statusPayload(metadata));
    const done = recentlyCompleted.get(uploadId);
    if (done) return res.json(completedPayload(uploadId, done));
    return res.status(404).json({ error: 'Upload session not found' });
  } catch (err) {
    logger.error(`Status lookup failed for ${uploadId}: ${err.message}`);
    res.status(500).json({ error: 'Failed to read upload status' });
  }
});

/**
 * Discard whatever is left of the request body, then answer.
 * Prevents connection resets when we reject a chunk before reading it.
 */
function reject(req, res, status, body) {
  req.resume();
  return res.status(status).json(body);
}

// Upload chunk — body is streamed directly to disk at the requested offset.
router.post('/chunk/:uploadId', async (req, res) => {
  const { uploadId } = req.params;

  if (isDemoMode()) {
    logger.debug(`[DEMO] Received chunk for ${uploadId}`);
    const demoProgress = Math.min(100, Math.random() * 100);
    return reject(req, res, 200, { bytesReceived: 0, progress: demoProgress, complete: false });
  }

  const clientBatchId = req.headers['x-batch-id'];
  const declaredLength = Number(req.headers['content-length']);
  if (declaredLength === 0) return reject(req, res, 400, { error: 'Empty chunk received' });
  if (declaredLength > MAX_CHUNK_BYTES) {
    return reject(req, res, 413, { error: 'Chunk too large', limit: MAX_CHUNK_BYTES });
  }

  let metadata;
  try {
    metadata = await getCachedMetadata(uploadId);
  } catch (err) {
    logger.error(`Chunk metadata lookup failed for ${uploadId}: ${err.message}`);
    return reject(req, res, 500, { error: 'Failed to process chunk', details: publicErrorDetails(err) });
  }

  if (!metadata) {
    const done = recentlyCompleted.get(uploadId);
    if (done) return reject(req, res, 200, completedPayload(uploadId, done));
    logger.warn(`Upload metadata not found for chunk request: ${uploadId}. Client Batch ID: ${clientBatchId || 'none'}.`);
    return reject(req, res, 404, { error: 'Upload session not found or already completed' });
  }

  if (metadata.batchId && isValidBatchId(metadata.batchId)) {
    batchActivity.set(metadata.batchId, Date.now());
  }

  if (metadata.finalizing || isComplete(metadata.ranges, metadata.fileSize)) {
    return reject(req, res, 200, statusPayload(metadata));
  }

  const offset = parseChunkOffset(req, firstGap(metadata.ranges, metadata.fileSize));
  if (offset === null) return reject(req, res, 400, { error: 'Invalid chunk offset' });
  if (offset >= metadata.fileSize) {
    return reject(req, res, 400, { error: 'Chunk offset beyond end of file', fileSize: metadata.fileSize });
  }
  if (Number.isFinite(declaredLength) && offset + declaredLength > metadata.fileSize) {
    return reject(req, res, 400, { error: 'Chunk exceeds file size', fileSize: metadata.fileSize, offset });
  }
  if (metadata.inflight >= MAX_INFLIGHT_PER_UPLOAD) {
    res.set('Retry-After', '1');
    return reject(req, res, 429, { error: 'Too many parallel chunks for this upload', limit: MAX_INFLIGHT_PER_UPLOAD });
  }

  metadata.inflight += 1;
  let written = 0;
  let pending = [];
  let pendingBytes = 0;
  let responded = false;

  try {
    const fileHandle = await getFileHandle(uploadId, metadata.partialFilePath);

    const flush = async () => {
      if (!pendingBytes) return;
      const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      const result = await fileHandle.write(buf, 0, buf.length, offset + written);
      if (result.bytesWritten !== buf.length) {
        throw new Error(`Short write for ${uploadId}: expected ${buf.length}, wrote ${result.bytesWritten}`);
      }
      written += result.bytesWritten;
    };

    // Only chunked-encoded bodies (no Content-Length) can trip these limits
    // mid-stream. Keep draining instead of breaking so the socket stays clean.
    for await (const piece of req) {
      if (responded) continue;
      const total = written + pendingBytes + piece.length;
      if (total > MAX_CHUNK_BYTES) {
        responded = true;
        pending = [];
        pendingBytes = 0;
        res.status(413).json({ error: 'Chunk too large', limit: MAX_CHUNK_BYTES });
        continue;
      }
      if (offset + total > metadata.fileSize) {
        responded = true;
        pending = [];
        pendingBytes = 0;
        res.status(400).json({ error: 'Chunk exceeds file size', fileSize: metadata.fileSize, offset });
        continue;
      }
      pending.push(piece);
      pendingBytes += piece.length;
      if (pendingBytes >= WRITE_COALESCE_BYTES) await flush();
    }
    if (!responded) await flush();
  } catch (err) {
    // Bytes already flushed are valid on disk, so still record them below.
    // req.complete is false when the client dropped mid-body; nobody is
    // listening for a response in that case.
    if (req.complete && !res.headersSent) {
      logger.error(`Chunk upload failed for ${uploadId}: ${err.message} ${err.stack}`);
      responded = true;
      res.status(500).json({ error: 'Failed to process chunk', details: publicErrorDetails(err) });
    } else if (!req.complete) {
      logger.debug(`Chunk connection dropped for ${uploadId} after ${written} bytes at offset ${offset}`);
      responded = true;
    }
  }

  if (written > 0) {
    metadata.ranges = mergeRange(metadata.ranges, offset, offset + written);
    metadata.bytesReceived = coveredBytes(metadata.ranges);
    logger.debug(`Chunk written for ${uploadId}: [${offset}, ${offset + written}) -> ${metadata.bytesReceived}/${metadata.fileSize}`);
  }
  metadata.inflight -= 1;

  const complete = isComplete(metadata.ranges, metadata.fileSize);
  if (metadata.finalizing) {
    // Cancelled (or already finalized) while this chunk was in flight
  } else if (complete && metadata.inflight === 0) {
    await finalizeUpload(uploadId, metadata);
  } else if (!complete && written > 0) {
    await persistMetadata(uploadId, metadata).catch((err) => {
      logger.error(`Metadata persist failed for ${uploadId}: ${err.message}`);
    });
  }

  if (!responded) {
    res.json(statusPayload(metadata));
  }
});

// Cancel upload
router.post('/cancel/:uploadId', async (req, res) => {
  // DEMO MODE CHECK
  if (isDemoMode()) {
    logger.info(`[DEMO] Upload cancelled: ${req.params.uploadId}`);
    return res.json({ message: 'Upload cancelled (Demo)' });
  }

  const { uploadId } = req.params;
  logger.info(`Received cancel request for upload: ${uploadId}`);

  try {
    const metadata = await getCachedMetadata(uploadId);

    if (metadata) {
      metadata.finalizing = true; // Stops in-flight chunks from finalizing a cancelled upload
      await forgetUpload(uploadId);
      // Delete partial file first
      try {
        await fs.unlink(metadata.partialFilePath);
        logger.info(`Deleted partial file on cancellation: ${metadata.partialFilePath}`);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') { // Ignore if already gone
          logger.error(`Failed to delete partial file ${metadata.partialFilePath} on cancel: ${unlinkErr.message}`);
        }
      }
      // Then delete metadata file
      await deleteUploadMetadata(uploadId);
      logger.info(`Upload cancelled and cleaned up: ${uploadId} (${metadata.originalFilename})`);
    } else {
      logger.warn(`Cancel request for non-existent or already completed upload: ${uploadId}`);
    }

    res.json({ message: 'Upload cancelled or already complete' });
  } catch (err) {
    logger.error(`Error during upload cancellation for ${uploadId}: ${err.message}`);
    res.status(500).json({ error: 'Failed to cancel upload' });
  }
});

module.exports = {
  router,
  startBatchCleanup,
  stopBatchCleanup,
  closeAllFileHandles,
  MAX_CHUNK_BYTES,
  // Export for testing if required
  readUploadMetadata,
  writeUploadMetadata,
  deleteUploadMetadata
};
