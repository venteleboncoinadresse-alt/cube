import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { io } from 'https://cdn.socket.io/4.7.5/socket.io.esm.min.js';

// ===== helpers & UI =====
const TAU = Math.PI * 2;
function lerpAngle(a, b, t){ let d=((b-a+Math.PI)%TAU)-Math.PI; if(d<-Math.PI) d+=TAU; return a+d*Math.max(0,Math.min(1,t)); }
const $ = (id)=>document.getElementById(id);

const hud={ status:$("status"), room:$("room"), ping:$("ping"), score:$("score"),
  lobby:$("lobby"), nameInput:$("name"), roomInput:$("roomInput"), joinBtn:$("joinBtn"),
  openOpt:$("openOpt"), options:$("options"), closeOpt:$("closeOpt"),
  moveMode:$("moveMode"), camSens:$("camSens"), camSensVal:$("camSensVal"),
  skinSelect:$("skinSelect"), skinSelectOpt:$("skinSelectOpt"),
  charScale:$("charScale"), charScaleVal:$("charScaleVal"),
  resetOpt:$("resetOpt"), saveOpt:$("saveOpt"),
  dbg:$("debug"), roomLbl:$("room") };

const DEFAULT_BIND={ forward:'KeyZ', back:'KeyS', left:'KeyQ', right:'KeyD', jump:'Space', sprint:'ShiftLeft' };
let bindings = JSON.parse(localStorage.getItem('ct_bindings')||'null') || {...DEFAULT_BIND};
const DEFAULT_SETTINGS={ moveMode:'tps', camSens:1.0, skin:'runner', charScale:1.0 };
let settings = JSON.parse(localStorage.getItem('ct_settings')||'null') || {...DEFAULT_SETTINGS};

const DEFAULT_COLORS={ self:0x55ff55, other:0x5599ff, tag:0xff5555 };
function getColorsSafe(){ try{ const c=JSON.parse(localStorage.getItem('ct_colors')||'null'); if(c&&typeof c.self==='number'&&typeof c.other==='number'&&typeof c.tag==='number') return c; }catch{} return DEFAULT_COLORS; }
function getRoleColorHex(isTagger,isSelf){ const c=getColorsSafe(); return isTagger?c.tag:(isSelf?c.self:c.other); }

// ===== scene =====
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x101418);
const camera=new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 0.1, 200); camera.position.set(0,8,14);
const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setSize(innerWidth, innerHeight); document.body.appendChild(renderer.domElement);
renderer.domElement.setAttribute('tabindex','0'); renderer.domElement.addEventListener('pointerdown',()=>renderer.domElement.focus());
const labelRenderer=new CSS2DRenderer(); labelRenderer.setSize(innerWidth, innerHeight); labelRenderer.domElement.style.position='fixed'; labelRenderer.domElement.style.top='0'; labelRenderer.domElement.style.pointerEvents='none'; document.body.appendChild(labelRenderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff,0x1a1a1a,1.0));
const sun=new THREE.DirectionalLight(0xffffff,0.9); sun.position.set(5,12,4); scene.add(sun);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(50,50), new THREE.MeshStandardMaterial({color:0x25303a})); ground.rotation.x=-Math.PI/2; scene.add(ground);
function wall(x,z,w,h,rotY=0){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,1.5,h), new THREE.MeshStandardMaterial({color:0x3a4652})); m.position.set(x,0.75,z); m.rotation.y=rotY; scene.add(m); }
wall(0,-25,52,2); wall(0,25,52,2); wall(-25,0,2,52); wall(25,0,2,52);

// camera orbit
const controls=new OrbitControls(camera, renderer.domElement);
controls.enablePan=false; controls.enableZoom=false; controls.enableDamping=true; controls.dampingFactor=0.08;
controls.minDistance=12; controls.maxDistance=12; controls.rotateSpeed=settings.camSens;

