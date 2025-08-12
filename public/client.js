import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { io } from 'https://cdn.socket.io/4.7.5/socket.io.esm.min.js';

// ---------- Helpers & UI ----------
const $ = (id)=>document.getElementById(id);
const hud={ status:$("status"), room:$("room"), ping:$("ping"), score:$("score"),
  lobby:$("lobby"), nameInput:$("name"), roomInput:$("roomInput"), joinBtn:$("joinBtn"),
  openOpt:$("openOpt"), options:$("options"), closeOpt:$("closeOpt"),
  moveMode:$("moveMode"), camSens:$("camSens"), camSensVal:$("camSensVal"),
  resetOpt:$("resetOpt"), saveOpt:$("saveOpt"),
  sizeSlider:$("sizeSlider"), sizeVal:$("sizeVal"),
  skinSelect:$("skinSelect"),
  diag:$("diag")
};
const SCOUT_FIXED_SCALE = 0.01;

// --- Persistence (keep characters/settings) ---
const DEFAULTS_AZERTY = { forward:'Z', left:'Q', back:'S', right:'D', jump:'Space', sprint:'ShiftLeft' };
const DEFAULTS_QWERTY = { forward:'W', left:'A', back:'S', right:'D', jump:'Space', sprint:'ShiftLeft' };
const DEFAULT_SETTINGS = { moveMode:'tps', camSens:1.0, skin:'runner', size:1.0, layout:'azerty' };
const DEFAULT_COLORS = { self:0x55ff55, other:0x5599ff, tag:0xff5555 };

const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)||'null'); } catch { return null; } };
function normalizeToken(tok){
  if(!tok) return '';
  if(/^Key[A-Z]$/.test(tok)) return tok.slice(3);
  if(/^Digit[0-9]$/.test(tok)) return tok.slice(5);
  return tok;
}

let bindings = readJSON('ct_bindings') || { ...DEFAULTS_AZERTY };
for (const k of Object.keys(DEFAULTS_AZERTY)) bindings[k] = normalizeToken(bindings[k] ?? DEFAULTS_AZERTY[k]);
let settings = { ...DEFAULT_SETTINGS, ...(readJSON('ct_settings')||{}) };
let colors = readJSON('ct_colors') || DEFAULT_COLORS;

// Layout radios
document.querySelectorAll('input[name="layout"]').forEach(r=>{
  r.checked = (settings.layout === r.value);
  r.addEventListener('change', ()=>{
    settings.layout = r.value;
    if (r.value === 'azerty' && JSON.stringify(bindings) === JSON.stringify(DEFAULTS_QWERTY)) bindings = { ...DEFAULTS_AZERTY };
    if (r.value === 'qwerty' && JSON.stringify(bindings) === JSON.stringify(DEFAULTS_AZERTY)) bindings = { ...DEFAULTS_QWERTY };
    renderBindings();
  });
});

// --- Scene + Rendu haut de gamme ---
const scene=new THREE.Scene();
scene.background=new THREE.Color(0x0e1116);
scene.fog = new THREE.FogExp2(0x0e1116, 0.006);

const camera=new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 0.1, 800);
camera.position.set(0,10,18);

const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
renderer.domElement.setAttribute('tabindex','0');
renderer.domElement.addEventListener('pointerdown',()=>renderer.domElement.focus());

// Environnement HDRi virtuel (PMREM)
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

// Post-process (FXAA + Bloom)
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const fxaaPass = new ShaderPass(FXAAShader);
const pr = Math.min(devicePixelRatio, 2);
fxaaPass.material.uniforms['resolution'].value.set(1/(innerWidth*pr), 1/(innerHeight*pr));
composer.addPass(fxaaPass);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.22, 0.9, 0.9);
composer.addPass(bloomPass);

const labelRenderer=new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.position='fixed';
labelRenderer.domElement.style.top='0';
labelRenderer.domElement.style.pointerEvents='none';
document.body.appendChild(labelRenderer.domElement);

