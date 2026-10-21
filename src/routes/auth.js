/**
 * PIN login, session status, and logout.
 * A correct PIN gets a signed session cookie for its role (upload or admin).
 * Wrong PINs share one per-IP lockout with every other PIN entry point.
 */

const express = require('express');
const router = express.Router();
const { config } = require('../config');
const logger = require('../utils/logger');
const {
  validatePin,
  isLockedOut,
  recordAttempt,
  resetAttempts,
  MAX_ATTEMPTS,
  LOCKOUT_DURATION,
} = require('../utils/security');
const { getClientIp } = require('../utils/ipExtractor');
const {
  SESSION_COOKIE,
  LEGACY_PIN_COOKIE,
  sessionRole,
  revokeSession,
} = require('../utils/sessions');
const { roleForPin, issueSessionCookie, canManage } = require('../middleware/security');

function clearAuthCookies(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(LEGACY_PIN_COOKIE, { path: '/' });
}

/**
 * Verify a PIN and start a session.
 */
router.post('/verify-pin', (req, res) => {
  const { pin } = req.body || {};
  const ip = getClientIp(req);

  try {
    if (!config.pin && !config.adminPin) {
      clearAuthCookies(res);
      return res.json({ success: true, error: null, role: null });
    }

    const cleanedPin = validatePin(pin);
    if (!cleanedPin) {
      logger.warn(`Invalid PIN format from IP: ${ip}`);
      return res.status(401).json({
        success: false,
        error: 'Invalid PIN format. PIN must be 4-10 digits.',
      });
    }

    if (isLockedOut(ip)) {
      const attempts = recordAttempt(ip);
      const timeLeft = Math.ceil(
        (LOCKOUT_DURATION - (Date.now() - attempts.lastAttempt)) / 1000 / 60
      );
      logger.warn(`Login attempt from locked out IP: ${ip}`);
      return res.status(429).json({
        success: false,
        error: `Too many PIN verification attempts. Please try again in ${timeLeft} minutes.`,
      });
    }

    const role = roleForPin(cleanedPin);
    if (role) {
      resetAttempts(ip);
      issueSessionCookie(req, res, role);
      logger.info(`Successful ${role} PIN verification from IP: ${ip}`);
      return res.json({ success: true, error: null, role });
    }

    const attempts = recordAttempt(ip);
    const attemptsLeft = MAX_ATTEMPTS - attempts.count;
    logger.warn(`Failed PIN verification from IP: ${ip} (${attemptsLeft} attempts remaining)`);
    return res.status(401).json({
      success: false,
      error:
        attemptsLeft > 0
          ? `Invalid PIN. ${attemptsLeft} attempts remaining.`
          : 'Too many PIN verification attempts. Account locked for 15 minutes.',
    });
  } catch (err) {
    logger.error(`PIN verification error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Authentication failed' });
  }
});

/**
 * Whether the login page is needed.
 * required: uploads need a PIN. adminLogin: an admin PIN exists.
 */
router.get('/pin-required', (req, res) => {
  res.json({
    required: Boolean(config.pin),
    adminLogin: Boolean(config.adminPin),
  });
});

/**
 * Current session, for the UI and for scripts.
 */
router.get('/session', (req, res) => {
  const role = sessionRole(req);
  res.json({
    authenticated: Boolean(role),
    role,
    canManage: canManage(role),
  });
});

/**
 * Log out: revoke the session server-side and clear the cookies.
 */
router.post('/logout', (req, res) => {
  revokeSession(req.cookies?.[SESSION_COOKIE]);
  clearAuthCookies(res);
  logger.info(`Logout for IP: ${getClientIp(req)}`);
  res.json({ success: true });
});

module.exports = router;
