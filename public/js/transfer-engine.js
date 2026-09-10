/**
 * Parallel upload engine (no DOM).
 * One shared pool of N connections is fed chunk tasks from every queued file,
 * so a single large file uses all N streams and thousands of small files also
 * keep the pipe full. XHR is used for real upload progress, chunk size adapts
 * to the measured throughput, and stats are sampled for the dashboard.
 */

import { apiUrl } from './utils.js';

export const MIN_CHUNK = 2 * 1024 * 1024;
export const MAX_CHUNK = 32 * 1024 * 1024;
export const DEFAULT_CHUNK = 8 * 1024 * 1024;
export const MAX_CONCURRENCY = 6;

// Aim for chunks that take ~2.5s per stream: big enough to amortize the
// request round-trip, small enough that a retry is cheap and progress is smooth.
const TARGET_CHUNK_SECONDS = 2.5;
const RATE_WINDOW_MS = 3000;
const SAMPLE_INTERVAL_MS = 250;
const HISTORY_LENGTH = 90;
const UPDATE_THROTTLE_MS = 120;
const MAX_STATUS_REPAIRS = 3;

let taskCounter = 0;

export class TransferEngine {
  constructor({ concurrency = 4, chunkBytes = 0, maxRetries = 5, onUpdate, onTransfer, onFinish } = {}) {
    this.concurrency = clampConcurrency(concurrency);
    this.fixedChunkBytes = chunkBytes > 0 ? Math.min(Math.max(chunkBytes, MIN_CHUNK), MAX_CHUNK) : 0;
    this.chunkBytes = this.fixedChunkBytes || DEFAULT_CHUNK;
    this.maxRetries = maxRetries;
    this.onUpdate = onUpdate;
    this.onTransfer = onTransfer;
    this.onFinish = onFinish;

    this.transfers = [];
    this.active = new Set();
    this.running = false;
    this.paused = false;

    this.samples = [];
    this.history = [];
    this.rate = 0;
    this.peakRate = 0;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.sampleTimer = null;
    this.updateTimer = null;
    this.dirty = false;
  }

  // ----- public API -----

  add(files, batchId = null) {
    const added = [];
    for (const file of files) {
      const transfer = {
        id: `t${++taskCounter}`,
        batchId,
        file,
        name: (file.webkitRelativePath || file.name).replace(/\\/g, '/'),
        size: file.size,
        status: 'queued',
        uploadId: null,
        initPromise: null,
        serverMaxChunk: MAX_CHUNK,
        nextOffset: 0,
        committed: 0,
        inflight: new Map(),
        retryQueue: [],
        repairs: 0,
        xhrs: new Set(),
        error: null,
        startedAt: 0,
        finishedAt: 0,
      };
      this.transfers.push(transfer);
      added.push(transfer);
    }
    if (this.running) this.pump();
    return added;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.startedAt = this.startedAt || Date.now();
    this.finishedAt = 0;
    this.sampleTimer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.sample();
    this.pump();
  }

  setConcurrency(n) {
    this.concurrency = clampConcurrency(n);
    this.pump();
    this.markDirty();
  }

  setChunkBytes(bytes) {
    this.fixedChunkBytes = bytes > 0 ? Math.min(Math.max(bytes, MIN_CHUNK), MAX_CHUNK) : 0;
    if (this.fixedChunkBytes) this.chunkBytes = this.fixedChunkBytes;
    this.markDirty();
  }

  pause() {
    this.paused = true;
    this.markDirty();
  }

  resume() {
    this.paused = false;
    this.pump();
    this.markDirty();
  }

  cancel(transferId) {
    const transfer = this.transfers.find((t) => t.id === transferId);
    if (!transfer || isTerminal(transfer)) return;
    this.finishTransfer(transfer, 'cancelled', 'Cancelled');
    if (transfer.uploadId) {
      fetch(apiUrl(`/api/upload/cancel/${transfer.uploadId}`), { method: 'POST' }).catch(() => {});
    }
    this.pump();
  }

  cancelAll() {
    this.transfers.filter((t) => !isTerminal(t)).forEach((t) => this.cancel(t.id));
  }