// Lights
const hemi=new THREE.HemisphereLight(0xffffff,0x2a2a2a,0.6);
scene.add(hemi);

const sun=new THREE.DirectionalLight(0xffffff,3.0);
sun.position.set(30,60,15);
sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.normalBias = 0.02;
sun.shadow.bias = -0.0001;
const d=80;
sun.shadow.camera.left=-d; sun.shadow.camera.right=d;
sun.shadow.camera.top=d; sun.shadow.camera.bottom=-d;
sun.shadow.camera.near=1; sun.shadow.camera.far=200;
scene.add(sun);

// Orbit
const controls=new OrbitControls(camera, renderer.domElement);
controls.enablePan=false; controls.enableZoom=false;
controls.enableDamping=true; controls.dampingFactor=0.08;
controls.minDistance=12; controls.maxDistance=12;
controls.rotateSpeed = settings.camSens;

// --- City (sans voitures décoratives) ---
const city = new THREE.Group();
scene.add(city);

function makeRoad(length = 1000){
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(14, length),
    new THREE.MeshStandardMaterial({color:0x2b2b2b, roughness:0.9, metalness:0.0, envMapIntensity:1.0})
  );
  road.rotation.x = -Math.PI/2; road.receiveShadow = true;
  city.add(road);

  const lineMat = new THREE.MeshStandardMaterial({color:0xf0f0f0, emissive:0x141414, roughness:0.6, metalness:0.0});
  for (let z = -length/2 + 10; z <= length/2 - 10; z += 8){
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 2), lineMat);
    seg.rotation.x = -Math.PI/2; seg.position.set(0,0.01,z);
    city.add(seg);
  }

  const sidewalkMat = new THREE.MeshStandardMaterial({color:0x7a7a7a, roughness:0.95, metalness:0.0});
  const leftWalk = new THREE.Mesh(new THREE.BoxGeometry(6,0.3,length), sidewalkMat);
  leftWalk.position.set(-10,0.15,0); leftWalk.receiveShadow = true; city.add(leftWalk);
  const rightWalk = leftWalk.clone(); rightWalk.position.x = 10; city.add(rightWalk);
}
function makeHouse(x,z, w=5, d=6, h=3, color=0xb8a48a){
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({color, roughness:0.95, metalness:0.0, envMapIntensity:0.8})
  );
  base.castShadow = true; base.receiveShadow = true;
  base.position.set(x, h/2, z);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(Math.max(w,d)*0.65, 2, 4),
    new THREE.MeshStandardMaterial({color:0x7a4f2b, roughness:0.8, metalness:0.0, envMapIntensity:0.8})
  );
  roof.position.set(x, h+1, z); roof.rotation.y = Math.PI/4; roof.castShadow = true;
  city.add(base, roof);
}

// build street (grande)
const CITY_LENGTH = 1000;
makeRoad(CITY_LENGTH);
for (let i = -CITY_LENGTH/2 + 20; i < CITY_LENGTH/2 - 20; i += 20){
  makeHouse(-18, i, 6, 8, 4, 0xc9b59a);
  makeHouse(-24, i + 10, 5, 6, 3.2, 0xaec3a1);
  makeHouse(18, i, 6, 8, 4, 0xc9b59a);
  makeHouse(24, i + 10, 5, 6, 3.2, 0xaec3a1);
}

// ground large
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(2000, 2200),
  new THREE.MeshStandardMaterial({color:0x2f3b44, roughness:0.95, metalness:0.0})
);
ground.rotation.x = -Math.PI/2; ground.position.y = -0.01; ground.receiveShadow = true; scene.add(ground);

// --- Players & GLB loading ---
const loader = new GLTFLoader();
const SKIN_FILES = { runner: "models/runner.glb", scout: "models/scout.glb", heavy: "models/heavy.glb" };
const CAR_FILE = "models/car1.glb";