// ===== GLB loader / normalize =====
const loader=new GLTFLoader();
const SKIN_FILES={ runner:"models/runner.glb", scout:"models/scout.glb", heavy:"models/heavy.glb" };

function tryLoadGLB(url){ return new Promise(res=>loader.load(url,(g)=>res({scene:g.scene,animations:g.animations||[]}),undefined,()=>res(null))); }
function makePlaceholder(hex){ const mat=new THREE.MeshStandardMaterial({color:hex}); const g=new THREE.Group(); const c=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,0.9,24),mat); const t=new THREE.Mesh(new THREE.SphereGeometry(0.35,24,18),mat); const b=new THREE.Mesh(new THREE.SphereGeometry(0.35,24,18),mat); t.position.y=0.45; b.position.y=-0.45; g.add(c,t,b); g.userData.isPlaceholder=true; return g; }
function forceVisible(root, tint){ let replaced=0; root.traverse(o=>{ if(o.isMesh){ o.visible=true; o.castShadow=o.receiveShadow=true; o.frustumCulled=false; const mats=Array.isArray(o.material)?o.material:[o.material]; for(const m of mats){ if(!m){ o.material=new THREE.MeshStandardMaterial({color:tint}); replaced++; continue; } m.transparent=false; m.opacity=1; m.side=THREE.DoubleSide; m.metalness=0; m.roughness=0.9; if(tint && m.color) m.color.setHex(tint); if(m.emissive) m.emissive.setHex(0x101010); } } }); return replaced; }
function centerAndNormalize(root, targetH=1.0){ const box=new THREE.Box3().setFromObject(root); const size=new THREE.Vector3(); box.getSize(size); if(size.y>0){ const center=new THREE.Vector3(); box.getCenter(center); root.position.sub(new THREE.Vector3(center.x, box.min.y, center.z)); const s1=targetH/size.y; root.scale.setScalar(s1); } root.position.y=0.5; }
function clampXZ(root, maxXZ=0.8){ const box=new THREE.Box3().setFromObject(root); const size=new THREE.Vector3(); box.getSize(size); const sx=size.x>0?(maxXZ/size.x):1; const sz=size.z>0?(maxXZ/size.z):1; const s2=Math.min(1,sx,sz); if(s2<1) root.scale.multiply(new THREE.Vector3(s2,1,s2)); }
function makeLabel(name){ const d=document.createElement('div'); d.textContent=name||'??'; d.style.padding='2px 6px'; d.style.borderRadius='10px'; d.style.background='rgba(0,0,0,.55)'; d.style.fontSize='12px'; d.style.whiteSpace='nowrap'; const obj=new CSS2DObject(d); obj.position.set(0,1.2,0); return obj; }

function setupAnimations(node, animations){
  if(!animations || !animations.length) return null;

  const mixer = new THREE.AnimationMixer(node);
  const pick = (s) => animations.find(a => (a.name||'').toLowerCase().includes(s));
  const clips = {
    idle: pick('idle') || pick('stand') || animations[0],
    walk: pick('walk') || pick('move')  || null,
    run:  pick('run')  || pick('sprint')|| null
  };

  const actions = {};
  for (const [k, c] of Object.entries(clips)) if (c) actions[k] = mixer.clipAction(c);

  let current = null;
  const fade = 0.12;

  function play(name){
    if (!actions[name]) return;
    if (current === actions[name]) return;
    if (current) current.fadeOut(fade);
    current = actions[name];
    current.reset().fadeIn(fade).play();
  }

  const api = {
    mixer,
    setSpeed: (spd, isMoving=false) => {
      const moving = isMoving || spd > 0.05;

      if (!moving) {
        // Affiche l’idle mais figée
        if (actions.idle) {
          play('idle');
          actions.idle.paused = true;      // fige
          actions.idle.time   = 0;         // sur la 1ère frame (ou mets une frame qui te plaît)
        } else {
          // si pas d’idle, on stoppe tout
          for (const a of Object.values(actions)) a.stop();
          current = null;
        }
        return;
      }

      // On bouge → défiger l’idle si besoin
      if (actions.idle) actions.idle.paused = false;

      if (spd < 2.2) {
        play('walk'); if (actions.walk) actions.walk.timeScale = THREE.MathUtils.clamp(spd/2.0, 0.6, 1.4);
      } else {
        play('run');  if (actions.run)  actions.run.timeScale  = THREE.MathUtils.clamp(spd/4.0, 0.8, 1.8);
      }
    }
  };
  return api;
}


