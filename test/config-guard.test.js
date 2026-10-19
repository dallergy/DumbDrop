/**
 * Production PIN guard tests
 * Production refuses to boot without a PIN unless the operator opts out.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = `
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
const { initialize } = require('./src/app');
initialize().then(() => process.exit(0)).catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(2);
});
`;

function boot(extraEnv) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-boot-'));
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      UPLOAD_DIR: uploadDir,
      DISABLE_BATCH_CLEANUP: 'true',
      DISABLE_SECURITY_CLEANUP: 'true',
      ...extraEnv,
    },
  });
  fs.rmSync(uploadDir, { recursive: true, force: true });
  return result;
}

describe('Production PIN requirement', () => {
  it('refuses to start when NODE_ENV=production and no PIN is set', () => {
    const result = boot({ DUMBDROP_PIN: '', ALLOW_INSECURE_NO_PIN: '' });
    assert.strictEqual(result.status, 2);
    assert.match(`${result.stderr}\n${result.stdout}`, /DUMBDROP_PIN is required/);
  });

  it('starts when ALLOW_INSECURE_NO_PIN=true', () => {
    const result = boot({ DUMBDROP_PIN: '', ALLOW_INSECURE_NO_PIN: 'true' });
    assert.strictEqual(result.status, 0, result.stderr);
  });

  it('starts when a PIN is configured', () => {
    const result = boot({ DUMBDROP_PIN: '123456', ALLOW_INSECURE_NO_PIN: '' });
    assert.strictEqual(result.status, 0, result.stderr);
  });
});
