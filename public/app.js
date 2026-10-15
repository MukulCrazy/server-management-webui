let term, fitAddon, ws;
let servers = [];
let activeServer = null;
let isConnected = false;
let currentWindow = 'terminal';
let currentPath = '/';
let cachedFiles = [];
let editingServerId = null;
let activeEditingFilePath = null;

let navHistoryBack = [];
let navHistoryForward = [];

let fileClipboard = {
  action: null,
  items: []
};

// Global prompt resolver preventing modal event stacking
let activePromptResolve = null;

function showCenterToast(msg, duration = 2800) {
  const toast = document.getElementById('center-toast');
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, duration);
}

function customCenterPrompt(title, defaultValue = '') {
  if (activePromptResolve) {
    activePromptResolve(null);
    activePromptResolve = null;
  }

  return new Promise((resolve) => {
    activePromptResolve = resolve;
    document.getElementById('prompt-title').textContent = title;
    const input = document.getElementById('prompt-input');
    input.value = defaultValue;
    document.getElementById('prompt-modal').style.display = 'flex';
    input.focus();
    input.select();
  });
}

function handlePromptConfirm() {
  const input = document.getElementById('prompt-input');
  const val = input.value.trim();
  const resolve = activePromptResolve;
  activePromptResolve = null;
  document.getElementById('prompt-modal').style.display = 'none';
  if (resolve) resolve(val);
}

function closePromptModal() {
  const resolve = activePromptResolve;
  activePromptResolve = null;
  document.getElementById('prompt-modal').style.display = 'none';
  if (resolve) resolve(null);
}

// Conflict Modal
function customCenterConflict(itemName) {
  return new Promise((resolve) => {
    document.getElementById('conflict-msg').textContent = `An item named "${itemName}" already exists in this folder.`;
    document.getElementById('conflict-modal').style.display = 'flex';

    const repBtn = document.getElementById('conflict-replace-btn');
    const renBtn = document.getElementById('conflict-rename-btn');

    const onReplace = () => { cleanup(); resolve('replace'); };
    const onRename = () => { cleanup(); resolve('rename'); };

    function cleanup() {
      repBtn.removeEventListener('click', onReplace);
      renBtn.removeEventListener('click', onRename);
      closeConflictModal();
    }

    repBtn.addEventListener('click', onReplace);
    renBtn.addEventListener('click', onRename);
  });
}

function closeConflictModal() {
  document.getElementById('conflict-modal').style.display = 'none';
}

function fitAndSyncTerminal() {
  if (!fitAddon || currentWindow !== 'terminal') return;
  fitAddon.fit();
  if (ws && ws.readyState === WebSocket.OPEN && term.cols && term.rows) {
    ws.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows
    }));
  }
}

window.onload = async () => {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", Courier, monospace',
    letterSpacing: 0,
    lineHeight: 1.0,
    theme: {
      background: '#111111',
      foreground: '#f8f8f8'
    }
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal-view'));

  if (document.fonts) {
    document.fonts.ready.then(() => {
      fitAndSyncTerminal();
    });
  }

  const resizeObserver = new ResizeObserver(() => {
    fitAndSyncTerminal();
  });
  resizeObserver.observe(document.getElementById('terminal-view'));

  term.onData(data => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  const promptInput = document.getElementById('prompt-input');
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handlePromptConfirm();
    if (e.key === 'Escape') closePromptModal();
  });
  document.getElementById('prompt-confirm-btn').onclick = handlePromptConfirm;

  await loadServers();

  const lastId = localStorage.getItem('last_active_server');
  if (lastId && servers.some(s => s.id === lastId)) {
    selectServer(lastId, false);
  }

  initDragAndDrop();
};

async function loadServers() {
  try {
    const res = await fetch('/api/servers');
    servers = await res.json();
    renderServerList();
  } catch (e) {
    console.error('Failed to load servers:', e);
  }
}

