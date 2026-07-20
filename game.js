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
  gunItems = (MAP.guns||[]).filter(g=>WEAPONS[g.t]).map(g=>({c:g.c, r:g.r, t:g.t, bob:Math.random()*6.28}));
  chests = (MAP.chests||[]).map(b=>({ c:b.c, r:b.r, v:CHEST_TILES[b.v]?b.v:1,
    items:(b.items||[]).filter(t=>WEAPONS[t]), st:'closed', t:0, loot:[] }));
  // minimapa: 1px por célula — só terreno sólido (sem sombra nem opacidade)
  miniMap = document.createElement('canvas'); miniMap.width=COLS; miniMap.height=ROWS;
  const mmc = miniMap.getContext('2d'); mmc.imageSmoothingEnabled = true;
  mmc.fillStyle='#c99a63'; mmc.fillRect(0,0,COLS,ROWS);
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const i=r*COLS+c;
    if(sombra[i]) continue;                               // sem sombra decorativa
    for(let li=layers.length-1;li>=0;li--){
      const L=layers[li]; const t=L.tiles[i]; if(!t) continue;
      if((typeof L.alpha==='number') && L.alpha<1) continue; // sem camada translúcida
      const s=MAP_SHEETS[t[0]]||MAP_SHEETS[0], img=IMG[s[0]]; if(!img) break;
      mmc.drawImage(img, t[1]*s[1], t[2]*s[1], s[1], s[1], c, r, 1, 1); break; }
  }
  // Cor dominante do minimapa — usada como fundo quando player chega nas bordas
  {
    const data = mmc.getImageData(0, 0, COLS, ROWS).data;
    const freq = {}; let best = '#c99a63', bestN = 0;
    for (let p = 0; p < data.length; p += 4) {
      const hex = '#' + [data[p], data[p+1], data[p+2]].map(v => v.toString(16).padStart(2, '0')).join('');
      freq[hex] = (freq[hex] || 0) + 1;
      if (freq[hex] > bestN) { bestN = freq[hex]; best = hex; }
    }
    miniBg = best;
  }
  // Baús bloqueiam balas e player — sempre viram block
  for(const b of chests){
    coll[b.r * COLS + b.c] = 1;
  }
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

