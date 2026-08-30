const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- JSON File Database (Pure JS, Zero C++ compilation, Instant In-Memory) ---
const DB_FILE = path.join(__dirname, 'iris_database.json');

let db = {
  configs: {},       // key: `${hwid}:${name}` -> { hwid, name, description, data, share_key, is_public, username, created_at, updated_at }
  friends: {},       // key: `${hwid}` -> [friend_name1, friend_name2, ...]
  user_profiles: {}  // key: `${hwid}` -> { hwid, username, prefix, last_seen }
};

// Load existing DB if present
try {
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = {
      configs: parsed.configs || {},
      friends: parsed.friends || {},
      user_profiles: parsed.user_profiles || {}
    };
  }
} catch (e) {
  console.error('Failed to load DB file, starting fresh:', e.message);
}

// Debounced async persistence
let saveTimeout = null;
function saveDatabase() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const tempFile = DB_FILE + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tempFile, DB_FILE);
    } catch (e) {
      console.error('Failed to save DB file:', e.message);
    }
  }, 300);
}

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

  const key = `${hwid}:${name}`;
  const existing = db.configs[key];
  const now = new Date().toISOString();

  db.configs[key] = {
    hwid,
    name,
    description: description !== '' ? description : (existing?.description || ''),
    data: data !== '' ? data : (existing?.data || ''),
    share_key: existing?.share_key || null,
    is_public: existing?.is_public || false,
    username,
    created_at: existing?.created_at || now,
    updated_at: now
  };
  saveDatabase();

  res.json({ success: true, name, share_key: db.configs[key].share_key });
});

app.post('/api/configs/get', (req, res) => {
  const { hwid, name } = req.body;
  if (!hwid || !name) return res.status(400).json({ success: false, error: 'hwid and name required' });

  const key = `${hwid}:${name}`;
  const config = db.configs[key];
  if (!config) return res.status(404).json({ success: false, error: 'Config not found' });

  res.json({
    success: true,
    data: {
      name: config.name,
      description: config.description,
      data: config.data,
      is_public: Boolean(config.is_public),
      share_key: config.share_key
    }
  });
});

app.post('/api/configs/list', (req, res) => {
  const { hwid, username = 'Unknown' } = req.body;
  if (!hwid) return res.status(400).json({ success: false, error: 'hwid required' });

  const now = new Date().toISOString();
  if (!db.user_profiles[hwid]) {
    db.user_profiles[hwid] = { hwid, username, prefix: 'USER', last_seen: now };
  } else {
    db.user_profiles[hwid].username = username;
    db.user_profiles[hwid].last_seen = now;
  }
  saveDatabase();

  const userConfigs = [];
  for (const k in db.configs) {
    if (db.configs[k].hwid === hwid) {
      const c = db.configs[k];
      userConfigs.push({
        name: c.name,
        description: c.description,
        share_key: c.share_key,
        is_public: Boolean(c.is_public),
        created_at: c.created_at,
        updated_at: c.updated_at
      });
    }
  }

  userConfigs.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  res.json({ success: true, configs: userConfigs });
});

app.post('/api/configs/delete', (req, res) => {
  const { hwid, name } = req.body;
  if (!hwid || !name) return res.status(400).json({ success: false, error: 'hwid and name required' });

  const key = `${hwid}:${name}`;
  if (!db.configs[key]) return res.status(404).json({ success: false, error: 'Config not found' });

  delete db.configs[key];
  saveDatabase();

  res.json({ success: true });
});

app.post('/api/configs/rename', (req, res) => {
  const { hwid, old_name, new_name } = req.body;
  if (!hwid || !old_name || !new_name) return res.status(400).json({ success: false, error: 'hwid, old_name, and new_name required' });

  const oldKey = `${hwid}:${old_name}`;
  const newKey = `${hwid}:${new_name}`;

  const config = db.configs[oldKey];
  if (!config) return res.status(404).json({ success: false, error: 'Config not found' });

  config.name = new_name;
  config.updated_at = new Date().toISOString();
  db.configs[newKey] = config;
  delete db.configs[oldKey];
  saveDatabase();

  res.json({ success: true });
});

app.post('/api/configs/share', (req, res) => {
  const { hwid, name } = req.body;
  if (!hwid || !name) return res.status(400).json({ success: false, error: 'hwid and name required' });

  const key = `${hwid}:${name}`;
  const config = db.configs[key];
  if (!config) return res.status(404).json({ success: false, error: 'Config not found' });

  if (config.share_key) {
    return res.json({ success: true, share_key: config.share_key });
  }

  const shareKey = 'IRIS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  config.share_key = shareKey;
  saveDatabase();

  res.json({ success: true, share_key: shareKey });
});

