/**
 * Security middleware implementations for HTTP-level protection.
 * Sets security headers (CSP, HSTS) and implements PIN-based authentication.
 * Provides Express middleware for securing routes and responses.
 */

const { safeCompare, isLockedOut, recordAttempt, resetAttempts } = require('../utils/security');
const { getClientIp } = require('../utils/ipExtractor');
const logger = require('../utils/logger');
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// const { config } = require('../config');
/**
 * Security headers middleware
 * DEPRECATED: Use helmet middleware instead for security headers
 */
// function securityHeaders(req, res, next) {
//   // Content Security Policy
//   let csp =
//     "default-src 'self'; " +
//     "connect-src 'self'; " +
//     "style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
//     "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
//     "img-src 'self' data: blob:;";

//   // If allowedIframeOrigins is set, allow those origins to embed via iframe
//   if (config.allowedIframeOrigins && config.allowedIframeOrigins.length > 0) {
//     // Remove X-Frame-Options header (do not set it)
//     // Add frame-ancestors directive to CSP
//     const frameAncestors = ["'self'", ...config.allowedIframeOrigins].join(' ');
//     csp += ` frame-ancestors ${frameAncestors};`;
//   } else {
//     // Default: only allow same origin if not configured
//     res.setHeader('X-Frame-Options', 'SAMEORIGIN');
//   }

//   res.setHeader('Content-Security-Policy', csp);
//   res.setHeader('X-Content-Type-Options', 'nosniff');
//   res.setHeader('X-XSS-Protection', '1; mode=block');

//   // Strict Transport Security (when in production)
//   if (process.env.NODE_ENV === 'production') {
//     res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
//   }

//   next();
// }

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
 * Header values Express may present as a string or an array of strings.
 * @param {string|string[]|undefined} value
 * @returns {string[]}
 */
function headerValues(value) {
  if (value === undefined) return [];
  return [].concat(value).filter((entry) => typeof entry === 'string' && entry.length > 0);
}

/**
 * PIN protection middleware.
 * Failed guesses presented via cookie or X-Pin share the login lockout.
 * Requests with no credential are rejected but not counted, so anonymous
 * page loads cannot lock the operator out.
 * @param {string} PIN - Valid PIN for comparison
 */
function requirePin(PIN) {
  return (req, res, next) => {
    if (!PIN) {
      return next();
    }

    const ip = getClientIp(req);
    if (isLockedOut(ip)) {
      logger.warn(`Rejected PIN-protected request from locked out IP: ${ip}`);
      return res.status(429).json({ error: 'Too many attempts' });
    }

    const cookiePin = req.cookies?.DUMBDROP_PIN;
    const presentedCookie = typeof cookiePin === 'string' && cookiePin.length > 0;
    if (presentedCookie && safeCompare(cookiePin, PIN)) {
      resetAttempts(ip);
      return next();
    }

    // A duplicated header arrives as an array. Treat that as a failed guess
    // rather than skipping the lockout counter.
    const presentedHeaders = headerValues(req.headers['x-pin']);
    if (presentedHeaders.length === 1 && safeCompare(presentedHeaders[0], PIN)) {
      resetAttempts(ip);
      res.cookie('DUMBDROP_PIN', PIN, {
        httpOnly: true,
        secure: secureCookie(req),
        sameSite: 'strict',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000,
      });
      return next();
    }

    if (presentedCookie || presentedHeaders.length > 0) {
      recordAttempt(ip);
    }

    logger.warn(`Unauthorized access attempt from IP: ${ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

module.exports = {
  // securityHeaders, // Deprecated, use helmet instead
  getHelmetConfig,
  requirePin,
  secureCookie,
};
