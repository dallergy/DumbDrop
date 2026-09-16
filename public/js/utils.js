/**
 * Shared client helpers for DumbDrop.
 */

export function loadAppConfig() {
  const el = document.getElementById('app-config');
  try {
    return JSON.parse(el?.textContent || '{}');
  } catch {
    return {};
  }
}

export function apiUrl(path) {
  const base = (window.APP_CONFIG?.basePath || '/').replace(/\/+$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`;
}

export function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatRate(bytesPerSecond) {
  return `${formatFileSize(bytesPerSecond)}/s`;
}

/**
 * Line speeds are sold in megabits; show both so users can compare with their plan.
 */
export function formatMbps(bytesPerSecond) {
  const mbps = (bytesPerSecond * 8) / 1_000_000;
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`;
  return `${mbps.toFixed(mbps >= 100 ? 0 : 1)} Mbps`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '<1s';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Persisted user preferences (upload tuning, etc.) with safe fallbacks.
 */
export function readSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(`dumbdrop:${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeSetting(key, value) {
  try {
    localStorage.setItem(`dumbdrop:${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode); keep in-memory value */
  }
}

export function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function generateBatchId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function toast(text, ok = true) {
  Toastify({
    text,
    duration: 2800,
    gravity: 'bottom',
    position: 'right',
    style: {
      background: ok ? 'oklch(0.42 0.12 155)' : 'oklch(0.5 0.18 25)',
      color: '#fff',
      borderRadius: '10px',
      boxShadow: '0 8px 24px rgba(0,0,0,.18)',
    },
  }).showToast();
}

let confirmResolver = null;

/**
 * Promise-based confirm dialog. Falls back to window.confirm if markup is missing.
 */
export function askConfirm({
  title = 'Are you sure?',
  message,
  ok = 'Delete',
  danger = true,
} = {}) {
  const modal = document.getElementById('confirmModal');
  if (!modal) return Promise.resolve(window.confirm(message || title));
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message || '';
  const okBtn = document.getElementById('confirmOk');
  okBtn.textContent = ok;
  okBtn.className = danger ? 'btn btn-destructive' : 'btn btn-primary';
  modal.classList.add('open');
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

export function initConfirmDialog() {
  const modal = document.getElementById('confirmModal');
  if (!modal) return;
  const finish = (value) => {
    modal.classList.remove('open');
    if (confirmResolver) confirmResolver(value);
    confirmResolver = null;
  };
  document.getElementById('confirmCancel')?.addEventListener('click', () => finish(false));
  document.getElementById('confirmOk')?.addEventListener('click', () => finish(true));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) finish(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) finish(false);
  });
}

export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function workerLoop() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => workerLoop());
  await Promise.all(workers);
  return results;
}
