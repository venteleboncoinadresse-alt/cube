import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { io } from 'https://cdn.socket.io/4.7.5/socket.io.esm.min.js';

const TAU = Math.PI * 2;
const lerpAngle = (a,b,t)=>{ let d=((b-a+Math.PI)%TAU)-Math.PI; if(d<-Math.PI) d+=TAU; return a + d * Math.max(0,Math.min(1,t)); };
const $ = (id)=>document.getElementById(id);

// HUD
const hud={ status:$("status"), room:$("room"), ping:$("ping"), score:$("score"),
  lobby:$("lobby"), nameInput:$("name"), roomInput:$("roomInput"), joinBtn:$("joinBtn"),
  dbgId:$("dbgId"), dbgDiag:$("dbgDiag"), dbgSkin:$("dbgSkin"),
  openOpt:$("openOpt"), options:$("options"), closeOpt:$("closeOpt"),
  moveMode:$("moveMode"), camSens:$("camSens"), camSensVal:$("camSensVal"),
  resetOpt:$("resetOpt"), saveOpt:$("saveOpt"),
  skinSelect:$("skinSelect"), customGlbUrl:$("customGlbUrl")
};

// Defaults
const defaultBindings={ forward:'KeyZ', back:'KeyS', left:'KeyQ', right:'KeyD', jump:'Space', sprint:'ShiftLeft' };
let bindings = JSON.parse(localStorage.getItem('ct_bindings')||'null') || {...defaultBindings};
const defaultSettings={ moveMode:'tps', camSens:1.0, skin:'runner', customGlbUrl:'' };
let settings = JSON.parse(localStorage.getItem('ct_settings')||'null') || {...defaultSettings};

// CDN fallback for realistic humans (Khronos sample models)
const SKIN_CDN = {
  runner: "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Soldier/glTF-Binary/Soldier.glb",
  scout:  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMan/glTF-Binary/CesiumMan.glb",
  heavy:  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/RiggedSimple/glTF-Binary/RiggedSimple.glb"
};
const SKIN_LOCAL = { runner: "models/runner.glb", scout: "models/scout.glb", heavy: "models/heavy.glb" };

// Stats
const SKIN_STATS = {
  runner: { speed: 7.5, sprint: 10.5, jump: 8.0 },
  scout:  { speed: 8.5, sprint: 12.0, jump: 9.0 },
  heavy:  { speed: 6.0, sprint: 8.5,  jump: 7.2 }
};

// Scene
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x101418);
const camera=new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 0.1, 200); camera.position.set(0,8,14);
const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setSize(innerWidth, innerHeight); document.body.appendChild(renderer.domElement);
renderer.domElement.setAttribute('tabindex','0'); renderer.domElement.addEventListener('pointerdown',()=>renderer.domElement.focus());
const labelRenderer=new CSS2DRenderer(); labelRenderer.setSize(innerWidth, innerHeight); labelRenderer.domElement.style.position='fixed'; labelRenderer.domElement.style.top='0'; labelRenderer.domElement.style.pointerEvents='none'; document.body.appendChild(labelRenderer.domElement);

// Lights + arena
scene.add(new THREE.HemisphereLight(0xffffff,0x1a1a1a,1.0));
const sun=new THREE.DirectionalLight(0xffffff,0.9); sun.position.set(5,12,4); scene.add(sun);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(50,50), new THREE.MeshStandardMaterial({color:0x25303a})); ground.rotation.x=-Math.PI/2; scene.add(ground);
function wall(x,z,w,h,rotY=0){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,1.5,h), new THREE.MeshStandardMaterial({color:0x3a4652})); m.position.set(x,0.75,z); m.rotation.y=rotY; scene.add(m); }
wall(0,-25,52,2); wall(0,25,52,2); wall(-25,0,2,52); wall(25,0,2,52);

// Orbit
const controls=new OrbitControls(camera, renderer.domElement);
controls.enablePan=false; controls.enableZoom=false; controls.enableDamping=true; controls.dampingFactor=0.08;
controls.minDistance=12; controls.maxDistance=12;
controls.rotateSpeed = settings.camSens;

// Loader
const loader = new GLTFLoader();

async function loadGLB(url){
  return new Promise((resolve,reject)=>{
    loader.load(url, (gltf)=>resolve(gltf.scene), undefined, (err)=>reject(err));
  });
}

// Fallback mesh
function makeCapsule(hex){
  const mat=new THREE.MeshStandardMaterial({color:hex});
  const g=new THREE.Group();
  const c=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,0.9,24),mat);
  const t=new THREE.Mesh(new THREE.SphereGeometry(0.35,24,18),mat);
  const b=new THREE.Mesh(new THREE.SphereGeometry(0.35,24,18),mat);
  t.position.y=0.45; b.position.y=-0.45; g.add(c,t,b); return g;
}

