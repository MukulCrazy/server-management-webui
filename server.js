const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Client } = require('ssh2');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const TEMP_DIR = path.join(DATA_DIR, 'temp');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

if (!fs.existsSync(SERVERS_FILE)) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify([], null, 2));
}

const upload = multer({ dest: TEMP_DIR });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readServers() {
  try {
    const raw = fs.readFileSync(SERVERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function writeServers(data) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(data, null, 2));
}

function getSftpClient(srv, callback) {
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) {
        conn.end();
        return callback(err);
      }
      callback(null, sftp, conn);
    });
  }).on('error', (err) => {
    callback(err);
  }).connect({
    host: srv.host,
    port: parseInt(srv.port, 10) || 22,
    username: srv.username || 'ubuntu',
    password: srv.authType === 'password' ? srv.password : undefined,
    privateKey: srv.authType === 'key' ? srv.privateKey : undefined,
    readyTimeout: 10000
  });
}

// Server CRUD endpoints
app.get('/api/servers', (req, res) => {
  res.json(readServers());
});

app.post('/api/servers', (req, res) => {
  const servers = readServers();
  const newServer = {
    id: Date.now().toString(),
    name: req.body.name || 'Server',
    host: req.body.host,
    port: parseInt(req.body.port, 10) || 22,
    username: req.body.username || 'ubuntu',
    authType: req.body.authType || 'key',
    password: req.body.password || '',
    privateKey: req.body.privateKey || ''
  };
  servers.push(newServer);
  writeServers(servers);
  res.status(201).json(newServer);
});

app.put('/api/servers/:id', (req, res) => {
  let servers = readServers();
  const idx = servers.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Server not found' });

  servers[idx] = {
    ...servers[idx],
    name: req.body.name || servers[idx].name,
    host: req.body.host || servers[idx].host,
    port: parseInt(req.body.port, 10) || servers[idx].port,
    username: req.body.username || servers[idx].username,
    authType: req.body.authType || servers[idx].authType,
    password: req.body.password !== undefined ? req.body.password : servers[idx].password,
    privateKey: req.body.privateKey !== undefined ? req.body.privateKey : servers[idx].privateKey
  };
  writeServers(servers);
  res.json(servers[idx]);
});

app.delete('/api/servers/:id', (req, res) => {
  let servers = readServers();
  servers = servers.filter((s) => s.id !== req.params.id);
  writeServers(servers);
  res.json({ success: true });
});

// SFTP directory listing
app.post('/api/sftp/list', (req, res) => {
  const { serverId, dirPath } = req.body;
  const servers = readServers();
  const srv = servers.find((s) => s.id === serverId);
  if (!srv) return res.status(404).json({ error: 'Server not found' });

  getSftpClient(srv, (err, sftp, conn) => {
    if (err) return res.status(500).json({ error: err.message });

    sftp.readdir(dirPath || '/', (readErr, list) => {
      conn.end();
      if (readErr) return res.status(500).json({ error: readErr.message });

      const items = list.map((item) => ({
        name: item.filename,
        isDirectory: item.attrs.isDirectory(),
        size: item.attrs.size,
        modified: new Date(item.attrs.mtime * 1000).toLocaleString(),
        mode: (item.attrs.mode & 0o777).toString(8)
      }));

      items.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
        return a.isDirectory ? -1 : 1;
      });

      res.json({ files: items, currentPath: dirPath || '/' });
    });
  });
});

// SFTP upload
app.post('/api/sftp/upload', upload.single('file'), (req, res) => {
  const { serverId, targetDir } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const servers = readServers();
  const srv = servers.find((s) => s.id === serverId);
  if (!srv) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Server not found' });
  }

  getSftpClient(srv, (err, sftp, conn) => {
    if (err) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: err.message });
    }

    const destinationPath = path.posix.join(targetDir || '/home/ubuntu', req.file.originalname);
    sftp.fastPut(req.file.path, destinationPath, (uploadErr) => {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      conn.end();
      if (uploadErr) return res.status(500).json({ error: uploadErr.message });
      res.json({ success: true, path: destinationPath });
    });
  });
});

