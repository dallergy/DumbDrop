/**
 * Core security utilities for authentication and protection.
 * Implements rate limiting, PIN validation, and secure string comparison.
 * Manages login attempts and security-related cleanup tasks.
 */

const crypto = require('crypto');
const { ipKeyGenerator } = require('express-rate-limit');
const logger = require('./logger');

/**
 * Store for login attempts with rate limiting
 * @type {Map<string, {count: number, lastAttempt: number}>}
 */
const loginAttempts = new Map();

// Constants
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

let cleanupInterval;

/**
 * Start the cleanup interval for old lockouts
 * @returns {NodeJS.Timeout} The interval handle
 */
function startCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [ip, attempts] of loginAttempts.entries()) {
      if (now - attempts.lastAttempt >= LOCKOUT_DURATION) {
        loginAttempts.delete(ip);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} expired lockouts`);
    }
  }, 60000); // Check every minute

  return cleanupInterval;
}

/**
 * Stop the cleanup interval
 */
function stopCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Start cleanup interval unless disabled
if (!process.env.DISABLE_BATCH_CLEANUP && !process.env.DISABLE_SECURITY_CLEANUP) {
  startCleanupInterval();
}

/**
 * Bucket an IP the same way the rate limiters do: IPv4 as-is, IPv6 by its
 * /56 prefix. One IPv6 client usually controls a whole /56 or /64, so keying
 * by full address would hand out a fresh set of guesses per address.
 * @param {string} ip - IP address
 * @returns {string}
 */
function lockoutKey(ip) {
  try {
    return ipKeyGenerator(String(ip));
  } catch {
    return String(ip);
  }
}

/**
 * Reset login attempts for an IP
 * @param {string} ip - IP address
 */
function resetAttempts(ip) {
  const key = lockoutKey(ip);
  // Successful API calls hit this on every request; only log when a counter existed.
  if (!loginAttempts.has(key)) return;
  loginAttempts.delete(key);
  logger.info(`Reset login attempts for ${key}`);
}

/**
 * Drop every lockout counter. Used by tests so cases do not share attempts.
 */
function clearLoginAttempts() {
  loginAttempts.clear();
}

/**
 * Check if an IP is locked out
 * @param {string} ip - IP address
 * @returns {boolean} True if IP is locked out
 */
function isLockedOut(ip) {
  const attempts = loginAttempts.get(lockoutKey(ip));
  if (!attempts) return false;

  if (attempts.count >= MAX_ATTEMPTS) {
    const timeElapsed = Date.now() - attempts.lastAttempt;
    if (timeElapsed < LOCKOUT_DURATION) {
      return true;
    }
    resetAttempts(ip);
  }
  return false;
}

/**
 * Record a login attempt for an IP
 * @param {string} ip - IP address
 * @returns {{count: number, lastAttempt: number}} Attempt details
 */
function recordAttempt(ip) {
  const key = lockoutKey(ip);
  const attempts = loginAttempts.get(key) || { count: 0, lastAttempt: 0 };
  attempts.count += 1;
  attempts.lastAttempt = Date.now();
  loginAttempts.set(key, attempts);
  logger.warn(`Recorded failed login attempt for ${key} (attempt ${attempts.count})`);
  return attempts;
}

/**
 * Validate and clean PIN
 * @param {string} pin - PIN to validate
 * @returns {string|null} Cleaned PIN or null if invalid
 */
function validatePin(pin) {
  if (!pin || typeof pin !== 'string') return null;
  const cleanPin = pin.replace(/\D/g, '');
  return cleanPin.length >= 4 && cleanPin.length <= 10 ? cleanPin : null;
}

/**
 * Compare two strings in constant time.
 * Digests are fixed length, so a shorter value padded with spaces cannot match.
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings match
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const left = crypto.createHash('sha256').update(a, 'utf8').digest();
  const right = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  MAX_ATTEMPTS,
  LOCKOUT_DURATION,
  lockoutKey,
  resetAttempts,
  clearLoginAttempts,
  isLockedOut,
  recordAttempt,
  validatePin,
  safeCompare,
  startCleanupInterval,
  stopCleanupInterval,
};