// Input tokens
function tokenFromEvent(e){
  if (e.key && e.key.length === 1) {
    const ch = e.key.toUpperCase();
    if (/^[A-Z0-9]$/.test(ch)) return ch;
  }
  if (e.code === 'Space') return 'Space';
  if (e.code && (e.code.startsWith('Shift') || e.code.startsWith('Control') || e.code.startsWith('Alt'))) return e.code;
  if (e.key && /^(Arrow|Escape|Tab|Enter)/.test(e.key)) return e.key;
  return e.code || e.key || '';
}

// bindings UI
function renderBindings(){
  document.querySelectorAll('.keybtn').forEach(btn=>{
    const a = btn.dataset.action;
    btn.textContent = bindings[a];
    btn.onclick = ()=>{
      btn.textContent = 'Appuie…';
      const h = (ev)=>{ ev.preventDefault(); const tok=tokenFromEvent(ev); bindings[a]=tok; btn.textContent=tok; document.removeEventListener('keydown',h,true); };
      document.addEventListener('keydown',h,true);
    };
  });
  hud.moveMode.value = settings.moveMode;
  hud.camSens.value = settings.camSens; hud.camSensVal.textContent = String(settings.camSens.toFixed(2));
  hud.sizeSlider.value = settings.size; hud.sizeVal.textContent = settings.size.toFixed(2);
  const toHex = (n)=>'#'+n.toString(16).padStart(6,'0');
  $("colSelf").value = toHex(colors.self);
  $("colOther").value = toHex(colors.other);
  $("colTag").value = toHex(colors.tag);
}

hud.openOpt.onclick = ()=>{ hud.options.style.display='flex'; renderBindings(); };
hud.closeOpt.onclick = ()=>{ hud.options.style.display='none'; };
window.addEventListener('keydown',(e)=>{ if(e.code==='KeyO'){ hud.options.style.display = (hud.options.style.display==='flex'?'none':'flex'); if(hud.options.style.display==='flex') renderBindings(); }});
hud.camSens.addEventListener('input',()=>{ settings.camSens=Number(hud.camSens.value); hud.camSensVal.textContent=String(settings.camSens.toFixed(2)); });
hud.sizeSlider.addEventListener('input',()=>{ settings.size=Number(hud.sizeSlider.value); hud.sizeVal.textContent=settings.size.toFixed(2); const m=players.get(myId); if(m) m.scale.setScalar(settings.size); });

$("colSelf").addEventListener('input',e=>colors.self=parseInt(e.target.value.replace('#','0x')));
$("colOther").addEventListener('input',e=>colors.other=parseInt(e.target.value.replace('#','0x')));
$("colTag").addEventListener('input',e=>colors.tag=parseInt(e.target.value.replace('#','0x')));

hud.resetOpt.onclick=()=>{
  bindings = (settings.layout==='qwerty')?{...DEFAULTS_QWERTY}:{...DEFAULTS_AZERTY};
  settings = {...DEFAULT_SETTINGS, layout: settings.layout};
  colors = {...DEFAULT_COLORS};
  controls.rotateSpeed = settings.camSens;
  localStorage.removeItem('ct_bindings'); localStorage.removeItem('ct_settings'); localStorage.removeItem('ct_colors');
  renderBindings();
};
hud.saveOpt.onclick=()=>{
  localStorage.setItem('ct_bindings', JSON.stringify(bindings));
  localStorage.setItem('ct_settings', JSON.stringify(settings));
  localStorage.setItem('ct_colors', JSON.stringify(colors));
  controls.rotateSpeed = settings.camSens;
  hud.status.textContent = 'Options sauvegardées ✔';
  hud.options.style.display='none';
};

// role color
function roleColor(isTagger,isSelf){ return isTagger?colors.tag:(isSelf?colors.self:colors.other); }

