const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DATA_DIR = path.join(__dirname, 'data');
const KEYS_DIR = path.join(DATA_DIR, 'keys');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');

if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

function getServers() {
  if (!fs.existsSync(SERVERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveServers(servers) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2), 'utf8');
}

function buildConfig(s) {
  const config = {
    host: s.host,
    port: parseInt(s.port, 10) || 22,
    username: s.username,
    readyTimeout: 10000
  };
  if (s.privateKey) {
    config.privateKey = s.privateKey.trim();
  } else if (s.password) {
    config.password = s.password;
  }
  return config;
}

const terminalSessions = new Map();
const sftpClients = new Map();

function getSFTP(serverConfig, cb) {
  const cached = sftpClients.get(serverConfig.id);
  if (cached && cached.sftp) return cb(null, cached.sftp);

  const client = new Client();
  client.on('ready', () => {
    client.sftp((err, sftp) => {
      if (err) {
        client.end();
        return cb(err);
      }
      sftpClients.set(serverConfig.id, { client, sftp });
      cb(null, sftp);
    });
  });
  client.on('error', (err) => {
    sftpClients.delete(serverConfig.id);
    cb(err);
  });
  client.on('end', () => sftpClients.delete(serverConfig.id));
  client.on('close', () => sftpClients.delete(serverConfig.id));

  try {
    client.connect(buildConfig(serverConfig));
  } catch (err) {
    cb(err);
  }
}

// Recursive deletion for files and non-empty folders
function rmrf(sftp, targetPath, cb) {
  sftp.stat(targetPath, (err, stats) => {
    if (err) return cb(err);
    if (!stats.isDirectory()) {
      return sftp.unlink(targetPath, cb);
    }
    sftp.readdir(targetPath, (readErr, list) => {
      if (readErr) return cb(readErr);
      if (list.length === 0) {
        return sftp.rmdir(targetPath, cb);
      }
      let remaining = list.length;
      let firstError = null;
      for (const item of list) {
        const fullChild = path.posix.join(targetPath, item.filename);
        rmrf(sftp, fullChild, (childErr) => {
          if (childErr && !firstError) firstError = childErr;
          remaining--;
          if (remaining === 0) {
            if (firstError) return cb(firstError);
            sftp.rmdir(targetPath, cb);
          }
        });
      }
    });
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100mb' }));

// Stream upload directly to remote SFTP
app.post('/api/files/upload', (req, res) => {
  const { serverId, targetPath } = req.query;
  const s = getServers().find((x) => x.id === serverId);
  if (!s || !targetPath) return res.status(400).json({ error: 'Missing parameters' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });

    const wStream = sftp.createWriteStream(targetPath);
    req.pipe(wStream);

    wStream.on('close', () => res.json({ success: true }));
    wStream.on('error', (writeErr) => {
      if (!res.headersSent) res.status(500).json({ error: writeErr.message });
    });
  });
});

app.get('/api/servers', (req, res) => {
  const list = getServers().map(({ password, privateKey, ...s }) => ({
    ...s,
    authType: privateKey ? 'SSH Key' : (password ? 'Password' : 'None')
  }));
  res.json(list);
});

app.post('/api/servers', (req, res) => {
  const { name, host, port, username, authType, password, privateKey } = req.body;
  if (!name || !host || !username) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const servers = getServers();
  const id = Date.now().toString();
  servers.push({
    id,
    name,
    host,
    port: parseInt(port, 10) || 22,
    username,
    authType: authType || 'password',
    password: authType === 'password' ? password : null,
    privateKey: authType === 'key' ? privateKey : null
  });
  saveServers(servers);
  res.json({ success: true, id });
});

app.put('/api/servers/:id', (req, res) => {
  const { name, host, port, username, authType, password, privateKey } = req.body;
  const servers = getServers();
  const idx = servers.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Server not found' });

  servers[idx] = {
    ...servers[idx],
    name,
    host,
    port: parseInt(port, 10) || 22,
    username,
    authType: authType || 'password',
    password: authType === 'password' ? password : null,
    privateKey: authType === 'key' ? (privateKey || servers[idx].privateKey) : null
  };
  saveServers(servers);
  res.json({ success: true });
});

app.delete('/api/servers/:id', (req, res) => {
  const sess = terminalSessions.get(req.params.id);
  if (sess) {
    try { sess.client.end(); } catch (e) {}
    terminalSessions.delete(req.params.id);
  }
  const sftp = sftpClients.get(req.params.id);
  if (sftp) {
    try { sftp.client.end(); } catch (e) {}
    sftpClients.delete(req.params.id);
  }
  saveServers(getServers().filter((s) => s.id !== req.params.id));
  res.json({ success: true });
});

app.post('/api/sftp/disconnect', (req, res) => {
  const { serverId } = req.body;
  const sftpObj = sftpClients.get(serverId);
  if (sftpObj) {
    try { sftpObj.client.end(); } catch (e) {}
    sftpClients.delete(serverId);
  }
  res.json({ success: true });
});

app.get('/api/files', (req, res) => {
  const { serverId, dirPath } = req.query;
  const s = getServers().find((x) => x.id === serverId);
  if (!s) return res.status(404).json({ error: 'Server not configured' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });
    const targetDir = (dirPath && dirPath.trim()) || (s.username === 'root' ? '/root' : `/home/${s.username}`);

    sftp.readdir(targetDir, (readErr, list) => {
      if (readErr) return res.status(500).json({ error: readErr.message });
      const items = list
        .map((item) => ({
          name: item.filename,
          isDir: item.attrs.isDirectory(),
          size: item.attrs.size,
          mtime: item.attrs.mtime * 1000,
          permission: (item.attrs.mode & 0o777).toString(8) || '755'
        }))
        .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));

      res.json({ currentPath: targetDir, files: items });
    });
  });
});

