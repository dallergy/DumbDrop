/**
 * Storage quota for the upload directory (MAX_STORAGE_MB).
 *
 * used     - bytes of finished files, cached and refreshed every 30 s,
 *            after deletes, and when uploads complete.
 * reserved - declared size of every upload in progress, held from init
 *            until completion, cancel, or stale-session cleanup.
 * An init is refused (507) when used + reserved + new size > limit.
 *
 * Counted: user files only. App data under .metadata (upload state, share
 * list, cached share ZIPs) and *.partial files (covered by reservations) are
 * not, so downloading a shared folder can never make uploads fail.
 */

const fs = require('fs').promises;
const path = require('path');
const { config } = require('../config');
const logger = require('./logger');

const USED_TTL_MS = 30 * 1000;
const METADATA_DIR_NAME = '.metadata';

/** @type {Map<string, number>} uploadId -> declared size still reserved */
const reservations = new Map();
let seededFromDisk = false;

let usedBytes = 0;
let usedAt = 0;
let lockTail = Promise.resolve();

/**
 * Serialize quota changes so two inits cannot both pass the same check.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
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
 * Bytes of finished user files under target. Does not follow symlinks.
 * @param {string} target
 * @param {boolean} [isRoot]
 * @returns {Promise<number>}
 */
async function measureTreeBytes(target, isRoot = true) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return target.endsWith('.partial') ? 0 : stat.size;
  if (!stat.isDirectory()) return 0;

  let total = 0;
  for (const name of await fs.readdir(target)) {
    if (isRoot && name === METADATA_DIR_NAME) continue;
    total += await measureTreeBytes(path.join(target, name), false);
  }
  return total;
}

/**
 * Uploads still in progress from before a restart hold space too.
 * Read once; after that the in-memory map is kept up to date.
 */
async function seedReservationsFromDisk() {
  if (seededFromDisk) return;
  seededFromDisk = true;
  const metadataDir = path.join(config.uploadDir, METADATA_DIR_NAME);
  let names;
  try {
    names = await fs.readdir(metadataDir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  for (const name of names) {
    if (!name.endsWith('.meta')) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(metadataDir, name), 'utf8'));
      const id = typeof meta.uploadId === 'string' ? meta.uploadId : name.slice(0, -'.meta'.length);
      const size = Number(meta.fileSize);
      if (id && Number.isFinite(size) && size >= 0 && !reservations.has(id)) {
        reservations.set(id, size);
      }
    } catch (err) {
      logger.warn(`Skipping unreadable upload metadata ${name}: ${err.message}`);
    }
  }
}

function reservedTotal() {
  let total = 0;
  for (const size of reservations.values()) total += size;
  return total;
}

async function refreshUsedIfStale() {
  if (!usedAt || Date.now() - usedAt > USED_TTL_MS) {
    usedBytes = await measureTreeBytes(config.uploadDir);
    usedAt = Date.now();
  }
}

/**
 * Reserve space for an upload that has not been written yet.
 * @param {string} uploadId
 * @param {number} bytes
 * @returns {Promise<{ok: boolean, usedBytes?: number, reservedBytes?: number, limit?: number, freeBytes?: number}>}
 */
async function reserveStorage(uploadId, bytes) {
  return withQuotaLock(async () => {
    const size = Math.max(0, Number(bytes) || 0);
    if (!quotaEnabled()) {
      return { ok: true };
    }

    await seedReservationsFromDisk();
    await refreshUsedIfStale();

    const reservedBytes = reservedTotal();
    const freeBytes = Math.max(0, config.maxStorageBytes - usedBytes - reservedBytes);
    const status = { usedBytes, reservedBytes, limit: config.maxStorageBytes, freeBytes };
    if (size > freeBytes) {
      return { ok: false, ...status };
    }

    reservations.set(uploadId, size);
    return { ok: true, ...status, freeBytes: freeBytes - size };
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
 * Recompute the cached total after a delete so the next init sees the space.
 */
async function noteDeleted() {
  return withQuotaLock(async () => {
    if (!quotaEnabled()) return;
    usedBytes = await measureTreeBytes(config.uploadDir);
    usedAt = Date.now();
  });
}

/**
 * Current numbers for the UI. Null when there is no quota.
 * @returns {Promise<{limit: number, used: number, reserved: number, free: number}|null>}
 */
async function getStorageStatus() {
  if (!quotaEnabled()) return null;
  return withQuotaLock(async () => {
    await seedReservationsFromDisk();
    await refreshUsedIfStale();
    const reserved = reservedTotal();
    return {
      limit: config.maxStorageBytes,
      used: usedBytes,
      reserved,
      free: Math.max(0, config.maxStorageBytes - usedBytes - reserved),
    };
  });
}

module.exports = {
  reserveStorage,
  commitStored,
  releaseReservation,
  noteDeleted,
  measureTreeBytes,
  getStorageStatus,
};