  retry(transferId) {
    const transfer = this.transfers.find((t) => t.id === transferId);
    if (!transfer || transfer.status !== 'failed') return;
    Object.assign(transfer, {
      status: 'queued',
      uploadId: null,
      initPromise: null,
      nextOffset: 0,
      committed: 0,
      retryQueue: [],
      repairs: 0,
      error: null,
      startedAt: 0,
      finishedAt: 0,
    });
    transfer.inflight.clear();
    this.finishedAt = 0;
    if (!this.running) this.start();
    this.pump();
    this.emitTransfer(transfer);
  }

  /**
   * Forget finished transfers and session stats. No-op while running.
   */
  reset() {
    if (this.running) return;
    this.transfers = [];
    this.samples = [];
    this.history = [];
    this.rate = 0;
    this.peakRate = 0;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.markDirty();
  }

  snapshot() {
    let totalBytes = 0;
    let sentBytes = 0;
    let filesDone = 0;
    let filesFailed = 0;
    let filesActive = 0;
    for (const t of this.transfers) {
      if (t.status === 'cancelled') continue;
      totalBytes += t.size;
      sentBytes += sentOf(t);
      if (t.status === 'done') filesDone += 1;
      else if (t.status === 'failed') filesFailed += 1;
      else if (t.status === 'uploading' || t.status === 'initializing') filesActive += 1;
    }
    const remaining = Math.max(0, totalBytes - sentBytes);
    const elapsed = this.startedAt ? ((this.finishedAt || Date.now()) - this.startedAt) / 1000 : 0;
    return {
      running: this.running,
      paused: this.paused,
      finished: Boolean(this.finishedAt),
      totalBytes,
      sentBytes,
      remainingBytes: remaining,
      rate: this.finishedAt ? 0 : this.rate,
      peakRate: this.peakRate,
      averageRate: elapsed > 0 ? sentBytes / elapsed : 0,
      eta: this.rate > 0 && !this.finishedAt ? remaining / this.rate : null,
      elapsed,
      filesTotal: this.transfers.filter((t) => t.status !== 'cancelled').length,
      filesDone,
      filesFailed,
      filesActive,
      activeConnections: this.active.size,
      concurrency: this.concurrency,
      chunkBytes: this.chunkBytes,
      adaptiveChunks: !this.fixedChunkBytes,
      history: this.history,
      transfers: this.transfers,
    };
  }

  // ----- scheduling -----

  pump() {
    if (!this.running || this.paused) return;
    while (this.active.size < this.concurrency) {
      const task = this.nextTask();
      if (!task) break;
      this.active.add(task);
      this.runTask(task).finally(() => {
        this.active.delete(task);
        this.markDirty();
        this.pump();
      });
    }
    this.checkFinished();
    this.markDirty();
  }

  nextTask() {
    // Retries first so a stalled file does not sit behind the whole queue
    for (const transfer of this.transfers) {
      if (transfer.retryQueue.length && !isTerminal(transfer)) {
        const range = transfer.retryQueue.shift();
        return { kind: 'chunk', transfer, start: range.start, end: range.end, attempt: range.attempt || 0 };
      }
    }
    for (const transfer of this.transfers) {
      if (isTerminal(transfer)) continue;
      if (!transfer.uploadId) {
        if (transfer.initPromise) continue; // another slot is initializing it
        return { kind: 'init', transfer };
      }
      if (transfer.nextOffset < transfer.size) {
        const chunk = Math.min(this.currentChunkBytes(transfer), transfer.serverMaxChunk);
        const start = transfer.nextOffset;
        const end = Math.min(start + chunk, transfer.size);
        transfer.nextOffset = end;
        return { kind: 'chunk', transfer, start, end, attempt: 0 };
      }
    }
    return null;
  }

  currentChunkBytes(transfer) {
    if (this.fixedChunkBytes) return this.fixedChunkBytes;
    // Small files: single request, no point splitting
    if (transfer.size <= this.chunkBytes) return transfer.size || 1;
    return this.chunkBytes;
  }

