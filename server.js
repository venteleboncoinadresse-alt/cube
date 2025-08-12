import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// --- Modèle de données par salon ---
// rooms: roomId -> { players: Map<id, Player>, taggerId, lastTick }
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
      lastTick: now(),
      arena: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 }
    });
  }
  return rooms.get(roomId);
}

function sanitizeRoom(room) {
  return (room || "").toString().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "public";
}
function sanitizeName(name) {
  const n = (name || "").toString().trim().replace(/\s+/g, " ");
  return n.length ? n.slice(0, 16) : "Guest";
}

// Connexion
io.on("connection", (socket) => {
  let roomId = null;

  socket.on("room:join", ({ room, name }) => {
    roomId = sanitizeRoom(room);
    const niceName = sanitizeName(name);
    const roomObj = getOrCreateRoom(roomId);

    // Ajoute joueur
    const spawn = {
      id: socket.id,
      name: niceName,
      x: (Math.random() - 0.5) * 10,
      y: 0.5,
      z: (Math.random() - 0.5) * 10,
      rotY: Math.random() * Math.PI * 2,
      isTagger: false,
      lastTagTime: 0,
      score: 0
    };

    if (!roomObj.taggerId) {
      spawn.isTagger = true;
      roomObj.taggerId = socket.id;
      spawn.lastTagTime = now();
    }

    roomObj.players.set(socket.id, spawn);
    socket.join(roomId);

    // init pour le nouveau
    socket.emit("world:init", {
      me: spawn.id,
      room: roomId,
      players: Array.from(roomObj.players.values()),
      arena: roomObj.arena
    });

    // informer les autres
    socket.to(roomId).emit("player:join", spawn);
  });

  socket.on("player:state", (state) => {
    if (!roomId) return;
    const roomObj = rooms.get(roomId);
    if (!roomObj) return;
    const p = roomObj.players.get(socket.id);
    if (!p) return;
    // clamp dans l'arène
    p.x = clamp(state.x ?? p.x, roomObj.arena.minX, roomObj.arena.maxX);
    p.y = 0.5;
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
      if (first) {
        first.isTagger = true;
        first.lastTagTime = now();
        roomObj.taggerId = first.id;
        io.to(roomId).emit("tag:update", { taggerId: roomObj.taggerId });
      } else {
        roomObj.taggerId = null;
      }
    }

    // Supprime la room vide
    if (roomObj.players.size === 0) {
      rooms.delete(roomId);
    }
  });

  // ping RTT
  socket.on("net:ping", (t) => {
    socket.emit("net:pong", t);
  });
});

// Boucle serveur: 10 Hz pour chaque salon
setInterval(() => {
  const t = now();
  for (const [roomId, roomObj] of rooms.entries()) {
    // tag
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
          // Score: +1 pour celui qui transfère (a touché)
          tagger.score = (tagger.score || 0) + 1;
          io.to(roomId).emit("tag:update", { taggerId: roomObj.taggerId });
          break;
        }
      }
    }

    // broadcast etat
    io.to(roomId).emit("world:state",
      Array.from(roomObj.players.values()).map(p => ({
        id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, rotY: p.rotY, isTagger: p.isTagger, score: p.score || 0
      }))
    );
  }
}, 100);

server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
