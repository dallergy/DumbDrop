/**
 * Upload directory quota tracking and in-flight reservations.
 * Rejects new uploads that would exceed MAX_STORAGE_MB, including concurrent inits.
 * Refreshes a cached byte total instead of walking the disk on every request.
 */

const fs = require('fs').promises;
const path = require('path');
const { config } = require('../config');
const logger = require('./logger');

const USED_TTL_MS = 30 * 1000;
const METADATA_DIR_NAME = '.metadata';

/** @type {Map<string, number>} uploadId -> declared size still reserved */
const reservations = new Map();

let usedBytes = 0;
let usedAt = 0;
let lockTail = Promise.resolve();

/**
 * Serialize quota mutations so two inits cannot both pass the same check.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
function withQuotaLock(fn) {
  const run = lockTail.then(fn, fn);
  lockTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function quotaEnabled() {
  return config.maxStorageBytes > 0;
}

/**
 * Bytes currently stored, excluding in-progress *.partial files.
 * Those are covered by reservations of the declared size instead.
 * @param {string} target
 * @returns {Promise<number>}
 */
async function measureTreeBytes(target) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  // Do not follow links. Escaping symlinks are rejected elsewhere, and
  // counting the target would charge the quota for files we do not own.
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) {
    if (target.endsWith('.partial')) return 0;
    return stat.size;
  }
  if (!stat.isDirectory()) return 0;

  const names = await fs.readdir(target);
  let total = 0;
  for (const name of names) {
    total += await measureTreeBytes(path.join(target, name));
  }
  return total;
}

/**
 * Declared sizes of uploads that still have metadata on disk.
 * In-memory reservations win when both exist, so a session is counted once.
 * @returns {Promise<Map<string, number>>}
 */
async function reservationsFromDisk() {
  const found = new Map();
  const metadataDir = path.join(config.uploadDir, METADATA_DIR_NAME);
  let names;
  try {
    names = await fs.readdir(metadataDir);
  } catch (err) {
    if (err.code === 'ENOENT') return found;
    throw err;
  }

  for (const name of names) {
    if (!name.endsWith('.meta')) continue;
    try {
      const raw = await fs.readFile(path.join(metadataDir, name), 'utf8');
      const meta = JSON.parse(raw);
      const id = typeof meta.uploadId === 'string' ? meta.uploadId : name.slice(0, -'.meta'.length);
      const size = Number(meta.fileSize);
      if (!id || !Number.isFinite(size) || size < 0) continue;
      found.set(id, size);
    } catch (err) {
      logger.warn(`Skipping unreadable upload metadata ${name}: ${err.message}`);
    }
  }
  return found;
}

/**
 * @param {Map<string, number>} diskMap
 * @returns {number}
 */
function reservedTotal(diskMap) {
  const ids = new Set([...reservations.keys(), ...diskMap.keys()]);
  let total = 0;
  for (const id of ids) {
    total += reservations.has(id) ? reservations.get(id) : diskMap.get(id);
  }
  return total;
}

/**
 * Reserve `bytes` for an upload that has not been written yet.
 * @param {string} uploadId
 * @param {number} bytes
 * @returns {Promise<{ok: boolean, usedBytes?: number, reservedBytes?: number, limit?: number}>}
 */
async function reserveStorage(uploadId, bytes) {
  return withQuotaLock(async () => {
    const size = Math.max(0, Number(bytes) || 0);
    if (!quotaEnabled()) {
      reservations.set(uploadId, size);
      return { ok: true };
    }

    if (!usedAt || Date.now() - usedAt > USED_TTL_MS) {
      usedBytes = await measureTreeBytes(config.uploadDir);
      usedAt = Date.now();
    }

    const disk = await reservationsFromDisk();
    const reservedBytes = reservedTotal(disk);
    if (usedBytes + reservedBytes + size > config.maxStorageBytes) {
      return {
        ok: false,
        usedBytes,
        reservedBytes,
        limit: config.maxStorageBytes,
      };
    }

    reservations.set(uploadId, size);
    return { ok: true, usedBytes, reservedBytes, limit: config.maxStorageBytes };
  });
}

/**
 * The upload finished. Drop the reservation and count the stored bytes.
 * @param {string} uploadId
 * @param {number} bytes
 */
async function commitStored(uploadId, bytes) {
  return withQuotaLock(async () => {
    reservations.delete(uploadId);
    if (quotaEnabled() && usedAt) {
      usedBytes += Math.max(0, Number(bytes) || 0);
    }
  });
}

/**
 * The upload was cancelled or expired before completion.
 * @param {string} uploadId
 */
async function releaseReservation(uploadId) {
  return withQuotaLock(async () => {
    reservations.delete(uploadId);
  });
}

/**
 * Recompute the cached total after a delete. The next init must see the free space.
 */
async function noteDeleted() {
  return withQuotaLock(async () => {
    if (!quotaEnabled()) return;
    usedBytes = await measureTreeBytes(config.uploadDir);
    usedAt = Date.now();
  });
}

module.exports = {
  reserveStorage,
  commitStored,
  releaseReservation,
  noteDeleted,
  measureTreeBytes,
};
