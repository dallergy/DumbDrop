/**
 * File library, share links, rename/share dialogs.
 * Folder navigation, sortable table, and overflow menus.
 */

import { apiUrl, formatFileSize, toast, askConfirm, openDialog, closeDialog } from './utils.js';
import { fileGlyph } from './icons.js';

const spriteIcon = (id) => `<svg class="icon" aria-hidden="true"><use href="#${id}"></use></svg>`;

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function parentPath(itemPath) {
  const parts = itemPath.split('/').filter(Boolean);
  parts.pop();
  return parts;
}

function encodePath(itemPath) {
  return itemPath.split('/').map(encodeURIComponent).join('/');
}

function emptyRow(title, detail = '', isError = false) {
  const tr = document.createElement('tr');
  tr.className = `empty-row${isError ? ' error' : ''}`;
  const td = document.createElement('td');
  td.colSpan = 4;
  const box = document.createElement('div');
  box.className = 'empty-state';
  const strong = document.createElement('strong');
  strong.textContent = title;
  box.appendChild(strong);
  if (detail) {
    const p = document.createElement('span');
    p.textContent = detail;
    box.appendChild(p);
  }
  td.appendChild(box);
  tr.appendChild(td);
  return tr;
}

function iconButton(icon, label, handler, extraClass = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn btn-ghost btn-icon btn-sm ${extraClass}`.trim();
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.innerHTML = spriteIcon(icon);
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    handler(btn);
  });
  return btn;
}

/**
 * Shared overflow menu. Only one is open at a time.
 */
function closeMenus() {
  document.querySelectorAll('.menu').forEach((el) => el.remove());
}

function openMenu(anchor, entries) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  entries.forEach((entry) => {
    if (entry === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = spriteIcon(entry.icon);
    btn.append(entry.label);
    if (entry.danger) btn.classList.add('is-danger');
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenus();
      entry.run();
    });
    menu.appendChild(btn);
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('button')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') items[(index + 1) % items.length].focus();
    else if (event.key === 'ArrowUp') items[(index - 1 + items.length) % items.length].focus();
    else if (event.key === 'Escape') {
      closeMenus();
      anchor.focus();
    } else return;
    event.preventDefault();
  });
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const below = rect.bottom + 4 + menu.offsetHeight <= window.innerHeight - 8;
  const top = below ? rect.bottom + 4 : rect.top - menu.offsetHeight - 4;
  const left = Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8);
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.querySelector('button')?.focus({ preventScroll: true });
}

document.addEventListener('click', closeMenus);
window.addEventListener('resize', closeMenus);
window.addEventListener('scroll', closeMenus, { passive: true });

export class FileListManager {
  constructor() {
    this.uploadedFilesContent = document.getElementById('uploadedFilesContent');
    this.totalFilesSpan = document.getElementById('totalFiles');
    this.totalSizeSpan = document.getElementById('totalSize');
    this.refreshBtn = document.getElementById('refreshFilesBtn');
    this.searchInput = document.getElementById('fileSearch');
    this.breadcrumb = document.getElementById('fileBreadcrumb');
    this.renameModal = document.getElementById('renameModal');
    this.renameInput = document.getElementById('renameInput');
    this.shareModal = document.getElementById('shareModal');
    this.currentRenameData = null;
    this.cwd = [];
    this.items = [];
    this.loaded = false;
    this.filter = '';
    this.sortKey = 'name';
    this.sortDir = 'asc';

    if (!window.APP_CONFIG?.showFileList) return;
    this.init();
  }

  init() {
    this.refreshBtn.addEventListener('click', () => this.loadFiles());
    this.searchInput?.addEventListener('input', (e) => {
      this.filter = e.target.value.trim().toLowerCase();
      if (this.filter) this.cwd = [];
      this.render();
    });
    this.searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.searchInput.value) {
        e.preventDefault();
        this.searchInput.value = '';
        this.filter = '';
        this.render();
      }
    });
    this.renameModal.addEventListener('close', () => {
      this.currentRenameData = null;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && e.target === document.body && document.body.dataset.view === 'files') {
        e.preventDefault();
        this.searchInput?.focus();
      }
    });
    document.querySelectorAll('.th-sort').forEach((btn) => {
      btn.addEventListener('click', () => this.setSort(btn.dataset.sort));
    });
    this.loadFiles();
  }

  closeMenu() {
    closeMenus();
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
      if (!this.loaded) this.uploadedFilesContent.replaceChildren(emptyRow('Loading…'));
      this.refreshBtn.disabled = true;
      const response = await fetch(apiUrl('/api/files'));
      if (!response.ok) throw new Error(`Could not load files (HTTP ${response.status})`);
      const data = await response.json();
      this.items = data.items || [];
      this.totalFiles = data.totalFiles;
      this.totalSize = data.totalSize;
      this.loaded = true;
      this.render();
    } catch (error) {
      this.uploadedFilesContent.replaceChildren(emptyRow(error.message, '', true));
    } finally {
      this.refreshBtn.disabled = false;
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
    const count = this.totalFiles ?? 0;
    this.totalFilesSpan.textContent = String(count);
    this.totalFilesSpan.nextSibling.textContent = count === 1 ? ' file · ' : ' files · ';
    this.totalSizeSpan.textContent = formatFileSize(this.totalSize);
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
      const empty = this.filter
        ? emptyRow('No matches', `Nothing named “${this.filter}”.`)
        : this.cwd.length
          ? emptyRow('This folder is empty')
          : emptyRow('No files yet', 'Drop files anywhere on this page to upload.');
      this.uploadedFilesContent.replaceChildren(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    rows.forEach((item) => frag.appendChild(this.createRow(item)));
    this.uploadedFilesContent.replaceChildren(frag);
  }

  renderBreadcrumb() {
    if (!this.breadcrumb) return;
    this.breadcrumb.replaceChildren();
    const root = this.crumbButton('Files', []);
    if (!this.cwd.length && !this.filter) root.setAttribute('aria-current', 'location');
    this.breadcrumb.appendChild(root);
    if (this.filter) {
      this.breadcrumb.append(this.crumbSep(), this.crumbLabel(`Results for “${this.filter}”`));
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
    btn.title = label;
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
    sep.setAttribute('aria-hidden', 'true');
    sep.innerHTML = spriteIcon('i-chevron');
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
    const isDir = item.type === 'directory';
    const tr = document.createElement('tr');
    if (isDir) tr.className = 'is-dir';

    const nameTd = document.createElement('td');
    const cell = document.createElement('div');
    cell.className = 'file-cell';
    const glyph = document.createElement('span');
    glyph.className = `file-glyph${isDir ? ' is-dir' : ''}`;
    glyph.innerHTML = fileGlyph(item);
    const text = document.createElement('div');
    text.className = 'file-text';
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = item.name;
    name.title = item.name;
    text.appendChild(name);
    if (this.filter && item.path.includes('/')) {
      const path = document.createElement('div');
      path.className = 'file-path';
      path.textContent = parentPath(item.path).join(' / ');
      text.appendChild(path);
    }
    const sizeLabel = formatFileSize(item.size);
    const detail = isDir ? this.folderSummary(item) : formatDate(item.uploadDate);
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = `${sizeLabel} · ${detail}`;
    text.appendChild(meta);
    cell.append(glyph, text);
    nameTd.appendChild(cell);

    const sizeTd = document.createElement('td');
    sizeTd.className = 'col-size';
    sizeTd.textContent = sizeLabel;

    const dateTd = document.createElement('td');
    dateTd.className = 'col-date';
    dateTd.textContent = detail;

    const actionTd = document.createElement('td');
    actionTd.className = 'col-actions';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (!isDir) {
      actions.appendChild(
        iconButton(
          'i-download',
          `Download ${item.name}`,
          () => this.downloadFile(item.path),
          'row-quick'
        )
      );
    }
    actions.appendChild(
      iconButton('i-link', `Share ${item.name}`, () => this.openShare(item.path), 'row-quick')
    );
    actions.appendChild(
      iconButton('i-more', `More actions for ${item.name}`, (btn) => this.openMenu(btn, item))
    );
    actionTd.appendChild(actions);

    tr.append(nameTd, sizeTd, dateTd, actionTd);
    tr.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      if (isDir) this.openFolder(item);
    });
    tr.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) return;
      if (!isDir) this.downloadFile(item.path);
    });
    return tr;
  }

  folderSummary(dir) {
    const files = this.countFilesInDirectory(dir);
    return `${files} file${files === 1 ? '' : 's'}`;
  }

  openFolder(item) {
    this.filter = '';
    if (this.searchInput) this.searchInput.value = '';
    this.cwd = item.path.split('/').filter(Boolean);
    this.render();
  }

  openMenu(anchor, item) {
    const entries = [];
    if (item.type === 'file') {
      entries.push({
        icon: 'i-download',
        label: 'Download',
        run: () => this.downloadFile(item.path),
      });
    } else {
      entries.push({ icon: 'i-folder', label: 'Open', run: () => this.openFolder(item) });
    }
    entries.push(
      { icon: 'i-link', label: 'Share…', run: () => this.openShare(item.path) },
      {
        icon: 'i-pencil',
        label: 'Rename…',
        run: () => this.renameItem(item.path, item.type, item.name),
      },
      'sep',
      {
        icon: 'i-trash',
        label: 'Delete',
        danger: true,
        run: () => this.deleteItem(item.path, item.type),
      }
    );
    openMenu(anchor, entries);
  }

  countFilesInDirectory(dir) {
    if (!dir.children) return 0;
    return dir.children.reduce(
      (count, child) => count + (child.type === 'file' ? 1 : this.countFilesInDirectory(child)),
      0
    );
  }

  downloadFile(filePath) {
    const link = document.createElement('a');
    link.href = apiUrl(`/api/files/download/${encodePath(filePath)}`);
    link.download = filePath.split('/').pop();
    link.click();
  }

  openShare(itemPath) {
    this.currentSharePath = itemPath;
    this.currentShareToken = null;
    document.getElementById('shareItemName').textContent = itemPath;
    document.getElementById('shareForm').hidden = false;
    document.getElementById('shareResult').hidden = true;
    document.getElementById('createShareBtn').hidden = false;
    document.getElementById('copyShareBtn').hidden = true;
    document.getElementById('downloadQrBtn').hidden = true;
    document.getElementById('closeShareBtn').textContent = 'Cancel';
    document.getElementById('shareAuth').checked = false;
    document.getElementById('shareAuth').disabled = !window.APP_CONFIG?.pinEnabled;
    document.getElementById('shareExpiry').value = '0';
    openDialog(this.shareModal);
  }

  closeShare() {
    closeDialog(this.shareModal);
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
      document.getElementById('closeShareBtn').textContent = 'Done';
      document.getElementById('copyShareBtn').focus();
      window.dispatchEvent(new CustomEvent('dumbdrop:shares-changed'));
    } catch (error) {
      toast(error.message, false);
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = 'Create link';
    }
  }

  async copyShare() {
    const value = document.getElementById('shareLink').value;
    try {
      await navigator.clipboard.writeText(value);
      toast('Link copied');
    } catch {
      document.getElementById('shareLink').select();
      toast('Press Ctrl+C to copy', false);
    }
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
          ? `“${itemName}” and everything inside it will be permanently deleted.`
          : `“${itemName}” will be permanently deleted.`,
      ok: 'Delete',
    });
    if (!ok) return;
    try {
      const response = await fetch(apiUrl(`/api/files/${encodePath(itemPath)}`), {
        method: 'DELETE',
      });
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
    document.getElementById('renameTitle').textContent =
      itemType === 'directory' ? 'Rename folder' : 'Rename file';
    this.renameInput.value = currentName;
    openDialog(this.renameModal);
    this.renameInput.focus();
    // Select the name without its extension, like desktop file managers do.
    const dot = currentName.lastIndexOf('.');
    const end = itemType === 'file' && dot > 0 ? dot : currentName.length;
    this.renameInput.setSelectionRange(0, end);
  }

  cancelRename() {
    closeDialog(this.renameModal);
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
      const response = await fetch(
        apiUrl(`/api/files/rename/${encodePath(this.currentRenameData.itemPath)}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newName }),
        }
      );
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Rename failed');
      }
      const result = await response.json();
      toast(result.message || 'Renamed');
      this.cancelRename();
      this.loadFiles();
    } catch (error) {
      toast(error.message, false);
    }
  }
}