function spriteOverlapsBridge(px, py, L){
  // Check if a SPR x SPR sprite centered at (px, py) overlaps any bridge cell
  const half=SPR/2;
  const top=py-half, bot=py+half;
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
const player = { x:0, y:0, L:0, skin:0, animT:0, frame:0, moving:false, flip:false, hp:100, armor:50,
  heading:-Math.PI/2, headingS:-Math.PI/2 };   // direção de MOVIMENTO (alvo + suavizada) — bússola/minimapa
const keys={};
addEventListener('keydown',e=>{ keys[e.key.toLowerCase()]=true;
  if(e.key==='2' && state==='playing' && medkits>0 && player.hp<100){   // slot [2]: kit médico
    medkits--; player.hp=Math.min(100, player.hp+50); chestSound();
  }
});
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

// ── ARMAS: cada uma com seu próprio recuo, cadência, spread, som e flash ──
// spr = coluna na linha 0 da folha weapons (24px). auto = segurar atira.
const WEAPONS = {
  pistola:  { nome:'Pistola',  spr:0, auto:false, rate:0.32, pellets:1, spread:0.020, recoil:2.0, shake:0.7,  speed:35, flash:0.8,
              snd:{vol:0.09, body:0.10, f1:1800, f2:200, sub:0.06} },
  magnum:   { nome:'Magnum',   spr:1, auto:false, rate:0.50, pellets:1, spread:0.012, recoil:3.6, shake:1.3,  speed:40, flash:1.1,
              snd:{vol:0.12, body:0.14, f1:1400, f2:150, sub:0.09} },
  uzi:      { nome:'Uzi',      spr:2, auto:true,  rate:0.075,pellets:1, spread:0.100, recoil:1.1, shake:0.35, speed:32, flash:0.6,
              snd:{vol:0.05, body:0.06, f1:2200, f2:400, sub:0.03} },
  sniper:   { nome:'Sniper',   spr:3, auto:false, rate:1.15, pellets:1, spread:0.000, recoil:5.5, shake:2.0,  speed:55, flash:1.5,
              snd:{vol:0.16, body:0.28, f1:900,  f2:80,  sub:0.14} },
  carabina: { nome:'Carabina', spr:4, auto:true,  rate:0.16, pellets:1, spread:0.050, recoil:1.7, shake:0.6,  speed:36, flash:0.8,
              snd:{vol:0.08, body:0.09, f1:2000, f2:300, sub:0.05} },
  fuzil:    { nome:'Fuzil',    spr:5, auto:true,  rate:0.125,pellets:1, spread:0.065, recoil:2.2, shake:0.85, speed:38, flash:0.9,
              snd:{vol:0.09, body:0.11, f1:1700, f2:250, sub:0.07} },
  smg:      { nome:'SMG',      spr:6, auto:true,  rate:0.09, pellets:1, spread:0.120, recoil:1.0, shake:0.3,  speed:30, flash:0.55,
              snd:{vol:0.045,body:0.05, f1:2400, f2:500, sub:0.025} },
  escopeta: { nome:'Escopeta', spr:7, auto:false, rate:0.90, pellets:6, spread:0.220, recoil:4.8, shake:1.7,  speed:30, flash:1.4,
              snd:{vol:0.14, body:0.20, f1:1100, f2:120, sub:0.12} },
};
let gun = 'pistola';        // arma atual do player
let gunItems = [];          // armas colocadas no cenário (vindas do editor): {c,r,t,bob}
let overlapGun = -1;        // item sob o player no frame anterior (troca só AO ENTRAR — sem flip-flop parado)
// ── BAÚS: fechado → segura E perto → carregando (treme/brilha) → aberto (armas saltam) ──
const CHEST_TILES = [ {closed:[0,12], open:[1,12]}, {closed:[2,12], open:[3,12]} ];   // laranja, dourado
const CHEST_COLORS = ['#e8845c', '#f4c95d'];  // cor do anel: [laranja, dourado]
const CHEST_RANGE = MTILE*1.7;      // distância que permite interagir
const CHEST_CHARGE = [1.2, 2.0];     // segundos para abrir: [laranja, dourado]
let chests = [];                    // {c,r,v,items,st:'closed'|'charging'|'open', t, loot:[voos]}
// ── HUD: estado do layout novo ──
let kills = 0;                      // abates (bots ainda não existem — já fica pronto)
let elapsedT = 0;                   // cronômetro da partida (chip do relógio)
let medkits = 2;                    // slot [2] — tecla 2 usa (cura 50)
let miniMap = null, miniBg = '#c99a63';     // offscreen 1px/célula + cor dominante
let swapAnim = null;         // animação de troca: {t, total} — tempo restante pro bounce
let fireLatch = false;      // semi-auto: exige soltar o clique entre tiros
let flashT = 0, flashAng = 0;  // muzzle flash

// Shooting juice state
let recoilForce = 0;        // current recoil offset (decays)
let bullets = [];           // projectiles: {x,y,vx,vy,life}
let hits = [];              // impact sparks at target
let smoke = [];             // pegadas no chão
let footprintDist = 0;       // distância acumulada para spawn de pegada
let shakePhase = 0;          // screen shake damped oscillation
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
  elapsedT += dt;
  let dx=0,dy=0;
  if(keys['w']||keys['arrowup'])dy--;   if(keys['s']||keys['arrowdown'])dy++;
  if(keys['a']||keys['arrowleft'])dx--; if(keys['d']||keys['arrowright'])dx++;
  player.moving=!!(dx||dy);
  if(player.moving){
    const l=Math.hypot(dx,dy), s=SPEED*dt;
    if(dx) player.flip = dx<0;
    player.heading = Math.atan2(dy, dx);               // direção do movimento (WASD)
    moveAxis(player.x+dx/l*s, player.y, true);
    moveAxis(player.x, player.y+dy/l*s, false);
  }
  // Suaviza heading (bússola e minimapa seguem o movimento, não o mouse)
  let hd = player.heading - player.headingS;
  hd = Math.atan2(Math.sin(hd), Math.cos(hd));          // normaliza para [-PI, PI]
  player.headingS += hd * Math.min(1, dt * 14);
  player.animT+=dt; player.frame = player.moving ? 1+(Math.floor(player.animT*8)%2) : 0; // frame 3 = morte, skip

  // ── Pegar arma do chão (troca AO ENTRAR no item; parado em cima não re-troca) ──
  let curOverlap = -1;
  for(let gi=0; gi<gunItems.length; gi++){
    const it=gunItems[gi];
    const gx=it.c*MTILE+MTILE/2, gy=it.r*MTILE+MTILE/2;
    if(Math.hypot(player.x-gx, player.y-gy) < MTILE*0.6){ curOverlap=gi; break; }
  }
  if(curOverlap!==-1 && curOverlap!==overlapGun){
    const it=gunItems[curOverlap];
    const old=gun; gun=it.t; it.t=old;                 // swap — a antiga fica no chão
    fireCooldown=0; fireLatch=false;
    pickupSound();
    // Animação de troca: bounce de escala
    swapAnim={t:0, total:0.18};
  }
  overlapGun = curOverlap;

  // ── Baús: aproximar → carrega → abre e as armas saltam ──
  for(const b of chests){
    const bx=b.c*MTILE+MTILE/2, by=b.r*MTILE+MTILE/2;
    const inRange = Math.hypot(player.x-bx, player.y-by) < CHEST_RANGE;
    if(b.st==='closed'){
      if(inRange){ b.st='charging'; b.t=0; }
    } else if(b.st==='charging'){
      if(inRange){
        b.t+=dt;
        if(b.t>=CHEST_CHARGE[b.v]){
          b.st='open'; b.t=0; chestSound();
          scatterChestLoot(b);
        }
      } else {
        b.st='closed'; b.t=0;   // saiu do alcance = reseta
      }
    } else if(b.st==='open' && b.loot.length){
      for(const f of b.loot){ f.t0+=dt;
        if(f.t0>=f.dur) gunItems.push({c:f.lc, r:f.lr, t:f.t, bob:Math.random()*6.28}); }
      b.loot=b.loot.filter(f=>f.t0<f.dur);
    }
  }

  // ── Shooting (cadência/auto por arma) ──
  const w = WEAPONS[gun];
  fireCooldown = Math.max(0, fireCooldown - dt);
  if(swapAnim){ swapAnim.t+=dt; if(swapAnim.t>=swapAnim.total) swapAnim=null; }
  // Arma tocando ponte? Trava o disparo (não o corpo do player)
  const aimAng = Math.atan2(mouse.wy - (player.y-6), mouse.wx - player.x);
  const wpd = SPR*0.35 - recoilForce;
  const weaponOnBridge = spriteOverlapsBridge(player.x + Math.cos(aimAng)*wpd, player.y-6 + Math.sin(aimAng)*wpd, player.L);
  if(mouse.down && fireCooldown <= 0 && state=="playing" && !weaponOnBridge && (w.auto || !fireLatch)){
    fireCooldown = w.rate;
    fireLatch = true;
    shoot();
  }
  if(!mouse.down) fireLatch = false;
  flashT = Math.max(0, flashT - dt);
  // Decay juice
  recoilForce += (0 - recoilForce) * Math.min(1, dt*18);
  shakePhase = Math.max(0, shakePhase - dt*22);  // fast damped oscillation
  for(const b of bullets) bulletStep(b, dt);
  // Spawn impact sparks at bullet collision point or max-range target
  for(const b of bullets){ if(b.life<=0){
    const d = Math.hypot(b.vx,b.vy)||1;
    const nx = b.tx + (b.vx/d)*MTILE*0.15;  // faísca um pouco à frente do impacto
    const ny = b.ty + (b.vy/d)*MTILE*0.15;
    spawnSparks(nx, ny, b.vx, b.vy);
  }}
  bullets = bullets.filter(b => b.life > 0);
  for(const h of hits){ h.life -= dt; }
  hits = hits.filter(h => h.life > 0);
  // Pegadas no chão — spawn a cada 12px percorridos
  if(player.moving){
    const s = SPEED*dt;
    footprintDist += s;
    if(footprintDist >= MTILE*0.75){  // uma pegada a cada ~12px
      footprintDist = 0;
      footstepSound();
      smoke.push({
        x: player.x,
        y: player.y + 2,
        life: 0.8+Math.random()*0.4,
      });
    }
  } else {
    footprintDist = MTILE*0.75;  // reset ao parar — spawn imediato ao voltar a andar
  }
  for(const s of smoke){ s.life -= dt; }
  smoke = smoke.filter(s => s.life > 0);

  // Camera (with damped oscillation screen shake)
  const shakeX = Math.sin(shakePhase*55)*shakePhase*1.5;
  const shakeY = Math.cos(shakePhase*67)*shakePhase*1;
  const tx=clamp(player.x-(VW/VIEW_SCALE)/2, 0, Math.max(0,WORLD_W-VW/VIEW_SCALE));
  const ty=clamp(player.y-(VH/VIEW_SCALE)/2, 0, Math.max(0,WORLD_H-VH/VIEW_SCALE));
  cam.x+=(tx-cam.x)*0.04; cam.y+=(ty-cam.y)*0.04;  // delay generoso — câmera bem solta
  cam.x += shakeX; cam.y += shakeY;  // direct offset, returns to 0 naturally
}

