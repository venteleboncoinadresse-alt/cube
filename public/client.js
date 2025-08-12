import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { io } from 'https://cdn.socket.io/4.7.5/socket.io.esm.min.js';

// --- UI elements
const hud = {
  status: document.getElementById("status"),
  room: document.getElementById("room"),
  ping: document.getElementById("ping"),
  score: document.getElementById("score"),
  share: document.getElementById("share"),
  lobby: document.getElementById("lobby"),
  nameInput: document.getElementById("name"),
  roomInput: document.getElementById("roomInput"),
  joinBtn: document.getElementById("joinBtn"),
  btnW: document.getElementById("btnW"),
  btnA: document.getElementById("btnA"),
  btnS: document.getElementById("btnS"),
  btnD: document.getElementById("btnD"),
};

// room from URL ?room=foo
const url = new URL(window.location.href);
const urlRoom = url.searchParams.get("room") || "";
if (urlRoom) {
  hud.roomInput.value = urlRoom;
}
hud.nameInput.value = localStorage.getItem("ct_name") || "";

// --- Three.js base
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101418);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 8, 12);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// labels renderer
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'fixed';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

// lights
const hemi = new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 1.0);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(5, 12, 4);
scene.add(dir);

// ground
const groundGeo = new THREE.PlaneGeometry(50, 50);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x25303a, metalness: 0.1, roughness: 0.9 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// arena walls (visual)
function addWall(x, z, w, h, rotY=0) {
  const geo = new THREE.BoxGeometry(w, 1.5, h);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a4652 });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, 0.75, z);
  m.rotation.y = rotY;
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
}
addWall(0, -25, 52, 2);
addWall(0,  25, 52, 2);
addWall(-25, 0, 2, 52);
addWall( 25, 0, 2, 52);

// camera controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.enablePan = false;
controls.maxPolarAngle = Math.PI * 0.49;

// materials
const matSelf = new THREE.MeshStandardMaterial({ color: 0x55ff55 });
const matOther = new THREE.MeshStandardMaterial({ color: 0x5599ff });
const matTagger = new THREE.MeshStandardMaterial({ color: 0xff5555 });

// players
const players = new Map();
let myId = null;
let myScore = 0;
let roomId = null;
let arena = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };

function makeLabel(text) {
  const div = document.createElement('div');
  div.textContent = text;
  div.style.padding = '2px 6px';
  div.style.borderRadius = '10px';
  div.style.background = 'rgba(0,0,0,0.55)';
  div.style.fontSize = '12px';
  div.style.whiteSpace = 'nowrap';
  return new CSS2DObject(div);
}

function createPlayerMesh(isSelf = false, name = "") {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geo, isSelf ? matSelf : matOther);
  mesh.castShadow = true;
  const label = makeLabel(name || "??");
  label.position.set(0, 0.9, 0);
  mesh.add(label);
  mesh.userData.label = label;
  return mesh;
}

function ensurePlayer(p) {
  if (!players.has(p.id)) {
    const isSelf = p.id === myId;
    const mesh = createPlayerMesh(isSelf, p.name);
    mesh.position.set(p.x, 0.5, p.z);
    scene.add(mesh);
    players.set(p.id, mesh);
  }
  const m = players.get(p.id);
  m.userData.label.element.textContent = p.name;
  m.material = p.isTagger ? matTagger : (p.id === myId ? matSelf : matOther);
}

function removePlayer(id) {
  const m = players.get(id);
  if (m) {
    scene.remove(m);
    players.delete(id);
  }
}

// input
const keys = new Set();
window.addEventListener("keydown", (e) => keys.add(e.code));
window.addEventListener("keyup", (e) => keys.delete(e.code));

// touch buttons
function bindTouch(btn, code) {
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); keys.add(code); }, {passive:false});
  btn.addEventListener('touchend',   (e) => { e.preventDefault(); keys.delete(code); }, {passive:false});
}
bindTouch(hud.btnW, "KeyW");
bindTouch(hud.btnA, "KeyA");
bindTouch(hud.btnS, "KeyS");
bindTouch(hud.btnD, "KeyD");