function renderServerList() {
  const container = document.getElementById('server-list');
  container.innerHTML = '';
  servers.forEach(s => {
    const div = document.createElement('div');
    div.className = `server-item ${activeServer && activeServer.id === s.id ? 'active' : ''}`;
    div.onclick = () => selectServer(s.id, false);
    div.innerHTML = `
      <div class="server-item-title">
        <span>${s.name}</span>
        <span style="font-size:12px; color:var(--text-muted);">${s.authType}</span>
      </div>
      <div class="server-item-ip">${s.username}@${s.host}:${s.port}</div>
      <div class="server-item-actions">
        <button class="btn-mini" onclick="openEditServerModal(event, '${s.id}')">Edit</button>
      </div>
    `;
    container.appendChild(div);
  });
}

function selectServer(id, autoConnect = false) {
  if (isConnected) {
    disconnectSession();
  }
  activeServer = servers.find(s => s.id === id);
  if (!activeServer) return;

  navHistoryBack = [];
  navHistoryForward = [];
  updateNavButtonsState();

  localStorage.setItem('last_active_server', id);
  renderServerList();

  document.getElementById('disp-name').textContent = activeServer.name;
  document.getElementById('disp-ip').textContent = `${activeServer.username}@${activeServer.host}:${activeServer.port}`;

  if (autoConnect) {
    connectTerminal(activeServer.id);
  }
}

function toggleConnection() {
  if (!activeServer) {
    showCenterToast('Please select or add a server first.');
    return;
  }
  if (isConnected) {
    disconnectSession();
  } else {
    connectTerminal(activeServer.id);
  }
}

