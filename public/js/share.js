/**
 * Public share landing page.
 */

import { loadAppConfig, apiUrl } from './utils.js';
import { initTheme } from './theme.js';

initTheme();
window.APP_CONFIG = { basePath: '/', ...loadAppConfig() };

const token = document.body.dataset.shareToken || '';

function renderShareTree(items, container) {
  if (!items?.length) return;
  const list = document.createElement('ul');
  list.className = 'share-items';
  items.forEach((item) => {
    const row = document.createElement('li');
    row.className = 'share-tree-row';
    const label = document.createElement('div');
    label.className = 'share-tree-label';
    label.textContent = `${item.type === 'directory' ? '📁' : '📄'} ${item.name}${item.type === 'file' ? ` · ${item.formattedSize}` : ''}`;
    row.appendChild(label);
    if (item.type === 'file') {
      const link = document.createElement('a');
      link.className = 'btn btn-outline btn-sm';
      link.href = apiUrl(`/api/shares/${encodeURIComponent(token)}/file/${item.path.split('/').map(encodeURIComponent).join('/')}`);
      link.textContent = 'Download';
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
    document.getElementById('name').textContent = 'Share unavailable';
    document.getElementById('error').textContent = data.error;
    return;
  }

  const isFolder = data.type === 'directory';
  document.getElementById('name').textContent = data.name;
  document.getElementById('icon').textContent = isFolder ? '📁' : '📄';
  document.getElementById('typeBadge').textContent = isFolder ? 'Shared folder' : 'Shared file';
  document.getElementById('meta').textContent =
    `${isFolder ? 'Folder' : 'File'} · ${data.formattedSize}` +
    (data.expiresAt ? ` · Expires ${new Date(data.expiresAt).toLocaleString()}` : '');

  const qrUrl = apiUrl(`/api/shares/${encodeURIComponent(token)}/qr.png`);
  document.getElementById('qrImage').src = qrUrl;
  const qrDownload = document.getElementById('downloadQr');
  qrDownload.href = qrUrl;
  qrDownload.download = `dumbdrop-share-${token.slice(0, 8)}.png`;

  document.getElementById('auth').hidden = data.authenticated;
  document.getElementById('content').hidden = !data.authenticated;
  document.getElementById('download').hidden = !data.authenticated;
  document.getElementById('download').href = apiUrl(`/api/shares/${encodeURIComponent(token)}/download`);
  document.getElementById('download').textContent = isFolder ? 'Download folder (.zip)' : 'Download file';

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