// Synth gunshot sound — layered for a punchy pixel-art feel (Web Audio, no files)
let audioCtx=null;
function gunSound(s){
  // s = perfil da arma: {vol, body, f1, f2, sub} — cada arma soa diferente
  if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  const t=audioCtx.currentTime;
  // ── Sharp attack click (firing pin) ──
  const clk=audioCtx.createOscillator(); clk.type='square'; clk.frequency.setValueAtTime(2400,t); clk.frequency.exponentialRampToValueAtTime(600,t+0.01);
  const cg=audioCtx.createGain(); cg.gain.setValueAtTime(s.vol*0.9,t); cg.gain.exponentialRampToValueAtTime(0.001,t+0.015);
  clk.connect(cg); cg.connect(audioCtx.destination);
  clk.start(t); clk.stop(t+0.015);
  // ── Noise body (the "bang") ──
  const len=s.body, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.12));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const gain=audioCtx.createGain(); gain.gain.setValueAtTime(s.vol,t); gain.gain.exponentialRampToValueAtTime(0.001,t+len);
  const bp=audioCtx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.setValueAtTime(s.f1,t); bp.frequency.exponentialRampToValueAtTime(s.f2,t+len);
  bp.Q.setValueAtTime(1.2,t);
  src.connect(bp); bp.connect(gain); gain.connect(audioCtx.destination);
  src.start(t); src.stop(t+len);
  // ── Sub punch ──
  const osc=audioCtx.createOscillator(); osc.type='sine'; osc.frequency.setValueAtTime(90,t); osc.frequency.exponentialRampToValueAtTime(25,t+0.05);
  const og=audioCtx.createGain(); og.gain.setValueAtTime(s.sub,t); og.gain.exponentialRampToValueAtTime(0.001,t+0.05);
  osc.connect(og); og.connect(audioCtx.destination);
  osc.start(t); osc.stop(t+0.05);
}
function footstepSound(){
  if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  const t=audioCtx.currentTime;
  const len=0.03, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.12));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const gain=audioCtx.createGain(); gain.gain.setValueAtTime(0.03,t); gain.gain.exponentialRampToValueAtTime(0.001,t+len);
  const lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.setValueAtTime(300,t);
  src.connect(lp); lp.connect(gain); gain.connect(audioCtx.destination);
  src.start(t); src.stop(t+len);
}
function pickupSound(){
  if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  const t=audioCtx.currentTime;
  // Click metálico (armar)
  const clk=audioCtx.createOscillator(); clk.type='square'; clk.frequency.setValueAtTime(800,t); clk.frequency.exponentialRampToValueAtTime(200,t+0.04);
  const cg=audioCtx.createGain(); cg.gain.setValueAtTime(0.05,t); cg.gain.exponentialRampToValueAtTime(0.001,t+0.05);
  clk.connect(cg); cg.connect(audioCtx.destination);
  clk.start(t); clk.stop(t+0.05);
  // Ruído mecânico (corrediça)
  const len=0.06, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.1));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const gain=audioCtx.createGain(); gain.gain.setValueAtTime(0.04,t); gain.gain.exponentialRampToValueAtTime(0.001,t+len);
  const hp=audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.setValueAtTime(2000,t);
  src.connect(hp); hp.connect(gain); gain.connect(audioCtx.destination);
  src.start(t); src.stop(t+len);
}
function chestSound(){
  // chime subindo + pop — sinal de loot
  if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  const t=audioCtx.currentTime;
  [[520,0],[780,0.07],[1040,0.14]].forEach(([f,d])=>{
    const o=audioCtx.createOscillator(); o.type='triangle'; o.frequency.setValueAtTime(f,t+d);
    const g=audioCtx.createGain(); g.gain.setValueAtTime(0.0001,t+d);
    g.gain.exponentialRampToValueAtTime(0.09,t+d+0.02); g.gain.exponentialRampToValueAtTime(0.001,t+d+0.18);
    o.connect(g); g.connect(audioCtx.destination); o.start(t+d); o.stop(t+d+0.2);
  });
}
function scatterChestLoot(b){
  const bx = b.c*MTILE+MTILE/2, by = b.r*MTILE+MTILE/2;
  const dirs = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  let di = 0;
  for(let k=0;k<b.items.length;k++){
    let lc=b.c, lr=b.r+1;                                       // fallback: logo abaixo
    while(di<dirs.length){ const cc=b.c+dirs[di][0], rr=b.r+dirs[di][1]; di++;
      const ci=collInfo(collAt(cc,rr));
      if(!(ci&&ci.kind==='block')){ lc=cc; lr=rr; break; } }
    b.loot.push({ t:b.items[k], t0:0, dur:0.38+k*0.09,
      x0:bx, y0:by-4, x1:lc*MTILE+MTILE/2, y1:lr*MTILE+MTILE/2, lc, lr });
  }
  b.items = [];
}
function shoot(){
  const w = WEAPONS[gun];
  recoilForce = w.recoil;
  shakePhase = w.shake;
  gunSound(w.snd);
  const angle = Math.atan2(mouse.wy - (player.y-6), mouse.wx - player.x);
  flashT = 0.05; flashAng = angle;
  const gx = player.x + Math.cos(angle)*SPR*0.45;
  const gy = player.y-6 + Math.sin(angle)*SPR*0.45;
  const aimDist = Math.max(MTILE*2, Math.hypot(mouse.wx-gx, mouse.wy-gy));
  const bulletSpeed = MTILE*w.speed;
  for(let p=0;p<w.pellets;p++){
    const a = angle + (Math.random()*2-1)*w.spread;          // spread por projétil
    const txw = gx + Math.cos(a)*aimDist, tyw = gy + Math.sin(a)*aimDist;
    bullets.push({
      x: gx, y: gy,
      vx: Math.cos(a)*bulletSpeed,
      vy: Math.sin(a)*bulletSpeed,
      tx: txw, ty: tyw,
      level: player.L,
      life: aimDist/bulletSpeed,
      w: gun
    });
  }
}