// Fix materials
function forceVisible(root, tint=0xffffff){
  let rep=0;
  root.traverse((o)=>{
    if(o.isMesh){
      let m=o.material;
      if(!m){ m = new THREE.MeshStandardMaterial({ color: tint }); rep++; }
      m.opacity=1; m.transparent=false; m.side=THREE.DoubleSide; m.metalness=0; m.roughness=0.9;
      if(!m.emissive) m.emissive = new THREE.Color(0x111111);
      o.material = m;
      o.visible=true; o.frustumCulled=false; o.castShadow=true; o.receiveShadow=true;
    }
  });
  return rep;
}

// Normalize
function normalizeModel(root){
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return {pre:[0,0,0], post:[0,0,0], s1:1, s2:1};
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);

  // recentre (pose les pieds au sol)
  root.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));

  // scale height to 1.0
  const s1 = size.y>0 ? (1.0/size.y) : 1;
  root.scale.multiplyScalar(s1);

  // recompute and clamp XZ to <= 0.8
  const box2 = new THREE.Box3().setFromObject(root);
  const size2 = new THREE.Vector3(); box2.getSize(size2);
  const clampXZ = 0.8;
  const fx = size2.x>clampXZ ? (clampXZ/size2.x) : 1;
  const fz = size2.z>clampXZ ? (clampXZ/size2.z) : 1;
  const s2 = Math.min(fx,fz);
  if (s2 < 1) root.scale.multiplyScalar(s2);

  root.position.y = 0.5;
  const box3 = new THREE.Box3().setFromObject(root);
  const size3 = new THREE.Vector3(); box3.getSize(size3);
  return {pre:[size.x,size.y,size.z], post:[size3.x,size3.y,size3.z], s1, s2};
}

