import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// basic rooms state
const rooms = new Map();
const TAG_RADIUS = 1.5;
const TAG_COOLDOWN_MS = 1500;

const now = () => Date.now();
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const dist3 = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
};

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: new Map(),
      taggerId: null,
      arena: { minX: -35, maxX: 35, minZ: -90, maxZ: 90, minY: 0.5, maxY: 6 }
    });
  }
  return rooms.get(roomId);
}
const sanitizeRoom = (room) => (room || "").toString().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "public";
const sanitizeName = (name) => {
  const n = (name || "").toString().trim().replace(/\s+/g, " ");
  return n.length ? n.slice(0, 16) : "Guest";
};
const sanitizeSkin = (skin) => (new Set(["runner","scout","heavy"]).has(skin) ? skin : "runner");

io.on("connection", (socket) => {
  let roomId = null;

  socket.on("room:join", ({ room, name, skin }) => {
    roomId = sanitizeRoom(room);
    const niceName = sanitizeName(name);
    const selSkin = sanitizeSkin(skin);
    const roomObj = getOrCreateRoom(roomId);

    const spawn = {
      id: socket.id,
      name: niceName,
      skin: selSkin,
      x: (Math.random() - 0.5) * 10,
      y: 0.5,
      z: (Math.random() - 0.5) * 10,
      rotY: Math.random() * Math.PI * 2,
      isTagger: !roomObj.taggerId,
      lastTagTime: now(),
      score: 0
    };
    if (!roomObj.taggerId) roomObj.taggerId = socket.id;

    roomObj.players.set(socket.id, spawn);
    socket.join(roomId);

    socket.emit("world:init", {
      me: spawn.id,
      room: roomId,
      players: Array.from(roomObj.players.values()),
      arena: roomObj.arena
    });
    socket.to(roomId).emit("player:join", spawn);
  });

  socket.on("player:state", (state) => {
    if (!roomId) return;
    const roomObj = rooms.get(roomId);
    if (!roomObj) return;
    const p = roomObj.players.get(socket.id);
    if (!p) return;
    p.x = clamp(state.x ?? p.x, roomObj.arena.minX, roomObj.arena.maxX);
    p.y = clamp(state.y ?? p.y, roomObj.arena.minY, roomObj.arena.maxY);
    p.z = clamp(state.z ?? p.z, roomObj.arena.minZ, roomObj.arena.maxZ);
    p.rotY = state.rotY ?? p.rotY;
  });

  socket.on("disconnect", () => {
    if (!roomId) return;
    const roomObj = rooms.get(roomId);
    if (!roomObj) return;
    const wasTagger = roomObj.taggerId === socket.id;
    roomObj.players.delete(socket.id);
    socket.to(roomId).emit("player:leave", socket.id);

    if (wasTagger) {
      const first = roomObj.players.values().next().value;
      roomObj.taggerId = first ? first.id : null;
      if (first) {
        first.isTagger = true;
        first.lastTagTime = now();
        io.to(roomId).emit("tag:update", { taggerId: roomObj.taggerId });
      }
    }
    if (roomObj.players.size === 0) rooms.delete(roomId);
  });

  socket.on("net:ping", (t) => socket.emit("net:pong", t));
});

// broadcast state ~10Hz and tagging
setInterval(() => {
  for (const [roomId, roomObj] of rooms.entries()) {
    if (roomObj.taggerId && roomObj.players.has(roomObj.taggerId)) {
      const tagger = roomObj.players.get(roomObj.taggerId);
      for (const p of roomObj.players.values()) {
        if (p.id === tagger.id) continue;
        const canTag = now() - tagger.lastTagTime > TAG_COOLDOWN_MS;
        if (!canTag) continue;
        if (dist3(tagger, p) <= TAG_RADIUS) {
          tagger.isTagger = false;
          p.isTagger = true;
          roomObj.taggerId = p.id;
          p.lastTagTime = now();
          tagger.score = (tagger.score || 0) + 1;
          io.to(roomId).emit("tag:update", { taggerId: roomObj.taggerId });
          break;
        }
      }
    }
    io.to(roomId).emit("world:state",
      Array.from(roomObj.players.values()).map(p => ({
        id: p.id, name: p.name, skin: p.skin, x: p.x, y: p.y, z: p.z, rotY: p.rotY, isTagger: p.isTagger, score: p.score || 0
      }))
    );
  }
}, 100);

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
