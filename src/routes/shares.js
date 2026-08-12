/**
 * Secure, token-based file and folder sharing.
 * Handles share CRUD, public access, cached ZIP archives, and QR PNG output.
 */

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const QRCode = require('qrcode');
const { config } = require('../config');
const { safeCompare } = require('../utils/security');
const { isPathWithinUploadDir, formatFileSize } = require('../utils/fileUtils');
const { getOrCreateShareZip, deleteShareArchive } = require('../utils/shareArchives');

const router = express.Router();
const storePath = path.join(config.uploadDir, '.metadata', 'shares.json');

async function readShares() {
  try {
    return JSON.parse(await fsp.readFile(storePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeShares(shares) {
  const temporary = `${storePath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(shares, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, storePath);
}

function grantFor(token) {
  return crypto.createHmac('sha256', config.pin || 'no-pin').update(token).digest('hex');
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

function hasAccess(req, share) {
  if (!share.authRequired) {
    return true;
  }
  const grant = req.cookies?.[`DUMBDROP_SHARE_${share.token}`];
  return Boolean(grant && safeCompare(grant, grantFor(share.token)));
}

async function resolveShare(req, res, next) {
  try {
    const shares = await readShares();
    const share = shares[req.params.token];
    if (!share || isShareExpired(share)) {
      return res.status(404).json({ error: 'This share does not exist or has expired.' });
    }
    const itemPath = path.join(config.uploadDir, share.path);
    if (!isPathWithinUploadDir(itemPath, config.uploadDir, true)) {
      return res.status(404).json({ error: 'The shared item is no longer available.' });
    }
    req.share = share;
    req.sharePath = itemPath;
    next();
  } catch (error) {
    next(error);
  }
}

function resolveSharedFilePath(share, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const targetPath = path.join(config.uploadDir, share.path, normalized);
  const shareRoot = path.join(config.uploadDir, share.path);

  if (!normalized || !isPathWithinUploadDir(targetPath, shareRoot, true)) {
    return null;
  }

  return targetPath;
}

async function buildShareTree(dirPath, relativeBase = '') {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const items = [];

  for (const entry of entries.filter((item) => !item.name.startsWith('.'))) {
    const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);
    const stat = await fsp.stat(fullPath);
    const node = {
      name: entry.name,
      path: relativePath,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      formattedSize: formatFileSize(stat.size),
    };

    if (entry.isDirectory()) {
      node.children = await buildShareTree(fullPath, relativePath);
    }

    items.push(node);
  }

  return items.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

async function removeShare(token) {
  const shares = await readShares();
  if (!shares[token]) {
    return false;
  }

  delete shares[token];
  await writeShares(shares);
  await deleteShareArchive(token);
  return true;
}

async function cleanupExpiredShares() {
  const shares = await readShares();
  let changed = false;

  for (const [token, share] of Object.entries(shares)) {
    if (!isShareExpired(share)) {
      continue;
    }

    delete shares[token];
    await deleteShareArchive(token);
    changed = true;
  }

  if (changed) {
    await writeShares(shares);
  }
}

router.post('/', async (req, res, next) => {
  try {
    const relativePath = typeof req.body.path === 'string' ? req.body.path.replace(/\\/g, '/') : '';
    const itemPath = path.join(config.uploadDir, relativePath);
    if (!relativePath || !isPathWithinUploadDir(itemPath, config.uploadDir, true)) {
      return res.status(400).json({ error: 'Choose an existing file or folder.' });
    }

    const stats = await fsp.stat(itemPath);
    const expiresIn = Number(req.body.expiresIn || 0);
    const token = crypto.randomBytes(18).toString('base64url');
    const share = {
      token,
      path: relativePath,
      name: path.basename(relativePath),
      type: stats.isDirectory() ? 'directory' : 'file',
      authRequired: Boolean(req.body.authRequired && config.pin),
      createdAt: new Date().toISOString(),
      expiresAt: expiresIn > 0
        ? new Date(Date.now() + Math.min(expiresIn, 30 * 86400) * 1000).toISOString()
        : null,
    };

    const shares = await readShares();
    shares[token] = share;
    await writeShares(shares);

    res.status(201).json({
      ...share,
      url: shareUrl(token),
      qrUrl: `/api/shares/${token}/qr.png`,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/manage', async (req, res, next) => {
  try {
    const shares = await readShares();
    const list = Object.values(shares)
      .map((share) => ({
        ...share,
        url: shareUrl(share.token),
        qrUrl: `/api/shares/${share.token}/qr.png`,
        expired: isShareExpired(share),
      }))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

    res.json({ shares: list });
  } catch (error) {
    next(error);
  }
});

router.patch('/:token', async (req, res, next) => {
  try {
    const shares = await readShares();
    const share = shares[req.params.token];
    if (!share) {
      return res.status(404).json({ error: 'Share not found.' });
    }

    if (req.body.expiresIn !== undefined) {
      const expiresIn = Number(req.body.expiresIn);
      share.expiresAt = expiresIn > 0
        ? new Date(Date.now() + Math.min(expiresIn, 30 * 86400) * 1000).toISOString()
        : null;
    }

    if (req.body.authRequired !== undefined) {
      share.authRequired = Boolean(req.body.authRequired && config.pin);
    }

    shares[req.params.token] = share;
    await writeShares(shares);

    res.json({
      ...share,
      url: shareUrl(share.token),
      qrUrl: `/api/shares/${share.token}/qr.png`,
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/:token', async (req, res, next) => {
  try {
    const removed = await removeShare(req.params.token);
    if (!removed) {
      return res.status(404).json({ error: 'Share not found.' });
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.get('/:token', resolveShare, async (req, res, next) => {
  try {
    const stats = await fsp.stat(req.sharePath);
    let items;

    if (stats.isDirectory()) {
      items = await buildShareTree(req.sharePath);
    }

    res.json({
      name: req.share.name,
      type: req.share.type,
      authRequired: req.share.authRequired,
      authenticated: hasAccess(req, req.share),
      expiresAt: req.share.expiresAt,
      size: stats.size,
      formattedSize: formatFileSize(stats.size),
      items: hasAccess(req, req.share) ? items : undefined,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:token/auth', resolveShare, (req, res) => {
  if (!req.share.authRequired) {
    return res.json({ authenticated: true });
  }
  if (!config.pin || typeof req.body.pin !== 'string' || !safeCompare(req.body.pin, config.pin)) {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }

  res.cookie(`DUMBDROP_SHARE_${req.share.token}`, grantFor(req.share.token), {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: `/api/shares/${req.share.token}`,
    maxAge: 24 * 3600 * 1000,
  });
  res.json({ authenticated: true });
});

router.get('/:token/qr.png', resolveShare, async (req, res, next) => {
  try {
    await renderShareQrPng(shareUrl(req.share.token), res);
  } catch (error) {
    next(error);
  }
});

router.get('/:token/file/*', resolveShare, async (req, res, next) => {
  try {
    if (!hasAccess(req, req.share)) {
      return res.status(401).json({ error: 'PIN required.' });
    }

    const relativePath = req.params[0];
    const targetPath = resolveSharedFilePath(req.share, relativePath);
    if (!targetPath) {
      return res.status(404).json({ error: 'File not found in this share.' });
    }

    const stats = await fsp.stat(targetPath);
    if (!stats.isFile()) {
      return res.status(400).json({ error: 'Folders must be downloaded as a ZIP archive.' });
    }

    res.download(targetPath, path.basename(targetPath));
  } catch (error) {
    next(error);
  }
});

router.get('/:token/download', resolveShare, async (req, res, next) => {
  try {
    if (!hasAccess(req, req.share)) {
      return res.status(401).json({ error: 'PIN required.' });
    }

    if (req.share.type === 'file') {
      return res.download(req.sharePath, req.share.name);
    }

    const zipPath = await getOrCreateShareZip(req.share.token, req.sharePath);
    res.download(zipPath, `${req.share.name}.zip`);
  } catch (error) {
    next(error);
  }
});

module.exports = {
  router,
  readShares,
  writeShares,
  removeShare,
  cleanupExpiredShares,
};