// label
function makeLabel(text){ const d=document.createElement('div'); d.textContent=text||'??'; d.style.padding='2px 6px'; d.style.borderRadius='10px'; d.style.background='rgba(0,0,0,.55)'; d.style.fontSize='12px'; d.style.whiteSpace='nowrap'; const L=new CSS2DObject(d); L.position.set(0,1.2,0); return L; }

// placeholder capsule
function makeCapsule(hex){ const mat=new THREE.MeshStandardMaterial({color:hex}); const g=new THREE.Group(); const c=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,0.9,24),mat); const t=new THREE.Mesh(new THREE.SphereGeometry(0.35,24,18),mat); const b=new THREE.Mesh(new THREE.SphereGeometry(0.35,24,18),mat); t.position.y=0.45; b.position.y=-0.45; [c,t,b].forEach(m=>{m.castShadow=true;m.receiveShadow=true;}); g.add(c,t,b); return g; }

// GLB helpers
function forceVisible(root, tintHex=null){
  let replaced=0;
  root.traverse(o=>{
    if(o.isMesh){
      o.visible=true; o.castShadow=true; o.receiveShadow=true; o.frustumCulled=false;
      if(!o.material){ o.material=new THREE.MeshStandardMaterial({color:tintHex??0xffffff}); replaced++; }
      const mats = Array.isArray(o.material)?o.material:[o.material];
      for(const m of mats){
        m.transparent=false; m.opacity=1; m.side=THREE.DoubleSide; m.metalness=0; m.roughness=0.9;
        if (tintHex && m.color) m.color.setHex(tintHex);
        if (m.emissive) m.emissive.setHex(0x101010);
      }
    }
  });
  return replaced;
}
function centerAndNormalize(root, targetH=1.0){
  const box=new THREE.Box3().setFromObject(root); if(box.isEmpty()) return {pre:[0,0,0], post:[0,0,0], s1:1, s2:1};
  const size=new THREE.Vector3(); box.getSize(size); const center=new THREE.Vector3(); box.getCenter(center);
  root.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  const s1 = size.y>0 ? (targetH/size.y) : 1; root.scale.setScalar(s1); root.position.y=0.5;
  const box2=new THREE.Box3().setFromObject(root); const s2size=new THREE.Vector3(); box2.getSize(s2size);
  const sx = s2size.x>0 ? (0.8/s2size.x) : 1; const sz = s2size.z>0 ? (0.8/s2size.z) : 1;
  const s2 = Math.min(1, sx, sz); if(s2<1) root.scale.multiply(new THREE.Vector3(s2,1,s2));
  const post=new THREE.Box3().setFromObject(root); const postSize=new THREE.Vector3(); post.getSize(postSize);
  return {pre:[size.x,size.y,size.z], post:[postSize.x,postSize.y,postSize.z], s1, s2};
}

async function tryLoadGLB(url){
  return new Promise((resolve)=>{
    new GLTFLoader().load(url, (g)=>resolve(g), undefined, ()=>resolve(null));
  });
}

// players map
const players=new Map(); let myId=null, roomId=null, myScore=0;
let arena={minX:-35,maxX:35,minZ:-90,maxZ:90,minY:0.5,maxY:6};

// ------- SELF VEHICLE (car1.glb) -------
let car=null;
const carState={
  yaw:0, x:0, y:0.5, z:0,
  speed:0, steer:0,
  maxSpeed:18, accel:18, brake:28, drag:1.8,
  steerMax:0.7, steerSpeed:2.6
};
const CAR_TARGET_H = 1.2;   // normalisation hauteur
const CAR_EXTRA_SCALE = 1.2;// petit facteur visuel