async function buildCharacter(isSelf,name,skin='runner'){
  const baseColor=getRoleColorHex(false,isSelf);
  const root=new THREE.Group();
  const placeholder=makePlaceholder(baseColor); root.add(placeholder);
  const label=makeLabel(name); root.add(label);

  const glb=await tryLoadGLB(SKIN_FILES[skin]);
  if(!glb){ console.warn("[GLB] fail → placeholder only"); root.userData={label,placeholder, setSpeed:()=>{}, applyRoleColors:(isTagger,isSelf2)=>{ const hex=getRoleColorHex(isTagger,isSelf2); placeholder.traverse(o=>{ if(o.isMesh&&o.material&&o.material.color) o.material.color.setHex(hex); }); } }; return root; }

  const node=glb.scene;
  forceVisible(node, baseColor);
  centerAndNormalize(node, 1.0);
  clampXZ(node, 0.8);
  placeholder.visible=false;
  root.add(node);

  const anim=setupAnimations(node, glb.animations);

  // apply scale factor from settings
  const s=THREE.MathUtils.clamp(settings.charScale||1.0, 0.01, 2.0);
  root.scale.multiplyScalar(s);

  root.userData={
    label, placeholder,
    setSpeed:(spd)=>{ if(anim) anim.setSpeed(spd); },
    mixer: anim?anim.mixer:null,
    applyRoleColors:(isTagger,isSelf2)=>{ const hex=getRoleColorHex(isTagger,isSelf2); node.traverse(o=>{ if(o.isMesh&&o.material&&o.material.color) o.material.color.setHex(hex); }); }
  };
  return root;
}

// ===== players & net =====
const players=new Map(); let myId=null, roomId=null, myScore=0;
let arena={minX:-20,maxX:20,minZ:-20,maxZ:20,minY:0.5,maxY:6};

async function ensurePlayer(p){
  if(!players.has(p.id)){
    const node=await buildCharacter(p.id===myId, p.name, p.skin||'runner');
    node.position.set(p.x,p.y,p.z); scene.add(node); players.set(p.id,node);
  }
  const m=players.get(p.id);
  if(m?.userData?.label?.element) m.userData.label.element.textContent=p.name;
  if(m?.userData?.applyRoleColors) m.userData.applyRoleColors(p.isTagger, p.id===myId);
}

const socket=io(); hud.status.textContent="Connexion…";
socket.on('connect',()=>hud.status.textContent=`Connecté au serveur (${socket.id})`);

const url=new URL(location.href);
const urlRoom=url.searchParams.get('room')||''; if(urlRoom) $("roomInput").value=urlRoom;
$("name").value=localStorage.getItem('ct_name')||'';
$("skinSelect").value=settings.skin;
$("skinSelect").addEventListener('change',()=>{ settings.skin=$("skinSelect").value; });

function join(){ const name=($("name").value||'').trim()||'Guest'; const room=($("roomInput").value||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'')||'public'; localStorage.setItem('ct_name',name); socket.emit('room:join',{room,name,skin:settings.skin}); }
$("joinBtn").addEventListener('click',e=>{e.preventDefault();join();});
document.addEventListener('keydown',e=>{ if(e.code==='Enter'&&hud.lobby.style.display!=='none'){ e.preventDefault(); join(); } });

