/**
 * Public share landing page.
 */

import { loadAppConfig, apiUrl, formatFileSize } from './utils.js';
import { initTheme } from './theme.js';
import { fileGlyph } from './icons.js';

initTheme();
window.APP_CONFIG = { basePath: '/', ...loadAppConfig() };

const token = document.getElementById('shareRoot')?.dataset.shareToken || '';

function renderShareTree(items, container) {
  if (!items?.length) return;
  const list = document.createElement('ul');
  list.className = 'share-items';
  items.forEach((item) => {
    const row = document.createElement('li');
    row.className = 'share-tree-row';
    const label = document.createElement('div');
    label.className = 'share-tree-label file-cell';
    const glyph = document.createElement('span');
    glyph.className = `file-glyph${item.type === 'directory' ? ' is-dir' : ''}`;
    glyph.innerHTML = fileGlyph(item);
    const name = document.createElement('span');
    name.textContent =
      item.type === 'file' ? `${item.name} · ${formatFileSize(item.size)}` : item.name;
    name.title = item.name;
    label.append(glyph, name);
    row.appendChild(label);
    if (item.type === 'file') {
      const link = document.createElement('a');
      link.className = 'btn btn-ghost btn-icon btn-sm';
      link.setAttribute('aria-label', `Download ${item.name}`);
      link.title = `Download ${item.name}`;
      link.href = apiUrl(
        `/api/shares/${encodeURIComponent(token)}/file/${item.path.split('/').map(encodeURIComponent).join('/')}`
      );
      link.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4"/></svg>';
      row.appendChild(link);
    }
    if (item.children?.length) {
      const childWrap = document.createElement('div');
      childWrap.className = 'share-tree-children';
      renderShareTree(item.children, childWrap);
      row.appendChild(childWrap);
    }
    list.appendChild(row);
  });
  container.appendChild(list);
}

async function load() {
  const response = await fetch(apiUrl(`/api/shares/${encodeURIComponent(token)}`));
  const data = await response.json();
  if (!response.ok) {
    document.getElementById('name').textContent = 'Link unavailable';
    document.getElementById('typeBadge').textContent = 'Shared with you';
    document.getElementById('error').textContent =
      data.error || 'This link has expired or was removed.';
    return;
  }

  const isFolder = data.type === 'directory';
  document.getElementById('name').textContent = data.name;
  document.getElementById('icon').classList.toggle('is-dir', isFolder);
  document.getElementById('icon').innerHTML = fileGlyph({
    type: isFolder ? 'directory' : 'file',
    name: data.name,
    extension: '',
  });
  document.title = `${data.name} · ${document.title.split(' · ').pop()}`;
  document.getElementById('typeBadge').textContent = isFolder
    ? 'Folder shared with you'
    : 'File shared with you';
  document.getElementById('meta').textContent =
    formatFileSize(data.size) +
    (data.expiresAt
      ? ` · Expires ${new Date(data.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
      : '');

  const qrUrl = apiUrl(`/api/shares/${encodeURIComponent(token)}/qr.png`);
  document.getElementById('qrImage').src = qrUrl;
  const qrDownload = document.getElementById('downloadQr');
  qrDownload.href = qrUrl;
  qrDownload.download = `dumbdrop-share-${token.slice(0, 8)}.png`;

  document.getElementById('auth').hidden = data.authenticated;
  document.getElementById('content').hidden = !data.authenticated;
  document.getElementById('download').hidden = !data.authenticated;
  document.getElementById('download').href = apiUrl(
    `/api/shares/${encodeURIComponent(token)}/download`
  );
  document.getElementById('downloadLabel').textContent = isFolder ? 'Download as ZIP' : 'Download';

  const itemsRoot = document.getElementById('items');
  itemsRoot.replaceChildren();
  if (data.items) renderShareTree(data.items, itemsRoot);
}

document.getElementById('auth').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch(apiUrl(`/api/shares/${encodeURIComponent(token)}/auth`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: document.getElementById('pin').value }),
  });
  if (response.ok) {
    document.getElementById('error').textContent = '';
    load();
    return;
  }
  document.getElementById('error').textContent = (await response.json()).error;
});

load();
