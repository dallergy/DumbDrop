/**
 * DumbDrop client bootstrap: shell navigation, dropzone, paste, camera, queue.
 */

import { loadAppConfig, apiUrl, toast, initConfirmDialog } from './utils.js';
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
const shareLinksManager = new ShareLinksManager();

window.fileListManager = fileListManager;

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const cameraInput = document.getElementById('cameraInput');
const overlay = document.getElementById('dropOverlay');
const settingsToggle = document.getElementById('settingsToggle');
const settingsPopover = document.getElementById('settingsPopover');
const pageTitle = document.getElementById('pageTitle');
const pageKicker = document.getElementById('pageKicker');
const pageSub = document.getElementById('pageSub');
const siteTitle = pageTitle?.textContent?.trim() || 'DumbDrop';

const VIEW_COPY = {
  files: {
    kicker: 'Library',
    title: 'Files',
    sub: 'Browse folders, share links, and keep the drop tidy.',
  },
  shares: {
    kicker: 'Access',
    title: 'Share links',
    sub: 'Anyone with a link can download until you revoke it.',
  },
  upload: {
    kicker: 'Transfer',
    title: siteTitle,
    sub: 'Drop files. Share links. Saturate the pipe.',
  },
};

export function setView(view) {
  const next = VIEW_COPY[view] ? view : 'upload';
  document.body.dataset.view = next;
  document.querySelectorAll('.rail-btn[data-view]').forEach((btn) => {
    const on = btn.dataset.view === next;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-current', on ? 'page' : 'false');
  });
  const copy = VIEW_COPY[next];
  if (pageKicker) pageKicker.textContent = copy.kicker;
  if (pageTitle) pageTitle.textContent = copy.title;
  if (pageSub) pageSub.textContent = copy.sub;
  shareLinksManager.showPane?.(next === 'shares' ? 'shares' : 'files');
}

if (window.APP_CONFIG.showFileList) {
  document.body.classList.add('app--library');
  setView('files');
} else {
  setView('upload');
}

document.querySelectorAll('.rail-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

document.getElementById('themeToggle')?.addEventListener('click', () => {
  const next = cycleTheme();
  document
    .getElementById('themeToggle')
    .setAttribute('aria-label', `Theme: ${getThemePreference()}`);
  toast(`Theme: ${next === 'dark' || next === 'light' ? next : 'system'}`, true);
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
    e.target !== settingsToggle &&
    !settingsToggle.contains(e.target)
  ) {
    setSettingsOpen(false);
  }
});

function openFiles() {
  fileInput.click();
}
function openFolders() {
  folderInput.click();
}

document.getElementById('browseFilesBtn')?.addEventListener('click', openFiles);
document.getElementById('browseFoldersBtn')?.addEventListener('click', openFolders);
document.getElementById('browseFilesBtnLibrary')?.addEventListener('click', openFiles);
document.getElementById('browseFoldersBtnLibrary')?.addEventListener('click', openFolders);
document.getElementById('cameraBtn')?.addEventListener('click', () => cameraInput.click());
document.getElementById('cameraBtnLibrary')?.addEventListener('click', () => cameraInput.click());
document.getElementById('uploadButton')?.addEventListener('click', () => queue.start());
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
document
  .getElementById('confirmRenameBtn')
  ?.addEventListener('click', () => fileListManager.confirmRename());

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
  toast(`Added ${files.length} pasted file${files.length === 1 ? '' : 's'}`);
});

window.addEventListener('dumbdrop:uploads-finished', () => {
  if (window.APP_CONFIG?.showFileList) fileListManager.loadFiles();
});

document.getElementById('shareModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'shareModal') fileListManager.closeShare();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    fileListManager.closeShare();
    setSettingsOpen(false);
  }
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