setInterval(()=>socket.emit('net:ping',performance.now()),2000);
socket.on('net:pong',t=>{ $("ping").textContent=String(Math.max(0,Math.round(performance.now()-t))); });

socket.on('world:init', async ({me:id, room, players:plist, arena:a})=>{
  myId=id; roomId=room; arena=a||arena; hud.roomLbl.textContent=roomId; hud.status.textContent=`Connecté : ${myId}`; hud.lobby.style.display='none';
  const u=new URL(location.href); u.searchParams.set('room',roomId); history.replaceState(null,'',u.toString());
  for(const p of plist){ await ensurePlayer(p); if(p.id===myId){ me.x=p.x; me.y=p.y; me.z=p.z; me.yaw=p.rotY||0; const n=players.get(myId); if(n) controls.target.copy(n.position.clone().setY(1.2)); } }
  renderOptions();
});

socket.on('player:join', async p=>{ await ensurePlayer(p); });
socket.on('player:leave', id=>{ const m=players.get(id); if(m){ scene.remove(m); players.delete(id);} });
socket.on('world:state', list=>{ for(const p of list){ const m=players.get(p.id); if(!m) continue; m.position.lerp(new THREE.Vector3(p.x,p.y,p.z),0.35); m.rotation.y=p.rotY; if(m?.userData?.applyRoleColors) m.userData.applyRoleColors(p.isTagger, p.id===myId); if(p.id===myId){ myScore=p.score||0; $("score").textContent=String(myScore); } } });

// ===== movement =====
const me={ x:0,y:0.5,z:0,yaw:0, vx:0,vy:0,vz:0, speed:7, sprint:10, gravity:25, jumpVel:8, grounded:true };
const keys=new Set();
function isGameKey(code){ return Object.values(bindings).includes(code); }
function onKeyDown(e){ if(isGameKey(e.code)) e.preventDefault(); keys.add(e.code); }
function onKeyUp(e){ keys.delete(e.code); }
addEventListener('keydown',onKeyDown); addEventListener('keyup',onKeyUp); renderer.domElement.addEventListener('keydown',onKeyDown); renderer.domElement.addEventListener('keyup',onKeyUp);

function dirCamRelative(){ const f=new THREE.Vector3(); camera.getWorldDirection(f); f.y=0; f.normalize(); const r=new THREE.Vector3(f.z,0,-f.x); const d=new THREE.Vector3(); if(keys.has(bindings.forward)) d.add(f); if(keys.has(bindings.back)) d.add(f.clone().multiplyScalar(-1)); if(keys.has(bindings.right)) d.add(r); if(keys.has(bindings.left)) d.add(r.clone().multiplyScalar(-1)); if(d.lengthSq()>0) d.normalize(); return d; }

// options UI
function renderOptions(){ $("moveMode").value=settings.moveMode; $("camSens").value=settings.camSens; $("camSensVal").textContent=String(settings.camSens.toFixed(2)); $("skinSelectOpt").value=settings.skin; $("charScale").value=settings.charScale; $("charScaleVal").textContent=String(settings.charScale.toFixed(2)); }
$("openOpt").onclick=()=>{ $("options").style.display='flex'; renderOptions(); };
$("closeOpt").onclick=()=>{ $("options").style.display='none'; };
$("camSens").addEventListener('input',()=>{ $("camSensVal").textContent=String(Number($("camSens").value).toFixed(2)); });
$("charScale").addEventListener('input',()=>{ $("charScaleVal").textContent=String(Number($("charScale").value).toFixed(2)); const self=players.get(myId); if(self){ const s=THREE.MathUtils.clamp(Number($("charScale").value),0.01,2.0); // apply live
  // reset to normalized then multiply: we can't easily re-normalize here, so scale uniformly from current
  self.scale.setScalar(s); } });
