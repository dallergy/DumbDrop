/**
 * Regression tests for the November maintenance pass.
 *  - Completed uploads must not write secrets (PINs, Apprise URL) to the logs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbdrop-maint-nov-'));
process.env.DISABLE_BATCH_CLEANUP = 'true';
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.UPLOAD_DIR = uploadDir;
process.env.DUMBDROP_PIN = '987654';
process.env.DUMBDROP_ADMIN_PIN = '135791';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'http://localhost:3000/';

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const util = require('node:util');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

// notifications.js captures spawn when it loads, so replace it first. The
// fake never starts the real apprise binary and always finishes at once.
const spawnCalls = [];
childProcess.spawn = (command, args) => {
  spawnCalls.push({ command, args });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => child.emit('close', 0));
  return child;
};

const { config } = require('../src/config');
const { sendNotification } = require('../src/services/notifications');

after(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

/**
 * Run fn and return everything it wrote through console.* as one string.
 */
async function captureConsole(fn) {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map((name) => [name, console[name]]));
  const lines = [];
  for (const name of methods) {
    console[name] = (...args) => lines.push(util.format(...args));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, originals);
  }
  return lines.join('\n');
}

describe('upload notifications', () => {
  it('do not log the PINs when an upload completes', async () => {
    assert.strictEqual(config.pin, '987654');
    const output = await captureConsole(() => sendNotification('report.pdf', 1024, config));
    assert.ok(!output.includes('987654'), `upload PIN leaked to logs:\n${output}`);
    assert.ok(!output.includes('135791'), `admin PIN leaked to logs:\n${output}`);
  });

  it('do not log the Apprise URL, which usually carries a token', async () => {
    const secretUrl = 'tgram://123456:SECRET-BOT-TOKEN/987';
    spawnCalls.length = 0;
    const output = await captureConsole(() =>
      sendNotification('report.pdf', 1024, { ...config, appriseUrl: secretUrl, uploadDir })
    );
    // The stubbed apprise really ran, so the success path's logging was covered.
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].command, 'apprise');
    assert.ok(!output.includes('SECRET-BOT-TOKEN'), `Apprise URL leaked to logs:\n${output}`);
  });
});
