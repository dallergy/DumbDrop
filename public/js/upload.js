/**
 * Upload UI: staging queue, live transfer dashboard and per-file cards.
 * All transfer logic lives in TransferEngine; this file only renders it.
 */

import {
  formatFileSize, formatRate, formatMbps, formatDuration, escapeHtml,
  generateBatchId, toast, readSetting, writeSetting,
} from './utils.js';
import { TransferEngine, MAX_CONCURRENCY, sentOf } from './transfer-engine.js';

const QUEUE_PREVIEW_LIMIT = 60;
const CARD_LINGER_MS = 1800;
const SPARK_W = 300;
const SPARK_H = 56;

const ICON_X = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export function loadUploadSettings() {
  const cfg = window.APP_CONFIG || {};
  return {
    concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, readSetting('concurrency', cfg.uploadConcurrency || 4))),
    chunkBytes: readSetting('chunkBytes', cfg.uploadChunkBytes || 0),
  };
}

export class UploadQueue {
  constructor() {
    this.autoUpload = Boolean(window.APP_CONFIG?.autoUpload);
    this.maxFileSize = Number(window.APP_CONFIG?.maxFileSize) || Infinity;
    this.staged = [];
    this.cards = new Map();
    this.settings = loadUploadSettings();

    this.engine = new TransferEngine({
      concurrency: this.settings.concurrency,
      chunkBytes: this.settings.chunkBytes,
      maxRetries: window.APP_CONFIG?.maxRetries ?? 5,
      onUpdate: (snapshot) => this.render(snapshot),
      onTransfer: (transfer) => this.syncCard(transfer),
      onFinish: (snapshot) => this.finished(snapshot),
    });

    this.el = {
      queue: document.getElementById('fileList'),
      uploadButton: document.getElementById('uploadButton'),
      panel: document.getElementById('transferPanel'),
      title: document.getElementById('transferTitle'),
      subtitle: document.getElementById('transferSubtitle'),
      pause: document.getElementById('pauseBtn'),
      cancelAll: document.getElementById('cancelAllBtn'),
      clear: document.getElementById('clearTransfersBtn'),
      speed: document.getElementById('statSpeed'),
      speedBits: document.getElementById('statSpeedBits'),
      eta: document.getElementById('statEta'),
      etaSub: document.getElementById('statEtaSub'),
      moved: document.getElementById('statMoved'),
      movedSub: document.getElementById('statMovedSub'),
      streams: document.getElementById('statStreams'),
      streamsSub: document.getElementById('statStreamsSub'),
      sparkLine: document.querySelector('#sparkline .spark-line'),
      sparkFill: document.querySelector('#sparkline .spark-fill'),
      totalBar: document.getElementById('totalBar'),
      list: document.getElementById('transferList'),
      footer: document.getElementById('transferFooter'),
      concurrency: document.getElementById('settingConcurrency'),
      concurrencyValue: document.getElementById('settingConcurrencyValue'),
      chunk: document.getElementById('settingChunk'),
    };

    this.bindControls();
  }

  bindControls() {
    this.el.pause?.addEventListener('click', () => {
      if (this.engine.paused) this.engine.resume(); else this.engine.pause();
    });
    this.el.cancelAll?.addEventListener('click', () => this.engine.cancelAll());
    this.el.clear?.addEventListener('click', () => this.clearFinished());

    if (this.el.concurrency) {
      this.el.concurrency.max = String(MAX_CONCURRENCY);
      this.el.concurrency.value = String(this.settings.concurrency);
      this.el.concurrencyValue.textContent = String(this.settings.concurrency);
      this.el.concurrency.addEventListener('input', (e) => {
        const value = Number(e.target.value);
        this.settings.concurrency = value;
        this.el.concurrencyValue.textContent = String(value);
        writeSetting('concurrency', value);
        this.engine.setConcurrency(value);
      });
    }
    if (this.el.chunk) {
      this.el.chunk.value = String(this.settings.chunkBytes || 0);
      this.el.chunk.addEventListener('change', (e) => {
        const value = Number(e.target.value);
        this.settings.chunkBytes = value;
        writeSetting('chunkBytes', value);
        this.engine.setChunkBytes(value);
      });
    }
  }

  // ----- staging -----

  setFiles(fileList) {
    this.addFiles(fileList);
  }

  addFiles(fileList) {
    const files = [...fileList].filter((file) => {
      if (file.size > this.maxFileSize) {
        toast(`${file.name} is larger than the ${formatFileSize(this.maxFileSize)} limit`, false);
        return false;
      }
      return true;
    });
    if (!files.length) return;
    if (this.autoUpload) {
      this.launch(files);
      return;
    }
    this.staged = [...this.staged, ...files];
    this.renderQueue();
  }

