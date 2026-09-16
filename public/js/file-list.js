/**
 * File library, share links, rename/share dialogs.
 * Folder navigation, sortable table, and overflow menus replace the old tree.
 */

import { apiUrl, formatFileSize, escapeHtml, toast, askConfirm } from './utils.js';
import { fileGlyph } from './icons.js';

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function parentPath(itemPath) {
  const parts = itemPath.split('/').filter(Boolean);
  parts.pop();
  return parts;
}

export class FileListManager {
  constructor() {
    this.libraryPanel = document.getElementById('libraryPanel');
    this.uploadedFilesContent = document.getElementById('uploadedFilesContent');
    this.totalFilesSpan = document.getElementById('totalFiles');
    this.totalSizeSpan = document.getElementById('totalSize');
    this.refreshBtn = document.getElementById('refreshFilesBtn');
    this.searchInput = document.getElementById('fileSearch');
    this.breadcrumb = document.getElementById('fileBreadcrumb');
    this.renameModal = document.getElementById('renameModal');
    this.renameInput = document.getElementById('renameInput');
    this.currentRenameData = null;
    this.cwd = [];
    this.items = [];
    this.filter = '';
    this.sortKey = 'name';
    this.sortDir = 'asc';
    this.menu = null;

    if (!window.APP_CONFIG?.showFileList) return;
    this.init();
  }

