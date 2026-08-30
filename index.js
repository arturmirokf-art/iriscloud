const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const url = require('url');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const dbPath = path.join(__dirname, 'iris_cloud.db');
const db = new Database(dbPath);

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS configs (
    hwid TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    data TEXT NOT NULL,
    share_key TEXT UNIQUE,
    is_public INTEGER DEFAULT 0,
    username TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (hwid, name)
  );

  CREATE TABLE IF NOT EXISTS friends (
    hwid TEXT NOT NULL,
    friend_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (hwid, friend_name)
  );

  CREATE TABLE IF NOT EXISTS user_profiles (
    hwid TEXT PRIMARY KEY,
    username TEXT,
    prefix TEXT DEFAULT 'USER',
    last_seen TEXT NOT NULL
  );
`);

// Prepared Statements for high performance
const stmts = {
  getConfig: db.prepare('SELECT * FROM configs WHERE hwid = ? AND name = ?'),
  getConfigByShareKey: db.prepare('SELECT * FROM configs WHERE share_key = ?'),
  listConfigs: db.prepare('SELECT hwid, name, description, share_key, is_public, username, created_at, updated_at FROM configs WHERE hwid = ? ORDER BY updated_at DESC'),
  saveConfig: db.prepare(`
    INSERT INTO configs (hwid, name, description, data, share_key, is_public, username, created_at, updated_at)
    VALUES (@hwid, @name, @description, @data, @share_key, @is_public, @username, @created_at, @updated_at)
    ON CONFLICT(hwid, name) DO UPDATE SET
      description = CASE WHEN @description != '' THEN @description ELSE configs.description END,
      data = CASE WHEN @data != '' THEN @data ELSE configs.data END,
      username = @username,
      updated_at = @updated_at
  `),
  deleteConfig: db.prepare('DELETE FROM configs WHERE hwid = ? AND name = ?'),
  renameConfig: db.prepare('UPDATE configs SET name = ?, updated_at = ? WHERE hwid = ? AND name = ?'),
  updateShareKey: db.prepare('UPDATE configs SET share_key = ? WHERE hwid = ? AND name = ?'),
  updatePublish: db.prepare('UPDATE configs SET is_public = ? WHERE hwid = ? AND name = ?'),
  listMarketplace: db.prepare('SELECT name, description, data, share_key, username, created_at, updated_at FROM configs WHERE is_public = 1 ORDER BY updated_at DESC LIMIT 50'),

  listFriends: db.prepare('SELECT friend_name FROM friends WHERE hwid = ? ORDER BY created_at ASC'),
  addFriend: db.prepare('INSERT OR IGNORE INTO friends (hwid, friend_name, created_at) VALUES (?, ?, ?)'),
  removeFriend: db.prepare('DELETE FROM friends WHERE hwid = ? AND LOWER(friend_name) = LOWER(?)'),

  getUserProfile: db.prepare('SELECT * FROM user_profiles WHERE hwid = ?'),
  upsertUserProfile: db.prepare(`
    INSERT INTO user_profiles (hwid, username, prefix, last_seen)
    VALUES (@hwid, @username, @prefix, @last_seen)
    ON CONFLICT(hwid) DO UPDATE SET
      username = @username,
      last_seen = @last_seen,
      prefix = CASE WHEN @prefix IS NOT NULL AND @prefix != '' THEN @prefix ELSE user_profiles.prefix END
  `),
  updatePrefix: db.prepare('UPDATE user_profiles SET prefix = ?, last_seen = ? WHERE hwid = ?')
};

// WebSocket Connection Manager
const activeConnections = new Map(); // ws -> { hwid, username, prefix }

function getOnlineUsernames() {
  const users = new Set();
  for (const info of activeConnections.values()) {
    if (info.username) users.add(info.username.toLowerCase());
  }
  return Array.from(users);
}

function broadcastOnlineUsers() {
  const users = getOnlineUsernames();
  const payload = JSON.stringify({ type: 'online_users', users });
  for (const [ws, _] of activeConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastChat(sender, prefix, text) {
  const payload = JSON.stringify({
    type: 'chat',
    sender,
    prefix,
    text,
    timestamp: Math.floor(Date.now() / 1000)
  });
  for (const [ws, _] of activeConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// --- Health / Keepalive (UptimeRobot HEAD & GET) ---
app.all(['/', '/ping'], (req, res) => {
  res.json({
    status: 'online',
    service: 'Iris Cloud & IRC Service (Node.js)',
    time: Math.floor(Date.now() / 1000),
    online_users: activeConnections.size
  });
});

// --- Cloud Configs API ---
app.post('/api/configs/save', (req, res) => {
  const { hwid, name, description = '', data = '', username = 'Unknown' } = req.body;
  if (!hwid || !name) return res.status(400).json({ success: false, error: 'hwid and name required' });

  const existing = stmts.getConfig.get(hwid, name);
  let shareKey = existing?.share_key || null;
  const isPublic = existing?.is_public || 0;
  const now = new Date().toISOString();

  stmts.saveConfig.run({
    hwid,
    name,
    description,
    data,
    share_key: shareKey,
    is_public: isPublic,
    username,
    created_at: existing?.created_at || now,
    updated_at: now
  });

  res.json({ success: true, name, share_key: shareKey });
});

app.post('/api/configs/get', (req, res) => {
  const { hwid, name } = req.body;
  if (!hwid || !name) return res.status(400).json({ success: false, error: 'hwid and name required' });

  const row = stmts.getConfig.get(hwid, name);
  if (!row) return res.status(404).json({ success: false, error: 'Config not found' });

  res.json({
    success: true,
    data: {
      name: row.name,
      description: row.description,
      data: row.data,
      is_public: Boolean(row.is_public),
      share_key: row.share_key
    }
  });
});

app.post('/api/configs/list', (req, res) => {
  const { hwid, username = 'Unknown' } = req.body;
  if (!hwid) return res.status(400).json({ success: false, error: 'hwid required' });

  const now = new Date().toISOString();
  stmts.upsertUserProfile.run({ hwid, username, prefix: null, last_seen: now });

  const configs = stmts.listConfigs.all(hwid).map(r => ({
    name: r.name,
    description: r.description,
    share_key: r.share_key,
    is_public: Boolean(r.is_public),
    created_at: r.created_at,
    updated_at: r.updated_at
  }));

  res.json({ success: true, configs });
});

app.post('/api/configs/delete', (req, res) => {
  const { hwid, name } = req.body;
  if (!hwid || !name) return res.status(400).json({ success: false, error: 'hwid and name required' });

  const result = stmts.deleteConfig.run(hwid, name);
  if (result.changes === 0) return res.status(404).json({ success: false, error: 'Config not found' });

  res.json({ success: true });
});

app.post('/api/configs/rename', (req, res) => {
  const { hwid, old_name, new_name } = req.body;
  if (!hwid || !old_name || !new_name) return res.status(400).json({ success: false, error: 'hwid, old_name, and new_name required' });

  const now = new Date().toISOString();
  const result = stmts.renameConfig.run(new_name, now, hwid, old_name);
  if (result.changes === 0) return res.status(404).json({ success: false, error: 'Config not found' });

  res.json({ success: true });
});

app.post('/api/configs/share', (req, res) => {
  const { hwid, name } = req.body;
  if (!hwid || !name) return res.status(400).json({ success: false, error: 'hwid and name required' });

  const row = stmts.getConfig.get(hwid, name);
  if (!row) return res.status(404).json({ success: false, error: 'Config not found' });

  if (row.share_key) {
    return res.json({ success: true, share_key: row.share_key });
  }

  const shareKey = 'IRIS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  stmts.updateShareKey.run(shareKey, hwid, name);

  res.json({ success: true, share_key: shareKey });
});

app.post('/api/configs/import', (req, res) => {
  const { hwid, share_key, target_name } = req.body;
  if (!hwid || !share_key) return res.status(400).json({ success: false, error: 'hwid and share_key required' });

  const source = stmts.getConfigByShareKey.get(share_key);
  if (!source) return res.status(404).json({ success: false, error: 'Invalid share key' });

  const saveName = target_name || (source.name + ' (Imported)');
  const now = new Date().toISOString();

  stmts.saveConfig.run({
    hwid,
    name: saveName,
    description: source.description || '',
    data: source.data,
    share_key: null,
    is_public: 0,
    username: 'Imported',
    created_at: now,
    updated_at: now
  });

  res.json({ success: true, name: saveName });
});

app.get('/api/configs/marketplace', (req, res) => {
  const configs = stmts.listMarketplace.all().map(r => ({
    name: r.name,
    description: r.description,
    author: r.username,
    share_key: r.share_key,
    updated_at: r.updated_at
  }));
  res.json({ success: true, configs });
});

app.post('/api/configs/publish', (req, res) => {
  const { hwid, name, is_public = true } = req.body;
  if (!hwid || !name) return res.status(400).json({ success: false, error: 'hwid and name required' });

  const result = stmts.updatePublish.run(is_public ? 1 : 0, hwid, name);
  if (result.changes === 0) return res.status(404).json({ success: false, error: 'Config not found' });

  res.json({ success: true });
});

// --- Friends API ---
app.post('/api/friends/list', (req, res) => {
  const { hwid } = req.body;
  if (!hwid) return res.status(400).json({ success: false, error: 'hwid required' });

  const friends = stmts.listFriends.all(hwid).map(r => r.friend_name);
  res.json({ success: true, friends });
});

app.post('/api/friends/add', (req, res) => {
  const { hwid, friend_name } = req.body;
  if (!hwid || !friend_name) return res.status(400).json({ success: false, error: 'hwid and friend_name required' });

  const now = new Date().toISOString();
  stmts.addFriend.run(hwid, friend_name.trim(), now);
  res.json({ success: true });
});

app.post('/api/friends/remove', (req, res) => {
  const { hwid, friend_name } = req.body;
  if (!hwid || !friend_name) return res.status(400).json({ success: false, error: 'hwid and friend_name required' });

  stmts.removeFriend.run(hwid, friend_name.trim());
  res.json({ success: true });
});

// --- User Profile / Prefix API ---
app.post('/api/user/prefix', (req, res) => {
  const { hwid, username = 'Unknown', prefix = 'USER' } = req.body;
  if (!hwid) return res.status(400).json({ success: false, error: 'hwid required' });

  const now = new Date().toISOString();
  stmts.upsertUserProfile.run({ hwid, username, prefix, last_seen: now });

  // Update in active connection if online
  for (const [ws, info] of activeConnections) {
    if (info.hwid === hwid) {
      info.prefix = prefix;
      break;
    }
  }
  broadcastOnlineUsers();

  res.json({ success: true, prefix });
});

// --- HTTP Server & WebSocket Setup ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  if (pathname === '/ws/irc') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const hwid = parsedUrl.query.hwid || 'unknown';
  const username = parsedUrl.query.username || 'Anonymous';

  const now = new Date().toISOString();
  const profile = stmts.getUserProfile.get(hwid);
  const prefix = profile?.prefix || 'USER';

  stmts.upsertUserProfile.run({ hwid, username, prefix, last_seen: now });

  const info = { hwid, username, prefix };
  activeConnections.set(ws, info);

  // Send welcome
  ws.send(JSON.stringify({
    type: 'welcome',
    your_prefix: prefix,
    online_users: getOnlineUsernames()
  }));

  // Notify everyone
  broadcastOnlineUsers();

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.action === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (data.action === 'chat' && data.text) {
        broadcastChat(info.username, info.prefix, data.text);
      } else if (data.action === 'set_prefix' && data.prefix) {
        const newPrefix = data.prefix.slice(0, 16);
        info.prefix = newPrefix;
        stmts.updatePrefix.run(newPrefix, new Date().toISOString(), info.hwid);
        ws.send(JSON.stringify({ type: 'prefix_updated', prefix: newPrefix }));
        broadcastOnlineUsers();
      }
    } catch (err) {
      // Ignore malformed JSON
    }
  });

  ws.on('close', () => {
    activeConnections.delete(ws);
    broadcastOnlineUsers();
  });

  ws.on('error', () => {
    activeConnections.delete(ws);
    broadcastOnlineUsers();
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Iris Cloud & IRC Server (Node.js) listening on port ${PORT}`);
});