app.get('/api/files/read', (req, res) => {
  const { serverId, filePath } = req.query;
  const s = getServers().find((x) => x.id === serverId);
  if (!s || !filePath) return res.status(400).json({ error: 'Invalid arguments' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });

    sftp.stat(filePath, (statErr, stats) => {
      if (statErr) return res.status(500).json({ error: statErr.message });
      if (stats.size > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'File is too large to edit directly' });
      }

      const stream = sftp.createReadStream(filePath);
      let content = '';
      stream.on('data', (d) => { content += d.toString('utf8'); });
      stream.on('end', () => {
        const mode = (stats.mode & 0o777).toString(8);
        res.json({ content, mode, size: stats.size });
      });
      stream.on('error', (e) => res.status(500).json({ error: e.message }));
    });
  });
});

app.post('/api/files/save', (req, res) => {
  const { serverId, filePath, content } = req.body;
  const s = getServers().find((x) => x.id === serverId);
  if (!s || !filePath) return res.status(400).json({ error: 'Missing parameters' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });

    const wStream = sftp.createWriteStream(filePath);
    wStream.on('close', () => res.json({ success: true }));
    wStream.on('error', (writeErr) => res.status(500).json({ error: writeErr.message }));
    wStream.end(content, 'utf8');
  });
});

app.post('/api/files/touch', (req, res) => {
  const { serverId, targetPath } = req.body;
  const s = getServers().find((x) => x.id === serverId);
  if (!s || !targetPath) return res.status(400).json({ error: 'Missing parameters' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });
    const wStream = sftp.createWriteStream(targetPath);
    wStream.on('close', () => res.json({ success: true }));
    wStream.on('error', (writeErr) => res.status(500).json({ error: writeErr.message }));
    wStream.end('');
  });
});

app.post('/api/files/unzip', (req, res) => {
  const { serverId, zipPath, targetDir } = req.body;
  const s = getServers().find(x => x.id === serverId);
  if (!s || !zipPath || !targetDir) return res.status(400).json({ error: 'Missing parameters' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });

    const rStream = sftp.createReadStream(zipPath);
    let activePipes = 0;
    let streamClosed = false;

    function checkFinished() {
      if (streamClosed && activePipes === 0 && !res.headersSent) {
        res.json({ success: true });
      }
    }

    rStream
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        const destPath = path.posix.join(targetDir, entry.path);
        if (entry.type === 'Directory') {
          sftp.mkdir(destPath, () => entry.autodrain());
        } else {
          activePipes++;
          const wStream = sftp.createWriteStream(destPath);
          entry.pipe(wStream);
          wStream.on('close', () => {
            activePipes--;
            checkFinished();
          });
          wStream.on('error', () => {
            activePipes--;
            checkFinished();
          });
        }
      })
      .on('close', () => {
        streamClosed = true;
        checkFinished();
      })
      .on('error', (uErr) => {
        if (!res.headersSent) res.status(500).json({ error: uErr.message });
      });
  });
});

app.get('/api/files/download', (req, res) => {
  const { serverId, filePath } = req.query;
  const s = getServers().find((x) => x.id === serverId);
  if (!s || !filePath) return res.status(400).send('Invalid arguments');

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).send(err.message);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    sftp.createReadStream(filePath).pipe(res);
  });
});