function connectTerminal(serverId) {
  if (ws) ws.close();
  term.reset();
  showCenterToast('Connecting to server...');

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/?serverId=${serverId}`);

  ws.onopen = () => {
    isConnected = true;
    updateConnectionUI(true);
    showCenterToast('Connected successfully!');
    setTimeout(() => fitAndSyncTerminal(), 60);
    if (currentWindow === 'filebrowser') {
      loadDirectory('/');
    }
  };

  ws.onmessage = e => term.write(e.data);

  ws.onclose = (event) => {
    if (event.reason === 'process_exit') {
      handleProcessExit();
    } else {
      handleDisconnectCleanup();
    }
  };
}

function disconnectSession() {
  if (ws) ws.close();
  showCenterToast('Session detached: Terminal is running in the background');
  handleDisconnectCleanup();
}

function handleProcessExit() {
  showCenterToast('Session ended: Terminal process terminated');
  handleDisconnectCleanup();
}

function handleDisconnectCleanup() {
  isConnected = false;
  updateConnectionUI(false);

  navHistoryBack = [];
  navHistoryForward = [];
  updateNavButtonsState();

  cachedFiles = [];
  document.getElementById('fb-breadcrumbs').innerHTML = '';
  document.getElementById('fb-table-body').innerHTML = `
    <tr>
      <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 32px;">
        Connection closed. Connect to a server to browse files.
      </td>
    </tr>`;

  clearClipboard();

  if (currentWindow === 'filebrowser') {
    switchWindow('terminal');
  }
}

function updateConnectionUI(online) {
  const dot = document.getElementById('disp-dot');
  const statusText = document.getElementById('disp-status');
  const btn = document.getElementById('btn-toggle-conn');

  if (online) {
    dot.className = 'status-dot online';
    statusText.textContent = 'Online / Active';
    btn.textContent = 'Disconnect';
    btn.className = 'btn-connect-toggle disconnect';
  } else {
    dot.className = 'status-dot';
    statusText.textContent = 'Disconnected';
    btn.textContent = 'Connect';
    btn.className = 'btn-connect-toggle';
  }
}

function switchWindow(tab) {
  currentWindow = tab;
  const termEl = document.getElementById('terminal-view');
  const fbEl = document.getElementById('filebrowser-view');

  if (tab === 'terminal') {
    termEl.style.display = 'block';
    fbEl.style.display = 'none';
    document.getElementById('tab-terminal-btn').classList.add('active');
    document.getElementById('tab-fb-btn').classList.remove('active');
    setTimeout(() => fitAndSyncTerminal(), 50);
  } else {
    if (!isConnected) {
      showCenterToast('Connect to the server first to access File Browser.');
      return;
    }
    termEl.style.display = 'none';
    fbEl.style.display = 'flex';
    document.getElementById('tab-terminal-btn').classList.remove('active');
    document.getElementById('tab-fb-btn').classList.add('active');
    loadDirectory(currentPath || '/');
  }
}

function updateNavButtonsState() {
  const bBtn = document.getElementById('navBackBtn');
  const fBtn = document.getElementById('navForwardBtn');
  if (bBtn) bBtn.disabled = navHistoryBack.length === 0;
  if (fBtn) fBtn.disabled = navHistoryForward.length === 0;
}

function navGoBack() {
  if (navHistoryBack.length > 0) {
    navHistoryForward.push(currentPath);
    const prev = navHistoryBack.pop();
    loadDirectory(prev, true);
  }
}

function navGoForward() {
  if (navHistoryForward.length > 0) {
    navHistoryBack.push(currentPath);
    const next = navHistoryForward.pop();
    loadDirectory(next, true);
  }
}

function navGoUp() {
  if (!currentPath || currentPath === '/') return;
  const parts = currentPath.replace(/\/+$/, '').split('/');
  parts.pop();
  const parent = parts.join('/') || '/';
  loadDirectory(parent);
}

function navGoHome() {
  loadDirectory('/home/ubuntu');
}

function activateManualPathInput() {
  const bc = document.getElementById('fb-breadcrumbs');
  const inp = document.getElementById('manual-path-input');
  if (!bc || !inp) return;
  bc.style.display = 'none';
  inp.style.display = 'block';
  inp.value = currentPath;
  inp.focus();
  inp.select();
}

function handleManualPathKey(e) {
  if (e.key === 'Enter') {
    const val = e.target.value.trim();
    if (val) loadDirectory(val);
    deactivateManualPathInput();
  } else if (e.key === 'Escape') {
    deactivateManualPathInput();
  }
}

function deactivateManualPathInput() {
  const bc = document.getElementById('fb-breadcrumbs');
  const inp = document.getElementById('manual-path-input');
  if (!bc || !inp) return;
  inp.style.display = 'none';
  bc.style.display = 'flex';
}

async function loadDirectory(targetDir, isHistoryAction = false) {
  if (!activeServer || !isConnected) return;
  try {
    const res = await fetch(`/api/files?serverId=${activeServer.id}&dirPath=${encodeURIComponent(targetDir || '')}`);
    const data = await res.json();
    if (!res.ok) return showCenterToast(data.error || 'Failed to list directory');

    if (!isHistoryAction && currentPath && currentPath !== data.currentPath) {
      navHistoryBack.push(currentPath);
      navHistoryForward = [];
    }

    currentPath = data.currentPath;
    cachedFiles = data.files;
    updateNavButtonsState();
    renderBreadcrumbs(currentPath);
    renderFileTable(cachedFiles);
    updateBatchActionBar();
  } catch (err) {
    showCenterToast('Failed to read files: ' + err.message);
  }
}

function renderBreadcrumbs(dir) {
  const box = document.getElementById('fb-breadcrumbs');
  box.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'crumb-segment';
  root.textContent = '/';
  root.onclick = (e) => {
    e.stopPropagation();
    loadDirectory('/');
  };
  box.appendChild(root);

  let built = '';
  dir.split('/').filter(Boolean).forEach(part => {
    const sep = document.createElement('span');
    sep.textContent = ' ❯ ';
    sep.className = 'crumb-sep';
    box.appendChild(sep);

    built += '/' + part;
    const dest = built;
    const crumb = document.createElement('span');
    crumb.className = 'crumb-segment';
    crumb.textContent = part;
    crumb.onclick = (e) => {
      e.stopPropagation();
      loadDirectory(dest);
    };
    box.appendChild(crumb);
  });
}

function renderFileTable(items) {
  const tbody = document.getElementById('fb-table-body');
  tbody.innerHTML = '';
  if (!items || items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">Directory is empty</td></tr>';
    return;
  }

  const folderSvg = `<svg class="folder-svg" width="18" height="18" viewBox="0 0 24 24" fill="#0091ff"><path d="M10 4H4c-1.11 0-2 .89-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8c0-1.11-.89-2-2-2h-8l-2-2z"/></svg>`;
  const fileSvg = `<svg class="file-svg" width="18" height="18" viewBox="0 0 24 24" fill="#90a4ae"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;

  items.forEach((item) => {
    const tr = document.createElement('tr');
    const fullPath = currentPath.replace(/\/+$/, '') + '/' + item.name;
    const icon = item.isDir ? folderSvg : fileSvg;
    const isZip = item.name.toLowerCase().endsWith('.zip');

    tr.innerHTML = `
      <td><input type="checkbox" class="file-chk" data-path="${fullPath}" data-isdir="${item.isDir}" onchange="updateBatchActionBar()" /></td>
      <td style="cursor:pointer; color:${item.isDir ? '#38bdf8' : '#fff'}; font-weight:${item.isDir ? '500' : 'normal'};" class="file-link">${icon}${item.name}</td>
      <td style="color:var(--text-muted);">${item.isDir ? '--' : formatBytes(item.size)}</td>
      <td style="color:var(--text-muted); font-size:13px;">${new Date(item.mtime).toLocaleString()}</td>
      <td style="color:var(--text-muted); font-family:monospace; font-size:13px;">${item.permission}</td>
      <td style="text-align:right; white-space:nowrap;">
        ${!item.isDir ? `<button class="btn-mini edit-row-btn" title="Edit / View">&#9998;</button>` : ''}
        ${isZip ? `<button class="btn-mini unzip-row-btn" title="Extract ZIP">&#128230;</button>` : ''}
        <button class="btn-mini rename-row-btn" title="Rename">&#9997;</button>
        ${!item.isDir ? `<button class="btn-mini dl-row-btn" title="Download">&#11123;</button>` : ''}
        <button class="btn-mini danger del-row-btn" title="Delete">&#10005;</button>
      </td>
    `;

    if (item.isDir) {
      tr.querySelector('.file-link').onclick = () => loadDirectory(fullPath);
    } else {
      tr.querySelector('.file-link').onclick = () => openFileInEditor(fullPath, item.permission);
      tr.querySelector('.edit-row-btn').onclick = (e) => {
        e.stopPropagation();
        openFileInEditor(fullPath, item.permission);
      };
      tr.querySelector('.dl-row-btn').onclick = (e) => {
        e.stopPropagation();
        downloadFile(fullPath);
      };
    }

    if (isZip) {
      tr.querySelector('.unzip-row-btn').onclick = (e) => {
        e.stopPropagation();
        unzipArchive(fullPath);
      };
    }

    tr.querySelector('.rename-row-btn').onclick = (e) => {
      e.stopPropagation();
      renameItem(fullPath);
    };

    tr.querySelector('.del-row-btn').onclick = (e) => {
      e.stopPropagation();
      deleteEntry(fullPath);
    };

    tbody.appendChild(tr);
  });
}

function formatBytes(bytes) {
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(1) + ' ' + units[i];
}

function filterFiles() {
  const q = document.getElementById('fb-search').value.toLowerCase();
  renderFileTable(cachedFiles.filter(f => f.name.toLowerCase().includes(q)));
}

function bufferClipboard(action) {
  const checkedBoxes = Array.from(document.querySelectorAll('.file-chk:checked'));
  if (!checkedBoxes.length) return showCenterToast('No files selected');

  fileClipboard.action = action;
  fileClipboard.items = checkedBoxes.map(c => c.getAttribute('data-path'));
  updatePasteButton();
  showCenterToast(`${action === 'copy' ? 'Copied' : 'Cut'} ${fileClipboard.items.length} item. Navigate to destination and click Paste.`);
}

function updatePasteButton() {
  const btn = document.getElementById('btn-paste');
  const cancelBtn = document.getElementById('btn-cancel-clip');
  const countEl = document.getElementById('paste-count');
  if (fileClipboard.items.length > 0) {
    btn.style.display = 'inline-flex';
    cancelBtn.style.display = 'inline-flex';
    countEl.textContent = fileClipboard.items.length;
  } else {
    btn.style.display = 'none';
    cancelBtn.style.display = 'none';
  }
}

function clearClipboard() {
  fileClipboard.action = null;
  fileClipboard.items = [];
  updatePasteButton();
  showCenterToast('Clipboard cleared');
}

async function pasteClipboard() {
  if (!fileClipboard.items.length || !fileClipboard.action) return;

  const action = fileClipboard.action;

  for (const src of fileClipboard.items) {
    const originalName = src.split('/').pop();
    let targetName = originalName;

    const exists = cachedFiles.some(f => f.name === targetName);
    if (exists) {
      const choice = await customCenterConflict(targetName);
      if (!choice) return;
      if (choice === 'rename') {
        const ext = pathExt(targetName);
        const base = baseWithoutExt(targetName);
        let counter = 1;
        while (cachedFiles.some(f => f.name === `${base}_copy${counter}${ext}`)) {
          counter++;
        }
        targetName = `${base}_copy${counter}${ext}`;
      }
    }

    const dest = currentPath.replace(/\/+$/, '') + '/' + targetName;
    
    if (action === 'copy') {
      await fetch('/api/files/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: activeServer.id, srcPath: src, destPath: dest })
      });
    } else if (action === 'move') {
      await fetch('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: activeServer.id, oldPath: src, newPath: dest })
      });
    }
  }

  showCenterToast(`${action === 'copy' ? 'Copied' : 'Moved'} successfully!`);
  clearClipboard();
  loadDirectory(currentPath);
}

function pathExt(filename) {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(idx) : '';
}

function baseWithoutExt(filename) {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}

async function openFileInEditor(filePath, mode) {
  showCenterToast('Loading file...');
  try {
    const res = await fetch(`/api/files/read?serverId=${activeServer.id}&filePath=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (!res.ok) return showCenterToast(data.error || 'Failed to open file');

    activeEditingFilePath = filePath;
    document.getElementById('editor-filename').textContent = filePath.split('/').pop();
    document.getElementById('editor-filemode').textContent = `Mode: ${data.mode || mode}`;
    document.getElementById('editor-textarea').value = data.content;

    const permNum = parseInt(data.mode || mode, 8);
    const hasWrite = (permNum & 0o200) !== 0;
    const warnBox = document.getElementById('editor-warning');
    if (!hasWrite) {
      warnBox.style.display = 'block';
    } else {
      warnBox.style.display = 'none';
    }

    document.getElementById('editor-modal').style.display = 'flex';
  } catch (e) {
    showCenterToast('Error: ' + e.message);
  }
}

function closeEditorModal() {
  document.getElementById('editor-modal').style.display = 'none';
  activeEditingFilePath = null;
}

async function saveFileFromEditor() {
  if (!activeEditingFilePath) return;
  showCenterToast('Saving file changes...');
  try {
    const content = document.getElementById('editor-textarea').value;
    const res = await fetch('/api/files/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: activeServer.id, filePath: activeEditingFilePath, content })
    });
    const data = await res.json();
    if (!res.ok) return showCenterToast('Save failed: ' + (data.error || 'Permission denied'));

    showCenterToast('File saved successfully!');
    loadDirectory(currentPath);
  } catch (e) {
    showCenterToast('Error saving: ' + e.message);
  }
}

