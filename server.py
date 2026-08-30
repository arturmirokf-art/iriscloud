"""
Iris Cloud & IRC Backend Server
FastAPI + WebSockets server for Minecraft Fabric Client.
Features:
- HWID-isolated Private Cloud Configs
- Public Configs Marketplace & Share-by-Key System
- HWID-isolated Cloud Friends List
- Real-time IRC Chat with Custom/Preset Prefixes (@irc, @irc prefix)
- Live Iris Online Users Tracking for In-Game Badges
- /ping and / keepalive endpoints for UptimeRobot (Free Render.com tier)
"""

import asyncio
import json
import os
import sqlite3
import string
import random
import time
from datetime import datetime
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="Iris Cloud & IRC Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_FILE = os.environ.get("DB_FILE", "cloud.db")

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        # Configs Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS configs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hwid TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                data TEXT NOT NULL,
                share_key TEXT UNIQUE,
                is_public INTEGER DEFAULT 0,
                downloads INTEGER DEFAULT 0,
                author_name TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(hwid, name)
            )
        """)
        # Friends Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS friends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hwid TEXT NOT NULL,
                friend_name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(hwid, friend_name)
            )
        """)
        # User Profiles (Last seen, custom prefix)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_profiles (
                hwid TEXT PRIMARY KEY,
                last_name TEXT NOT NULL,
                irc_prefix TEXT DEFAULT 'USER',
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()

init_db()

def generate_share_key() -> str:
    chars = string.ascii_uppercase + string.digits
    for _ in range(10):
        code = f"IRIS-{''.join(random.choices(chars, k=4))}-{''.join(random.choices(chars, k=4))}"
        with get_db() as conn:
            row = conn.execute("SELECT id FROM configs WHERE share_key = ?", (code,)).fetchone()
            if not row:
                return code
    return f"IRIS-{int(time.time())}"

# --- WebSocket Connection Manager for IRC & Live Users ---
class ConnectionManager:
    def __init__(self):
        # ws -> dict(hwid, username, prefix)
        self.active_connections: Dict[WebSocket, dict] = {}

    async def connect(self, websocket: WebSocket, hwid: str, username: str, prefix: str):
        await websocket.accept()
        self.active_connections[websocket] = {
            "hwid": hwid,
            "username": username,
            "prefix": prefix,
            "connected_at": time.time()
        }
        await self.broadcast_online_users()

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            del self.active_connections[websocket]

    def get_online_usernames(self) -> List[str]:
        return list({info["username"] for info in self.active_connections.values() if info.get("username")})

    async def broadcast_online_users(self):
        users = self.get_online_usernames()
        msg = json.dumps({"type": "online_users", "users": users})
        for ws in list(self.active_connections.keys()):
            try:
                await ws.send_text(msg)
            except Exception:
                pass

    async def broadcast_chat(self, sender: str, prefix: str, text: str):
        msg = json.dumps({
            "type": "chat",
            "sender": sender,
            "prefix": prefix,
            "text": text,
            "timestamp": int(time.time())
        })
        for ws in list(self.active_connections.keys()):
            try:
                await ws.send_text(msg)
            except Exception:
                pass

manager = ConnectionManager()

# --- Health & Keepalive (GET & HEAD for UptimeRobot) ---
@app.api_route("/", methods=["GET", "HEAD"])
@app.api_route("/ping", methods=["GET", "HEAD"])
def ping():
    return {
        "status": "online",
        "service": "Iris Cloud & IRC Service",
        "time": int(time.time()),
        "online_users": len(manager.active_connections)
    }

# --- Request Models ---
class ConfigSaveRequest(BaseModel):
    hwid: str
    name: str
    description: Optional[str] = ""
    data: str
    username: Optional[str] = "User"

class ConfigGetRequest(BaseModel):
    hwid: str
    name: str

class ConfigDeleteRequest(BaseModel):
    hwid: str
    name: str

class ConfigRenameRequest(BaseModel):
    hwid: str
    old_name: str
    new_name: str

class ConfigShareRequest(BaseModel):
    hwid: str
    name: str

class ConfigImportRequest(BaseModel):
    hwid: str
    share_key: str
    target_name: Optional[str] = None

class ConfigPublishRequest(BaseModel):
    hwid: str
    name: str
    is_public: bool = True

class FriendRequest(BaseModel):
    hwid: str
    friend_name: str

class HwidRequest(BaseModel):
    hwid: str
    username: Optional[str] = None

class PrefixUpdateRequest(BaseModel):
    hwid: str
    username: str
    prefix: str

