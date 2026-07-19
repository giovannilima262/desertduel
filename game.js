'use strict';
/* Desert Duel — walk build (novo, do zero).
   Carrega o map.json do editor e move o player com AS MESMAS regras do modo Testar:
   pisos por nível (0-5), escadas (adjacentes e multi-nível), bloqueio, ponte ligada
   a nível, e oclusão por andar (só o sprite mais à frente cobre o player).
   Combate entra depois, em cima desta fundação. */

//======================= CONFIG =======================
const MTILE = 16;                  // célula do mapa (folha de terreno é 16px)
const SPR   = 24;                  // sprite do player (folha players é 24px)
const VIEW_SCALE = 3;
const SPEED = 6.5 * MTILE;         // mesma sensação do editor: 6,5 células/s
const PLAYER_R = MTILE * 0.34;     // mesmo raio de colisão do editor

//======================= CANVAS =======================
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let VW=0, VH=0;
function resize(){ VW=canvas.width=innerWidth; VH=canvas.height=innerHeight; ctx.imageSmoothingEnabled=false; }
addEventListener('resize', resize); resize();

const overlay  = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');

//======================= ASSETS =======================
const IMG = {};
function loadImg(k,src){ return new Promise(r=>{ const i=new Image(); i.onload=()=>{IMG[k]=i;r();}; i.onerror=()=>r(); i.src=src; }); }
const MAP_SHEETS = { 0:['tiles',16], tiles:['tiles',16], interface:['interface',16],
                     players:['players',24], enemies:['enemies',24], weapons:['weapons',24] };
function blitMap(t,x,y){
  const s=MAP_SHEETS[t[0]]||MAP_SHEETS[0], img=IMG[s[0]]; if(!img) return;
  const ts=s[1]; ctx.drawImage(img, t[1]*ts, t[2]*ts, ts, ts, x, y, MTILE, MTILE);
}
function blitMapMato(t,x,y,rot){
  // Draw a tile with wind sway — pivots from bottom-center.
  // Uses a cached offscreen copy so rotation never bleeds neighbour tiles.
  const s=MAP_SHEETS[t[0]]||MAP_SHEETS[0], img=IMG[s[0]]; if(!img) return;
  const ts=s[1];
  const key=t[0]+'_'+t[1]+'_'+t[2];
  let tc=matoCache[key];
  if(!tc){
    tc=document.createElement('canvas'); tc.width=ts; tc.height=ts;
    const tctx=tc.getContext('2d'); tctx.imageSmoothingEnabled=false;
    tctx.drawImage(img, t[1]*ts, t[2]*ts, ts, ts, 0, 0, ts, ts);
    matoCache[key]=tc;
  }
  ctx.save();
  ctx.translate(x+MTILE/2, y+MTILE);
  ctx.rotate(rot);
  ctx.drawImage(tc, 0, 0, ts, ts, -MTILE/2, -MTILE, MTILE, MTILE);
  ctx.restore();
}

//======================= MAPA =======================
let MAP=null, COLS=0, ROWS=0, WORLD_W=0, WORLD_H=0;
let layers=[], coll=[], over=[], mato=[], sombra=[], matoTop={}, sombraTop={}, matoCache={};
const idx=(c,r)=>r*COLS+c;

function loadLevel(){
  COLS=MAP.cols; ROWS=MAP.rows; WORLD_W=COLS*MTILE; WORLD_H=ROWS*MTILE;
  layers = MAP.layers.filter(L=>L.type!=='image' && L.visible!==false && Array.isArray(L.tiles));
  coll = MAP.coll || new Array(COLS*ROWS).fill(0);
  over = MAP.over || new Array(COLS*ROWS).fill(0);
  mato = MAP.mato || new Array(COLS*ROWS).fill(0);
  sombra = MAP.sombra || new Array(COLS*ROWS).fill(0);
  matoCache = {};  // fresh tile cache for this level
  // Pre-compute topmost layer for mato and sombra cells
  matoTop = {}; sombraTop = {};
  for(let i=0;i<mato.length;i++){
    if(mato[i]){
      for(let li=layers.length-1;li>=0;li--){
        if(layers[li].tiles[i]){ matoTop[i]=li; break; }
      }
    }
  }
  for(let i=0;i<sombra.length;i++){
    if(sombra[i]){
      for(let li=layers.length-1;li>=0;li--){
        if(layers[li].tiles[i]){ sombraTop[i]=li; break; }
      }
    }
  }
}

