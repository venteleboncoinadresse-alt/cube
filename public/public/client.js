import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { io } from 'https://cdn.socket.io/4.7.5/socket.io.esm.min.js';

// --- UI refs
const $ = (id)=>document.getElementById(id);
const hud = { status: $("status"), room:$("room"), ping:$("ping"), openOpt:$("openOpt"), options:$("options"), closeOpt:$("closeOpt"),
  layoutSel:$("layoutSel"), resetOpt:$("resetOpt"), saveOpt:$("saveOpt"),
  lobby:$("lobby"), joinBtn:$("joinBtn"), name:$("name"), roomInput:$("roomInput") };

// ---- Input tokenization robust (AZERTY/QWERTY safe) ----
function tokenFromEvent(e){
  // Letters/numbers → use e.key uppercased (locale-aware)
  if (e.key && e.key.length === 1) {
    const ch = e.key.toUpperCase();
    if (/^[A-Z0-9]$/.test(ch)) return ch;
  }
  // Space / modifiers: use code
  if (e.code === 'Space') return 'Space';
  if (e.code && (e.code.startsWith('Shift') || e.code.startsWith('Control') || e.code.startsWith('Alt'))) return e.code;
  // Arrows / others: prefer key if meaningful, else code
  if (e.key && /^Arrow|Escape|Tab|Enter$/.test(e.key)) return e.key;
  return e.code || e.key || '';
}
// Pretty print token for UI
function tokenLabel(tok){
  if (tok === ' ') return 'Space';
  return tok;
}

// Defaults per layout (store tokens, not codes for letters)
const defaultsAZERTY = { forward:'Z', left:'Q', back:'S', right:'D', jump:'Space', sprint:'ShiftLeft' };
const defaultsQWERTY = { forward:'W', left:'A', back:'S', right:'D', jump:'Space', sprint:'ShiftLeft' };

let settings = JSON.parse(localStorage.getItem('ct_settings')||'null') || { layout:'azerty' };
let bindings = JSON.parse(localStorage.getItem('ct_bindings_tok')||'null') || (settings.layout==='qwerty' ? {...defaultsQWERTY} : {...defaultsAZERTY});

// capture
const keys = new Set();
function onKeyDown(e){
  const tok = tokenFromEvent(e);
  // prevent default if mapped
  if (Object.values(bindings).includes(tok)) e.preventDefault();
  keys.add(tok);
}
function onKeyUp(e){
  const tok = tokenFromEvent(e);
  keys.delete(tok);
}
window.addEventListener('keydown', onKeyDown, {passive:false});
window.addEventListener('keyup', onKeyUp, {passive:false});

// ---- Scene ----
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101418);
const camera = new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 0.1, 200); camera.position.set(0,8,12);
const renderer = new THREE.WebGLRenderer({ antialias:true }); renderer.setSize(innerWidth, innerHeight); document.body.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan=false; controls.maxPolarAngle = Math.PI*0.49; controls.enableDamping=true; controls.dampingFactor=0.08;

// arena
scene.add(new THREE.HemisphereLight(0xffffff,0x1a1a1a,1.0));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(50,50), new THREE.MeshStandardMaterial({color:0x25303a})); ground.rotation.x=-Math.PI/2; scene.add(ground);

// net
const socket = io(); hud.status.textContent="Connexion…";
setInterval(()=>socket.emit("net:ping",performance.now()),2000);
socket.on("net:pong",t=>{ hud.ping.textContent = String(Math.max(0,Math.round(performance.now()-t))); });

let myId=null, arena={minX:-20,maxX:20,minZ:-20,maxZ:20,minY:0.5,maxY:6};
const players=new Map();
function makeCapsule(color){ const g=new THREE.Group(); const m=new THREE.MeshStandardMaterial({color}); const c=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,0.9,16),m), t=new THREE.Mesh(new THREE.SphereGeometry(0.35,16,12),m), b=new THREE.Mesh(new THREE.SphereGeometry(0.35,16,12),m); t.position.y=0.45; b.position.y=-0.45; g.add(c,t,b); return g; }
function ensurePlayer(p){ if(!players.has(p.id)){ const mesh=makeCapsule(p.id===myId?0x55ff55:0x5599ff); mesh.position.set(p.x,p.y,p.z); scene.add(mesh); players.set(p.id,mesh); } }
socket.on("world:init", ({me:id, room, players:pl, arena:a})=>{
  myId=id; arena=a||arena; hud.room.textContent=room; hud.lobby.style.display='none'; hud.status.textContent=`Connecté : ${myId}`;
  for(const p of pl){ ensurePlayer(p); }
});
socket.on("player:join",p=>ensurePlayer(p));
socket.on("player:leave",id=>{ const m=players.get(id); if(m){scene.remove(m); players.delete(id);} });
socket.on("world:state",list=>{ for(const p of list){ const m=players.get(p.id); if(!m) continue; m.position.lerp(new THREE.Vector3(p.x,p.y,p.z),0.35); m.rotation.y=p.rotY; } });

