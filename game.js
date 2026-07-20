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

//======================= ZONAS (Fortnite-style) =======================
const MAX_ZONES    = 10;             // total de zonas na partida
const ZONE_WAIT    = 48;             // 48s entre safes
const ZONE_SHRINK  = 14;             // 14s fechando normal
const ZONE_SHRINK_FAST = 7;          // 7s fechando nas últimas 3
const ZONE_FINAL   = 30;             // 30s fechamento final até zero
const ZONE_DMG_TICK = 1.0;           // intervalo de dano fora da zona
const ZONE_BASE_DMG = 2;             // dano base por tick (escala com o nº da zona)

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
    healAura = 1.5;                                      // aura verde de cura
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
let hpGhost = 100, armorGhost = 50; // trilha "fantasma" das barras (dano recente escorre)
let shieldRechargeTimer = 0;      // segundos sem tomar dano (após 5s, recarrega escudo)
let prevHp = 100;                 // hp do frame anterior (pra detectar dano)
let miniMap = null, miniBg = '#c99a63';     // offscreen 1px/célula + cor dominante
let zoneState = 'idle', zoneTimer = 0, zoneDmgTimer = 0, zoneNum = 0;   // idle|waiting|shrinking
let zoneCurrent = null, zoneNext = null;      // {cx,cy,r} em px (world coords)
let zoneShrinkFrom = null;                   // estado da zona no início do shrink
let zoneShrinkDur = ZONE_SHRINK;             // duração real do shrink atual (normal ou fast)
let zoneParts = [];                          // partículas de areia/brasa na tempestade
let zoneBanner = null;                       // anúncio central: {text,sub,color,t,dur}
let zoneHitFlash = 0;                        // flash vermelho ao tomar dano da zona
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
// ── SUPERAQUECIMENTO: atirar esquenta o cano; estourou = trava até esfriar ──
let gunHeat = 0;            // calor da arma atual (0..1)
let gunOverheat = false;    // travada fumegando até esfriar
let overheatFlash = 0;      // pop visual do momento do estouro
let healAura = 0;           // aura verde ao curar (0→desaparece)
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
  updateZone(dt);
  // Trilha fantasma das barras: cura acompanha na hora, dano escorre devagar
  hpGhost    = player.hp    > hpGhost    ? player.hp    : Math.max(player.hp,    hpGhost    - dt*30);
  armorGhost = player.armor > armorGhost ? player.armor : Math.max(player.armor, armorGhost - dt*30);
  // ── Recarga do escudo: 5s sem dano → regenera 10/s até 100 ──
  if(player.armor < 100){
    shieldRechargeTimer += dt;
    if(shieldRechargeTimer >= 5){
      player.armor = Math.min(100, player.armor + dt*10);
    }
  } else {
    shieldRechargeTimer = 0;
  }
  if(player.hp < prevHp) shieldRechargeTimer = 0;   // tomou dano → reseta recarga
  prevHp = player.hp;
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
    gunHeat=0; gunOverheat=false;                      // arma do chão tá fria — trocar esfria!
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
  if(mouse.down && fireCooldown <= 0 && !gunOverheat && state=="playing" && !weaponOnBridge && (w.auto || !fireLatch)){
    fireCooldown = w.rate;
    fireLatch = true;
    shoot();
    // Esquenta: rajada contínua estoura em ~4s (escala com a cadência da arma)
    gunHeat += clamp(w.rate*0.45, 0.03, 0.55);
    if(gunHeat >= 1){
      gunHeat = 1; gunOverheat = true; overheatFlash = 1.6;
      overheatSound();
    }
  }
  if(!mouse.down) fireLatch = false;
  flashT = Math.max(0, flashT - dt);
  // ── Resfriamento + vapor do cano ──
  gunHeat = Math.max(0, gunHeat - dt*(gunOverheat ? 0.30 : 0.20));
  if(gunOverheat && gunHeat <= 0.30) gunOverheat = false;    // pronta de novo
  overheatFlash = Math.max(0, overheatFlash - dt);
  // ── Aura de cura ──
  healAura = Math.max(0, healAura - dt);
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
function overheatSound(){
  // "PSSSHHH" de vapor pressurizado + tom descendo (arma desligando)
  if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  const t=audioCtx.currentTime;
  const len=0.55, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.45));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const gain=audioCtx.createGain(); gain.gain.setValueAtTime(0.09,t); gain.gain.exponentialRampToValueAtTime(0.001,t+len);
  const hp=audioCtx.createBiquadFilter(); hp.type='highpass';
  hp.frequency.setValueAtTime(3600,t); hp.frequency.exponentialRampToValueAtTime(1200,t+len);
  src.connect(hp); hp.connect(gain); gain.connect(audioCtx.destination);
  src.start(t); src.stop(t+len);
  const o=audioCtx.createOscillator(); o.type='triangle';
  o.frequency.setValueAtTime(560,t); o.frequency.exponentialRampToValueAtTime(110,t+0.30);
  const og=audioCtx.createGain(); og.gain.setValueAtTime(0.06,t); og.gain.exponentialRampToValueAtTime(0.001,t+0.32);
  o.connect(og); og.connect(audioCtx.destination); o.start(t); o.stop(t+0.32);
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