async function promptNewFile() {
  const name = await customCenterPrompt('Enter New File Name:');
  if (!name) return;
  const targetPath = currentPath.replace(/\/+$/, '') + '/' + name;
  showCenterToast('Creating file...');
  const res = await fetch('/api/files/touch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId: activeServer.id, targetPath })
  });
  const data = await res.json();
  if (!res.ok) return showCenterToast(data.error || 'Failed to create file');
  showCenterToast('File created!');
  loadDirectory(currentPath);
}

async function promptNewFolder() {
  const name = await customCenterPrompt('Enter New Folder Name:');
  if (!name) return;
  const targetPath = currentPath.replace(/\/+$/, '') + '/' + name;
  showCenterToast('Creating folder...');
  const res = await fetch('/api/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId: activeServer.id, targetPath })
  });
  const data = await res.json();
  if (!res.ok) return showCenterToast(data.error || 'Failed to create folder');
  showCenterToast('Folder created!');
  loadDirectory(currentPath);
}

async function unzipArchive(zipPath) {
  showCenterToast('Extracting ZIP archive...');
  try {
    const res = await fetch('/api/files/unzip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: activeServer.id, zipPath, targetDir: currentPath })
    });
    const data = await res.json();
    if (!res.ok) return showCenterToast(data.error || 'Failed to extract');
    showCenterToast('Extraction complete!');
    loadDirectory(currentPath);
  } catch (e) {
    showCenterToast('Error extracting: ' + e.message);
  }
}

