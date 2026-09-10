/**
 * File upload route handlers and batch upload management.
 * Handles file uploads, chunked transfers, and folder creation.
 * Manages upload sessions using persistent metadata for resumability.
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

// --- Persistence Setup ---
const METADATA_DIR = path.join(config.uploadDir, '.metadata');

// --- In-Memory Maps (Still useful for session-level data) ---
// Store folder name mappings for batch uploads (avoids FS lookups during session)
const folderMappings = new Map();
// Store batch activity timestamps (for cleaning up stale batches/folder mappings)
const batchActivity = new Map();

const BATCH_TIMEOUT = 30 * 60 * 1000; // 30 minutes for batch/folderMapping cleanup
// 32MB is large enough for gigabit LAN without buffering a whole file in RAM
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const META_FLUSH_INTERVAL_MS = 2000;
const META_FLUSH_BYTES = 16 * 1024 * 1024;
// Keep partial-file handles open across chunks to avoid open/close + fsync per MB
const openHandles = new Map();
const metadataCache = new Map();

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
  try {
    // Write atomically if possible (write to temp then rename) for more safety
    await fs.mkdir(METADATA_DIR, { recursive: true });
    await fs.writeFile(tempMetaPath, JSON.stringify(metadata, null, 2));
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

function parseChunkOffset(req, fallback) {
  const header = req.headers['x-chunk-offset'] || req.headers['content-range'];
  if (!header) return fallback;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bytes ')) {
    const start = Number(header.slice(6).split('-')[0]);
    return Number.isFinite(start) && start >= 0 ? start : fallback;
  }
  const offset = Number(header);
  return Number.isFinite(offset) && offset >= 0 ? offset : fallback;
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
  if (metadata) metadataCache.set(uploadId, metadata);
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
    return res.json({ uploadId });
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
      const originalFolderName = pathParts[0];
      let newFolderName = folderMappings.get(`${originalFolderName}-${batchId}`);
      const baseFolderPath = path.join(config.uploadDir, newFolderName || originalFolderName);

      if (!newFolderName) {
        await fs.mkdir(path.dirname(baseFolderPath), { recursive: true });
        try {
          await fs.mkdir(baseFolderPath, { recursive: false });
          newFolderName = originalFolderName;
        } catch (err) {
          if (err.code === 'EEXIST') {
            const uniqueFolderPath = await getUniqueFolderPath(baseFolderPath);
            newFolderName = path.basename(uniqueFolderPath);
            logger.info(`Folder "${originalFolderName}" exists or conflict, using unique "${newFolderName}" for batch ${batchId}`);
            await fs.mkdir(path.join(config.uploadDir, newFolderName), { recursive: true });
          } else {
            throw err;
          }
        }
        folderMappings.set(`${originalFolderName}-${batchId}`, newFolderName);
      }
      pathParts[0] = newFolderName;
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
      batchId,
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    await writeUploadMetadata(uploadId, metadata);
    metadataCache.set(uploadId, metadata);
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
        sendNotification(metadata.originalFilename, 0, config);
      } catch (writeErr) {
        logger.error(`Failed to create zero-byte file ${finalFilePath}: ${writeErr.message}`);
        await deleteUploadMetadata(uploadId).catch(() => {}); // Attempt cleanup on error
        throw writeErr; // Let the main catch block handle it
      }
    }

    res.json({ uploadId });

  } catch (err) {
    logger.error(`Upload initialization failed: ${err.message} ${err.stack}`);
    return res.status(500).json({ error: 'Failed to initialize upload', details: publicErrorDetails(err) });
  }
});

// Upload chunk
router.post('/chunk/:uploadId', express.raw({
  limit: MAX_CHUNK_BYTES,
  type: 'application/octet-stream'
}), async (req, res) => {
  if (isDemoMode()) {
    const { uploadId } = req.params;
    logger.debug(`[DEMO] Received chunk for ${uploadId}`);
    const demoProgress = Math.min(100, Math.random() * 100);
    return res.json({ bytesReceived: 0, progress: demoProgress });
  }

  const { uploadId } = req.params;
  let chunk = req.body;
  let chunkSize = chunk.length;
  const clientBatchId = req.headers['x-batch-id'];

  if (!chunkSize) return res.status(400).json({ error: 'Empty chunk received' });
  if (chunkSize > MAX_CHUNK_BYTES) {
    return res.status(413).json({ error: 'Chunk too large', limit: MAX_CHUNK_BYTES });
  }

  try {
    const metadata = await getCachedMetadata(uploadId);

    if (!metadata) {
      logger.warn(`Upload metadata not found for chunk request: ${uploadId}. Client Batch ID: ${clientBatchId || 'none'}.`);
      return res.status(404).json({ error: 'Upload session not found or already completed' });
    }

    if (metadata.batchId && isValidBatchId(metadata.batchId)) {
      batchActivity.set(metadata.batchId, Date.now());
    }

    if (metadata.bytesReceived >= metadata.fileSize) {
      await forgetUpload(uploadId);
      try {
        await fs.access(metadata.filePath);
      } catch {
        try {
          await fs.rename(metadata.partialFilePath, metadata.filePath);
        } catch (renameErr) {
          if (renameErr.code !== 'ENOENT') {
            logger.error(`Error finalizing ${uploadId} on redundant chunk: ${renameErr.message}`);
          }
        }
      }
      await deleteUploadMetadata(uploadId);
      return res.json({ bytesReceived: metadata.fileSize, progress: 100 });
    }

    const offset = parseChunkOffset(req, metadata.bytesReceived);

    if (offset > metadata.bytesReceived) {
      return res.status(409).json({
        error: 'Chunk offset gap',
        bytesReceived: metadata.bytesReceived,
        expectedOffset: metadata.bytesReceived
      });
    }

    if (offset + chunkSize > metadata.fileSize) {
      const bytesToWrite = metadata.fileSize - offset;
      chunk = chunk.slice(0, bytesToWrite);
      chunkSize = chunk.length;
    }

    if (offset + chunkSize <= metadata.bytesReceived) {
      const progress = metadata.fileSize === 0 ? 100 :
        Math.min(Math.round((metadata.bytesReceived / metadata.fileSize) * 100), 100);
      return res.json({ bytesReceived: metadata.bytesReceived, progress });
    }

    const writeOffset = metadata.bytesReceived;
    const skip = writeOffset - offset;
    if (skip > 0) {
      chunk = chunk.slice(skip);
      chunkSize = chunk.length;
    }

    if (chunkSize > 0) {
      const fileHandle = await getFileHandle(uploadId, metadata.partialFilePath);
      const writeResult = await fileHandle.write(chunk, 0, chunkSize, writeOffset);
      if (writeResult.bytesWritten !== chunkSize) {
        logger.error(`Partial write for chunk ${uploadId}! Expected ${chunkSize}, wrote ${writeResult.bytesWritten}.`);
        throw new Error(`Failed to write full chunk for ${uploadId}`);
      }
      metadata.bytesReceived += writeResult.bytesWritten;
    }

    const progress = metadata.fileSize === 0 ? 100 :
      Math.min(Math.round((metadata.bytesReceived / metadata.fileSize) * 100), 100);

    logger.debug(`Chunk written for ${uploadId}: ${metadata.bytesReceived}/${metadata.fileSize} (${progress}%)`);

    if (metadata.bytesReceived >= metadata.fileSize) {
      await persistMetadata(uploadId, metadata, { force: true });
      await closeFileHandle(uploadId);
      logger.info(`Upload ${uploadId} (${metadata.originalFilename}) completed ${metadata.bytesReceived} bytes.`);
      try {
        await fs.rename(metadata.partialFilePath, metadata.filePath);
        logger.success(`Upload completed and finalized: ${metadata.originalFilename} as ${metadata.filePath} (${metadata.fileSize} bytes)`);
        await deleteUploadMetadata(uploadId);
        metadataCache.delete(uploadId);
        sendNotification(metadata.originalFilename, metadata.fileSize, config);
      } catch (renameErr) {
        if (renameErr.code === 'ENOENT') {
          logger.warn(`Partial file ${metadata.partialFilePath} not found during finalization for ${uploadId}.`);
          await deleteUploadMetadata(uploadId).catch(() => {});
          metadataCache.delete(uploadId);
        } else {
          logger.error(`CRITICAL: Failed to rename partial file ${metadata.partialFilePath} to ${metadata.filePath}: ${renameErr.message}`);
        }
      }
    } else {
      await persistMetadata(uploadId, metadata);
    }

    res.json({ bytesReceived: metadata.bytesReceived, progress });

  } catch (err) {
    logger.error(`Chunk upload failed for ${uploadId}: ${err.message} ${err.stack}`);
    res.status(500).json({ error: 'Failed to process chunk', details: publicErrorDetails(err) });
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
    const metadata = await readUploadMetadata(uploadId);

    if (metadata) {
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
  // Export for testing if required
  readUploadMetadata,
  writeUploadMetadata,
  deleteUploadMetadata
}; 