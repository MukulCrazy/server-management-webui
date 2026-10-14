let term, fitAddon, ws;
let servers = [];
let activeServer = null;
let currentWindow = 'terminal';
let currentPath = '/';
let cachedFiles = [];
let editingServerId = null;

window.onload = async () => {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "Consolas, 'Courier New', Courier, monospace",
    letterSpacing: 0,
    lineHeight: 1.0,
    theme: { background: '#000000', foreground: '#ffffff' }
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal-view'));

  const resizeObserver = new ResizeObserver(() => {
    if (currentWindow === 'terminal') fitAddon.fit();
  });
  resizeObserver.observe(document.getElementById('terminal-view'));

  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  await loadServers();

  const lastId = localStorage.getItem('last_active_server');
  if (lastId && servers.some((s) => s.id === lastId)) {
    selectServer(lastId);
  }
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
  servers.forEach((s) => {
    const div = document.createElement('div');
    div.className = `server-item ${activeServer && activeServer.id === s.id ? 'active' : ''}`;
    div.onclick = () => selectServer(s.id);
    div.innerHTML = `
      <div class="server-item-title">
        <span>${s.name}</span>
        <span style="font-size:11px; color:var(--text-muted);">${s.authType}</span>
      </div>
      <div class="server-item-ip">${s.username}@${s.host}:${s.port}</div>
      <div class="server-item-actions">
        <button class="btn-mini" onclick="openEditServerModal(event, '${s.id}')">Edit</button>
        <button class="btn-mini danger" onclick="deleteServer(event, '${s.id}')">Delete</button>
      </div>
    `;
    container.appendChild(div);
  });
}

function selectServer(id) {
  activeServer = servers.find((s) => s.id === id);
  if (!activeServer) return;

  localStorage.setItem('last_active_server', id);
  renderServerList();

  document.getElementById('disp-name').textContent = activeServer.name;
  document.getElementById('disp-ip').textContent = `${activeServer.username}@${activeServer.host}:${activeServer.port}`;

  connectTerminal(activeServer.id);
  if (currentWindow === 'filebrowser') loadDirectory('/');
}

function connectTerminal(serverId) {
  if (ws) ws.close();
  term.reset();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/?serverId=${serverId}`);

  ws.onopen = () => {
    document.getElementById('disp-dot').className = 'status-dot online';
    document.getElementById('disp-status').textContent = 'Online / Active';
  };

  ws.onmessage = (e) => term.write(e.data);

  ws.onclose = () => {
    document.getElementById('disp-dot').className = 'status-dot';
    document.getElementById('disp-status').textContent = 'Disconnected';
  };
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
    setTimeout(() => fitAddon.fit(), 50);
  } else {
    termEl.style.display = 'none';
    fbEl.style.display = 'flex';
    document.getElementById('tab-terminal-btn').classList.remove('active');
    document.getElementById('tab-fb-btn').classList.add('active');
    if (activeServer) loadDirectory(currentPath);
  }
}

function connectFileBrowser() {
  if (!activeServer) return alert('Select a server first.');
  switchWindow('filebrowser');
}

async function loadDirectory(targetDir) {
  if (!activeServer) return;
  try {
    const res = await fetch(`/api/files?serverId=${activeServer.id}&dirPath=${encodeURIComponent(targetDir || '')}`);
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Failed to list directory');

    currentPath = data.currentPath;
    cachedFiles = data.files;
    renderBreadcrumbs(currentPath);
    renderFileTable(cachedFiles);
  } catch (err) {
    alert('Failed to read files: ' + err.message);
  }
}

function renderBreadcrumbs(dir) {
  const box = document.getElementById('fb-breadcrumbs');
  box.innerHTML = '';
  const root = document.createElement('span');
  root.textContent = '/';
  root.style.cursor = 'pointer';
  root.onclick = () => loadDirectory('/');
  box.appendChild(root);

  let built = '';
  dir.split('/').filter(Boolean).forEach((part) => {
    const sep = document.createElement('span');
    sep.textContent = ' / ';
    sep.style.color = 'var(--text-muted)';
    box.appendChild(sep);

    built += '/' + part;
    const dest = built;
    const crumb = document.createElement('span');
    crumb.textContent = part;
    crumb.style.cursor = 'pointer';
    crumb.onclick = () => loadDirectory(dest);
    box.appendChild(crumb);
  });
}

function renderFileTable(items) {
  const tbody = document.getElementById('fb-table-body');
  tbody.innerHTML = '';
  items.forEach((item) => {
    const tr = document.createElement('tr');
    const fullPath = currentPath.replace(/\/+$/, '') + '/' + item.name;
    const icon = item.isDir ? '📁 ' : '📄 ';

    tr.innerHTML = `
      <td><input type="checkbox" class="file-chk" data-path="${fullPath}" data-isdir="${item.isDir}" /></td>
      <td style="cursor:pointer; color:${item.isDir ? 'var(--accent-blue)' : '#fff'};" class="file-link">${icon}${item.name}</td>
      <td style="color:var(--text-muted);">${item.isDir ? '--' : formatBytes(item.size)}</td>
      <td style="color:var(--text-muted); font-size:12px;">${new Date(item.mtime).toLocaleString()}</td>
      <td style="color:var(--text-muted); font-family:monospace; font-size:12px;">${item.permission}</td>
      <td style="text-align:right;">
        ${item.isDir ? '' : `<button class="btn-mini" onclick="downloadFile('${fullPath}')">⬇</button>`}
        <button class="btn-mini danger" onclick="deleteEntry('${fullPath}', ${item.isDir})">✕</button>
      </td>
    `;
    if (item.isDir) {
      tr.querySelector('.file-link').onclick = () => loadDirectory(fullPath);
    }
    tbody.appendChild(tr);
  });
}

function formatBytes(bytes) {
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return bytes.toFixed(1) + ' ' + units[i];
}

function filterFiles() {
  const q = document.getElementById('fb-search').value.toLowerCase();
  renderFileTable(cachedFiles.filter((f) => f.name.toLowerCase().includes(q)));
}

function downloadFile(fullPath) {
  window.location.href = `/api/files/download?serverId=${activeServer.id}&filePath=${encodeURIComponent(fullPath)}`;
}

async function deleteEntry(targetPath, isDir) {
  if (!confirm(`Delete ${targetPath}?`)) return;
  await fetch('/api/files/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId: activeServer.id, targetPath, isDir })
  });
  loadDirectory(currentPath);
}

async function promptNewFolder() {
  const name = prompt('Folder name:');
  if (!name) return;
  await fetch('/api/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverId: activeServer.id,
      targetPath: currentPath.replace(/\/+$/, '') + '/' + name
    })
  });
  loadDirectory(currentPath);
}

async function handleFileUpload(e) {
  const files = e.target.files;
  if (!files.length || !activeServer) return;
  for (const f of files) {
    const dest = currentPath.replace(/\/+$/, '') + '/' + f.name;
    await fetch(`/api/files/upload?serverId=${activeServer.id}&targetPath=${encodeURIComponent(dest)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await f.arrayBuffer()
    });
  }
  e.target.value = '';
  loadDirectory(currentPath);
}