// Raycast: step cell-by-cell from (x1,y1) to (x2,y2), tracking level changes
// through stairs. Returns the world hit point and the bullet's level at impact.
function raycast(x1, y1, x2, y2, startL){
  const dx=x2-x1, dy=y2-y1, dist=Math.hypot(dx,dy);
  if(dist<0.01) return {x:x2,y:y2,L:startL};
  const steps=Math.ceil(dist/(MTILE*0.4));  // fine steps
  let curL=startL, lastX=x1, lastY=y1;
  let prevC=Math.floor(x1/MTILE), prevR=Math.floor(y1/MTILE);
  for(let i=1;i<=steps;i++){
    const t=i/steps;
    const px=x1+dx*t, py=y1+dy*t;
    const cx=Math.floor(px/MTILE), cy=Math.floor(py/MTILE);
    if(cx!==prevC||cy!==prevR){  // entered new cell
      const ci=collInfo(collAt(cx,cy));
      // Wall blocks at any level
      if(ci&&ci.kind==='block') return {x:lastX,y:lastY,L:curL};
      // Map edge
      if(cx<0||cy<0||cx>=COLS||cy>=ROWS) return {x:lastX,y:lastY,L:curL};
      // Floor/spawn: pass if same level OR shooting down from higher level
      const ov=overAt(cx,cy);
      if(bridgeActive(ov,curL)){ /* pass, level stays */ }
      else if(ci&&(ci.kind==='piso'||ci.kind==='spawn')){
        const cellL=ci.kind==='spawn'?0:ci.level;
        if(cellL>curL) return {x:lastX,y:lastY,L:curL};     // shooting UP to higher floor = hit
        // cellL <= curL: same level or shooting down = pass, adopt the lower level
        curL = cellL;
      }
      // Stair: can change level to the other end of the stair
      else if(ci&&ci.kind==='escada'){
        if(!ci.levels.includes(curL)) return {x:lastX,y:lastY,L:curL};  // unreachable
        // Adopt the other level if stair connects two
        if(ci.levels.length===2) curL=ci.levels[0]===curL?ci.levels[1]:ci.levels[0];
      }
      // Empty + no bridge = hit (void)
      else if(!ci) return {x:lastX,y:lastY,L:curL};
      prevC=cx; prevR=cy;
    }
    lastX=px; lastY=py;
  }
  return {x:x2,y:y2,L:curL};  // reached crosshair
}
function spawnSparks(x, y, vx, vy){
  const baseAng = Math.atan2(vy, vx) + Math.PI;  // direção contrária à bala (rebate)
  for(let i=0;i<8;i++){
    const a = baseAng + (Math.random()*2-1)*0.7; // cone mais aberto de ±40°
    const spd = MTILE*(3+Math.random()*5);
    const len = MTILE*(0.1+Math.random()*0.2);   // riscos bem mais curtos
    hits.push({
      x, y,
      vx: Math.cos(a)*spd, vy: Math.sin(a)*spd,
      len, ang: a,
      life: 0.08+Math.random()*0.06,
    });
  }
}
// ── Arma: sem colisão, atravessa tudo (a ponte só barra o disparo e cobre visualmente) ──
function weaponDist(px, py, angle, maxDist){
  return maxDist;
}

