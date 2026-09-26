/**
 * DumbDrop client bootstrap: shell navigation, dropzone, paste, camera, queue.
 */

import { loadAppConfig, apiUrl, toast, initConfirmDialog, formatFileSize } from './utils.js';
import { initTheme, cycleTheme, getThemePreference } from './theme.js';
import { UploadQueue } from './upload.js';
import { FileListManager, ShareLinksManager } from './file-list.js';

window.APP_CONFIG = {
  autoUpload: false,
  maxRetries: 5,
  showFileList: false,
  pinEnabled: false,
  basePath: '/',
  ...loadAppConfig(),
};

initTheme();
initConfirmDialog();

const queue = new UploadQueue();
const fileListManager = new FileListManager();
new ShareLinksManager();

window.fileListManager = fileListManager;

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const cameraInput = document.getElementById('cameraInput');
const overlay = document.getElementById('dropOverlay');
const settingsToggle = document.getElementById('settingsToggle');
const settingsPopover = document.getElementById('settingsPopover');
const themeToggle = document.getElementById('themeToggle');
const siteTitle = document.title;
const VIEWS = ['upload', 'files', 'shares'];
const VIEW_TITLES = {
  upload: siteTitle,
  files: `Files · ${siteTitle}`,
  shares: `Share links · ${siteTitle}`,
};

export function setView(view) {
  const libraryEnabled = Boolean(window.APP_CONFIG.showFileList);
  const next = libraryEnabled && VIEWS.includes(view) ? view : 'upload';
  document.body.dataset.view = next;
  document.querySelectorAll('.tab[data-view]').forEach((tab) => {
    if (tab.dataset.view === next) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view[data-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.pane !== next;
  });
  document.title = VIEW_TITLES[next];
  fileListManager.closeMenu?.();
}

if (window.APP_CONFIG.showFileList) {
  document.getElementById('viewTabs').hidden = false;
  setView('files');
} else {
  setView('upload');
}

document.querySelectorAll('.tab[data-view]').forEach((tab) => {
  tab.addEventListener('click', () => setView(tab.dataset.view));
});

const THEME_META = {
  light: { icon: 'i-sun', label: 'Light' },
  dark: { icon: 'i-moon', label: 'Dark' },
  system: { icon: 'i-monitor', label: 'System' },
};

function syncThemeButton(preference) {
  const meta = THEME_META[preference] || THEME_META.system;
  themeToggle?.querySelector('use')?.setAttribute('href', `#${meta.icon}`);
  themeToggle?.setAttribute('aria-label', `Theme: ${meta.label}. Click to change.`);
  themeToggle?.setAttribute('title', `Theme: ${meta.label}`);
}

syncThemeButton(getThemePreference());
themeToggle?.addEventListener('click', () => {
  const preference = cycleTheme();
  syncThemeButton(preference);
  toast(`Theme: ${THEME_META[preference].label}`);
});

function setSettingsOpen(open) {
  settingsPopover.hidden = !open;
  settingsToggle.setAttribute('aria-expanded', String(open));
}
settingsToggle?.addEventListener('click', () => setSettingsOpen(settingsPopover.hidden));
document.addEventListener('click', (e) => {
  if (
    !settingsPopover.hidden &&
    !settingsPopover.contains(e.target) &&
    !settingsToggle.contains(e.target)
  ) {
    setSettingsOpen(false);
  }
});

const openFiles = () => fileInput.click();
const openFolders = () => folderInput.click();
const openCamera = () => cameraInput.click();

document.getElementById('browseFilesBtn')?.addEventListener('click', openFiles);
document.getElementById('browseFoldersBtn')?.addEventListener('click', openFolders);
document.getElementById('cameraBtn')?.addEventListener('click', openCamera);
document.getElementById('browseFilesBtnLibrary')?.addEventListener('click', openFiles);
document.getElementById('browseFoldersBtnLibrary')?.addEventListener('click', openFolders);
document.getElementById('uploadButton')?.addEventListener('click', () => queue.start());
document.getElementById('clearQueueBtn')?.addEventListener('click', () => queue.clear());
document
  .getElementById('createShareBtn')
  ?.addEventListener('click', () => fileListManager.createShare());
document
  .getElementById('copyShareBtn')
  ?.addEventListener('click', () => fileListManager.copyShare());
document
  .getElementById('downloadQrBtn')
  ?.addEventListener('click', () => fileListManager.downloadShareQr());
document
  .getElementById('closeShareBtn')
  ?.addEventListener('click', () => fileListManager.closeShare());
document
  .getElementById('cancelRenameBtn')
  ?.addEventListener('click', () => fileListManager.cancelRename());
document.getElementById('renameForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  fileListManager.confirmRename();
});