export class ShareLinksManager {
  constructor() {
    this.content = document.getElementById('shareLinksContent');
    this.totalSharesSpan = document.getElementById('totalShares');
    this.refreshBtn = document.getElementById('refreshSharesBtn');
    this.editModal = document.getElementById('editShareModal');
    this.editing = null;
    if (!window.APP_CONFIG?.showFileList) return;

    this.refreshBtn.addEventListener('click', () => this.loadShares());
    window.addEventListener('dumbdrop:shares-changed', () => this.loadShares());
    document
      .getElementById('cancelEditShareBtn')
      ?.addEventListener('click', () => this.closeEdit());
    document.getElementById('saveEditShareBtn')?.addEventListener('click', () => this.saveEdit());
    this.editModal?.addEventListener('close', () => {
      this.editing = null;
    });
    this.loadShares();
  }

  async loadShares() {
    try {
      if (!this.loaded) this.content.replaceChildren(emptyRow('Loading…'));
      const response = await fetch(apiUrl('/api/files/shares/manage'));
      if (!response.ok) throw new Error('Could not load share links');
      const data = await response.json();
      this.loaded = true;
      this.renderShares(data.shares || []);
    } catch (error) {
      this.content.replaceChildren(emptyRow(error.message, '', true));
    }
  }

  renderShares(shares) {
    const active = shares.filter((share) => !share.expired).length;
    this.totalSharesSpan.textContent = String(active);
    this.totalSharesSpan.toggleAttribute('data-zero', active === 0);
    if (!shares.length) {
      this.content.replaceChildren(
        emptyRow('No share links', 'Use the link icon on any file or folder to create one.')
      );
      return;
    }
    const frag = document.createDocumentFragment();
    shares.forEach((share) => frag.appendChild(this.createShareRow(share)));
    this.content.replaceChildren(frag);
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
    text.className = 'file-text';
    const title = document.createElement('div');
    title.className = 'file-name';
    title.textContent = share.name;
    title.title = share.name;
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
      badge.className = 'badge badge-pin';
      badge.textContent = 'PIN';
    } else {
      badge.className = 'badge';
      badge.textContent = 'Public';
    }
    statusTd.appendChild(badge);

