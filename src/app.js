/**
 * Main application setup and configuration.
 * Initializes Express app, middleware, routes, and static file serving.
 * Handles core application bootstrapping and configuration validation.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');
const { ensureDirectoryExists } = require('./utils/fileUtils');
const { getHelmetConfig, requirePin } = require('./middleware/security');
const { safeCompare } = require('./utils/security');
const {
  initUploadLimiter,
  chunkUploadLimiter,
  pinVerifyLimiter,
  pinStatusLimiter,
  downloadLimiter,
} = require('./middleware/rateLimiter');
const { injectDemoBanner, demoMiddleware } = require('./utils/demoMode');
const { originValidationMiddleware, getCorsOptions } = require('./middleware/cors');
const { isPublicShareRequest } = require('./routes/shares');

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Configure proxy trust based on environment (security-sensitive)
if (config.trustProxy) {
  if (config.trustedProxyIps && config.trustedProxyIps.length > 0) {
    // Trust only specific proxy IPs
    app.set('trust proxy', config.trustedProxyIps);
    logger.warn(`Proxy trust enabled for specific IPs: ${config.trustedProxyIps.join(', ')}`);
  } else {
    // Trust first proxy only
    app.set('trust proxy', 1);
    logger.warn(
      'Proxy trust enabled for first proxy - ensure reverse proxy is properly configured'
    );
  }
} else {
  // Secure default: do not trust proxy headers
  app.set('trust proxy', false);
  logger.info('Proxy trust disabled (secure default mode)');
}

// Middleware setup
app.use(cors(getCorsOptions(BASE_URL)));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(helmet(getHelmetConfig()));

// --- AUTHENTICATION MIDDLEWARE FOR ALL PROTECTED ROUTES ---
app.use((req, res, next) => {
  // List of paths that should be publicly accessible
  const publicPaths = [
    '/login',
    '/login.html',
    '/api/auth/logout',
    '/api/auth/verify-pin',
    '/api/auth/pin-required',
    '/health',
    '/api/health',
    '/config.js',
    '/assets/',
    '/js/',
    '/styles.css',
    '/manifest.json',
    '/asset-manifest.json',
    '/service-worker.js',
    '/share/',
    '/share.html',
  ];

  // Token read routes stay public. Management routes stay on the auth path
  // so a missing PIN cannot list or rewrite shares.
  if (
    publicPaths.some((path) => req.path.startsWith(path)) ||
    isPublicShareRequest(req.method, req.originalUrl || req.path)
  ) {
    return next();
  }

  // For all other paths, apply both origin validation and auth middleware
  originValidationMiddleware(req, res, () => {
    demoMiddleware(req, res, next);
  });
});

// Import routes
const { router: uploadRouter } = require('./routes/upload');
const fileRoutes = require('./routes/files');
const authRoutes = require('./routes/auth');
const { router: shareRoutes } = require('./routes/shares');
const notFound = (req, res) => {
  res.status(404).json({ error: 'Not found' });
};

// Use routes with appropriate middleware
// Apply strict rate limiting to PIN verification, but more permissive to status checks
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.use('/api/auth/pin-required', pinStatusLimiter);
app.use('/api/auth/logout', pinStatusLimiter);
app.use('/api/auth', pinVerifyLimiter, authRoutes);
app.use('/api/upload/init', requirePin(config.pin), initUploadLimiter);
app.use('/api/upload/chunk', requirePin(config.pin), chunkUploadLimiter);
app.use('/api/upload', requirePin(config.pin), uploadRouter);

if (config.uploadOnly) {
  // Drop-box mode: uploads stay available, management and public shares do not.
  app.use('/api/files', notFound);
  app.use('/api/shares', notFound);
  app.get('/share/:token', (req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
} else {
  app.use('/api/files/share', requirePin(config.pin), shareRoutes);
  app.use('/api/files/shares', requirePin(config.pin), shareRoutes);
  app.use('/api/files', requirePin(config.pin), downloadLimiter, fileRoutes);
  // Share PIN guesses use the same tight limiter as /api/auth/verify-pin.
  app.use('/api/shares/:token/auth', (req, res, next) => {
    if (req.method !== 'POST') return next();
    return pinVerifyLimiter(req, res, next);
  });
  app.use(
    '/api/shares',
    (req, res, next) => {
      if (isPublicShareRequest(req.method, req.originalUrl || req.path)) return next();
      return requirePin(config.pin)(req, res, next);
    },
    downloadLimiter,
    shareRoutes
  );

  app.get('/share/:token', (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, '../public', 'share.html'), 'utf8');
    html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
    html = html.replace('{{SHARE_TOKEN}}', String(req.params.token).replace(/"/g, ''));
    html = html.replace(
      /{{BASE_URL}}/g,
      config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/'
    );
    html = html.replace(
      '{{APP_CONFIG}}',
      JSON.stringify({
        basePath: new URL(config.baseUrl).pathname || '/',
      })
    );
    res.send(html);
  });
}

// Root route
app.get('/', (req, res) => {
  // Check if the PIN is configured and the cookie exists
  if (
    config.pin &&
    (!req.cookies?.DUMBDROP_PIN || !safeCompare(req.cookies.DUMBDROP_PIN, config.pin))
  ) {
    return res.redirect('/login.html');
  }

  let html = fs.readFileSync(path.join(__dirname, '../public', 'index.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  html = html.replace('{{APP_CONFIG}}', JSON.stringify(indexAppConfig()));
  html = injectDemoBanner(html);
  res.send(html);
});

/**
 * Client-side settings injected into index.html.
 */