function downloadFile(fullPath) {
  showCenterToast('Starting download...');
  window.location.href = `/api/files/download?serverId=${activeServer.id}&filePath=${encodeURIComponent(fullPath)}`;
}

async function deleteEntry(targetPath) {
  const confirmMsg = await customCenterPrompt(`Type YES to delete ${targetPath.split('/').pop()}:`);
  if (confirmMsg !== 'YES' && confirmMsg !== 'yes') return;

  showCenterToast('Deleting...');
  const res = await fetch('/api/files/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId: activeServer.id, targetPath })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    return showCenterToast('Delete failed: ' + (data.error || 'Permission denied'));
  }
  showCenterToast('Deleted successfully');
  loadDirectory(currentPath);
}

async function renameItem(oldPath) {
  const oldName = oldPath.split('/').pop();
  const newName = await customCenterPrompt('Enter new name:', oldName);
  if (!newName || newName === oldName) return;

  const parts = oldPath.split('/');
  parts.pop();
  const parent = parts.join('/') || '/';
  const newFullPath = parent.replace(/\/+$/, '') + '/' + newName;

  showCenterToast('Renaming...');
  const res = await fetch('/api/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId: activeServer.id, oldPath, newPath: newFullPath })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    return showCenterToast('Rename failed: ' + (data.error || 'Error'));
  }
  showCenterToast('Renamed successfully');
  loadDirectory(currentPath);
}