async function buildCar(){
  const g = new THREE.Group();
  let glb = await tryLoadGLB(CAR_FILE);
  if(!glb){
    // fallback: simple box-car
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.6,0.6,3.2),
      new THREE.MeshStandardMaterial({color:0x3388ff, roughness:0.35, metalness:0.6, envMapIntensity:1.2})
    );
    body.castShadow=true; body.receiveShadow=true;
    g.add(body);
  } else {
    const node = glb.scene;
    forceVisible(node, null);
    centerAndNormalize(node, CAR_TARGET_H);
    node.scale.multiplyScalar(CAR_EXTRA_SCALE);
    g.add(node);
  }
  g.position.set(0, 0.5, 0);
  g.castShadow=true; g.receiveShadow=true;
  return g;
}

// ------- Characters (for OTHER players) -------
async function buildCharacter(isSelf, name, skin='runner'){
  const g = new THREE.Group();
  const tint = roleColor(false,isSelf);
  const placeholder = makeCapsule(tint);
  g.add(placeholder);
  const L = makeLabel(name); g.add(L);

  const glb = await tryLoadGLB(SKIN_FILES[skin]);
  if(!glb){
    g.userData.label=L; g.userData.placeholder=placeholder;
    g.scale.setScalar(settings.size||0.01);
    g.userData.applyRoleColors=(isTagger,isSelf2)=>{
      const hex=roleColor(isTagger,isSelf2);
      placeholder.traverse(o=>{ if(o.isMesh && o.material && o.material.color) o.material.color.setHex(hex); });
    };
    g.userData.setSpeed=()=>{};
    return g;
  }
  const node = glb.scene;
  const rep = forceVisible(node, tint);
  const norm = centerAndNormalize(node, 1.0);
  node.scale.multiplyScalar(settings.size||0.01);
  placeholder.visible=false;
  g.add(node);

  const anims = glb.animations || [];
  let mixer=null, actions={}, current=null;
  if(anims.length){
    mixer = new THREE.AnimationMixer(node);
    const pick = (s)=>anims.find(a=>(a.name||'').toLowerCase().includes(s));
    const clips = { idle: pick('idle')||pick('stand')||anims[0], walk: pick('walk')||pick('move')||null, run: pick('run')||pick('sprint')||null };
    for (const [k,c] of Object.entries(clips)) if (c) actions[k]=mixer.clipAction(c);
  }
  function play(name,fade=0.12){
    if(!actions[name]) return;
    if(current===actions[name]) return;
    if(current) current.fadeOut(fade);
    current=actions[name];
    current.reset().fadeIn(fade).play();
  }
  g.userData.setSpeed=(spd,isMoving=false)=>{
    if(!mixer){ return; }
    const moving = isMoving || spd>0.05;
    if(!moving){
      if(actions.idle){ play('idle'); actions.idle.paused=true; actions.idle.time=0; }
      else { for(const a of Object.values(actions)) a.stop(); current=null; }
      return;
    }
    if(actions.idle) actions.idle.paused=false;
    if(spd<2.2){ play('walk'); if(actions.walk) actions.walk.timeScale = THREE.MathUtils.clamp(spd/2.0,0.6,1.4); }
    else { play('run'); if(actions.run) actions.run.timeScale = THREE.MathUtils.clamp(spd/4.0,0.8,1.8); }
  };
  g.userData.mixer=mixer;
  g.userData.label=L; g.userData.placeholder=placeholder;
  g.userData.applyRoleColors=(isTagger,isSelf2)=>{
    const hex=roleColor(isTagger,isSelf2);
    node.traverse(o=>{ if(o.isMesh && o.material && o.material.color) o.material.color.setHex(hex); });
  };

  hud.diag.textContent = `[GLB] ${skin} ready`;
  return g;
}

async function ensurePlayer(p){
  // self -> car
  if(p.id===myId){
    if(!car){
      car = await buildCar();
      car.position.set(p.x,p.y,p.z);
      carState.x=p.x; carState.y=p.y; carState.z=p.z; carState.yaw=p.rotY||0;
      scene.add(car);
    }
    players.set(p.id, car);
    return;
  }
  // others -> character
  if(!players.has(p.id)){
    const n = await buildCharacter(false, p.name, p.skin||'runner');
    n.position.set(p.x,p.y,p.z);
    scene.add(n);
    players.set(p.id,n);
  }
  const m=players.get(p.id);
  if(m?.userData?.label?.element) m.userData.label.element.textContent=p.name;
  if(m?.userData?.applyRoleColors) m.userData.applyRoleColors(p.isTagger, p.id===myId);
  m.scale?.setScalar?.(settings.size||0.01);
}

