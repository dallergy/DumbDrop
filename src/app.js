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
const { getHelmetConfig, requireAccess, canManage } = require('./middleware/security');
const { sessionRole } = require('./utils/sessions');
const {
  initUploadLimiter,
  chunkUploadLimiter,
  pinVerifyLimiter,
  pinStatusLimiter,
  downloadLimiter,
} = require('./middleware/rateLimiter');
const { injectDemoBanner, demoMiddleware } = require('./utils/demoMode');
const { originValidationMiddleware, getCorsOptions } = require('./middleware/cors');

// Create Express app
const app = express();
const PUBLIC_DIR = path.resolve(__dirname, '../public');
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

// --- ORIGIN CHECK AND DEMO MODE FOR NON-PUBLIC ROUTES ---
// PIN checks happen per route below (requireAccess); this layer only checks
// the request Origin and applies demo mode.
const PUBLIC_PATH_PREFIXES = [
  '/login',
  '/login.html',
  '/api/auth/logout',
  '/api/auth/verify-pin',
  '/api/auth/pin-required',
  '/api/auth/session',
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
  // Only the public share router is mounted here (see below).
  '/api/shares/',
];

app.use((req, res, next) => {
  if (PUBLIC_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    return next();
  }
  originValidationMiddleware(req, res, () => {
    demoMiddleware(req, res, next);
  });
});

// Import routes
const { router: uploadRouter } = require('./routes/upload');
const fileRoutes = require('./routes/files');
const authRoutes = require('./routes/auth');
const {
  publicRouter: publicShareRoutes,
  manageRouter: manageShareRoutes,
} = require('./routes/shares');
const notFound = (req, res) => {
  res.status(404).json({ error: 'Not found' });
};
const requireUpload = requireAccess('upload');
const requireManage = requireAccess('manage');

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Status reads get a loose limit; PIN guesses get the strict one.
app.use('/api/auth/pin-required', pinStatusLimiter);
app.use('/api/auth/session', pinStatusLimiter);
app.use('/api/auth/logout', pinStatusLimiter);
app.use('/api/auth', pinVerifyLimiter, authRoutes);

app.use('/api/upload/init', requireUpload, initUploadLimiter);
app.use('/api/upload/chunk', requireUpload, chunkUploadLimiter);
app.use('/api/upload', requireUpload, uploadRouter);

if (config.managementMode === 'off') {
  // Drop-box mode with no admin PIN: no library, no shares.
  app.use('/api/files', notFound);
  app.use('/api/shares', notFound);
  app.get('/share/:token', (req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
} else {
  // Management: create/list/edit/delete shares, and the file library.
  app.use('/api/files/share', requireManage, manageShareRoutes);
  app.use('/api/files/shares', requireManage, manageShareRoutes);
  app.use('/api/files', requireManage, downloadLimiter, fileRoutes);

  // Public share links. Share PIN guesses use the strict PIN limiter.
  app.use('/api/shares/:token/auth', (req, res, next) => {
    if (req.method !== 'POST') return next();
    return pinVerifyLimiter(req, res, next);
  });
  app.use('/api/shares', downloadLimiter, publicShareRoutes);

  app.get('/share/:token', (req, res) => {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'share.html'), 'utf8');
    html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
    html = html.replace('{{SHARE_TOKEN}}', String(req.params.token).replace(/[^A-Za-z0-9_-]/g, ''));
    html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash());
    html = html.replace('{{APP_CONFIG}}', JSON.stringify({ basePath: basePath() }));
    res.send(html);
  });
}

function baseUrlWithSlash() {
  return config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
}

function basePath() {
  return new URL(config.baseUrl).pathname || '/';
}

/**
 * Client-side settings injected into index.html, for this visitor's session.
 * @param {import('express').Request} req
 */
function indexAppConfig(req) {
  const role = sessionRole(req);
  const manage = canManage(role);
  const adminMode = config.managementMode === 'admin';
  return {
    autoUpload: config.autoUpload,
    maxRetries: config.clientMaxRetries,
    // With an admin PIN the library is the admin's tool, so it is always on for them.
    showFileList: manage && (config.showFileList || (adminMode && role === 'admin')),
    uploadOnly: !manage,
    maxStorageBytes: config.maxStorageBytes,
    // Protected shares use DUMBDROP_PIN.
    pinEnabled: Boolean(config.pin),
    signedIn: Boolean(role),
    role,
    adminSignIn: adminMode && role !== 'admin',
    basePath: basePath(),
    maxFileSize: config.maxFileSize,
    uploadConcurrency: config.uploadConcurrency,
    uploadChunkBytes: config.uploadChunkMb * 1024 * 1024,
  };
}

function sendIndex(req, res) {
  if (config.pin && !sessionRole(req)) {
    return res.redirect('login.html');
  }
  res.set('Cache-Control', 'no-store');
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  html = html.replace('{{APP_CONFIG}}', JSON.stringify(indexAppConfig(req)));
  html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash());
  html = injectDemoBanner(html);
  res.send(html);
}

app.get('/', sendIndex);
app.get('/index.html', sendIndex);

app.get('/login.html', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'login.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  html = html.replace('{{APP_CONFIG}}', JSON.stringify({ basePath: basePath() }));
  html = injectDemoBanner(html);
  res.send(html);
});

// Unknown API routes answer in JSON like the rest of the API.
app.use('/api', notFound);

// Other HTML pages get template values filled in.
app.use((req, res, next) => {
  if (!req.path.endsWith('.html')) {
    return next();
  }
  if (config.managementMode === 'off' && req.path === '/share.html') {
    return res.status(404).type('text/plain').send('Not found');
  }

  // req.path is not normalized, so "/../x.html" would leave public/ without this.
  const filePath = path.resolve(PUBLIC_DIR, `.${req.path}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return res.status(404).type('text/plain').send('Not found');
  }

  try {
    let html = fs.readFileSync(filePath, 'utf8');
    html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
    html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash());
    html = injectDemoBanner(html);
    res.send(html);
  } catch {
    next();
  }
});

// Serve remaining static files
app.use(express.static(PUBLIC_DIR));

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
      logger.info('PIN protection enabled for uploads');
    } else if (config.nodeEnv === 'production') {
      logger.warn('Uploads need no PIN (ALLOW_INSECURE_NO_PIN=true)');
    }
    const managementLog = {
      admin: 'File management (list, download, rename, delete, shares) needs the admin PIN',
      off: 'Upload-only mode: list, download, rename, delete, and shares are off',
      pin: config.pin
        ? 'File management is open to anyone with the PIN'
        : 'File management is open to everyone (no PIN set)',
    };
    logger.info(managementLog[config.managementMode]);
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
