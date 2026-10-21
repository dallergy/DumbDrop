/**
 * Token-based file and folder sharing.
 *
 * Two routers, mounted separately in app.js:
 *   publicRouter - what a share link needs: view, QR, download, share PIN.
 *                  Mounted at /api/shares with no owner check.
 *   manageRouter - create, list, update, delete. Mounted only behind the
 *                  management guard (/api/files/share and /api/files/shares).
 * Keeping them apart means a management route can never be reached through
 * the public mount, whatever the URL looks like.
 */

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const QRCode = require('qrcode');
const { config } = require('../config');
const logger = require('../utils/logger');
const { safeCompare, isLockedOut, recordAttempt, resetAttempts } = require('../utils/security');
const { getClientIp } = require('../utils/ipExtractor');
const { sessionRole } = require('../utils/sessions');
const { secureCookie } = require('../middleware/security');
const { isPathWithinUploadDir, formatFileSize, checkUserPath } = require('../utils/fileUtils');
const { getOrCreateShareZip, deleteShareArchive } = require('../utils/shareArchives');

const publicRouter = express.Router();
const manageRouter = express.Router();
const storePath = path.join(config.uploadDir, '.metadata', 'shares.json');
const MAX_EXPIRY_SECONDS = 30 * 86400;
// crypto.randomBytes(18).toString('base64url') is 24 characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

async function readShares() {
  try {
    const parsed = JSON.parse(await fsp.readFile(storePath, 'utf8'));
    // A prototype-free object, so a token like "__proto__" is just a missing key.
    return Object.assign(Object.create(null), parsed);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return Object.create(null);
    }
    throw error;
  }
}

async function writeShares(shares) {
  await fsp.mkdir(path.dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(shares, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, storePath);
}

let storeTail = Promise.resolve();

/**
 * Read, change, and write the share store with no other change in between.
 * Concurrent creates and edits otherwise overwrite each other.
 * @template T
 * @param {(shares: Record<string, any>) => Promise<T>|T} mutate
 * @returns {Promise<T>}
 */
function updateShares(mutate) {
  const run = storeTail.then(async () => {
    const shares = await readShares();
    const result = await mutate(shares);
    await writeShares(shares);
    return result;
  });
  storeTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Look a share up by token. Returns null for malformed tokens.
 * @param {Record<string, any>} shares
 * @param {unknown} token
 */
function findShare(shares, token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  return Object.hasOwn(shares, token) ? shares[token] : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newGrant() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Seconds from a request body to an ISO expiry, or null for "never".
 * @param {unknown} value
 */
function expiryFrom(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + Math.min(seconds, MAX_EXPIRY_SECONDS) * 1000).toISOString();
}

/**
 * Share records returned to clients. The grant cookie secret stays server-side.
 */
function toShareResponse(share, extra = {}) {
  return {
    token: share.token,
    path: share.path,
    name: share.name,
    type: share.type,
    authRequired: share.authRequired,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    url: shareUrl(share.token),
    qrUrl: `/api/shares/${share.token}/qr.png`,
    ...extra,
  };
}

function shareUrl(token) {
  return new URL(`/share/${token}`, config.baseUrl).toString();
}

function isShareExpired(share) {
  return Boolean(share.expiresAt && Date.parse(share.expiresAt) <= Date.now());
}

async function renderShareQrPng(url, res) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  await QRCode.toFileStream(res, url, {
    type: 'png',
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#111827', light: '#ffffff' },
  });
}

/**
 * Whether this request may open a PIN-protected share.
 * The share PIN is DUMBDROP_PIN, so a signed-in session already proves it.
 */
function hasAccess(req, share) {
  if (!share.authRequired) {
    return true;
  }
  if (sessionRole(req)) {
    return true;
  }
  const grant = req.cookies?.[`DUMBDROP_SHARE_${share.token}`];
  return Boolean(share.grant && grant && safeCompare(grant, share.grant));
}

async function resolveShare(req, res, next) {
  try {
    const shares = await readShares();
    const share = findShare(shares, req.params.token);
    if (!share || isShareExpired(share)) {
      return res.status(404).json({ error: 'This share does not exist or has expired.' });
    }
    const checked = checkUserPath(share.path);
    const itemPath = checked.ok ? path.join(config.uploadDir, checked.path) : null;
    if (!itemPath || !isPathWithinUploadDir(itemPath, config.uploadDir, true)) {
      return res.status(404).json({ error: 'The shared item is no longer available.' });
    }
    req.share = share;
    req.sharePath = itemPath;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Absolute path of a file inside a shared folder, or null.
 * Hidden names and symlinks that leave the shared folder are refused.
 */
function resolveSharedFilePath(req, relativePath) {
  const checked = checkUserPath(relativePath);
  if (!checked.ok) return null;
  const targetPath = path.join(req.sharePath, checked.path);
  if (!isPathWithinUploadDir(targetPath, req.sharePath, true)) return null;
  return targetPath;
}

function sumSizes(items = []) {
  return items.reduce((total, item) => total + (item.size || 0), 0);
}

/**
 * Folder listing for a share page. Symlinks and hidden names are left out,
 * matching what the ZIP download contains.
 */
async function buildShareTree(dirPath, relativeBase = '') {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const children = await buildShareTree(fullPath, relativePath);
      const size = sumSizes(children);
      items.push({
        name: entry.name,
        path: relativePath,
        type: 'directory',
        size,
        formattedSize: formatFileSize(size),
        children,
      });
    } else {
      const stat = await fsp.lstat(fullPath);
      items.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
        size: stat.size,
        formattedSize: formatFileSize(stat.size),
      });
    }
  }

  return items.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