// --- Movement & Input ---
const me={ x:0,y:0.5,z:0,yaw:0, vx:0,vy:0,vz:0, speed:7.5, sprint:11, gravity:25, jumpVel:8, grounded:true }; // still used for others anim
const keys=new Set();

window.addEventListener('keydown',e=>{
  const tok = tokenFromEvent(e);
  if (Object.values(bindings).includes(tok)) e.preventDefault();
  keys.add(tok);
},{passive:false});
window.addEventListener('keyup',e=>{
  keys.delete(tokenFromEvent(e));
},{passive:false});

function dirCamRelative(){
  const f=new THREE.Vector3(); camera.getWorldDirection(f); f.y=0; f.normalize();
  const r=new THREE.Vector3(f.z,0,-f.x);
  const d=new THREE.Vector3();
  const map = (settings.layout==='qwerty')?DEFAULTS_QWERTY:DEFAULTS_AZERTY;
  const fw=bindings.forward||map.forward, bk=bindings.back||map.back, lf=bindings.left||map.left, rt=bindings.right||map.right;
  if(keys.has(fw)) d.add(f);
  if(keys.has(bk)) d.add(f.clone().multiplyScalar(-1));
  if(keys.has(rt)) d.add(r);
  if(keys.has(lf)) d.add(r.clone().multiplyScalar(-1));
  if(d.lengthSq()>0) d.normalize();
  return d;
}

// --- Net join ---
const socket=io(); hud.status.textContent="Connexion…";
socket.on('connect',()=>{ hud.status.textContent=`Connecté (${socket.id})`; });

const url=new URL(location.href);
const urlRoom=url.searchParams.get('room')||''; if(urlRoom) hud.roomInput.value=urlRoom;
hud.skinSelect.value = settings.skin; // toujours là, mais la conduite utilise la voiture

function join(){
  const name=(hud.nameInput.value||'').trim()||'Guest';
  const room=(hud.roomInput.value||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'')||'public';
  localStorage.setItem('ct_settings', JSON.stringify(settings));
  socket.emit('room:join',{room,name,skin:settings.skin});
}
hud.joinBtn.addEventListener('click',e=>{e.preventDefault();join();});
document.addEventListener('keydown',e=>{ if(e.code==='Enter'&&hud.lobby.style.display!=='none'){e.preventDefault();join();}});
setInterval(()=>socket.emit('net:ping',performance.now()),2000);
socket.on('net:pong',t=>{ hud.ping.textContent=String(Math.max(0,Math.round(performance.now()-t))); });

socket.on('world:init', async ({me:id, room, players:plist, arena:a})=>{
  myId=id; roomId=room; arena=a||arena; hud.room.textContent=roomId; hud.lobby.style.display='none';
  const u=new URL(location.href); u.searchParams.set('room',roomId); history.replaceState(null,'',u.toString());
  for(const p of plist){ await ensurePlayer(p); if(p.id===myId){ carState.x=p.x; carState.y=p.y; carState.z=p.z; carState.yaw=p.rotY||0; } }
  const self=players.get(myId); if(self) controls.target.copy(self.position.clone().setY(1.2));
});
socket.on('player:join', async p=>{ await ensurePlayer(p); });
socket.on('player:leave', id=>{ const m=players.get(id); if(m){ scene.remove(m); players.delete(id); if(id===myId) car=null; } });
socket.on('world:state', list=>{
  for(const p of list){
    if(p.id===myId) continue; // self handled locally (voiture)
    const m=players.get(p.id); if(!m) continue;
    m.position.lerp(new THREE.Vector3(p.x,p.y,p.z),0.35); m.rotation.y=p.rotY;
    if(m?.userData?.applyRoleColors) m.userData.applyRoleColors(p.isTagger, p.id===myId);
    if(p.id===myId){ hud.score.textContent=String(p.score||0); }
  }
});
socket.on('tag:update', ({taggerId})=>{ hud.status.textContent = taggerId===myId ? "Tu es le CHAT ! (rouge)" : `Le chat: ${taggerId}`; });