let currentUploadXhr = null;
let isUploadCancelled = false;

document.getElementById('cancelUploadBtn').onclick = () => {
  if (currentUploadXhr) {
    isUploadCancelled = true;
    currentUploadXhr.abort();
    currentUploadXhr = null;
    document.getElementById('uploadProgressBox').style.display = 'none';
    showCenterToast('Upload cancelled');
  }
};

function uploadSingleFileWithProgress(file, targetDirPath) {
  return new Promise((resolve, reject) => {
    const progressBox = document.getElementById('uploadProgressBox');
    const filenameEl = document.getElementById('uploadFilename');
    const percentEl = document.getElementById('uploadPercent');
    const fillEl = document.getElementById('progressFill');
    const speedEl = document.getElementById('uploadSpeed');
    const sizeEl = document.getElementById('uploadSize');

    filenameEl.textContent = file.name;
    progressBox.style.display = 'flex';
    fillEl.style.width = '0%';
    percentEl.textContent = '0%';

    const xhr = new XMLHttpRequest();
    currentUploadXhr = xhr;

    const destPath = targetDirPath.replace(/\/+$/, '') + '/' + file.name;
    const url = `/api/files/upload?serverId=${encodeURIComponent(activeServer.id)}&targetPath=${encodeURIComponent(destPath)}`;

    let prevLoaded = 0;
    let prevTime = Date.now();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        fillEl.style.width = `${percent}%`;
        percentEl.textContent = `${percent}%`;

        const now = Date.now();
        const timeDiff = (now - prevTime) / 1000;

        if (timeDiff >= 0.25) {
          const bytesDiff = event.loaded - prevLoaded;
          const speed = bytesDiff / timeDiff;
          speedEl.textContent = speed > 1048576 
            ? `${(speed / 1048576).toFixed(1)} MB/s` 
            : `${(speed / 1024).toFixed(0)} KB/s`;
          prevLoaded = event.loaded;
          prevTime = now;
        }

        const loadedMB = (event.loaded / (1024 * 1024)).toFixed(1);
        const totalMB = (event.total / (1024 * 1024)).toFixed(1);
        sizeEl.textContent = `${loadedMB} MB / ${totalMB} MB`;

        if (percent === 100) {
          speedEl.textContent = 'Writing to server disk, please wait...';
        }
      }
    };

    xhr.onload = () => {
      currentUploadXhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.error || 'Server error during upload'));
        } catch {
          reject(new Error(`Server error: ${xhr.status}`));
        }
      }
    };

    xhr.onabort = () => {
      currentUploadXhr = null;
      reject(new Error('Upload aborted by user'));
    };

    xhr.onerror = () => {
      currentUploadXhr = null;
      reject(new Error('Network failure or permission denied'));
    };

    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(file);
  });
}