//======================= ZONAS =======================
function initZones(){
  zoneNum = 0; zoneState = 'idle';
  // Zona inicial cobre o mapa inteiro
  const cx = WORLD_W/2, cy = WORLD_H/2;
  const r = Math.hypot(WORLD_W/2, WORLD_H/2) + MTILE*2;
  zoneCurrent = {cx, cy, r};
  generateNextZone();
  zoneState = 'waiting'; zoneTimer = 30;  // primeira safe mais rápida
  showZoneBanner('ZONA 1/'+MAX_ZONES, 'primeira zona fecha em 30s', '#f2c14e');
}
function generateNextZone(){
  if(!zoneCurrent || zoneNum >= MAX_ZONES - 1) return;  // última zona = final
  // Shrink: começa no meio da curva (como se fosse zona 10 das 20 anteriores)
  const progress = 0.50 + (zoneNum / (MAX_ZONES - 1)) * 0.50;  // 0.50 → 1.0
  const p4 = progress*progress*progress*progress;               // curva de 4ª ordem
  const lo = 0.98 - p4*0.60;                                    // 0.90 → 0.38
  const hi = 0.99 - p4*0.50;                                    // 0.94 → 0.49
  const ratio = lo + Math.random()*(hi-lo);
  const newR = zoneCurrent.r * ratio;
  // Todas as 10 zonas podem "viajar" (safe se desloca pelo mapa)
  const maxDrift = zoneCurrent.r;
  // Ponto aleatório contido no círculo atual E nos bounds do mundo
  const boundL = Math.min(newR, WORLD_W - newR);  // se newR > metade do mundo, bound=WORLD_W-newR
  const boundR = Math.max(newR, WORLD_W - newR);
  const boundT = Math.min(newR, WORLD_H - newR);
  const boundB = Math.max(newR, WORLD_H - newR);
  let ncx, ncy, tries=0;
  do {
    const ang = Math.random()*Math.PI*2;
    const dist = Math.random()*maxDrift;
    ncx = clamp(zoneCurrent.cx + Math.cos(ang)*dist, boundL, boundR);
    ncy = clamp(zoneCurrent.cy + Math.sin(ang)*dist, boundT, boundB);
    tries++;
  } while(tries < 30 && Math.hypot(ncx-zoneCurrent.cx, ncy-zoneCurrent.cy) > maxDrift + 1);
  zoneNext = { cx:ncx, cy:ncy, r:newR };
}
function updateZone(dt){
  if(zoneState==='idle') return;
  zoneTimer -= dt;
  if(zoneState==='waiting' && zoneTimer <= 0){
    if(zoneNum >= MAX_ZONES - 1){
      // Última safe: fecha até quase zero
      zoneShrinkFrom = {cx:zoneCurrent.cx, cy:zoneCurrent.cy, r:zoneCurrent.r};
      zoneState = 'final'; zoneTimer = ZONE_FINAL; zoneNext = null;
      showZoneBanner('ZONA FINAL', 'sem área segura — lute!', '#ff4630');
      return;
    }
    // Começa a fechar — guarda estado inicial pra interpolar
    zoneShrinkFrom = {cx:zoneCurrent.cx, cy:zoneCurrent.cy, r:zoneCurrent.r};
    zoneShrinkDur = zoneNum >= MAX_ZONES - 4 ? ZONE_SHRINK_FAST : ZONE_SHRINK;
    zoneState = 'shrinking'; zoneTimer = zoneShrinkDur;
    showZoneBanner('A ZONA ESTÁ FECHANDO', 'corra para o círculo branco', '#ff8c3c');
  } else if(zoneState==='final'){
    // Fechamento derradeiro: raio vai até ~1 tile
    const t = clamp(1 - zoneTimer/ZONE_FINAL, 0, 1);
    zoneCurrent.r = zoneShrinkFrom.r * (1 - t*t);  // ease-in quadrático até zero
    if(zoneTimer <= 0){ zoneTimer = 0; zoneCurrent.r = 0; } // fechou tudo: sem área segura
  } else if(zoneState==='shrinking'){
    const t = clamp(1 - zoneTimer/zoneShrinkDur, 0, 1);  // 0→1 smoothstep
    const ease = t*t*(3 - 2*t);                          // suave no início e no fim
    zoneCurrent.cx = zoneShrinkFrom.cx + (zoneNext.cx - zoneShrinkFrom.cx)*ease;
    zoneCurrent.cy = zoneShrinkFrom.cy + (zoneNext.cy - zoneShrinkFrom.cy)*ease;
    zoneCurrent.r  = zoneShrinkFrom.r  + (zoneNext.r  - zoneShrinkFrom.r)*ease;
    if(zoneTimer <= 0){
      zoneCurrent = {cx:zoneNext.cx, cy:zoneNext.cy, r:zoneNext.r};
      zoneNum++;
      generateNextZone();
      zoneState = zoneNext ? 'waiting' : 'final';
      zoneTimer = ZONE_WAIT;
      if(zoneState==='waiting')
        showZoneBanner('ZONA '+(zoneNum+1)+'/'+MAX_ZONES, 'próxima zona em '+ZONE_WAIT+'s', '#f2c14e');
    }
  }
  // FX da zona (banner, flash, partículas da tempestade)
  if(zoneBanner){ zoneBanner.t -= dt; if(zoneBanner.t <= 0) zoneBanner = null; }
  zoneHitFlash = Math.max(0, zoneHitFlash - dt*2);
  updateZoneParts(dt);
  // Dano fora da zona
  if(zoneCurrent && zoneState!=='idle'){
    const dist = Math.hypot(player.x - zoneCurrent.cx, player.y - zoneCurrent.cy);
    if(zoneCurrent.r <= 0 || dist > zoneCurrent.r){
      zoneDmgTimer += dt;
      if(zoneDmgTimer >= ZONE_DMG_TICK){
        zoneDmgTimer -= ZONE_DMG_TICK;
        const dmg = zoneNum < 5 ? 1 : 1 + (zoneNum - 4);  // 1 até zona 6, depois escala
        player.hp -= dmg;
        zoneHitFlash = 1;
        if(player.hp <= 0){ player.hp = 0; /* morte depois */ }
      }
    } else {
      zoneDmgTimer = 0;
    }
  }
}
function updateZoneParts(dt){
  if(!zoneCurrent || zoneState==='idle'){ zoneParts.length = 0; return; }
  const vw = VW/VIEW_SCALE, vh = VH/VIEW_SCALE;
  // Spawn: só dentro da câmera e fora da safe
  let tries = 0;
  while(zoneParts.length < 70 && tries < 24){
    tries++;
    const x = cam.x - 24 + Math.random()*(vw+48);
    const y = cam.y - 24 + Math.random()*(vh+48);
    if(zoneCurrent.r > 0 && Math.hypot(x-zoneCurrent.cx, y-zoneCurrent.cy) <= zoneCurrent.r) continue;
    const a = Math.random()*Math.PI*2, sp = 5 + Math.random()*13;
    zoneParts.push({ x, y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp - 5,
      life:0, max:1.1 + Math.random()*1.5, s:0.7 + Math.random()*1.2,
      hot:Math.random() < 0.4 });
  }
  for(let i=zoneParts.length-1; i>=0; i--){
    const p = zoneParts[i];
    p.life += dt; p.x += p.vx*dt; p.y += p.vy*dt;
    const inSafe = zoneCurrent.r > 0 &&
      Math.hypot(p.x-zoneCurrent.cx, p.y-zoneCurrent.cy) <= zoneCurrent.r;
    const off = p.x < cam.x-30 || p.x > cam.x+vw+30 || p.y < cam.y-30 || p.y > cam.y+vh+30;
    if(p.life >= p.max || inSafe || off) zoneParts.splice(i,1);
  }
}
function drawZoneOverlay(){
  if(!zoneCurrent || zoneState==='idle') return;
  const vx = cam.x, vy = cam.y, vw = VW/VIEW_SCALE, vh = VH/VIEW_SCALE;
  const T = performance.now()/1000;
  const zcx = zoneCurrent.cx, zcy = zoneCurrent.cy, r = Math.max(0, zoneCurrent.r);
  const fullyClosed = zoneState==='final' && r <= 0;
  ctx.save();
  // ── Tempestade de areia: gradiente radial (borda quente → vermelho denso longe) ──
  if(fullyClosed){
    ctx.fillStyle = 'rgba(45,10,8,0.62)';
    ctx.fillRect(vx-10, vy-10, vw+20, vh+20);
  } else {
    const band = Math.max(80, r*0.6);
    const g = ctx.createRadialGradient(zcx, zcy, r, zcx, zcy, r+band);
    g.addColorStop(0.00, 'rgba(210,80,30,0)');
    g.addColorStop(0.10, 'rgba(210,80,30,0.28)');
    g.addColorStop(0.45, 'rgba(110,25,12,0.48)');
    g.addColorStop(1.00, 'rgba(45,10,8,0.62)');
    ctx.fillStyle = g;
    ctx.fillRect(vx-10, vy-10, vw+20, vh+20);
  }
  // ── Partículas de areia/brasa na tempestade ──
  for(const p of zoneParts){
    const k = p.life/p.max;
    const a = k < 0.2 ? k/0.2 : 1 - (k-0.2)/0.8;
    ctx.globalAlpha = a * (p.hot ? 0.75 : 0.45);
    ctx.fillStyle = p.hot ? '#ffb066' : '#e0b585';
    ctx.fillRect(p.x - p.s/2, p.y - p.s/2, p.s, p.s);
  }
  ctx.globalAlpha = 1;
  // ── Parede da tempestade (anel pulsante + faíscas girando) ──
  if(!fullyClosed){
    const accent = {waiting:'255,120,45', shrinking:'255,80,35', final:'255,45,25'}[zoneState];
    const hz = zoneState==='final' ? 5 : zoneState==='shrinking' ? 3.2 : 1.6;
    const pulse = 0.5 + 0.5*Math.sin(T*hz*Math.PI*2);
    // Glow largo e suave por fora
    ctx.strokeStyle = 'rgba('+accent+','+(0.10+0.10*pulse).toFixed(3)+')';
    ctx.lineWidth = 14;
    ctx.beginPath(); ctx.arc(zcx, zcy, r+7, 0, Math.PI*2); ctx.stroke();
    // Anel principal com brilho
    ctx.save();
    ctx.shadowColor = 'rgba('+accent+',0.9)';
    ctx.shadowBlur = 10 + 6*pulse;
    ctx.strokeStyle = 'rgba('+accent+','+(0.85+0.15*pulse).toFixed(3)+')';
    ctx.lineWidth = 2 + 1.2*pulse;
    ctx.beginPath(); ctx.arc(zcx, zcy, r, 0, Math.PI*2); ctx.stroke();
    ctx.restore();
    // Faíscas de energia percorrendo a parede
    ctx.strokeStyle = 'rgba(255,220,160,'+(0.35+0.25*pulse).toFixed(3)+')';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 17]);
    ctx.lineDashOffset = -T*26;
    ctx.beginPath(); ctx.arc(zcx, zcy, r+2.5, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
  }
  // ── Próxima safe (preview animado com marcha de traços) ──
  if(zoneNext && (zoneState==='waiting' || zoneState==='shrinking')){
    const np = 0.5 + 0.5*Math.sin(T*2.4);
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.beginPath(); ctx.arc(zoneNext.cx, zoneNext.cy, zoneNext.r, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,'+(0.55+0.30*np).toFixed(3)+')';
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 10]);
    ctx.lineDashOffset = -T*18;
    ctx.beginPath(); ctx.arc(zoneNext.cx, zoneNext.cy, zoneNext.r, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}