app.post('/api/files/download-zip', (req, res) => {
  const { serverId, paths } = req.body;
  const s = getServers().find(x => x.id === serverId);
  if (!s || !Array.isArray(paths) || paths.length === 0) return res.status(400).send('Invalid request');

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).send(err.message);

    const archive = archiver('zip', { zlib: { level: 6 } });
    res.setHeader('Content-Disposition', `attachment; filename="archive_${Date.now()}.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    archive.pipe(res);

    for (const target of paths) {
      const stream = sftp.createReadStream(target);
      archive.append(stream, { name: path.basename(target) });
    }
    archive.finalize();
  });
});

// Recursive delete endpoint for single and batch deletions
app.post('/api/files/delete', (req, res) => {
  const { serverId, targetPath } = req.body;
  const s = getServers().find((x) => x.id === serverId);
  if (!s || !targetPath) return res.status(400).json({ error: 'Missing parameters' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });
    rmrf(sftp, targetPath, (delErr) => {
      if (delErr) return res.status(500).json({ error: delErr.message });
      res.json({ success: true });
    });
  });
});

app.post('/api/files/rename', (req, res) => {
  const { serverId, oldPath, newPath } = req.body;
  const s = getServers().find((x) => x.id === serverId);
  if (!s || !oldPath || !newPath) return res.status(400).json({ error: 'Missing parameters' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });
    sftp.rename(oldPath, newPath, (rErr) => {
      if (rErr) return res.status(500).json({ error: rErr.message });
      res.json({ success: true });
    });
  });
});

app.post('/api/files/copy', (req, res) => {
  const { serverId, srcPath, destPath } = req.body;
  const s = getServers().find((x) => x.id === serverId);
  if (!s || !srcPath || !destPath) return res.status(400).json({ error: 'Missing parameters' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });
    const rStream = sftp.createReadStream(srcPath);
    const wStream = sftp.createWriteStream(destPath);
    rStream.pipe(wStream);
    wStream.on('close', () => res.json({ success: true }));
    wStream.on('error', (err) => res.status(500).json({ error: err.message }));
  });
});

app.post('/api/files/mkdir', (req, res) => {
  const { serverId, targetPath } = req.body;
  const s = getServers().find((x) => x.id === serverId);
  if (!s || !targetPath) return res.status(400).json({ error: 'Missing parameters' });

  getSFTP(s, (err, sftp) => {
    if (err) return res.status(500).json({ error: err.message });
    sftp.mkdir(targetPath, (mErr) => {
      if (mErr) return res.status(500).json({ error: mErr.message });
      res.json({ success: true });
    });
  });
});

// Terminal Connection
wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/?', ''));
  const serverId = urlParams.get('serverId');
  const serverConfig = getServers().find((s) => s.id === serverId);

  if (!serverConfig) {
    ws.send('\r\n[Error: Server not found]\r\n');
    return ws.close();
  }

  let session = terminalSessions.get(serverId);

  if (session && session.active) {
    session.ws = ws;
    if (session.scrollback.length > 0) ws.send(session.scrollback);
    ws.on('message', (msg) => {
      const str = msg.toString();
      try {
        const parsed = JSON.parse(str);
        if (parsed.type === 'resize' && session.stream) {
          session.stream.setWindow(parsed.rows, parsed.cols, 0, 0);
          return;
        }
      } catch (e) {}
      if (session.stream && session.active) session.stream.write(str);
    });
    ws.on('close', () => {
      if (session.ws === ws) session.ws = null;
    });
    return;
  }

  const client = new Client();
  session = { client, stream: null, scrollback: '', active: false, ws };
  terminalSessions.set(serverId, session);

  client.on('ready', () => {
    client.shell({ term: 'xterm-256color', rows: 30, cols: 100 }, (err, stream) => {
      if (err) {
        terminalSessions.delete(serverId);
        return ws.close();
      }
      session.stream = stream;
      session.active = true;

      stream.on('data', (d) => {
        const text = d.toString('utf-8');
        session.scrollback += text;
        if (session.scrollback.length > 200000) session.scrollback = session.scrollback.slice(-120000);
        if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(text);
      });

      stream.on('close', () => {
        session.active = false;
        client.end();
        terminalSessions.delete(serverId);
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send('\r\n\x1b[33m[Session ended: Terminal process terminated]\x1b[0m\r\n');
          session.ws.close(1000, 'process_exit');
        }
      });

      ws.on('message', (msg) => {
        const str = msg.toString();
        try {
          const parsed = JSON.parse(str);
          if (parsed.type === 'resize' && session.stream) {
            session.stream.setWindow(parsed.rows, parsed.cols, 0, 0);
            return;
          }
        } catch (e) {}
        if (session.stream && session.active) session.stream.write(str);
      });
      ws.on('close', () => {
        if (session.ws === ws) session.ws = null;
      });
    });
  });

  client.on('error', (err) => {
    terminalSessions.delete(serverId);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n[SSH Error: ${err.message}]\r\n`);
      ws.close();
    }
  });

  try {
    client.connect(buildConfig(serverConfig));
  } catch (err) {
    terminalSessions.delete(serverId);
    ws.send(`\r\n[SSH Error: ${err.message}]\r\n`);
    ws.close();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server manager active at http://localhost:${PORT}`));