// my state
const me = { x: 0, y: 0.5, z: 0, rotY: 0, speed: 7, turn: 2.8 };

// networking
const socket = io();
hud.status.textContent = "Connexion…";

hud.joinBtn.addEventListener("click", () => {
  const name = hud.nameInput.value.trim() || "Guest";
  const room = (hud.roomInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "")) || "public";
  localStorage.setItem("ct_name", name);
  socket.emit("room:join", { room, name });
});

hud.share.addEventListener("click", async () => {
  if (!roomId) return;
  const shareUrl = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
  try {
    await navigator.clipboard.writeText(shareUrl);
    hud.status.textContent = "Lien copié !";
  } catch {
    hud.status.textContent = shareUrl;
  }
});

// ping
let lastPingSent = 0;
setInterval(() => {
  lastPingSent = performance.now();
  socket.emit("net:ping", lastPingSent);
}, 2000);
socket.on("net:pong", (t) => {
  const rtt = Math.max(0, Math.round(performance.now() - t));
  hud.ping.textContent = rtt.toString();
});

// socket events
socket.on("world:init", ({ me: id, room, players: plist, arena: a }) => {
  myId = id;
  roomId = room;
  arena = a || arena;
  hud.room.textContent = roomId;
  hud.status.textContent = `Connecté : ${myId}`;
  hud.lobby.style.display = "none";

  // update URL with room
  const u = new URL(window.location.href);
  u.searchParams.set("room", roomId);
  history.replaceState(null, "", u.toString());

  // ensure players
  for (const p of plist) ensurePlayer(p);
});

socket.on("player:join", (p) => ensurePlayer(p));
socket.on("player:leave", (id) => removePlayer(id));

socket.on("world:state", (list) => {
  for (const p of list) {
    ensurePlayer(p);
    const m = players.get(p.id);
    // interpolation
    m.position.lerp(new THREE.Vector3(p.x, p.y, p.z), 0.35);
    m.rotation.y = p.rotY;
    m.material = p.isTagger ? matTagger : (p.id === myId ? matSelf : matOther);
    if (p.id === myId) {
      myScore = p.score || 0;
      hud.score.textContent = String(myScore);
    }
  }
});

socket.on("tag:update", ({ taggerId }) => {
  hud.status.textContent = taggerId === myId ? "Tu es le CHAT ! (rouge)" : `Le chat: ${taggerId}`;
});

// game loop
let last = performance.now();
function tick(t) {
  const dt = Math.min(0.033, (t - last) / 1000);
  last = t;

  const m = players.get(myId);
  if (m) {
    // tank controls
    if (keys.has("KeyA")) me.rotY += me.turn * dt;
    if (keys.has("KeyD")) me.rotY -= me.turn * dt;
    const forward = new THREE.Vector3(Math.sin(me.rotY), 0, Math.cos(me.rotY));
    let v = new THREE.Vector3(0, 0, 0);
    if (keys.has("KeyW")) v.add(forward);
    if (keys.has("KeyS")) v.add(forward.clone().multiplyScalar(-1));
    if (v.lengthSq() > 0) v.normalize().multiplyScalar(me.speed * dt);

    me.x = THREE.MathUtils.clamp(m.position.x + v.x, arena.minX, arena.maxX);
    me.z = THREE.MathUtils.clamp(m.position.z + v.z, arena.minZ, arena.maxZ);

    // apply
    m.position.set(me.x, 0.5, me.z);
    m.rotation.y = me.rotY;

    // send state ~15 Hz
    if (t % 66 < 16) {
      socket.emit("player:state", { x: me.x, z: me.z, rotY: me.rotY });
    }

    // camera follow
    const camOffset = new THREE.Vector3(0, 7, 10).applyAxisAngle(new THREE.Vector3(0,1,0), -me.rotY);
    camera.position.lerp(m.position.clone().add(camOffset), 0.1);
    controls.target.copy(m.position);
    controls.update();
  }

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// resize
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});