  init() {
    this.libraryPanel.hidden = false;
    document.body.classList.add('app--library');
    document.querySelectorAll('.rail-library').forEach((el) => {
      el.hidden = false;
    });
    this.refreshBtn.addEventListener('click', () => this.loadFiles());
    this.searchInput?.addEventListener('input', (e) => {
      this.filter = e.target.value.trim().toLowerCase();
      if (this.filter) this.cwd = [];
      this.render();
    });
    this.renameModal.addEventListener('click', (e) => {
      if (e.target === this.renameModal) this.cancelRename();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.renameModal.classList.contains('open')) this.cancelRename();
      if (e.key === '/' && e.target === document.body) {
        e.preventDefault();
        this.searchInput?.focus();
      }
    });
    document.querySelectorAll('.th-sort').forEach((btn) => {
      btn.addEventListener('click', () => this.setSort(btn.dataset.sort));
    });
    document.addEventListener('click', () => this.closeMenu());
    window.addEventListener('resize', () => this.closeMenu());
    this.loadFiles();
  }

  setSort(key) {
    if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    else {
      this.sortKey = key;
      this.sortDir = key === 'name' ? 'asc' : 'desc';
    }
    document.querySelectorAll('.th-sort').forEach((btn) => {
      btn.dataset.dir = btn.dataset.sort === this.sortKey ? this.sortDir : '';
    });
    this.render();
  }

  async loadFiles() {
    try {
      this.uploadedFilesContent.innerHTML =
        '<tr class="empty-row"><td colspan="4">Loading files…</td></tr>';
      const response = await fetch(apiUrl('/api/files'));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      this.items = data.items || [];
      this.totalFiles = data.totalFiles;
      this.totalSize = data.totalSize;
      this.formattedTotalSize = data.formattedTotalSize;
      this.render();
    } catch (error) {
      this.uploadedFilesContent.innerHTML = `<tr class="empty-row error"><td colspan="4">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  flatten(items, acc = []) {
    for (const item of items) {
      acc.push(item);
      if (item.children?.length) this.flatten(item.children, acc);
    }
    return acc;
  }

  itemsAtCwd() {
    let current = this.items;
    for (const segment of this.cwd) {
      const folder = current.find((item) => item.type === 'directory' && item.name === segment);
      if (!folder) {
        this.cwd = [];
        return this.items;
      }
      current = folder.children || [];
    }
    return current;
  }

  sortItems(items) {
    const dir = this.sortDir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      if (this.sortKey === 'name' && a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      if (this.sortKey === 'size') return (a.size - b.size) * dir;
      if (this.sortKey === 'date') {
        return (new Date(a.uploadDate) - new Date(b.uploadDate)) * dir;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir;
    });
  }

  render() {
    this.totalFilesSpan.textContent = String(this.totalFiles ?? 0);
    this.totalSizeSpan.textContent = this.formattedTotalSize || formatFileSize(this.totalSize);
    this.renderBreadcrumb();

    let rows;
    if (this.filter) {
      rows = this.flatten(this.items).filter((item) =>
        item.name.toLowerCase().includes(this.filter)
      );
    } else {
      rows = this.itemsAtCwd();
    }
    rows = this.sortItems(rows);

    if (!rows.length) {
      const message = this.filter
        ? 'No matching files'
        : this.cwd.length
          ? 'This folder is empty'
          : 'Nothing here yet. Drop files anywhere, or use Upload.';
      this.uploadedFilesContent.innerHTML = `<tr class="empty-row"><td colspan="4"><div class="empty-cta"><p>${escapeHtml(message)}</p></div></td></tr>`;
      return;
    }

    this.uploadedFilesContent.replaceChildren();
    const frag = document.createDocumentFragment();
    rows.forEach((item) => frag.appendChild(this.createRow(item)));
    this.uploadedFilesContent.appendChild(frag);
  }

  renderBreadcrumb() {
    if (!this.breadcrumb) return;
    this.breadcrumb.replaceChildren();
    const root = this.crumbButton('All files', []);
    if (!this.cwd.length && !this.filter) root.setAttribute('aria-current', 'location');
    this.breadcrumb.appendChild(root);
    if (this.filter) {
      this.breadcrumb.append(this.crumbSep(), this.crumbLabel(`Search “${this.filter}”`));
      return;
    }
    this.cwd.forEach((segment, index) => {
      this.breadcrumb.appendChild(this.crumbSep());
      const path = this.cwd.slice(0, index + 1);
      const btn = this.crumbButton(segment, path);
      if (index === this.cwd.length - 1) btn.setAttribute('aria-current', 'location');
      this.breadcrumb.appendChild(btn);
    });
  }

  crumbButton(label, path) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crumb';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      this.filter = '';
      if (this.searchInput) this.searchInput.value = '';
      this.cwd = path;
      this.render();
    });
    return btn;
  }

  crumbSep() {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.innerHTML = '<svg class="icon"><use href="#i-chevron"></use></svg>';
    return sep;
  }

  crumbLabel(text) {
    const span = document.createElement('span');
    span.className = 'crumb';
    span.setAttribute('aria-current', 'location');
    span.textContent = text;
    return span;
  }

  createRow(item) {
    const tr = document.createElement('tr');
    if (item.type === 'directory') tr.className = 'is-dir';

    const nameTd = document.createElement('td');
    const cell = document.createElement('div');
    cell.className = 'file-cell';
    const glyph = document.createElement('span');
    glyph.className = `file-glyph${item.type === 'directory' ? ' is-dir' : ''}`;
    glyph.innerHTML = fileGlyph(item);
    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = item.name;
    text.appendChild(name);
    if (this.filter && item.path.includes('/')) {
      const path = document.createElement('div');
      path.className = 'file-path';
      path.textContent = parentPath(item.path).join(' / ');
      text.appendChild(path);
    }
    cell.append(glyph, text);
    nameTd.appendChild(cell);

    const sizeTd = document.createElement('td');
    sizeTd.className = 'col-size';
    sizeTd.textContent = item.formattedSize || formatFileSize(item.size);

    const dateTd = document.createElement('td');
    dateTd.className = 'col-date';
    dateTd.textContent =
      item.type === 'directory'
        ? `${this.countFilesInDirectory(item)} files`
        : formatDate(item.uploadDate);

    const actionTd = document.createElement('td');
    actionTd.className = 'col-actions';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn btn-ghost btn-icon';
    more.setAttribute('aria-label', `Actions for ${item.name}`);
    more.innerHTML = '<svg class="icon"><use href="#i-more"></use></svg>';
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openMenu(more, item);
    });
    actionTd.appendChild(more);

    tr.append(nameTd, sizeTd, dateTd, actionTd);
    tr.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      if (item.type === 'directory') this.openFolder(item);
    });
    tr.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) return;
      if (item.type === 'file') this.downloadFile(item.path);
    });
    return tr;
  }

  openFolder(item) {
    this.filter = '';
    if (this.searchInput) this.searchInput.value = '';
    this.cwd = item.path.split('/').filter(Boolean);
    this.render();
  }

  openMenu(anchor, item) {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    const addItem = (label, handler, danger = false) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (danger) btn.classList.add('is-danger');
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.closeMenu();
        handler();
      });
      menu.appendChild(btn);
    };
    if (item.type === 'file') addItem('Download', () => this.downloadFile(item.path));
    addItem('Share', () => this.openShare(item.path));
    addItem('Rename', () => this.renameItem(item.path, item.type, item.name));
    addItem('Delete', () => this.deleteItem(item.path, item.type), true);

    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    const left = Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;
    this.menu = menu;
  }

  closeMenu() {
    document.querySelectorAll('.menu').forEach((el) => el.remove());
    this.menu = null;
  }

  countFilesInDirectory(dir) {
    if (!dir.children) return 0;
    return dir.children.reduce(
      (count, child) => count + (child.type === 'file' ? 1 : this.countFilesInDirectory(child)),
      0
    );
  }

  downloadFile(filePath) {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    window.open(apiUrl(`/api/files/download/${encodedPath}`), '_blank');
  }

  openShare(itemPath) {
    this.currentSharePath = itemPath;
    this.currentShareToken = null;
    document.getElementById('shareItemName').textContent = itemPath.split('/').pop();
    document.getElementById('shareForm').hidden = false;
    document.getElementById('shareResult').hidden = true;
    document.getElementById('createShareBtn').hidden = false;
    document.getElementById('copyShareBtn').hidden = true;
    document.getElementById('downloadQrBtn').hidden = true;
    document.getElementById('shareAuth').checked = false;
    document.getElementById('shareExpiry').value = '0';
    document.getElementById('shareModal').classList.add('open');
  }

  closeShare() {
    document.getElementById('shareModal').classList.remove('open');
  }

  async createShare() {
    const createBtn = document.getElementById('createShareBtn');
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    try {
      const response = await fetch(apiUrl('/api/files/share'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: this.currentSharePath,
          authRequired: document.getElementById('shareAuth').checked,
          expiresIn: Number(document.getElementById('shareExpiry').value),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not create share');
      this.currentShareToken = data.token;
      document.getElementById('shareLink').value = data.url;
      document.getElementById('shareQrImage').src = `${data.qrUrl}?t=${Date.now()}`;
      document.getElementById('shareForm').hidden = true;
      document.getElementById('shareResult').hidden = false;
      document.getElementById('createShareBtn').hidden = true;
      document.getElementById('copyShareBtn').hidden = false;
      document.getElementById('downloadQrBtn').hidden = false;
      window.dispatchEvent(new CustomEvent('dumbdrop:shares-changed'));
    } catch (error) {
      toast(error.message, false);
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = 'Create link';
    }
  }

  async copyShare() {
    await navigator.clipboard.writeText(document.getElementById('shareLink').value);
    toast('Share link copied');
  }

  downloadShareQr() {
    if (!this.currentShareToken) return;
    const link = document.createElement('a');
    link.href = apiUrl(`/api/shares/${encodeURIComponent(this.currentShareToken)}/qr.png`);
    link.download = `dumbdrop-share-${this.currentShareToken.slice(0, 8)}.png`;
    link.click();
  }

  async deleteItem(itemPath, itemType) {
    const itemName = itemPath.split('/').pop();
    const ok = await askConfirm({
      title: itemType === 'directory' ? 'Delete folder?' : 'Delete file?',
      message:
        itemType === 'directory'
          ? `“${itemName}” and everything inside it will be removed.`
          : `“${itemName}” will be permanently deleted.`,
      ok: 'Delete',
    });
    if (!ok) return;
    try {
      const encodedPath = itemPath.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(apiUrl(`/api/files/${encodedPath}`), { method: 'DELETE' });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Delete failed');
      }
      toast(`${itemType === 'directory' ? 'Folder' : 'File'} deleted`);
      this.loadFiles();
    } catch (error) {
      toast(error.message, false);
    }
  }

  renameItem(itemPath, itemType, currentName) {
    this.currentRenameData = { itemPath, itemType, currentName };
    this.renameInput.value = currentName;
    this.renameModal.classList.add('open');
    this.renameInput.focus();
    this.renameInput.select();
    this.currentKeydownHandler = (e) => {
      if (e.key === 'Enter') this.confirmRename();
    };
    this.renameInput.addEventListener('keydown', this.currentKeydownHandler);
  }

  cancelRename() {
    this.renameModal.classList.remove('open');
    this.currentRenameData = null;
    if (this.currentKeydownHandler) {
      this.renameInput.removeEventListener('keydown', this.currentKeydownHandler);
      this.currentKeydownHandler = null;
    }
  }

  async confirmRename() {
    if (!this.currentRenameData) return;
    const newName = this.renameInput.value.trim();
    if (!newName) return;
    if (newName === this.currentRenameData.currentName) {
      this.cancelRename();
      return;
    }
    try {
      const encodedPath = this.currentRenameData.itemPath
        .split('/')
        .map(encodeURIComponent)
        .join('/');
      const response = await fetch(apiUrl(`/api/files/rename/${encodedPath}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Rename failed');
      }
      const result = await response.json();
      toast(result.message);
      this.cancelRename();
      this.loadFiles();
    } catch (error) {
      toast(error.message, false);
    }
  }
}