async function processUploadQueue(fileList) {
  if (!activeServer || !isConnected) {
    showCenterToast('Connect to a server first');
    return;
  }
  if (!fileList || !fileList.length) return;

  const progressBox = document.getElementById('uploadProgressBox');
  isUploadCancelled = false;

  for (let i = 0; i < fileList.length; i++) {
    if (isUploadCancelled) break;
    const file = fileList[i];
    try {
      await uploadSingleFileWithProgress(file, currentPath);
    } catch (err) {
      if (err.message !== 'Upload aborted by user') {
        showCenterToast(`Failed to upload ${file.name}: ${err.message}`);
      }
    }
  }

  progressBox.style.display = 'none';
  if (!isUploadCancelled) {
    showCenterToast('Upload complete!');
  }
  loadDirectory(currentPath);
}

function handleFileUpload(e) {
  const files = Array.from(e.target.files);
  e.target.value = '';
  processUploadQueue(files);
}

function initDragAndDrop() {
  const dragOverlay = document.getElementById('dragDropOverlay');
  let dragCounter = 0;

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
    window.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  window.addEventListener('dragenter', () => {
    if (currentWindow !== 'filebrowser') return;
    dragCounter++;
    if (dragOverlay) dragOverlay.classList.add('active');
  });

  window.addEventListener('dragleave', () => {
    if (currentWindow !== 'filebrowser') return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      if (dragOverlay) dragOverlay.classList.remove('active');
    }
  });

  window.addEventListener('drop', (e) => {
    dragCounter = 0;
    if (dragOverlay) dragOverlay.classList.remove('active');
    if (currentWindow !== 'filebrowser' || !isConnected) return;

    const dt = e.dataTransfer;
    if (!dt || !dt.files.length) return;

    const droppedFiles = Array.from(dt.files);
    processUploadQueue(droppedFiles);
  });
}

function toggleSelectAllFiles() {
  const chk = document.getElementById('fb-select-all').checked;
  document.querySelectorAll('.file-chk').forEach(c => c.checked = chk);
  updateBatchActionBar();
}

function updateBatchActionBar() {
  const checkedBoxes = document.querySelectorAll('.file-chk:checked');
  const batchBar = document.getElementById('batch-actions');
  if (checkedBoxes.length > 0) {
    batchBar.style.display = 'flex';
  } else {
    batchBar.style.display = 'none';
  }
}

async function downloadZipBatch() {
  const paths = Array.from(document.querySelectorAll('.file-chk:checked'))
    .filter(c => c.getAttribute('data-isdir') === 'false')
    .map(c => c.getAttribute('data-path'));
  
  if (!paths.length) return showCenterToast('Select at least one file to zip');

  showCenterToast('Generating ZIP...');
  const res = await fetch('/api/files/download-zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId: activeServer.id, paths })
  });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `archive_${Date.now()}.zip`;
  a.click();
}

