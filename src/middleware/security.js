/**
 * Security middleware implementations for HTTP-level protection.
 * Sets security headers (CSP, HSTS) and guards routes with PIN sessions.
 */

const { safeCompare, isLockedOut, recordAttempt, resetAttempts } = require('../utils/security');
const { getClientIp } = require('../utils/ipExtractor');
const logger = require('../utils/logger');
const { config } = require('../config');
const {
  SESSION_COOKIE,
  LEGACY_PIN_COOKIE,
  SESSION_TTL_MS,
  createSession,
  sessionRole,
  roleSatisfies,
} = require('../utils/sessions');
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

/**
 * Helmet options: CSP, frame, referrer and HSTS headers.
 */
function getHelmetConfig() {
  const frameAncestors = ["'self'"];

  return {
    noSniff: true,
    frameguard: { action: 'sameorigin' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    ieNoOpen: true,
    hsts:
      process.env.NODE_ENV === 'production' && BASE_URL.startsWith('https')
        ? { maxAge: 31536000, includeSubDomains: true }
        : false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors,
        upgradeInsecureRequests: null,
      },
    },
    dnsPrefetchControl: { allow: false },
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    originAgentCluster: true,
    xssFilter: false,
  };
}

/**
 * Whether a cookie should be marked Secure.
 * req.secure is false behind a TLS-terminating proxy unless trust proxy is set,
 * so an https BASE_URL in production is treated as secure too.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function secureCookie(req) {
  return Boolean(req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'));
}

/**
 * Set the signed session cookie and drop the legacy raw-PIN cookie.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {'upload'|'admin'} role
 */
function issueSessionCookie(req, res, role) {
  res.cookie(SESSION_COOKIE, createSession(role), {
    httpOnly: true,
    secure: secureCookie(req),
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
  if (req.cookies?.[LEGACY_PIN_COOKIE]) res.clearCookie(LEGACY_PIN_COOKIE, { path: '/' });
}

/**
 * Header values Express may present as a string or an array of strings.
 * @param {string|string[]|undefined} value
 * @returns {string[]}
 */
function headerValues(value) {
  if (value === undefined) return [];
  return [].concat(value).filter((entry) => typeof entry === 'string' && entry.length > 0);
}

/**
 * Role a PIN unlocks, or null when it matches neither PIN.
 * Both comparisons always run so timing does not reveal which PIN exists.
 * @param {unknown} pin
 * @returns {'upload'|'admin'|null}
 */
function roleForPin(pin) {
  if (typeof pin !== 'string') return null;
  const isAdmin = Boolean(config.adminPin) && safeCompare(pin, config.adminPin);
  const isUpload = Boolean(config.pin) && safeCompare(pin, config.pin);
  if (isAdmin) return 'admin';
  if (isUpload) return 'upload';
  return null;
}

/**
 * Role a protected area needs, or null when it is open.
 * @param {'upload'|'manage'} area
 * @returns {'upload'|'admin'|null}
 */
function requiredRole(area) {
  if (area === 'manage' && config.managementMode === 'admin') return 'admin';
  return config.pin ? 'upload' : null;
}

/**
 * Whether a session role may use file management.
 * @param {'upload'|'admin'|null} role
 */
function canManage(role) {
  if (config.managementMode === 'off') return false;
  return roleSatisfies(role, requiredRole('manage'));
}

/**
 * Access middleware for an area ('upload' or 'manage').
 *
 * 1. A valid session cookie with a sufficient role passes. It is checked
 *    before the lockout: a signed session is not a guess, so someone else
 *    guessing from the same IP cannot lock a signed-in user out.
 * 2. An X-Pin header (for scripts) is a guess. Locked-out IPs get 429, wrong
 *    PINs count toward the lockout, and a right PIN sets a session cookie.
 * 3. A missing, expired or forged session cookie is a plain 401. Tokens are
 *    unguessable, so a stale cookie (for example after a PIN change) does not
 *    count toward the lockout either.
 * @param {'upload'|'manage'} area
 */
function requireAccess(area) {
  return (req, res, next) => {
    const needed = requiredRole(area);
    const session = sessionRole(req);
    if (roleSatisfies(session, needed)) {
      req.authRole = session || null;
      return next();
    }

    const ip = getClientIp(req);
    const presented = headerValues(req.headers['x-pin']);
    if (presented.length > 0) {
      if (isLockedOut(ip)) {
        logger.warn(`Rejected X-Pin from locked out IP: ${ip}`);
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
      // A duplicated header arrives as an array. Count it as a failed guess.
      const role = presented.length === 1 ? roleForPin(presented[0]) : null;
      if (!role) {
        recordAttempt(ip);
        logger.warn(`Wrong X-Pin from IP: ${ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
      }
      resetAttempts(ip);
      if (!roleSatisfies(role, needed)) {
        return res.status(403).json({ error: 'This needs the admin PIN.' });
      }
      issueSessionCookie(req, res, role);
      req.authRole = role;
      return next();
    }

    if (session) {
      return res.status(403).json({ error: 'This needs the admin PIN.' });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

/**
 * Upload-area guard kept under its old name for callers that only know one PIN.
 * The argument is ignored; the configured PINs are used.
 * @deprecated use requireAccess('upload')
 */
function requirePin() {
  return requireAccess('upload');
}

module.exports = {
  getHelmetConfig,
  requireAccess,
  requirePin,
  requiredRole,
  canManage,
  roleForPin,
  issueSessionCookie,
  secureCookie,
};