async function removeShare(token) {
  const removed = await updateShares((shares) => {
    if (!findShare(shares, token)) return false;
    delete shares[token];
    return true;
  });
  if (removed) await deleteShareArchive(token);
  return removed;
}

async function cleanupExpiredShares() {
  const expired = await updateShares((shares) => {
    const tokens = [];
    for (const [token, share] of Object.entries(shares)) {
      if (isShareExpired(share)) {
        delete shares[token];
        tokens.push(token);
      }
    }
    return tokens;
  });
  for (const token of expired) await deleteShareArchive(token);
}

// ---------------------------------------------------------------------------
// Management routes (owner only; guarded where mounted)
// ---------------------------------------------------------------------------

manageRouter.post('/', async (req, res, next) => {
  try {
    const checked = checkUserPath(req.body?.path);
    const itemPath = checked.ok ? path.join(config.uploadDir, checked.path) : null;
    if (!itemPath || !isPathWithinUploadDir(itemPath, config.uploadDir, true)) {
      return res.status(400).json({ error: 'Choose an existing file or folder.' });
    }

    const stats = await fsp.stat(itemPath);
    const token = crypto.randomBytes(18).toString('base64url');
    const authRequired = Boolean(req.body?.authRequired && config.pin);
    const share = {
      token,
      path: checked.path,
      name: path.basename(checked.path),
      type: stats.isDirectory() ? 'directory' : 'file',
      authRequired,
      grant: authRequired ? newGrant() : undefined,
      createdAt: new Date().toISOString(),
      expiresAt: expiryFrom(req.body?.expiresIn),
    };

    await updateShares((shares) => {
      shares[token] = share;
    });
    logger.info(`Share created for ${share.path}`);
    res.status(201).json(toShareResponse(share));
  } catch (error) {
    next(error);
  }
});

manageRouter.get('/manage', async (req, res, next) => {
  try {
    const shares = await readShares();
    const list = Object.values(shares)
      .map((share) => toShareResponse(share, { expired: isShareExpired(share) }))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

    res.json({ shares: list });
  } catch (error) {
    next(error);
  }
});

// This router is mounted at /api/files/share(s), on top of the file routes.
// When the token is not a share, hand the request on (next('router')), so a
// user folder named "share" or "shares" can still be managed.

manageRouter.patch('/:token', async (req, res, next) => {
  try {
    const updated = await updateShares((shares) => {
      const share = findShare(shares, req.params.token);
      if (!share) return null;

      if (req.body?.expiresIn !== undefined) {
        share.expiresAt = expiryFrom(req.body.expiresIn);
      }

      if (req.body?.authRequired !== undefined) {
        const nextAuth = Boolean(req.body.authRequired && config.pin);
        // A new grant signs out browsers that unlocked the share before.
        if (nextAuth !== Boolean(share.authRequired) || (nextAuth && !share.grant)) {
          share.grant = nextAuth ? newGrant() : undefined;
        }
        share.authRequired = nextAuth;
      }
      return { ...share };
    });

    if (!updated) return next('router');
    res.json(toShareResponse(updated));
  } catch (error) {
    next(error);
  }
});

