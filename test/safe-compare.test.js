/**
 * Constant-time compare tests
 * Trailing spaces must not compare equal to a shorter PIN.
 */

process.env.DISABLE_SECURITY_CLEANUP = 'true';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { safeCompare } = require('../src/utils/security');

describe('safeCompare', () => {
  it('matches identical strings', () => {
    assert.strictEqual(safeCompare('123456', '123456'), true);
  });

  it('rejects a value that only differs by trailing spaces', () => {
    assert.strictEqual(safeCompare('123456', '123456 '), false);
    assert.strictEqual(safeCompare('123456 ', '123456'), false);
  });

  it('rejects different lengths and non-strings', () => {
    assert.strictEqual(safeCompare('1234', '12345'), false);
    assert.strictEqual(safeCompare('1234', 1234), false);
    assert.strictEqual(safeCompare(null, '1234'), false);
  });
});