$("resetOpt").onclick=()=>{ bindings={...DEFAULT_BIND}; settings={...DEFAULT_SETTINGS}; localStorage.removeItem('ct_bindings'); localStorage.removeItem('ct_settings'); renderOptions(); };
$("saveOpt").onclick=()=>{ settings.moveMode=$("moveMode").value; settings.camSens=Number($("camSens").value); settings.skin=$("skinSelectOpt").value; settings.charScale=Number($("charScale").value); controls.rotateSpeed=settings.camSens; localStorage.setItem('ct_bindings', JSON.stringify(bindings)); localStorage.setItem('ct_settings', JSON.stringify(settings)); $("status").textContent="Options sauvegardées ✔"; $("options").style.display='none'; };

// orbit update
let showDiag=true; addEventListener('keydown',e=>{ if(e.code==='F9') showDiag=!showDiag; });

let last=performance.now();
function tick(t){
  const dt=Math.min(0.033,(t-last)/1000); last=t;
  const self=players.get(myId);
  if(self){
    const targetSpeed=keys.has(bindings.sprint)?me.sprint:me.speed;
    let desired=new THREE.Vector3();

    if(settings.moveMode==='tps'){
      desired.copy( dirCamRelative().multiplyScalar(targetSpeed) );
      if(desired.lengthSq()>0.0001){ const targetYaw=Math.atan2(desired.x,desired.z); me.yaw=lerpAngle(me.yaw,targetYaw, 1-Math.pow(1-0.28,dt*60)); }
    }else{
      if(keys.has(bindings.left)) me.yaw += 3.0*dt;
      if(keys.has(bindings.right)) me.yaw -= 3.0*dt;
      const fwd=new THREE.Vector3(Math.sin(me.yaw),0,Math.cos(me.yaw));
      let spd=0; if(keys.has(bindings.forward)) spd += targetSpeed; if(keys.has(bindings.back)) spd -= targetSpeed;
      desired.copy(fwd.multiplyScalar(spd));
    }

    // smooth velocity
    const smooth=1-Math.pow(1-0.35, dt*60);
    me.vx=THREE.MathUtils.lerp(me.vx, desired.x, smooth);
    me.vz=THREE.MathUtils.lerp(me.vz, desired.z, smooth);

    // deadzone to stop micro drift
    if(!keys.has(bindings.forward)&&!keys.has(bindings.back)&&!keys.has(bindings.left)&&!keys.has(bindings.right)){
      if(Math.hypot(me.vx,me.vz)<0.03){ me.vx=0; me.vz=0; }
    }

    if(keys.has(bindings.jump) && me.grounded){ me.vy=me.jumpVel; me.grounded=false; }
    me.vy -= 25*dt;

    me.x=THREE.MathUtils.clamp(me.x + me.vx*dt, arena.minX, arena.maxX);
    me.z=THREE.MathUtils.clamp(me.z + me.vz*dt, arena.minZ, arena.maxZ);
    me.y=Math.min(arena.maxY, me.y + me.vy*dt);
    const groundY=0.5; if(me.y<=groundY){ me.y=groundY; me.vy=0; me.grounded=true; }

    self.position.set(me.x,me.y,me.z); self.rotation.y=me.yaw;

    controls.target.copy(self.position.clone().setY(1.2));
    controls.rotateSpeed=settings.camSens; controls.update();

    const speed = Math.hypot(me.vx, me.vz);
    if(self?.userData?.setSpeed) self.userData.setSpeed(speed);

    if(t%66<16) socket.emit('player:state',{x:me.x,y:me.y,z:me.z,rotY:me.yaw});
  }

  // update mixers
  for(const n of players.values()){ if(n?.userData?.mixer) n.userData.mixer.update(dt); }

  // diag
  $("debug").style.display=showDiag?'block':'none';
  if(showDiag){ $("debug").textContent=`Ping: ${$("ping").textContent}\nScale: ${settings.charScale.toFixed(2)}\nKeys: ${[...keys].join(', ')}`; }

  renderer.render(scene,camera); labelRenderer.render(scene,camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

addEventListener('resize',()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight); });