// movement
const me={ x:0,y:0.5,z:0,yaw:0, vx:0,vy:0,vz:0, speed:7, sprint:10, gravity:25, jumpVel:8, grounded:true };
function dirCamRelative(){
  const f=new THREE.Vector3(); camera.getWorldDirection(f); f.y=0; f.normalize();
  const r=new THREE.Vector3(f.z,0,-f.x); const d=new THREE.Vector3();
  if (keys.has(bindings.forward)) d.add(f);
  if (keys.has(bindings.back))    d.add(f.clone().multiplyScalar(-1));
  if (keys.has(bindings.right))   d.add(r);
  if (keys.has(bindings.left))    d.add(r.clone().multiplyScalar(-1));
  if (d.lengthSq()>0) d.normalize();
  return d;
}

let last=performance.now();
function tick(t){
  const dt=Math.min(0.033,(t-last)/1000); last=t;
  const m=players.get(myId);
  if(m){
    const dir = dirCamRelative();
    const targetSpeed = keys.has(bindings.sprint)?me.sprint:me.speed;
    const desired = dir.clone().multiplyScalar(targetSpeed);
    const smooth = 1 - Math.pow(1 - 0.35, dt*60);
    me.vx = THREE.MathUtils.lerp(me.vx, desired.x, smooth);
    me.vz = THREE.MathUtils.lerp(me.vz, desired.z, smooth);

    if (keys.has(bindings.jump) && me.grounded){ me.vy=me.jumpVel; me.grounded=false; }
    me.vy -= me.gravity * dt;

    me.x = THREE.MathUtils.clamp(me.x + me.vx*dt, arena.minX, arena.maxX);
    me.z = THREE.MathUtils.clamp(me.z + me.vz*dt, arena.minZ, arena.maxZ);
    me.y = Math.min(arena.maxY, me.y + me.vy*dt);
    const groundY=0.5; if(me.y<=groundY){ me.y=groundY; me.vy=0; me.grounded=true; }

    if (dir.lengthSq()>0.0001){
      const targetYaw = Math.atan2(dir.x, dir.z);
      me.yaw = THREE.MathUtils.lerp(me.yaw, targetYaw, 1 - Math.pow(1 - 0.28, dt*60));
    }
    m.position.set(me.x, me.y, me.z);
    m.rotation.y = me.yaw;

    controls.target.copy(m.position.clone().setY(1.2));
    controls.update();

    if (t%66<16) socket.emit("player:state",{x:me.x,y:me.y,z:me.z,rotY:me.yaw});
  }

  renderer.render(scene,camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

addEventListener('resize',()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---- Options UI ----
function renderBindings(){
  document.querySelectorAll('.keybtn').forEach(btn=>{
    const a = btn.dataset.action;
    btn.textContent = tokenLabel(bindings[a]);
    btn.onclick = ()=>{
      btn.textContent = "Appuie…";
      const h = (ev)=>{
        ev.preventDefault();
        const tok = tokenFromEvent(ev);
        bindings[a] = tok;
        btn.textContent = tokenLabel(tok);
        document.removeEventListener('keydown', h, true);
      };
      document.addEventListener('keydown', h, true);
    };
  });
  hud.layoutSel.value = settings.layout || 'azerty';
}
function openOptions(){ hud.options.style.display='flex'; renderBindings(); }
function closeOptions(){ hud.options.style.display='none'; }
hud.openOpt.onclick=openOptions; hud.closeOpt.onclick=closeOptions;
window.addEventListener('keydown',(e)=>{ if(e.code==='KeyO'){ if(hud.options.style.display==='none'||!hud.options.style.display) openOptions(); else closeOptions(); }});

hud.resetOpt.onclick = ()=>{
  settings.layout = 'azerty';
  bindings = {...defaultsAZERTY};
  localStorage.removeItem('ct_bindings_tok');
  localStorage.setItem('ct_settings', JSON.stringify(settings));
  renderBindings();
};
hud.saveOpt.onclick = ()=>{
  settings.layout = hud.layoutSel.value;
  if (settings.layout === 'azerty' && JSON.stringify(bindings) === JSON.stringify(defaultsQWERTY)) bindings = {...defaultsAZERTY};
  if (settings.layout === 'qwerty' && JSON.stringify(bindings) === JSON.stringify(defaultsAZERTY)) bindings = {...defaultsQWERTY};
  localStorage.setItem('ct_bindings_tok', JSON.stringify(bindings));
  localStorage.setItem('ct_settings', JSON.stringify(settings));
  hud.status.textContent = "Options sauvegardées ✔";
};
