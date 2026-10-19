/**
 * File management and listing route handlers.
 * Provides endpoints for listing, downloading, and managing uploaded files.
 * Handles file metadata, stats, and directory operations.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const { config } = require('../config');
const logger = require('../utils/logger');
const {
  formatFileSize,
  sanitizeFilenameSafe,
  isPathWithinUploadDir,
} = require('../utils/fileUtils');
const { noteDeleted } = require('../utils/storageQuota');

/**
 * Safely encode filename for Content-Disposition header
 * Prevents header injection and handles special characters
 * @param {string} filename - The filename to encode
 * @returns {string} Properly formatted Content-Disposition value
 */
function createSafeContentDisposition(filename) {
  // Remove any path separators to ensure we only get the filename
  const basename = path.basename(filename);

  // Remove or replace characters that could cause issues
  // Remove control characters (0x00-0x1F, 0x7F) and quotes
  // eslint-disable-next-line no-control-regex
  const sanitized = basename.replace(/[\u0000-\u001F\u007F"\\]/g, '_');

  // For ASCII-only filenames, use simple format
  if (/^[\u0020-\u007E]*$/.test(sanitized)) {
    // Escape any remaining quotes and backslashes
    const escaped = sanitized.replace(/["\\]/g, '\\$&');
    return `attachment; filename="${escaped}"`;
  }

  // For filenames with non-ASCII characters, use RFC 5987 encoding
  // This provides better international character support
  const encoded = encodeURIComponent(sanitized);
  const asciiSafe = sanitized.replace(/[^\u0020-\u007E]/g, '_');

  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`;
}

/**
 * Express 5 named wildcards yield an array of decoded path segments.
 */
function splatPath(req) {
  const splat = req.params.splat;
  return Array.isArray(splat) ? splat.join('/') : String(splat || '');
}

/**
 * Reject lexical traversal and symlinks that point outside the upload dir.
 * Missing files that are lexically inside return 404 so a typo is not a 403.
 * @returns {Promise<boolean>} true when a response was already sent
 */
async function rejectUnsafeExistingPath(res, absolutePath, displayPath) {
  if (!isPathWithinUploadDir(absolutePath, config.uploadDir, false)) {
    logger.warn(`Blocked path outside upload directory: ${displayPath}`);
    res.status(403).json({ error: 'Access denied' });
    return true;
  }

  try {
    await fs.access(absolutePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
      return true;
    }
    throw err;
  }

  // requireExists follows the real path, so a symlink to outside is denied.
  if (!isPathWithinUploadDir(absolutePath, config.uploadDir, true)) {
    logger.warn(`Blocked symlink escape: ${displayPath}`);
    res.status(403).json({ error: 'Access denied' });
    return true;
  }
  return false;
}

/**
 * Get file information
 */
router.get('/info/*splat', async (req, res) => {
  const filePath = path.join(config.uploadDir, splatPath(req));

  try {
    if (await rejectUnsafeExistingPath(res, filePath, splatPath(req))) return;

    const stats = await fs.stat(filePath);
    const fileInfo = {
      filename: splatPath(req),
      size: stats.size,
      formattedSize: formatFileSize(stats.size),
      uploadDate: stats.mtime,
      mimetype: path.extname(splatPath(req)).slice(1),
      type: stats.isDirectory() ? 'directory' : 'file',
    };

    res.json(fileInfo);
  } catch (err) {
    logger.error(`Failed to get file info: ${err.message}`);
    res.status(404).json({ error: 'File not found' });
  }
});

/**
 * Download file
 */
router.get('/download/*splat', async (req, res) => {
  // Get the file path from the wildcard parameter
  const filePath = path.join(config.uploadDir, splatPath(req));
  const fileName = path.basename(splatPath(req));

  try {
    if (await rejectUnsafeExistingPath(res, filePath, splatPath(req))) return;

    // Set headers for download with safe Content-Disposition
    res.setHeader('Content-Disposition', createSafeContentDisposition(fileName));
    res.setHeader('Content-Type', 'application/octet-stream');

    // Stream the file
    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);

    // Handle errors during streaming
    fileStream.on('error', (err) => {
      logger.error(`File streaming error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      }
    });

    logger.info(`File download started: ${splatPath(req)}`);
  } catch (err) {
    logger.error(`File download failed: ${err.message}`);
    res.status(404).json({ error: 'File not found' });
  }
});

/**
 * List all files and folders recursively
 */
