/**
 * Unit tests for byte-range bookkeeping used by parallel chunk uploads.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { mergeRange, coveredBytes, firstGap, isComplete, missingRanges } = require('../src/utils/byteRanges');

describe('byteRanges', () => {
  it('merges out-of-order chunks into contiguous ranges', () => {
    let ranges = [];
    ranges = mergeRange(ranges, 20, 30);
    ranges = mergeRange(ranges, 0, 10);
    assert.deepStrictEqual(ranges, [[0, 10], [20, 30]]);
    ranges = mergeRange(ranges, 10, 20);
    assert.deepStrictEqual(ranges, [[0, 30]]);
  });

  it('absorbs overlapping and duplicate writes', () => {
    let ranges = mergeRange([], 0, 10);
    ranges = mergeRange(ranges, 5, 15);
    ranges = mergeRange(ranges, 0, 10);
    assert.deepStrictEqual(ranges, [[0, 15]]);
    assert.strictEqual(coveredBytes(ranges), 15);
  });

  it('ignores empty ranges', () => {
    assert.deepStrictEqual(mergeRange([[0, 5]], 7, 7), [[0, 5]]);
  });

  it('reports the first gap and missing ranges', () => {
    const ranges = [[0, 10], [20, 30]];
    assert.strictEqual(firstGap(ranges, 40), 10);
    assert.strictEqual(firstGap([[5, 10]], 40), 0);
    assert.strictEqual(firstGap([], 40), 0);
    assert.deepStrictEqual(missingRanges(ranges, 40), [[10, 20], [30, 40]]);
    assert.deepStrictEqual(missingRanges([[0, 40]], 40), []);
  });

  it('detects completion', () => {
    assert.strictEqual(isComplete([[0, 40]], 40), true);
    assert.strictEqual(isComplete([[0, 39]], 40), false);
    assert.strictEqual(isComplete([[0, 10], [10, 40]], 40), false);
    assert.strictEqual(isComplete([], 0), true);
  });
});