const dropHint = document.getElementById('dropHint');
if (dropHint) {
  const limit = Number(window.APP_CONFIG.maxFileSize);
  const parts = [];
  if (Number.isFinite(limit) && limit > 0) parts.push(`Up to ${formatFileSize(limit)} per file`);
  if (window.APP_CONFIG.autoUpload) parts.push('Uploads start immediately');
  dropHint.textContent = parts.join(' · ');
}

const logoutBtn = document.getElementById('logoutBtn');
if (window.APP_CONFIG.pinEnabled && logoutBtn) {
  logoutBtn.hidden = false;
  logoutBtn.addEventListener('click', async () => {
    await fetch(apiUrl('/api/auth/logout'), { method: 'POST' });
    window.location.href = apiUrl('/login.html');
  });
}

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
  document.body.addEventListener(eventName, preventDefaults);
});

let dragDepth = 0;
document.body.addEventListener('dragenter', () => {
  dragDepth += 1;
  overlay.hidden = false;
  dropZone.classList.add('highlight');
});
document.body.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    overlay.hidden = true;
    dropZone.classList.remove('highlight');
  }
});
document.body.addEventListener('drop', (e) => {
  dragDepth = 0;
  overlay.hidden = true;
  dropZone.classList.remove('highlight');
  handleDrop(e);
});

fileInput.addEventListener('change', (e) => {
  queue.setFiles(e.target.files);
  e.target.value = '';
});
folderInput.addEventListener('change', (e) => {
  const files = [...e.target.files];
  if (files.some((f) => !f.webkitRelativePath)) {
    toast('This browser cannot preserve folder structure.', false);
    e.target.value = '';
    return;
  }
  queue.setFiles(files);
  e.target.value = '';
});
cameraInput.addEventListener('change', (e) => {
  queue.addFiles(e.target.files);
  e.target.value = '';
});

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  queue.addFiles(files);
});

window.addEventListener('dumbdrop:uploads-finished', () => {
  if (window.APP_CONFIG?.showFileList) fileListManager.loadFiles();
});
window.addEventListener('dumbdrop:upload-started', () => {
  if (window.APP_CONFIG?.showFileList) setView('files');
});
// Staged files live in the Upload view; show them wherever they were added from.
window.addEventListener('dumbdrop:files-staged', () => setView('upload'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setSettingsOpen(false);
});

async function handleDrop(e) {
  const items = e.dataTransfer.items;
  if (items?.[0]?.webkitGetAsEntry) {
    try {
      const files = await getAllFileEntries(items);
      if (files.length) queue.setFiles(files);
    } catch (error) {
      toast(error.message, false);
    }
    return;
  }
  queue.setFiles(e.dataTransfer.files);
}

async function getAllFileEntries(dataTransferItems) {
  const fileEntries = [];
  let rootFolderName = null;

  async function traverseEntry(entry, path = '') {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => {
        entry.file((raw) => {
          if (!rootFolderName && path) rootFolderName = path.split('/')[0];
          const fullPath = path ? `${path}/${entry.name}` : entry.name;
          const fileWithPath = new File([raw], entry.name, {
            type: raw.type,
            lastModified: raw.lastModified,
          });
          const relativePath =
            rootFolderName && !fullPath.startsWith(rootFolderName)
              ? `${rootFolderName}/${fullPath}`
              : fullPath;
          Object.defineProperty(fileWithPath, 'webkitRelativePath', {
            value: relativePath,
            writable: false,
          });
          resolve(fileWithPath);
        }, reject);
      });
      fileEntries.push(file);
    } else if (entry.isDirectory) {
      if (!path && !rootFolderName) rootFolderName = entry.name;
      const dirReader = entry.createReader();
      const entries = [];
      const readNextBatch = () =>
        new Promise((resolve, reject) => {
          dirReader.readEntries((batch) => {
            if (batch.length) {
              entries.push(...batch);
              readNextBatch().then(resolve, reject);
            } else resolve();
          }, reject);
        });
      await readNextBatch();
      const dirPath = path ? `${path}/${entry.name}` : entry.name;
      for (const child of entries) {
        await traverseEntry(child, dirPath);
      }
    }
  }

  for (const item of dataTransferItems) {
    const entry = item.webkitGetAsEntry();
    if (entry) await traverseEntry(entry);
  }
  fileEntries.sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath));
  return fileEntries;
}