router.get('/', async (req, res) => {
  try {
    const items = await getDirectoryContents(config.uploadDir);

    // Calculate total size across all files
    const totalSize = calculateTotalSize(items);

    res.json({
      items: items,
      totalFiles: countFiles(items),
      totalSize: totalSize,
      formattedTotalSize: formatFileSize(totalSize),
    });
  } catch (err) {
    logger.error(`Failed to list files: ${err.message}`);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

/**
 * Recursively get directory contents
 */
async function getDirectoryContents(dirPath, relativePath = '') {
  const items = [];

  try {
    const entries = await fs.readdir(dirPath);

    for (const entry of entries) {
      // Skip metadata directory and hidden files
      if (entry === '.metadata' || entry.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dirPath, entry);
      const itemRelativePath = relativePath ? `${relativePath}/${entry}` : entry;

      try {
        const stats = await fs.stat(fullPath);

        if (stats.isDirectory()) {
          const subItems = await getDirectoryContents(fullPath, itemRelativePath);
          items.push({
            name: entry,
            type: 'directory',
            path: itemRelativePath,
            size: calculateTotalSize(subItems),
            formattedSize: formatFileSize(calculateTotalSize(subItems)),
            uploadDate: stats.mtime,
            children: subItems,
          });
        } else if (stats.isFile()) {
          items.push({
            name: entry,
            type: 'file',
            path: itemRelativePath,
            size: stats.size,
            formattedSize: formatFileSize(stats.size),
            uploadDate: stats.mtime,
            extension: path.extname(entry).toLowerCase(),
          });
        }
      } catch (statErr) {
        logger.error(`Failed to get stats for ${fullPath}: ${statErr.message}`);
        continue;
      }
    }

    // Sort items: directories first, then files, both alphabetically
    items.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    logger.error(`Failed to read directory ${dirPath}: ${err.message}`);
  }

  return items;
}

/**
 * Calculate total size of all files in a directory structure
 */
function calculateTotalSize(items) {
  return items.reduce((total, item) => {
    if (item.type === 'file') {
      return total + item.size;
    } else if (item.type === 'directory' && item.children) {
      return total + calculateTotalSize(item.children);
    }
    return total;
  }, 0);
}

/**
 * Count total number of files in a directory structure
 */
function countFiles(items) {
  return items.reduce((count, item) => {
    if (item.type === 'file') {
      return count + 1;
    } else if (item.type === 'directory' && item.children) {
      return count + countFiles(item.children);
    }
    return count;
  }, 0);
}

/**
 * Delete file or directory
 */
router.delete('/*splat', async (req, res) => {
  // Get the file/directory path from the wildcard parameter
  const itemPath = path.join(config.uploadDir, splatPath(req));

  try {
    if (await rejectUnsafeExistingPath(res, itemPath, splatPath(req))) return;

    const stats = await fs.stat(itemPath);

    if (stats.isDirectory()) {
      // Delete directory recursively
      await fs.rm(itemPath, { recursive: true, force: true });
      logger.info(`Directory deleted: ${splatPath(req)}`);
    } else {
      // Delete file
      await fs.unlink(itemPath);
      logger.info(`File deleted: ${splatPath(req)}`);
    }
    await noteDeleted();
    res.json({
      message: stats.isDirectory() ? 'Directory deleted successfully' : 'File deleted successfully',
    });
  } catch (err) {
    logger.error(`Deletion failed: ${err.message}`);
    res.status(err.code === 'ENOENT' ? 404 : 500).json({
      error: err.code === 'ENOENT' ? 'File or directory not found' : 'Failed to delete item',
    });
  }
});

/**
 * Rename file or directory
 */
router.put('/rename/*splat', async (req, res) => {
  const { newName } = req.body || {};

  if (!newName || typeof newName !== 'string' || newName.trim() === '') {
    return res.status(400).json({ error: 'New name is required' });
  }

  // Get the current file/directory path from the wildcard parameter
  const currentPath = path.join(config.uploadDir, splatPath(req));
  const currentDir = path.dirname(currentPath);

  try {
    if (await rejectUnsafeExistingPath(res, currentPath, splatPath(req))) return;

    const stats = await fs.stat(currentPath);

    // Sanitize the new name using our safe sanitization function
    const sanitizedNewName = sanitizeFilenameSafe(newName.trim());

    // Validate that sanitization didn't result in an empty filename
    if (!sanitizedNewName || sanitizedNewName.trim() === '') {
      logger.warn(`Rename rejected: sanitized filename is empty (original: "${newName}")`);
      return res.status(400).json({ error: 'Invalid or empty filename after sanitization' });
    }

    // Construct the new path
    const newPath = path.join(currentDir, sanitizedNewName);

    // The destination does not exist yet. requireExists=false still checks
    // that a symlink parent cannot land the new name outside the upload dir.
    if (!isPathWithinUploadDir(newPath, config.uploadDir, false)) {
      logger.warn(`Attempted to rename outside upload directory: ${newPath}`);
      return res.status(403).json({ error: 'Invalid destination path' });
    }

    // Check if a file/directory with the new name already exists
    try {
      await fs.access(newPath);
      return res.status(409).json({ error: 'A file or directory with that name already exists' });
    } catch (err) {
      // File doesn't exist, which is what we want
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    // Perform the rename operation
    await fs.rename(currentPath, newPath);

    // Log the operation
    const itemType = stats.isDirectory() ? 'Directory' : 'File';
    logger.info(`${itemType} renamed: "${splatPath(req)}" -> "${sanitizedNewName}"`);

    // Calculate relative path for response
    const relativePath = path.relative(config.uploadDir, newPath).replace(/\\/g, '/');

    res.json({
      message: `${itemType} renamed successfully`,
      oldName: path.basename(splatPath(req)),
      newName: sanitizedNewName,
      newPath: relativePath,
    });
  } catch (err) {
    logger.error(`Rename failed: ${err.message}`);
    res.status(err.code === 'ENOENT' ? 404 : 500).json({
      error: err.code === 'ENOENT' ? 'File or directory not found' : 'Failed to rename item',
    });
  }
});

module.exports = router;
