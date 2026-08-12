/**
 * Cached ZIP archives for shared folders.
 * Builds once per share token and reuses until the share is deleted or expires.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ZipArchive } = require('archiver');
const { config } = require('../config');

function archiveDir() {
  return path.join(config.uploadDir, '.metadata', 'share-archives');
}

function archivePath(token) {
  return path.join(archiveDir(), `${token}.zip`);
}

async function ensureArchiveDir() {
  await fsp.mkdir(archiveDir(), { recursive: true });
}

async function createZipFromDirectory(sourceDir, zipPath) {
  await ensureArchiveDir();
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    output.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function getOrCreateShareZip(token, sourceDir) {
  const zipPath = archivePath(token);

  try {
    const [zipStats, sourceStats] = await Promise.all([
      fsp.stat(zipPath),
      fsp.stat(sourceDir),
    ]);
    if (zipStats.mtimeMs >= sourceStats.mtimeMs) {
      return zipPath;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fsp.rm(zipPath, { force: true });
  return createZipFromDirectory(sourceDir, zipPath);
}

async function deleteShareArchive(token) {
  await fsp.rm(archivePath(token), { force: true });
}

module.exports = {
  archiveDir,
  archivePath,
  getOrCreateShareZip,
  deleteShareArchive,
};