// SFTP folder creation
app.post('/api/sftp/mkdir', (req, res) => {
  const { serverId, dirPath } = req.body;
  const servers = readServers();
  const srv = servers.find((s) => s.id === serverId);
  if (!srv) return res.status(404).json({ error: 'Server not found' });

  getSftpClient(srv, (err, sftp, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    sftp.mkdir(dirPath, (mkdirErr) => {
      conn.end();
      if (mkdirErr) return res.status(500).json({ error: mkdirErr.message });
      res.json({ success: true });
    });
  });
});

// SFTP file creation
app.post('/api/sftp/create-file', (req, res) => {
  const { serverId, filePath } = req.body;
  const servers = readServers();
  const srv = servers.find((s) => s.id === serverId);
  if (!srv) return res.status(404).json({ error: 'Server not found' });

  getSftpClient(srv, (err, sftp, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    const writeStream = sftp.createWriteStream(filePath);
    writeStream.on('close', () => {
      conn.end();
      res.json({ success: true });
    });
    writeStream.on('error', (streamErr) => {
      conn.end();
      res.status(500).json({ error: streamErr.message });
    });
    writeStream.end('');
  });
});

// SFTP delete item
app.post('/api/sftp/delete', (req, res) => {
  const { serverId, itemPath, isDirectory } = req.body;
  const servers = readServers();
  const srv = servers.find((s) => s.id === serverId);
  if (!srv) return res.status(404).json({ error: 'Server not found' });

  getSftpClient(srv, (err, sftp, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    const removeMethod = isDirectory ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
    removeMethod(itemPath, (removeErr) => {
      conn.end();
      if (removeErr) return res.status(500).json({ error: removeErr.message });
      res.json({ success: true });
    });
  });
});

// SFTP download item
app.get('/api/sftp/download', (req, res) => {
  const { serverId, filePath } = req.query;
  const servers = readServers();
  const srv = servers.find((s) => s.id === serverId);
  if (!srv) return res.status(404).json({ error: 'Server not found' });

  getSftpClient(srv, (err, sftp, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    const fileName = path.posix.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const readStream = sftp.createReadStream(filePath);
    readStream.pipe(res);
    readStream.on('close', () => conn.end());
    readStream.on('error', (streamErr) => {
      conn.end();
      if (!res.headersSent) res.status(500).json({ error: streamErr.message });
    });
  });
});

// Terminal WebSocket handler
wss.on('connection', (ws) => {
  let conn = null;
  let stream = null;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'init') {
        const servers = readServers();
        const srv = servers.find((s) => s.id === data.serverId);
        if (!srv) {
          ws.send(JSON.stringify({ type: 'output', data: '\r\nServer not found.\r\n' }));
          return;
        }

        conn = new Client();
        conn.on('ready', () => {
          conn.shell({ term: 'xterm-256color', rows: data.rows || 24, cols: data.cols || 80 }, (err, s) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'output', data: `\r\nShell error: ${err.message}\r\n` }));
              return;
            }
            stream = s;
            stream.on('data', (chunk) => {
              ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf-8') }));
            });
            stream.on('close', () => {
              conn.end();
              ws.close();
            });
          });
        }).on('error', (err) => {
          ws.send(JSON.stringify({ type: 'output', data: `\r\nConnection error: ${err.message}\r\n` }));
        }).connect({
          host: srv.host,
          port: parseInt(srv.port, 10) || 22,
          username: srv.username || 'ubuntu',
          password: srv.authType === 'password' ? srv.password : undefined,
          privateKey: srv.authType === 'key' ? srv.privateKey : undefined
        });
      }

      if (data.type === 'input' && stream) {
        stream.write(data.data);
      }

      if (data.type === 'resize' && stream) {
        stream.setWindow(data.rows, data.cols, 0, 0);
      }
    } catch (e) {
      // Ignore malformed packets
    }
  });

  ws.on('close', () => {
    if (conn) conn.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server manager listening on port ${PORT}`);
});