  clear() {
    this.staged = [];
    this.renderQueue();
  }

  start() {
    if (!this.staged.length) return;
    const files = this.staged;
    this.staged = [];
    this.renderQueue();
    this.launch(files);
  }

  launch(files) {
    this.el.panel.hidden = false;
    this.el.panel.classList.remove('is-finished');
    this.el.clear.hidden = true;
    this.engine.add(files, generateBatchId());
    this.engine.start();
  }

  renderQueue() {
    const { queue, uploadButton } = this.el;
    queue.replaceChildren();
    if (!this.staged.length) {
      uploadButton.hidden = true;
      return;
    }
    const total = this.staged.reduce((sum, f) => sum + f.size, 0);
    const preview = this.staged.slice(0, QUEUE_PREVIEW_LIMIT);
    const frag = document.createDocumentFragment();
    preview.forEach((file) => {
      const item = document.createElement('div');
      item.className = 'queue-item';
      item.innerHTML = `<span class="queue-name">${escapeHtml(file.webkitRelativePath || file.name)}</span><span class="queue-size">${formatFileSize(file.size)}</span>`;
      frag.appendChild(item);
    });
    if (this.staged.length > preview.length) {
      const more = document.createElement('div');
      more.className = 'queue-item queue-more';
      more.textContent = `…and ${this.staged.length - preview.length} more`;
      frag.appendChild(more);
    }
    queue.appendChild(frag);
    uploadButton.hidden = false;
    uploadButton.textContent = `Upload ${this.staged.length} file${this.staged.length === 1 ? '' : 's'} · ${formatFileSize(total)}`;
  }

  // ----- dashboard -----

  render(snapshot) {
    const s = snapshot;
    const { el } = this;
    if (el.panel.hidden) return;

    const pct = s.totalBytes ? (s.sentBytes / s.totalBytes) * 100 : 0;
    el.totalBar.style.width = `${Math.min(100, pct).toFixed(2)}%`;
    el.totalBar.classList.toggle('is-active', s.running && !s.paused && !s.finished);

    el.speed.textContent = formatRate(s.finished ? s.averageRate : s.rate);
    el.speedBits.textContent = s.finished
      ? `${formatMbps(s.averageRate)} avg · ${formatMbps(s.peakRate)} peak`
      : `${formatMbps(s.rate)} · ${formatMbps(s.peakRate)} peak`;

    el.eta.textContent = s.finished ? formatDuration(s.elapsed) : (s.paused ? 'Paused' : formatDuration(s.eta));
    el.etaSub.textContent = s.finished ? 'total time' : `${formatFileSize(s.remainingBytes)} left`;

    el.moved.textContent = formatFileSize(s.sentBytes);
    el.movedSub.textContent = `of ${formatFileSize(s.totalBytes)} · ${pct.toFixed(0)}%`;

    el.streams.textContent = `${s.activeConnections}/${s.concurrency}`;
    el.streamsSub.textContent = `${Math.round(s.chunkBytes / (1024 * 1024))} MB chunks · ${s.adaptiveChunks ? 'auto' : 'fixed'}`;

    this.renderSparkline(s.history, s.peakRate);

    if (s.finished && s.filesTotal === 0) {
      el.title.textContent = 'Uploads cancelled';
      el.subtitle.textContent = 'Nothing was kept on the server';
    } else if (s.finished) {
      const failed = s.filesFailed ? ` · ${s.filesFailed} failed` : '';
      el.title.textContent = s.filesFailed ? 'Finished with errors' : 'All uploads complete';
      el.subtitle.textContent = `${s.filesDone} of ${s.filesTotal} file${s.filesTotal === 1 ? '' : 's'} uploaded${failed}`;
    } else if (s.paused) {
      el.title.textContent = 'Paused';
      el.subtitle.textContent = `${s.filesDone} of ${s.filesTotal} done · in-flight chunks will finish`;
    } else {
      el.title.textContent = `Uploading ${s.filesActive || 1} of ${s.filesTotal - s.filesDone} file${s.filesTotal - s.filesDone === 1 ? '' : 's'}`;
      el.subtitle.textContent = `${s.filesDone} done${s.filesFailed ? ` · ${s.filesFailed} failed` : ''}`;
    }

    el.pause.textContent = s.paused ? 'Resume' : 'Pause';
    el.pause.hidden = s.finished;
    el.cancelAll.hidden = s.finished;
    el.clear.hidden = !s.finished;
    el.panel.classList.toggle('is-finished', s.finished);

    for (const transfer of s.transfers) {
      const card = this.cards.get(transfer.id);
      if (card) this.updateCard(card, transfer);
    }

    const queued = s.transfers.filter((t) => t.status === 'queued').length;
    el.footer.textContent = queued ? `${queued} file${queued === 1 ? '' : 's'} waiting` : '';
  }

