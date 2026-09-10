/**
 * Security middleware implementations for HTTP-level protection.
 * Sets security headers (CSP, HSTS) and implements PIN-based authentication.
 * Provides Express middleware for securing routes and responses.
 */

const { safeCompare, isValidSession, createSession, SESSION_COOKIE, SESSION_DURATION_MS } = require('../utils/security');
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
  const isSecure = BASE_URL.startsWith('https://');

  return {
    noSniff: true,
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    ieNoOpen: true,
    hsts: isSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    dnsPrefetchControl: true,
    permittedCrossDomainPolicies: false,
    originAgentCluster: false,
    xssFilter: false
  };
}

/**
 * PIN protection middleware
 * @param {string} PIN - Valid PIN for comparison
 */
function requirePin(PIN) {
  return (req, res, next) => {
    // Skip PIN check if no PIN is configured
    if (!PIN) {
      return next();
    }

    const sessionToken = req.cookies?.[SESSION_COOKIE];
    if (sessionToken && isValidSession(sessionToken)) {
      return next();
    }

    // Legacy PIN cookie support (deprecated — migrate to session tokens)
    const cookiePin = req.cookies?.DUMBDROP_PIN;
    if (cookiePin && safeCompare(cookiePin, PIN)) {
      const newSession = createSession(req.ip);
      res.cookie(SESSION_COOKIE, newSession, {
        httpOnly: true,
        secure: req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
        sameSite: 'strict',
        path: '/',
        maxAge: SESSION_DURATION_MS
      });
      res.clearCookie('DUMBDROP_PIN', { path: '/' });
      return next();
    }

    const headerPin = req.headers['x-pin'];
    if (headerPin && safeCompare(headerPin, PIN)) {
      const newSession = createSession(req.ip);
      res.cookie(SESSION_COOKIE, newSession, {
        httpOnly: true,
        secure: req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
        sameSite: 'strict',
        path: '/',
        maxAge: SESSION_DURATION_MS
      });
      return next();
    }

    logger.warn(`Unauthorized access attempt from IP: ${req.ip}`);
    res.status(401).json({ error: 'Unauthorized' });
  };
}

module.exports = {
  // securityHeaders, // Deprecated, use helmet instead
  getHelmetConfig,
  requirePin
}; 