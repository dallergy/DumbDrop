/**
 * High-throughput chunked uploader.
 * Uses 8–16MB chunks, offset writes, and concurrent files so speed is not
 * capped at 1MB/s by sequential 1MB round-trips.
 */

import { apiUrl, formatFileSize, formatRate, escapeHtml, generateBatchId, toast, runPool } from './utils.js';

const MIN_CHUNK = 4 * 1024 * 1024;
const DEFAULT_CHUNK = 8 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const FILE_CONCURRENCY = 3;

export class FileUploader {
  constructor(file, batchId, { onProgress, onComplete, onError } = {}) {
    this.file = file;
    this.batchId = batchId;
    this.uploadId = null;
    this.position = 0;
    this.chunkSize = DEFAULT_CHUNK;
    this.maxRetries = window.APP_CONFIG?.maxRetries ?? 5;
    this.aborted = false;
    this.uploadRate = 0;
    this.lastUploadedBytes = 0;
    this.lastUploadTime = Date.now();
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    this.controller = new AbortController();
  }

  abort() {
    this.aborted = true;
    this.controller.abort();
    if (this.uploadId) {
      fetch(apiUrl(`/api/upload/cancel/${this.uploadId}`), { method: 'POST' }).catch(() => {});
    }
  }

  async start() {
    try {
      this.emitProgress(0);
      await this.initUpload();
      if (this.file.size > 0) {
        await this.uploadChunks();
      }
      this.emitProgress(100);
      this.onComplete?.(this);
      return true;
    } catch (error) {
      if (!this.aborted) this.onError?.(this, error);
      return false;
    }
  }

  async initUpload() {
    const uploadPath = this.file.webkitRelativePath || this.file.name;
    const headers = { 'Content-Type': 'application/json' };
    if (this.batchId) headers['X-Batch-ID'] = this.batchId;

    const response = await fetch(apiUrl('/api/upload/init'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filename: uploadPath.replace(/\\/g, '/'),
        fileSize: this.file.size,
      }),
      signal: this.controller.signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Upload initialization failed');
    }