export class ShareLinksManager {
  constructor() {
    this.section = document.getElementById('shareLinksSection');
    this.content = document.getElementById('shareLinksContent');
    this.totalSharesSpan = document.getElementById('totalShares');
    this.refreshBtn = document.getElementById('refreshSharesBtn');
    this.filesTab = document.getElementById('filesTab');
    this.sharesTab = document.getElementById('sharesTab');
    this.filesPane = document.getElementById('uploadedFilesList');
    this.sharesPane = this.section;
    this.editing = null;
    if (!window.APP_CONFIG?.showFileList) return;

    this.refreshBtn.addEventListener('click', () => this.loadShares());
    window.addEventListener('dumbdrop:shares-changed', () => this.loadShares());
    document
      .getElementById('cancelEditShareBtn')
      ?.addEventListener('click', () => this.closeEdit());
    document.getElementById('saveEditShareBtn')?.addEventListener('click', () => this.saveEdit());
    document.getElementById('editShareModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'editShareModal') this.closeEdit();
    });
    this.loadShares();
  }

  showPane(name) {
    const filesActive = name === 'files';
    this.filesTab.classList.toggle('active', filesActive);
    this.sharesTab.classList.toggle('active', !filesActive);
    this.filesTab.setAttribute('aria-selected', filesActive ? 'true' : 'false');
    this.sharesTab.setAttribute('aria-selected', filesActive ? 'false' : 'true');
    this.filesPane.classList.toggle('active', filesActive);
    this.sharesPane.classList.toggle('active', !filesActive);
  }

  async loadShares() {
    try {
      this.content.innerHTML =
        '<tr class="empty-row"><td colspan="4">Loading share links…</td></tr>';
      const response = await fetch(apiUrl('/api/files/shares/manage'));
      if (!response.ok) throw new Error('Failed to load share links');
      const data = await response.json();
      this.renderShares(data.shares || []);
    } catch (error) {
      this.content.innerHTML = `<tr class="empty-row error"><td colspan="4">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  renderShares(shares) {
    this.totalSharesSpan.textContent = String(shares.length);
    if (!shares.length) {
      this.content.innerHTML =
        '<tr class="empty-row"><td colspan="4">No share links yet. Share a file from the library.</td></tr>';
      return;
    }
    this.content.replaceChildren();
    shares.forEach((share) => this.content.appendChild(this.createShareRow(share)));
  }

  createShareRow(share) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    const cell = document.createElement('div');
    cell.className = 'file-cell';
    const glyph = document.createElement('span');
    glyph.className = `file-glyph${share.type === 'directory' ? ' is-dir' : ''}`;
    glyph.innerHTML = fileGlyph({ type: share.type, name: share.name, extension: '' });
    const text = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'file-name';
    title.textContent = share.name;
    const url = document.createElement('div');
    url.className = 'file-path';
    url.textContent = share.url;
    text.append(title, url);
    cell.append(glyph, text);
    nameTd.appendChild(cell);

    const statusTd = document.createElement('td');
    statusTd.className = 'col-status';
    const badge = document.createElement('span');
    if (share.expired) {
      badge.className = 'badge badge-muted';
      badge.textContent = 'Expired';
    } else if (share.authRequired) {
      badge.className = 'badge badge-ok';
      badge.textContent = 'PIN';
    } else {
      badge.className = 'badge badge-ok';
      badge.textContent = 'Open';
    }
    statusTd.appendChild(badge);

    const expTd = document.createElement('td');
    expTd.className = 'col-date';
    expTd.textContent = share.expiresAt ? formatDate(share.expiresAt) : 'Never';

    const actionTd = document.createElement('td');
    actionTd.className = 'col-actions';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn btn-ghost btn-icon';
    more.setAttribute('aria-label', `Actions for ${share.name}`);
    more.innerHTML = '<svg class="icon"><use href="#i-more"></use></svg>';
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openMenu(more, share);
    });
    actionTd.appendChild(more);
    tr.append(nameTd, statusTd, expTd, actionTd);
    return tr;
  }

  openMenu(anchor, share) {
    document.querySelector('.menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'menu';
    const addItem = (label, handler, danger = false) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (danger) btn.classList.add('is-danger');
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        menu.remove();
        handler();
      });
      menu.appendChild(btn);
    };
    addItem('Copy link', async () => {
      await navigator.clipboard.writeText(share.url);
      toast('Link copied');
    });
    addItem('Download QR', () => {
      const link = document.createElement('a');
      link.href = share.qrUrl;
      link.download = `dumbdrop-share-${share.token.slice(0, 8)}.png`;
      link.click();
    });
    addItem('Edit', () => this.editShare(share));
    addItem('Delete', () => this.deleteShare(share), true);
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 8)}px`;
    menu.style.left = `${Math.max(8, rect.right - 168)}px`;
  }

  editShare(share) {
    this.editing = share;
    document.getElementById('editShareName').textContent = share.name;
    document.getElementById('editShareAuth').checked = Boolean(share.authRequired);
    document.getElementById('editShareExpiry').value = share.expiresAt ? '86400' : '0';
    document.getElementById('editShareModal').classList.add('open');
  }

  closeEdit() {
    this.editing = null;
    document.getElementById('editShareModal').classList.remove('open');
  }

  async saveEdit() {
    if (!this.editing) return;
    const response = await fetch(
      apiUrl(`/api/files/shares/${encodeURIComponent(this.editing.token)}`),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authRequired: document.getElementById('editShareAuth').checked,
          expiresIn: Number(document.getElementById('editShareExpiry').value),
        }),
      }
    );
    if (!response.ok) {
      const error = await response.json();
      toast(error.error || 'Update failed', false);
      return;
    }
    toast('Share link updated');
    this.closeEdit();
    this.loadShares();
  }

  async deleteShare(share) {
    const ok = await askConfirm({
      title: 'Delete share link?',
      message: `People with the link for “${share.name}” will lose access.`,
      ok: 'Delete',
    });
    if (!ok) return;
    const response = await fetch(apiUrl(`/api/files/shares/${encodeURIComponent(share.token)}`), {
      method: 'DELETE',
    });
    if (!response.ok) {
      const error = await response.json();
      toast(error.error || 'Delete failed', false);
      return;
    }
    toast('Share link deleted');
    this.loadShares();
  }
}