// ── Colisão per-frame das balas: atravessa tudo, só para em pontes e bordas ──
function bulletStep(b, dt){
  if(b.life <= 0) return;

  const prevX = b.x, prevY = b.y;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.life -= dt;

  if(b.life <= 0){
    b.tx = b.x; b.ty = b.y;                             // faísca na posição atual
    return;
  }

  // Borda do mapa
  const cx = Math.floor(b.x / MTILE), cy = Math.floor(b.y / MTILE);
  if(cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS){
    b.x = prevX; b.y = prevY; b.tx = prevX; b.ty = prevY; b.life = 0; return;
  }

  // Colisão com bloqueio (coll=1)
  const ci = collInfo(collAt(cx, cy));
  if(ci && ci.kind === 'block'){
    b.x = prevX; b.y = prevY; b.tx = prevX; b.ty = prevY; b.life = 0; return;
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


  // 1.8) pegadas no chão
  for(const s of smoke){
    const alpha = s.life/0.8*0.14;
    ctx.fillStyle=`rgba(60,40,20,${alpha})`;
    ctx.beginPath();
    ctx.arc(s.x-2, s.y, MTILE*0.10, 0, 6.28);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x+2, s.y, MTILE*0.08, 0, 6.28);
    ctx.fill();
  }
  // 1.9) baús — sempre atrás do player
  if(IMG.tiles){
    const tNow2 = performance.now()/1000;
    for(const b of chests){
      if(b.c<c0-1||b.c>=c1||b.r<r0-1||b.r>=r1) continue;
      const v=CHEST_TILES[b.v];
      const sp=(b.st==='open')?v.open:v.closed;
      ctx.drawImage(IMG.tiles, sp[0]*16, sp[1]*16, 16, 16, b.c*MTILE, b.r*MTILE, MTILE, MTILE);
    }
  }

  // 2) player (sombra + mascote 24px, ancorado nos pés)
	  ctx.fillStyle='rgba(0,0,0,0.28)';
	  ctx.beginPath(); ctx.ellipse(player.x, player.y+5, 6, 2.6, 0, 0, 6.28); ctx.fill();
	  if(IMG.players){
	    ctx.save(); ctx.translate(player.x, player.y-6);
	    if(player.flip) ctx.scale(-1,1);
	    ctx.drawImage(IMG.players, player.frame*SPR, player.skin*SPR, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR);
	    ctx.restore();
	  }

	  // ── Oclusão / Arma / Balas ──
	  const pci = collInfo(collAt(Math.floor(player.x/MTILE), Math.floor(player.y/MTILE)));
	  const naEscada = !!(pci && pci.kind==='escada');
	  const onBridge = !naEscada && playerOverlapsBridge(player.x, player.y, player.L);
	  const onSombra = playerOverlapsSombra(player.x, player.y);
	  window.__occ=0; window.__esc=naEscada; window.__onBridge=onBridge; window.__onSombra=onSombra;
	  // Arma tocando ponte? (usado pra ordem de renderização)
	  let _weaponOnBridge = false;
	  if(IMG.players && IMG.weapons){
	    const _wDef = WEAPONS[gun];
	    const _aimAngle = Math.atan2(mouse.wy - (player.y-6), mouse.wx - player.x);
	    const _wpDist = Math.min(SPR*0.35 - recoilForce, weaponDist(player.x, player.y-6, _aimAngle, SPR*0.35));
	    const _wx = player.x + Math.cos(_aimAngle)*_wpDist;
	    const _wy = player.y-6 + Math.sin(_aimAngle)*_wpDist;
	    _weaponOnBridge = spriteOverlapsBridge(_wx, _wy, player.L);
	  }

	  const _drawWeapon = () => {
	    const _wDef = WEAPONS[gun];
	    const _aimAngle = Math.atan2(mouse.wy - (player.y-6), mouse.wx - player.x);
	    const _wpDist = Math.min(SPR*0.35 - recoilForce, weaponDist(player.x, player.y-6, _aimAngle, SPR*0.35));
	    const _wx = player.x + Math.cos(_aimAngle)*_wpDist;
	    const _wy = player.y-6 + Math.sin(_aimAngle)*_wpDist;
	    ctx.save();
	    ctx.translate(_wx, _wy);
	    ctx.rotate(_aimAngle);
	    if(Math.abs(_aimAngle) > Math.PI/2) ctx.scale(1, -1);
	    // Bounce de escala na troca de arma
	    // começa pequeno, cresce com overshoot
	    if(swapAnim){ const bt=swapAnim.t/swapAnim.total; const bs=0.5+0.5*bt+Math.sin(bt*Math.PI)*0.3*(1-bt); ctx.scale(bs,bs); }
	    ctx.drawImage(IMG.weapons, _wDef.spr*SPR, 0*SPR, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR);
	    ctx.restore();
	    if(flashT > 0){
	      const fs = _wDef.flash * 6;
	      const fx = player.x + Math.cos(flashAng)*(_wpDist + SPR*0.5);
	      const fy = player.y-6 + Math.sin(flashAng)*(_wpDist + SPR*0.5);
	      ctx.save(); ctx.translate(fx, fy); ctx.rotate(flashAng);
	      ctx.globalAlpha = Math.min(1, flashT/0.05);
	      ctx.fillStyle='#ffd97a';
	      ctx.beginPath();
	      ctx.moveTo(fs*1.6, 0); ctx.lineTo(fs*0.35, fs*0.5); ctx.lineTo(-fs*0.2, 0); ctx.lineTo(fs*0.35, -fs*0.5);
	      ctx.closePath(); ctx.fill();
	      ctx.fillStyle='#fff6d8';
	      ctx.beginPath(); ctx.arc(fs*0.25, 0, fs*0.32, 0, 6.28); ctx.fill();
	      ctx.restore(); ctx.globalAlpha=1;
	    }
	  };

	  // Se arma toca ponte, renderiza atrás de tudo (antes da oclusão de piso)
	  if(_weaponOnBridge) _drawWeapon();

	  // 3a) oclusão por piso/escada/sombra (arma e balas ficam na frente disto)
	  if(!naEscada)
	  for(let r=r0;r<r1;r++) for(let c=c0;c<c1;c++){ const i=idx(c,r);
	    const ci=collInfo(coll[i]);
	    let cover = false;
	    if(ci && ci.kind==='piso')   cover = ci.level > player.L;
	    if(ci && ci.kind==='escada') cover = Math.min(...ci.levels) > player.L;
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

  // 3a.5) armas no chão — na frente dos pisos
  if(IMG.weapons){
    const wNow2 = performance.now()/1000;
    for(const it of gunItems){
      if(it.c<c0-1||it.c>=c1||it.r<r0-1||it.r>=r1) continue;
      const w=WEAPONS[it.t]; if(!w) continue;
      const gx=it.c*MTILE, gy=it.r*MTILE + Math.sin(wNow2*3+it.bob)*1.5;
      ctx.fillStyle='rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(it.c*MTILE+MTILE/2, it.r*MTILE+MTILE*0.85, MTILE*0.34, MTILE*0.13, 0, 0, 6.28); ctx.fill();
      ctx.drawImage(IMG.weapons, w.spr*SPR, 0, SPR, SPR, gx-(SPR-MTILE)/2, gy-(SPR-MTILE)/2-2, SPR, SPR);
    }
  }

  // helper: renderiza UM baú (sprite + loading ring + loot voando)
  const _drawChest = (b) => {
    const v=CHEST_TILES[b.v];
    const cx = b.c*MTILE+MTILE/2, cy = b.r*MTILE+MTILE/2;
    // Barra de carregamento na parte superior do baú
    if(b.st==='charging'){
      const p = Math.min(1, b.t/CHEST_CHARGE[b.v]);    // progresso 0→1
      const bw = MTILE - 2, bh = 3;                    // tamanho da barra
      const bx = b.c*MTILE + 1, by = b.r*MTILE - 5;    // acima do baú
      ctx.save();
      // fundo da barra (cinza escuro)
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx, by, bw, bh);
      // preenchimento (cor do baú)
      ctx.fillStyle = CHEST_COLORS[b.v];
      ctx.fillRect(bx, by, bw * p, bh);
      ctx.restore();
    }
    if(IMG.weapons) for(const f of b.loot){
      const k=Math.min(1, f.t0/f.dur);
      const fx=f.x0+(f.x1-f.x0)*k, fy=f.y0+(f.y1-f.y0)*k - Math.sin(Math.PI*k)*12;
      const sc=0.7+0.3*Math.sin(Math.PI*k);
      const w=WEAPONS[f.t];
      ctx.save(); ctx.translate(fx,fy); ctx.rotate(Math.sin(k*6.28)*0.4); ctx.scale(sc,sc);
      ctx.drawImage(IMG.weapons, w.spr*SPR, 0, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR); ctx.restore();
    }
  };

  const tNow = performance.now()/1000;
  // 3a.6) baús — sempre atrás de tudo
  if(IMG.tiles){
    for(const b of chests){
      if(b.c<c0-1||b.c>=c1||b.r<r0-1||b.r>=r1) continue;
      _drawChest(b);
    }
  }

  // 3b) Arma na mão — na frente dos pisos (se não estiver tocando ponte)
	  if(!_weaponOnBridge && IMG.players && IMG.weapons) _drawWeapon();

	  // 3c) oclusão por ponte (cobre a arma, balas ficam na frente)
	  if(!naEscada)
	  for(let r=r0;r<r1;r++) for(let c=c0;c<c1;c++){ const i=idx(c,r);
	    const ov=over[i];
	    let cover = (ov>0 && (ov-1)>=player.L);
	    if(!cover && onBridge){
	      const ci=collInfo(coll[i]);
	      if(ci && ci.kind==='block') cover = blockNearBridge(c, r, player.L);
	    }
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

	  
// 3d) Balas e sparks — na frente de tudo
	  if(IMG.interface){
	    for(const b of bullets){
	      const ang = Math.atan2(b.vy, b.vx);
	      const isShotgun = b.w === 'escopeta';
	      // Ambas usam a bala amarela (4,3). Escopeta com pellet menor.
	      const tileCol = 4;
	      const tileRow = 3;
	      const bs = isShotgun ? MTILE * 0.3 : MTILE * 0.5;  // pellet miúdo vs bala normal
	      ctx.save();
	      ctx.translate(b.x, b.y);
	      ctx.rotate(ang + Math.PI/2);  // ponta da bala aponta na direção do voo
	      if(!isShotgun) ctx.scale(0.7, 1.3);  // bala fina e alongada
	      ctx.drawImage(IMG.interface, tileCol*16, tileRow*16, 16, 16, -bs/2, -bs/2, bs, bs);
	      ctx.restore();
	    }
	  } else {
	    // Fallback: simple circles
	    for(const b of bullets){
	      ctx.fillStyle='#2a2218';
	      ctx.beginPath(); ctx.arc(b.x, b.y, 2.2, 0, 6.28); ctx.fill();
	      ctx.fillStyle='#f0e8d8';
	      ctx.beginPath(); ctx.arc(b.x, b.y, 1, 0, 6.28); ctx.fill();
	    }
	  }
	  for(const h of hits){
	    h.x += h.vx*(1/60); h.y += h.vy*(1/60);
	    const alpha = h.life/0.14;
	    ctx.strokeStyle=`rgba(245,235,215,${alpha})`;
	    ctx.lineWidth = 1;
	    ctx.beginPath();
	    ctx.moveTo(h.x, h.y);
	    ctx.lineTo(h.x - Math.cos(h.ang)*h.len, h.y - Math.sin(h.ang)*h.len);
	    ctx.stroke();
	    ctx.strokeStyle=`rgba(255,252,245,${alpha*0.8})`;
	    ctx.lineWidth = 0.5;
	    ctx.beginPath();
	    ctx.moveTo(h.x, h.y);
	    ctx.lineTo(h.x - Math.cos(h.ang)*h.len*0.6, h.y - Math.sin(h.ang)*h.len*0.6);
	    ctx.stroke();
  }
  // ── Seta acima do player (na frente de tudo) ──
  const ax = player.x, ay = player.y - SPR*0.7;
  const s = MTILE*0.16;
  const bob = Math.sin(performance.now()/1000*3) * 1.5;
  ctx.fillStyle='#4c3';
  ctx.strokeStyle='#1a3a10';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(ax, ay + s + bob);
  ctx.lineTo(ax - s, ay - s*0.5 + bob);
  ctx.lineTo(ax + s, ay - s*0.5 + bob);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();


  // ═══════════ HUD (barras+kills · minimapa+bússola+chips · slots) ═══════════
  ctx.setTransform(1,0,0,1,0,0);
  drawBars();
  drawMinimap();
  drawSlots();

  // Custom crosshair (por cima de tudo)
  if(IMG.weapons){
    const cs=SPR*2;
    ctx.drawImage(IMG.weapons, 5*SPR, 3*SPR, SPR, SPR, mouse.sx-cs/2, mouse.sy-cs/2, cs, cs);
  }
}

//======================= HUD (layout novo) =======================
function hudBar(x,y,w,h,val,max,cor,icone,corBadge){
  ctx.fillStyle='rgba(13,22,19,.85)'; roundRect(x+h*0.5,y,w,h,h/2); ctx.fill();
  ctx.strokeStyle='rgba(230,240,235,.35)'; ctx.lineWidth=1.5; roundRect(x+h*0.5,y,w,h,h/2); ctx.stroke();
  const pad=3, fw=(w-pad*2)*Math.max(0,Math.min(1,val/max));
  if(fw>3){ ctx.fillStyle=cor; roundRect(x+h*0.5+pad,y+pad,fw,h-pad*2,(h-pad*2)/2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.20)'; roundRect(x+h*0.5+pad,y+pad,fw,(h-pad*2)*0.45,(h-pad*2)/2); ctx.fill(); }
  ctx.fillStyle='#fff'; ctx.font='bold '+Math.round(h*0.5)+'px system-ui';
  ctx.textAlign='right'; ctx.textBaseline='middle';
  ctx.fillText((val|0)+'/'+max, x+h*0.5+w-12, y+h/2+1);
  const bx=x+h*0.25, by=y+h/2;                                 // badge circular à esquerda
  ctx.fillStyle='#0f1d18'; ctx.beginPath(); ctx.arc(bx,by,h*0.72,0,6.28); ctx.fill();
  ctx.strokeStyle=corBadge; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(bx,by,h*0.72,0,6.28); ctx.stroke();
  ctx.fillStyle=corBadge; ctx.font='bold '+Math.round(h*0.8)+'px system-ui'; ctx.textAlign='center';
  ctx.fillText(icone, bx, by+1);
}
function drawBars(){
  const X=22, Y=20, W=280, H=26;
  hudBar(X, Y, W, H, player.hp, 100, '#e33b2f', '♥', '#e8483a');
  hudBar(X, Y+H+12, W*0.76, H*0.88, player.armor, 100, '#8fd132', '✚', '#79bd22');
  const kY=Y+H+12+H*0.88+14, kW=128, kH=52;                    // painel KILLS
  ctx.fillStyle='rgba(13,22,19,.85)'; roundRect(X,kY,kW,kH,10); ctx.fill();
  ctx.strokeStyle='rgba(230,240,235,.35)'; ctx.lineWidth=1.5; roundRect(X,kY,kW,kH,10); ctx.stroke();
  ctx.font='24px system-ui'; ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText('💀', X+12, kY+kH/2+1);
  ctx.fillStyle='rgba(220,230,225,.75)'; ctx.font='bold 11px system-ui';
  ctx.fillText('KILLS', X+50, kY+16);
  ctx.fillStyle='#fff'; ctx.font='bold 20px system-ui';
  ctx.fillText(''+kills, X+50, kY+37);
}
function drawMinimap(){
  const R=64, cx=VW-R-28, cy=R+26;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx,cy,R,0,6.28); ctx.clip();
  ctx.fillStyle=miniBg; ctx.fillRect(cx-R,cy-R,R*2,R*2);
  if(miniMap){
    const z=3, pc=player.x/MTILE, pr=player.y/MTILE;
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(miniMap, cx-pc*z, cy-pr*z, COLS*z, ROWS*z);
    ctx.fillStyle='#f2c14e';                                   // baús fechados = pontos dourados
    for(const b of chests){ if(b.st!=='open')
      ctx.fillRect(cx+(b.c+0.5-pc)*z-2, cy+(b.r+0.5-pr)*z-2, 4, 4); }
  }
  ctx.restore();
  ctx.strokeStyle='rgba(235,240,238,.55)'; ctx.lineWidth=3;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,6.28); ctx.stroke();
  ctx.strokeStyle='rgba(10,16,14,.8)'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.arc(cx,cy,R+2.5,0,6.28); ctx.stroke();
  // ═══════════ Bússola fixa ao redor do minimapa (N sempre no topo) ═══════════
  const ringIn = R + 5, ringOut = R + 16, ringMid = (ringIn + ringOut) / 2;
  {
    ctx.save();
    // Fundo escuro só na borda (aro fino)
    ctx.strokeStyle = 'rgba(13,20,17,.65)';
    ctx.lineWidth = ringOut - ringIn;
    ctx.beginPath(); ctx.arc(cx, cy, ringMid, 0, 6.28); ctx.stroke();
    // Borda interna e externa sutis
    ctx.strokeStyle = 'rgba(235,240,238,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, ringIn, 0, 6.28); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, ringOut, 0, 6.28); ctx.stroke();

    const cardLabels = {0:'N', 90:'E', 180:'S', 270:'W'};
    for (let d = 0; d < 360; d += 15) {
      const isCardinal = d % 90 === 0;
      const a = d * Math.PI / 180 - Math.PI / 2;   // fixo: N=topo, E=direita, S=baixo, W=esquerda
      if (isCardinal) {
        // Label no meio do anel
        const lx = cx + Math.cos(a) * ringMid;
        const ly = cy + Math.sin(a) * ringMid;
        ctx.fillStyle = d === 0 ? '#f2c14e' : '#fff';
        ctx.font = 'bold 12px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cardLabels[d], lx, ly);
      } else {
        // Traço só onde não tem letra
        const tInner = ringIn + 3;
        const tOuter = ringOut - 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * tInner, cy + Math.sin(a) * tInner);
        ctx.lineTo(cx + Math.cos(a) * tOuter, cy + Math.sin(a) * tOuter);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  const ang=player.headingS;                                      // seta do player (direção do movimento)
  ctx.save(); ctx.translate(cx,cy); ctx.rotate(ang+Math.PI/2);
  ctx.fillStyle='#fff'; ctx.strokeStyle='#1a2420'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,-9); ctx.lineTo(-5.5,6); ctx.lineTo(0,2.5); ctx.lineTo(5.5,6);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
  // chips: relógio + jogadores
  const chH=32, chY=cy+ringOut+12;
  const mm=String(Math.floor(elapsedT/60)).padStart(2,'0'), ss=String(Math.floor(elapsedT%60)).padStart(2,'0');
  hudChip(cx+R-64, chY, 64, chH, '👤', '1');
  hudChip(cx+R-64-8-104, chY, 104, chH, '🕐', mm+':'+ss);
}
function hudChip(x,y,w,h,icone,txt){
  ctx.fillStyle='rgba(13,22,19,.85)'; roundRect(x,y,w,h,8); ctx.fill();
  ctx.strokeStyle='rgba(230,240,235,.35)'; ctx.lineWidth=1.5; roundRect(x,y,w,h,8); ctx.stroke();
  ctx.font='15px system-ui'; ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText(icone, x+9, y+h/2+1);
  ctx.fillStyle='#fff'; ctx.font='bold 15px system-ui';
  ctx.fillText(txt, x+32, y+h/2+1);
}
function hudSlot(x,y,num,ativo){
  ctx.fillStyle='rgba(13,22,19,.85)'; roundRect(x,y,96,78,12); ctx.fill();
  ctx.strokeStyle=ativo?'rgba(242,193,78,.85)':'rgba(235,240,238,.35)'; ctx.lineWidth=ativo?2:1.5;
  roundRect(x,y,96,78,12); ctx.stroke();
  ctx.fillStyle='#f2c14e'; roundRect(x+6,y+6,18,18,4); ctx.fill();
  ctx.fillStyle='#3a2c10'; ctx.font='bold 12px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(num, x+15, y+16);
}
function drawSlots(){
  const sw=96, sh=78, gap=10, x0=VW/2-(sw*2+gap)/2, y0=VH-sh-18;
  hudSlot(x0, y0, '1', true);
  hudSlot(x0+sw+gap, y0, '2', false);
  ctx.imageSmoothingEnabled=false;
  if(IMG.weapons) ctx.drawImage(IMG.weapons, WEAPONS[gun].spr*SPR,0, SPR,SPR, x0+sw/2-22, y0+6, 44,44);
  ctx.fillStyle='#fff'; ctx.font='bold 14px system-ui'; ctx.textAlign='center'; ctx.textBaseline='alphabetic';
  ctx.fillText('∞', x0+sw/2-12, y0+sh-11);
  ctx.fillStyle='#f2c14e';
  for(let i=0;i<3;i++){ roundRect(x0+sw/2+2+i*6.5, y0+sh-20, 3.6, 11, 1.8); ctx.fill(); }
  if(IMG.tiles) ctx.drawImage(IMG.tiles, 6*16, 12*16, 16, 16, x0+sw+gap+sw/2-20, y0+8, 40,40);
  ctx.fillStyle = medkits>0 ? '#fff' : 'rgba(255,255,255,.35)';
  ctx.font='bold 15px system-ui';
  ctx.fillText(''+medkits, x0+sw+gap+sw/2, y0+sh-11);
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
  elapsedT=0; kills=0; medkits=2; player.hp=100; player.armor=50;
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
  cam:{x:cam.x|0,y:cam.y|0}, world:COLS+'x'+ROWS, layers:layers.length, occ:window.__occ|0, naEscada:!!window.__esc, gun });