manageRouter.delete('/:token', async (req, res, next) => {
  try {
    const removed = await removeShare(req.params.token);
    if (!removed) return next('router');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Public routes (anyone with the link)
// ---------------------------------------------------------------------------

publicRouter.get('/:token', resolveShare, async (req, res, next) => {
  try {
    const stats = await fsp.stat(req.sharePath);
    const allowed = hasAccess(req, req.share);
    let items;
    let size = stats.size;
    if (stats.isDirectory()) {
      items = await buildShareTree(req.sharePath);
      size = sumSizes(items);
    }

    res.json({
      name: req.share.name,
      type: req.share.type,
      authRequired: req.share.authRequired,
      authenticated: allowed,
      expiresAt: req.share.expiresAt,
      size,
      formattedSize: formatFileSize(size),
      items: allowed ? items : undefined,
    });
  } catch (error) {
    next(error);
  }
});

publicRouter.post('/:token/auth', resolveShare, async (req, res, next) => {
  try {
    if (!req.share.authRequired) {
      return res.json({ authenticated: true });
    }

    const ip = getClientIp(req);
    if (isLockedOut(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    const pin = req.body?.pin;
    if (!config.pin || typeof pin !== 'string' || !safeCompare(pin, config.pin)) {
      // This route exists only to try a PIN, so empty guesses count too.
      recordAttempt(ip);
      return res.status(401).json({ error: 'Incorrect PIN.' });
    }

    resetAttempts(ip);

    let grant = req.share.grant;
    if (!grant) {
      // Shares created before random grants existed get one on first unlock.
      grant = await updateShares((shares) => {
        const current = findShare(shares, req.share.token);
        if (!current) return null;
        current.grant = current.grant || newGrant();
        return current.grant;
      });
      if (!grant) return res.status(404).json({ error: 'This share no longer exists.' });
    }

    res.cookie(`DUMBDROP_SHARE_${req.share.token}`, grant, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie(req),
      path: `/api/shares/${req.share.token}`,
      maxAge: 24 * 3600 * 1000,
    });
    res.json({ authenticated: true });
  } catch (error) {
    next(error);
  }
});

// Paths are validated before sending; ZIP caches live under .metadata, which
// Express 5 would otherwise refuse as a dotfile.
const SEND_OPTIONS = { dotfiles: 'allow' };

publicRouter.get('/:token/qr.png', resolveShare, async (req, res, next) => {
  try {
    await renderShareQrPng(shareUrl(req.share.token), res);
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/:token/file/*splat', resolveShare, async (req, res, next) => {
  try {
    if (!hasAccess(req, req.share)) {
      return res.status(401).json({ error: 'PIN required.' });
    }
    if (req.share.type !== 'directory') {
      return res.status(404).json({ error: 'File not found in this share.' });
    }

    const relativePath = [].concat(req.params.splat || []).join('/');
    const targetPath = resolveSharedFilePath(req, relativePath);
    if (!targetPath) {
      return res.status(404).json({ error: 'File not found in this share.' });
    }

    const stats = await fsp.stat(targetPath);
    if (!stats.isFile()) {
      return res.status(400).json({ error: 'Folders must be downloaded as a ZIP archive.' });
    }

    res.download(targetPath, path.basename(targetPath), SEND_OPTIONS);
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/:token/download', resolveShare, async (req, res, next) => {
  try {
    if (!hasAccess(req, req.share)) {
      return res.status(401).json({ error: 'PIN required.' });
    }

    if (req.share.type === 'file') {
      return res.download(req.sharePath, req.share.name, SEND_OPTIONS);
    }

    const zipPath = await getOrCreateShareZip(req.share.token, req.sharePath);
    res.download(zipPath, `${req.share.name}.zip`, SEND_OPTIONS);
  } catch (error) {
    next(error);
  }
});

module.exports = {
  publicRouter,
  manageRouter,
  readShares,
  writeShares,
  updateShares,
  removeShare,
  cleanupExpiredShares,
};