async function deleteBatch() {
  const checkedBoxes = Array.from(document.querySelectorAll('.file-chk:checked'));
  const confirmVal = await customCenterPrompt(`Type YES to delete ${checkedBoxes.length} selected items:`);
  if (confirmVal !== 'YES' && confirmVal !== 'yes') return;

  showCenterToast('Deleting batch...');
  for (const c of checkedBoxes) {
    await fetch('/api/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: activeServer.id,
        targetPath: c.getAttribute('data-path')
      })
    });
  }
  loadDirectory(currentPath);
}

function openAddServerModal() {
  editingServerId = null;
  document.getElementById('modal-title').textContent = 'Add New Server';
  document.getElementById('btn-delete-server').style.display = 'none';
  document.getElementById('srv-name').value = '';
  document.getElementById('srv-host').value = '';
  document.getElementById('srv-port').value = '22';
  document.getElementById('srv-user').value = '';
  document.getElementById('srv-auth').value = 'password';
  document.getElementById('srv-pass').value = '';
  document.getElementById('srv-key').value = '';
  document.getElementById('key-file-label').textContent = 'Click to browse Key File from PC';
  toggleAuthInput();
  document.getElementById('server-modal').style.display = 'flex';
}

function openEditServerModal(event, id) {
  event.stopPropagation();
  const s = servers.find(x => x.id === id);
  if (!s) return;

  editingServerId = id;
  document.getElementById('modal-title').textContent = 'Edit Server';
  document.getElementById('btn-delete-server').style.display = 'block';
  document.getElementById('srv-name').value = s.name;
  document.getElementById('srv-host').value = s.host;
  document.getElementById('srv-port').value = s.port;
  document.getElementById('srv-user').value = s.username;
  document.getElementById('srv-auth').value = s.authType === 'SSH Key' ? 'key' : 'password';
  document.getElementById('srv-pass').value = '';
  document.getElementById('srv-key').value = '';
  document.getElementById('key-file-label').textContent = s.authType === 'SSH Key' ? 'Key file already saved. Browse to replace if needed.' : 'Click to browse Key File from PC';
  toggleAuthInput();
  document.getElementById('server-modal').style.display = 'flex';
}

async function deleteServerFromModal() {
  if (!editingServerId) return;
  const confirmVal = await customCenterPrompt('Type YES to confirm server deletion:');
  if (confirmVal !== 'YES' && confirmVal !== 'yes') return;

  if (activeServer && activeServer.id === editingServerId) {
    disconnectSession();
    activeServer = null;
    document.getElementById('disp-name').textContent = 'No Server Selected';
    document.getElementById('disp-ip').textContent = '--.--.--.--';
  }
  await fetch(`/api/servers/${editingServerId}`, { method: 'DELETE' });
  closeServerModal();
  showCenterToast('Server deleted');
  await loadServers();
}

function closeServerModal() {
  document.getElementById('server-modal').style.display = 'none';
}

function toggleAuthInput() {
  const isKey = document.getElementById('srv-auth').value === 'key';
  document.getElementById('srv-pass').style.display = isKey ? 'none' : 'block';
  document.getElementById('key-input-container').style.display = isKey ? 'flex' : 'none';
}

function readKeyFileFromPC(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('key-file-label').textContent = 'Loaded: ' + file.name;
  const reader = new FileReader();
  reader.onload = evt => {
    document.getElementById('srv-key').value = evt.target.result.trim();
  };
  reader.readAsText(file);
}

async function submitServer() {
  const payload = {
    name: document.getElementById('srv-name').value,
    host: document.getElementById('srv-host').value,
    port: document.getElementById('srv-port').value || 22,
    username: document.getElementById('srv-user').value,
    authType: document.getElementById('srv-auth').value,
    password: document.getElementById('srv-pass').value,
    privateKey: document.getElementById('srv-key').value
  };

  const url = editingServerId ? `/api/servers/${editingServerId}` : '/api/servers';
  const method = editingServerId ? 'PUT' : 'POST';

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.json();
    return showCenterToast(err.error || 'Failed to save server');
  }

  closeServerModal();
  showCenterToast('Server saved successfully!');
  await loadServers();
  if (editingServerId && activeServer && activeServer.id === editingServerId) {
    selectServer(editingServerId, false);
  }
}