  renderSparkline(history, peak) {
    const { sparkLine, sparkFill } = this.el;
    if (!sparkLine || history.length < 2) {
      if (sparkLine) { sparkLine.setAttribute('d', ''); sparkFill.setAttribute('d', ''); }
      return;
    }
    const max = Math.max(peak, ...history, 1);
    const step = SPARK_W / (history.length - 1);
    const points = history.map((v, i) => {
      const x = (i * step).toFixed(1);
      const y = (SPARK_H - 3 - (v / max) * (SPARK_H - 6)).toFixed(1);
      return `${x},${y}`;
    });
    const line = `M${points.join(' L')}`;
    sparkLine.setAttribute('d', line);
    sparkFill.setAttribute('d', `${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z`);
  }

  // ----- per-file cards -----

  syncCard(transfer) {
    const visible = transfer.status === 'initializing' || transfer.status === 'uploading' || transfer.status === 'failed';
    let card = this.cards.get(transfer.id);
    if (visible && !card) {
      card = this.createCard(transfer);
      this.cards.set(transfer.id, card);
      this.el.list.appendChild(card.el);
    }
    if (!card) return;
    this.updateCard(card, transfer);
    if (transfer.status === 'done' || transfer.status === 'cancelled') {
      setTimeout(() => this.removeCard(transfer.id), CARD_LINGER_MS);
    }
  }

  createCard(transfer) {
    const el = document.createElement('article');
    el.className = 'transfer-card';
    el.innerHTML = `
      <div class="transfer-card-head">
        <div class="transfer-card-title">
          <span class="status-dot" aria-hidden="true"></span>
          <span class="transfer-name"></span>
        </div>
        <div class="transfer-card-actions">
          <button type="button" class="btn btn-ghost btn-sm transfer-retry" hidden>Retry</button>
          <button type="button" class="btn btn-ghost btn-icon transfer-cancel" aria-label="Cancel upload">${ICON_X}</button>
        </div>
      </div>
      <div class="progress"><div class="progress-bar"></div></div>
      <div class="transfer-card-meta">
        <span class="transfer-status"></span>
        <span class="transfer-bytes"></span>
      </div>`;
    el.querySelector('.transfer-name').textContent = transfer.name;
    el.querySelector('.transfer-cancel').addEventListener('click', () => this.engine.cancel(transfer.id));
    el.querySelector('.transfer-retry').addEventListener('click', () => this.engine.retry(transfer.id));
    return {
      el,
      bar: el.querySelector('.progress-bar'),
      status: el.querySelector('.transfer-status'),
      bytes: el.querySelector('.transfer-bytes'),
      cancel: el.querySelector('.transfer-cancel'),
      retry: el.querySelector('.transfer-retry'),
    };
  }

  updateCard(card, transfer) {
    const sent = sentOf(transfer);
    const pct = transfer.size ? (sent / transfer.size) * 100 : 100;
    card.bar.style.width = `${Math.min(100, pct).toFixed(2)}%`;
    card.el.dataset.status = transfer.status;
    card.bar.classList.toggle('is-active', transfer.status === 'uploading');

    const labels = {
      queued: 'Waiting',
      initializing: 'Starting…',
      uploading: `${transfer.inflight.size} stream${transfer.inflight.size === 1 ? '' : 's'} · ${pct.toFixed(0)}%`,
      done: 'Complete',
      failed: transfer.error || 'Failed',
      cancelled: 'Cancelled',
    };
    card.status.textContent = labels[transfer.status] || transfer.status;
    card.bytes.textContent = `${formatFileSize(sent)} / ${formatFileSize(transfer.size)}`;
    card.cancel.hidden = transfer.status === 'done' || transfer.status === 'failed' || transfer.status === 'cancelled';
    card.retry.hidden = transfer.status !== 'failed';
  }

  removeCard(id) {
    const card = this.cards.get(id);
    if (!card) return;
    this.cards.delete(id);
    card.el.classList.add('is-leaving');
    setTimeout(() => card.el.remove(), 220);
  }

  finished(snapshot) {
    const ok = snapshot.filesFailed === 0;
    toast(
      ok
        ? `Uploaded ${snapshot.filesDone} file${snapshot.filesDone === 1 ? '' : 's'} at ${formatRate(snapshot.averageRate)}`
        : `${snapshot.filesDone} uploaded, ${snapshot.filesFailed} failed`,
      ok,
    );
    window.dispatchEvent(new CustomEvent('dumbdrop:uploads-finished'));
  }

  clearFinished() {
    if (this.engine.running) return;
    for (const id of [...this.cards.keys()]) this.removeCard(id);
    this.engine.reset();
    this.el.panel.hidden = true;
  }
}
