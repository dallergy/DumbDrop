/**
 * Cached ZIP archives for shared folders.
 *
 * - Only regular files and folders go in. Symlinks are skipped so a link
 *   inside a shared folder cannot pull in files from outside it, and hidden
 *   entries (".name") are skipped to match what the share page lists.
 * - The cache is rebuilt when anything in the folder tree changes, not just
 *   the top folder.
 * - Concurrent downloads share one build, and the archive is written to a
 *   temporary file and renamed, so nobody is served a half-written ZIP.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { ZipArchive } = require('archiver');
const { config } = require('../config');

/** @type {Map<string, Promise<string>>} token -> archive build in progress */
const building = new Map();

function archiveDir() {
  return path.join(config.uploadDir, '.metadata', 'share-archives');
}

function archivePath(token) {
  return path.join(archiveDir(), `${token}.zip`);
}

/**
 * Regular files and folders under dir, skipping symlinks and hidden names.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {Promise<{files: {abs: string, name: string}[], dirs: string[], newestMtimeMs: number}>}
 */
async function collectEntries(dir, prefix = '') {
  const result = { files: [], dirs: [], newestMtimeMs: (await fsp.lstat(dir)).mtimeMs };
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Dirent types come from lstat, so a symlink is never a file or directory here.
    if (entry.isDirectory()) {
      const child = await collectEntries(abs, name);
      result.dirs.push(name, ...child.dirs);
      result.files.push(...child.files);
      result.newestMtimeMs = Math.max(result.newestMtimeMs, child.newestMtimeMs);
    } else if (entry.isFile()) {
      const stat = await fsp.lstat(abs);
      result.files.push({ abs, name });
      result.newestMtimeMs = Math.max(result.newestMtimeMs, stat.mtimeMs);
    }
  }
  return result;
}

async function writeZip(entries, zipPath) {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  const temporary = `${zipPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(temporary, { mode: 0o600 });
      const archive = new ZipArchive({ zlib: { level: 6 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      for (const dir of entries.dirs) archive.append(null, { name: `${dir}/` });
      for (const file of entries.files) archive.file(file.abs, { name: file.name });
      archive.finalize();
    });
    await fsp.rename(temporary, zipPath);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
  return zipPath;
}

async function buildIfStale(token, sourceDir) {
  const zipPath = archivePath(token);
  const entries = await collectEntries(sourceDir);
  try {
    const zipStats = await fsp.stat(zipPath);
    if (zipStats.mtimeMs >= entries.newestMtimeMs) return zipPath;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return writeZip(entries, zipPath);
}

/**
 * Path to an up-to-date ZIP of sourceDir for this share token.
 * @param {string} token
 * @param {string} sourceDir
 * @returns {Promise<string>}
 */
function getOrCreateShareZip(token, sourceDir) {
  const pending = building.get(token);
  if (pending) return pending;
  const job = buildIfStale(token, sourceDir).finally(() => building.delete(token));
  building.set(token, job);
  return job;
}

async function deleteShareArchive(token) {
  await fsp.rm(archivePath(token), { force: true });
}

module.exports = {
  archiveDir,
  archivePath,
  collectEntries,
  getOrCreateShareZip,
  deleteShareArchive,
};