# --- Cloud Configs API ---
@app.post("/api/configs/save")
def save_config(req: ConfigSaveRequest):
    if not req.hwid or not req.name:
        raise HTTPException(status_code=400, detail="Missing hwid or config name")
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO configs (hwid, name, description, data, author_name, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(hwid, name) DO UPDATE SET
                description = excluded.description,
                data = excluded.data,
                author_name = excluded.author_name,
                updated_at = CURRENT_TIMESTAMP
        """, (req.hwid, req.name, req.description or "", req.data, req.username or "User"))
        conn.commit()
    return {"success": True, "message": f"Config '{req.name}' saved successfully"}

@app.post("/api/configs/get")
def get_config(req: ConfigGetRequest):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM configs WHERE hwid = ? AND name = ?", (req.hwid, req.name)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Config not found")
        return {
            "success": True,
            "data": {
                "name": row["name"],
                "description": row["description"],
                "data": row["data"],
                "share_key": row["share_key"],
                "is_public": bool(row["is_public"]),
                "updated_at": row["updated_at"]
            }
        }

@app.post("/api/configs/list")
def list_configs(req: HwidRequest):
    with get_db() as conn:
        rows = conn.execute("""
            SELECT name, description, share_key, is_public, downloads, created_at, updated_at
            FROM configs WHERE hwid = ? ORDER BY updated_at DESC
        """, (req.hwid,)).fetchall()
        
        configs = []
        for r in rows:
            configs.append({
                "name": r["name"],
                "description": r["description"],
                "share_key": r["share_key"],
                "is_public": bool(r["is_public"]),
                "downloads": r["downloads"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"]
            })
        return {"success": True, "configs": configs}

@app.post("/api/configs/delete")
def delete_config(req: ConfigDeleteRequest):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM configs WHERE hwid = ? AND name = ?", (req.hwid, req.name))
        conn.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Config not found")
    return {"success": True, "message": f"Config '{req.name}' deleted"}

@app.post("/api/configs/rename")
def rename_config(req: ConfigRenameRequest):
    with get_db() as conn:
        cursor = conn.cursor()
        try:
            cursor.execute("UPDATE configs SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE hwid = ? AND name = ?",
                           (req.new_name, req.hwid, req.old_name))
            conn.commit()
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="Config not found")
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="Config with new name already exists")
    return {"success": True, "message": f"Renamed to '{req.new_name}'"}

@app.post("/api/configs/share")
def share_config(req: ConfigShareRequest):
    with get_db() as conn:
        row = conn.execute("SELECT share_key FROM configs WHERE hwid = ? AND name = ?", (req.hwid, req.name)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Config not found")
        
        key = row["share_key"]
        if not key:
            key = generate_share_key()
            conn.execute("UPDATE configs SET share_key = ? WHERE hwid = ? AND name = ?", (key, req.hwid, req.name))
            conn.commit()
            
        return {"success": True, "share_key": key}

@app.post("/api/configs/import")
def import_config(req: ConfigImportRequest):
    key = req.share_key.strip().upper()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM configs WHERE share_key = ?", (key,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Invalid share key or config not found")
        
        target_name = req.target_name if req.target_name else f"{row['name']}_imported"
        author = row["author_name"] or "Author"
        description = f"Imported from {author} (key: {key}). {row['description'] or ''}".strip()
        
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO configs (hwid, name, description, data, author_name, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(hwid, name) DO UPDATE SET
                description = excluded.description,
                data = excluded.data,
                author_name = excluded.author_name,
                updated_at = CURRENT_TIMESTAMP
        """, (req.hwid, target_name, description, row["data"], author))
        
        # Increment downloads
        conn.execute("UPDATE configs SET downloads = downloads + 1 WHERE id = ?", (row["id"],))
        conn.commit()
        
    return {
        "success": True,
        "name": target_name,
        "message": f"Successfully imported config '{target_name}'"
    }