window.__key=(k,d)=>{ keys[k]=d; };
window.__tick=(n=1,dt=0.016)=>{ if(state!=='playing') return 'not-playing';
  for(let i=0;i<n;i++) step(dt); draw(); return window.DBG(); };
window.__place=(c,r,L)=>{ player.x=c*MTILE+MTILE/2; player.y=r*MTILE+MTILE/2; player.L=L;
  cam.x=clamp(player.x-(VW/VIEW_SCALE)/2,0,Math.max(0,WORLD_W-VW/VIEW_SCALE));
  cam.y=clamp(player.y-(VH/VIEW_SCALE)/2,0,Math.max(0,WORLD_H-VH/VIEW_SCALE)); draw(); };
window.__coll=(c,r)=>collAt(c,r); window.__over=(c,r)=>overAt(c,r);
window.__gun=()=>({atual:gun, chao:gunItems.map(g=>g.t+'@'+g.c+','+g.r), balas:bullets.length, cd:+fireCooldown.toFixed(3), recuo:+recoilForce.toFixed(2)});
window.__spawnGun=(c,r,t)=>{ if(WEAPONS[t]) gunItems.push({c,r,t,bob:0}); return window.__gun(); };
window.__spawnChest=(c,r,items,v)=>{ chests.push({c,r,v:CHEST_TILES[v]?v:1,
  items:(items||[]).filter(t=>WEAPONS[t]), st:'closed', t:0, loot:[]}); return chests.length; };
window.__chests=()=>chests.map(b=>({c:b.c,r:b.r,st:b.st,dentro:b.items.length,voando:b.loot.length}));
window.__mouse=(down)=>{ mouse.down=down; };
window.__aim=(wx,wy)=>{ mouse.sx=(wx-cam.x)*VIEW_SCALE; mouse.sy=(wy-cam.y)*VIEW_SCALE; };

//======================= BOOT =======================
Promise.all([
  loadImg('tiles','assets/img/tiles_packed.png'),
  loadImg('interface','assets/img/interface_packed.png'),
  loadImg('players','assets/img/players_packed.png'),
  loadImg('enemies','assets/img/enemies_packed.png'),
  loadImg('weapons','assets/img/weapons_packed.png'),
  fetch('map.json?t='+Date.now()).then(r=>r.ok?r.json():null).then(d=>{MAP=d;}).catch(()=>{MAP=null;}),
]).then(()=>{ requestAnimationFrame(frame); });
