/**
 * Core security utilities for authentication and protection.
 * Implements rate limiting, PIN validation, and secure string comparison.
 * Manages login attempts and security-related cleanup tasks.
 */

const crypto = require('crypto');
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
 * Reset login attempts for an IP
 * @param {string} ip - IP address
 */
function resetAttempts(ip) {
  loginAttempts.delete(ip);
  logger.info(`Reset login attempts for IP: ${ip}`);
}

/**
 * Check if an IP is locked out
 * @param {string} ip - IP address
 * @returns {boolean} True if IP is locked out
 */
function isLockedOut(ip) {
  const attempts = loginAttempts.get(ip);
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
  const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  attempts.count += 1;
  attempts.lastAttempt = Date.now();
  loginAttempts.set(ip, attempts);
  logger.warn(`Recorded failed login attempt for IP: ${ip} (attempt ${attempts.count})`);
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
 * Compare two strings in constant time
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings match
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (err) {
    logger.error(`Safe compare error: ${err.message}`);
    return false;
  }
}

/** @type {Map<string, { createdAt: number, ip: string }>} */
const activeSessions = new Map();

const SESSION_COOKIE = 'DUMBDROP_SESSION';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Create a signed session token after successful PIN verification.
 * @param {string} ip - Client IP address
 * @returns {string} Session token
 */
function createSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, { createdAt: Date.now(), ip });
  return token;
}

/**
 * Validate an active session token.
 * @param {string} token - Session token from cookie
 * @returns {boolean}
 */
function isValidSession(token) {
  if (!token || typeof token !== 'string') return false;

  const session = activeSessions.get(token);
  if (!session) return false;

  if (Date.now() - session.createdAt > SESSION_DURATION_MS) {
    activeSessions.delete(token);
    return false;
  }

  return true;
}

/**
 * Revoke a session token.
 * @param {string} token - Session token
 */
function revokeSession(token) {
  if (token) activeSessions.delete(token);
}

module.exports = {
  MAX_ATTEMPTS,
  LOCKOUT_DURATION,
  SESSION_COOKIE,
  SESSION_DURATION_MS,
  resetAttempts,
  isLockedOut,
  recordAttempt,
  validatePin,
  safeCompare,
  createSession,
  isValidSession,
  revokeSession,
  startCleanupInterval,
  stopCleanupInterval
}; 