@app.get("/api/configs/marketplace")
def get_marketplace():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT name, description, author_name, share_key, downloads, updated_at
            FROM configs WHERE is_public = 1 ORDER BY downloads DESC, updated_at DESC LIMIT 50
        """).fetchall()
        
        public_configs = []
        for r in rows:
            public_configs.append({
                "name": r["name"],
                "description": r["description"],
                "author": r["author_name"],
                "share_key": r["share_key"],
                "downloads": r["downloads"],
                "updated_at": r["updated_at"]
            })
        return {"success": True, "configs": public_configs}

@app.post("/api/configs/publish")
def publish_config(req: ConfigPublishRequest):
    with get_db() as conn:
        row = conn.execute("SELECT share_key FROM configs WHERE hwid = ? AND name = ?", (req.hwid, req.name)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Config not found")
        
        key = row["share_key"] or generate_share_key()
        conn.execute("""
            UPDATE configs SET is_public = ?, share_key = ? WHERE hwid = ? AND name = ?
        """, (1 if req.is_public else 0, key, req.hwid, req.name))
        conn.commit()
    return {"success": True, "is_public": req.is_public, "share_key": key}

# --- Cloud Friends API ---
@app.post("/api/friends/list")
def list_friends(req: HwidRequest):
    with get_db() as conn:
        rows = conn.execute("SELECT friend_name, created_at FROM friends WHERE hwid = ? ORDER BY friend_name ASC", (req.hwid,)).fetchall()
        friends = [r["friend_name"] for r in rows]
        return {"success": True, "friends": friends}

@app.post("/api/friends/add")
def add_friend(req: FriendRequest):
    name = req.friend_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Friend name cannot be empty")
    with get_db() as conn:
        try:
            conn.execute("INSERT INTO friends (hwid, friend_name) VALUES (?, ?)", (req.hwid, name))
            conn.commit()
        except sqlite3.IntegrityError:
            pass
    return {"success": True, "friend": name}

@app.post("/api/friends/remove")
def remove_friend(req: FriendRequest):
    with get_db() as conn:
        conn.execute("DELETE FROM friends WHERE hwid = ? AND friend_name = ?", (req.hwid, req.friend_name.strip()))
        conn.commit()
    return {"success": True, "removed": req.friend_name}

# --- User Profile & Prefix API ---
@app.post("/api/user/prefix")
async def update_prefix(req: PrefixUpdateRequest):
    clean_prefix = req.prefix.strip()
    if not clean_prefix:
        clean_prefix = "USER"
    if len(clean_prefix) > 16:
        clean_prefix = clean_prefix[:16]
        
    with get_db() as conn:
        conn.execute("""
            INSERT INTO user_profiles (hwid, last_name, irc_prefix, last_seen)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(hwid) DO UPDATE SET
                last_name = excluded.last_name,
                irc_prefix = excluded.irc_prefix,
                last_seen = CURRENT_TIMESTAMP
        """, (req.hwid, req.username, clean_prefix))
        conn.commit()
        
    # Update active connection prefix if present
    for ws, info in manager.active_connections.items():
        if info["hwid"] == req.hwid:
            info["prefix"] = clean_prefix
            info["username"] = req.username
            
    return {"success": True, "prefix": clean_prefix}

# --- IRC WebSocket Endpoint ---
@app.websocket("/ws/irc")
async def websocket_irc_endpoint(websocket: WebSocket):
    hwid = websocket.query_params.get("hwid", "unknown_hwid")
    username = websocket.query_params.get("username", "IrisPlayer")
    
    # Load prefix from DB
    prefix = "USER"
    with get_db() as conn:
        row = conn.execute("SELECT irc_prefix FROM user_profiles WHERE hwid = ?", (hwid,)).fetchone()
        if row and row["irc_prefix"]:
            prefix = row["irc_prefix"]
        else:
            conn.execute("""
                INSERT INTO user_profiles (hwid, last_name, irc_prefix) VALUES (?, ?, ?)
                ON CONFLICT(hwid) DO UPDATE SET last_name = excluded.last_name
            """, (hwid, username, prefix))
            conn.commit()

    await manager.connect(websocket, hwid, username, prefix)
    
    try:
        # Send welcome and current online users
        await websocket.send_text(json.dumps({
            "type": "welcome",
            "your_prefix": prefix,
            "online_users": manager.get_online_usernames()
        }))
        
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                action = msg.get("action")
                
                if action == "chat":
                    text = msg.get("text", "").strip()
                    if text:
                        user_info = manager.active_connections.get(websocket, {})
                        cur_sender = user_info.get("username", username)
                        cur_prefix = user_info.get("prefix", prefix)
                        await manager.broadcast_chat(cur_sender, cur_prefix, text)
                        
                elif action == "set_prefix":
                    new_prefix = msg.get("prefix", "USER").strip()
                    if new_prefix:
                        if len(new_prefix) > 16:
                            new_prefix = new_prefix[:16]
                        user_info = manager.active_connections.get(websocket, {})
                        user_info["prefix"] = new_prefix
                        with get_db() as conn:
                            conn.execute("UPDATE user_profiles SET irc_prefix = ? WHERE hwid = ?", (new_prefix, hwid))
                            conn.commit()
                        await websocket.send_text(json.dumps({
                            "type": "prefix_updated",
                            "prefix": new_prefix
                        }))
                        
                elif action == "ping":
                    await websocket.send_text(json.dumps({"type": "pong", "time": int(time.time())}))
                    
            except json.JSONDecodeError:
                pass
                
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        await manager.broadcast_online_users()
    except Exception:
        manager.disconnect(websocket)
        await manager.broadcast_online_users()

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