    const expTd = document.createElement('td');
    expTd.className = 'col-date';
    expTd.textContent = share.expiresAt ? formatDate(share.expiresAt) : 'Never';

    const actionTd = document.createElement('td');
    actionTd.className = 'col-actions';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (!share.expired) {
      actions.appendChild(
        iconButton('i-link', `Copy link for ${share.name}`, () => this.copyLink(share), 'row-quick')
      );
    }
    actions.appendChild(
      iconButton('i-more', `More actions for ${share.name}`, (btn) => this.openMenu(btn, share))
    );
    actionTd.appendChild(actions);
    tr.append(nameTd, statusTd, expTd, actionTd);
    return tr;
  }

  async copyLink(share) {
    try {
      await navigator.clipboard.writeText(share.url);
      toast('Link copied');
    } catch {
      toast('Could not access the clipboard', false);
    }
  }

  openMenu(anchor, share) {
    openMenu(anchor, [
      { icon: 'i-link', label: 'Copy link', run: () => this.copyLink(share) },
      {
        icon: 'i-download',
        label: 'Download QR code',
        run: () => {
          const link = document.createElement('a');
          link.href = share.qrUrl;
          link.download = `dumbdrop-share-${share.token.slice(0, 8)}.png`;
          link.click();
        },
      },
      { icon: 'i-pencil', label: 'Edit…', run: () => this.editShare(share) },
      'sep',
      { icon: 'i-trash', label: 'Delete link', danger: true, run: () => this.deleteShare(share) },
    ]);
  }

  editShare(share) {
    this.editing = share;
    document.getElementById('editShareName').textContent = share.name;
    document.getElementById('editShareAuth').checked = Boolean(share.authRequired);
    document.getElementById('editShareAuth').disabled = !window.APP_CONFIG?.pinEnabled;
    const expiry = document.getElementById('editShareExpiry');
    expiry.querySelector('option[value="keep"]')?.remove();
    if (share.expiresAt && !share.expired) {
      const keep = document.createElement('option');
      keep.value = 'keep';
      keep.textContent = `Keep (${formatDate(share.expiresAt)})`;
      expiry.prepend(keep);
      expiry.value = 'keep';
    } else {
      expiry.value = '0';
    }
    openDialog(this.editModal);
  }

  closeEdit() {
    closeDialog(this.editModal);
  }

  async saveEdit() {
    if (!this.editing) return;
    const expiryValue = document.getElementById('editShareExpiry').value;
    const response = await fetch(
      apiUrl(`/api/files/shares/${encodeURIComponent(this.editing.token)}`),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authRequired: document.getElementById('editShareAuth').checked,
          // Omitting expiresIn keeps the current expiry on the server.
          ...(expiryValue === 'keep' ? {} : { expiresIn: Number(expiryValue) }),
        }),
      }
    );
    if (!response.ok) {
      const error = await response.json();
      toast(error.error || 'Update failed', false);
      return;
    }
    toast('Link updated');
    this.closeEdit();
    this.loadShares();
  }

  async deleteShare(share) {
    const ok = await askConfirm({
      title: 'Delete share link?',
      message: `Anyone with the link to “${share.name}” will lose access. The file itself is kept.`,
      ok: 'Delete link',
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
    toast('Link deleted');
    this.loadShares();
  }
}
