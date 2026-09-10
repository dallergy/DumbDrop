/**
 * Byte-range bookkeeping for parallel chunked uploads.
 * Ranges are half-open [start, end) pairs kept sorted and non-overlapping so
 * the server can accept chunks in any order and know when a file is complete.
 */

/**
 * Merge a new [start, end) range into a sorted, non-overlapping list.
 * Adjacent ranges are coalesced so the list stays small (typically one entry
 * per in-flight connection).
 * @param {number[][]} ranges - Existing sorted ranges
 * @param {number} start - Inclusive start offset
 * @param {number} end - Exclusive end offset
 * @returns {number[][]} New sorted, non-overlapping ranges
 */
function mergeRange(ranges, start, end) {
  if (end <= start) return ranges.slice();
  const result = [];
  let [s, e] = [start, end];
  let inserted = false;

  for (const [rs, re] of ranges) {
    if (re < s) {
      result.push([rs, re]);
    } else if (rs > e) {
      if (!inserted) {
        result.push([s, e]);
        inserted = true;
      }
      result.push([rs, re]);
    } else {
      // Overlapping or touching: absorb into the pending range
      s = Math.min(s, rs);
      e = Math.max(e, re);
    }
  }
  if (!inserted) result.push([s, e]);
  return result;
}

/**
 * Total number of bytes covered by the ranges.
 * @param {number[][]} ranges
 * @returns {number}
 */
function coveredBytes(ranges) {
  return ranges.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/**
 * Offset of the first byte that has not been received yet.
 * Returns fileSize when the file is fully covered.
 * @param {number[][]} ranges
 * @param {number} fileSize
 * @returns {number}
 */
function firstGap(ranges, fileSize) {
  if (!ranges.length || ranges[0][0] > 0) return 0;
  return Math.min(ranges[0][1], fileSize);
}

/**
 * True when a single range spans the entire file.
 * @param {number[][]} ranges
 * @param {number} fileSize
 * @returns {boolean}
 */
function isComplete(ranges, fileSize) {
  if (fileSize === 0) return true;
  return ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= fileSize;
}

/**
 * List the gaps [start, end) that still need to be uploaded.
 * @param {number[][]} ranges
 * @param {number} fileSize
 * @returns {number[][]}
 */
function missingRanges(ranges, fileSize) {
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < fileSize) gaps.push([cursor, fileSize]);
  return gaps;
}

module.exports = { mergeRange, coveredBytes, firstGap, isComplete, missingRanges };