function toggleSelectAllFiles() {
  const chk = document.getElementById('fb-select-all').checked;
  document.querySelectorAll('.file-chk').forEach((c) => (c.checked = chk));
}

function openAddServerModal() {
  editingServerId = null;
  document.getElementById('modal-title').textContent = 'Add New Server';
  document.getElementById('srv-name').value = '';
  document.getElementById('srv-host').value = '';
  document.getElementById('srv-port').value = '22';
  document.getElementById('srv-user').value = '';
  document.getElementById('srv-auth').value = 'password';
  document.getElementById('srv-pass').value = '';
  document.getElementById('srv-key').value = '';
  document.getElementById('key-file-label').textContent = 'Click to browse Key File from PC (.pem, .id_rsa, key)';
  toggleAuthInput();
  document.getElementById('server-modal').style.display = 'flex';
}

function openEditServerModal(event, id) {
  event.stopPropagation();
  const s = servers.find((x) => x.id === id);
  if (!s) return;

  editingServerId = id;
  document.getElementById('modal-title').textContent = 'Edit Server';
  document.getElementById('srv-name').value = s.name;
  document.getElementById('srv-host').value = s.host;
  document.getElementById('srv-port').value = s.port;
  document.getElementById('srv-user').value = s.username;
  document.getElementById('srv-auth').value = s.authType === 'SSH Key' ? 'key' : 'password';
  document.getElementById('srv-pass').value = '';
  document.getElementById('srv-key').value = '';
  document.getElementById('key-file-label').textContent =
    s.authType === 'SSH Key'
      ? 'Key file already saved. Browse to replace if needed.'
      : 'Click to browse Key File from PC (.pem, .id_rsa, key)';
  toggleAuthInput();
  document.getElementById('server-modal').style.display = 'flex';
}

async function deleteServer(event, id) {
  event.stopPropagation();
  if (!confirm('Are you sure you want to delete this server?')) return;
  await fetch(`/api/servers/${id}`, { method: 'DELETE' });
  if (activeServer && activeServer.id === id) {
    activeServer = null;
    if (ws) ws.close();
    term.reset();
    document.getElementById('disp-name').textContent = 'No Server Selected';
    document.getElementById('disp-ip').textContent = '--.--.--.--';
    document.getElementById('disp-dot').className = 'status-dot';
    document.getElementById('disp-status').textContent = 'Disconnected';
  }
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
  reader.onload = (evt) => {
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
    return alert(err.error || 'Failed to save server');
  }

  closeServerModal();
  await loadServers();
  if (editingServerId && activeServer && activeServer.id === editingServerId) {
    selectServer(editingServerId);
  }
}