//=========== colisão — regras idênticas às do editor ===========
function collInfo(v){
  if(!v) return null;
  if(v===1) return {kind:'block'};
  if(v===2) return {kind:'spawn', levels:[0]};
  if(v>=10 && v<20)  return {kind:'piso', level:v-10, levels:[v-10]};
  if(v>=20 && v<30){ const s=v-20; return {kind:'escada', levels:[s,s+1]}; }
  if(v>=100 && v<200){ const lo=((v-100)/10|0), hi=(v-100)%10;
    return {kind:'escada', levels: lo===hi?[lo]:[lo,hi]}; }
  return null;
}
function collAt(c,r){ if(c<0||r<0||c>=COLS||r>=ROWS) return 1; return coll[idx(c,r)]; }
function overAt(c,r){ if(c<0||r<0||c>=COLS||r>=ROWS) return 0; return over[idx(c,r)]; }
function bridgeActive(ov,L){ return ov>0 && (ov-1)===L; }
function coversHero(i,L){
  const ov=over[i]; if(ov>0 && (ov-1)>=L) return true;
  const ci=collInfo(coll[i]);
  if(ci && ci.kind==='piso')   return ci.level > L;
  if(ci && ci.kind==='escada') return Math.min(...ci.levels) > L;
  return false;
}
function blockNearBridge(c,r,L){
  // Returns true if this block collider is adjacent (8-way) to a bridge cell at level L.
  // Used so blocks around a bridge render on top of the player when they're on that bridge.
  for(let dr=-1; dr<=1; dr++){
    for(let dc=-1; dc<=1; dc++){
      if(dr===0 && dc===0) continue;
      if(bridgeActive(overAt(c+dc, r+dr), L)) return true;
    }
  }
  return false;
}
function playerOverlapsBridge(px, py, L){
  // Check all tile cells that the player's sprite (SPR x SPR, anchored at feet px/py-6) covers.
  // Any part of the 24px sprite touching a bridge cell at level L triggers bridge occlusion.
  const half=SPR/2;                       // 12 px
  const top=py-6-half, bot=py-6+half;     // sprite top/bottom in world coords
  const left=px-half, right=px+half;
  const c0=Math.floor(left/MTILE),  c1=Math.floor((right-0.001)/MTILE);
  const r0=Math.floor(top/MTILE),   r1=Math.floor((bot-0.001)/MTILE);
  for(let r=r0; r<=r1; r++)
    for(let c=c0; c<=c1; c++)
      if(bridgeActive(overAt(c,r), L)) return true;
  return false;
}
function playerOverlapsSombra(px, py){
  // Any part of the player's sprite touching a sombra cell?
  const half=SPR/2;
  const top=py-6-half, bot=py-6+half;
  const left=px-half, right=px+half;
  const c0=Math.floor(left/MTILE),  c1=Math.floor((right-0.001)/MTILE);
  const r0=Math.floor(top/MTILE),   r1=Math.floor((bot-0.001)/MTILE);
  for(let r=r0; r<=r1; r++)
    for(let c=c0; c<=c1; c++)
      if(sombra[idx(c,r)]) return true;
  return false;
}
function canStep(fromVal,L,toVal,toOver){
  const B=collInfo(toVal); if(B && B.kind==='block') return null;
  const A=collInfo(fromVal);
  const bridge=bridgeActive(toOver,L);
  if(B && B.kind==='escada'){ if(B.levels.includes(L)) return L; return bridge ? L : null; }
  if(B && (B.kind==='piso'||B.kind==='spawn')){
    const M = B.kind==='spawn' ? 0 : B.level;
    if(M===L) return L;
    if(A && A.kind==='escada' && A.levels.includes(L) && A.levels.includes(M)) return M;
    return bridge ? L : null;
  }
  return bridge ? L : null;
}