function indexAppConfig() {
  return {
    autoUpload: config.autoUpload,
    maxRetries: config.clientMaxRetries,
    showFileList: config.showFileList && !config.uploadOnly,
    uploadOnly: config.uploadOnly,
    maxStorageBytes: config.maxStorageBytes,
    pinEnabled: Boolean(config.pin),
    basePath: new URL(config.baseUrl).pathname || '/',
    maxFileSize: config.maxFileSize,
    uploadConcurrency: config.uploadConcurrency,
    uploadChunkBytes: config.uploadChunkMb * 1024 * 1024,
  };
}

// Login route
app.get('/login.html', (req, res) => {
  // Add cache control headers
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  let html = fs.readFileSync(path.join(__dirname, '../public', 'login.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  html = html.replace(
    '{{APP_CONFIG}}',
    JSON.stringify({
      basePath: new URL(config.baseUrl).pathname || '/',
    })
  );
  html = injectDemoBanner(html);
  res.send(html);
});

// Serve static files with template variable replacement for HTML files
app.use((req, res, next) => {
  if (!req.path.endsWith('.html')) {
    return next();
  }

  if (config.uploadOnly && req.path === '/share.html') {
    return res.status(404).type('text/plain').send('Not found');
  }

  try {
    const filePath = path.join(__dirname, '../public', req.path);
    let html = fs.readFileSync(filePath, 'utf8');
    html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
    if (req.path === '/index.html' || req.path === 'index.html') {
      html = html.replace('{{APP_CONFIG}}', JSON.stringify(indexAppConfig()));
    }
    // Ensure baseUrl has a trailing slash
    const baseUrlWithSlash = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
    html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash);
    html = injectDemoBanner(html);
    res.send(html);
  } catch {
    next();
  }
});

// Serve remaining static files
app.use(express.static(path.join(__dirname, '../public')));

// Error handling middleware
// Express requires all 4 parameters for error handling middleware
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// --- Add this after config is loaded ---
const METADATA_DIR = path.join(config.uploadDir, '.metadata');
// --- End addition ---

/**
 * Initialize the application
 * Sets up required directories and validates configuration
 */
async function initialize() {
  try {
    // Validate configuration
    validateConfig();

    // Ensure upload directory exists and is writable
    await ensureDirectoryExists(config.uploadDir);

    // --- Add this section ---
    // Ensure metadata directory exists
    try {
      if (!fs.existsSync(METADATA_DIR)) {
        await fsPromises.mkdir(METADATA_DIR, { recursive: true });
        logger.info(`Created metadata directory: ${METADATA_DIR}`);
      } else {
        logger.info(`Metadata directory exists: ${METADATA_DIR}`);
      }
      // Check writability (optional but good practice)
      await fsPromises.access(METADATA_DIR, fs.constants.W_OK);
      logger.success(`Metadata directory is writable: ${METADATA_DIR}`);
    } catch (err) {
      logger.error(`Metadata directory error (${METADATA_DIR}): ${err.message}`);
      // Decide if this is fatal. If resumability is critical, maybe throw.
      throw new Error(`Failed to access or create metadata directory: ${METADATA_DIR}`, {
        cause: err,
      });
    }
    // --- End added section ---

    // Log configuration
    logger.info(`Maximum file size set to: ${config.maxFileSize / (1024 * 1024)}MB`);
    if (config.pin) {
      logger.info('PIN protection enabled');
    } else if (config.nodeEnv === 'production') {
      logger.warn('PIN protection is disabled via ALLOW_INSECURE_NO_PIN');
    }
    if (config.uploadOnly) {
      logger.info('Upload-only mode enabled (list, download, rename, delete, and shares are off)');
    }
    if (config.maxStorageBytes > 0) {
      logger.info(`Storage quota set to ${config.maxStorageBytes / (1024 * 1024)}MB`);
    }
    logger.info(`Auto upload is ${config.autoUpload ? 'enabled' : 'disabled'}`);
    if (config.appriseUrl) {
      logger.info('Apprise notifications enabled');
    }

    // After initializing demo middleware
    if (process.env.DEMO_MODE === 'true') {
      logger.info('[DEMO] Running in demo mode - uploads will not be saved');
      // Clear any existing files in upload directory
      try {
        const files = fs.readdirSync(config.uploadDir);
        for (const file of files) {
          fs.unlinkSync(path.join(config.uploadDir, file));
        }
        logger.info('[DEMO] Cleared upload directory');
      } catch (err) {
        logger.error(`[DEMO] Failed to clear upload directory: ${err.message}`);
      }
    }

    return app;
  } catch (err) {
    logger.error(`Initialization failed: ${err.message}`);
    throw err;
  }
}

module.exports = { app, initialize, config };