app.post('/api/configs/import', (req, res) => {
  const { hwid, share_key, target_name } = req.body;
  if (!hwid || !share_key) return res.status(400).json({ success: false, error: 'hwid and share_key required' });

  let source = null;
  for (const k in db.configs) {
    if (db.configs[k].share_key === share_key) {
      source = db.configs[k];
      break;
    }
  }

  if (!source) return res.status(404).json({ success: false, error: 'Invalid share key' });

  const saveName = target_name || (source.name + ' (Imported)');
  const key = `${hwid}:${saveName}`;
  const now = new Date().toISOString();

  db.configs[key] = {
    hwid,
    name: saveName,
    description: source.description || '',
    data: source.data,
    share_key: null,
    is_public: false,
    username: 'Imported',
    created_at: now,
    updated_at: now
  };
  saveDatabase();

  res.json({ success: true, name: saveName });
});

app.get('/api/configs/marketplace', (req, res) => {
  const publicConfigs = [];
  for (const k in db.configs) {
    const c = db.configs[k];
    if (c.is_public) {
      publicConfigs.push({
        name: c.name,
        description: c.description,
        author: c.username,
        share_key: c.share_key,
        updated_at: c.updated_at
      });
    }
  }
  publicConfigs.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  res.json({ success: true, configs: publicConfigs.slice(0, 50) });
});

app.post('/api/configs/publish', (req, res) => {
  const { hwid, name, is_public = true } = req.body;
  if (!hwid || !name) return res.status(400).json({ success: false, error: 'hwid and name required' });

  const key = `${hwid}:${name}`;
  const config = db.configs[key];
  if (!config) return res.status(404).json({ success: false, error: 'Config not found' });

  config.is_public = Boolean(is_public);
  saveDatabase();

  res.json({ success: true });
});

// --- Friends API ---
app.post('/api/friends/list', (req, res) => {
  const { hwid } = req.body;
  if (!hwid) return res.status(400).json({ success: false, error: 'hwid required' });

  const friends = db.friends[hwid] || [];
  res.json({ success: true, friends });
});

app.post('/api/friends/add', (req, res) => {
  const { hwid, friend_name } = req.body;
  if (!hwid || !friend_name) return res.status(400).json({ success: false, error: 'hwid and friend_name required' });

  if (!db.friends[hwid]) db.friends[hwid] = [];
  const nameTrim = friend_name.trim();
  if (!db.friends[hwid].some(f => f.toLowerCase() === nameTrim.toLowerCase())) {
    db.friends[hwid].push(nameTrim);
    saveDatabase();
  }

  res.json({ success: true });
});

app.post('/api/friends/remove', (req, res) => {
  const { hwid, friend_name } = req.body;
  if (!hwid || !friend_name) return res.status(400).json({ success: false, error: 'hwid and friend_name required' });

  if (db.friends[hwid]) {
    const nameTrim = friend_name.trim().toLowerCase();
    db.friends[hwid] = db.friends[hwid].filter(f => f.toLowerCase() !== nameTrim);
    saveDatabase();
  }

  res.json({ success: true });
});

// --- User Profile / Prefix API ---
app.post('/api/user/prefix', (req, res) => {
  const { hwid, username = 'Unknown', prefix = 'USER' } = req.body;
  if (!hwid) return res.status(400).json({ success: false, error: 'hwid required' });

  const now = new Date().toISOString();
  if (!db.user_profiles[hwid]) {
    db.user_profiles[hwid] = { hwid, username, prefix, last_seen: now };
  } else {
    db.user_profiles[hwid].username = username;
    db.user_profiles[hwid].prefix = prefix;
    db.user_profiles[hwid].last_seen = now;
  }
  saveDatabase();

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
  const profile = db.user_profiles[hwid];
  const prefix = profile?.prefix || 'USER';

  if (!db.user_profiles[hwid]) {
    db.user_profiles[hwid] = { hwid, username, prefix, last_seen: now };
  } else {
    db.user_profiles[hwid].username = username;
    db.user_profiles[hwid].last_seen = now;
  }
  saveDatabase();

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
        if (db.user_profiles[info.hwid]) {
          db.user_profiles[info.hwid].prefix = newPrefix;
          db.user_profiles[info.hwid].last_seen = new Date().toISOString();
          saveDatabase();
        }
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