//======================= PLAYER =======================
const player = { x:0, y:0, L:0, skin:0, animT:0, frame:0, moving:false, flip:false };
const keys={};
addEventListener('keydown',e=>{ keys[e.key.toLowerCase()]=true; });
addEventListener('keyup',  e=>{ keys[e.key.toLowerCase()]=false; });
// Mouse tracking: canvas-relative pos + world pos (for weapon aim)
const mouse = { sx:0, sy:0, wx:0, wy:0, down:false };
canvas.addEventListener('mousemove',e=>{
  const r=canvas.getBoundingClientRect();
  mouse.sx=(e.clientX-r.left)*(canvas.width/r.width);
  mouse.sy=(e.clientY-r.top)*(canvas.height/r.height);
});
canvas.addEventListener('mousedown',()=>{ mouse.down=true; });
canvas.addEventListener('mouseup',()=>{ mouse.down=false; });
// Cursor hidden during gameplay (custom crosshair); shown on menu

// Shooting juice state
let recoilForce = 0;        // current recoil offset (decays)
let bullets = [];           // projectiles: {x,y,vx,vy,life}
let hits = [];              // impact sparks at target
let shakePhase = 0;          // screen shake damped oscillation
const FIRE_RATE = 0.18;     // seconds between shots
let fireCooldown = 0;       // time until next shot allowed

function moveAxis(nx,ny,horiz){
  const cc={c:Math.floor(player.x/MTILE), r:Math.floor(player.y/MTILE)};
  const fromVal=collAt(cc.c,cc.r);
  const lead = horiz ? {c:Math.floor((nx+Math.sign(nx-player.x)*PLAYER_R)/MTILE), r:cc.r}
                     : {c:cc.c, r:Math.floor((ny+Math.sign(ny-player.y)*PLAYER_R)/MTILE)};
  const res=canStep(fromVal, player.L, collAt(lead.c,lead.r), overAt(lead.c,lead.r));
  if(res===null) return;
  if(horiz) player.x=nx; else player.y=ny;
  const nc=Math.floor(player.x/MTILE), nr=Math.floor(player.y/MTILE);
  const nv=collInfo(collAt(nc,nr));                    // pisar num piso adota o nível — ponte ativa nunca muda
  if(!bridgeActive(overAt(nc,nr),player.L) && nv && nv.kind!=='escada')
    player.L = nv.kind==='spawn' ? 0 : nv.level;
}
function step(dt){
  let dx=0,dy=0;
  if(keys['w']||keys['arrowup'])dy--;   if(keys['s']||keys['arrowdown'])dy++;
  if(keys['a']||keys['arrowleft'])dx--; if(keys['d']||keys['arrowright'])dx++;
  player.moving=!!(dx||dy);
  if(player.moving){
    const l=Math.hypot(dx,dy), s=SPEED*dt;
    if(dx) player.flip = dx<0;
    moveAxis(player.x+dx/l*s, player.y, true);
    moveAxis(player.x, player.y+dy/l*s, false);
  }
  player.animT+=dt; player.frame = player.moving ? 1+(Math.floor(player.animT*8)%2) : 0; // frame 3 = morte, skip

  // ── Shooting ──
  fireCooldown = Math.max(0, fireCooldown - dt);
  if(mouse.down && fireCooldown <= 0 && state==='playing'){
    fireCooldown = FIRE_RATE;
    shoot();
  }
  // Decay juice
  recoilForce += (0 - recoilForce) * Math.min(1, dt*18);
  shakePhase = Math.max(0, shakePhase - dt*22);  // fast damped oscillation
  for(const b of bullets){ b.x += b.vx*dt; b.y += b.vy*dt; b.life -= dt; }
  // Spawn impact sparks at the exact crosshair target for expired bullets
  for(const b of bullets){ if(b.life<=0) spawnSparks(b.tx, b.ty); }
  bullets = bullets.filter(b => b.life > 0);
  for(const h of hits){ h.life -= dt; }
  hits = hits.filter(h => h.life > 0);

  // Camera (with damped oscillation screen shake)
  const shakeX = Math.sin(shakePhase*55)*shakePhase*1.5;
  const shakeY = Math.cos(shakePhase*67)*shakePhase*1;
  const tx=clamp(player.x-(VW/VIEW_SCALE)/2, 0, Math.max(0,WORLD_W-VW/VIEW_SCALE));
  const ty=clamp(player.y-(VH/VIEW_SCALE)/2, 0, Math.max(0,WORLD_H-VH/VIEW_SCALE));
  cam.x+=(tx-cam.x)*0.18; cam.y+=(ty-cam.y)*0.18;
  cam.x += shakeX; cam.y += shakeY;  // direct offset, returns to 0 naturally
}