function showZoneBanner(text, sub, color){
  zoneBanner = { text, sub, color, t:3.4, dur:3.4 };
}
//── FX de zona em espaço de tela (vinheta, seta pra safe, banner) ──
function drawZoneFX(){
  if(!zoneCurrent || zoneState==='idle') return;
  const T = performance.now()/1000;
  const dist = Math.hypot(player.x - zoneCurrent.cx, player.y - zoneCurrent.cy);
  const outside = zoneCurrent.r <= 0 || dist > zoneCurrent.r;
  // ── Vinheta de perigo (pulsa fora da zona, flash no tick de dano) ──
  const vig = (outside ? 0.28 + 0.10*Math.sin(T*5) : 0) + zoneHitFlash*0.35;
  if(vig > 0.01){
    const g = ctx.createRadialGradient(VW/2, VH/2, Math.min(VW,VH)*0.32, VW/2, VH/2, Math.max(VW,VH)*0.62);
    g.addColorStop(0, 'rgba(200,30,15,0)');
    g.addColorStop(1, 'rgba(160,15,8,'+Math.min(0.85,vig).toFixed(3)+')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
  }
  // ── Seta apontando pra área segura (com distância em metros) ──
  let target = null, col = '#fff';
  if(outside && zoneCurrent.r > 0){ target = zoneCurrent; col = '#ff5a3c'; }
  else if(!outside && zoneNext && (zoneState==='waiting' || zoneState==='shrinking')){
    if(Math.hypot(player.x-zoneNext.cx, player.y-zoneNext.cy) > zoneNext.r){ target = zoneNext; col = '#fff'; }
  }
  if(target){
    const psx = (player.x - cam.x)*VIEW_SCALE, psy = (player.y - cam.y)*VIEW_SCALE;
    const ang = Math.atan2(target.cy - player.y, target.cx - player.x);
    const m = Math.max(0, Math.round((Math.hypot(player.x-target.cx, player.y-target.cy) - target.r)/MTILE));
    const bob = Math.sin(T*4)*3;
    ctx.save();
    ctx.translate(psx + Math.cos(ang)*(86+bob), psy + Math.sin(ang)*(86+bob));
    ctx.rotate(ang);
    ctx.fillStyle = col; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(13,0); ctx.lineTo(-7,-9); ctx.lineTo(-3,0); ctx.lineTo(-7,9);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 4;
    ctx.fillStyle = col; ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(m+'m', psx + Math.cos(ang)*114, psy + Math.sin(ang)*114);
    ctx.restore();
  }
  // ── Banner de anúncio (centro-topo, fade in/out) ──
  if(zoneBanner){
    const b = zoneBanner, k = b.t/b.dur;                 // 1 → 0
    const aIn = Math.min(1, (1-k)*b.dur/0.25), aOut = Math.min(1, k*b.dur/0.5);
    const a = Math.min(aIn, aOut);
    const y = 92 - (1 - Math.min(1,aIn))*14;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 8;
    ctx.fillStyle = b.color; ctx.font = 'bold 30px system-ui';
    ctx.fillText(b.text, VW/2, y);
    ctx.shadowBlur = 0;
    const lw = ctx.measureText(b.text).width;
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.fillRect(VW/2 - lw/2, y+8, lw, 1.5);
    if(b.sub){
      ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 5;
      ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.font = '600 13px system-ui';
      ctx.fillText(b.sub, VW/2, y+28);
    }
    ctx.restore();
  }
}
function drawZoneOnMinimap(cx, cy, z){
  if(!zoneCurrent) return;
  // Zona atual
  const mmColors = {waiting:'rgba(255,70,50,0.8)', shrinking:'rgba(255,50,30,0.9)', final:'rgba(255,30,10,0.9)'};
  ctx.beginPath();
  ctx.arc(cx + (zoneCurrent.cx/MTILE - player.x/MTILE)*z, cy + (zoneCurrent.cy/MTILE - player.y/MTILE)*z,
    zoneCurrent.r/MTILE*z, 0, Math.PI*2);
  ctx.strokeStyle = mmColors[zoneState] || mmColors.waiting;
  ctx.lineWidth = 2;
  ctx.stroke();
  // Próxima safe
  if(zoneNext && (zoneState==='waiting' || zoneState==='shrinking')){
    ctx.beginPath();
    ctx.arc(cx + (zoneNext.cx/MTILE - player.x/MTILE)*z, cy + (zoneNext.cy/MTILE - player.y/MTILE)*z,
      zoneNext.r/MTILE*z, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
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
	    // Cano incandescente conforme esquenta
	    if(gunHeat > 0.35){
	      const gh=(gunHeat-0.35)/0.65, fl=0.75+0.25*Math.sin(performance.now()/40);
	      ctx.globalCompositeOperation='lighter';
	      const gg=ctx.createRadialGradient(SPR*0.30,0,0, SPR*0.30,0,7);
	      gg.addColorStop(0,'rgba(255,120,40,'+(0.55*gh*fl).toFixed(3)+')');
	      gg.addColorStop(1,'rgba(255,60,20,0)');
	      ctx.fillStyle=gg; ctx.beginPath(); ctx.arc(SPR*0.30,0,7,0,6.28); ctx.fill();
	      ctx.globalCompositeOperation='source-over';
	    }
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
  // ── Aura verde de cura ──
  if(healAura > 0){
    const t = performance.now()/1000;
    const k = healAura/1.5;
    // Anéis concêntricos pulsando
    for(let ring=0;ring<3;ring++){
      const ph = (t*0.8 + ring*0.33) % 1;
      const rw = (k*1.2) * (0.55 + ph*0.45);
      ctx.strokeStyle = 'rgba(143,209,50,'+((1-ph)*rw*0.55).toFixed(3)+')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(player.x, player.y-4, SPR*0.7 + ph*SPR*0.55, 0, 6.28); ctx.stroke();
    }
    // Glow sutil ao redor
    ctx.fillStyle = 'rgba(143,209,50,'+(0.08+0.06*Math.sin(t*5)).toFixed(3)+')';
    ctx.beginPath(); ctx.arc(player.x, player.y-4, SPR*0.65, 0, 6.28); ctx.fill();
  }
  // ── Badge de superaquecimento flutuando na arma ──
  if(gunOverheat || overheatFlash>0){
    const Tb = performance.now()/1000;
    const bAng = Math.atan2(mouse.wy-(player.y-6), mouse.wx-player.x);
    const bwx = player.x + Math.cos(bAng)*SPR*0.35;
    const bwy = player.y-6 + Math.sin(bAng)*SPR*0.35;
    const k = overheatFlash/1.6;
    const pop = overheatFlash>0 ? 1+Math.sin((1-k)*Math.PI)*0.35 : 1;
    ctx.save();
    ctx.translate(bwx, bwy - 13 + Math.sin(Tb*3)*1.2);
    ctx.scale(pop, pop);
    if(overheatFlash>0) ctx.rotate(Math.sin(Tb*14)*0.10);
    ctx.globalAlpha = gunOverheat ? 1 : Math.min(1, k*3);
    // Anel de pulso enquanto está travada
    if(gunOverheat){
      ctx.strokeStyle='rgba(255,90,42,'+(0.6+0.4*Math.sin(Tb*8)).toFixed(3)+')';
      ctx.lineWidth=1;
      ctx.beginPath(); ctx.arc(0,0,6.8+Math.sin(Tb*8)*0.8,0,6.28); ctx.stroke();
    }
    ctx.fillStyle='#d92c1f';
    ctx.beginPath(); ctx.arc(0,0,5.5,0,6.28); ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.arc(0,0,5.5,0,6.28); ctx.stroke();
    tinyFlame(0, 0.6, 2.8, '#fff', Math.sin(Tb*20));
    ctx.restore();
    ctx.globalAlpha=1;
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

  // ── Zona (overlay mundial, antes do HUD) ──
  drawZoneOverlay();

  // ═══════════ HUD (barras+kills · minimapa+bússola+chips · slots) ═══════════
  ctx.setTransform(1,0,0,1,0,0);
  drawZoneFX();      // vinheta, seta pra safe e banner (embaixo do HUD)
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
// Barra inclinada (paralelogramo) — visual moderno de BR
function slantBar(x,y,w,h,s){
  ctx.beginPath();
  ctx.moveTo(x+s, y); ctx.lineTo(x+w+s, y);
  ctx.lineTo(x+w, y+h); ctx.lineTo(x, y+h);
  ctx.closePath();
}
//── Ícones pequenos desenhados (coração e escudo) ──
function tinyHeart(x,y,s,color){
  ctx.fillStyle=color;
  ctx.beginPath();
  ctx.moveTo(x, y+s*0.9);
  ctx.bezierCurveTo(x-s, y+s*0.1, x-s*0.9, y-s*0.8, x, y-s*0.15);
  ctx.bezierCurveTo(x+s*0.9, y-s*0.8, x+s, y+s*0.1, x, y+s*0.9);
  ctx.fill();
}
function tinyShield(x,y,s,color){
  ctx.fillStyle=color;
  ctx.beginPath();
  ctx.moveTo(x, y-s);
  ctx.quadraticCurveTo(x+s, y-s*0.7, x+s, y-s*0.05);
  ctx.quadraticCurveTo(x+s, y+s*0.55, x, y+s);
  ctx.quadraticCurveTo(x-s, y+s*0.55, x-s, y-s*0.05);
  ctx.quadraticCurveTo(x-s, y-s*0.7, x, y-s);
  ctx.fill();
}
//── Barra de status com trilha fantasma de dano e segmentos ──
function vitalBar(x,y,w,h,val,ghost,max,c1,c2,slant){
  // Track
  slantBar(x,y,w,h,slant); ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fill();
  // Fantasma (dano recente escorrendo)
  const gw=w*clamp(ghost/max,0,1), fw=w*clamp(val/max,0,1);
  if(gw>fw+0.5){ slantBar(x+fw,y,gw-fw,h,slant); ctx.fillStyle='rgba(255,255,255,.55)'; ctx.fill(); }
  // Preenchimento com gradiente
  if(fw>1){
    const g=ctx.createLinearGradient(x,y,x,y+h);
    g.addColorStop(0,c1); g.addColorStop(1,c2);
    slantBar(x,y,fw,h,slant); ctx.fillStyle=g; ctx.fill();
    // Brilho no topo
    slantBar(x,y,fw,h*0.42,slant*0.55); ctx.fillStyle='rgba(255,255,255,.22)'; ctx.fill();
  }
  // Segmentos (25 em 25)
  ctx.strokeStyle='rgba(0,0,0,.45)'; ctx.lineWidth=1.5;
  for(let i=1;i<4;i++){
    const sx=x+w*i/4;
    ctx.beginPath(); ctx.moveTo(sx+slant,y); ctx.lineTo(sx,y+h); ctx.stroke();
  }
  // Contorno
  slantBar(x,y,w,h,slant); ctx.strokeStyle='rgba(255,255,255,.28)'; ctx.lineWidth=1; ctx.stroke();
}
function drawBars(){
  const T=performance.now()/1000;
  // ═══ Cartão de vitais (canto inferior esquerdo) ═══
  const W=332, H=88, X=20, Y=VH-H-18;
  const lowHp = player.hp<=30;
  ctx.save();
  // Painel
  const pg=ctx.createLinearGradient(X,Y,X,Y+H);
  pg.addColorStop(0,'rgba(14,22,18,.86)'); pg.addColorStop(1,'rgba(8,13,11,.92)');
  ctx.fillStyle=pg; roundRect(X,Y,W,H,14); ctx.fill();
  ctx.strokeStyle= lowHp ? 'rgba(255,60,40,'+(0.45+0.35*Math.sin(T*6)).toFixed(3)+')' : 'rgba(255,255,255,.14)';
  ctx.lineWidth=lowHp?2:1.2; roundRect(X,Y,W,H,14); ctx.stroke();
  // Avatar circular (sprite do player)
  const acx=X+44, acy=Y+H/2, ar=30;
  ctx.fillStyle='#0d1714'; ctx.beginPath(); ctx.arc(acx,acy,ar,0,6.28); ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.arc(acx,acy,ar-1.5,0,6.28); ctx.clip();
  if(IMG.players){
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(IMG.players, 0, (player.skin||0)*SPR, SPR, SPR, acx-33, acy-30, 66, 66);
  }
  ctx.restore();
  ctx.strokeStyle='#f2c14e'; ctx.lineWidth=2.5;
  ctx.beginPath(); ctx.arc(acx,acy,ar,0,6.28); ctx.stroke();
  ctx.strokeStyle='rgba(0,0,0,.5)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.arc(acx,acy,ar+2,0,6.28); ctx.stroke();
  // Barras à direita do avatar
  const bx=X+96, bw=W-96-70, sl=5;
  // Escudo (fina, em cima)
  tinyShield(bx-13, Y+25, 7, '#4aa3ff');
  vitalBar(bx, Y+18, bw*0.82, 12, player.armor, armorGhost, 100, '#5ab5ff', '#2878cc', sl);
  // Glow de recarga: brilha na ponta enquanto regenera
  if(player.armor < 100 && shieldRechargeTimer >= 5){
    const rgw = bw*0.82*clamp(player.armor/100,0,1);
    slantBar(bx+rgw-3, Y+18, 6, 12, sl);
    ctx.fillStyle = 'rgba(130,210,255,'+(0.35+0.25*Math.sin(performance.now()/1000*6)).toFixed(3)+')';
    ctx.fill();
  }
  ctx.fillStyle='#b0d8ff'; ctx.font='bold 12px system-ui';
  ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText(''+(player.armor|0), bx+bw*0.82+12, Y+25);
  // HP (grossa, embaixo)
  tinyHeart(bx-13, Y+52, 7.5, lowHp?'#ff6a55':'#ff5a4a');
  vitalBar(bx, Y+44, bw, 19, player.hp, hpGhost, 100,
    lowHp?'#ff7a5a':'#ff6448', lowHp?'#d92c1f':'#cf3322', sl);
  // Número grande de HP
  ctx.fillStyle = lowHp ? '#ff8d75' : '#fff';
  ctx.font='bold 26px system-ui'; ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText(''+(player.hp|0), bx+bw+14, Y+53);
  ctx.restore();
  // Pulso vermelho na tela com HP baixo
  if(lowHp && player.hp>0){
    const a=(0.10+0.08*Math.sin(T*6))*(1-player.hp/30);
    const g=ctx.createRadialGradient(VW/2,VH/2,Math.min(VW,VH)*0.35, VW/2,VH/2,Math.max(VW,VH)*0.60);
    g.addColorStop(0,'rgba(180,20,10,0)'); g.addColorStop(1,'rgba(180,20,10,'+a.toFixed(3)+')');
    ctx.fillStyle=g; ctx.fillRect(0,0,VW,VH);
  }
  // ═══ Chip de abates (topo esquerdo, compacto) ═══
  const kW=104, kH=38, kX=20, kY=18;
  ctx.fillStyle='rgba(10,16,14,.80)'; roundRect(kX,kY,kW,kH,19); ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,.12)'; ctx.lineWidth=1; roundRect(kX,kY,kW,kH,19); ctx.stroke();
  ctx.font='18px system-ui'; ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText('💀', kX+12, kY+kH/2+1);
  ctx.fillStyle='#fff'; ctx.font='bold 18px system-ui';
  ctx.fillText(''+kills, kX+40, kY+kH/2+1);
  ctx.fillStyle='rgba(255,255,255,.40)'; ctx.font='bold 9px system-ui';
  ctx.fillText('ABATES', kX+40+(kills>9?26:16), kY+kH/2+2);
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
    // Zonas no minimapa
    drawZoneOnMinimap(cx, cy, z);
    // Overlay avermelhado fora da safe no minimapa
    if(zoneCurrent && zoneState!=='idle'){
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx-R, cy-R, R*2, R*2);
      ctx.arc(cx + (zoneCurrent.cx/MTILE-pc)*z, cy + (zoneCurrent.cy/MTILE-pr)*z,
        zoneCurrent.r/MTILE*z, 0, Math.PI*2, true);
      ctx.fillStyle = 'rgba(80,15,10,0.45)';
      ctx.fill('evenodd');
      ctx.restore();
    }
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
  // ═══════════ Painel BR abaixo do minimapa ═══════════
  const T=performance.now()/1000;
  const panelW=172, panelX=cx-panelW/2, panelTop=cy+ringOut+14;
  const inSafe = zoneCurrent && Math.hypot(player.x-zoneCurrent.cx, player.y-zoneCurrent.cy) <= zoneCurrent.r;

  // Cores por estado da zona
  let zAccent='#555', zGlow=null, zIcon=0, zProgress=0, zUrgent=false;
  // zIcon: 0=shield, 1=warning, 2=hourglass, 3=fire, 4=skull
  if(zoneState==='waiting'){
    zAccent = inSafe ? '#22c55e' : '#eab308';
    zGlow   = inSafe ? 'rgba(34,197,94,.25)' : 'rgba(234,179,8,.35)';
    zIcon   = inSafe ? 0 : 1;
    zProgress = 1-zoneTimer/(zoneNum===0?30:ZONE_WAIT);
    zUrgent = zoneTimer<=10;
  }else if(zoneState==='shrinking'){
    zAccent = inSafe ? '#f97316' : '#ef4444';
    zGlow   = inSafe ? 'rgba(249,115,22,.30)' : 'rgba(239,68,68,.40)';
    zIcon   = inSafe ? 2 : 3;
    zProgress = 1-zoneTimer/zoneShrinkDur;
    zUrgent = true;
  }else if(zoneState==='final'){
    zAccent = '#dc2626';
    zGlow   = 'rgba(220,38,38,.45)';
    zIcon   = 4;
    zProgress = 1-zoneTimer/ZONE_FINAL;
    zUrgent = true;
  }

  // ── Fundo do painel (unifica tudo) ──
  const zoneOn = zoneState!=='idle';
  const zoneH=96, tilesH=46;
  const panelH = (zoneOn ? zoneH+6 : 0) + tilesH;
  ctx.fillStyle='rgba(8,14,12,.82)'; roundRect(panelX-4, panelTop-4, panelW+8, panelH+8, 12); ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,.10)'; ctx.lineWidth=1;
  roundRect(panelX-4, panelTop-4, panelW+8, panelH+8, 12); ctx.stroke();

  let py=panelTop;

  // ═══ 1. CARD ZONA ═══
  if(zoneOn){
    const zx=panelX, zw=panelW, zh=zoneH;
    // Fundo + glow da cor do estado
    ctx.fillStyle='rgba(12,20,16,.9)'; roundRect(zx, py, zw, zh, 10); ctx.fill();
    if(zGlow){ ctx.fillStyle=zGlow; roundRect(zx, py, zw, zh, 10); ctx.fill(); }
    ctx.save(); ctx.shadowColor=zAccent; ctx.shadowBlur=9;
    ctx.strokeStyle=zAccent; ctx.lineWidth=1.6; roundRect(zx, py, zw, zh, 10); ctx.stroke();
    ctx.restore();

    // Header: label + ícone de status (menor, no topo direito)
    ctx.fillStyle='rgba(255,255,255,.55)'; ctx.font='bold 10px system-ui';
    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText('ZONA', zx+12, py+9);
    ctx.save(); ctx.translate(zx+zw-18, py+16); ctx.scale(0.68,0.68);
    drawZoneIcon(0, 0, zIcon, zAccent);
    ctx.restore();

    // Número da zona (ou FINAL) + timer pulsando quando urgente
    ctx.fillStyle='#fff'; ctx.font='bold 24px system-ui';
    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText(zoneState==='final' ? 'FINAL' : (zoneNum+1)+'/'+MAX_ZONES, zx+12, py+21);
    const tScale = zUrgent ? 1+0.07*Math.sin(T*8) : 1;
    ctx.save();
    ctx.translate(zx+zw-13, py+37); ctx.scale(tScale,tScale);
    ctx.fillStyle = zUrgent ? zAccent : '#fff';
    ctx.font='bold 26px system-ui'; ctx.textAlign='right'; ctx.textBaseline='middle';
    ctx.fillText(Math.ceil(zoneTimer)+'s', 0, 0);
    ctx.restore();

    // Pips das 10 zonas: passadas · atual (pulsando) · futuras
    const pipY=py+zh-27, pipL=zx+12, pipSpan=zw-24, step=pipSpan/MAX_ZONES;
    for(let i=0;i<MAX_ZONES;i++){
      const pcx=pipL+step*i+step/2;
      const cur = i===zoneNum;
      const s = cur ? 4.6*(1+0.25*Math.sin(T*4)) : 3.6;
      ctx.save();
      ctx.translate(pcx, pipY); ctx.rotate(Math.PI/4);
      if(cur){
        ctx.shadowColor=zAccent; ctx.shadowBlur=6;
        ctx.fillStyle=zAccent;
        ctx.fillRect(-s/2,-s/2,s,s);
      } else if(i<zoneNum){
        ctx.fillStyle='rgba(255,255,255,.40)';
        ctx.fillRect(-s/2,-s/2,s,s);
      } else {
        ctx.strokeStyle='rgba(255,255,255,.20)'; ctx.lineWidth=1;
        ctx.strokeRect(-s/2,-s/2,s,s);
      }
      ctx.restore();
    }

    // Barra de progresso com listras marchando
    const barX=zx+12, barW=zw-24, barY=py+zh-14, barH=6;
    ctx.fillStyle='rgba(0,0,0,.45)'; roundRect(barX, barY, barW, barH, barH/2); ctx.fill();
    const progW=barW*Math.min(1,Math.max(0,zProgress));
    if(progW>1){
      ctx.save();
      roundRect(barX, barY, progW, barH, barH/2); ctx.clip();
      ctx.fillStyle=zAccent; ctx.fillRect(barX, barY, progW, barH);
      // Listras diagonais andando
      ctx.fillStyle='rgba(255,255,255,.22)';
      const off=(T*16)%12;
      for(let sx=barX-12+off; sx<barX+progW; sx+=12){
        ctx.beginPath();
        ctx.moveTo(sx, barY+barH); ctx.lineTo(sx+4, barY+barH);
        ctx.lineTo(sx+4+barH, barY); ctx.lineTo(sx+barH, barY);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle='rgba(255,255,255,.20)'; ctx.fillRect(barX, barY, progW, barH*0.4);
      ctx.restore();
    }
    ctx.strokeStyle='rgba(255,255,255,.15)'; ctx.lineWidth=1;
    roundRect(barX, barY, barW, barH, barH/2); ctx.stroke();

    py+=zh+6;
  }

  // ═══ 2. TILES LADO A LADO: VIVOS | TEMPO ═══
  {
    const tw2=(panelW-6)/2, th=tilesH;
    // ── VIVOS (esquerda) ──
    const vx=panelX, vy=py;
    ctx.fillStyle='rgba(12,20,16,.75)'; roundRect(vx, vy, tw2, th, 9); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=1; roundRect(vx, vy, tw2, th, 9); ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,.45)'; ctx.font='bold 8px system-ui';
    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText('VIVOS', vx+10, vy+8);
    ctx.fillStyle='#fff'; ctx.font='bold 20px system-ui';
    ctx.fillText('1', vx+10, vy+18);
    // Ícone pessoa
    const hx=vx+tw2-16, hy=vy+th/2+2;
    ctx.strokeStyle='rgba(255,255,255,.45)'; ctx.lineWidth=1.3;
    ctx.beginPath(); ctx.arc(hx, hy-6, 3.6, 0, 6.28); ctx.stroke();
    ctx.beginPath(); ctx.arc(hx, hy+6, 5.5, Math.PI, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hx, hy+6); ctx.lineTo(hx, hy+11); ctx.stroke();
    // ── TEMPO (direita) ──
    const tx=panelX+tw2+6, ty=py;
    ctx.fillStyle='rgba(12,20,16,.75)'; roundRect(tx, ty, tw2, th, 9); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=1; roundRect(tx, ty, tw2, th, 9); ctx.stroke();
    const mm=String(Math.floor(elapsedT/60)).padStart(2,'0'), ss=String(Math.floor(elapsedT%60)).padStart(2,'0');
    ctx.fillStyle='rgba(255,255,255,.45)'; ctx.font='bold 8px system-ui';
    ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText('TEMPO', tx+10, ty+8);
    ctx.fillStyle='#fff'; ctx.font='bold 16px monospace';
    ctx.fillText(mm+':'+ss, tx+10, ty+20);
    // Relógio pequeno com ponteiro girando (divertido)
    const icx=tx+tw2-16, icy=ty+th/2+2;
    ctx.strokeStyle='rgba(255,255,255,.5)'; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.arc(icx, icy, 7, 0, 6.28); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(icx, icy); ctx.lineTo(icx, icy-4); ctx.stroke();
    const secAng=(elapsedT%60)/60*Math.PI*2 - Math.PI/2;
    ctx.beginPath(); ctx.moveTo(icx, icy);
    ctx.lineTo(icx+Math.cos(secAng)*5, icy+Math.sin(secAng)*5); ctx.stroke();
  }
}
//── Ícones de status da zona (desenhados com Canvas) ──
function drawZoneIcon(ix,iy,type,color){
  ctx.save();
  ctx.strokeStyle=color; ctx.fillStyle=color;
  ctx.lineWidth=2; ctx.lineCap='round'; ctx.lineJoin='round';
  const S=11; // raio base do ícone

  if(type===0){       // ═══ SHIELD — escudo com checkmark ═══
    // Escudo pontudo
    ctx.fillStyle=color.replace(')',',.20)').replace('rgb','rgba');
    ctx.beginPath();
    ctx.moveTo(ix,iy-S-1);                              // topo
    ctx.quadraticCurveTo(ix+S*1.1,iy-S*0.8, ix+S*1.1,iy-S*0.1);  // ombro direito
    ctx.lineTo(ix+S*0.5,iy+S*0.6);                      // ponta direita baixa
    ctx.quadraticCurveTo(ix+S*0.2,iy+S*0.3, ix,iy+S*0.9);         // curva inferior direita → ponta
    ctx.quadraticCurveTo(ix-S*0.2,iy+S*0.3, ix-S*0.5,iy+S*0.6);   // ponta → curva inferior esquerda
    ctx.lineTo(ix-S*1.1,iy-S*0.1);                      // ombro esquerdo
    ctx.quadraticCurveTo(ix-S*1.1,iy-S*0.8, ix,iy-S-1);           // volta ao topo
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Checkmark interno
    ctx.strokeStyle=color; ctx.lineWidth=2.5;
    ctx.beginPath();
    ctx.moveTo(ix-5,iy); ctx.lineTo(ix-1,iy+4); ctx.lineTo(ix+6,iy-4);
    ctx.stroke();
  }else if(type===1){ // ═══ WARNING — triângulo com "!" em paths ═══
    ctx.fillStyle=color.replace(')',',.20)').replace('rgb','rgba');
    ctx.beginPath();
    ctx.moveTo(ix,iy-S-1); ctx.lineTo(ix+S+1,iy+S); ctx.lineTo(ix-S-1,iy+S);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Exclamação (barra + ponto)
    ctx.fillStyle=color; ctx.strokeStyle=color; ctx.lineWidth=2;
    ctx.beginPath(); ctx.roundRect(ix-2,iy-5,4,10,2); ctx.fill();      // barra vertical
    ctx.beginPath(); ctx.arc(ix,iy+7,2.5,0,Math.PI*2); ctx.fill();      // ponto
  }else if(type===2){ // ═══ HOURGLASS — ampulheta com grãos de areia ═══
    ctx.fillStyle=color.replace(')',',.18)').replace('rgb','rgba');
    // Corpo da ampulheta
    ctx.beginPath();
    ctx.moveTo(ix-S*0.8,iy-S-2); ctx.lineTo(ix+S*0.8,iy-S-2);   // topo largo
    ctx.quadraticCurveTo(ix+S*0.3,iy-S*0.4, ix,iy);              // curva direita cima → centro
    ctx.quadraticCurveTo(ix-S*0.3,iy+S*0.4, ix+S*0.8,iy+S);     // curva esquerda baixo → base
    ctx.lineTo(ix-S*0.8,iy+S);
    ctx.quadraticCurveTo(ix-S*0.3,iy+S*0.4, ix,iy);              // curva esquerda cima → centro
    ctx.quadraticCurveTo(ix+S*0.3,iy-S*0.4, ix-S*0.8,iy-S-2);    // volta ao topo
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Grãos de areia na base (3 pontinhos)
    ctx.fillStyle=color; ctx.beginPath(); ctx.arc(ix-4,iy+S-3,1.6,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(ix,iy+S-2,1.6,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(ix+4,iy+S-3,1.6,0,Math.PI*2); ctx.fill();
    // Linha fina no centro
    ctx.strokeStyle=color; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.moveTo(ix-S*0.5,iy); ctx.lineTo(ix+S*0.5,iy); ctx.stroke();
  }else if(type===3){ // ═══ FIRE — chama com camada interna ═══
    // Chama externa
    ctx.fillStyle=color.replace(')',',.22)').replace('rgb','rgba');
    ctx.beginPath();
    ctx.moveTo(ix,iy-S-2);                                              // ponta superior
    ctx.bezierCurveTo(ix+S*0.7,iy-S*0.9, ix+S*1.1,iy-S*0.4, ix+S,iy+S*0.3);   // curva direita alta
    ctx.bezierCurveTo(ix+S*1.3,iy+S*0.9, ix+S*0.6,iy+S*0.8, ix+S*0.7,iy+S);    // lobo direito
    ctx.bezierCurveTo(ix+S*0.3,iy+S*0.5, ix,iy+S*0.3, ix,iy);                  // centro-direita
    ctx.bezierCurveTo(ix-S*0.3,iy+S*0.5, ix-S*0.7,iy+S*0.8, ix-S*0.7,iy+S);    // lobo esquerdo
    ctx.bezierCurveTo(ix-S*1.3,iy+S*0.9, ix-S,iy+S*0.3, ix-S*0.8,iy-S*0.1);    // curva esquerda alta
    ctx.bezierCurveTo(ix-S*0.7,iy-S*0.7, ix,iy-S-2, ix,iy-S-2);                // volta ao topo
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Chama interna (mais clara, menor)
    ctx.fillStyle=color.replace(')',',.40)').replace('rgb','rgba');
    ctx.beginPath();
    ctx.moveTo(ix,iy-S*0.3);
    ctx.bezierCurveTo(ix+S*0.35,iy-S*0.2, ix+S*0.5,iy+S*0.3, ix+S*0.2,iy+S*0.55);
    ctx.bezierCurveTo(ix+S*0.1,iy+S*0.3, ix,iy+S*0.1, ix,iy-S*0.1);
    ctx.bezierCurveTo(ix-S*0.2,iy+S*0.3, ix-S*0.5,iy+S*0.55, ix-S*0.5,iy+S*0.3);
    ctx.bezierCurveTo(ix-S*0.35,iy-S*0.2, ix,iy-S*0.3, ix,iy-S*0.3);
    ctx.closePath(); ctx.fill();
  }else if(type===4){ // ═══ SKULL & CROSSBONES — caveira com ossos cruzados ═══
    ctx.fillStyle=color.replace(')',',.20)').replace('rgb','rgba');
    // Ossos cruzados (atrás)
    ctx.lineWidth=3; ctx.strokeStyle=color;
    ctx.beginPath(); ctx.moveTo(ix-S,iy-S*0.6); ctx.lineTo(ix+S,iy+S*0.8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ix+S,iy-S*0.6); ctx.lineTo(ix-S,iy+S*0.8); ctx.stroke();
    // Bolinhas nas pontas dos ossos
    ctx.fillStyle=color; ctx.lineWidth=1.5;
    [{x:ix-S,y:iy-S*0.6},{x:ix+S,y:iy+S*0.8},{x:ix+S,y:iy-S*0.6},{x:ix-S,y:iy+S*0.8}].forEach(p=>{
      ctx.beginPath(); ctx.arc(p.x,p.y,2.2,0,Math.PI*2); ctx.fill(); ctx.stroke();
    });
    // Crânio
    ctx.fillStyle=color.replace(')',',.22)').replace('rgb','rgba');
    ctx.beginPath();
    // Crânio em forma de pêra (não círculo perfeito)
    ctx.arc(ix,iy-S*0.2,S*0.7,Math.PI,0);           // topo arredondado
    ctx.quadraticCurveTo(ix+S*0.8,iy+S*0.2, ix+S*0.2,iy+S*0.65);  // bochecha direita
    ctx.lineTo(ix-S*0.2,iy+S*0.65);                               // maxilar inferior
    ctx.quadraticCurveTo(ix-S*0.8,iy+S*0.2, ix-S*0.7,iy-S*0.2);  // bochecha esquerda
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Olhos (2 ovais escuros)
    ctx.fillStyle='rgba(8,14,12,.85)';
    ctx.beginPath(); ctx.ellipse(ix-3,iy-S*0.25,2.2,2.8,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(ix+3,iy-S*0.25,2.2,2.8,0,0,Math.PI*2); ctx.fill();
    // Nariz (triângulo invertido)
    ctx.fillStyle='rgba(8,14,12,.85)';
    ctx.beginPath(); ctx.moveTo(ix-1.5,iy+S*0.1); ctx.lineTo(ix+1.5,iy+S*0.1); ctx.lineTo(ix,iy+S*0.3); ctx.closePath(); ctx.fill();
    // Dentes (linha horizontal com traços verticais)
    ctx.strokeStyle='rgba(8,14,12,.85)'; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.moveTo(ix-3,iy+S*0.45); ctx.lineTo(ix+3,iy+S*0.45); ctx.stroke();
    for(let dx=-2;dx<=2;dx+=1.3){
      ctx.beginPath(); ctx.moveTo(ix+dx,iy+S*0.45); ctx.lineTo(ix+dx,iy+S*0.6); ctx.stroke();
    }
  }
  ctx.restore();
}
//── Cor do calor: azul frio → amarelo → vermelho brasa ──
function heatColor(h){
  const mix=(a,b,t)=>Math.round(a+(b-a)*t);
  let c;
  if(h<0.5){ const t=h*2; c=[mix(90,255,t), mix(190,210,t), mix(255,74,t)]; }
  else { const t=(h-0.5)*2; c=[255, mix(210,59,t), mix(74,30,t)]; }
  return 'rgb('+c[0]+','+c[1]+','+c[2]+')';
}
//── Chaminha desenhada (tremula com o flicker) ──
function tinyFlame(x,y,s,color,flicker){
  ctx.fillStyle=color;
  ctx.beginPath();
  ctx.moveTo(x, y+s);
  ctx.quadraticCurveTo(x-s*0.9, y+s*0.2, x-s*0.35, y-s*0.3);
  ctx.quadraticCurveTo(x-s*0.1, y-s*0.05, x, y-s*(1+flicker*0.35));
  ctx.quadraticCurveTo(x+s*0.15, y-s*0.4, x+s*0.4, y-s*0.15);
  ctx.quadraticCurveTo(x+s*0.9, y+s*0.3, x, y+s);
  ctx.fill();
}
//── Keycap (tecla desenhada no canto do slot) ──
function keycap(x,y,label,gold){
  ctx.fillStyle = gold ? '#f2c14e' : 'rgba(255,255,255,.16)';
  roundRect(x,y,17,17,4); ctx.fill();
  ctx.strokeStyle='rgba(0,0,0,.4)'; ctx.lineWidth=1; roundRect(x,y,17,17,4); ctx.stroke();
  ctx.fillStyle = gold ? '#3a2c10' : 'rgba(255,255,255,.85)';
  ctx.font='bold 11px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(label, x+8.5, y+9.5);
}
function drawSlots(){
  const T=performance.now()/1000;
  const w=WEAPONS[gun];
  const M=20;                                   // margem da borda
  // ═══ Geometria dos slots primeiro — o cartão de calor alinha exato com eles ═══
  const s1W=100, s1H=76, s2W=80, s2H=64, gap=10;
  const s2X=VW-M-s2W, s2Y=VH-18-s2H;
  const s1X=s2X-gap-s1W, s1Y=VH-18-s1H;
  // ═══ Cartão da arma: linha 1 = nome · modo · temperatura | linha 2 = termômetro cheio ═══
  const iH=52, iW=s1W+gap+s2W, iX=s1X, iY=s1Y-8-iH;
  const ig=ctx.createLinearGradient(iX,iY,iX,iY+iH);
  ig.addColorStop(0,'rgba(14,22,18,.86)'); ig.addColorStop(1,'rgba(8,13,11,.92)');
  ctx.fillStyle=ig; roundRect(iX,iY,iW,iH,10); ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,.14)'; ctx.lineWidth=1; roundRect(iX,iY,iW,iH,10); ctx.stroke();
  const hc = heatColor(gunHeat);
  const temp = (20 + gunHeat*180)|0;                         // 20°C fria → 200°C estourando
  const blink = gunOverheat ? (Math.sin(T*10)>0 ? 1 : 0.35) : 1;
  // ── Linha 1: nome + chip de modo à esquerda, temperatura à direita ──
  const r1=iY+16;
  ctx.fillStyle='#fff'; ctx.font='bold 12px system-ui';
  ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText(w.nome.toUpperCase(), iX+12, r1);
  const nomeW=ctx.measureText(w.nome.toUpperCase()).width;
  const chX=iX+12+nomeW+8, chW=34;
  ctx.fillStyle = w.auto ? 'rgba(242,193,78,.18)' : 'rgba(255,255,255,.10)';
  roundRect(chX, r1-7, chW, 14, 4); ctx.fill();
  ctx.strokeStyle = w.auto ? 'rgba(242,193,78,.6)' : 'rgba(255,255,255,.25)';
  ctx.lineWidth=1; roundRect(chX, r1-7, chW, 14, 4); ctx.stroke();
  ctx.fillStyle = w.auto ? '#f2c14e' : 'rgba(255,255,255,.7)';
  ctx.font='bold 9px system-ui'; ctx.textAlign='center';
  ctx.fillText(w.auto?'AUTO':'SEMI', chX+chW/2, r1+1);
  // Temperatura à direita + chaminha que cresce com o calor
  ctx.save(); ctx.globalAlpha=blink;
  ctx.fillStyle = (gunHeat>0.5||gunOverheat) ? hc : '#fff';
  ctx.font='bold 16px system-ui'; ctx.textAlign='right'; ctx.textBaseline='middle';
  ctx.fillText(temp+'°C', iX+iW-12, r1+1);
  const tempW=ctx.measureText(temp+'°C').width;
  ctx.restore();
  if(gunHeat>0.05){
    const fl=Math.sin(T*22)*0.5+Math.sin(T*13.7)*0.5;
    ctx.save(); ctx.globalAlpha=0.35+gunHeat*0.65;
    tinyFlame(iX+iW-12-tempW-10, r1+1, 3.5+gunHeat*4, hc, fl);
    ctx.restore();
  }
  // ── Linha 2: termômetro de largura total (azul frio → vermelho brasa) ──
  const hbX=iX+12, hbW=iW-24, hbH=11, hbY=iY+iH-19;
  ctx.fillStyle='rgba(0,0,0,.5)'; roundRect(hbX, hbY, hbW, hbH, hbH/2); ctx.fill();
  if(gunHeat>0.02){
    ctx.save();
    roundRect(hbX, hbY, Math.max(hbH, hbW*gunHeat), hbH, hbH/2); ctx.clip();
    const tg=ctx.createLinearGradient(hbX,0,hbX+hbW,0);   // gradiente fixo: a barra "revela" ele
    tg.addColorStop(0,'#4ac1ff'); tg.addColorStop(0.55,'#ffd24a'); tg.addColorStop(1,'#ff3b1e');
    ctx.globalAlpha=blink;
    ctx.fillStyle=tg; ctx.fillRect(hbX, hbY, hbW, hbH);
    ctx.fillStyle='rgba(255,255,255,.22)'; ctx.fillRect(hbX, hbY, hbW, hbH*0.45);
    ctx.restore();
  }
  // Marcas de 25/50/75%
  ctx.strokeStyle='rgba(255,255,255,.18)'; ctx.lineWidth=1;
  for(let i=1;i<4;i++){
    const tx=hbX+hbW*i/4;
    ctx.beginPath(); ctx.moveTo(tx, hbY+2); ctx.lineTo(tx, hbY+hbH-2); ctx.stroke();
  }
  // Superaqueceu: marcador branco piscando em 30% — onde a arma destrava
  if(gunOverheat){
    ctx.save(); ctx.globalAlpha=0.5+0.5*Math.sin(T*8);
    ctx.strokeStyle='#fff'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(hbX+hbW*0.30, hbY-2); ctx.lineTo(hbX+hbW*0.30, hbY+hbH+2); ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle='rgba(255,255,255,.25)'; ctx.lineWidth=1;
  roundRect(hbX, hbY, hbW, hbH, hbH/2); ctx.stroke();

  // ═══ Slots (arma ativa + medkit) ═══
  // ── Slot 1: arma (ativo, dourado) ──
  const g1=ctx.createLinearGradient(s1X,s1Y,s1X,s1Y+s1H);
  g1.addColorStop(0,'rgba(20,28,22,.90)'); g1.addColorStop(1,'rgba(10,15,12,.94)');
  ctx.fillStyle=g1; roundRect(s1X,s1Y,s1W,s1H,12); ctx.fill();
  // brilho interno dourado sutil
  ctx.fillStyle='rgba(242,193,78,.07)'; roundRect(s1X,s1Y,s1W,s1H,12); ctx.fill();
  // Borda: dourada fria → vermelha em brasa; pisca quando superaquece
  const hotBorder = gunHeat>0.35 ? heatColor(0.5+((gunHeat-0.35)/0.65)*0.5) : '#f2c14e';
  ctx.save();
  ctx.shadowColor=hotBorder; ctx.shadowBlur=8+gunHeat*8;
  ctx.globalAlpha = gunOverheat ? (0.55+0.45*Math.sin(T*10)) : 1;
  ctx.strokeStyle=hotBorder; ctx.lineWidth=2; roundRect(s1X,s1Y,s1W,s1H,12); ctx.stroke();
  ctx.restore();
  keycap(s1X+7, s1Y+7, '1', true);
  // Sprite da arma (com bounce na troca)
  ctx.save();
  ctx.imageSmoothingEnabled=false;
  let ws=1;
  if(swapAnim){ const bt=swapAnim.t/swapAnim.total; ws=0.5+0.5*bt+Math.sin(bt*Math.PI)*0.3*(1-bt); }
  ctx.translate(s1X+s1W/2, s1Y+s1H/2-4);
  ctx.scale(ws,ws);
  if(IMG.weapons) ctx.drawImage(IMG.weapons, w.spr*SPR,0, SPR,SPR, -26, -26, 52,52);
  ctx.restore();
  // Nome pequeno na base do slot
  ctx.fillStyle='rgba(255,255,255,.75)'; ctx.font='bold 9px system-ui';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(w.nome.toUpperCase(), s1X+s1W/2, s1Y+s1H-10);

  // ── Slot 2: medkit ──
  const canHeal = medkits>0 && player.hp<100;
  const g2=ctx.createLinearGradient(s2X,s2Y,s2X,s2Y+s2H);
  g2.addColorStop(0,'rgba(16,24,19,.86)'); g2.addColorStop(1,'rgba(9,14,11,.92)');
  ctx.fillStyle=g2; roundRect(s2X,s2Y,s2W,s2H,11); ctx.fill();
  // Pulso verde quando dá pra curar
  ctx.strokeStyle = canHeal
    ? 'rgba(143,209,50,'+(0.45+0.35*Math.sin(T*4)).toFixed(3)+')'
    : 'rgba(255,255,255,.18)';
  ctx.lineWidth = canHeal ? 1.8 : 1.2;
  roundRect(s2X,s2Y,s2W,s2H,11); ctx.stroke();
  keycap(s2X+6, s2Y+6, '2', false);
  ctx.save();
  ctx.imageSmoothingEnabled=false;
  if(medkits<=0) ctx.globalAlpha=0.35;
  if(IMG.tiles) ctx.drawImage(IMG.tiles, 6*16, 12*16, 16, 16, s2X+s2W/2-17, s2Y+s2H/2-19, 34,34);
  ctx.restore();
  // Contador (badge no canto)
  ctx.fillStyle = medkits>0 ? '#8fd132' : 'rgba(255,255,255,.25)';
  roundRect(s2X+s2W-25, s2Y+s2H-23, 19, 17, 6); ctx.fill();
  ctx.fillStyle = medkits>0 ? '#12240a' : 'rgba(0,0,0,.5)';
  ctx.font='bold 11px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('x'+medkits, s2X+s2W-15.5, s2Y+s2H-14);
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
  elapsedT=0; kills=0; medkits=2; player.hp=100; player.armor=0;
  hpGhost=100; armorGhost=0;
  shieldRechargeTimer=0; prevHp=100;
  gunHeat=0; gunOverheat=false; overheatFlash=0;
  healAura=0;
  const s=findSpawn(), sv=collInfo(coll[s]);
  player.x=(s%COLS)*MTILE+MTILE/2; player.y=((s/COLS)|0)*MTILE+MTILE/2;
  player.L = (sv && sv.levels) ? sv.levels[0] : 0;
  cam.x=clamp(player.x-(VW/VIEW_SCALE)/2,0,Math.max(0,WORLD_W-VW/VIEW_SCALE));
  cam.y=clamp(player.y-(VH/VIEW_SCALE)/2,0,Math.max(0,WORLD_H-VH/VIEW_SCALE));
  overlay.classList.add('hidden');
  canvas.style.cursor='none';  // custom crosshair
  initZones();
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