  adaptChunkSize() {
    if (this.fixedChunkBytes || this.rate <= 0) return;
    const perStream = this.rate / Math.max(1, Math.min(this.concurrency, this.active.size || 1));
    const ideal = perStream * TARGET_CHUNK_SECONDS;
    const clamped = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, ideal));
    // Snap to whole MB and only move when the change is meaningful
    const snapped = Math.round(clamped / (1024 * 1024)) * 1024 * 1024;
    if (Math.abs(snapped - this.chunkBytes) >= this.chunkBytes * 0.5) {
      this.chunkBytes = snapped;
    }
  }

  async runTask(task) {
    const { transfer } = task;
    if (task.kind === 'init') {
      transfer.initPromise = this.initTransfer(transfer);
      try {
        await transfer.initPromise;
      } finally {
        transfer.initPromise = null;
      }
      return;
    }
    await this.sendChunk(task);
  }

  async initTransfer(transfer) {
    transfer.status = 'initializing';
    transfer.startedAt = transfer.startedAt || Date.now();
    this.emitTransfer(transfer);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (transfer.batchId) headers['X-Batch-ID'] = transfer.batchId;
      const response = await fetch(apiUrl('/api/upload/init'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename: transfer.name, fileSize: transfer.size }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Upload initialization failed (${response.status})`);
      }
      const data = await response.json();
      if (transfer.status === 'cancelled') {
        // Cancelled while the init round-trip was in flight; drop the orphan session
        fetch(apiUrl(`/api/upload/cancel/${data.uploadId}`), { method: 'POST' }).catch(() => {});
        return;
      }
      transfer.uploadId = data.uploadId;
      if (data.maxChunkBytes) transfer.serverMaxChunk = data.maxChunkBytes;
      if (transfer.size === 0) {
        this.finishTransfer(transfer, 'done');
      } else {
        transfer.status = 'uploading';
        this.emitTransfer(transfer);
      }
    } catch (error) {
      if (transfer.status !== 'cancelled') this.finishTransfer(transfer, 'failed', error.message);
    }
  }

  sendChunk(task) {
    const { transfer, start, end } = task;
    const taskId = `c${++taskCounter}`;
    const body = transfer.file.slice(start, end);
    const bytes = end - start;

    return new Promise((resolve) => {
      if (isTerminal(transfer)) return resolve();
      const xhr = new XMLHttpRequest();
      transfer.xhrs.add(xhr);
      transfer.inflight.set(taskId, 0);
      // Generous stall guard: ~64KB/s floor plus fixed overhead
      xhr.timeout = Math.max(60000, Math.ceil(bytes / (64 * 1024)) * 1000 + 30000);

      const cleanup = () => {
        transfer.xhrs.delete(xhr);
        transfer.inflight.delete(taskId);
      };

      const fail = (reason, { retryable = true, status = 0 } = {}) => {
        cleanup();
        if (isTerminal(transfer)) return resolve();
        if (status === 404) {
          // Session vanished: either finished behind our back or evicted
          this.repairFromStatus(transfer, `Upload session lost (${reason})`).finally(resolve);
          return;
        }
        if (retryable && task.attempt < this.maxRetries) {
          const delay = status === 429 ? 1500 : Math.min(800 * 2 ** task.attempt, 8000);
          // Free the connection slot now; re-queue the range after the backoff
          setTimeout(() => {
            if (!isTerminal(transfer)) {
              transfer.retryQueue.push({ start, end, attempt: task.attempt + 1 });
              this.pump();
            }
          }, delay);
          return resolve();
        }
        this.finishTransfer(transfer, 'failed', reason);
        resolve();
      };

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          transfer.inflight.set(taskId, Math.min(event.loaded, bytes));
          this.markDirty();
        }
      };
      xhr.onerror = () => fail('Network error');
      xhr.ontimeout = () => fail('Chunk timed out');
      xhr.onabort = () => { cleanup(); resolve(); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          cleanup();
          transfer.committed += bytes;
          this.adaptChunkSize();
          let data = {};
          try { data = JSON.parse(xhr.responseText); } catch { /* server ack without body */ }
          if (data.complete) {
            this.finishTransfer(transfer, 'done');
          } else if (transfer.nextOffset >= transfer.size && !transfer.inflight.size && !transfer.retryQueue.length) {
            // Everything we know of was acknowledged but the server disagrees; ask it what is missing
            this.repairFromStatus(transfer, 'Server reported missing bytes');
          }
          this.markDirty();
          return resolve();
        }
        let message = `Chunk failed (${xhr.status})`;
        try { message = JSON.parse(xhr.responseText).error || message; } catch { /* keep default */ }
        const retryable = xhr.status >= 500 || xhr.status === 429 || xhr.status === 408;
        fail(message, { retryable, status: xhr.status });
      };

      xhr.open('POST', apiUrl(`/api/upload/chunk/${transfer.uploadId}`));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Chunk-Offset', String(start));
      if (transfer.batchId) xhr.setRequestHeader('X-Batch-ID', transfer.batchId);
      xhr.send(body);
    });
  }

  /**
   * Ask the server which byte ranges it still lacks and queue just those.
   */
  async repairFromStatus(transfer, reason) {
    if (isTerminal(transfer)) return;
    try {
      const response = await fetch(apiUrl(`/api/upload/status/${transfer.uploadId}`));
      if (response.status === 404) throw new Error(reason);
      if (!response.ok) throw new Error(`Status check failed (${response.status})`);
      const status = await response.json();
      if (status.complete) {
        transfer.committed = transfer.size;
        this.finishTransfer(transfer, 'done');
        return;
      }
      if (transfer.repairs >= MAX_STATUS_REPAIRS) throw new Error(reason);
      transfer.repairs += 1;
      transfer.committed = status.bytesReceived || 0;
      const chunk = this.currentChunkBytes(transfer);
      for (const [gapStart, gapEnd] of status.missing || []) {
        for (let s = gapStart; s < gapEnd; s += chunk) {
          transfer.retryQueue.push({ start: s, end: Math.min(s + chunk, gapEnd), attempt: 0 });
        }
      }
      transfer.nextOffset = transfer.size;
      this.pump();
    } catch (error) {
      this.finishTransfer(transfer, 'failed', error.message);
    }
  }

  finishTransfer(transfer, status, error = null) {
    if (isTerminal(transfer)) return;
    transfer.status = status;
    transfer.error = error;
    transfer.finishedAt = Date.now();
    if (status === 'done') transfer.committed = transfer.size;
    transfer.inflight.clear();
    transfer.retryQueue = [];
    // Anything still in flight is a duplicate of bytes the server already has
    // (or belongs to a failed/cancelled file) — stop wasting bandwidth on it
    transfer.xhrs.forEach((xhr) => xhr.abort());
    transfer.xhrs.clear();
    this.emitTransfer(transfer);
    this.markDirty();
  }

  checkFinished() {
    if (!this.running || this.finishedAt) return;
    if (this.active.size) return;
    const pending = this.transfers.some((t) => !isTerminal(t));
    if (pending) return;
    this.finishedAt = Date.now();
    this.running = false;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    this.sample();
    this.emitUpdate();
    this.onFinish?.(this.snapshot());
  }

  // ----- stats -----

  sample() {
    const now = Date.now();
    let sent = 0;
    for (const t of this.transfers) if (t.status !== 'cancelled') sent += sentOf(t);
    this.samples.push({ t: now, sent });
    while (this.samples.length > 2 && now - this.samples[0].t > RATE_WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    const dt = (now - first.t) / 1000;
    if (dt > 0.2) {
      this.rate = Math.max(0, (sent - first.sent) / dt);
      this.peakRate = Math.max(this.peakRate, this.rate);
    }
    if (this.running) {
      this.history.push(this.rate);
      if (this.history.length > HISTORY_LENGTH) this.history.shift();
    }
    this.markDirty();
  }

  markDirty() {
    this.dirty = true;
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      if (this.dirty) this.emitUpdate();
    }, UPDATE_THROTTLE_MS);
  }

  emitUpdate() {
    this.dirty = false;
    this.onUpdate?.(this.snapshot());
  }

  emitTransfer(transfer) {
    this.onTransfer?.(transfer);
    this.markDirty();
  }
}

function clampConcurrency(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return 4;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(value)));
}

function isTerminal(transfer) {
  return transfer.status === 'done' || transfer.status === 'failed' || transfer.status === 'cancelled';
}

export function sentOf(transfer) {
  if (transfer.status === 'done') return transfer.size;
  let inflight = 0;
  for (const loaded of transfer.inflight.values()) inflight += loaded;
  return Math.min(transfer.size, transfer.committed + inflight);
}