function shoot(){
  recoilForce = 5;
  shakePhase = 1;
  const angle = Math.atan2(mouse.wy - (player.y-6), mouse.wx - player.x);
  const gx = player.x + Math.cos(angle)*SPR*0.45;
  const gy = player.y-6 + Math.sin(angle)*SPR*0.45;
  // Raycast: find where the bullet actually hits (wall, different floor, etc.)
  const hit = raycast(gx, gy, mouse.wx, mouse.wy, player.L);
  const dist = Math.hypot(hit.x - gx, hit.y - gy);
  const bulletSpeed = MTILE*35;
  bullets.push({
    x: gx, y: gy,
    vx: Math.cos(angle)*bulletSpeed,
    vy: Math.sin(angle)*bulletSpeed,
    tx: hit.x, ty: hit.y,
    life: dist/bulletSpeed
  });
}

// Raycast: step through cells from (x1,y1) to (x2,y2), stop at first blocking cell.
// Returns the world-position hit point. A cell blocks if the player can't walk there.
function raycast(x1, y1, x2, y2, L){
  const dx=x2-x1, dy=y2-y1;
  const steps = Math.ceil(Math.hypot(dx, dy) / (MTILE*0.5)); // half-tile steps
  for(let i=1; i<=steps; i++){
    const t = i/steps;
    const cx = Math.floor((x1 + dx*t)/MTILE);
    const cy = Math.floor((y1 + dy*t)/MTILE);
    if(blocksBullet(cx, cy, L)){
      // Back up to edge of blocking cell
      return { x: x1 + dx*(i-1)/steps, y: y1 + dy*(i-1)/steps };
    }
  }
  return { x: x2, y: y2 }; // no wall hit, reach crosshair
}
function blocksBullet(c, r, L){
  if(c<0||r<0||c>=COLS||r>=ROWS) return true;            // map edge
  const v=collAt(c,r);
  if(v===1) return true;                                   // block wall
  const ci=collInfo(v);
  if(!ci) return !bridgeActive(overAt(c,r), L);           // empty: pass only if bridge at this level
  if(ci.kind==='block') return true;
  if(ci.kind==='spawn') return L!==0;                     // pass only if on level 0
  if(ci.kind==='piso') return ci.level!==L;               // pass only if same floor
  if(ci.kind==='escada') return !ci.levels.includes(L);   // pass only if reachable
  return true;                                              // unknown = block
}
function spawnSparks(x, y){
  for(let i=0;i<4;i++){
    const a = Math.random()*6.28;
    const spd = MTILE*(3+Math.random()*6);
    hits.push({
      x, y,
      vx: Math.cos(a)*spd, vy: Math.sin(a)*spd,
      life: 0.12+Math.random()*0.08
    });
  }
}
const clamp=(v,a,b)=>v<a?a:v>b?b:v;

function findSpawn(){
  for(let i=0;i<coll.length;i++) if(coll[i]===2) return i;              // Spawn pintado
  for(let i=0;i<coll.length;i++){ const ci=collInfo(coll[i]); if(ci&&ci.kind==='piso') return i; }
  return 0;
}