// Build player
async function buildCharacter(self,name,skin,customUrl){
  const color = self ? 0x55ff55 : 0x5599ff;
  const base = new THREE.Group();
  const placeholder = makeCapsule(color);
  base.add(placeholder);

  // choose source: custom URL > local > CDN
  const srcs = [];
  if(customUrl && /^https?:\/\//i.test(customUrl)) srcs.push(customUrl);
  srcs.push(SKIN_LOCAL[skin]);
  srcs.push(SKIN_CDN[skin]);

  let model = null, lastErr=null, diag='';
  for(const url of srcs){
    try {
      model = await loadGLB(url);
      diag = `ok:${url}`;
      break;
    } catch(e){
      lastErr = e; diag = `fail:${url}`;
    }
  }

  if(model){
    const rep = forceVisible(model, color);
    const info = normalizeModel(model);
    base.add(model);
    placeholder.visible = false; // hide once loaded
    hud.dbgDiag.textContent = `[GLB] ${skin} replaced=${rep} pre=${info.pre.map(n=>n.toFixed(3)).join(',')} post=${info.post.map(n=>n.toFixed(3)).join(',')} s1=${info.s1.toFixed(3)} s2=${info.s2.toFixed(3)}`;
  }else{
    hud.dbgDiag.textContent = `[GLB] ${skin} failed (${diag}) • fallback capsule used`;
  }

  const lbl = document.createElement('div'); lbl.textContent=name||'??'; lbl.style.padding='2px 6px'; lbl.style.borderRadius='10px'; lbl.style.background='rgba(0,0,0,.55)'; lbl.style.fontSize='12px'; lbl.style.whiteSpace='nowrap';
  const labelObj = new CSS2DObject(lbl); labelObj.position.set(0,1.2,0); base.add(labelObj);
  base.userData.label = labelObj;
  base.userData.setTagger = (isTagger)=>{
    const col = isTagger?0xff5555:color;
    base.traverse(o=>{ if(o.isMesh && o.material && o.material.color){ o.material.color.setHex(col); } });
  };
  base.position.y = 0.5;
  return base;
}

// Players
const players=new Map(); let myId=null, roomId=null, myScore=0;
let arena={minX:-20,maxX:20,minZ:-20,maxZ:20,minY:0.5,maxY:6};

async function ensurePlayer(p){
  if(!players.has(p.id)){
    const node = await buildCharacter(p.id===myId, p.name, p.skin||'runner', settings.customGlbUrl);
    node.position.set(p.x,p.y,p.z);
    scene.add(node);
    players.set(p.id,node);
  }
  const n=players.get(p.id);
  if(n?.userData?.label?.element) n.userData.label.element.textContent=p.name;
  (n?.userData?.setTagger||(()=>{}))(p.isTagger);
}
function removePlayer(id){ const m=players.get(id); if(m){ scene.remove(m); players.delete(id); }}

// Movement
const me={ x:0,y:0.5,z:0,yaw:0, vx:0,vy:0,vz:0, speed:7, sprint:10, gravity:25, jumpVel:8, grounded:true };
const keys=new Set();
function applySkinStats(){
  const st = SKIN_STATS[settings.skin] || SKIN_STATS.runner;
  me.speed = st.speed; me.sprint = st.sprint; me.jumpVel = st.jump;
}

function isGameKey(code){ return Object.values(defaultBindings).includes(code) || Object.values(bindings).includes(code); }
function onKeyDown(e){ if(isGameKey(e.code)) e.preventDefault(); keys.add(e.code); }
function onKeyUp(e){ keys.delete(e.code); }
window.addEventListener('keydown',onKeyDown); window.addEventListener('keyup',onKeyUp);
document.addEventListener('keydown',onKeyDown); document.addEventListener('keyup',onKeyUp);
renderer.domElement.addEventListener('keydown',onKeyDown); renderer.domElement.addEventListener('keyup',onKeyUp);

// Options UI
function renderOptions(){
  document.querySelectorAll('.keybtn').forEach(btn=>{
    const a = btn.dataset.action;
    btn.textContent = bindings[a] || defaultBindings[a];
    btn.onclick = ()=>{
      btn.textContent = 'Appuie…';
      const h = (ev)=>{ ev.preventDefault(); bindings[a] = ev.code; btn.textContent = bindings[a]; document.removeEventListener('keydown', h, true); };
      document.addEventListener('keydown', h, true);
    };
  });
  hud.moveMode.value = settings.moveMode;
  hud.camSens.value = settings.camSens;
  hud.camSensVal.textContent = settings.camSens.toFixed(2);
  hud.customGlbUrl.value = settings.customGlbUrl || '';
}
function openOptions(){ hud.options.style.display='flex'; renderOptions(); }
function closeOptions(){ hud.options.style.display='none'; }
hud.openOpt.onclick = openOptions; hud.closeOpt.onclick = closeOptions;
hud.camSens.addEventListener('input', ()=>{ hud.camSensVal.textContent = Number(hud.camSens.value).toFixed(2); });

hud.resetOpt.onclick = ()=>{
  bindings = {...defaultBindings};
  settings = {...defaultSettings, skin: settings.skin}; // keep current skin
  controls.rotateSpeed = settings.camSens;
  localStorage.removeItem('ct_bindings');
  localStorage.removeItem('ct_settings');
  renderOptions();
};
hud.saveOpt.onclick = ()=>{
  settings.moveMode = hud.moveMode.value;
  settings.camSens = Number(hud.camSens.value);
  settings.customGlbUrl = hud.customGlbUrl.value.trim();
  controls.rotateSpeed = settings.camSens;
  localStorage.setItem('ct_bindings', JSON.stringify(bindings));
  localStorage.setItem('ct_settings', JSON.stringify(settings));
  hud.status.textContent = 'Options sauvegardées ✔';
  closeOptions();
};

// Controls
const controls=new OrbitControls(camera, renderer.domElement);
controls.enablePan=false; controls.enableZoom=false; controls.enableDamping=true; controls.dampingFactor=0.08;
controls.minDistance=12; controls.maxDistance=12; controls.rotateSpeed = settings.camSens;

function dirCamRelative(){
  const f=new THREE.Vector3(); camera.getWorldDirection(f); f.y=0; f.normalize();
  const r=new THREE.Vector3(f.z,0,-f.x);
  const d=new THREE.Vector3();
  if(keys.has(bindings.forward||defaultBindings.forward)) d.add(f);
  if(keys.has(bindings.back||defaultBindings.back)) d.add(f.clone().multiplyScalar(-1));
  if(keys.has(bindings.right||defaultBindings.right)) d.add(r);
  if(keys.has(bindings.left||defaultBindings.left)) d.add(r.clone().multiplyScalar(-1));
  if(d.lengthSq()>0) d.normalize();
  return d;
}

// Net & join
const socket=io(); hud.status.textContent="Connexion…";
socket.on('connect',()=>{ hud.status.textContent=`Connecté au serveur (${socket.id})`; });

const url=new URL(location.href);
const urlRoom=url.searchParams.get('room')||''; if(urlRoom) hud.roomInput.value=urlRoom;
hud.nameInput.value=localStorage.getItem('ct_name')||'';
hud.skinSelect.value = settings.skin;
hud.skinSelect.addEventListener('change', ()=>{ settings.skin = hud.skinSelect.value; hud.dbgSkin.textContent = settings.skin; applySkinStats(); localStorage.setItem('ct_settings', JSON.stringify(settings)); });

function join(){
  const name=(hud.nameInput.value||'').trim()||'Guest';
  const room=(hud.roomInput.value||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'')||'public';
  localStorage.setItem('ct_name',name);
  applySkinStats();
  socket.emit('room:join',{room,name,skin:settings.skin});
}
hud.joinBtn.addEventListener('click',e=>{e.preventDefault();join();});
document.addEventListener('keydown',e=>{if(e.code==='Enter'&&hud.lobby.style.display!=='none'){e.preventDefault();join();}});
setTimeout(()=>{ if(hud.lobby.style.display!=='none') join(); }, 1200);

setInterval(()=>socket.emit('net:ping',performance.now()),2000);
socket.on('net:pong',t=>{ hud.ping.textContent=String(Math.max(0,Math.round(performance.now()-t))); });

socket.on('world:init',async ({me:id, room, players:plist, arena:a})=>{
  myId=id; roomId=room; arena=a||arena; hud.room.textContent=roomId; hud.status.textContent=`Connecté : ${myId}`; hud.lobby.style.display='none'; hud.dbgId.textContent=myId; hud.dbgSkin.textContent=settings.skin;
  const u=new URL(location.href); u.searchParams.set('room',roomId); history.replaceState(null,'',u.toString());
  for(const p of plist){ await ensurePlayer(p); if(p.id===myId){ me.x=p.x; me.y=p.y; me.z=p.z; me.yaw=p.rotY||0; const n=players.get(myId); if(n){ controls.target.copy(n.position.clone().setY(1.2)); } } }
  renderOptions();
});

socket.on('player:join',async p=>{ await ensurePlayer(p); });
socket.on('player:leave',id=>removePlayer(id));
socket.on('world:state',list=>{ for(const p of list){ const n=players.get(p.id); if(!n) continue; n.position.lerp(new THREE.Vector3(p.x,p.y,p.z),0.35); n.rotation.y=p.rotY; (n.userData.setTagger||(()=>{}))(p.isTagger); if(p.id===myId){ myScore=p.score||0; hud.score.textContent=String(myScore); } } });

// Loop
let last=performance.now();
function tick(t){
  const dt=Math.min(0.033,(t-last)/1000); last=t;
  const n=players.get(myId);
  if(n){
    const targetSpeed = (keys.has(bindings.sprint||defaultBindings.sprint)?(me.sprint||10):(me.speed||7));
    let desired = new THREE.Vector3();

    if(settings.moveMode==='tps'){
      desired.copy( dirCamRelative().multiplyScalar(targetSpeed) );
      if(desired.lengthSq()>0.0001){
        const targetYaw=Math.atan2(desired.x,desired.z);
        me.yaw = lerpAngle(me.yaw, targetYaw, 1 - Math.pow(1 - 0.28, dt*60));
      }
    } else {
      if(keys.has(bindings.left||defaultBindings.left))  me.yaw += 3.0 * dt;
      if(keys.has(bindings.right||defaultBindings.right)) me.yaw -= 3.0 * dt;
      const forward = new THREE.Vector3(Math.sin(me.yaw),0,Math.cos(me.yaw));
      let spd = 0; if(keys.has(bindings.forward||defaultBindings.forward)) spd += targetSpeed; if(keys.has(bindings.back||defaultBindings.back)) spd -= targetSpeed;
      desired.copy(forward.multiplyScalar(spd));
    }

    const smooth = 1 - Math.pow(1 - 0.35, dt*60);
    me.vx = THREE.MathUtils.lerp(me.vx, desired.x, smooth);
    me.vz = THREE.MathUtils.lerp(me.vz, desired.z, smooth);

    if(keys.has(bindings.jump||defaultBindings.jump) && me.grounded){ me.vy=me.jumpVel; me.grounded=false; }
    me.vy -= 25 * dt;

    me.x=THREE.MathUtils.clamp(me.x + me.vx*dt, arena.minX, arena.maxX);
    me.z=THREE.MathUtils.clamp(me.z + me.vz*dt, arena.minZ, arena.maxZ);
    me.y=Math.min(arena.maxY, me.y + me.vy*dt);
    const groundY=0.5; if(me.y<=groundY){ me.y=groundY; me.vy=0; me.grounded=true; }

    n.position.set(me.x, me.y, me.z); n.rotation.y=me.yaw;
    controls.target.copy(n.position.clone().setY(1.2)); controls.rotateSpeed = settings.camSens; controls.update();
    if(t%66<16){ socket.emit('player:state',{x:me.x,y:me.y,z:me.z,rotY:me.yaw}); }
  }

  renderer.render(scene,camera); labelRenderer.render(scene,camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

addEventListener('resize',()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight); });
