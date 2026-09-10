/**
 * File library, share links, rename/share dialogs.
 */

import { apiUrl, formatFileSize, escapeHtml, toast } from './utils.js';

export class FileListManager {
  constructor() {
    this.libraryPanel = document.getElementById('libraryPanel');
    this.uploadedFilesContent = document.getElementById('uploadedFilesContent');
    this.totalFilesSpan = document.getElementById('totalFiles');
    this.totalSizeSpan = document.getElementById('totalSize');
    this.refreshBtn = document.getElementById('refreshFilesBtn');
    this.searchInput = document.getElementById('fileSearch');
    this.renameModal = document.getElementById('renameModal');
    this.renameInput = document.getElementById('renameInput');
    this.currentRenameData = null;
    this.folderState = new Map();
    this.items = [];
    this.filter = '';

    if (!window.APP_CONFIG?.showFileList) return;
    this.init();
  }

  init() {
    this.libraryPanel.hidden = false;
    this.refreshBtn.addEventListener('click', () => this.loadFiles());
    this.searchInput?.addEventListener('input', (e) => {
      this.filter = e.target.value.trim().toLowerCase();
      this.displayFiles({ items: this.items, totalFiles: this.totalFiles, totalSize: this.totalSize, formattedTotalSize: this.formattedTotalSize });
    });
    this.renameModal.addEventListener('click', (e) => {
      if (e.target === this.renameModal) this.cancelRename();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.renameModal.classList.contains('open')) this.cancelRename();
    });
    this.loadFiles();
  }

  async loadFiles() {
    try {
      this.uploadedFilesContent.innerHTML = '<div class="empty-state">Loading files…</div>';
      const response = await fetch(apiUrl('/api/files'));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      this.items = data.items;
      this.totalFiles = data.totalFiles;
      this.totalSize = data.totalSize;
      this.formattedTotalSize = data.formattedTotalSize;
      this.displayFiles(data);
    } catch (error) {
      this.uploadedFilesContent.innerHTML = `<div class="empty-state error">${escapeHtml(error.message)}</div>`;
    }
  }

  matchesFilter(item) {
    if (!this.filter) return true;
    if (item.name.toLowerCase().includes(this.filter)) return true;
    if (item.children) return item.children.some((child) => this.matchesFilter(child));
    return false;
  }

  displayFiles(data) {
    this.totalFilesSpan.textContent = `${data.totalFiles} file${data.totalFiles !== 1 ? 's' : ''}`;
    this.totalSizeSpan.textContent = data.formattedTotalSize || formatFileSize(data.totalSize);

    const items = (data.items || []).filter((item) => this.matchesFilter(item));
    if (!items.length) {
      this.uploadedFilesContent.innerHTML = `<div class="empty-state">${this.filter ? 'No matching files' : 'No files uploaded yet'}</div>`;
      return;
    }

    this.uploadedFilesContent.replaceChildren();
    this.renderItems(items, this.uploadedFilesContent);
  }

  renderItems(items, container, level = 0) {
    items.forEach((item) => {
      const node = document.createElement('div');
      node.className = 'file-tree-node';
      const hasChildren = item.type === 'directory' && item.children?.length;
      node.appendChild(this.createItemElement(item, level, hasChildren));
      if (hasChildren) {
        const children = document.createElement('div');
        const collapsed = this.folderState.get(item.path) ?? level > 0;
        children.className = `directory-children${collapsed ? ' collapsed' : ''}`;
        this.renderItems(item.children, children, level + 1);
        node.appendChild(children);
      }
      container.appendChild(node);
    });
  }

  createItemElement(item, level, hasChildren = false) {
    const itemDiv = document.createElement('div');
    itemDiv.className = `file-row ${item.type === 'directory' ? 'is-dir' : ''}`;
    itemDiv.style.paddingLeft = `${8 + Math.min(level * 16, 56)}px`;

    const info = document.createElement('div');
    info.className = 'file-row-info';

    if (hasChildren) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `folder-toggle${this.folderState.get(item.path) ?? level > 0 ? '' : ' expanded'}`;
      toggle.setAttribute('aria-label', `Toggle ${item.name}`);
      toggle.textContent = '▸';
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const children = itemDiv.parentElement.querySelector('.directory-children');
        if (!children) return;
        const collapsed = children.classList.toggle('collapsed');
        toggle.classList.toggle('expanded', !collapsed);
        this.folderState.set(item.path, collapsed);
      });
      info.appendChild(toggle);
    } else if (item.type === 'directory') {
      const spacer = document.createElement('span');
      spacer.className = 'folder-toggle-spacer';
      info.appendChild(spacer);
    }

    const text = document.createElement('div');
    text.className = 'file-row-text';
    const name = document.createElement('div');
    name.className = 'file-row-name';
    name.textContent = `${item.type === 'directory' ? '📁' : '📄'} ${item.name}`;
    const details = document.createElement('div');
    details.className = 'file-row-meta';
    details.textContent = item.type === 'directory'
      ? `${item.formattedSize} · ${this.countFilesInDirectory(item)} files`
      : `${item.formattedSize} · ${new Date(item.uploadDate).toLocaleDateString()}`;
    text.append(name, details);
    info.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'file-row-actions';

    const shareBtn = this.actionButton('Share', 'btn-outline', () => this.openShare(item.path));
    actions.appendChild(shareBtn);

    if (item.type === 'file') {
      actions.appendChild(this.actionButton('Download', 'btn-outline', () => this.downloadFile(item.path)));
    }
    actions.appendChild(this.actionButton('Rename', 'btn-ghost', () => this.renameItem(item.path, item.type, item.name)));
    actions.appendChild(this.actionButton('Delete', 'btn-destructive', () => this.deleteItem(item.path, item.type)));

    itemDiv.append(info, actions);
    return itemDiv;
  }

  actionButton(label, variant, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${variant} btn-sm`;
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handler();
    });
    return btn;
  }

  countFilesInDirectory(dir) {
    if (!dir.children) return 0;
    return dir.children.reduce((count, child) => count + (child.type === 'file' ? 1 : this.countFilesInDirectory(child)), 0);
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
    const confirmMessage = itemType === 'directory'
      ? `Delete folder "${itemName}" and all its contents?`
      : `Delete file "${itemName}"?`;
    if (!confirm(confirmMessage)) return;
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
      const encodedPath = this.currentRenameData.itemPath.split('/').map(encodeURIComponent).join('/');
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
    if (!window.APP_CONFIG?.showFileList) return;

    this.refreshBtn.addEventListener('click', () => this.loadShares());
    this.filesTab.addEventListener('click', () => this.showPane('files'));
    this.sharesTab.addEventListener('click', () => this.showPane('shares'));
    window.addEventListener('dumbdrop:shares-changed', () => this.loadShares());
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
      this.content.innerHTML = '<div class="empty-state">Loading share links…</div>';
      const response = await fetch(apiUrl('/api/files/shares/manage'));
      if (!response.ok) throw new Error('Failed to load share links');
      const data = await response.json();
      this.renderShares(data.shares || []);
    } catch (error) {
      this.content.innerHTML = `<div class="empty-state error">${escapeHtml(error.message)}</div>`;
    }
  }

  renderShares(shares) {
    this.totalSharesSpan.textContent = `${shares.length} link${shares.length === 1 ? '' : 's'}`;
    if (!shares.length) {
      this.content.innerHTML = '<div class="empty-state">No share links yet. Share a file from the Files tab.</div>';
      return;
    }
    this.content.replaceChildren();
    shares.forEach((share) => {
      const card = document.createElement('div');
      card.className = `share-link-card${share.expired ? ' expired' : ''}`;
      const meta = document.createElement('div');
      meta.className = 'share-link-meta';
      meta.innerHTML = `
        <div class="share-link-title">${share.type === 'directory' ? '📁' : '📄'} ${escapeHtml(share.name)}</div>
        <div class="share-link-subtitle">${share.type === 'directory' ? 'Folder' : 'File'} · ${share.expiresAt ? `Expires ${new Date(share.expiresAt).toLocaleString()}` : 'Never expires'}${share.authRequired ? ' · PIN protected' : ''}</div>
        <a class="share-link-url" href="${escapeHtml(share.url)}" target="_blank" rel="noopener">${escapeHtml(share.url)}</a>`;
      const actions = document.createElement('div');
      actions.className = 'file-row-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn-outline btn-sm';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(share.url);
        toast('Link copied');
      });

      const qrBtn = document.createElement('button');
      qrBtn.type = 'button';
      qrBtn.className = 'btn btn-ghost btn-sm';
      qrBtn.textContent = 'QR';
      qrBtn.addEventListener('click', () => {
        const link = document.createElement('a');
        link.href = share.qrUrl;
        link.download = `dumbdrop-share-${share.token.slice(0, 8)}.png`;
        link.click();
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-ghost btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => this.editShare(share));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-destructive btn-sm';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => this.deleteShare(share));

      actions.append(copyBtn, qrBtn, editBtn, deleteBtn);
      card.append(meta, actions);
      this.content.appendChild(card);
    });
  }

  async editShare(share) {
    const authRequired = confirm(`Require PIN for "${share.name}"?\n\nOK = PIN required\nCancel = no PIN`);
    const expiryChoice = prompt('Link expiry:\n0 = never\n3600 = 1 hour\n86400 = 1 day\n604800 = 7 days\n2592000 = 30 days', share.expiresAt ? '86400' : '0');
    if (expiryChoice === null) return;
    const response = await fetch(apiUrl(`/api/files/shares/${encodeURIComponent(share.token)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authRequired, expiresIn: Number(expiryChoice) }),
    });
    if (!response.ok) {
      const error = await response.json();
      toast(error.error || 'Update failed', false);
      return;
    }
    toast('Share link updated');
    this.loadShares();
  }

  async deleteShare(share) {
    if (!confirm(`Delete share link for "${share.name}"?`)) return;
    const response = await fetch(apiUrl(`/api/files/shares/${encodeURIComponent(share.token)}`), { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.json();
      toast(error.error || 'Delete failed', false);
      return;
    }
    toast('Share link deleted');
    this.loadShares();
  }
}