//======================= RENDER =======================
let cam={x:0,y:0};
function draw(){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle='#c99a63'; ctx.fillRect(0,0,VW,VH);
  ctx.setTransform(VIEW_SCALE,0,0,VIEW_SCALE, -cam.x*VIEW_SCALE|0, -cam.y*VIEW_SCALE|0);

  // Update mouse world pos each frame (camera moves smoothly)
  mouse.wx = mouse.sx/VIEW_SCALE + cam.x;
  mouse.wy = mouse.sy/VIEW_SCALE + cam.y;

  const c0=Math.max(0,(cam.x/MTILE|0)-1), r0=Math.max(0,(cam.y/MTILE|0)-1);
  const c1=Math.min(COLS,c0+(VW/VIEW_SCALE/MTILE|0)+3), r1=Math.min(ROWS,r0+(VH/VIEW_SCALE/MTILE|0)+3);

  // 1) camadas do mapa, de baixo pra cima (mato com animacao de vento)
  const wNow = performance.now()/1000;
  for(let li=0; li<layers.length; li++){
    const L=layers[li];
    const a=(typeof L.alpha==='number')?L.alpha:1;
    if(a<1){ ctx.save(); ctx.globalAlpha=a; }
    const t=L.tiles;
    for(let r=r0;r<r1;r++){ const base=r*COLS;
      for(let c=c0;c<c1;c++){
        const i=base+c; const tt=t[i]; if(!tt) continue;
        if(matoTop[i]===li){
          const rot=Math.sin(wNow*2.0 + c*0.6 + r*0.9)*0.06;
          blitMapMato(tt, c*MTILE, r*MTILE, rot);
        } else {
          blitMap(tt, c*MTILE, r*MTILE);
        }
      }
    }
    if(a<1) ctx.restore();
  }

  // 2) player (sombra + mascote 24px, ancorado nos pés)
  ctx.fillStyle='rgba(0,0,0,0.28)';
  ctx.beginPath(); ctx.ellipse(player.x, player.y+5, 6, 2.6, 0, 0, 6.28); ctx.fill();
  if(IMG.players){
    ctx.save(); ctx.translate(player.x, player.y-6);
    if(player.flip) ctx.scale(-1,1);
    ctx.drawImage(IMG.players, player.frame*SPR, player.skin*SPR, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR);
    ctx.restore();
    // Weapon: tile [0,0] from weapons sheet, with recoil + muzzle flash
    if(IMG.weapons){
      const aimAngle = Math.atan2(mouse.wy - (player.y-6), mouse.wx - player.x);
      const recoilOff = recoilForce;  // kicks back along aim line
      const wpDist = SPR*0.35 - recoilOff;
      const wx = player.x + Math.cos(aimAngle)*wpDist;
      const wy = player.y-6 + Math.sin(aimAngle)*wpDist;
      ctx.save();
      ctx.translate(wx, wy);
      ctx.rotate(aimAngle);
      if(Math.abs(aimAngle) > Math.PI/2) ctx.scale(1, -1);
      ctx.drawImage(IMG.weapons, 0*SPR, 0*SPR, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR);
      ctx.restore();
    }
  }

  // 2.5) Bullet projectiles (custom drawn circles)
  for(const b of bullets){
    ctx.fillStyle='#1a1410';
    ctx.beginPath(); ctx.arc(b.x, b.y, 2.5, 0, 6.28); ctx.fill();
    ctx.fillStyle='#ffe875';
    ctx.beginPath(); ctx.arc(b.x, b.y, 1.8, 0, 6.28); ctx.fill();
    ctx.fillStyle='#fff';
    ctx.beginPath(); ctx.arc(b.x, b.y, 1, 0, 6.28); ctx.fill();
  }
  // Impact sparks (when bullet hits something or expires)
  for(const h of hits){
    const alpha = h.life/0.15;
    h.x += h.vx*(1/60); h.y += h.vy*(1/60);
    ctx.fillStyle=`rgba(255,200,60,${alpha})`;
    ctx.beginPath(); ctx.arc(h.x, h.y, 2.5, 0, 6.28); ctx.fill();
    ctx.fillStyle=`rgba(255,255,255,${alpha})`;
    ctx.beginPath(); ctx.arc(h.x, h.y, 1, 0, 6.28); ctx.fill();
  }

  // 3) oclusão por andar + ponte: bloqueios ao redor da ponte viram
  //    cobertura quando o player pisa nela (efeito de profundidade).
  const pci = collInfo(collAt(Math.floor(player.x/MTILE), Math.floor(player.y/MTILE)));
  const naEscada = !!(pci && pci.kind==='escada');
  // Qualquer parte do asset do player (24px) tocando a ponte ativa o efeito
  const onBridge = !naEscada && playerOverlapsBridge(player.x, player.y, player.L);
  const onSombra = playerOverlapsSombra(player.x, player.y);
  window.__occ=0; window.__esc=naEscada; window.__onBridge=onBridge; window.__onSombra=onSombra;
  if(!naEscada)
  for(let r=r0;r<r1;r++) for(let c=c0;c<c1;c++){ const i=idx(c,r);
    let cover = coversHero(i,player.L);
    if(!cover && onBridge){
      const ci=collInfo(coll[i]);
      if(ci && ci.kind==='block') cover = blockNearBridge(c, r, player.L);
    }
    if(!cover && onSombra && sombra[i]) cover = true;
    if(!cover) continue;
    for(let li=layers.length-1; li>=0; li--){ const L=layers[li];
      if(!L.tiles[i]) continue;
      const a=(typeof L.alpha==='number')?L.alpha:1;
      if(a<1){ ctx.save(); ctx.globalAlpha=a; }
      blitMap(L.tiles[i], c*MTILE, r*MTILE);
      if(a<1) ctx.restore();
      window.__occ++;
      break;
    }
  }

  // HUD
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle='rgba(30,22,18,.72)';
  roundRect(16,14,132,34,8); ctx.fill();
  ctx.fillStyle='#f4c95d'; ctx.font='bold 16px system-ui'; ctx.textAlign='left';
  ctx.fillText('Nível '+player.L, 28, 37);
  // Custom crosshair: tile [5,3] from weapons sheet, at mouse pos
  if(IMG.weapons){
    const cs=SPR*2;  // crosshair size (48px)
    ctx.drawImage(IMG.weapons, 5*SPR, 3*SPR, SPR, SPR, mouse.sx-cs/2, mouse.sy-cs/2, cs, cs);
  }
}
function roundRect(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

//======================= LOOP / FLUXO =======================
let state='menu', last=0;
function frame(t){
  const dt=Math.min(0.05,(t-last)/1000)||0; last=t;
  if(state==='playing'){ step(dt); draw(); }
  requestAnimationFrame(frame);
}
function start(){
  if(!MAP){ alert('map.json não carregou — salve o mapa no editor primeiro.'); return; }
  loadLevel();
  const s=findSpawn(), sv=collInfo(coll[s]);
  player.x=(s%COLS)*MTILE+MTILE/2; player.y=((s/COLS)|0)*MTILE+MTILE/2;
  player.L = (sv && sv.levels) ? sv.levels[0] : 0;
  cam.x=clamp(player.x-(VW/VIEW_SCALE)/2,0,Math.max(0,WORLD_W-VW/VIEW_SCALE));
  cam.y=clamp(player.y-(VH/VIEW_SCALE)/2,0,Math.max(0,WORLD_H-VH/VIEW_SCALE));
  overlay.classList.add('hidden');
  canvas.style.cursor='none';  // custom crosshair
  state='playing'; last=performance.now();
}
startBtn.addEventListener('click', start);

//======================= DEBUG (verificação) =======================
window.DBG=()=>({ state, p:{x:player.x|0,y:player.y|0,L:player.L,
  cc:Math.floor(player.x/MTILE), cr:Math.floor(player.y/MTILE)},
  cam:{x:cam.x|0,y:cam.y|0}, world:COLS+'x'+ROWS, layers:layers.length, occ:window.__occ|0, naEscada:!!window.__esc });
window.__key=(k,d)=>{ keys[k]=d; };
window.__tick=(n=1,dt=0.016)=>{ if(state!=='playing') return 'not-playing';
  for(let i=0;i<n;i++) step(dt); draw(); return window.DBG(); };
window.__place=(c,r,L)=>{ player.x=c*MTILE+MTILE/2; player.y=r*MTILE+MTILE/2; player.L=L;
  cam.x=clamp(player.x-(VW/VIEW_SCALE)/2,0,Math.max(0,WORLD_W-VW/VIEW_SCALE));
  cam.y=clamp(player.y-(VH/VIEW_SCALE)/2,0,Math.max(0,WORLD_H-VH/VIEW_SCALE)); draw(); };
window.__coll=(c,r)=>collAt(c,r); window.__over=(c,r)=>overAt(c,r);

//======================= BOOT =======================
Promise.all([
  loadImg('tiles','assets/img/tiles_packed.png'),
  loadImg('interface','assets/img/interface_packed.png'),
  loadImg('players','assets/img/players_packed.png'),
  loadImg('enemies','assets/img/enemies_packed.png'),
  loadImg('weapons','assets/img/weapons_packed.png'),
  fetch('map.json?t='+Date.now()).then(r=>r.ok?r.json():null).then(d=>{MAP=d;}).catch(()=>{MAP=null;}),
]).then(()=>{ requestAnimationFrame(frame); });
