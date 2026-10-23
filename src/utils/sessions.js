/**
 * Signed session tokens for the PIN login.
 *
 * The cookie used to hold the raw PIN. It now holds
 *   v1.<role>.<expiresAtMs>.<nonce>.<signature>
 * signed with HMAC-SHA256. The signing key is derived from a random secret
 * stored in <uploadDir>/.metadata/session.key and from the PIN for that role,
 * so:
 *   - the PIN never leaves the server after login,
 *   - sessions survive restarts,
 *   - changing a PIN signs every existing session for that role out.
 *
 * Roles: "upload" (DUMBDROP_PIN) and "admin" (DUMBDROP_ADMIN_PIN).
 * An admin session can do everything an upload session can.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const logger = require('./logger');

const SESSION_COOKIE = 'DUMBDROP_SESSION';
// Cookie that stored the raw PIN before signed sessions. Only ever cleared now.
const LEGACY_PIN_COOKIE = 'DUMBDROP_PIN';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ROLE_RANK = Object.freeze({ upload: 1, admin: 2 });
const VERSION = 'v1';

let secret = null;
/**
 * Sessions ended by logout: nonce -> expiry. Kept in memory, so a restart
 * forgets them; a logged-out token copied before logout would then work
 * until it expires (at most SESSION_TTL_MS). Deleting session.key or
 * changing the PIN ends every session for good.
 * @type {Map<string, number>}
 */
const revoked = new Map();

function secretPath() {
  return path.join(config.uploadDir, '.metadata', 'session.key');
}

/**
 * Load the signing secret, creating it on first use.
 * Falls back to an in-memory secret (sessions end on restart) if the
 * metadata directory is not writable.
 * @returns {Buffer}
 */
function getSecret() {
  if (secret) return secret;
  const file = secretPath();
  try {
    const stored = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(stored)) {
      secret = Buffer.from(stored, 'hex');
      return secret;
    }
    logger.warn('Session key file is malformed; generating a new one');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`Could not read session key: ${err.message}`);
  }

  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh.toString('hex'), { mode: 0o600 });
  } catch (err) {
    logger.warn(`Could not persist session key (${err.message}); sessions will end on restart`);
  }
  secret = fresh;
  return secret;
}

/** PIN that unlocks a role, or '' when that role has no PIN. */
function pinForRole(role) {
  if (role === 'admin') return config.adminPin || '';
  if (role === 'upload') return config.pin || '';
  return '';
}

function keyForRole(role) {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`dumbdrop-session:${role}:${pinForRole(role)}`)
    .digest();
}

function sign(role, payload) {
  return crypto.createHmac('sha256', keyForRole(role)).update(payload).digest('base64url');
}

/**
 * Create a session token for a role.
 * @param {'upload'|'admin'} role
 * @returns {string}
 */
function createSession(role) {
  if (!ROLE_RANK[role]) throw new Error(`Unknown session role: ${role}`);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const payload = `${VERSION}.${role}.${expiresAt}.${nonce}`;
  return `${payload}.${sign(role, payload)}`;
}

/**
 * Check a session token.
 * @param {unknown} token
 * @returns {{role: 'upload'|'admin', expiresAt: number, nonce: string}|null}
 */
function verifySession(token) {
  if (typeof token !== 'string' || token.length > 256) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [version, role, expiresRaw, nonce, signature] = parts;
  if (version !== VERSION || !ROLE_RANK[role]) return null;
  // A role whose PIN is not configured cannot hold a session.
  if (!pinForRole(role)) return null;

  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null;

  const expected = Buffer.from(sign(role, `${version}.${role}.${expiresRaw}.${nonce}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return null;
  }
  if (revoked.has(nonce)) return null;
  return { role, expiresAt, nonce };
}

/**
 * End a session before it expires (logout).
 * @param {unknown} token
 */
function revokeSession(token) {
  const session = verifySession(token);
  if (!session) return;
  const now = Date.now();
  for (const [nonce, expiresAt] of revoked) {
    if (expiresAt <= now) revoked.delete(nonce);
  }
  revoked.set(session.nonce, session.expiresAt);
}

/**
 * Role of the request's session cookie, or null.
 * @param {import('express').Request} req
 * @returns {'upload'|'admin'|null}
 */
function sessionRole(req) {
  const session = verifySession(req.cookies?.[SESSION_COOKIE]);
  return session ? session.role : null;
}

/** True when `role` is at least `needed`. A null requirement always passes. */
function roleSatisfies(role, needed) {
  if (!needed) return true;
  return Boolean(role && ROLE_RANK[role] >= ROLE_RANK[needed]);
}

/** Forget the in-memory secret and revocations. Tests only. */
function resetSessionsForTests() {
  secret = null;
  revoked.clear();
}

module.exports = {
  SESSION_COOKIE,
  LEGACY_PIN_COOKIE,
  SESSION_TTL_MS,
  createSession,
  verifySession,
  revokeSession,
  sessionRole,
  roleSatisfies,
  resetSessionsForTests,
};
