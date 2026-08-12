/**
 * Secure, token-based file and folder sharing.
 * Handles share creation, public access, PIN-gated downloads, and QR PNG output.
 */
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { config } = require('../config');
const { safeCompare } = require('../utils/security');
const { isPathWithinUploadDir, formatFileSize } = require('../utils/fileUtils');

const router = express.Router();
const storePath = path.join(config.uploadDir, '.metadata', 'shares.json');

async function readShares() {
  try { return JSON.parse(await fsp.readFile(storePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
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
  if (!share.authRequired) return true;
  const grant = req.cookies?.[`DUMBDROP_SHARE_${share.token}`];
  return Boolean(grant && safeCompare(grant, grantFor(share.token)));
}

async function resolveShare(req, res, next) {
  try {
    const shares = await readShares();
    const share = shares[req.params.token];
    if (!share || (share.expiresAt && Date.parse(share.expiresAt) <= Date.now())) {
      return res.status(404).json({ error: 'This share does not exist or has expired.' });
    }
    const itemPath = path.join(config.uploadDir, share.path);
    if (!isPathWithinUploadDir(itemPath, config.uploadDir, true)) {
      return res.status(404).json({ error: 'The shared item is no longer available.' });
    }
    req.share = share;
    req.sharePath = itemPath;
    next();
  } catch (error) { next(error); }
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
      token, path: relativePath, name: path.basename(relativePath),
      type: stats.isDirectory() ? 'directory' : 'file',
      authRequired: Boolean(req.body.authRequired && config.pin),
      createdAt: new Date().toISOString(),
      expiresAt: expiresIn > 0 ? new Date(Date.now() + Math.min(expiresIn, 30 * 86400) * 1000).toISOString() : null,
    };
    const shares = await readShares();
    shares[token] = share;
    await writeShares(shares);
    const url = shareUrl(token);
    res.status(201).json({ ...share, url, qrUrl: `/api/shares/${token}/qr.png` });
  } catch (error) { next(error); }
});

router.get('/:token', resolveShare, async (req, res, next) => {
  try {
    const stats = await fsp.stat(req.sharePath);
    let items;
    if (stats.isDirectory()) {
      const entries = await fsp.readdir(req.sharePath, { withFileTypes: true });
      items = await Promise.all(entries.filter(entry => !entry.name.startsWith('.')).map(async entry => {
        const stat = await fsp.stat(path.join(req.sharePath, entry.name));
        return { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: stat.size, formattedSize: formatFileSize(stat.size) };
      }));
    }
    res.json({ name: req.share.name, type: req.share.type, authRequired: req.share.authRequired,
      authenticated: hasAccess(req, req.share), expiresAt: req.share.expiresAt, size: stats.size,
      formattedSize: formatFileSize(stats.size), items: hasAccess(req, req.share) ? items : undefined });
  } catch (error) { next(error); }
});

router.post('/:token/auth', resolveShare, (req, res) => {
  if (!req.share.authRequired) return res.json({ authenticated: true });
  if (!config.pin || typeof req.body.pin !== 'string' || !safeCompare(req.body.pin, config.pin)) {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }
  res.cookie(`DUMBDROP_SHARE_${req.share.token}`, grantFor(req.share.token), {
    httpOnly: true, sameSite: 'strict', secure: req.secure, path: `/api/shares/${req.share.token}`, maxAge: 24 * 3600 * 1000,
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

router.get('/:token/download', resolveShare, (req, res, next) => {
  if (!hasAccess(req, req.share)) return res.status(401).json({ error: 'PIN required.' });
  if (req.share.type === 'file') return res.download(req.sharePath, req.share.name);
  res.attachment(`${req.share.name}.tar.gz`);
  const archive = spawn('tar', ['-czf', '-', '--', req.share.name], { cwd: path.dirname(req.sharePath), stdio: ['ignore', 'pipe', 'pipe'] });
  archive.stdout.pipe(res);
  let stderr = '';
  archive.stderr.on('data', chunk => { stderr += chunk; });
  archive.on('error', next);
  archive.on('close', code => { if (code && !res.headersSent) next(new Error(`Archive failed: ${stderr}`)); });
});

module.exports = router;