// --- Car driving loop ---
let last=performance.now();
function tick(t){
  const dt=Math.min(0.033,(t-last)/1000); last=t;

  // Self car controls
  if(car){
    // throttle/brake
    const map = (settings.layout==='qwerty')?DEFAULTS_QWERTY:DEFAULTS_AZERTY;
    const fw=bindings.forward||map.forward, bk=bindings.back||map.back, lf=bindings.left||map.left, rt=bindings.right||map.right;
    const sprint = bindings.sprint || 'ShiftLeft';

    const maxSpeed = keys.has(sprint) ? carState.maxSpeed*1.25 : carState.maxSpeed;

    if(keys.has(fw)) carState.speed += carState.accel * dt;
    if(keys.has(bk)) carState.speed -= carState.brake * dt;

    // drag
    const drag = carState.drag * (1 + Math.min(Math.abs(carState.speed)/maxSpeed, 1)*0.6);
    if(carState.speed>0){ carState.speed = Math.max(0, carState.speed - drag*dt); }
    else if(carState.speed<0){ carState.speed = Math.min(0, carState.speed + drag*dt); }

    // clamp
    carState.speed = THREE.MathUtils.clamp(carState.speed, -maxSpeed*0.35, maxSpeed);

    // steering
    const steerTarget =
      (keys.has(lf)? +carState.steerMax : 0) +
      (keys.has(rt)? -carState.steerMax : 0);
    carState.steer = THREE.MathUtils.damp(carState.steer, steerTarget, carState.steerSpeed, dt);

    // yaw change proportional to speed
    const turnGain = THREE.MathUtils.clamp(Math.abs(carState.speed)/8, 0, 1);
    carState.yaw += carState.steer * turnGain * dt;

    // integrate
    const forward = new THREE.Vector3(Math.sin(carState.yaw),0,Math.cos(carState.yaw));
    const vx = forward.x * carState.speed * dt;
    const vz = forward.z * carState.speed * dt;

    carState.x = THREE.MathUtils.clamp(carState.x + vx, -35, 35);
    carState.z = THREE.MathUtils.clamp(carState.z + vz, -CITY_LENGTH/2 + 5, CITY_LENGTH/2 - 5);

    car.position.set(carState.x, carState.y, carState.z);
    car.rotation.y = carState.yaw;

    // camera chase (ressort)
    const camBoom = new THREE.Vector3(0, 6, 12).applyAxisAngle(new THREE.Vector3(0,1,0), -carState.yaw);
    const desiredPos = car.position.clone().add(camBoom);
    camera.position.lerp(desiredPos, 1 - Math.pow(1 - 0.18, dt*60));
    controls.target.copy(car.position.clone().setY(1.2));
    controls.rotateSpeed = settings.camSens;
    controls.update();

    // Emit state ~15Hz
    if(t%66<16){ socket.emit('player:state',{x:carState.x,y:carState.y,z:carState.z,rotY:carState.yaw}); }
  }

  // Render
  composer.render();
  labelRenderer.render(scene,camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

addEventListener('resize',()=>{
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  const pr2 = Math.min(devicePixelRatio, 2);
  fxaaPass.material.uniforms['resolution'].value.set(1/(innerWidth*pr2), 1/(innerHeight*pr2));
  labelRenderer.setSize(innerWidth, innerHeight);
});