    const data = await response.json();
    this.uploadId = data.uploadId;
  }

  async uploadChunks() {
    while (this.position < this.file.size) {
      if (this.aborted) throw new Error('Upload cancelled');
      const start = this.position;
      const end = Math.min(start + this.chunkSize, this.file.size);
      const chunk = await this.file.slice(start, end).arrayBuffer();
      await this.uploadChunkWithRetry(chunk, start);
      this.adaptChunkSize();
    }
  }

  adaptChunkSize() {
    if (this.uploadRate > 12 * 1024 * 1024) {
      this.chunkSize = Math.min(MAX_CHUNK, this.chunkSize * 2);
    } else if (this.uploadRate > 0 && this.uploadRate < 512 * 1024) {
      this.chunkSize = Math.max(MIN_CHUNK, Math.floor(this.chunkSize / 2));
    }
  }

  async uploadChunkWithRetry(chunk, chunkStartPosition) {
    let lastError = null;
    const timeoutMs = Math.max(120000, Math.ceil(chunk.byteLength / (32 * 1024)) * 1000);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.aborted) throw new Error('Upload cancelled');
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const onParentAbort = () => controller.abort();
        this.controller.signal.addEventListener('abort', onParentAbort);

        const response = await fetch(apiUrl(`/api/upload/chunk/${this.uploadId}`), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Batch-ID': this.batchId,
            'X-Chunk-Offset': String(chunkStartPosition),
          },
          body: chunk,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        this.controller.signal.removeEventListener('abort', onParentAbort);

        if (response.ok) {
          const data = await response.json();
          this.position = chunkStartPosition + chunk.byteLength;
          this.emitProgress(data.progress);
          return;
        }

        if (response.status === 404 && attempt > 0) {
          this.emitProgress(100);
          return;
        }

        const errorText = await response.text().catch(() => '');
        lastError = new Error(`Chunk failed: ${response.status} ${errorText}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt < this.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
      }
    }

    throw lastError || new Error('Chunk upload failed');
  }

  emitProgress(percent) {
    const now = Date.now();
    const elapsed = (now - this.lastUploadTime) / 1000;
    if (elapsed > 0) {
      this.uploadRate = (this.position - this.lastUploadedBytes) / elapsed;
    }
    this.lastUploadedBytes = this.position;
    this.lastUploadTime = now;
    this.onProgress?.(this, percent);
  }
}

export class UploadQueue {
  constructor(root) {
    this.root = root;
    this.files = [];
    this.active = [];
    this.autoUpload = Boolean(window.APP_CONFIG?.autoUpload);
  }

  setFiles(fileList) {
    this.files = [...fileList];
    this.renderList();
    if (this.autoUpload && this.files.length) this.start();
  }

  addFiles(fileList) {
    this.files = [...this.files, ...fileList];
    this.renderList();
    if (this.autoUpload && this.files.length) this.start();
  }

  clear() {
    this.files = [];
    this.renderList();
  }

  renderList() {
    const list = document.getElementById('fileList');
    const uploadButton = document.getElementById('uploadButton');
    list.replaceChildren();

    if (!this.files.length) {
      uploadButton.hidden = true;
      return;
    }

    this.files.forEach((file) => {
      const item = document.createElement('div');
      item.className = 'queue-item';
      item.innerHTML = `<span class="queue-name">${escapeHtml(file.webkitRelativePath || file.name)}</span><span class="queue-size">${formatFileSize(file.size)}</span>`;
      list.appendChild(item);
    });

    uploadButton.hidden = this.autoUpload;
  }

  async start() {
    if (!this.files.length) return;
    const files = this.files;
    this.files = [];
    this.renderList();
    document.getElementById('uploadButton').disabled = true;
    const batchId = generateBatchId();
    const progressRoot = document.getElementById('uploadProgress');
    progressRoot.replaceChildren();

    const results = await runPool(files, FILE_CONCURRENCY, async (file) => {
      const card = this.createProgressCard(file);
      progressRoot.appendChild(card.el);
      const uploader = new FileUploader(file, batchId, {
        onProgress: (_u, percent) => this.updateCard(card, file, uploader, percent),
        onComplete: () => this.updateCard(card, file, uploader, 100, 'complete'),
        onError: (_u, err) => this.updateCard(card, file, uploader, 0, err.message),
      });
      card.cancelBtn.addEventListener('click', () => uploader.abort());
      return uploader.start();
    });

    const successful = results.filter(Boolean).length;
    toast(`Uploaded ${successful} of ${files.length} files`, successful === files.length);
    document.getElementById('uploadButton').disabled = false;
    window.dispatchEvent(new CustomEvent('dumbdrop:uploads-finished'));
  }

  createProgressCard(file) {
    const el = document.createElement('div');
    el.className = 'progress-card';
    el.innerHTML = `
      <div class="progress-card-head">
        <div class="progress-label"></div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="Cancel upload">✕</button>
      </div>
      <div class="progress"><div class="progress-bar"></div></div>
      <div class="progress-status">
        <span class="progress-info">starting…</span>
        <span class="progress-details"></span>
      </div>`;
    el.querySelector('.progress-label').textContent = file.webkitRelativePath || file.name;
    return {
      el,
      bar: el.querySelector('.progress-bar'),
      info: el.querySelector('.progress-info'),
      details: el.querySelector('.progress-details'),
      cancelBtn: el.querySelector('button'),
    };
  }

  updateCard(card, file, uploader, percent, status) {
    card.bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    const done = status === 'complete' || percent >= 100;
    card.info.textContent = status && status !== 'complete'
      ? status
      : `${formatRate(uploader.uploadRate)} · ${done ? 'complete' : 'uploading'}`;
    card.details.textContent = `${formatFileSize(uploader.position)} of ${formatFileSize(file.size)} (${percent.toFixed(0)}%)`;
    if (done) {
      card.cancelBtn.hidden = true;
      setTimeout(() => card.el.remove(), 1400);
    }
  }
}
