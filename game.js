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
let ctx = canvas.getContext('2d');   // let (não const): a tela de morte redireciona pra
                                      // um mini-canvas à parte pra reaproveitar os mesmos
                                      // helpers de desenho (drawBmpText/drawCard/drawCoinShape)
let VW=0, VH=0;
function resize(){ VW=canvas.width=innerWidth; VH=canvas.height=innerHeight; ctx.imageSmoothingEnabled=false; }
addEventListener('resize', resize); resize();


//======================= ASSETS =======================
const IMG = {};
function loadImg(k,src){ return new Promise(r=>{ const i=new Image(); i.onload=()=>{IMG[k]=i;r();}; i.onerror=()=>r(); i.src=src; }); }
const MAP_SHEETS = { 0:['tiles',16], tiles:['tiles',16], interface:['interface',16],
                     players:['players',24], enemies:['enemies',24], weapons:['weapons',24] };
function blitMap(t,x,y){
  const s=MAP_SHEETS[t[0]]||MAP_SHEETS[0], img=IMG[s[0]]; if(!img) return;
  const ts=s[1]; ctx.drawImage(img, t[1]*ts, t[2]*ts, ts, ts, x, y, MTILE, MTILE);
}
//======================= PERSONAGENS (LOJA) =======================
// Mesmas 5 skins que os bots já podem sortear (ver ENEMY_SKINS mais abaixo) — a
// primeira é a mascote padrão (grátis, já "dona"); as outras se compram com moedas
// guardadas entre partidas (ver saveData/persistSaveData).
const CHARACTERS = [
  { sheet:'players', row:0, name:'Desert Fox',      price:0 },
  { sheet:'players', row:1, name:'Sheriff Bear',    price:300 },
  { sheet:'players', row:2, name:'Lone Wolf',       price:600 },
  { sheet:'players', row:3, name:'Fugitive Rabbit', price:900 },
  { sheet:'enemies',  row:3, name:'Storm Monster',  price:1500 },
];
// ─── CrazyGames SDK bootstrap ───────────────────────────────────────────
// O namespace real é window.CrazyGames.SDK (não existe um global "SDK" solto),
// e ele PRECISA de init() explícito antes de qualquer outra chamada — sem isso
// todo método é inválido. crazySDK resolve pro objeto do SDK quando pronto, ou
// null se indisponível (fora da CrazyGames, script bloqueado, ad-blocker etc.)
// — cada callsite testa contra essa promise, então o jogo roda idêntico com ou
// sem a plataforma.
const crazySDK = (async () => {
  try{
    if(!window.CrazyGames || !window.CrazyGames.SDK) return null;
    await window.CrazyGames.SDK.init();
    return window.CrazyGames.SDK;
  }catch(e){ return null; }
})();
function withSDK(fn){ crazySDK.then(sdk=>{ if(sdk){ try{ fn(sdk); }catch(e){} } }); }

const SAVE_KEY = 'dd_save_v1';   // moedas guardadas + skins compradas — sobrevive a partidas/recargas
function parseSaveData(raw){
  const d = JSON.parse(raw);
  let owned = Array.isArray(d.owned) ? d.owned.filter(i=>Number.isInteger(i) && i>=0 && i<CHARACTERS.length) : [];
  if(!owned.includes(0)) owned.push(0);
  let selected = Number.isInteger(d.selected) ? d.selected : 0;
  if(!owned.includes(selected)) selected = 0;
  return { bank: Math.max(0, d.bank|0), owned, selected };
}
function loadSaveData(){
  try{ return parseSaveData(localStorage.getItem(SAVE_KEY)); }catch(e){ return { bank:0, owned:[0], selected:0 }; }
}
let saveData = loadSaveData();
function persistSaveData(){
  const json = JSON.stringify(saveData);
  try{ localStorage.setItem(SAVE_KEY, json); }catch(e){}   // sempre funciona, fallback offline
  withSDK(sdk => sdk.data.setItem(SAVE_KEY, json).catch(()=>{}));  // cloud save (só na plataforma)
}
// Puxa o save da nuvem da CrazyGames antes do boot terminar — se existir, sobrescreve
// o que veio do localStorage (ex: jogador trocou de navegador/dispositivo). Retorna uma
// Promise pro boot poder esperar isso resolver antes de desenhar o menu pela 1a vez.
function syncFromCloud(){
  return crazySDK.then(sdk=>{
    if(!sdk || !sdk.data || !sdk.data.getItem) return;
    return sdk.data.getItem(SAVE_KEY).then(v=>{
      if(!v) return;
      try{ saveData = parseSaveData(v); }catch(e){}
    }).catch(()=>{});
  }).catch(()=>{});
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
  critterSpawners = (MAP.critterSpawns||[]).map(s=>({
    c:s.c, r:s.r, L:s.L|0, qty:Math.max(1,s.qty|0)||3, maxAlive:Math.max(1,s.maxAlive|0)||6,
    timer:0, everSpawned:false, hasKillSinceWave:false }));
  critters = [];
  critterSplashes = [];
  critterHealPops = [];
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
  if(v>=200 && v<210) return {kind:'spawn', levels:[v-200]};   // spawn num andar elevado
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
    const M = B.kind==='spawn' ? B.levels[0] : B.level;
    if(M===L) return L;
    if(A && A.kind==='escada' && A.levels.includes(L) && A.levels.includes(M)) return M;
    return bridge ? L : null;
  }
  return bridge ? L : null;
}

//======================= PLAYER =======================
const player = { x:0, y:0, L:0, skin:0, sheet:'players', animT:0, frame:0, moving:false, flip:false, hp:100, armor:100,
  heading:-Math.PI/2, headingS:-Math.PI/2,   // direção de MOVIMENTO (alvo + suavizada) — bússola/minimapa
  facaCooldown:0, facaSwingT:0, facaSwingAng:0 };   // faca automática (ver updateMelee)
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
  pistola:  { nome:'Pistol',   spr:0, auto:false, rate:0.32, pellets:1, spread:0.020, recoil:2.0, shake:0.7,  speed:35, flash:0.8,
              snd:{vol:0.09, body:0.10, f1:1800, f2:200, sub:0.06} },
  magnum:   { nome:'Magnum',   spr:1, auto:false, rate:0.50, pellets:1, spread:0.012, recoil:3.6, shake:1.3,  speed:40, flash:1.1,
              snd:{vol:0.12, body:0.14, f1:1400, f2:150, sub:0.09} },
  uzi:      { nome:'Uzi',      spr:2, auto:true,  rate:0.075,pellets:1, spread:0.100, recoil:1.1, shake:0.35, speed:32, flash:0.6,
              snd:{vol:0.05, body:0.06, f1:2200, f2:400, sub:0.03} },
  sniper:   { nome:'Sniper',   spr:3, auto:false, rate:1.15, pellets:1, spread:0.000, recoil:5.5, shake:2.0,  speed:55, flash:1.5,
              snd:{vol:0.16, body:0.28, f1:900,  f2:80,  sub:0.14} },
  carabina: { nome:'Carbine',  spr:4, auto:true,  rate:0.16, pellets:1, spread:0.050, recoil:1.7, shake:0.6,  speed:36, flash:0.8,
              snd:{vol:0.08, body:0.09, f1:2000, f2:300, sub:0.05} },
  fuzil:    { nome:'Rifle',    spr:5, auto:true,  rate:0.125,pellets:1, spread:0.065, recoil:2.2, shake:0.85, speed:38, flash:0.9,
              snd:{vol:0.09, body:0.11, f1:1700, f2:250, sub:0.07} },
  smg:      { nome:'SMG',      spr:6, auto:true,  rate:0.09, pellets:1, spread:0.120, recoil:1.0, shake:0.3,  speed:30, flash:0.55,
              snd:{vol:0.045,body:0.05, f1:2400, f2:500, sub:0.025} },
  escopeta: { nome:'Shotgun',  spr:7, auto:false, rate:0.90, pellets:6, spread:0.220, recoil:4.8, shake:1.7,  speed:30, flash:1.4,
              snd:{vol:0.14, body:0.20, f1:1100, f2:120, sub:0.12} },
  // ── Arma branca PASSIVA (golpe automático, ver updateMelee): não entra no ciclo
  // de troca/disparo normal — `rate` aqui é o cooldown entre golpes. Cada tipo de
  // personagem golpeia com uma delas (ver MELEE_BY_SKIN) — funcionam TODAS igual
  // (mesmo dano/alcance/cadência/som), só o sprite muda; os machados (linha 2 da
  // folha weapons) desenham um pouco maiores que as facas (`scale`), que é como a
  // folha original já os diferencia. `row` = linha na folha weapons (24px), padrão 0.
  faca:     { nome:'Knife',   spr:8, row:0, dmg:40, range:MTILE*1.35, rate:5.0,
              snd:{vol:0.07, body:0.05, f1:2600, f2:900, sub:0.02} },
  faca2:    { nome:'Knife',   spr:8, row:1, dmg:40, range:MTILE*1.35, rate:5.0,
              snd:{vol:0.07, body:0.05, f1:2600, f2:900, sub:0.02} },
  machado:  { nome:'Axe',     spr:9, row:0, scale:1.28, dmg:40, range:MTILE*1.35, rate:5.0,
              snd:{vol:0.07, body:0.05, f1:2600, f2:900, sub:0.02} },
  machado2: { nome:'Axe',     spr:9, row:1, scale:1.28, dmg:40, range:MTILE*1.35, rate:5.0,
              snd:{vol:0.07, body:0.05, f1:2600, f2:900, sub:0.02} },
};
// Qual arma branca cada personagem usa — chave é "sheet,row" (mesmo par usado em
// CHARACTERS/ENEMY_SKINS): raposo = faca padrão, urso = a outra faca, lobo e coelho
// = machado laranja, monstro = o outro machado.
const MELEE_BY_SKIN = {
  'players,0': 'faca',
  'players,1': 'faca2',
  'players,2': 'machado',
  'players,3': 'machado',
  'enemies,3': 'machado2',
};
function meleeIdFor(ent){
  const row = ent===player ? ent.skin : ent.row;
  return MELEE_BY_SKIN[ent.sheet+','+row] || 'faca';
}
let gun = 'pistola';        // arma atual do player
let gunItems = [];          // armas colocadas no cenário (vindas do editor): {c,r,t,bob}
// Dropa a arma de quem morreu no chão — só se não for a pistola inicial (senão o
// mapa ia encher de pistola, já que todo mundo começa com uma).
function dropWeaponOnDeath(x, y, gunId){
  if(!gunId || gunId==='pistola' || !WEAPONS[gunId]) return;
  gunItems.push({ c:Math.floor(x/MTILE), r:Math.floor(y/MTILE), t:gunId, bob:Math.random()*6.28 });
}
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
// ── Moedas: bicho mata=3, abate=20, baú normal=50/dourado=100, sobreviver=1000 ──
// Voam do local do evento até quem ganhou (player OU bot — mesma lógica do "+10" de
// cura do bicho, que já segue o matador vivo até chegar) — só quem é o player conta
// pro contador do HUD e toca o som em volume cheio; bot ganhando só tem o visual.
let coins = 0;
let coinPops = [];                  // {fx,fy,tx,ty,to,t,delay,dur,give,collected}
let coinPulseT = 999, coinBurstT = 999;   // pulso/brilho do chip de moedas (mesmo padrão do de abates)
let matchWon = false;               // só premia a vitória uma vez por partida
let victoryTimer = -1;               // conta regressiva pós-vitória até congelar a tela
const COINS_CRITTER = 1, COINS_KILL = 10, COINS_CHEST_NORMAL = 10, COINS_CHEST_GOLD = 20, COINS_WIN = 400;
function addCoins(amount, x, y, to){
  if(amount<=0 || !to) return;
  const n = clamp(Math.round(amount/6), 1, 6);   // várias moedinhas visuais em drops grandes, sem exagerar
  let given = 0;
  for(let i=0;i<n;i++){
    const give = i===n-1 ? amount-given : Math.round(amount/n);
    given += give;
    const ang = Math.random()*6.28, jit = 5+Math.random()*10;
    coinPops.push({
      // Cada moeda sai de um pontinho espalhado ao redor do evento (não todas do
      // mesmo pixel) e faz uma curva lateral própria (side) — sem isso, todas viajam
      // pela mesma linha reta e parecem 1 moeda só grudada, não "várias".
      fx:x+Math.cos(ang)*jit, fy:y+Math.sin(ang)*jit, tx:to.x, ty:to.y-6, to,
      side: (Math.random()*2-1) * (20+Math.random()*28),
      t:0, delay:i*0.09, dur:0.55, give, collected:false,
    });
  }
}
function updateCoinPops(dt){
  coinPulseT += dt; coinBurstT += dt;
  for(const p of coinPops){
    if(p.delay>0){ p.delay = Math.max(0, p.delay-dt); continue; }
    p.t += dt;
    if(p.to && p.to.hp>0){ p.tx=p.to.x; p.ty=p.to.y-6; }   // segue quem ganhou até chegar
    if(!p.collected && p.t >= p.dur){
      p.collected = true;
      const isPlayer = p.to===player;
      if(isPlayer){ coins += p.give; coinPulseT = 0; coinBurstT = 0; }
      coinCollectSound(isPlayer ? 1 : gunshotAtten(p.tx, p.ty));
    }
  }
  coinPops = coinPops.filter(p => p.delay>0 || p.t < p.dur+0.15);
}
// Moeda em pixel art de verdade (blocos sólidos, sem curva/gradiente) — combina com o
// resto do jogo, que é tudo sprite pixelado. 7x7, 3 cores só.
const COIN_PIXELS = [
  '..111..',
  '.12221.',
  '1222321',
  '1233221',
  '1222221',
  '.12221.',
  '..111..',
];
const COIN_PIX_COLORS = {'1':'#8a5a12', '2':'#f2c14e', '3':'#fff6d0'};
function drawCoinSilhouette(n, px, color){
  ctx.fillStyle = color;
  for(let ry=0; ry<n; ry++){
    const row = COIN_PIXELS[ry];
    for(let rx=0; rx<row.length; rx++){
      if(row[rx]==='.') continue;
      ctx.fillRect(Math.round(rx*px), Math.round(ry*px), Math.ceil(px)+1, Math.ceil(px)+1);
    }
  }
}
function drawCoinShape(size){
  const n = COIN_PIXELS.length, px = size/n;
  ctx.save();
  ctx.translate(-size/2, -size/2);
  // Contorno escuro: desenha a silhueta inteira deslocada nas 4 direções antes da
  // moeda colorida — sem isso ela some contra o fundo (areia é um tom parecido).
  const off = Math.max(1, px*0.9);
  [[off,0],[-off,0],[0,off],[0,-off]].forEach(([ox,oy])=>{
    ctx.save(); ctx.translate(ox,oy); drawCoinSilhouette(n, px, '#5c3a06'); ctx.restore();
  });
  for(let ry=0; ry<n; ry++){
    const row = COIN_PIXELS[ry];
    for(let rx=0; rx<row.length; rx++){
      const c = COIN_PIX_COLORS[row[rx]];
      if(!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(rx*px), Math.round(ry*px), Math.ceil(px)+1, Math.ceil(px)+1);
    }
  }
  ctx.restore();
}
// Voa em curva própria até quem ganhou (mesmo espírito do "+10" de cura do bicho) —
// pop de escala na saída e na chegada, sem suavizar/rotacionar o sprite (pixel art
// fica borrado se girar/escalar em ângulo — só escala uniforme, que mantém nítido).
function drawCoinPopsWorld(){
  for(const p of coinPops){
    if(p.delay>0) continue;
    const k = clamp(p.t/p.dur, 0, 1), ease = 1-(1-k)*(1-k);
    const dx = p.tx-p.fx, dy = p.ty-p.fy, len = Math.hypot(dx,dy)||1;
    const perpX = -dy/len, perpY = dx/len;
    const bulge = Math.sin(k*Math.PI) * p.side;
    const x = p.fx + dx*ease + perpX*bulge;
    const y = p.fy + dy*ease + perpY*bulge - Math.sin(k*Math.PI)*8;
    const sc = k<0.15 ? k/0.15 : (k>0.8 ? Math.max(0,1-(k-0.8)/0.2) : 1);
    if(sc<=0) continue;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y)); ctx.scale(sc, sc);
    drawCoinShape(6);
    ctx.restore();
  }
}
function coinCollectSound(atten=1){
  // "Clink" metálico curto e brilhante — toca quando a moedinha chega e conta pro total
  if(atten<=0) return;
  ensureAudio();
  const t=audioCtx.currentTime;
  [[1760,0],[2350,0.03]].forEach(([f,d])=>{
    const o=audioCtx.createOscillator(); o.type='sine'; o.frequency.setValueAtTime(f,t+d);
    const g=audioCtx.createGain(); g.gain.setValueAtTime(0.0001,t+d);
    g.gain.exponentialRampToValueAtTime(0.09*atten,t+d+0.01); g.gain.exponentialRampToValueAtTime(0.001,t+d+0.14);
    o.connect(g); g.connect(masterGain); o.start(t+d); o.stop(t+d+0.16);
  });
}
const PLAYER_NAME = '★ you';
let killFeed = [];                   // {victim,killer,t,dur} — mini chat de abates no canto esquerdo
const KILL_FEED_DUR = 6;            // segundos que cada entrada fica visível
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
// ── Faca automática: golpe passivo corpo-a-corpo, sem clique/decisão de IA — ver
// updateMelee(). Qual arma branca cada um usa vem de MELEE_BY_SKIN/meleeIdFor
// (é por personagem, não uma escolha manual) — existe à parte da arma equipada.
const MELEE_SWING_DUR = 0.32;   // duração visual do golpe (sprite varrendo o arco)
let fireLatch = false;      // semi-auto: exige soltar o clique entre tiros
let flashT = 0, flashAng = 0, flashMx = 0, flashMy = 0;  // muzzle flash (posição do cano no tiro)

// Shooting juice state
let recoilForce = 0;        // current recoil offset (decays)
let bullets = [];           // projectiles: {x,y,vx,vy,life}
let hits = [];              // impact sparks at target
let smoke = [];             // pegadas no chão
let footprintDist = 0;       // distância acumulada para spawn de pegada
let playerStuckTimer = 0;    // travado numa quina (ver forceUnstick)
let shakePhase = 0;          // screen shake damped oscillation
let fireCooldown = 0;       // time until next shot allowed
// ── SUPERAQUECIMENTO: atirar esquenta o cano; estourou = trava até esfriar ──
let gunHeat = 0;            // calor da arma atual (0..1)
let gunOverheat = false;    // travada fumegando até esfriar
let overheatFlash = 0;      // pop visual do momento do estouro
let healAura = 0;           // aura verde ao curar (0→desaparece)
// Mover genérico por eixo — usado pelo player E pelos bots, garante que ambos
// respeitem exatamente as mesmas regras de colisão/piso/escada/ponte.
// Devolve true/false (passo aceito ou bloqueado) — o player ignora o retorno,
// os bots usam pra detectar "travado" e forçar um replan de rota.
function moveEntityAxis(ent, nx, ny, horiz){
  const cc={c:Math.floor(ent.x/MTILE), r:Math.floor(ent.y/MTILE)};
  const fromVal=collAt(cc.c,cc.r);
  const lead = horiz ? {c:Math.floor((nx+Math.sign(nx-ent.x)*PLAYER_R)/MTILE), r:cc.r}
                     : {c:cc.c, r:Math.floor((ny+Math.sign(ny-ent.y)*PLAYER_R)/MTILE)};
  const res=canStep(fromVal, ent.L, collAt(lead.c,lead.r), overAt(lead.c,lead.r));
  if(res===null) return false;
  if(horiz) ent.x=nx; else ent.y=ny;
  const nc=Math.floor(ent.x/MTILE), nr=Math.floor(ent.y/MTILE);
  const nv=collInfo(collAt(nc,nr));                    // pisar num piso adota o nível — ponte ativa nunca muda
  if(!bridgeActive(overAt(nc,nr),ent.L) && nv && nv.kind!=='escada')
    ent.L = nv.kind==='spawn' ? nv.levels[0] : nv.level;
  return true;
}
function moveAxis(nx,ny,horiz){ return moveEntityAxis(player, nx, ny, horiz); }
// ── Paliativo de travamento: acha uma célula andável bem perto (mesmo nível) e "chuta"
// a entidade pra lá — usado quando ela fica tempo demais sem progredir de verdade numa
// quina/reentrância do mapa (bug de colisão numa diagonal, não falta de tentativa).
// Serve pro player (que trava parado sem conseguir sair de certos cantos do mapa) e
// pros bots (reforça o replan de rota — trocar de alvo não adianta se a quina em si
// continuar no caminho).
function findEscapeCell(ent){
  const c0=Math.floor(ent.x/MTILE), r0=Math.floor(ent.y/MTILE);
  for(let ring=1; ring<=4; ring++){
    for(let dr=-ring; dr<=ring; dr++) for(let dc=-ring; dc<=ring; dc++){
      if(Math.max(Math.abs(dc),Math.abs(dr))!==ring) continue;
      const c=c0+dc, r=r0+dr;
      if(canEnterCell(c0,r0,ent.L,c,r)!==null) return {c,r};
    }
  }
  return null;
}
function forceUnstick(ent){
  const cell = findEscapeCell(ent);
  if(!cell) return false;
  ent.x = cell.c*MTILE+MTILE/2; ent.y = cell.r*MTILE+MTILE/2;
  return true;
}
// "Travado de verdade" pra quem tenta andar num eixo só (reto, sem diagonal — o caso
// mais comum em corredor/escada estreita): se dx===0, okY sozinho SEMPRE dá true (é um
// não-passo, "ainda tô na mesma célula", não prova nada), então checar "!okX && !okY"
// cru nunca detecta um bloqueio de eixo único — é exatamente por isso que o bot fica
// parado preso na parede sem nunca acionar o forceUnstick. Só conta como bloqueado o
// eixo que realmente tentou andar (delta != 0); se todo eixo tentado falhou, travou.
function movementBlocked(dx, dy, okX, okY){
  const EPS = 0.5;   // px — resíduo de chegada não conta como "tentando" andar nesse eixo
  const triedX = Math.abs(dx)>EPS, triedY = Math.abs(dy)>EPS;
  if(!triedX && !triedY) return false;
  return (!triedX || !okX) && (!triedY || !okY);
}
// Corrige quem ficou cravado num colisor de bloqueio (canto entre duas paredes que o
// check por eixo/lead do moveEntityAxis não pega, ou empurrão entre corpos que jogou
// alguém pra dentro de uma parede — aquele empurrão não valida colisão). Roda toda vez
// e não faz nada quando não há sobreposição, então é seguro chamar sempre.
function unstickFromBlocks(ent){
  const cc=Math.floor(ent.x/MTILE), rr=Math.floor(ent.y/MTILE);
  let corrX=0, corrY=0, hit=false;
  for(let dr=-1; dr<=1; dr++){
    for(let dc=-1; dc<=1; dc++){
      const c=cc+dc, r=rr+dr;
      if((collInfo(collAt(c,r))||{}).kind !== 'block') continue;
      const left=c*MTILE, top=r*MTILE, right=left+MTILE, bottom=top+MTILE;
      const nx=Math.min(Math.max(ent.x,left),right), ny=Math.min(Math.max(ent.y,top),bottom);
      const dx=ent.x-nx, dy=ent.y-ny, dist=Math.hypot(dx,dy);
      if(dist >= PLAYER_R) continue;                    // não sobrepõe esse bloqueio
      hit = true;
      if(dist > 0.0001){
        const push=PLAYER_R-dist;
        corrX += dx/dist*push; corrY += dy/dist*push;
      } else {
        // Centro cravado dentro do bloco — escapa pelo eixo com menor penetração.
        const dL=ent.x-left, dR=right-ent.x, dT=ent.y-top, dB=bottom-ent.y;
        const m=Math.min(dL,dR,dT,dB);
        if(m===dL) corrX -= dL+PLAYER_R; else if(m===dR) corrX += dR+PLAYER_R;
        else if(m===dT) corrY -= dT+PLAYER_R; else corrY += dB+PLAYER_R;
      }
    }
  }
  if(hit){ ent.x += corrX; ent.y += corrY; }
}
function step(dt){
  if(introWipe){ introWipe.t += dt; if(introWipe.t >= introWipe.dur) introWipe = null; }
  elapsedT += dt;
  updateZone(dt);
  maybeRespawnEnemies(dt);
  // Último de pé: todo mundo mais morreu e o player ainda tá vivo — só premia 1x.
  // Não congela na hora: espera a animação das 1000 moedas terminar de "cair" antes
  // de travar a tela de vitória (ver victoryTimer).
  if(!matchWon && player.hp>0 && enemies.length>0 && enemies.every(e=>e.st!=='alive')){
    matchWon = true;
    addCoins(COINS_WIN, player.x, player.y-20, player);
    victoryTimer = 1.3;
  }
  if(victoryTimer > 0){
    victoryTimer -= dt;
    if(victoryTimer <= 0) showVictoryScreen();
  }
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
  if(player.hp>0){                                     // morto não anda, não mira, não atira
    let dx=0,dy=0;
    if(keys['w']||keys['arrowup'])dy--;   if(keys['s']||keys['arrowdown'])dy++;
    if(keys['a']||keys['arrowleft'])dx--; if(keys['d']||keys['arrowright'])dx++;
    player.moving=!!(dx||dy);
    if(player.moving){
      const l=Math.hypot(dx,dy), s=SPEED*dt;
      if(dx) player.flip = dx<0;
      player.heading = Math.atan2(dy, dx);               // direção do movimento (WASD)
      const okX = moveAxis(player.x+dx/l*s, player.y, true);
      const okY = moveAxis(player.x, player.y+dy/l*s, false);
      // Travado de verdade (nenhum eixo que tentou andar teve sucesso) — depois de
      // 0.8s force sair da quina.
      playerStuckTimer = movementBlocked(dx,dy,okX,okY) ? playerStuckTimer+dt : 0;
      if(playerStuckTimer > 0.8){ if(forceUnstick(player)) playerStuckTimer = 0; }
    } else {
      playerStuckTimer = 0;
    }
  }
  // ── Inimigos: IA (decide, anda, mira, atira, pega arma), timers ──
  aiPathBudget = 0; aiUrgentPathBudget = 0;   // orçamento de buscas A* deste frame, repartido entre todos os bots
  for(const e of enemies){
    e.flashT = Math.max(0, e.flashT - dt);
    e.muzzleFlashT = Math.max(0, (e.muzzleFlashT||0) - dt);
    if(e.st==='dead'){ e.deathT = (e.deathT||0) + dt; continue; }   // corpo some depois de CORPSE_LIFETIME
    if(e.st!=='alive') continue;                       // corpo morto não pensa nem colide
    // Faca automática: independe da IA/FSM — dispara sozinha por proximidade.
    updateMelee(e, dt, hostileList(e));
    // Recarga do escudo — igual ao do player: 5s sem tomar dano, depois regenera 10/s
    if(e.armor < e.maxArmor){
      e.shieldRechargeTimer += dt;
      if(e.shieldRechargeTimer >= 5) e.armor = Math.min(e.maxArmor, e.armor + dt*10);
    } else {
      e.shieldRechargeTimer = 0;
    }
    // Superaquecimento da arma — mesma regra do player: esfria sozinho, mais rápido
    // depois de travar (gunOverheat), até liberar de novo em 30% de calor.
    e.gunHeat = Math.max(0, (e.gunHeat||0) - dt*(e.gunOverheat ? 0.30 : 0.20));
    if(e.gunOverheat && e.gunHeat <= 0.30) e.gunOverheat = false;
    e.overheatFlash = Math.max(0, (e.overheatFlash||0) - dt);
    // Kit médico — igual ao player: usa quando HP baixo (≤40%), cura 50, aura verde
    e.healAura = Math.max(0, (e.healAura||0) - dt);
    if(e.medkits>0 && e.hp>0 && e.hp<=40){
      e.medkits--; e.hp = Math.min(e.maxHp, e.hp+50);
      e.healAura = 1.5;
      chestSound(gunshotAtten(e.x, e.y));   // mesmo som do player ao curar
    }
    // Dano da zona/tempestade — mesma regra do player, só que cada bot tem seu próprio
    // timer (não existia antes: bot nunca sofria dano da zona, então nunca tinha motivo
    // de verdade pra fugir dela).
    if(zoneCurrent && zoneState!=='idle'){
      const distZ = Math.hypot(e.x-zoneCurrent.cx, e.y-zoneCurrent.cy);
      if(zoneCurrent.r<=0 || distZ>zoneCurrent.r){
        e.zoneDmgTimer = (e.zoneDmgTimer||0) + dt;
        if(e.zoneDmgTimer >= ZONE_DMG_TICK){
          e.zoneDmgTimer -= ZONE_DMG_TICK;
          const dmgZ = zoneNum < 5 ? 1 : zoneNum + 2;
          damageEnemy(e, dmgZ, e.x, e.y-6, null);
          if(e.st!=='alive') continue;
        }
      } else {
        e.zoneDmgTimer = 0;
      }
    }
    e.moving = false;
    updateBotAI(e, dt);
    botCheckGunPickup(e);
    e.animT += dt;
    e.frame = e.moving ? 1+(Math.floor(e.animT*8)%2) : 0;
    // Pegadas no chão — mesma regra do player, só que sem o som (evita 49 bots
    // tocando passo ao mesmo tempo). Bicho não entra aqui, tem o jeito dele.
    if(e.moving){
      e.footprintDist = (e.footprintDist||0) + AI_BOT_SPEED*dt;
      if(e.footprintDist >= MTILE*0.75){
        e.footprintDist = 0;
        smoke.push({ x: e.x, y: e.y+2, life: 0.8+Math.random()*0.4 });
      }
    } else {
      e.footprintDist = MTILE*0.75;
    }
  }
  // ── Bicho: leva (spawner) + andança lenta própria — some da lista já morto ──
  updateCritterSpawners(dt);
  for(const cr of critters) if(cr.st!=='dead') updateCritter(cr, dt);
  if(critters.some(cr=>cr.st==='dead')) critters = critters.filter(cr=>cr.st!=='dead');
  // Empurrão entre bichos — não se atravessam entre si (não mexe com player/bot).
  // Cada eixo só aceita o empurrão se o destino continuar num chão válido pro bicho.
  {
    const min = SPR;   // asset cheio do bicho — não é menor que o sprite
    for(let i=0;i<critters.length;i++){
      const a = critters[i];
      for(let j=i+1;j<critters.length;j++){
        const b = critters[j];
        const dx=a.x-b.x, dy=a.y-b.y, d=Math.hypot(dx,dy);
        if(d>0.001 && d<min){
          const push=(min-d)/2, nx=dx/d, ny=dy/d;
          const ax=a.x+nx*push, ay=a.y+ny*push, bx=b.x-nx*push, by=b.y-ny*push;
          if(critterCanStep(collAt(Math.floor(ax/MTILE), Math.floor(a.y/MTILE)), a.L)) a.x=ax;
          if(critterCanStep(collAt(Math.floor(a.x/MTILE), Math.floor(ay/MTILE)), a.L)) a.y=ay;
          if(critterCanStep(collAt(Math.floor(bx/MTILE), Math.floor(b.y/MTILE)), b.L)) b.x=bx;
          if(critterCanStep(collAt(Math.floor(b.x/MTILE), Math.floor(by/MTILE)), b.L)) b.y=by;
        }
      }
    }
  }
  updateCritterSplashes(dt);
  updateCritterHealPops(dt);
  updateKillFeed(dt);
  // Empurrão entre corpos — player e bots agora se movem, então o afastamento é
  // simétrico (cada um cede metade), diferente de quando só o player se mexia.
  // Player morto sai da lista (corpo não empurra ninguém, igual bot morto).
  const bodies = player.hp>0 ? [player] : [];
  for(const e of enemies) if(e.st==='alive') bodies.push(e);
  {
    const min = PLAYER_R*2;
    for(let i=0;i<bodies.length;i++){
      for(let j=i+1;j<bodies.length;j++){
        const a=bodies[i], b=bodies[j];
        const dx=a.x-b.x, dy=a.y-b.y, d=Math.hypot(dx,dy);
        if(d>0.001 && d<min){
          const push=(min-d)/2, nx=dx/d, ny=dy/d;
          a.x+=nx*push; a.y+=ny*push; b.x-=nx*push; b.y-=ny*push;
        }
      }
    }
  }
  // Corrige quem ficou cravado num colisor de bloqueio (o empurrão acima não valida
  // colisão, então pode jogar alguém pra dentro de uma parede vizinha).
  for(const b of bodies) unstickFromBlocks(b);
  // Suaviza heading (bússola e minimapa seguem o movimento, não o mouse)
  let hd = player.heading - player.headingS;
  hd = Math.atan2(Math.sin(hd), Math.cos(hd));          // normaliza para [-PI, PI]
  player.headingS += hd * Math.min(1, dt * 14);
  if(player.hp>0){
    player.animT+=dt; player.frame = player.moving ? 1+(Math.floor(player.animT*8)%2) : 0;
  }   // morto: frame fica travado em PLAYER_DEAD (setado 1x em killPlayer)

  // ── Pegar arma do chão (troca AO ENTRAR no item; parado em cima não re-troca) ──
  let curOverlap = -1;
  if(player.hp>0) for(let gi=0; gi<gunItems.length; gi++){
    const it=gunItems[gi];
    if(!it.t) continue;   // slot vazio (pistola descartada num swap — não fica largada)
    const gx=it.c*MTILE+MTILE/2, gy=it.r*MTILE+MTILE/2;
    if(Math.hypot(player.x-gx, player.y-gy) < MTILE*0.6){ curOverlap=gi; break; }
  }
  if(curOverlap!==-1 && curOverlap!==overlapGun){
    const it=gunItems[curOverlap];
    const old=gun; gun=it.t;
    it.t = old==='pistola' ? null : old;   // pistola descartada só some, não fica largada
    fireCooldown=0; fireLatch=false;
    gunHeat=0; gunOverheat=false;                      // arma do chão tá fria — trocar esfria!
    pickupSound();
    // Animação de troca: bounce de escala
    swapAnim={t:0, total:0.18};
  }
  overlapGun = curOverlap;

  // ── Baús: aproximar → carrega → abre e as armas saltam (player OU bot, primeiro a chegar) ──
  for(const b of chests){
    const bx=b.c*MTILE+MTILE/2, by=b.r*MTILE+MTILE/2;
    if(b.st==='closed'){
      let claimant = (player.hp>0 && Math.hypot(player.x-bx, player.y-by) < CHEST_RANGE) ? player : null;
      if(!claimant) for(const e of enemies){
        if(e.st==='alive' && Math.hypot(e.x-bx, e.y-by) < CHEST_RANGE){ claimant=e; break; }
      }
      if(claimant){ b.st='charging'; b.t=0; b.chargedBy=claimant; }
    } else if(b.st==='charging'){
      const cb = b.chargedBy;
      const inRange = cb && (cb===player ? cb.hp>0 : cb.st==='alive') && Math.hypot(cb.x-bx, cb.y-by) < CHEST_RANGE;
      if(inRange){
        b.t+=dt;
        if(b.t>=CHEST_CHARGE[b.v]){
          b.st='open'; b.t=0; b.chargedBy=null;
          chestSound(cb===player ? 1 : gunshotAtten(bx, by));
          scatterChestLoot(b);
          addCoins(b.v===1 ? COINS_CHEST_GOLD : COINS_CHEST_NORMAL, bx, by-8, cb);
        }
      } else {
        b.st='closed'; b.t=0; b.chargedBy=null;   // saiu do alcance/morreu = reseta
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
  // Disparo: balas atravessam por baixo da ponte
  const aimAng = Math.atan2(mouse.wy - (player.y-6), mouse.wx - player.x);
  if(mouse.down && fireCooldown <= 0 && !gunOverheat && state=="playing" && (w.auto || !fireLatch)){
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
  // ── Faca automática: independe do gatilho/gun — dispara sozinha por proximidade ──
  if(player.hp>0) updateMelee(player, dt, hostileList(player));
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
    spawnSparks(nx, ny, b.vx, b.vy, b.level);
  }}
  bullets = bullets.filter(b => b.life > 0);
  for(const h of hits){ h.life -= dt; }
  hits = hits.filter(h => h.life > 0);
  // Números de dano: sobem rápido e "pairam" (vy decai pra zero)
  for(const p of dmgPops){
    p.t += dt; p.x += p.vx*dt; p.y += p.vy*dt;
    p.vy += (0 - p.vy)*Math.min(1, dt*5);
  }
  dmgPops = dmgPops.filter(p => p.t < p.dur);
  // Caveira de abate: sobe do corpo e depois voa até o contador de ABATES
  updateDeathPops(dt);
  updateShieldBreaks(dt);
  updateCoinPops(dt);
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

  // Camera: segue o player ou, se morto, o último inimigo da corrente (quem te
  // matou → quem matou ele → …), trocando na hora quando o atual morre.
  if(player.hp>0) spectator = null;
  else if(spectator && spectator.st!=='alive') spectator = null;
  const lookAt = player.hp>0 ? player : spectator;
  let shakeX=0, shakeY=0, tx=0, ty=0;
  if(lookAt){
    if(player.hp>0){ shakeX = Math.sin(shakePhase*55)*shakePhase*1.5; shakeY = Math.cos(shakePhase*67)*shakePhase*1; }
    tx=clamp(lookAt.x-(VW/VIEW_SCALE)/2, 0, Math.max(0,WORLD_W-VW/VIEW_SCALE));
    ty=clamp(lookAt.y-(VH/VIEW_SCALE)/2, 0, Math.max(0,WORLD_H-VH/VIEW_SCALE));
  }
  cam.x+=(tx-cam.x)*0.04; cam.y+=(ty-cam.y)*0.04;  // delay generoso — câmera bem solta
  cam.x += shakeX; cam.y += shakeY;  // direct offset, returns to 0 naturally
}

// Synth gunshot sound — layered for a punchy pixel-art feel (Web Audio, no files)
let audioCtx=null;
// masterGain fica entre TODO som sintetizado e a saída — um único nó pra ligar/desligar
// tudo de uma vez, sem precisar tocar em cada função de som. É como o mute do painel
// de configurações da CrazyGames (SDK.game.settings.muteAudio) consegue silenciar o
// jogo inteiro sem o jogo saber de cada oscillator individualmente (ver applySdkMute).
let masterGain=null;
let sdkMuted=false;
// Alguns navegadores (Safari/iOS em especial) criam o AudioContext já "suspended"
// mesmo dentro do gesto de clique — sem isso o som simplesmente não toca, sem erro
// nenhum no console. resume() é seguro de chamar sempre (no-op se já tiver rodando).
function ensureAudio(){
  if(!audioCtx){
    audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    masterGain=audioCtx.createGain();
    masterGain.gain.value = sdkMuted ? 0 : 1;
    masterGain.connect(masterGain);
  }
  if(audioCtx.state==='suspended') audioCtx.resume();
  return audioCtx;
}
function applySdkMute(muted){
  sdkMuted = !!muted;
  if(masterGain) masterGain.gain.value = sdkMuted ? 0 : 1;
}
addEventListener('pointerdown', ensureAudio);
addEventListener('keydown', ensureAudio);
// Lê o mute atual assim que o SDK estiver pronto e escuta mudanças (o jogador pode
// mutar pelo painel da CrazyGames a qualquer momento, não só na tela de loading).
withSDK(sdk=>{
  if(sdk.game && sdk.game.settings) applySdkMute(sdk.game.settings.muteAudio);
  if(sdk.game && sdk.game.addSettingsChangeListener){
    sdk.game.addSettingsChangeListener(settings => applySdkMute(settings.muteAudio));
  }
});
// Clique de UI (menu/tela de morte) — "tap" seco e curto, com um segundo tom mais
// grave pro hover/nav (setas de personagem) pra diferenciar de uma ação "forte" (comprar/jogar).
function uiClickSound(kind='tap'){
  const audioCtx = ensureAudio();
  const t=audioCtx.currentTime;
  const profiles = {
    tap:  [[880,0.05]],           // navegação (setas, seleção) — clique neutro
    confirm: [[660,0.07],[990,0.09]],  // ação positiva (comprar, play, revive) — dois tons subindo
    back: [[520,0.06]],            // ação neutra/secundária (fechar, cancelar)
  };
  const notes = profiles[kind] || profiles.tap;
  notes.forEach(([f,vol])=>{
    const o=audioCtx.createOscillator(); o.type='triangle'; o.frequency.setValueAtTime(f,t);
    const g=audioCtx.createGain(); g.gain.setValueAtTime(0.0001,t);
    g.gain.exponentialRampToValueAtTime(vol,t+0.008); g.gain.exponentialRampToValueAtTime(0.0001,t+0.09);
    o.connect(g); g.connect(masterGain); o.start(t); o.stop(t+0.1);
  });
}
// Alcance de audição de tiro alheio (~50 "metros" = 50 tiles) e o quanto mais abafado
// um tiro de outro personagem soa em relação ao seu próprio (sempre no volume cheio).
const AUDIO_HEARING_RANGE = MTILE*30;
const OTHER_GUNSHOT_VOLUME = 0.3;
function gunshotAtten(sx, sy){
  // Fator de volume (0..1) de um tiro disparado em (sx,sy), do ponto de vista do player.
  const d = Math.hypot(sx-player.x, sy-player.y);
  if(d >= AUDIO_HEARING_RANGE) return 0;
  const k = 1 - d/AUDIO_HEARING_RANGE;
  return k*k * OTHER_GUNSHOT_VOLUME;   // queda quadrática — já fica abafado bem antes do limite
}
function gunSound(s, atten=1){
  // s = perfil da arma: {vol, body, f1, f2, sub} — cada arma soa diferente
  // atten = fator de volume (0..1) — 1 pro seu próprio tiro, menor (por distância) pros outros
  if(atten<=0) return;
  ensureAudio();
  const t=audioCtx.currentTime;
  const vol=s.vol*atten, sub=s.sub*atten;
  // ── Sharp attack click (firing pin) ──
  const clk=audioCtx.createOscillator(); clk.type='square'; clk.frequency.setValueAtTime(2400,t); clk.frequency.exponentialRampToValueAtTime(600,t+0.01);
  const cg=audioCtx.createGain(); cg.gain.setValueAtTime(vol*0.9,t); cg.gain.exponentialRampToValueAtTime(0.001,t+0.015);
  clk.connect(cg); cg.connect(masterGain);
  clk.start(t); clk.stop(t+0.015);
  // ── Noise body (the "bang") ──
  const len=s.body, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.12));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const gain=audioCtx.createGain(); gain.gain.setValueAtTime(vol,t); gain.gain.exponentialRampToValueAtTime(0.001,t+len);
  const bp=audioCtx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.setValueAtTime(s.f1,t); bp.frequency.exponentialRampToValueAtTime(s.f2,t+len);
  bp.Q.setValueAtTime(1.2,t);
  src.connect(bp); bp.connect(gain); gain.connect(masterGain);
  src.start(t); src.stop(t+len);
  // ── Sub punch ──
  const osc=audioCtx.createOscillator(); osc.type='sine'; osc.frequency.setValueAtTime(90,t); osc.frequency.exponentialRampToValueAtTime(25,t+0.05);
  const og=audioCtx.createGain(); og.gain.setValueAtTime(sub,t); og.gain.exponentialRampToValueAtTime(0.001,t+0.05);
  osc.connect(og); og.connect(masterGain);
  osc.start(t); osc.stop(t+0.05);
}
function footstepSound(){
  ensureAudio();
  const t=audioCtx.currentTime;
  const len=0.03, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.12));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const gain=audioCtx.createGain(); gain.gain.setValueAtTime(0.03,t); gain.gain.exponentialRampToValueAtTime(0.001,t+len);
  const lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.setValueAtTime(300,t);
  src.connect(lp); lp.connect(gain); gain.connect(masterGain);
  src.start(t); src.stop(t+len);
}
function pickupSound(atten=1){
  if(atten<=0) return;
  ensureAudio();
  const t=audioCtx.currentTime;
  // Click metálico (armar)
  const clk=audioCtx.createOscillator(); clk.type='square'; clk.frequency.setValueAtTime(800,t); clk.frequency.exponentialRampToValueAtTime(200,t+0.04);
  const cg=audioCtx.createGain(); cg.gain.setValueAtTime(0.05*atten,t); cg.gain.exponentialRampToValueAtTime(0.001,t+0.05);
  clk.connect(cg); cg.connect(masterGain);
  clk.start(t); clk.stop(t+0.05);
  // Ruído mecânico (corrediça)
  const len=0.06, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.1));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const gain=audioCtx.createGain(); gain.gain.setValueAtTime(0.04*atten,t); gain.gain.exponentialRampToValueAtTime(0.001,t+len);
  const hp=audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.setValueAtTime(2000,t);
  src.connect(hp); hp.connect(gain); gain.connect(masterGain);
  src.start(t); src.stop(t+len);
}
function chestSound(atten=1){
  // chime subindo + pop — sinal de loot
  if(atten<=0) return;
  ensureAudio();
  const t=audioCtx.currentTime;
  [[520,0],[780,0.07],[1040,0.14]].forEach(([f,d])=>{
    const o=audioCtx.createOscillator(); o.type='triangle'; o.frequency.setValueAtTime(f,t+d);
    const g=audioCtx.createGain(); g.gain.setValueAtTime(0.0001,t+d);
    g.gain.exponentialRampToValueAtTime(0.09*atten,t+d+0.02); g.gain.exponentialRampToValueAtTime(0.001,t+d+0.18);
    o.connect(g); g.connect(masterGain); o.start(t+d); o.stop(t+d+0.2);
  });
}
function overheatSound(){
  // "PSSSHHH" de vapor pressurizado + tom descendo (arma desligando)
  ensureAudio();
  const t=audioCtx.currentTime;
  const len=0.55, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.45));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const gain=audioCtx.createGain(); gain.gain.setValueAtTime(0.09,t); gain.gain.exponentialRampToValueAtTime(0.001,t+len);
  const hp=audioCtx.createBiquadFilter(); hp.type='highpass';
  hp.frequency.setValueAtTime(3600,t); hp.frequency.exponentialRampToValueAtTime(1200,t+len);
  src.connect(hp); hp.connect(gain); gain.connect(masterGain);
  src.start(t); src.stop(t+len);
  const o=audioCtx.createOscillator(); o.type='triangle';
  o.frequency.setValueAtTime(560,t); o.frequency.exponentialRampToValueAtTime(110,t+0.30);
  const og=audioCtx.createGain(); og.gain.setValueAtTime(0.06,t); og.gain.exponentialRampToValueAtTime(0.001,t+0.32);
  o.connect(og); og.connect(masterGain); o.start(t); o.stop(t+0.32);
}
const CRITTER_DIE_SFX = new Audio('assets/sfx/hurt-c.ogg');
function critterSquishSound(atten=1){
  // arquivo gravado (hurt-c) em vez de síntese — clona pra permitir sobrepor
  // se mais de um bicho morrer no mesmo instante. Fica fora do grafo do Web Audio
  // (masterGain), então precisa checar o mute do SDK na mão.
  if(atten<=0 || sdkMuted) return;
  const a = CRITTER_DIE_SFX.cloneNode(true);
  a.volume = Math.min(1, atten/OTHER_GUNSHOT_VOLUME) * 0.1;
  a.play().catch(()=>{});
}
function enemyHitSound(atten=1){
  // thud curto e grave — bala acertou carne
  if(atten<=0) return;
  ensureAudio();
  const t=audioCtx.currentTime;
  const o=audioCtx.createOscillator(); o.type='square';
  o.frequency.setValueAtTime(340,t); o.frequency.exponentialRampToValueAtTime(120,t+0.07);
  const g=audioCtx.createGain(); g.gain.setValueAtTime(0.07*atten,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.08);
  o.connect(g); g.connect(masterGain); o.start(t); o.stop(t+0.08);
}
function enemyDieSound(atten=1){
  // tom descendo (desinflando) + ruído de baque + thump grave (peso extra no impacto)
  if(atten<=0) return;
  ensureAudio();
  const t=audioCtx.currentTime;
  const o=audioCtx.createOscillator(); o.type='triangle';
  o.frequency.setValueAtTime(520,t); o.frequency.exponentialRampToValueAtTime(60,t+0.28);
  const g=audioCtx.createGain(); g.gain.setValueAtTime(0.10*atten,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.30);
  o.connect(g); g.connect(masterGain); o.start(t); o.stop(t+0.30);
  const len=0.12, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.2));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const ng=audioCtx.createGain(); ng.gain.setValueAtTime(0.08*atten,t); ng.gain.exponentialRampToValueAtTime(0.001,t+len);
  const lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.setValueAtTime(500,t);
  src.connect(lp); lp.connect(ng); ng.connect(masterGain);
  src.start(t); src.stop(t+len);
  // Thump grave — dá peso ao golpe fatal (mesma ideia do "sub punch" do tiro)
  const sub=audioCtx.createOscillator(); sub.type='sine';
  sub.frequency.setValueAtTime(115,t); sub.frequency.exponentialRampToValueAtTime(28,t+0.16);
  const subg=audioCtx.createGain(); subg.gain.setValueAtTime(0.16*atten,t); subg.gain.exponentialRampToValueAtTime(0.001,t+0.16);
  sub.connect(subg); subg.connect(masterGain); sub.start(t); sub.stop(t+0.16);
}
function killCollectSound(){
  // "Ding" de abate confirmado: arpejo curto e brilhante + brilho agudo — toca quando a caveira chega no contador
  ensureAudio();
  const t=audioCtx.currentTime;
  [[880,0],[1180,0.045],[1568,0.09]].forEach(([f,d])=>{
    const o=audioCtx.createOscillator(); o.type='triangle'; o.frequency.setValueAtTime(f,t+d);
    const g=audioCtx.createGain(); g.gain.setValueAtTime(0.0001,t+d);
    g.gain.exponentialRampToValueAtTime(0.11,t+d+0.015); g.gain.exponentialRampToValueAtTime(0.001,t+d+0.16);
    o.connect(g); g.connect(masterGain); o.start(t+d); o.stop(t+d+0.18);
  });
  const o2=audioCtx.createOscillator(); o2.type='sine';
  o2.frequency.setValueAtTime(2400,t+0.02); o2.frequency.exponentialRampToValueAtTime(3200,t+0.12);
  const g2=audioCtx.createGain(); g2.gain.setValueAtTime(0.0001,t+0.02);
  g2.gain.exponentialRampToValueAtTime(0.035,t+0.03); g2.gain.exponentialRampToValueAtTime(0.001,t+0.2);
  o2.connect(g2); g2.connect(masterGain); o2.start(t+0.02); o2.stop(t+0.22);
}
function enemyShieldBreakSound(atten=1){
  // Escudo quebrando: zap elétrico descendo + estouro de vidro + tinidos agudos dos cacos
  if(atten<=0) return;
  ensureAudio();
  const t=audioCtx.currentTime;
  const o=audioCtx.createOscillator(); o.type='sawtooth';
  o.frequency.setValueAtTime(1400,t); o.frequency.exponentialRampToValueAtTime(180,t+0.22);
  const g=audioCtx.createGain(); g.gain.setValueAtTime(0.08*atten,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.24);
  const hp=audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.setValueAtTime(400,t);
  o.connect(hp); hp.connect(g); g.connect(masterGain); o.start(t); o.stop(t+0.24);
  const len=0.18, sr=audioCtx.sampleRate, buf=audioCtx.createBuffer(1,Math.max(1,sr*len|0),sr);
  const d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.exp(-i/(d.length*0.3));
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const ng=audioCtx.createGain(); ng.gain.setValueAtTime(0.11*atten,t); ng.gain.exponentialRampToValueAtTime(0.001,t+len);
  const bp=audioCtx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.setValueAtTime(3200,t); bp.Q.setValueAtTime(0.8,t);
  src.connect(bp); bp.connect(ng); ng.connect(masterGain);
  src.start(t); src.stop(t+len);
  [2600,3300,4100].forEach((f,i)=>{
    const d2=0.02+i*0.03;
    const o2=audioCtx.createOscillator(); o2.type='sine'; o2.frequency.setValueAtTime(f,t+d2);
    const g2=audioCtx.createGain(); g2.gain.setValueAtTime(0.0001,t+d2);
    g2.gain.exponentialRampToValueAtTime(0.05*atten,t+d2+0.008); g2.gain.exponentialRampToValueAtTime(0.001,t+d2+0.09);
    o2.connect(g2); g2.connect(masterGain); o2.start(t+d2); o2.stop(t+d2+0.1);
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
// Spawner genérico de bala — usado pelo player (shoot()) e por qualquer bot.
// owner: 'player' ou a referência do bot que atirou (bulletStep usa isso pra
// saber quem a bala pode/não pode acertar).
function fireBullet(sx, sy, sL, gunId, angle, aimDist, owner){
  const w = WEAPONS[gunId];
  const wpDist = SPR*0.35;
  const mx = sx + Math.cos(angle)*(wpDist + SPR*0.5);
  const my = sy + Math.sin(angle)*(wpDist + SPR*0.5);
  const bulletSpeed = MTILE*w.speed;
  for(let p=0;p<w.pellets;p++){
    const a = angle + (Math.random()*2-1)*w.spread;          // spread por projétil
    const txw = mx + Math.cos(a)*aimDist, tyw = my + Math.sin(a)*aimDist;
    bullets.push({
      x: mx, y: my,
      vx: Math.cos(a)*bulletSpeed,
      vy: Math.sin(a)*bulletSpeed,
      tx: txw, ty: tyw,
      level: sL,
      life: aimDist/bulletSpeed,
      w: gunId,
      owner,
    });
  }
  return {mx, my};
}
function shoot(){
  const w = WEAPONS[gun];
  recoilForce = w.recoil;
  shakePhase = w.shake;
  gunSound(w.snd);
  const angle = Math.atan2(mouse.wy - (player.y-6), mouse.wx - player.x);
  const wpDist = SPR*0.35;  // distância base da arma
  const mx = player.x + Math.cos(angle)*(wpDist + SPR*0.5);
  const my = player.y-6 + Math.sin(angle)*(wpDist + SPR*0.5);
  flashT = 0.05; flashAng = angle; flashMx = mx; flashMy = my;
  const aimDist = Math.max(MTILE*2, Math.hypot(mouse.wx-mx, mouse.wy-my));
  fireBullet(player.x, player.y-6, player.L, gun, angle, aimDist, 'player');
}
// ── Faca automática: golpe passivo corpo-a-corpo — roda TODO frame pra QUALQUER
// combatente vivo (player e cada bot, mesma função) e só "aparece" (anima + causa
// dano) se, com o cooldown zerado, achar um hostil dentro do alcance. Sem alvo por
// perto ela fica escondida — não é sacada/segurada como as armas de fogo.
function updateMelee(ent, dt, hostiles){
  ent.facaCooldown = Math.max(0, ent.facaCooldown - dt);
  ent.facaSwingT = Math.max(0, ent.facaSwingT - dt);
  if(ent.facaCooldown > 0) return;
  const mw = WEAPONS[meleeIdFor(ent)];
  let target = null, targetIsCritter = false, bestD = mw.range;
  for(const h of hostiles){
    const d = Math.hypot(h.x-ent.x, (h.y-6)-(ent.y-6));
    if(d <= bestD){ bestD = d; target = h; targetIsCritter = false; }
  }
  for(const cr of critters){                        // faca também mata bicho — mesmo alcance
    if(cr.st==='dead' || cr.L !== ent.L) continue;
    const d = Math.hypot(cr.x-ent.x, (cr.y-6)-(ent.y-6));
    if(d <= bestD){ bestD = d; target = cr; targetIsCritter = true; }
  }
  if(!target) return;
  ent.facaSwingAng = Math.atan2((target.y-6)-(ent.y-6), target.x-ent.x);
  ent.facaSwingT = MELEE_SWING_DUR;
  ent.facaCooldown = mw.rate;
  if(ent===player) shakePhase = Math.max(shakePhase, 0.4);
  gunSound(mw.snd, ent===player ? 1 : gunshotAtten(ent.x, ent.y));
  if(targetIsCritter) killCritter(target, ent===player ? 'player' : ent);
  else if(target===player) damagePlayer(mw.dmg, target.x, target.y-6, ent);
  else damageEnemy(target, mw.dmg, target.x, target.y-6, ent===player ? 'player' : ent);
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
        const cellL=ci.kind==='spawn'?ci.levels[0]:ci.level;
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
function spawnSparks(x, y, vx, vy, level){
  const baseAng = Math.atan2(vy, vx) + Math.PI;  // direção contrária à bala (rebate)
  for(let i=0;i<8;i++){
    const a = baseAng + (Math.random()*2-1)*0.7; // cone mais aberto de ±40°
    const spd = MTILE*(3+Math.random()*5);
    const len = MTILE*(0.1+Math.random()*0.2);   // riscos bem mais curtos
    hits.push({
      x, y,
      vx: Math.cos(a)*spd, vy: Math.sin(a)*spd,
      len, ang: a, level,
      life: 0.08+Math.random()*0.06,
    });
  }
}
// ── Arma: sem colisão, atravessa tudo (a ponte só barra o disparo e cobre visualmente) ──
function weaponDist(px, py, angle, maxDist){
  return maxDist;
}

// ── Colisão per-frame das balas: atravessa tudo, só para em pontes e bordas ──
const BOT_VS_BOT = true;   // todos contra todos — bala de bot também acerta outro bot
function bulletStep(b, dt){
  if(b.life <= 0) return;
  b.life -= dt;
  // Raycast do frame: ajusta posição e nível com obstáculos
  const nextX = b.x + b.vx*dt, nextY = b.y + b.vy*dt;
  const hit = raycast(b.x, b.y, nextX, nextY, b.level);
  // Alvo no caminho? (segmento do frame vs sprite inteiro — sem tunneling)
  // Testa player (se a bala não for do player) e inimigos (se for do player, ou bot-vs-bot ligado)
  let bestT=Infinity, bestPt=null, hitPlayer=false, hitEnemy=null, hitCritter=null;
  if(b.owner !== 'player' && player.hp > 0 && player.L === b.level){
    const h = segRectHit(b.x, b.y, hit.x, hit.y, bodyRect(player.x, player.y));
    if(h && h.t < bestT){ bestT=h.t; bestPt=h; hitPlayer=true; hitEnemy=null; hitCritter=null; }
  }
  if(b.owner === 'player' || BOT_VS_BOT){
    for(const e of enemies){
      if(e === b.owner || e.st !== 'alive' || e.L !== b.level) continue;
      const h = segRectHit(b.x, b.y, hit.x, hit.y, bodyRect(e.x, e.y));
      if(h && h.t < bestT){ bestT=h.t; bestPt=h; hitPlayer=false; hitEnemy=e; hitCritter=null; }
    }
  }
  // Bicho: qualquer bala (de qualquer dono) mata — vida efetiva 1
  for(const cr of critters){
    if(cr.st==='dead' || cr.L !== b.level) continue;
    const h = segRectHit(b.x, b.y, hit.x, hit.y, bodyRect(cr.x, cr.y));
    if(h && h.t < bestT){ bestT=h.t; bestPt=h; hitPlayer=false; hitEnemy=null; hitCritter=cr; }
  }
  if(bestPt){
    if(hitPlayer) damagePlayer(GUN_DMG[b.w]||10, bestPt.x, bestPt.y, b.owner);
    else if(hitCritter) killCritter(hitCritter, b.owner);
    else damageEnemy(hitEnemy, GUN_DMG[b.w]||10, bestPt.x, bestPt.y, b.owner);
    b.x=bestPt.x; b.y=bestPt.y; b.tx=b.x; b.ty=b.y; b.life=0;   // faísca no ponto do impacto
    return;
  }
  b.x = hit.x; b.y = hit.y; b.level = hit.L;
  // Chegou no destino ou bateu em algo = faísca
  const dxNext = nextX - b.x, dyNext = nextY - b.y;
  if(Math.abs(dxNext) > 0.2 || Math.abs(dyNext) > 0.2 || b.life <= 0){
    b.tx = b.x; b.ty = b.y; b.life = 0;
  }
}
// ── Dano no player (bala de bot) — espelha damageEnemy: escudo absorve primeiro ──
function damagePlayer(dmg, hx, hy, killer){
  const px = hx ?? player.x, py = (hy ?? player.y-6) - 6;
  let toArmor = 0, toHp = dmg;
  if(player.armor > 0){
    toArmor = Math.min(player.armor, dmg);
    player.armor -= toArmor; toHp = dmg - toArmor;
    shieldRechargeTimer = 0;
    spawnDmgPop(px, py, toArmor, false, true);          // número azul — dano no escudo
    if(player.armor <= 0){ spawnShieldBreak(player.x, player.y-6); enemyShieldBreakSound(); }
  }
  if(toHp <= 0){ enemyHitSound(); return; }
  player.hp -= toHp;
  spawnDmgPop(px, py - (toArmor>0?10:0), toHp, player.hp<=0);
  if(player.hp <= 0) killPlayer(killer); else enemyHitSound();
}
// ── Morte do player: único ponto de saída — a tela de morte/vitória é 100% canvas
// (ver drawEndScreen mais abaixo), no mesmo estilo do menu inicial. ──
const PLAYER_DEAD = 3;   // último frame da folha players = pose de morte (igual ENEMY_DEAD)
let deathGunSnapshot = 'pistola';   // arma que tava na mão na hora da morte — pra "reviver"
// REVIVER só existe 1x por partida e só até a zona 8 (zoneNum é 0-indexado — mesmo
// limite que os reforços de bots já usam, ver RESPAWN_ZONE_LIMIT) — depois disso é
// tarde demais pra valer a pena continuar de onde morreu.
let reviveUsed = false;
let deathTimer = 0;                    // segundos restantes pra reviver — 0 = expirou
const REVIVE_ZONE_LIMIT = 8;
const DEATH_REVIVE_TIMEOUT = 30;       // janela de 30s pra decidir se revive ou não
// Cronômetro do card de stats na tela de morte/vitória: precisa TRAVAR no instante
// da morte (elapsedT global continua correndo — bots e zona seguem vivos atrás do
// painel) senão o "TEMPO" fica contando por conta própria enquanto você decide se
// reviver ou não. Na vitória não precisa (elapsedT já para sozinho — ver frame()),
// mas capturamos igual por uniformidade.
let endElapsedT = 0;
function killPlayer(killer){
  if(state !== 'playing') return;
  deathGunSnapshot = gun;
  player.hp = 0; player.moving = false; player.frame = PLAYER_DEAD; state = 'dead';
  endElapsedT = elapsedT;
  deathTimer = DEATH_REVIVE_TIMEOUT;    // corrida contra o relógio — 30s pra decidir reviver
  dropWeaponOnDeath(player.x, player.y, gun);
  pushKillFeed(player, killer);
  playerKiller = killer && killer.st==='alive' ? killer : null;
  spectator = playerKiller;   // foca em quem te matou
  canvas.style.cursor = 'pointer';
  withSDK(sdk => sdk.game.gameplayStop());
}
// Reviver exatamente onde morreu, com a arma de antes — abates/moedas/tempo continuam
// (é a mesma partida, só que sem passar pelo spawn de novo).
function revivePlayer(){
  if(state !== 'dead' || reviveUsed || deathTimer <= 0 || zoneNum >= REVIVE_ZONE_LIMIT) return;
  reviveUsed = true; deathTimer = 0;
  player.hp = 100; player.armor = 100;
  hpGhost = 100; armorGhost = 100;
  shieldRechargeTimer = 0; prevHp = 100;
  player.frame = 0; player.moving = false;
  gun = deathGunSnapshot;
  fireCooldown = 0; fireLatch = false; gunHeat = 0; gunOverheat = false; overheatFlash = 0;
  spectator = null; playerKiller = null;
  canvas.style.cursor = 'none';
  state = 'playing';
  withSDK(sdk => sdk.game.gameplayStart());
}
// Vitória (último de pé): mesmo painel de estatísticas da tela de morte, mas sem
// "reviver" (não tem sentido, já ganhou) — e o jogo/mundo congela de vez (ver frame()),
// diferente da morte, que continua rolando atrás do painel. wonSnapshot guarda a
// última imagem renderizada pra desenhar de novo (idempotente) sem precisar rodar
// step()/draw() a cada frame enquanto congelado.
let wonSnapshot = null;
function showVictoryScreen(){
  state = 'won';
  endElapsedT = elapsedT;
  wonSnapshot = document.createElement('canvas');
  wonSnapshot.width = canvas.width; wonSnapshot.height = canvas.height;
  wonSnapshot.getContext('2d').drawImage(canvas, 0, 0);
  canvas.style.cursor = 'pointer';
  withSDK(sdk => sdk.game.gameplayStop());
  // Confete da própria CrazyGames — celebração da plataforma pra conquistas grandes
  // (ganhar a partida inteira é bem o caso de uso que o SDK recomenda pra happytime).
  withSDK(sdk => sdk.game.happytime());
}

const clamp=(v,a,b)=>v<a?a:v>b?b:v;

function shuffleInPlace(arr){
  for(let i=arr.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr;
}
// Acha até `total` pontos de spawn: primeiro os tiles de spawn pintados no mapa (nível 0 ou elevado);
// se faltar, completa com células de piso bem espaçadas (amostragem gulosa por distância
// mínima) — assim funciona hoje (1 spawn só) e escala pra quantos o mapa tiver depois.
function collectSpawnPoints(total){
  const spawnCells = [];
  for(let i=0;i<coll.length;i++){ const v=coll[i]; if(v===2 || (v>=200&&v<210)) spawnCells.push(i); }
  if(spawnCells.length >= total) return shuffleInPlace(spawnCells).slice(0,total);
  const candidates = [];
  for(let i=0;i<coll.length;i++){
    const ci = collInfo(coll[i]);
    if(ci && ci.kind!=='block') candidates.push(i);
  }
  shuffleInPlace(candidates);
  const chosen = spawnCells.slice();
  const minDist = MTILE*6, minDistSq = minDist*minDist;
  const toXY = i => [ (i%COLS)*MTILE+MTILE/2, ((i/COLS)|0)*MTILE+MTILE/2 ];
  for(const cand of candidates){
    if(chosen.length >= total) break;
    const [cx,cy] = toXY(cand);
    let ok = true;
    for(const ch of chosen){ const [chx,chy]=toXY(ch); const dx=cx-chx,dy=cy-chy;
      if(dx*dx+dy*dy < minDistSq){ ok=false; break; } }
    if(ok) chosen.push(cand);
  }
  if(chosen.length < total){   // mapa apertado demais pro espaçamento mínimo — relaxa e completa
    for(const cand of candidates){ if(chosen.length>=total) break; if(!chosen.includes(cand)) chosen.push(cand); }
  }
  return chosen;
}

//======================= INIMIGOS =======================
// Bots com IA: andam pelo mapa (mesmas regras de colisão/piso/escada/ponte do player),
// perseguem/fogem/procuram loot e baús, e atiram de volta — ver seção "IA DOS BOTS".
const ENEMY_ROW   = 3;              // linha do sprite na folha enemies (boneco azul)
const ENEMY_DEAD  = 3;              // último frame da linha = morto
// Variedade visual dos bots: reaproveita as skins da folha players (mesmas
// regras de IA/combate pra todo mundo, só a aparência muda) — cada bot sorteia
// uma dessas ao spawnar, espalhada pelos pontos de spawn.
const ENEMY_SKINS = [
  { sheet:'enemies', row:ENEMY_ROW },
  { sheet:'players',  row:0 },
  { sheet:'players',  row:1 },
  { sheet:'players',  row:2 },
  { sheet:'players',  row:3 },
];
const CORPSE_LIFETIME = 3;          // corpo some do mapa 3s depois de morrer
const CORPSE_FADE_DUR = 1;          // últimos 1s desse tempo: desvanece em vez de sumir de repente
function corpseAlpha(e){            // 1 (opaco) até começar a desvanecer, depois cai linear até 0
  const left = CORPSE_LIFETIME - e.deathT;
  return left >= CORPSE_FADE_DUR ? 1 : Math.max(0, left/CORPSE_FADE_DUR);
}
// Pistola = 2 de dano (baseline) — resto reescalado nas MESMAS proporções (×0.4 em
// cima da leva anterior, que já tinha as outras com vantagem clara sobre a pistola).
const GUN_DMG = { pistola:2, magnum:8, uzi:3.6, sniper:40, carabina:4, fuzil:5, smg:3, escopeta:3 };
// Tier de qualidade das armas (pra IA decidir "isso é upgrade?") — não é DPS bruto:
// automáticas de cadência alta são limitadas pelo superaquecimento, e armas de tiro
// único (sniper) valem mais que a conta crua sugere, então o ranking é curado.
const WEAPON_TIER = { pistola:1, escopeta:2, smg:2, magnum:3, carabina:3, uzi:3, sniper:4, fuzil:4 };
const weaponScore = id => { const w=WEAPONS[id]; return w.pellets*(GUN_DMG[id]||10)/w.rate; };
// ── Nomes dos bots (200+ criativos com special chars) ──
const BOT_NAMES=[
'☠️xX_StrayShot_Xx','ヅHeadshotHank','⚡SupremeBolt','🩸ColdBlood','💀BoneCollector',
'GoAllIn','DiedInACoffin','snipeGODヅ','🔥GrillMaster','🌀StormPiercer',
'LAG_KILLER','30fps_Gamer','x√-1_H4X0R','RushMcGee','SatOnTheCactus',
'JoeDropsAll','BBQ_Uncle','PeacockArmed','KidNunchuck','GermanBrute',
'G3X_M4T3R','CamperNoob','SpawnRat','Viper_X7','Ghost_Pepper',
'☢RadioActive','Phoenix☄Fallen','VultureNinja','FlyingToxin','MoshPitBullet',
'SlowCapybara','RAGE_QUITTER','FlatTire','D3AD_before_spawn','BulletShell',
'IronPuller','StuffedArmed','WallBreaker','TacticalTripod','🔪ThroatSlit',
'LilClubArmed','xX_Boogeyman_Xx','ChubGunslinger','SilverBullet','DraggedFluffy',
'Strike_Fake','ButterHands','CosmicDust','V8_Beak','WetTowel',
'NightWing','SourCandy','SilentRoadrunner','xX_TrojanHorse_Xx','🔫SouthSideGuy',
'FatFirework','HitchhikerToad','DeathBallerina','NinjaCherry','SleepyOgre',
'ArmedChicken','GreatWallDefender','JokerPanther','NightRavenX','SilentThunder',
'AtomicWorm','ElectricCrab','gator.aerial','☕BlackCoffee','NutellaZombie',
'MilkCarton','WoodMoped','Dr0p4d0r4','PinchedByFate','ArmedSausage',
'R@T_FROM_THE_SEWER','GoodPopcorn','RambleToadヅ','DesertWitch','TacticalRust',
'NightWindstorm','NuclearGecko','AsphaltPirate','WindMachine','LongOvercoat',
'GutPunch','NoReverseRocket','BootedCat⚔','DeadlyPinball','AtomicShoelace',
'TriggerFinger','ThreeShotLoko','KillerTamale','BulletFamily','🌀DryStorm',
'CarrionCity','FlyingChainsaw','DizzyRoach☢','BombedPigeon','RespawnRider',
'CamperChicken','EastSideSnitch','PopcornStrike','SteelTermite','NuclearCorncob',
'TirePete','ColdLunchbox','RippedJeans','SlipperFoot','OgreOnTheLoose',
'SniperVulture','AtomicShrimp','BadAimBuddy','TinBackpack','CrookedBlunderbuss',
'BlindLighthouse','PegLeg','BulletSpitter','DeadlyDragnet','NinjaTortoise',
'Arroba_Thunder','DeathPotStew','HellPolka','TacticalPatch','RaccoonSupreme',
'Vulgo_Tato','BulletDodger','🔧WrenchThrower','NightCrystal','FlyingLizard',
'SoapyFish','Malice_007','LeechHate','PineappleRifle','FallenChameleon',
'GunpowderKeg','SlowDeathBrew','🦴HardBone','ToyPistol','GrindItOut',
'ClamCounter','R@bã0','ArmedTiburon','LethalPneumonia','FlyingTurnstile',
'CabbagePatchJoe','LowBlowヅ','EvilPopcorn','BolebaSniper','RustyNerves',
'SweatyPitStain','SteelSpider','♿ElectricChair','DeathSyrup','RottenThumb',
'CrocsWithIce','FlyingFlipFlop','HotCracklin','ElectricGoat','SmokeNoFire',
'LeadLasagna','SonicToot','SlippedOnIt','Gambiarra_Pro','FlyingSaucer',
'DeathNoodle','ArmedMallard','BluntSickle','GhostBoar','LemonPopsicle',
'Catapimba','SandbagSam','RelâmpaG0_X','TacticalStool','CountryChick',
'NinjaWagon','LionBreath','BeachedSlug','DramaQueen','NuclearStraw',
'BreadWithBullets','RifleRanger','FlyingShark','AtomicSloth','LazyMonkeyヅ',
'TarDummy','ElectricSaw☠','LethalCornmeal','HairyLeg','KnockedOutTruco',
'SteelPamonha','ElectricCatfish','DeathBell','CrookedLilPistol','ScratchedEye',
'🦴OldCarcass','WaterHen','RadioactiveDust','KiteKingpin','LeadPudding',
'OldManBar','BulletSurfer','NuclearSlang','BOLOLO_H4H4','StreetKid',
'FlyingBladder','SteelForkFred','CaboDaciolo⚡','LivingSkeleton','MarbleBall',
'CaneJuiceArmed','MercyShot','AtomicRamen','NoodleNinja','ScrapMetalMax',
'PickleSlicer','SwampWraith','TumbleweedTerror','RustBucketRiot','CactusJuggler',
];
let usedNames=[];   // nomes já sorteados nesta partida (sem repetir)
let nameIdx=0;       // próximo índice livre em usedNames (spawn inicial E reforços depois)
function nextBotName(){
  if(nameIdx >= usedNames.length){ usedNames = shuffleInPlace([...BOT_NAMES]); nameIdx = 0; }
  return usedNames[nameIdx++];
}

// ── Bicho fraco (spawner configurável no editor): nasce, cresce e fica andando
// devagar SÓ no próprio nível — nunca usa escada nem ponte. Qualquer bala ou golpe
const TOTAL_COMBATANTS = 50;     // player + bots
let enemies = [];
let critterSpawners = [];   // do mapa: {c,r,L,qty,maxAlive} + timer/estado de leva
let critters = [];          // instâncias vivas: {x,y,L,st,animT,spawner,...}
let critterSplashes = [];   // splash de gosma no instante da morte: {x,y,drops,t,dur}
let critterHealPops = [];   // "+1" verde do bicho morto voando pro player: {fx,fy,tx,ty,t,dur}
const CRITTER_SPAWN_ANIM_DUR = 0.6;   // segundos "brotando" antes de poder andar
const CRITTER_SPEED = SPEED * 0.13;   // bem devagar
const CRITTER_WAVE_CHECK = 8;         // segundos entre checagens de leva nova
// Fábrica compartilhada: spawn inicial E reforços depois usam o mesmo bot "de fábrica".
function makeEnemyObj(id, sc, sr, L, nome, skinIdx){
  const skin = ENEMY_SKINS[skinIdx % ENEMY_SKINS.length];
  return {
    id, nome: nome||('?'+id),
    x:sc*MTILE+MTILE/2, y:sr*MTILE+MTILE/2, L,
    hp:100, maxHp:100, armor:100, maxArmor:100, shieldRechargeTimer:0,
    st:'alive', flashT:0, sheet:skin.sheet, row:skin.row,
    healAura:0, medkits:2,
    // ── combate/visual ──
    gun:'pistola', fireCooldown:0, muzzleFlashT:0, aimAngle:Math.random()*Math.PI*2-Math.PI, flip:false, moving:false,
    facaCooldown:0, facaSwingT:0, facaSwingAng:0,
    animT:Math.random()*10, frame:0, overlapGunIdx:-1, gunHeat:0, gunOverheat:false, overheatFlash:0, deathT:0, zoneDmgTimer:0, strafeDir:1, strafeTimer:0, footprintDist:0,
    // ── IA ──
    fsm:'EXPLORE', decisionTimer:Math.random()*0.3, target:null, lastKnownTargetPos:null,
    critterTarget:null,
    lootGoal:null, lootPriority: Math.random() < 0.3,
    path:[], pathIndex:0, pathGoal:null, repathTimer:Math.random()*1.5, stuckTimer:0,
    wanderTarget:null, hardStuckTimer:0, crossLevelTarget:null,
  };
}
let nextEnemyId = 0;
function spawnEnemies(){
  enemies = [];
  killFeed = [];
  spectator = null; playerKiller = null;
  usedNames = shuffleInPlace([...BOT_NAMES]);
  nameIdx = 0;
  const spawnIdx = collectSpawnPoints(TOTAL_COMBATANTS);
  shuffleInPlace(spawnIdx);
  // Primeiro ponto sorteado vira o spawn do player — todo mundo disputa o mesmo pool
  const ps = spawnIdx[0], psv = collInfo(coll[ps]);
  player.x = (ps%COLS)*MTILE+MTILE/2; player.y = ((ps/COLS)|0)*MTILE+MTILE/2;
  player.L = (psv && psv.levels) ? psv.levels[0] : 0;
  for(let k=1; k<spawnIdx.length; k++){
    const s=spawnIdx[k], sc=s%COLS, sr=(s/COLS)|0, sv=collInfo(coll[s]);
    enemies.push(makeEnemyObj(k, sc, sr, (sv&&sv.levels)?sv.levels[0]:0, nextBotName(), k));
  }
  nextEnemyId = spawnIdx.length;
  respawnCheckTimer = RESPAWN_CHECK_INTERVAL;
  dmgPops = []; deathPops = []; shieldBreaks = []; killPulseT = 999; killBurstT = 999;
  bullets = []; aiPathBudget = 0; aiUrgentPathBudget = 0;
}
// ── Reforços: até a safe 6 (zoneNum<6), mantém vivos sempre entre MIN e MAX_ALIVE_
// ENEMIES — sem isso o jogo fica esvaziando rápido demais no início. Reaproveita os
// mesmos pontos de spawn do mapa (tiles de spawn de verdade, não qualquer canto). O
// alvo de reforço é sorteado dentro da faixa (não sempre o mesmo número fixo), pra
// dar uma variação natural de quantos tão vivos em vez de ficar preso num valor só.
const MIN_ALIVE_ENEMIES = 40;
const MAX_ALIVE_ENEMIES = 50;
const RESPAWN_ZONE_LIMIT = 8;
const RESPAWN_CHECK_INTERVAL = 2;
let respawnCheckTimer = RESPAWN_CHECK_INTERVAL;
function pickReinforcementSpawn(){
  const spawnCells = [];
  for(let i=0;i<coll.length;i++){ const v=coll[i]; if(v===2 || (v>=200&&v<210)) spawnCells.push(i); }
  const pool = spawnCells.length ? spawnCells : (()=>{
    const c=[]; for(let i=0;i<coll.length;i++){ const ci=collInfo(coll[i]); if(ci && ci.kind!=='block') c.push(i); } return c;
  })();
  if(!pool.length) return null;
  const s = pool[(Math.random()*pool.length)|0];
  const sv = collInfo(coll[s]);
  return { sc:s%COLS, sr:(s/COLS)|0, L:(sv&&sv.levels)?sv.levels[0]:0 };
}
function maybeRespawnEnemies(dt){
  if(zoneNum >= RESPAWN_ZONE_LIMIT) return;
  respawnCheckTimer -= dt;
  if(respawnCheckTimer > 0) return;
  respawnCheckTimer = RESPAWN_CHECK_INTERVAL;
  const alive = enemies.reduce((n,e)=>n+(e.st==='alive'?1:0), 0);
  if(alive >= MIN_ALIVE_ENEMIES) return;
  const target = MIN_ALIVE_ENEMIES + Math.floor(Math.random()*(MAX_ALIVE_ENEMIES-MIN_ALIVE_ENEMIES+1));
  const deficit = Math.min(target, MAX_ALIVE_ENEMIES) - alive;
  for(let i=0; i<deficit; i++){
    const sp = pickReinforcementSpawn();
    if(!sp) break;
    const nome = nextBotName();
    const e = makeEnemyObj(nextEnemyId++, sp.sc, sp.sr, sp.L, nome, nextEnemyId);
    enemies.push(e);
    pushJoinFeed(e.nome);
  }
}

// ── Bicho: colisão PRÓPRIA (sem escada, sem ponte — só piso/spawn do MESMO nível) ──
function critterCanStep(toVal, L){
  const ci = collInfo(toVal);
  if(!ci) return false;                                  // vazio/vazio = sem chão, não anda
  if(ci.kind==='block' || ci.kind==='escada') return false;   // parede E escada bloqueiam
  if(ci.kind==='piso') return ci.level===L;
  if(ci.kind==='spawn') return ci.levels[0]===L;
  return false;
}
function critterAxis(cr, nx, ny, horiz){
  const cc={c:Math.floor(cr.x/MTILE), r:Math.floor(cr.y/MTILE)};
  const lead = horiz ? {c:Math.floor((nx+Math.sign(nx-cr.x)*SPR/2)/MTILE), r:cc.r}
                     : {c:cc.c, r:Math.floor((ny+Math.sign(ny-cr.y)*SPR/2)/MTILE)};
  if(!critterCanStep(collAt(lead.c,lead.r), cr.L)) return false;
  if(horiz) cr.x=nx; else cr.y=ny;
  return true;
}
function spawnCritter(sp){
  critters.push({
    x: sp.c*MTILE+MTILE/2 + (Math.random()*2-1)*MTILE*0.25,
    y: sp.r*MTILE+MTILE/2 + (Math.random()*2-1)*MTILE*0.25,
    L: sp.L, spawner: sp, st:'spawning', animT:0, flip:false,
    vx:0, vy:0, wanderT:0,
  });
}
// Solta uma leva nova só se: (a) ainda tem vaga (abaixo do máx vivo DESSE spawner),
// (b) é a primeira leva OU já morreu pelo menos um da leva anterior, e (c) o spawner
// ainda está dentro da zona segura — depois que a tempestade engole o ponto, os
// bichinhos param de nascer ali (não faz sentido dar vida/moeda numa área que já
// está matando o jogador por dano de zona).
function updateCritterSpawners(dt){
  for(const sp of critterSpawners){
    sp.timer -= dt;
    if(sp.timer > 0) continue;
    sp.timer = CRITTER_WAVE_CHECK;
    if(sp.everSpawned && !sp.hasKillSinceWave) continue;
    const spx = sp.c*MTILE+MTILE/2, spy = sp.r*MTILE+MTILE/2;
    if(!inSafeZone(spx, spy)) continue;
    const aliveNow = critters.reduce((n,cr)=>n+(cr.spawner===sp && cr.st!=='dead' ? 1 : 0), 0);
    const room = sp.maxAlive - aliveNow;
    if(room <= 0) continue;
    const n = Math.min(sp.qty, room);
    for(let i=0;i<n;i++) spawnCritter(sp);
    sp.everSpawned = true;
    sp.hasKillSinceWave = false;
  }
}
function updateCritter(cr, dt){
  cr.animT += dt;
  if(cr.st==='spawning'){
    if(cr.animT >= CRITTER_SPAWN_ANIM_DUR){ cr.st='alive'; cr.animT=0; }
    return;
  }
  cr.wanderT -= dt;
  if(cr.wanderT <= 0){
    // Anda só paralelo aos eixos (igual a um passo de grade) — nunca na diagonal.
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    const d = dirs[(Math.random()*4)|0];
    cr.vx = d[0]; cr.vy = d[1];
    cr.wanderT = 1.2 + Math.random()*2.2;
  }
  const s = CRITTER_SPEED*dt;
  const okX = critterAxis(cr, cr.x+cr.vx*s, cr.y, true);
  const okY = critterAxis(cr, cr.x, cr.y+cr.vy*s, false);
  if(!okX && !okY) cr.wanderT = 0;         // bateu em algo — escolhe outra direção já no próximo frame
  if(cr.vx) cr.flip = cr.vx<0;
  // Corrige o corpo que sobrou pendurado pra fora do piso — sem isso metade do
  // asset podia flutuar sobre o vazio (lembra: o colisor é o asset cheio agora).
  // Empurra o centro de volta pra área válida: a célula do centro É válida (o
  // movimento sempre foi aceito), então andamos pra cada lado até achar onde a
  // "casca" (SPR/2) bateria num tile inválido, e paramos logo antes.
  const R=SPR/2, cc=Math.floor(cr.x/MTILE), crr=Math.floor(cr.y/MTILE);
  let lx=cc, rx=cc;
  while(lx>0 && critterCanStep(collAt(lx-1,crr),cr.L)) lx--;
  while(rx<COLS-1 && critterCanStep(collAt(rx+1,crr),cr.L)) rx++;
  cr.x = clamp(cr.x, lx*MTILE+R, (rx+1)*MTILE-R);
  const cc2=Math.floor(cr.x/MTILE);            // recalculado depois do clamp de x
  let ty=crr, by=crr;
  while(ty>0 && critterCanStep(collAt(cc2,ty-1),cr.L)) ty--;
  while(by<ROWS-1 && critterCanStep(collAt(cc2,by+1),cr.L)) by++;
  cr.y = clamp(cr.y, ty*MTILE+R, (by+1)*MTILE-R);
}
// ── Splash de gosma no instante da morte: gotas voando (com "gravidade") a partir
// do ponto de impacto, some rápido — nada de rastro persistente, só o momento. ──
const SPLASH_RING_DELAY = 0.13, SPLASH_RING_DUR = 0.55, SPLASH_RINGS = 2;
function spawnCritterSplash(x, y){
  critterSplashes.push({x, y, t:0, dur:(SPLASH_RINGS-1)*SPLASH_RING_DELAY + SPLASH_RING_DUR});
}
function updateCritterSplashes(dt){
  for(const s of critterSplashes) s.t += dt;
  if(critterSplashes.some(s=>s.t>=s.dur)) critterSplashes = critterSplashes.filter(s=>s.t<s.dur);
}
// "+1" verde voando do bicho morto até quem matou ⊕ ease-out com fade
function updateCritterHealPops(dt){
  for(const p of critterHealPops){
    p.t += dt;
    if(p.to && p.to.hp>0){ p.tx=p.to.x; p.ty=p.to.y-6; }  // segue o matador até chegar
  }
  if(critterHealPops.some(p=>p.t>=p.dur)) critterHealPops = critterHealPops.filter(p=>p.t<p.dur);
}
function drawCritterHealPops(){
  if(!IMG.interface) return;
  for(const p of critterHealPops){
    const k = p.t/p.dur, ease = 1-(1-k)*(1-k);  // ease-out pro alvo
    const cx = p.fx + (p.tx-p.fx)*ease, cy = p.fy + (p.ty-p.fy)*ease;
    const a = k>0.7 ? Math.max(0, 1-(k-0.7)/0.3) : 1;
    const sc = 1 + Math.sin(Math.PI*k)*0.4;       // leve bounce
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = a;
    ctx.scale(sc, sc);
    drawBmpText('+10', 0, 0, 10, {color:'#6fdb8c', align:'center', shaded:true});
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
function killCritter(cr, owner){
  if(cr.st==='dead') return;
  cr.st = 'dead';
  if(cr.spawner) cr.spawner.hasKillSinceWave = true;
  spawnCritterSplash(cr.x, cr.y);
  critterSquishSound(gunshotAtten(cr.x, cr.y));
  // Bicho morto = +1 HP pra quem matou (player ou bot). Um "+1" verde anima
  // voando do corpo até o matador — simples, sem texto rebuscado. Moeda usa o mesmo
  // "to" — visual de moeda voando vale pra player E bot, só o contador do HUD e o
  // som em volume cheio são exclusivos do player.
  const to = owner==='player' ? player : owner && owner.st==='alive' ? owner : null;
  if(to) addCoins(COINS_CRITTER, cr.x, cr.y-6, to);
  if(to){
    to.hp = Math.min((to.maxHp||100), to.hp + 10);
    critterHealPops.push({
      fx: cr.x, fy: cr.y-6, tx: to.x, ty: to.y-6, to,
      t:0, dur:0.55,
    });
  }
}
// enemies_packed.png é um PNG indexado — reduzir a escala direto dele faz o Chrome
// vazar branco opaco nas bordas transparentes. Decodifica cada frame 1x num canvas
// (RGBA de verdade) e escala A PARTIR DELE — sem esse passo o halo aparece.
const _critterFrameCache = {};
function critterFrameImg(frame){
  let c = _critterFrameCache[frame];
  if(!c){
    c = document.createElement('canvas'); c.width=SPR; c.height=SPR;
    const g = c.getContext('2d'); g.imageSmoothingEnabled=false;
    g.drawImage(IMG.enemies, frame*SPR, 0, SPR, SPR, 0, 0, SPR, SPR);
    _critterFrameCache[frame] = c;
  }
  return c;
}
function drawCritter(cr){
  if(!IMG.enemies) return;
  const spawning = cr.st==='spawning';
  const frame = spawning ? (2 + Math.floor(cr.animT*6)%2) : (Math.floor(cr.animT*4)%2);
  ctx.fillStyle='rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(cr.x, cr.y+4, 5, 2, 0, 0, 6.28); ctx.fill();
  // Cresce ao nascer — escala o DESTINO do drawImage, não a matriz de transformação.
  const s = spawning ? SPR*Math.min(1, cr.animT/CRITTER_SPAWN_ANIM_DUR) : SPR;
  ctx.save(); ctx.translate(cr.x, cr.y-4);
  if(cr.flip) ctx.scale(-1,1);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(critterFrameImg(frame), 0, 0, SPR, SPR, -s/2, -s/2, s, s);
  ctx.restore();
}

function pushKillFeed(victim, killer){
  const vn = victim===player ? PLAYER_NAME : (victim.nome||'?');
  const kn = killer==='player' ? PLAYER_NAME : (killer && killer.nome ? killer.nome : 'the zone');
  killFeed.push({victim:vn, killer:kn, t:0, dur:KILL_FEED_DUR, isPlayer:(victim===player||killer==='player')});
  // Mantém só as 8 mais recentes — mini chat limitado
  while(killFeed.length > 8) killFeed.shift();
}
// Reforço chegando no mapa — mesma mini-chat dos abates, "Fulano ↑" (seta verde no
// lugar da palavra "entrou", ver drawKillFeed).
function pushJoinFeed(nome){
  killFeed.push({isJoin:true, nome, t:0, dur:KILL_FEED_DUR});
  while(killFeed.length > 8) killFeed.shift();
}
function updateKillFeed(dt){
  for(const kf of killFeed) kf.t += dt;
  if(killFeed.some(kf=>kf.t>=kf.dur)) killFeed = killFeed.filter(kf=>kf.t<kf.dur);
}
function damageEnemy(e, dmg, hx, hy, owner){
  e.flashT = 0.12;
  const px = hx ?? e.x, py = (hy ?? e.y-6) - 6;
  const byPlayer = owner === 'player';
  // Som de acerto/morte de OUTRO combatente também abafa com a distância, igual o
  // tiro — senão toda porrada em qualquer canto do mapa (bot vs bot longe de você)
  // chega no seu ouvido no volume cheio.
  const atten = gunshotAtten(e.x, e.y);
  // Escudo absorve primeiro (1:1, igual a maioria dos BR) — resto vaza pra vida
  let toArmor = 0, toHp = dmg;
  if(e.armor > 0){
    toArmor = Math.min(e.armor, dmg);
    e.armor -= toArmor; toHp = dmg - toArmor;
    e.shieldRechargeTimer = 0;
    spawnDmgPop(px, py, toArmor, false, true);      // número azul — dano no escudo
    if(e.armor <= 0){ spawnShieldBreak(e.x, e.y-6); enemyShieldBreakSound(atten); }
  }
  if(toHp <= 0){ enemyHitSound(atten); return; }      // escudo absorveu tudo — sem dano na vida
  e.hp -= toHp;
  const kill = e.hp <= 0;
  spawnDmgPop(px, py - (toArmor>0?10:0), toHp, kill); // se veio dano de escudo antes, empilha o número da vida acima
  if(kill){
    e.hp = 0; e.st='dead'; e.deathT = 0;
    dropWeaponOnDeath(e.x, e.y, e.gun);
    pushKillFeed(e, owner);   // mini chat de abate
    enemyDieSound(atten);
    spawnDeathPop(e.x, e.y-6);
    if(byPlayer){                                      // abate só conta no contador do PLAYER
      kills++; killCollectSound(); killPulseT = 0; killBurstT = 0;
      addCoins(COINS_KILL, e.x, e.y-6, player);
      shakePhase = Math.max(shakePhase, 0.4);
    } else if(owner && owner.st==='alive'){
      addCoins(COINS_KILL, e.x, e.y-6, owner);   // bot também ganha (visual só, sem contador)
    }
    // Corrente do espectador: se quem morreu era o foco, segue o assassino
    if(owner && owner.st==='alive' && e===spectator) spectator = owner;
  } else enemyHitSound(atten);
}

//======================= IA DOS BOTS =======================
// Pathfinding A* sobre (coluna,linha,nível) — reaproveita canStep (mesma regra de
// colisão/piso/escada/ponte do player, sem duplicar nada). Orçamento por frame pra
// aguentar até 50 bots buscando rota ao mesmo tempo sem travar o jogo.
let aiPathBudget = 0;
const AI_MAX_PATHS_PER_FRAME = 2;
// Orçamento à parte pra rotas de vida-ou-morte (fugir da tempestade ou de quem tá
// atirando) — bem mais generoso, senão esses bots ficam na fila atrás de todo mundo
// que só tá explorando/procurando loot e correm reto (sem escada) enquanto esperam.
let aiUrgentPathBudget = 0;
const AI_MAX_URGENT_PATHS_PER_FRAME = 12;
const AI_PATH_NODE_CAP = 4000;
const AI_DETECTION_RADIUS = MTILE*14;
const AI_LOS_CANDIDATES = 8;
const AI_MEMORY_TIME = 3;
const AI_FLEE_HP_PCT = 0.30, AI_FLEE_RECOVER_PCT = 0.55;
const AI_CRITTER_HUNT_PCT = 0.50;     // abaixo desse HP, bicho vira prioridade
const AI_ENGAGE_STOP_DIST = MTILE*6;
const AI_BOT_SPEED = SPEED*0.85;   // levemente mais devagar que o player — sensação "de bot"
const AI_AIM_ERROR = 0.05;         // erro de mira humano (rad), além do spread da própria arma
// Mira do bot vira suave em vez de "grudada" no waypoint cru: um corredor apertado
// (escada, quina) pode exigir reverter quase 180° de um waypoint pro próximo, e sem
// suavização isso vira um giro instantâneo — a "mira frenética pra vários lados" que
// aparecia mesmo sozinho, sem ninguém por perto (só andando/procurando algo).
const AI_TURN_RATE = Math.PI*5;   // rad/s — meia-volta em ~0.2s, ainda ágil no combate
function turnToward(cur, target, maxDelta){
  let diff = target - cur;
  while(diff > Math.PI) diff -= 2*Math.PI;
  while(diff < -Math.PI) diff += 2*Math.PI;
  if(diff > maxDelta) diff = maxDelta;
  else if(diff < -maxDelta) diff = -maxDelta;
  // Sem isso o ângulo devolvido não fica preso em [-π,π] (só a DIFERENÇA era normalizada,
  // não o resultado final) — ele vai saindo do intervalo aos poucos a cada frame, e o
  // teste "Math.abs(aimAngle) > PI/2" que decide se espelha a arma verticalmente (pra
  // não desenhar de ponta cabeça ao mirar pra esquerda) para de bater com o ângulo real
  // já rotacionado. É isso que deixava a arma de alguns bots de ponta cabeça.
  let result = cur + diff;
  while(result > Math.PI) result -= 2*Math.PI;
  while(result < -Math.PI) result += 2*Math.PI;
  return result;
}
const AI_REACT_MIN = 0.12, AI_REACT_MAX = 0.37;   // atraso de reação antes do 1º tiro num alvo novo

function canEnterCell(fromC,fromR,fromL, toC,toR){
  if(toC<0||toR<0||toC>=COLS||toR>=ROWS) return null;
  return canStep(collAt(fromC,fromR), fromL, collAt(toC,toR), overAt(toC,toR));
}
// Min-heap simples (array binário) por fScore — evita custo O(n²) de escanear a fronteira toda
function pqPush(heap, node){
  heap.push(node); let i=heap.length-1;
  while(i>0){ const p=(i-1)>>1; if(heap[p].f<=heap[i].f) break; [heap[p],heap[i]]=[heap[i],heap[p]]; i=p; }
}
function pqPop(heap){
  const top=heap[0], last=heap.pop();
  if(heap.length){ heap[0]=last; let i=0;
    for(;;){ const l=i*2+1, r=i*2+2; let m=i;
      if(l<heap.length && heap[l].f<heap[m].f) m=l;
      if(r<heap.length && heap[r].f<heap[m].f) m=r;
      if(m===i) break;
      [heap[m],heap[i]]=[heap[i],heap[m]]; i=m;
    }
  }
  return top;
}
function reconstructPath(came, endKey, startKey){
  const path=[]; let k=endKey;
  while(k && k!==startKey){
    const [c,r,L] = k.split(',').map(Number);
    path.push({c,r,L});
    k = came.get(k);
  }
  return path.reverse();
}
// A* de (startC,startR,startL) até (goalC,goalR) em qualquer nível. Se não alcançar o
// alvo exato (fora de alcance/cap de nós), devolve o melhor caminho parcial até o nó
// mais próximo do alvo que a busca conseguiu explorar — o bot nunca "trava" sem rota.
function findPath(startC,startR,startL, goalC,goalR){
  if(startC===goalC && startR===goalR) return [];
  const startKey = startC+','+startR+','+startL;
  const gScore = new Map([[startKey, 0]]);
  const came = new Map();
  const heap = [];
  pqPush(heap, {c:startC,r:startR,L:startL, f:Math.hypot(goalC-startC,goalR-startR), key:startKey});
  let closest = {key:startKey}, closestD = Math.hypot(goalC-startC,goalR-startR);
  let nodes = 0;
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
  while(heap.length && nodes < AI_PATH_NODE_CAP){
    const cur = pqPop(heap); nodes++;
    if(cur.c===goalC && cur.r===goalR) return reconstructPath(came, cur.key, startKey);
    const d = Math.hypot(goalC-cur.c, goalR-cur.r);
    if(d<closestD){ closestD=d; closest=cur; }
    const g = gScore.get(cur.key);
    for(const [dc,dr] of DIRS){
      const nc=cur.c+dc, nr=cur.r+dr;
      const nl = canEnterCell(cur.c,cur.r,cur.L, nc,nr);
      if(nl===null) continue;
      const nkey = nc+','+nr+','+nl;
      const ng = g+1;
      if(!gScore.has(nkey) || ng<gScore.get(nkey)){
        gScore.set(nkey, ng);
        came.set(nkey, cur.key);
        pqPush(heap, {c:nc,r:nr,L:nl, f:ng+Math.hypot(goalC-nc,goalR-nr), key:nkey});
      }
    }
  }
  return closest.key===startKey ? [] : reconstructPath(came, closest.key, startKey);
}
// Dispara/renova o path de um bot em direção à célula-alvo, respeitando o orçamento
// por frame — replaneja só quando precisa (sem path, alvo mudou, timeout, ou travado).
function setBotGoal(e, gc, gr){
  if(!e.pathGoal || e.pathGoal.c!==gc || e.pathGoal.r!==gr){
    e.pathGoal = {c:gc, r:gr};
    e.path = []; e.pathIndex = 0; e.repathTimer = 0;
    e.pathGoalSetT = elapsedT;
  }
}
// Objetivo demorando demais: mesma meta (mesma célula) há tempo demais sem chegar —
// não é sobre um frame travado (isso é o hardStuckTimer), é "essa perseguição não tá
// dando em nada, muda de direção". Não se aplica durante ENGAGE (o alvo se move, o
// pathGoal muda toda hora sozinho, então nunca fica "velho" de verdade perseguindo
// alguém de verdade) — só pra metas fixas tipo loot/bicho/zona/explorar.
const AI_GOAL_TIMEOUT = 4.5;
function updateBotPathing(e, dt){
  if(!e.pathGoal) return;
  if(e.fsm!=='ENGAGE' && e.fsm!=='FLEE' && (elapsedT - (e.pathGoalSetT||elapsedT)) > AI_GOAL_TIMEOUT){
    e.target=null; e.lastKnownTargetPos=null; e.lootGoal=null; e.zoneGoal=null; e.critterTarget=null;
    e.path=[]; e.pathIndex=0; e.pathGoal=null; e.wanderTarget=null; e.pathFailCount=0;
    e.fsm=null; e.decisionTimer=0; e.hardStuckTimer=0; e.stuckTimer=0;
    forceUnstick(e);
    return;
  }
  e.repathTimer -= dt;
  const needsPath = e.path.length===0 || e.pathIndex>=e.path.length;
  const stuck = e.stuckTimer > 0.6;
  if(!(needsPath || e.repathTimer<=0 || stuck)) return;
  const urgent = e.fsm==='FLEE' || e.fsm==='AVOID_ZONE';
  const hasBudget = urgent ? aiUrgentPathBudget < AI_MAX_URGENT_PATHS_PER_FRAME
                            : aiPathBudget < AI_MAX_PATHS_PER_FRAME;
  if(!hasBudget) return;
  if(urgent) aiUrgentPathBudget++; else aiPathBudget++;
  const sc=Math.floor(e.x/MTILE), sr=Math.floor(e.y/MTILE);
  e.path = findPath(sc, sr, e.L, e.pathGoal.c, e.pathGoal.r);
  e.pathIndex = 0; e.repathTimer = 1.5+Math.random(); e.stuckTimer = 0;
  // Meta inalcançável (path vazio) duas vezes seguidas — abandona em vez de ficar
  // tentando a mesma rota impossível pra sempre (é isso que trava o bot num lugar só).
  if(e.path.length===0){
    e.pathFailCount = (e.pathFailCount||0) + 1;
    if(e.pathFailCount >= 2){ e.pathGoal=null; e.pathFailCount=0; e.wanderTarget=null; e.lootGoal=null; }
  } else {
    e.pathFailCount = 0;
  }
}
// Anda em direção ao próximo waypoint do path atual (mesmo mover por eixo do player).
function followPath(e, dt){
  if(e.path.length && e.pathIndex < e.path.length){
    const wp = e.path[e.pathIndex];
    const wx = wp.c*MTILE+MTILE/2, wy = wp.r*MTILE+MTILE/2;
    const dx = wx-e.x, dy = wy-e.y, dist = Math.hypot(dx,dy);
    if(dist < MTILE*0.5){ e.pathIndex++; return followPath(e, dt); }
    const s = AI_BOT_SPEED*dt, l = dist||1;
    const okX = moveEntityAxis(e, e.x+dx/l*s, e.y, true);
    const okY = moveEntityAxis(e, e.x, e.y+dy/l*s, false);
    e.moving = true; e.aimAngle = turnToward(e.aimAngle, Math.atan2(dy,dx), AI_TURN_RATE*dt); e.flip = dx<0;
    const blocked = movementBlocked(dx,dy,okX,okY);
    e.stuckTimer = blocked ? e.stuckTimer+dt : 0;
    noteBlockedMovement(e, blocked, dt);
    return true;
  }
  // Sem waypoints ainda prontos (esperando a vez no orçamento de pathfinding por
  // frame, ou meta momentaneamente sem rota) — anda direto rumo ao objetivo em vez
  // de ficar parado esperando; o bot NUNCA deve travar parado.
  if(!e.pathGoal) { e.moving=false; return false; }
  const gx = e.pathGoal.c*MTILE+MTILE/2, gy = e.pathGoal.r*MTILE+MTILE/2;
  const dx = gx-e.x, dy = gy-e.y, dist = Math.hypot(dx,dy);
  if(dist < MTILE*0.5){ e.moving=false; return false; }
  const s = AI_BOT_SPEED*dt, l = dist||1;
  const okX = moveEntityAxis(e, e.x+dx/l*s, e.y, true);
  const okY = moveEntityAxis(e, e.x, e.y+dy/l*s, false);
  e.moving = true; e.aimAngle = turnToward(e.aimAngle, Math.atan2(dy,dx), AI_TURN_RATE*dt); e.flip = dx<0;
  const blocked = movementBlocked(dx,dy,okX,okY);
  e.stuckTimer = blocked ? e.stuckTimer+dt : 0;
  noteBlockedMovement(e, blocked, dt);
  return true;
}

// ── Percepção: todo mundo (player + outros bots) é só "hostil" — sem caso especial ──
function hostileList(self){
  const list=[];
  if(self!==player && player.hp>0) list.push(player);   // self pode ser o próprio player (ver updateMelee)
  for(const e of enemies) if(e!==self && e.st==='alive') list.push(e);
  return list;
}
function findVisibleHostile(e){
  // Mantém o alvo atual enquanto ele continuar válido — sem isso, com vários hostis por
  // perto o bot troca de alvo (o mais próximo, cru) a cada ciclo de decisão e fica
  // "cambaleando" a direção/mira entre um e outro em vez de terminar a briga com um só.
  if(e.target && e.target.hp > 0){
    const d = Math.hypot(e.target.x-e.x, e.target.y-e.y);
    if(d < AI_DETECTION_RADIUS && e.target.L===e.L){
      const ray = raycast(e.x, e.y-6, e.target.x, e.target.y-6, e.L);
      if(Math.hypot(ray.x-e.target.x, ray.y-e.target.y) < MTILE*0.6) return e.target;
    }
  }
  const cands = hostileList(e)
    .map(h=>({h, d:Math.hypot(h.x-e.x, h.y-e.y)}))
    .filter(o=>o.d < AI_DETECTION_RADIUS && o.h.L===e.L)
    .sort((a,b)=>a.d-b.d)
    .slice(0, AI_LOS_CANDIDATES);
  for(const {h} of cands){
    const ray = raycast(e.x, e.y-6, h.x, h.y-6, e.L);
    if(Math.hypot(ray.x-h.x, ray.y-h.y) < MTILE*0.6) return h;
  }
  return null;
}
// Sabe que tem alguém perto só que num andar diferente — não pra mirar (bala não
// atravessa nível, ver colisão de bala), mas pra ir de propósito buscar a escada/ponte
// e procurar briga em vez de vagar às cegas quando não tem mais nada melhor pra fazer.
function findCrossLevelHostile(e){
  let best=null, bestD=AI_DETECTION_RADIUS;
  for(const h of hostileList(e)){
    if(h.L === e.L) continue;
    const d = Math.hypot(h.x-e.x, h.y-e.y);
    if(d < bestD){ bestD = d; best = h; }
  }
  return best;
}

// ── Tier de arma: "isso é upgrade de verdade?" (margem de 10% dentro do mesmo tier) ──
function isUpgrade(e, gunId){
  const cur = WEAPON_TIER[e.gun]||1, cand = WEAPON_TIER[gunId]||1;
  if(cand > cur) return true;
  if(cand === cur) return weaponScore(gunId) > weaponScore(e.gun)*1.1;
  return false;
}
function findBestLootGoal(e){
  // Nunca manda o bot atrás de loot fora da zona segura atual — senão ele sai puxado
  // pelo SEEK_LOOT logo depois que o AVOID_ZONE acabou de trazer ele pra dentro, e
  // fica entrando/saindo da tempestade em loop pra sempre atrás do mesmo item.
  let best=null, bestD=Infinity;
  for(const it of gunItems){
    if(!it.t) continue;   // slot vazio (pistola descartada num swap — não fica largada)
    if(!isUpgrade(e, it.t)) continue;
    const gx=it.c*MTILE+MTILE/2, gy=it.r*MTILE+MTILE/2;
    if(!inSafeZone(gx,gy)) continue;
    const d=Math.hypot(gx-e.x, gy-e.y);
    if(d<bestD){ bestD=d; best={c:it.c, r:it.r}; }
  }
  for(const b of chests){
    if(b.st!=='closed') continue;
    const bx=b.c*MTILE+MTILE/2, by=b.r*MTILE+MTILE/2;
    if(!inSafeZone(bx,by)) continue;
    const d=Math.hypot(bx-e.x, by-e.y);
    if(d<bestD){ bestD=d; best={c:b.c, r:b.r}; }
  }
  return best;
}
// Ponto está dentro da zona segura atual? Antes da 1a zona aparecer (idle) ou sem
// zona definida, tudo conta como "seguro" — usada tanto pela IA (findBestLootGoal)
// quanto pelos spawners de bichinho (updateCritterSpawners).
function inSafeZone(x, y){
  return !zoneCurrent || zoneState==='idle' || zoneCurrent.r<=0 ||
    Math.hypot(x-zoneCurrent.cx, y-zoneCurrent.cy) <= zoneCurrent.r;
}
// Alvo de "vagar" — tenta ficar dentro da zona segura atual (consciência de tempestade)
// Puxa um ponto de volta pra dentro da zona segura se ele cair fora dela — usado pra
// fugir de um inimigo sem por acaso fugir pra dentro da tempestade também.
function clampToZone(x, y){
  if(!zoneCurrent || zoneState==='idle' || zoneCurrent.r<=0) return {x, y};
  const dx=x-zoneCurrent.cx, dy=y-zoneCurrent.cy, d=Math.hypot(dx,dy);
  if(d <= zoneCurrent.r*0.9) return {x, y};
  const k = (zoneCurrent.r*0.85)/d;
  return { x: zoneCurrent.cx+dx*k, y: zoneCurrent.cy+dy*k };
}
function pickWanderTarget(e){
  for(let tries=0; tries<12; tries++){
    let tc, tr;
    if(zoneCurrent && zoneState!=='idle' && zoneCurrent.r>0){
      const ang=Math.random()*6.28, rad=Math.random()*zoneCurrent.r*0.85;
      tc = Math.floor((zoneCurrent.cx+Math.cos(ang)*rad)/MTILE);
      tr = Math.floor((zoneCurrent.cy+Math.sin(ang)*rad)/MTILE);
    } else {
      tc = (Math.random()*COLS)|0; tr = (Math.random()*ROWS)|0;
    }
    const ci = collInfo(collAt(tc,tr));
    if(ci && ci.kind!=='block') return {c:tc, r:tr};
  }
  return {c:Math.floor(e.x/MTILE), r:Math.floor(e.y/MTILE)};
}

// Bicho visível mais próximo no mesmo nível (pra caçar e curar). Só conta se não
// tiver obstáculo no caminho — o bot "enxerga" ele igual enxerga um hostile.
function findNearbyCritter(e){
  if(!critters.length) return null;
  let best=null, bestD=AI_DETECTION_RADIUS;
  for(const cr of critters){
    if(cr.st==='dead' || cr.L!==e.L) continue;
    const d=Math.hypot(cr.x-e.x, cr.y-e.y);
    if(d>=bestD) continue;
    const ray = raycast(e.x, e.y-6, cr.x, cr.y-6, e.L);
    if(Math.hypot(ray.x-cr.x, ray.y-cr.y) < MTILE*0.8){ bestD=d; best=cr; }
  }
  return best;
}

// ── Máquina de estados: FLEE > AVOID_ZONE > ENGAGE > SEEK_LOOT > EXPLORE ──
function decideBotFSM(e, dt){
  // Corte de fuga por vida baixa roda TODO frame (é só uma conta), não preso ao timer
  // throttled abaixo — senão o bot podia soltar mais uma rajada já abaixo do limiar,
  // esperando até 0.3s pra "perceber" que devia estar fugindo.
  const hpPct = e.hp / e.maxHp;
  if(e.fsm !== 'FLEE' && hpPct <= AI_FLEE_HP_PCT) e.fsm = 'FLEE';
  else if(e.fsm === 'FLEE' && hpPct >= AI_FLEE_RECOVER_PCT) e.fsm = null;

  e.decisionTimer -= dt;
  if(e.decisionTimer > 0) return;
  e.decisionTimer = 0.2 + Math.random()*0.1;

  const target = findVisibleHostile(e);
  if(target) e.lastKnownTargetPos = {x:target.x, y:target.y, L:target.L, t:elapsedT};
  e.target = target;

  if(e.fsm === 'FLEE') return;   // mantém fugindo até recuperar HP, mesmo sem alvo visível

  // Abrindo baú: não abandona no meio — o hostil pode esperar (ou morrer pra zona)
  // enquanto a carga termina (senão sai do range a cada ciclo de decisão e reseta).
  if(e.fsm === 'SEEK_LOOT' && chests.some(b=>b.st==='charging' && b.chargedBy===e)) return;

  // Fora da zona segura: sempre vem antes de qualquer objetivo "de conforto" (cura,
  // loot) — sobreviver à tempestade é mais urgente que farmar bicho ou trocar de arma.
  // Ainda não é uma fuga cega que ignora tudo: continua atirando se um alvo aparecer
  // no caminho de volta (ver updateBotAI).
  const outsideZone = zoneCurrent && zoneState!=='idle' &&
    (zoneCurrent.r<=0 || Math.hypot(e.x-zoneCurrent.cx, e.y-zoneCurrent.cy) > zoneCurrent.r);
  if(outsideZone){ e.critterTarget = null; e.fsm = 'AVOID_ZONE'; return; }

  // HP baixo → bicho por perto = prioridade máxima (cura), acima até de hostil visível.
  // Acima do limiar de emergência, ainda vale desviar pra "completar" a vida (ficar
  // com 100) se não tiver ninguém pra atirar agora — só não abandona uma troca de
  // tiro em andamento por causa disso.
  if(hpPct <= AI_CRITTER_HUNT_PCT || (hpPct < 1 && !target)){
    const cr = findNearbyCritter(e);
    if(cr){ e.critterTarget = cr; e.fsm = 'HUNT_CRITTER'; return; }
  }
  e.critterTarget = null;

  if(target){
    // Alguns bots (personalidade "gananciosa", sorteada no spawn) preferem upar de
    // arma antes de trocar tiro — se ainda tão com a inicial e tem upgrade ou baú
    // alcançável por perto, vão atrás disso em vez de engajar na hora.
    if(e.lootPriority && WEAPON_TIER[e.gun]<=1){
      const loot = findBestLootGoal(e);
      if(loot){ e.lootGoal = loot; e.fsm = 'SEEK_LOOT'; return; }
    }
    e.fsm = 'ENGAGE';
  }
  else if(e.lastKnownTargetPos && elapsedT - e.lastKnownTargetPos.t < AI_MEMORY_TIME) e.fsm = 'ENGAGE';
  else {
    const loot = findBestLootGoal(e);
    if(loot){ e.lootGoal = loot; e.fsm = 'SEEK_LOOT'; return; }
    // Nada pra fazer no próprio andar — sabe que tem gente perto em outro andar (não
    // pra mirar, só posição) e vai de propósito buscar a escada/ponte pra brigar em
    // vez de vagar às cegas sem rumo.
    const cross = findCrossLevelHostile(e);
    if(cross){ e.crossLevelTarget = cross; e.fsm = 'SEEK_CONFLICT'; return; }
    e.fsm = 'EXPLORE';
  }
}
function botTryFire(e, dt, target){
  // Atraso de reação ao mirar num alvo novo (readquirido) — sem isso o bot "trava" mira
  // perfeita instantânea assim que enxerga alguém, o que fica com cara de aimbot.
  if(e.aimTarget !== target){ e.aimTarget = target; e.aimReadyT = AI_REACT_MIN + Math.random()*(AI_REACT_MAX-AI_REACT_MIN); }
  if(e.aimReadyT > 0){ e.aimReadyT -= dt; return; }
  if(e.gunOverheat) return;   // arma travada esfriando — mesma trava do player

  e.fireCooldown = Math.max(0, e.fireCooldown - dt);
  if(e.fireCooldown > 0) return;
  const w = WEAPONS[e.gun];
  e.fireCooldown = w.rate * (1 + Math.random()*0.35);   // variação de cadência mais humana
  // Erro de mira humano (além do spread da própria arma) — cresce com a distância,
  // igual miraria pior num alvo longe do que num bem perto.
  const humanError = (Math.random()*2-1) * AI_AIM_ERROR;
  const angle = Math.atan2((target.y-6)-(e.y-6), target.x-e.x) + humanError;
  const aimDist = Math.max(MTILE*2, Math.hypot(target.x-e.x, (target.y-6)-(e.y-6)));
  gunSound(w.snd, gunshotAtten(e.x, e.y));   // abafado com a distância — só ~50 tiles de alcance
  fireBullet(e.x, e.y-6, e.L, e.gun, angle, aimDist, e);
  e.muzzleFlashT = 0.05;
  // Esquenta igual ao player: rajada contínua estoura a arma em ~4s (escala com a cadência)
  e.gunHeat = (e.gunHeat||0) + clamp(w.rate*0.45, 0.03, 0.55);
  if(e.gunHeat >= 1){ e.gunHeat = 1; e.gunOverheat = true; e.overheatFlash = 1.6; }
}
// Orbita ao redor de um alvo (perpendicular à linha bot→alvo), trocando de lado de vez
// em quando ou se bater em algo — usado sempre que o bot precisa continuar se
// movendo durante o combate em vez de travar parado (dentro do alcance, ou esperando
// a arma esfriar longe do alvo).
function botStrafe(e, t, dt){
  e.strafeTimer = (e.strafeTimer||0) - dt;
  if(e.strafeTimer <= 0){ e.strafeDir = Math.random()<0.5 ? 1 : -1; e.strafeTimer = 1.2 + Math.random()*1.8; }
  const dx=t.x-e.x, dy=t.y-e.y, dd=Math.hypot(dx,dy)||1;
  const px=-dy/dd, py=dx/dd;
  const s = AI_BOT_SPEED*dt*e.strafeDir;
  const okX = moveEntityAxis(e, e.x+px*s, e.y, true);
  const okY = moveEntityAxis(e, e.x, e.y+py*s, false);
  e.moving = true; e.flip = dx<0;
  const blocked = movementBlocked(px,py,okX,okY);
  if(blocked) e.strafeTimer = 0;   // bateu em algo — troca de lado no próximo tick
  // Trocar de lado uma vez não adianta se o bot tá encurralado numa parede/canto perto
  // do alvo (os dois lados batem) — sem isso ele fica ali oscilando pra sempre em vez
  // de sair da quina, exatamente o "travado na parede" que ainda acontecia em combate.
  noteBlockedMovement(e, blocked, dt);
}
// Travado de verdade: os DOIS eixos do movimento pretendido bloqueados no mesmo frame,
// por tempo demais seguido (ver okX/okY em followPath) — não é "orbitando/estrafegando
// sem sair do lugar" (isso é normal em combate, tem posição líquida parada mas tá se
// mexendo o tempo todo); é ficar de verdade sem conseguir dar nenhum passo. Troca de
// objetivo não resolve se a quina em si continuar no caminho — chuta o bot pra uma
// célula andável vizinha, igual o player.
function noteBlockedMovement(e, blocked, dt){
  e.hardStuckTimer = blocked ? (e.hardStuckTimer||0)+dt : 0;
  if(e.hardStuckTimer > 1.0){
    e.hardStuckTimer = 0;
    e.target=null; e.lastKnownTargetPos=null; e.lootGoal=null; e.zoneGoal=null; e.critterTarget=null;
    e.path=[]; e.pathIndex=0; e.pathGoal=null; e.wanderTarget=null; e.pathFailCount=0;
    e.fsm=null; e.decisionTimer=0;
    forceUnstick(e);
  }
}
function updateBotAI(e, dt){
  decideBotFSM(e, dt);

  if(e.fsm === 'FLEE'){
    const threat = e.target || e.lastKnownTargetPos;
    if(threat){
      const dx=e.x-threat.x, dy=e.y-threat.y, d=Math.hypot(dx,dy)||1;
      // Foge do ameaçador, mas sem por acaso fugir pra dentro da tempestade — puxa de
      // volta pra zona segura se a direção "pra longe do inimigo" apontar pra fora dela.
      const raw = clampToZone(e.x + dx/d*MTILE*8, e.y + dy/d*MTILE*8);
      const gx = clamp(raw.x, 0, WORLD_W-1), gy = clamp(raw.y, 0, WORLD_H-1);
      setBotGoal(e, Math.floor(gx/MTILE), Math.floor(gy/MTILE));
    }
    updateBotPathing(e, dt); followPath(e, dt);
    // Atira de volta enquanto foge, se ainda enxergar o ameaçador — mira nele, não na
    // direção que tá correndo (followPath vira a mira pro rumo do movimento, então
    // sobrescreve aqui por último).
    if(e.target){
      e.aimAngle = turnToward(e.aimAngle, Math.atan2((e.target.y-6)-(e.y-6), e.target.x-e.x), AI_TURN_RATE*dt);
      botTryFire(e, dt, e.target);
    }
    return;
  }
  if(e.fsm === 'HUNT_CRITTER'){
    // Vai atrás do bicho pra farmar +1 HP — não troca tiro com hostil enquanto isso
    const cr = e.critterTarget;
    if(cr && cr.st!=='dead' && cr.L===e.L){
      setBotGoal(e, Math.floor(cr.x/MTILE), Math.floor(cr.y/MTILE));
      updateBotPathing(e, dt); followPath(e, dt);
      // Mira no bicho por ÚLTIMO — followPath sobrescreve aimAngle com a direção do
      // waypoint (que ziguezagueia contornando obstáculo), então tem que vir depois,
      // senão a mira "treme" seguindo o caminho em vez do alvo de verdade.
      e.aimAngle = turnToward(e.aimAngle, Math.atan2((cr.y-6)-(e.y-6), cr.x-e.x), AI_TURN_RATE*dt);
      botTryFire(e, dt, cr);   // atira ou esfaqueia — bala/faca já casam com critter
      return;
    }
    e.critterTarget = null; e.fsm = 'EXPLORE';   // bicho morreu/sumiu — volta a vagar
    return;
  }
  if(e.fsm === 'SEEK_CONFLICT'){
    // Sabe que tem alguém em outro andar — vai de propósito buscar a escada/ponte pra
    // procurar briga em vez de vagar às cegas. Sem mira/tiro aqui (bala não atravessa
    // nível): assim que o path atravessar pro mesmo andar, o findVisibleHostile normal
    // assume e o bot entra em ENGAGE de verdade.
    const ct = e.crossLevelTarget;
    const stillValid = ct && (ct===player ? ct.hp>0 : ct.st==='alive');
    if(stillValid && ct.L!==e.L){
      setBotGoal(e, Math.floor(ct.x/MTILE), Math.floor(ct.y/MTILE));
      updateBotPathing(e, dt); followPath(e, dt);
      return;
    }
    e.crossLevelTarget = null; e.fsm = 'EXPLORE';   // já chegou no andar, ou o alvo sumiu/morreu
    return;
  }
  if(e.fsm === 'AVOID_ZONE'){
    // Fora da zona: corre pra um ponto aleatório bem dentro da área segura atual (não
    // sempre o centro cravado, senão os 49 bots convergem todos pro mesmo pixel) — mas
    // continua atirando se um alvo aparecer no caminho, não é uma fuga cega.
    if(zoneCurrent && zoneCurrent.r>0){
      if(!e.zoneGoal || Math.hypot(e.zoneGoal.x-e.x, e.zoneGoal.y-e.y) < MTILE*2){
        const ang=Math.random()*6.28, rad=Math.random()*zoneCurrent.r*0.6;
        e.zoneGoal = { x: zoneCurrent.cx+Math.cos(ang)*rad, y: zoneCurrent.cy+Math.sin(ang)*rad };
      }
      setBotGoal(e, Math.floor(e.zoneGoal.x/MTILE), Math.floor(e.zoneGoal.y/MTILE));
    }
    updateBotPathing(e, dt); followPath(e, dt);
    const t = e.target;
    if(t){ e.aimAngle = turnToward(e.aimAngle, Math.atan2((t.y-6)-(e.y-6), t.x-e.x), AI_TURN_RATE*dt); botTryFire(e, dt, t); }
    return;
  }
  if(e.fsm === 'ENGAGE'){
    // Mira no alvo (ou na última posição conhecida) sempre por ÚLTIMO, depois de mover —
    // followPath/botStrafe sobrescrevem aimAngle com a direção do movimento (waypoint
    // do path, que ziguezagueia contornando parede/escada), então setar a mira ANTES
    // do movimento fazia ela "tremer" seguindo o caminho em vez de travar no alvo (era
    // a mira frenética "pra vários lados" quando na real tava só perseguindo/reposicionando).
    const t = e.target, aimAt = t || e.lastKnownTargetPos;
    if(t){
      const d = Math.hypot(t.x-e.x, t.y-e.y);
      if(e.gunOverheat){
        // Arma travada esfriando — recua um pouco em vez de ficar parado exposto perto
        // do alvo (só quando já tava perto; longe não faz sentido recuar mais ainda,
        // mas mesmo longe continua orbitando em vez de travar parado esperando esfriar).
        if(d < AI_ENGAGE_STOP_DIST*1.5){
          const dx=e.x-t.x, dy=e.y-t.y, dd=Math.hypot(dx,dy)||1;
          const gx = clamp(e.x + dx/dd*MTILE*3, 0, WORLD_W-1), gy = clamp(e.y + dy/dd*MTILE*3, 0, WORLD_H-1);
          setBotGoal(e, Math.floor(gx/MTILE), Math.floor(gy/MTILE));
          updateBotPathing(e, dt); followPath(e, dt);
        } else { e.path=[]; e.pathGoal=null; botStrafe(e, t, dt); }
      } else if(d > AI_ENGAGE_STOP_DIST){
        setBotGoal(e, Math.floor(t.x/MTILE), Math.floor(t.y/MTILE));
        updateBotPathing(e, dt); followPath(e, dt);
      } else {
        // Dentro do alcance de tiro — não trava parado: orbita/strafe ao redor do alvo
        // enquanto atira, trocando de lado de vez em quando (ou se bater em algo).
        e.path=[]; e.pathGoal=null;
        botStrafe(e, t, dt);
      }
      e.aimAngle = turnToward(e.aimAngle, Math.atan2((aimAt.y-6)-(e.y-6), aimAt.x-e.x), AI_TURN_RATE*dt);
      botTryFire(e, dt, t);
    } else if(e.lastKnownTargetPos){
      setBotGoal(e, Math.floor(e.lastKnownTargetPos.x/MTILE), Math.floor(e.lastKnownTargetPos.y/MTILE));
      updateBotPathing(e, dt); followPath(e, dt);
      e.aimAngle = turnToward(e.aimAngle, Math.atan2((aimAt.y-6)-(e.y-6), aimAt.x-e.x), AI_TURN_RATE*dt);
    }
    return;
  }
  if(e.fsm === 'SEEK_LOOT' && e.lootGoal){
    const lx = e.lootGoal.c*MTILE+MTILE/2, ly = e.lootGoal.r*MTILE+MTILE/2;
    const d = Math.hypot(e.x-lx, e.y-ly);
    // Confere se o baú na célula ainda precisa de carga — aberto = já foi, segue
    // atrás do loot (a arma que saltou) em vez de travar parado no lugar.
    const chestHere = chests.find(b=>b.c===e.lootGoal.c && b.r===e.lootGoal.r);
    const stillCharging = chestHere && (chestHere.st==='closed' || chestHere.st==='charging');
    if(d >= CHEST_RANGE*0.8 || !stillCharging){
      setBotGoal(e, e.lootGoal.c, e.lootGoal.r);
      updateBotPathing(e, dt); followPath(e, dt);
    } else {
      e.moving = false;   // parado, olhando pro loot — a carga do baú não reseta!
      e.flip = e.x > lx;  // virado pro baú/arma
    }
    return;
  }
  // EXPLORE
  if(!e.wanderTarget || Math.hypot(e.wanderTarget.c*MTILE-e.x, e.wanderTarget.r*MTILE-e.y) < MTILE*1.5){
    e.wanderTarget = pickWanderTarget(e);
    setBotGoal(e, e.wanderTarget.c, e.wanderTarget.r);
  }
  updateBotPathing(e, dt); followPath(e, dt);
}
// Pega arma do chão (mesma regra de proximidade do player) — só troca se for upgrade real,
// senão o bot ignoraria a que já escolheu ir buscar toda vez que passa por cima de outra.
function botCheckGunPickup(e){
  let cur=-1;
  for(let gi=0; gi<gunItems.length; gi++){
    const it=gunItems[gi];
    if(!it.t) continue;   // slot vazio (pistola descartada num swap — não fica largada)
    const gx=it.c*MTILE+MTILE/2, gy=it.r*MTILE+MTILE/2;
    // Raio bem maior que o do player (MTILE*0.6): o player anda até o centro exato do
    // item de propósito, mas um bot só passa perto por acaso (lutando/fugindo) — com o
    // raio apertado ele "roça" no item sem nunca entrar no círculo e nunca troca de arma,
    // e isso pega muito mais os bots que já upgraram (só contam com esse encontro casual;
    // o bot ainda na pistola tem o SEEK_LOOT mirando o centro exato do tile).
    if(Math.hypot(e.x-gx, e.y-gy) < MTILE*1.0){ cur=gi; break; }
  }
  if(cur!==-1 && cur!==e.overlapGunIdx && isUpgrade(e, gunItems[cur].t)){
    const it=gunItems[cur], old=e.gun;
    e.gun=it.t;
    it.t = old==='pistola' ? null : old;   // pistola descartada só some, não fica largada
    e.fireCooldown=0;
    pickupSound(gunshotAtten(e.x, e.y));
  }
  e.overlapGunIdx = cur;
}

// ── Caveira saindo do corpo ao morrer: sobe, balança e some (ícone da folha interface) ──
// O abate soma na hora e o chip de ABATES pulsa/brilha (killPulseT/killBurstT), sem a
// caveira precisar viajar até lá — só o "pop" no corpo mesmo.
const DEATH_RISE_DUR = 1.1;
let deathPops = [];        // {wx,wy,t,sway}
let killPulseT = 999;      // tempo desde o abate (999 = parado) — dá o bounce no chip
let killBurstT = 999;      // brilho/anel expandindo no chip
function spawnDeathPop(x, y){
  deathPops.push({ wx:x, wy:y, t:0, sway:Math.random()*6.28 });
}
function updateDeathPops(dt){
  for(const p of deathPops) p.t += dt;
  deathPops = deathPops.filter(p => p.t < DEATH_RISE_DUR);
  killPulseT += dt; killBurstT += dt;
}
// Sobe do corpo com pop de escala, balança e desvanece (mundo, segue a câmera)
function drawDeathPopsWorld(){
  if(!IMG.interface) return;
  for(const p of deathPops){
    const k = p.t/DEATH_RISE_DUR;
    const sc = k<0.18 ? 0.3+(k/0.18)*1.05 : 1.35-Math.min(1,(k-0.18)/0.3)*0.35;
    const ds = 20*sc;
    const sx = p.wx + Math.sin(p.t*4+p.sway)*4, sy = p.wy - 16*Math.min(1,k/0.3);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.globalAlpha = k>0.55 ? Math.max(0, 1-(k-0.55)/0.45) : 1;
    ctx.drawImage(IMG.interface, 1*16, 3*16, 16, 16, -ds/2, -ds/2, ds, ds);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
// ── Estilhaços do escudo quebrando: cacos azuis voando + anel de choque (mundo) ──
let shieldBreaks = [];   // {x,y,t,dur,shards:[{ang,spd,rot,rotSpd,len}]}
function spawnShieldBreak(x, y){
  const shards = [];
  for(let i=0;i<10;i++){
    shards.push({
      ang: (i/10)*6.28 + (Math.random()*2-1)*0.3,
      spd: MTILE*(2.5+Math.random()*3),
      rot: Math.random()*6.28, rotSpd: (Math.random()*2-1)*10,
      len: MTILE*(0.22+Math.random()*0.16),
    });
  }
  shieldBreaks.push({ x, y, t:0, dur:0.5, shards });
}
function updateShieldBreaks(dt){
  for(const b of shieldBreaks) b.t += dt;
  shieldBreaks = shieldBreaks.filter(b => b.t < b.dur);
}
function drawShieldBreaks(){
  for(const b of shieldBreaks){
    const k = b.t/b.dur, fade = Math.max(0, 1-k/0.8);
    // Anel de choque se expandindo
    ctx.save();
    ctx.globalAlpha = fade*0.6; ctx.strokeStyle = DMG_COLOR_SHIELD; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(b.x, b.y, 4+k*22, 0, 6.28); ctx.stroke();
    ctx.restore();
    // Cacos triangulares voando pra fora, girando e sumindo
    for(const s of b.shards){
      const dist = s.spd*k;
      const sx = b.x + Math.cos(s.ang)*dist, sy = b.y + Math.sin(s.ang)*dist - k*k*30;   // leve gravidade
      ctx.save();
      ctx.translate(sx, sy); ctx.rotate(s.rot + s.rotSpd*k);
      ctx.globalAlpha = fade;
      ctx.fillStyle = DMG_COLOR_SHIELD;
      ctx.beginPath();
      ctx.moveTo(0,-s.len*0.5); ctx.lineTo(s.len*0.4,s.len*0.4); ctx.lineTo(-s.len*0.4,s.len*0.4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}
//======================= FONTE BITMAP (folha interface) =======================
// Linhas 5-7 da folha: % + - 0-9 · A-M · N-Z (tiles 16px, glifo útil ~10px, y1-14).
// Glifos que a folha não tem (: / ° ! .) são desenhados à mão na mesma paleta,
// numa 4ª linha do canvas base. Tingida por cor via multiply (cache por cor).
const FONT_OUT='#47324b', FONT_FACE='#ffffff', FONT_SH='#999ac4';   // paleta amostrada da folha
const GLYPH_W = { I:6, J:8, M:12, W:12, '1':8, '+':8, '-':8, ':':5, '.':5, '!':4, '/':12, '°':7, ' ':5 };
const glyphW = ch => GLYPH_W[ch] ?? 10;
const fontBases = {};   // 'flat' (linhas 8-10, sem sombra — layout) | 'shaded' (linhas 5-7 — dano)
const fontCache = {};
function glyphPos(ch){
  const c = ch.charCodeAt(0);
  if(ch>='0'&&ch<='9') return [3+(c-48), 0];
  if(ch>='A'&&ch<='M') return [c-65, 1];
  if(ch>='N'&&ch<='Z') return [c-78, 2];
  if(ch==='%') return [0,0];
  if(ch==='+') return [1,0];
  if(ch==='-') return [2,0];
  const extra = {':':0, '/':1, '°':2, '!':3, '.':4};
  if(ch in extra) return [extra[ch], 3];
  return null;
}
function buildFontBase(style){
  const base = document.createElement('canvas'); base.width=208; base.height=64;
  const g = base.getContext('2d'); g.imageSmoothingEnabled=false;
  g.drawImage(IMG.interface, 0, (style==='flat' ? 8 : 5)*16, 208, 48, 0, 0, 208, 48);
  const y = 48, sh = style!=='flat';   // 4ª linha: glifos extras (chapado = sem sombra)
  const dot=(x,dy)=>{ g.fillStyle=FONT_OUT; g.fillRect(x,y+dy,5,5);
    g.fillStyle=FONT_FACE; g.fillRect(x+1,y+dy+1,3,sh?2:3);
    if(sh){ g.fillStyle=FONT_SH; g.fillRect(x+1,y+dy+3,3,1); } };
  dot(0*16+5, 2); dot(0*16+5, 9);                       // ':'
  dot(4*16+5, 9);                                       // '.'
  {                                                     // '/' em degraus de pixel (stroke antialiasado destoa)
    const px=1*16, cells=[];
    for(let yy=0; yy<12; yy++) cells.push([Math.round(10 - yy*6/11), 2+yy]);
    g.fillStyle=FONT_OUT;
    for(const [cx,cy] of cells) g.fillRect(px+cx-1, y+cy-1, 4, 3);
    g.fillStyle=FONT_FACE;
    for(const [cx,cy] of cells) g.fillRect(px+cx, y+cy, 2, 1);
  }
  g.strokeStyle=FONT_OUT; g.lineWidth=3.4;              // '°'
  g.beginPath(); g.arc(2*16+8, y+4.5, 3, 0, 6.29); g.stroke();
  g.strokeStyle=FONT_FACE; g.lineWidth=1.4;
  g.beginPath(); g.arc(2*16+8, y+4.5, 3, 0, 6.29); g.stroke();
  g.fillStyle=FONT_OUT; g.fillRect(3*16+6, y+1, 4, 8);  // '!'
  g.fillStyle=FONT_FACE; g.fillRect(3*16+7, y+2, 2, sh?5:6);
  if(sh){ g.fillStyle=FONT_SH; g.fillRect(3*16+7, y+7, 2, 1); }
  g.fillStyle=FONT_OUT; g.fillRect(3*16+6, y+10, 4, 4);
  g.fillStyle=FONT_FACE; g.fillRect(3*16+7, y+11, 2, 2);
  fontBases[style] = base;
  return base;
}
function fontSheet(rgb, style){
  const key = style+'|'+rgb;
  let c = fontCache[key];
  if(!c){
    const base = fontBases[style] || buildFontBase(style);
    c = document.createElement('canvas'); c.width=base.width; c.height=base.height;
    const g = c.getContext('2d'); g.imageSmoothingEnabled=false;
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation='multiply';
    g.fillStyle=rgb; g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation='destination-in';        // multiply mata o alpha — restaura
    g.drawImage(base, 0, 0);
    fontCache[key] = c;
  }
  return c;
}
function splitColor(c){    // 'rgba(r,g,b,a)' → cor sólida + alpha (o cache só aceita cor sólida)
  const m = /^rgba\(([^,]+),([^,]+),([^,]+),([^)]+)\)$/.exec((''+c).replace(/\s/g,''));
  return m ? {rgb:'rgb('+m[1]+','+m[2]+','+m[3]+')', a:+m[4]} : {rgb:c, a:1};
}
function bmpNorm(str){
  // NFD separa acentos em combinantes (̀-ͯ) — remove e caixa alta
  return (''+str).normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/[—–]/g,'-');
}
// Desenha texto com a fonte da folha. o = {color, align:left|center|right,
// valign:middle|top|alphabetic, alpha, ls (letter-spacing em px da folha, pode ser negativo)}
// Devolve a largura desenhada.
function drawBmpText(str, x, y, size, o={}){
  if(!IMG.interface) return 0;
  str = bmpNorm(str);
  const k = size/16, ls = (o.ls ?? 0)*k;
  let W = 0;
  for(const ch of str) W += glyphW(ch)*k + ls;
  if(str.length) W -= ls;
  const {rgb, a} = splitColor(o.color || '#ffffff');
  const sheet = fontSheet(rgb, o.shaded ? 'shaded' : 'flat');   // layout usa o chapado; dano usa o com sombra
  let cx = o.align==='center' ? x - W/2 : o.align==='right' ? x - W : x;
  const ty = o.valign==='top' ? y - 1*k : o.valign==='alphabetic' ? y - 14.5*k : y - 8*k;
  const pa = ctx.globalAlpha, aa = a*(o.alpha ?? 1);
  if(aa !== 1) ctx.globalAlpha = pa*aa;
  for(const ch of str){
    const gw = glyphW(ch), gp = glyphPos(ch);
    if(gp) ctx.drawImage(sheet, gp[0]*16, gp[1]*16, 16, 16, cx-(16-gw)/2*k, ty, size, size);
    cx += gw*k + ls;
  }
  ctx.globalAlpha = pa;
  return W;
}
function bmpTextW(str, size, ls=0){
  str = bmpNorm(str);
  const k = size/16; let W = 0;
  for(const ch of str) W += glyphW(ch)*k + ls*k;
  return str.length ? W - ls*k : 0;
}

//======================= CARDS E BARRAS DA FOLHA INTERFACE =======================
// Cards 48x48 no topo da folha (x = idx*48): medalhão redondo, dourado, laranja, cinza, vermelho, azul.
const UI_CARD = { medal:0, gold:1, orange:2, gray:3, red:4, blue:5 };
function drawCard(x,y,w,h,idx,bs=12){
  if(!IMG.interface) return;
  const S=48, B=8, sx=idx*S, img=IMG.interface;
  const m=(a,b,c,d, dx,dy,dw,dh)=>ctx.drawImage(img, sx+a, b, c, d, x+dx, y+dy, dw, dh);
  ctx.imageSmoothingEnabled=false;
  m(0,0,B,B,       0,0,bs,bs);           m(S-B,0,B,B,     w-bs,0,bs,bs);      // cantos
  m(0,S-B,B,B,     0,h-bs,bs,bs);        m(S-B,S-B,B,B,   w-bs,h-bs,bs,bs);
  m(B,0,S-2*B,B,   bs,0,w-2*bs,bs);      m(B,S-B,S-2*B,B, bs,h-bs,w-2*bs,bs); // bordas
  m(0,B,B,S-2*B,   0,bs,bs,h-2*bs);      m(S-B,B,B,S-2*B, w-bs,bs,bs,h-2*bs);
  m(B,B,S-2*B,S-2*B, bs,bs,w-2*bs,h-2*bs);                                    // centro
}
// Barras 64px de largura em x208-271: branca (container/vazia), laranja (HP), azul (escudo)
const UI_BARS = { white:{sy:97,sh:14}, orange:{sy:113,sh:14}, blue:{sy:130,sh:12} };
function uiBarSlice(b, x,y,w,h){
  const cap=5, sx=208, sw=64, ck=Math.min(w*0.33, cap*(h/b.sh));
  ctx.drawImage(IMG.interface, sx, b.sy, cap, b.sh, x, y, ck, h);
  // miolo: só a faixa limpa do 1º segmento (x214-239) — evita o divisor do asset em x247
  ctx.drawImage(IMG.interface, sx+cap+1, b.sy, 26, b.sh, x+ck, y, w-2*ck, h);
  ctx.drawImage(IMG.interface, sx+sw-cap, b.sy, cap, b.sh, x+w-ck, y, ck, h);
}
function drawUIBar(x,y,w,h,color,pct,ghost){
  if(!IMG.interface) return;
  ctx.imageSmoothingEnabled=false;
  uiBarSlice(UI_BARS.white, x,y,w,h);                     // trilho vazio
  pct=clamp(pct,0,1);
  if(ghost!==undefined && (ghost=clamp(ghost,0,1)) > pct+0.004){
    ctx.save(); ctx.beginPath(); ctx.rect(x+w*pct, y, w*(ghost-pct), h); ctx.clip();
    const pa=ctx.globalAlpha; ctx.globalAlpha=pa*0.5;     // trilha fantasma do dano recente
    uiBarSlice(UI_BARS[color], x,y,w,h);
    ctx.globalAlpha=pa; ctx.restore();
  }
  if(pct>0.01){
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w*pct, h); ctx.clip();
    uiBarSlice(UI_BARS[color], x,y,w,h);
    ctx.restore();
  }
}

// ── Números de dano ──
const DMG_COLOR = '#f2c14e', DMG_COLOR_KILL = '#ff5040', DMG_COLOR_SHIELD = '#4ac1ff';   // dourado; vermelho no golpe fatal; azul no escudo
let dmgPops = [];      // {x,y,vx,vy,t,dur,val,big,shield}
function spawnDmgPop(x, y, val, big, shield){
  dmgPops.push({ x: x + (Math.random()*2-1)*4, y,
    vx:(Math.random()*2-1)*10, vy:-(42+Math.random()*14),
    t:0, dur: big?0.9:0.65, val: Math.round(val), big:!!big, shield:!!shield });
}
function drawDmgPops(){
  if(!IMG.interface) return;
  for(const p of dmgPops){
    const k = p.t/p.dur;
    // Pop com overshoot: nasce pequeno, estoura e assenta; fade no fim
    const sc = k<0.15 ? 0.4 + (k/0.15)*0.95 : 1.35 - Math.min(1,(k-0.15)/0.25)*0.35;
    const ds = (p.big ? 12 : 8.5) * sc;
    const col = p.shield ? DMG_COLOR_SHIELD : p.big ? DMG_COLOR_KILL : DMG_COLOR;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = k>0.65 ? Math.max(0, 1-(k-0.65)/0.35) : 1;
    drawBmpText(p.val, 0, 0, ds, {color: col, align:'center', ls:-2, shaded:true});
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
// Hitbox de bala: o SPRITE inteiro (24x24 ancorado nos pés, mesmo desenho na tela).
// Vale igual pro inimigo e pro player — quando inimigos atirarem, usar bodyRect(player.x, player.y).
function bodyRect(x,y){ return { x0:x-SPR/2, y0:y-6-SPR/2, x1:x+SPR/2, y1:y-6+SPR/2 }; }
// segmento (x1,y1)→(x2,y2) cruza o retângulo? devolve o ponto de ENTRADA (slab method)
function segRectHit(x1,y1,x2,y2,rc){
  const dx=x2-x1, dy=y2-y1;
  let t0=0, t1=1;
  const p=[-dx, dx, -dy, dy], q=[x1-rc.x0, rc.x1-x1, y1-rc.y0, rc.y1-y1];
  for(let i=0;i<4;i++){
    if(Math.abs(p[i])<1e-9){ if(q[i]<0) return null; }      // paralelo e fora do slab
    else{
      const t=q[i]/p[i];
      if(p[i]<0){ if(t>t1) return null; if(t>t0) t0=t; }
      else      { if(t<t0) return null; if(t<t1) t1=t; }
    }
  }
  return { t:t0, x:x1+dx*t0, y:y1+dy*t0 };
}
// Golpe da faca automática: só existe durante MELEE_SWING_DUR — a lâmina varre um
// arco em torno do alvo (único frame estático, sem folha de animação própria, então
// o "corte" é o sprite girando/deslocando rápido no arco, não uma troca de frame).
function drawMeleeSwing(x, y, ang, swingT, weaponId){
  if(swingT<=0 || !IMG.weapons) return;
  const mw = WEAPONS[weaponId] || WEAPONS.faca;
  const k = 1 - swingT/MELEE_SWING_DUR;           // 0→1 ao longo do golpe
  // Envelope de escala (cresce, segura, encolhe) e progresso do arco são
  // curvas SEPARADAS — o arco sempre termina de varrer (aos 60% do tempo) antes
  // da escala começar a encolher (75%), senão o corte parecia "cortado" na
  // metade mesmo sem nada cancelando de verdade.
  const scaleEnv = k<0.2 ? k/0.2 : k>0.75 ? Math.max(0,(1-k)/0.25) : 1;
  const sweepK = Math.min(1, k/0.6);
  const dist = SPR*0.55;
  const a0 = ang-0.7, a1 = ang-0.7+1.4*sweepK;     // varre de -0.7 a +0.7 rad em torno do alvo
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scaleEnv, scaleEnv);
  // Rastro branco brilhante do arco — o que faz o corte realmente "aparecer",
  // não só o ícone da faca (que sozinho é pequeno e passa despercebido).
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 3.2;
  ctx.beginPath(); ctx.arc(0, 0, dist, a0, a1); ctx.stroke();
  ctx.restore();
  // Lâmina na ponta do arco, maior que o normal pra ficar bem visível
  ctx.save();
  ctx.translate(Math.cos(a1)*dist, Math.sin(a1)*dist);
  ctx.rotate(a1 + Math.PI/4);
  const bladeScale = 1.4 * (mw.scale||1);         // machados desenham um pouco maiores
  ctx.scale(bladeScale, bladeScale);
  ctx.drawImage(IMG.weapons, mw.spr*SPR, (mw.row||0)*SPR, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR);
  ctx.restore();
  ctx.restore();
}
function drawEnemy(e){
  const frame = e.st==='dead' ? ENEMY_DEAD : e.frame;
  ctx.fillStyle='rgba(0,0,0,0.28)';
  ctx.beginPath(); ctx.ellipse(e.x, e.y+5, 6, 2.6, 0, 0, 6.28); ctx.fill();
  ctx.save(); ctx.translate(e.x, e.y-6);
  if(e.flip) ctx.scale(-1,1);
  if(e.flashT>0) ctx.filter='brightness(2.2) saturate(0.4)';   // flash branco ao levar tiro
  ctx.drawImage(IMG[e.sheet], frame*SPR, e.row*SPR, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR);
  ctx.restore();
  if(e.st==='alive'){
    drawBotWeapon(e);   // arma que o bot carrega — sempre visível, começa com pistola
    // faca automática: desenhada num passe FINAL à parte (ver draw()), sempre por
    // cima de todo mundo — aqui cobriria/seria coberta dependendo da ordem do loop.
    // Aura verde de cura (igual ao player) — mesma animação de anéis pulsando
    if(e.healAura > 0){
      const t = performance.now()/1000;
      const k = e.healAura/1.5;
      for(let ring=0;ring<3;ring++){
        const ph = (t*0.8 + ring*0.33) % 1;
        const rw = (k*1.2) * (0.55 + ph*0.45);
        ctx.strokeStyle = 'rgba(143,209,50,'+((1-ph)*rw*0.55).toFixed(3)+')';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(e.x, e.y-4, SPR*0.7 + ph*SPR*0.55, 0, 6.28); ctx.stroke();
      }
    }
    // barra de vida da folha interface acima da cabeça (trilho branco + laranja)
    const bw=MTILE*1.5, bh=bw*14/64;
    drawUIBar(e.x-bw/2, e.y-SPR+4, bw, bh, 'orange', e.hp/e.maxHp);
  }
}
// Arma do bot: mesma matemática de posição/rotação do player, versão simplificada
// (sem bounce de troca na animação — mas tem o mesmo superaquecimento/brilho do player).
function drawBotWeapon(e){
  if(!IMG.weapons) return;
  const wDef = WEAPONS[e.gun];
  const wx = e.x + Math.cos(e.aimAngle)*SPR*0.35;
  const wy = e.y-6 + Math.sin(e.aimAngle)*SPR*0.35;
  ctx.save();
  ctx.translate(wx, wy);
  ctx.rotate(e.aimAngle);
  if(Math.abs(e.aimAngle) > Math.PI/2) ctx.scale(1,-1);
  ctx.drawImage(IMG.weapons, wDef.spr*SPR, 0, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR);
  // Cano incandescente conforme esquenta — mesmo efeito visual do player
  if(e.gunHeat > 0.35){
    const gh=(e.gunHeat-0.35)/0.65, fl=0.75+0.25*Math.sin(performance.now()/40);
    ctx.globalCompositeOperation='lighter';
    const gg=ctx.createRadialGradient(SPR*0.30,0,0, SPR*0.30,0,7);
    gg.addColorStop(0,'rgba(255,120,40,'+(0.55*gh*fl).toFixed(3)+')');
    gg.addColorStop(1,'rgba(255,60,20,0)');
    ctx.fillStyle=gg; ctx.beginPath(); ctx.arc(SPR*0.30,0,7,0,6.28); ctx.fill();
    ctx.globalCompositeOperation='source-over';
  }
  ctx.restore();
  if(e.muzzleFlashT > 0){
    const fs = wDef.flash * 6;
    ctx.save(); ctx.translate(wx, wy); ctx.rotate(e.aimAngle);
    ctx.globalAlpha = Math.min(1, e.muzzleFlashT/0.05);
    ctx.fillStyle='#ffd97a';
    ctx.beginPath();
    ctx.moveTo(fs*1.6,0); ctx.lineTo(fs*0.35,fs*0.5); ctx.lineTo(-fs*0.2,0); ctx.lineTo(fs*0.35,-fs*0.5);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle='#fff6d8';
    ctx.beginPath(); ctx.arc(fs*0.25,0,fs*0.32,0,6.28); ctx.fill();
    ctx.restore(); ctx.globalAlpha=1;
  }
  // Badge de superaquecimento flutuando na arma — mesmo ícone do player
  if(e.gunOverheat || e.overheatFlash>0){
    const Tb = performance.now()/1000;
    const k = e.overheatFlash/1.6;
    const pop = e.overheatFlash>0 ? 1+Math.sin((1-k)*Math.PI)*0.35 : 1;
    ctx.save();
    ctx.translate(wx, wy - 13 + Math.sin(Tb*3)*1.2);
    ctx.scale(pop, pop);
    if(e.overheatFlash>0) ctx.rotate(Math.sin(Tb*14)*0.10);
    ctx.globalAlpha = e.gunOverheat ? 1 : Math.min(1, k*3);
    if(e.gunOverheat){
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
  showZoneBanner('ZONE 1/'+MAX_ZONES, 'first zone closes in 30s', '#f2c14e');
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
      showZoneBanner('FINAL ZONE', 'no safe area — fight!', '#ff4630');
      return;
    }
    // Começa a fechar — guarda estado inicial pra interpolar
    zoneShrinkFrom = {cx:zoneCurrent.cx, cy:zoneCurrent.cy, r:zoneCurrent.r};
    zoneShrinkDur = zoneNum >= MAX_ZONES - 4 ? ZONE_SHRINK_FAST : ZONE_SHRINK;
    zoneState = 'shrinking'; zoneTimer = zoneShrinkDur;
    showZoneBanner('THE ZONE IS CLOSING', 'run to the safe area', '#ff8c3c');
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
        showZoneBanner('ZONE '+(zoneNum+1)+'/'+MAX_ZONES, 'next zone in '+ZONE_WAIT+'s', '#f2c14e');
    }
  }
  // FX da zona (banner, flash, partículas da tempestade)
  if(zoneBanner){ zoneBanner.t -= dt; if(zoneBanner.t <= 0) zoneBanner = null; }
  zoneHitFlash = Math.max(0, zoneHitFlash - dt*2);
  updateZoneParts(dt);
  // Dano fora da zona (corpo morto não sofre mais dano/flash de zona)
  if(player.hp>0 && zoneCurrent && zoneState!=='idle'){
    const dist = Math.hypot(player.x - zoneCurrent.cx, player.y - zoneCurrent.cy);
    if(zoneCurrent.r <= 0 || dist > zoneCurrent.r){
      zoneDmgTimer += dt;
      if(zoneDmgTimer >= ZONE_DMG_TICK){
        zoneDmgTimer -= ZONE_DMG_TICK;
        const dmg = zoneNum < 5 ? 1 : 1 + (zoneNum - 4);  // 1 até zona 6, depois escala
        player.hp -= dmg;
        zoneHitFlash = 1;
        if(player.hp <= 0) killPlayer('the zone');
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
  zoneBanner = { text, sub, color, t:5, dur:5 };
}
// ── Seta da folha interface (triângulo, x48,y64 — 3 colunas à esquerda do "arrow-up") tingida por cor ──
const ZONE_ARROW_SRC = {sx:48, sy:64, s:16};
const zoneArrowCache = {};
function zoneArrowSheet(rgb){
  let c = zoneArrowCache[rgb];
  if(!c){
    const {sx,sy,s} = ZONE_ARROW_SRC;
    c = document.createElement('canvas'); c.width=s; c.height=s;
    const g = c.getContext('2d'); g.imageSmoothingEnabled=false;
    g.drawImage(IMG.interface, sx, sy, s, s, 0, 0, s, s);
    g.globalCompositeOperation='multiply';
    g.fillStyle=rgb; g.fillRect(0, 0, s, s);
    g.globalCompositeOperation='destination-in';
    g.drawImage(IMG.interface, sx, sy, s, s, 0, 0, s, s);
    zoneArrowCache[rgb] = c;
  }
  return c;
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
    if(IMG.interface){
      const asz = 26;
      ctx.save();
      ctx.translate(psx + Math.cos(ang)*(52+bob), psy + Math.sin(ang)*(52+bob));
      ctx.rotate(ang + Math.PI/2);   // o ícone da folha aponta pra cima — alinha com a direção calculada
      ctx.imageSmoothingEnabled=false;
      ctx.shadowColor='rgba(0,0,0,.5)'; ctx.shadowBlur=3;
      ctx.drawImage(zoneArrowSheet(col), -asz/2, -asz/2, asz, asz);
      ctx.restore();
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 4;
    drawBmpText(m+'M', psx + Math.cos(ang)*82, psy + Math.sin(ang)*82, 20, {color:col, align:'center'});
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
    ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 8;
    drawBmpText(b.text, VW/2, y, 40, {color:b.color, align:'center', valign:'alphabetic'});
    ctx.shadowBlur = 0;
    const lw = bmpTextW(b.text, 40);
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.fillRect(VW/2 - lw/2, y+10, lw, 1.5);
    if(b.sub){
      ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 5;
      drawBmpText(b.sub, VW/2, y+34, 17, {color:'rgba(255,255,255,.88)', align:'center', valign:'alphabetic'});
    }
    ctx.restore();
  }
}
// ── Indicadores de ameaça na borda da tela: aponta pra TODOS os bots vivos que
// estão fora da visão no momento — igual ao minimapa, mostra todo mundo.
function drawThreatIndicators(){
  const psx = (player.x - cam.x)*VIEW_SCALE, psy = (player.y - cam.y)*VIEW_SCALE;
  const margin = 26, minX=margin, minY=margin, maxX=VW-margin, maxY=VH-margin;
  const T = performance.now()/1000;
  for(const e of enemies){
    if(e.st!=='alive') continue;
    const engaging = e.fsm==='ENGAGE' && e.target===player;
    const sx = (e.x-cam.x)*VIEW_SCALE, sy = (e.y-cam.y)*VIEW_SCALE;
    if(sx>=0 && sx<=VW && sy>=0 && sy<=VH) continue;   // já visível na tela — sem indicador
    const ang = Math.atan2(e.y-player.y, e.x-player.x);
    const dx=Math.cos(ang), dy=Math.sin(ang);
    let t=Infinity;
    if(dx>0) t=Math.min(t,(maxX-psx)/dx); else if(dx<0) t=Math.min(t,(minX-psx)/dx);
    if(dy>0) t=Math.min(t,(maxY-psy)/dy); else if(dy<0) t=Math.min(t,(minY-psy)/dy);
    if(!isFinite(t)) t=0;
    const px = psx+dx*t, py = psy+dy*t;
    const pulse = engaging ? 0.75+0.25*Math.sin(T*10) : 0.7;
    const s = (engaging ? 7 : 5.5) * (engaging ? 1+0.12*Math.sin(T*10) : 1);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang + Math.PI/2);   // ponta aponta pra "cima" por padrão — alinha com a direção calculada
    ctx.fillStyle = engaging ? 'rgba(255,45,45,'+pulse.toFixed(3)+')' : 'rgba(255,150,40,0.7)';
    ctx.strokeStyle = 'rgba(30,0,0,.6)'; ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(-s*0.8, s*0.6);
    ctx.lineTo(s*0.8, s*0.6);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
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

// ── Contorno do player quando escondido (sob ponte/piso/sombra) — sem isso o
// player some por completo e perde a noção de onde está embaixo da ponte.
// Técnica: silhueta colorida do frame atual (multiply+destination-in, igual
// zoneArrowSheet), erodida 1px (4 cópias deslocadas em destination-in viram
// o "AND" das 4 direções) e subtraída da silhueta original — sobra só um
// anel fino PRA DENTRO do contorno real, sem inchar o personagem.
const _plyOutlineSil = {};
function playerSilhouette(frame, skin, sheet){
  const key = sheet+','+frame+','+skin;
  let c = _plyOutlineSil[key];
  if(!c){
    c = document.createElement('canvas'); c.width=SPR; c.height=SPR;
    const g = c.getContext('2d'); g.imageSmoothingEnabled=false;
    // desenhado um pouco menor que o sprite real (0.78x, centralizado) — contorno
    // no tamanho cheio do corpo lia como "personagem gordo/inchado".
    const sc=0.78, sw=SPR*sc, sh=SPR*sc, ox=(SPR-sw)/2, oy=(SPR-sh)/2;
    g.drawImage(IMG[sheet], frame*SPR, skin*SPR, SPR, SPR, ox, oy, sw, sh);
    g.globalCompositeOperation='source-in';
    g.fillStyle='#fff6cc';
    g.fillRect(0, 0, SPR, SPR);
    _plyOutlineSil[key] = c;
  }
  return c;
}
const _plyOutlineScratch = document.createElement('canvas');
_plyOutlineScratch.width = SPR; _plyOutlineScratch.height = SPR;
const _plyOutlineCtx = _plyOutlineScratch.getContext('2d');
_plyOutlineCtx.imageSmoothingEnabled = false;
const _plyEroded = document.createElement('canvas');
_plyEroded.width = SPR; _plyEroded.height = SPR;
const _plyErodedCtx = _plyEroded.getContext('2d');
_plyErodedCtx.imageSmoothingEnabled = false;
function playerOutlineImg(frame, skin, sheet){
  const sil = playerSilhouette(frame, skin, sheet);
  const gc = _plyErodedCtx;
  gc.clearRect(0, 0, SPR, SPR);
  gc.globalCompositeOperation = 'source-over';
  gc.drawImage(sil, 0, 0);
  gc.globalCompositeOperation = 'destination-in';
  for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) gc.drawImage(sil, dx, dy);
  gc.globalCompositeOperation = 'source-over';

  const g = _plyOutlineCtx;
  g.clearRect(0, 0, SPR, SPR);
  g.drawImage(sil, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(_plyEroded, 0, 0);
  g.globalCompositeOperation = 'source-over';
  return _plyOutlineScratch;
}
function drawPlayerOutline(px, py, flip){
  if(!IMG[player.sheet]) return;
  const img = playerOutlineImg(player.frame, player.skin, player.sheet);
  ctx.save();
  ctx.translate(px, py-6);
  if(flip) ctx.scale(-1,1);
  ctx.globalAlpha = 0.65;
  ctx.drawImage(img, -img.width/2, -img.height/2);
  ctx.restore();
}

//======================= RENDER =======================
let cam={x:0,y:0};
let spectator = null;       // inimigo sendo seguido depois que o player morre
let playerKiller = null;   // quem matou o player (pra focar nele primeiro)
// Transição "íris" ao clicar em JOGAR — duas fases: primeiro o círculo FECHA em
// cima do menu (jogarWipe), aí sim a partida começa de verdade por baixo, já
// escondida, e o círculo ABRE de novo revelando o mundo (introWipe).
let jogarWipe = null;    // fase 1 (fechando, sobre o menu) — {x,y,t,dur,maxR}
let introWipe = null;    // fase 2 (abrindo, sobre o jogo) — {x,y,t,dur,maxR}
let deathWipe = null;    // fase 1 (fechando, sobre a tela de morte) — {x,y,t,dur,maxR}
let menuWipe  = null;    // fase 2 (abrindo, sobre o menu de volta)
// Máscara compartilhada pelas duas fases — um "buraco" redondo na tela toda,
// com o anel dourado brilhando na borda enquanto anima.
function drawIrisMask(x, y, r, ringAlpha){
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VW, VH);
  ctx.moveTo(x+r, y);
  ctx.arc(x, y, r, 0, 6.283);
  ctx.fillStyle = '#0c0810';
  ctx.fill('evenodd');
  ctx.restore();
  if(ringAlpha > 0.002){
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283);
    ctx.strokeStyle = 'rgba(244,201,93,'+ringAlpha.toFixed(3)+')';
    ctx.lineWidth = 5; ctx.shadowColor = 'rgba(244,201,93,.9)'; ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.restore();
  }
}
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
  // 1.85) splash de gosma no instante da morte do bicho — 3 anéis crescendo em
  // sequência (tipo onda). Cresce em ease-out (rápido no início, desacelera) e o
  // alfa entra e sai suave (sem) — nada de "pop" nem corte brusco no fim.
  for(const s of critterSplashes){
    for(let ring=0; ring<SPLASH_RINGS; ring++){
      const rt = s.t - ring*SPLASH_RING_DELAY;
      if(rt<=0 || rt>=SPLASH_RING_DUR) continue;
      const k = rt/SPLASH_RING_DUR;
      const ease = Math.sin(Math.PI*k);          // 0→1→0 suave (entra e sai fluido)
      const growK = 1 - (1-k)*(1-k);              // ease-out: cresce rápido, desacelera
      ctx.save(); ctx.globalAlpha = ease*0.8;
      ctx.strokeStyle = 'rgba(79,156,134,0.85)'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.arc(s.x, s.y, growK*MTILE*0.9, 0, 6.28); ctx.stroke();
      ctx.restore();
    }
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

  // 1.95) inimigos — mortos primeiro (corpo no chão, desvanece e some depois de
  // CORPSE_LIFETIME), vivos por cima
  if(IMG.enemies && IMG.players){
    for(const e of enemies) if(e.st==='dead' && e.deathT<CORPSE_LIFETIME){
      const a = corpseAlpha(e);
      if(a<1){ ctx.save(); ctx.globalAlpha=a; }
      drawEnemy(e);
      if(a<1) ctx.restore();
    }
    for(const e of enemies) if(e.st!=='dead')  drawEnemy(e);
  }
  // 1.96) bicho — nasce/anda, sem oclusão própria (é pequeno e raso, sempre visível)
  if(IMG.enemies) for(const cr of critters) drawCritter(cr);

  // 2) player (sombra + mascote 24px, ancorado nos pés)
	  ctx.fillStyle='rgba(0,0,0,0.28)';
	  ctx.beginPath(); ctx.ellipse(player.x, player.y+5, 6, 2.6, 0, 0, 6.28); ctx.fill();
	  if(IMG[player.sheet]){
	    ctx.save(); ctx.translate(player.x, player.y-6);
	    if(player.flip) ctx.scale(-1,1);
	    ctx.drawImage(IMG[player.sheet], player.frame*SPR, player.skin*SPR, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR);
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
	      ctx.save(); ctx.translate(flashMx, flashMy); ctx.rotate(flashAng);
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
	  // Morto não carrega arma — igual bot morto (drawEnemy só chama drawBotWeapon se e.st==='alive').
	  if(_weaponOnBridge && player.hp>0) _drawWeapon();

  // armas no chão — na frente dos pisos
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
      drawUIBar(b.c*MTILE, b.r*MTILE - 7, MTILE, 4.5, 'blue', p);
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

  // baús — sempre atrás de tudo
  if(IMG.tiles){
    for(const b of chests){
      if(b.c<c0-1||b.c>=c1||b.r<r0-1||b.r>=r1) continue;
      _drawChest(b);
    }
  }

	  // ── Oclusão INDEPENDENTE por entidade (piso/escada/ponte/sombra + o reforço de
	  // blocos perto de ponte) — cada entidade (player e cada bot) decide sua PRÓPRIA
	  // visibilidade usando só a PRÓPRIA posição/nível. Nada aqui depende do estado de
	  // qualquer OUTRA entidade: antes o player tinha um passo GLOBAL à parte (rodava
	  // pelo mapa inteiro usando só player.L/onBridge/onSombra) que podia esconder ou
	  // revelar coisas perto de bots sem nenhuma relação — agora todo mundo (player
	  // incluso) passa pela MESMA função, exatamente como se cada um fosse "o player"
	  // na própria posição.
	  //
	  // Duas fases (esconder tudo primeiro, só depois desenhar quem fica visível): se
	  // cada um se escondesse/mostrasse num único passo, o redesenho de chão de um podia
	  // pintar por cima de OUTRO vizinho que devia continuar visível.
	  if(IMG.enemies && IMG.players){
	    // A célula (c,r) cobre alguém no nível L? (piso/escada acima, ponte ativa acima,
	    // ou sombra decorativa — sombra cobre em qualquer nível, como antes).
	    const _coveredFor = (c, r, L) => {
	      const ci = collInfo(collAt(c, r));
	      if(ci && ci.kind==='piso' && ci.level > L) return true;
	      if(ci && ci.kind==='escada' && Math.min(...ci.levels) > L) return true;
	      const ov = overAt(c, r);
	      if(ov>0 && (ov-1) >= L) return true;
	      if(sombra[idx(c,r)]) return true;
	      return false;
	    };
	    // Em cima de uma ESCADA nada cobre — mesma exceção pro player e pros bots.
	    const _isHiddenAt = (c, r, L) => {
	      const selfCi = collInfo(collAt(c, r));
	      if(selfCi && selfCi.kind==='escada') return false;
	      return _coveredFor(c, r, L);
	    };
	    // Redesenha a CÉLULA INTEIRA (todas as layers com conteúdo, de baixo pra cima),
	    // não só a de cima — se a de cima for uma sombra translúcida (comum: sombra fica
	    // por cima do andar na pilha de layers), redesenhar só ela deixava o sprite por
	    // baixo ainda parcialmente visível através da transparência da sombra.
	    const _drawTileAt = (c, r) => {
	      const i = idx(c,r);
	      for(let li=0; li<layers.length; li++){ const L=layers[li];
	        if(!L.tiles[i]) continue;
	        const a=(typeof L.alpha==='number')?L.alpha:1;
	        if(a<1){ ctx.save(); ctx.globalAlpha=a; }
	        blitMap(L.tiles[i], c*MTILE, r*MTILE);
	        if(a<1) ctx.restore();
	      }
	    };
	    // Raio de "esconder": nao e so o corpo (SPR/2) - a arma na mao fica deslocada do
	    // centro (SPR*0.35) e tem seu proprio raio (SPR/2) por cima disso, entao o alcance
	    // real do que precisa ser coberto e maior que o corpo sozinho. Sem essa folga, a
	    // arma (e o flash/selo de superaquecimento) ficava sobrando visivel fora da area
	    // escondida, mesmo com o corpo corretamente coberto por baixo. Vale igual pro
	    // player — é o mesmo raio, a mesma arma deslocada do centro.
	    const HIDE_PAD = SPR*1.6;
	    const hideCellsFor = (x, y) => {
	      const c0e=Math.floor((x-HIDE_PAD)/MTILE), c1e=Math.floor((x+HIDE_PAD)/MTILE);
	      const r0e=Math.floor((y-6-HIDE_PAD)/MTILE), r1e=Math.floor((y-6+HIDE_PAD)/MTILE);
	      const cells=[];
	      for(let r=r0e; r<=r1e; r++) for(let c=c0e; c<=c1e; c++) cells.push([c,r]);
	      return cells;
	    };
	    const hideCells = [];
	    const playerAnchorC = Math.floor(player.x/MTILE), playerAnchorR = Math.floor(player.y/MTILE);
	    const playerHidden = _isHiddenAt(playerAnchorC, playerAnchorR, player.L);
	    if(playerHidden) hideCells.push(...hideCellsFor(player.x, player.y));
	    const visibleDead = [], visibleAlive = [];
	    for(const e of enemies){
	      if(e.st==='dead' && e.deathT>=CORPSE_LIFETIME) continue;   // corpo ja sumiu
	      const anchorC = Math.floor(e.x/MTILE), anchorR = Math.floor(e.y/MTILE);
	      const isHidden = _isHiddenAt(anchorC, anchorR, e.L);
	      if(isHidden) hideCells.push(...hideCellsFor(e.x, e.y));
	      else (e.st==='dead' ? visibleDead : visibleAlive).push(e);
	    }
	    for(const [c,r] of hideCells) _drawTileAt(c,r);
	    if(!playerHidden){
	      // O player já foi desenhado bem cedo (antes de toda essa oclusão) — redesenha
	      // por cima aqui de novo, igual os bots, pra garantir que fica acima de
	      // qualquer redraw de chão feito acima (senão a arma podia flutuar visível
	      // mesmo com o corpo escondido por um piso acima, por exemplo).
	      ctx.save(); ctx.translate(player.x, player.y-6);
	      if(player.flip) ctx.scale(-1,1);
	      ctx.drawImage(IMG[player.sheet], player.frame*SPR, player.skin*SPR, SPR, SPR, -SPR/2, -SPR/2, SPR, SPR);
	      ctx.restore();
	      if(!_weaponOnBridge && IMG.weapons && player.hp>0) _drawWeapon();
	    } else {
	      // Escondido (ponte/piso acima/sombra): sem o sprite cheio, só um
	      // contorno por cima do chão redesenhado, pra saber onde está.
	      drawPlayerOutline(player.x, player.y, player.flip);
	    }
	    for(const e of visibleDead){
	      const a = corpseAlpha(e);
	      if(a<1){ ctx.save(); ctx.globalAlpha=a; }
	      drawEnemy(e);
	      if(a<1) ctx.restore();
	    }
	    for(const e of visibleAlive) drawEnemy(e);

	    // ── Blocos (grade/trilho) da ponte na FRENTE de quem estiver pisando NAQUELA
	    // ponte especificamente — por ENTIDADE (player e cada bot, cada um só revela os
	    // blocos da PRÓPRIA ponte que está tocando, no PRÓPRIO nível). Local, não um
	    // flag global só do player — isso é que vazava pra pontes/bots sem relação.
	    const revealedBlocks = new Set();
	    const revealBridgeBlocksFor = (ax, ay, L) => {
	      const half=SPR/2;
	      const c0b=Math.floor((ax-half)/MTILE), c1b=Math.floor((ax+half-0.001)/MTILE);
	      const r0b=Math.floor((ay-half)/MTILE), r1b=Math.floor((ay+half-0.001)/MTILE);
	      for(let r=r0b; r<=r1b; r++) for(let c=c0b; c<=c1b; c++){
	        if(!bridgeActive(overAt(c,r), L)) continue;
	        for(let dr=-1; dr<=1; dr++) for(let dc=-1; dc<=1; dc++){
	          const nc=c+dc, nr=r+dr, key=nc+','+nr;
	          if(revealedBlocks.has(key)) continue;
	          const ci=collInfo(collAt(nc,nr));
	          if(ci && ci.kind==='block'){ revealedBlocks.add(key); _drawTileAt(nc,nr); }
	        }
	      }
	    };
	    if(!playerHidden) revealBridgeBlocksFor(player.x, player.y-6, player.L);
	    for(const e of visibleAlive) revealBridgeBlocksFor(e.x, e.y-6, e.L);
	    for(const e of visibleDead)  revealBridgeBlocksFor(e.x, e.y-6, e.L);

	    // ── Golpe de faca: passe FINAL, por cima de todo mundo (player e bots) — se
	    // desenhasse junto com cada sprite, quem fosse desenhado DEPOIS (ordem de loop)
	    // cobria o corte de quem golpeou antes.
	    if(!playerHidden && player.hp>0) drawMeleeSwing(player.x, player.y-6, player.facaSwingAng, player.facaSwingT, meleeIdFor(player));
	    for(const e of visibleAlive) drawMeleeSwing(e.x, e.y-6, e.facaSwingAng, e.facaSwingT, meleeIdFor(e));
	  }


// 3d) Balas e sparks — esconde balas sob ponte
	  if(IMG.interface){
	    for(const b of bullets){
	      const bcx = Math.floor(b.x/MTILE), bcy = Math.floor(b.y/MTILE);
	      const bov = overAt(bcx, bcy);
	      if(bov > 0 && (bov-1) >= b.level) continue;   // bala sob/na ponte: escondida pelo asset
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
	      const bcx = Math.floor(b.x/MTILE), bcy = Math.floor(b.y/MTILE);
	      const bov = overAt(bcx, bcy);
	      if(bov > 0 && (bov-1) >= b.level) continue;
	      ctx.fillStyle='#2a2218';
	      ctx.beginPath(); ctx.arc(b.x, b.y, 2.2, 0, 6.28); ctx.fill();
	      ctx.fillStyle='#f0e8d8';
	      ctx.beginPath(); ctx.arc(b.x, b.y, 1, 0, 6.28); ctx.fill();
	    }
	  }
	  for(const h of hits){
		// Esconde faísca sob ponte (mesmo critério das balas)
		const hcx = Math.floor(h.x/MTILE), hcy = Math.floor(h.y/MTILE);
		const hov = overAt(hcx, hcy);
		if(hov > 0 && (hov-1) >= h.level) continue;
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
  // 3e) Números de dano + caveira subindo do corpo + estilhaços de escudo — por cima de tudo no mundo
  drawDmgPops();
  drawDeathPopsWorld();
  drawCoinPopsWorld();
  drawCritterHealPops();
  drawShieldBreaks();
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
  drawThreatIndicators();   // seta na borda apontando pra bots fora da tela te ameaçando
  drawBars();
  drawMinimap();
  drawKillFeed();
  drawSlots();

  // Custom crosshair (por cima de tudo)
  if(IMG.weapons){
    const cs=SPR*2;
    ctx.drawImage(IMG.weapons, 5*SPR, 3*SPR, SPR, SPR, mouse.sx-cs/2, mouse.sy-cs/2, cs, cs);
  }

  // ── Transição íris fase 2 (ver introWipe) — por cima de TUDO, inclusive o crosshair ──
  if(introWipe){
    const k = Math.min(1, introWipe.t/introWipe.dur);
    const e = 1-Math.pow(1-k, 3);           // ease-out: abre rápido e assenta suave
    const r = Math.max(0, introWipe.maxR * e);
    drawIrisMask(introWipe.x, introWipe.y, r, k<1 ? 0.9*(1-k) : 0);
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
//── Ícones em grade de pixel (blocos retos — combina com o resto da UI, sem curvas suaves) ──
// pattern: array de strings, 'X' = célula pintada, '.' = transparente (deixa o fundo do card aparecer)
function drawPixelGlyph(pattern, cx, cy, cell, color){
  const gh=pattern.length, gw=pattern[0].length;
  ctx.fillStyle=color;
  for(let r=0;r<gh;r++){
    const row=pattern[r];
    for(let c=0;c<gw;c++){
      if(row[c]==='X'){
        const x=Math.round(cx+(c-gw/2)*cell), y=Math.round(cy+(r-gh/2)*cell);
        ctx.fillRect(x, y, Math.ceil(cell), Math.ceil(cell));
      }
    }
  }
}
// Ampulheta: só triângulos retos (nada de círculo) — TEMPO
const GLYPH_HOURGLASS = ['XXXXXXX','.XXXXX.','..XXX..','...X...','..XXX..','.XXXXX.','XXXXXXX'];
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
// Fator de encolhimento do HUD no mobile: mesma lógica do uiScale() do menu —
// sem isso o card de vitais de 332px encosta na borda direita em telas de 390px.
function drawBars(){
  const T=performance.now()/1000;
  // ═══ Cartão de vitais (canto inferior esquerdo) ═══
  const W=332, H=88, X=20, Y=VH-H-18;
  const lowHp = player.hp<=30;
  ctx.save();
  // Painel — card cinza da folha interface
  drawCard(X, Y, W, H, UI_CARD.gray, 12);
  if(lowHp){
    // Reto — o card da folha tem cantos vivos, um contorno arredondado destoaria
    ctx.strokeStyle='rgba(255,60,40,'+(0.45+0.35*Math.sin(T*6)).toFixed(3)+')';
    ctx.lineWidth=2; ctx.strokeRect(X+2,Y+2,W-4,H-4);
  }
  // Avatar dentro do medalhão redondo da folha
  const acx=X+44, acy=Y+H/2, ar=30;
  if(IMG.interface){
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(IMG.interface, 0, 0, 48, 48, acx-ar-6, acy-ar-6, (ar+6)*2, (ar+6)*2);
  }
  ctx.save();
  ctx.beginPath(); ctx.arc(acx,acy,ar*0.8,0,6.28); ctx.clip();
  if(IMG[player.sheet]){
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(IMG[player.sheet], 0, (player.skin||0)*SPR, SPR, SPR, acx-33, acy-30, 66, 66);
  }
  ctx.restore();
  // Barras à direita do avatar (sem ícones — as cores já dizem o que é)
  // Mesma largura pras duas — números alinham numa coluna só — e bem coladas uma na outra
  const bx=X+90, bw=W-90-70;
  const shY=Y+24, shH=15, gapBars=3, hpY=shY+shH+gapBars, hpH=25;
  drawUIBar(bx, shY, bw, shH, 'blue', player.armor/100, armorGhost/100);
  // Glow de recarga: brilha na ponta enquanto regenera
  if(player.armor < 100 && shieldRechargeTimer >= 5){
    const rgw = bw*clamp(player.armor/100,0,1);
    ctx.fillStyle = 'rgba(130,210,255,'+(0.35+0.25*Math.sin(performance.now()/1000*6)).toFixed(3)+')';
    ctx.fillRect(bx+rgw-3, shY+2, 5, shH-4);
  }
  drawBmpText(player.armor|0, bx+bw+14, shY+shH/2+1, 15, {color:'#b0d8ff'});
  // HP (grossa, embaixo)
  drawUIBar(bx, hpY, bw, hpH, 'orange', player.hp/100, hpGhost/100);
  // Número grande de HP — mesma coluna do escudo, acima
  drawBmpText(player.hp|0, bx+bw+14, hpY+hpH/2+1, 26, {color: lowHp ? '#ff8d75' : '#fff'});
  ctx.restore();
  // Pulso vermelho na tela com HP baixo
  if(lowHp && player.hp>0){
    const a=(0.10+0.08*Math.sin(T*6))*(1-player.hp/30);
    const g=ctx.createRadialGradient(VW/2,VH/2,Math.min(VW,VH)*0.35, VW/2,VH/2,Math.max(VW,VH)*0.60);
    g.addColorStop(0,'rgba(180,20,10,0)'); g.addColorStop(1,'rgba(180,20,10,'+a.toFixed(3)+')');
    ctx.fillStyle=g; ctx.fillRect(0,0,VW,VH);
  }
  // ═══ Chip de abates (topo esquerdo, compacto): caveira da folha + número ═══
  // Reage ao impacto da caveira que chega voando: brilho expandindo + bounce de escala
  const kW = 60 + bmpTextW(''+kills, 19), kH=38, kX=20, kY=18;
  const kcx=kX+kW/2, kcy=kY+kH/2;
  const kpDur=0.4, kp = killPulseT<kpDur ? Math.sin((killPulseT/kpDur)*Math.PI) : 0;
  const kbDur=0.5, kb = killBurstT<kbDur ? 1-killBurstT/kbDur : 0;
  if(kb>0){
    ctx.save();
    ctx.globalAlpha = kb*0.85;
    ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 2+kb*2;
    ctx.beginPath(); ctx.arc(kcx, kcy, 18+(1-kb)*32, 0, 6.28); ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.translate(kcx, kcy); ctx.scale(1+kp*0.3, 1+kp*0.3); ctx.translate(-kcx, -kcy);
  drawCard(kX, kY, kW, kH, UI_CARD.gray, 10);
  if(kb>0){ ctx.fillStyle='rgba(242,193,78,'+(kb*0.35).toFixed(3)+')'; ctx.fillRect(kX, kY, kW, kH); }
  if(IMG.interface){
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(IMG.interface, 1*16, 3*16, 16, 16, kX+9, kY+kH/2-14, 28, 28);
  }
  drawBmpText(kills, kX+44, kY+kH/2+1, 19, {color:'#fff'});
  ctx.restore();
  // ═══ Chip de moedas (colado ao lado do de abates): moeda dourada desenhada na hora ═══
  const cW = 60 + bmpTextW(''+coins, 19), cH=38, cGap=8, cX=kX+kW+cGap, cY=18;
  const ccx=cX+cW/2, ccy=cY+cH/2;
  const cpDur=0.4, cp = coinPulseT<cpDur ? Math.sin((coinPulseT/cpDur)*Math.PI) : 0;
  const cbDur=0.5, cb = coinBurstT<cbDur ? 1-coinBurstT/cbDur : 0;
  if(cb>0){
    ctx.save();
    ctx.globalAlpha = cb*0.85;
    ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 2+cb*2;
    ctx.beginPath(); ctx.arc(ccx, ccy, 18+(1-cb)*32, 0, 6.28); ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.translate(ccx, ccy); ctx.scale(1+cp*0.3, 1+cp*0.3); ctx.translate(-ccx, -ccy);
  drawCard(cX, cY, cW, cH, UI_CARD.gray, 10);
  if(cb>0){ ctx.fillStyle='rgba(242,193,78,'+(cb*0.35).toFixed(3)+')'; ctx.fillRect(cX, cY, cW, cH); }
  const coinCx = cX+9+14, coinCy = cY+cH/2;
  ctx.save();
  ctx.translate(Math.round(coinCx), Math.round(coinCy));
  drawCoinShape(17);
  ctx.restore();
  drawBmpText(coins, cX+44, cY+cH/2+1, 19, {color:'#fff'});
  ctx.restore();
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
    // Todos os inimigos vivos = pontos vermelhos (mais brilhante quem tá te engajando)
    for(const e of enemies){
      if(e.st!=='alive') continue;
      const engaging = e.fsm==='ENGAGE' && e.target===player;
      ctx.fillStyle = engaging ? '#ff2d2d' : '#c23b3b';
      ctx.beginPath();
      ctx.arc(cx+(e.x/MTILE-pc)*z, cy+(e.y/MTILE-pr)*z, engaging?2.6:2, 0, 6.28);
      ctx.fill();
    }
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
  ctx.strokeStyle='#b7b3c8'; ctx.lineWidth=3;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,6.28); ctx.stroke();
  ctx.strokeStyle='#47324b'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(cx,cy,R+2.5,0,6.28); ctx.stroke();
  // ═══════════ Bússola fixa ao redor do minimapa (N sempre no topo) ═══════════
  const ringIn = R + 5, ringOut = R + 16, ringMid = (ringIn + ringOut) / 2;
  {
    ctx.save();
    // Fundo escuro só na borda (aro fino)
    ctx.strokeStyle = 'rgba(40,28,44,.72)';
    ctx.lineWidth = ringOut - ringIn;
    ctx.beginPath(); ctx.arc(cx, cy, ringMid, 0, 6.28); ctx.stroke();
    // Borda interna e externa sutis
    ctx.strokeStyle = 'rgba(183,179,200,.35)';
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
        drawBmpText(cardLabels[d], lx, ly, 13, {color: d===0 ? '#f2c14e' : '#fff', align:'center'});
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
  const panelW=196, panelX=(cx+R)-panelW, panelTop=cy+ringOut+14;   // encostado na borda direita do minimapa
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

  // ── Cards soltos da folha (zona colorida por estado + tiles cinza) ──
  const zoneOn = zoneState!=='idle';
  const zoneH=110, tilesH=54;

  let py=panelTop;

  // ═══ 1. CARD ZONA ═══
  if(zoneOn){
    const zx=panelX, zw=panelW, zh=zoneH;
    // Card colorido pelo estado (cinza=safe, dourado=alerta, laranja=fechando, vermelho=final)
    const zCard = zoneState==='final' ? UI_CARD.red
                : zoneState==='shrinking' ? UI_CARD.orange
                : inSafe ? UI_CARD.gray : UI_CARD.gold;
    drawCard(zx, py, zw, zh, zCard, 10);

    // Header: label + ícone de status (menor, no topo direito)
    drawBmpText('ZONE', zx+14, py+10, 12, {color:'rgba(255,255,255,.75)', valign:'top'});
    ctx.save(); ctx.translate(zx+zw-20, py+19);
    drawZoneIcon(0, 0, zIcon, 'rgb(255,255,255)');
    ctx.restore();

    // Número da zona (ou FINAL) + timer pulsando quando urgente
    drawBmpText(zoneState==='final' ? 'FINAL' : (zoneNum+1)+'/'+MAX_ZONES, zx+14, py+25, 28, {color:'#fff', valign:'top'});
    const tScale = zUrgent ? 1+0.07*Math.sin(T*8) : 1;
    ctx.save();
    ctx.translate(zx+zw-14, py+42); ctx.scale(tScale,tScale);
    // 'S' menor que os dígitos — senão "28S" lê como "285"
    const tCol = '#fff';   // urgência já é dita pela cor do card + pulso
    drawBmpText('S', 0, 3, 16, {color:tCol, align:'right'});
    drawBmpText(Math.ceil(zoneTimer), -bmpTextW('S',16)-2, 0, 30, {color:tCol, align:'right'});
    ctx.restore();

    // Pips das 10 zonas: passadas · atual (pulsando) · futuras
    const pipY=py+zh-30, pipL=zx+14, pipSpan=zw-28, step=pipSpan/MAX_ZONES;
    for(let i=0;i<MAX_ZONES;i++){
      const pcx=pipL+step*i+step/2;
      const cur = i===zoneNum;
      const s = cur ? 4.6*(1+0.25*Math.sin(T*4)) : 3.6;
      ctx.save();
      ctx.translate(pcx, pipY); ctx.rotate(Math.PI/4);
      if(cur){
        ctx.shadowColor='#fff'; ctx.shadowBlur=6;
        ctx.fillStyle='#fff';
        ctx.fillRect(-s/2,-s/2,s,s);
      } else if(i<zoneNum){
        ctx.fillStyle='rgba(255,255,255,.55)';
        ctx.fillRect(-s/2,-s/2,s,s);
      } else {
        ctx.strokeStyle='rgba(71,50,75,.6)'; ctx.lineWidth=1;
        ctx.strokeRect(-s/2,-s/2,s,s);
      }
      ctx.restore();
    }

    // Barra de progresso — trilho e preenchimento da folha interface
    const barX=zx+14, barW=zw-28, barY=py+zh-18, barH=9;
    drawUIBar(barX, barY, barW, barH, 'orange', zProgress);

    py+=zh+6;
  }

  // ═══ 2. TILES LADO A LADO: VIVOS | TEMPO ═══
  {
    const tw2=(panelW-6)/2, th=tilesH;
    // ── VIVOS (esquerda) ──
    const vx=panelX, vy=py;
    drawCard(vx, vy, tw2, th, UI_CARD.gray, 8);
    drawBmpText('ALIVE', vx+12, vy+9, 11, {color:'rgba(255,255,255,.75)', valign:'top'});
    drawBmpText((player.hp>0?1:0)+enemies.filter(e=>e.st==='alive').length, vx+12, vy+21, 23, {color:'#fff', valign:'top'});
    // Ícone: a mesma seta do jogador (bússola/topo da cabeça) — reaproveita o motivo do próprio jogo
    const hx=vx+tw2-19, hy=vy+th/2+3;
    ctx.save(); ctx.translate(hx, hy);
    ctx.fillStyle='#fff'; ctx.strokeStyle='rgba(26,36,32,.6)'; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.moveTo(0,-7); ctx.lineTo(-4.5,5); ctx.lineTo(0,2); ctx.lineTo(4.5,5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // ── TEMPO (direita) ──
    const tx=panelX+tw2+6, ty=py;
    drawCard(tx, ty, tw2, th, UI_CARD.gray, 8);
    const mm=String(Math.floor(elapsedT/60)).padStart(2,'0'), ss=String(Math.floor(elapsedT%60)).padStart(2,'0');
    drawBmpText('TIME', tx+12, ty+9, 11, {color:'rgba(255,255,255,.75)', valign:'top'});
    drawBmpText(mm+':'+ss, tx+12, ty+23, 18, {color:'#fff', valign:'top'});
    // Ampulheta em blocos + grão de areia caindo pelo gargalo (só retas, sem círculo)
    const icx=tx+tw2-19, icy=ty+th/2+3;
    drawPixelGlyph(GLYPH_HOURGLASS, icx, icy, 2.1, 'rgba(255,255,255,.85)');
    const dropK=(T*0.9)%1, dropY=icy-6+dropK*12;
    ctx.fillStyle='rgba(255,255,255,.85)';
    ctx.fillRect(Math.round(icx-1), Math.round(dropY), 2, 2);
  }
}
//── Ícones de status da zona (desenhados com Canvas) ──
function drawZoneIcon(ix,iy,type,color){
  if(type===0){       // ═══ SAFE — losango sólido, o mesmo motivo dos pips da zona ═══
    ctx.save(); ctx.translate(ix,iy); ctx.rotate(Math.PI/4);
    ctx.shadowColor=color; ctx.shadowBlur=5;
    ctx.fillStyle=color; ctx.fillRect(-7,-7,14,14);
    ctx.restore();
    return;
  }
  // Tipos 1-4: ainda em curvas vetoriais — mantém a escala 0.8 original pra esses
  ctx.save();
  ctx.scale(0.8,0.8);
  ctx.strokeStyle=color; ctx.fillStyle=color;
  ctx.lineWidth=2; ctx.lineCap='round'; ctx.lineJoin='round';
  const S=11; // raio base do ícone

  if(type===1){ // ═══ WARNING — triângulo com "!" em paths ═══
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
  drawCard(x, y, 22, 22, gold ? UI_CARD.gold : UI_CARD.gray, 6);   // mini-card da folha
  drawBmpText(label, x+11, y+12, 13, {color:'#fff', align:'center'});
}
function drawKillFeed(){
  if(!killFeed.length || !IMG.interface) return;
  // Esquerda, colado acima do cartão de vida. A caveira é a MESMA do chip de
  // abates (topo esquerdo), só que menor pra caber na linha.
  const X=20, sz=14, gap=4, Y0=VH-120, icS=16;
  for(let i=0;i<killFeed.length;i++){
    const kf=killFeed[i];
    const a = kf.t<0.5 ? 1 : Math.max(0, 1-(kf.t-0.5)/(kf.dur-0.5));
    const sy = Y0 - i*(sz+gap);
    ctx.save(); ctx.globalAlpha=a;
    if(kf.isJoin){
      // "Fulano ↑" — seta verde no lugar da palavra "entrou" (reforço chegando)
      const kw = drawBmpText(kf.nome, X, sy, sz, {color:'rgba(255,255,255,.85)', valign:'bottom'});
      const asx = X + kw + 4, aiy = sy - sz/2 - icS/2 + 2;
      ctx.fillStyle = '#8fd132';
      ctx.beginPath();
      ctx.moveTo(asx+icS/2, aiy+2);
      ctx.lineTo(asx+icS-2, aiy+icS-4);
      ctx.lineTo(asx+icS*0.62, aiy+icS-4);
      ctx.lineTo(asx+icS*0.62, aiy+icS-2);
      ctx.lineTo(asx+icS*0.38, aiy+icS-2);
      ctx.lineTo(asx+icS*0.38, aiy+icS-4);
      ctx.lineTo(asx+2, aiy+icS-4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      continue;
    }
    const killerColor = kf.isPlayer ? '#f4c95d' : 'rgba(255,255,255,.75)';
    const kx = X;
    const kw = drawBmpText(kf.killer, kx, sy, sz, {color:killerColor, valign:'bottom'});
    const sx = kx + kw + 4;
    const iy = sy - sz/2 - icS/2 + 2;   // centraliza a caveira com o texto
    ctx.drawImage(IMG.interface, 1*16, 3*16, 16, 16, sx, iy, icS, icS);
    drawBmpText(kf.victim, sx + icS + 4, sy, sz, {color:'#d92c1f', valign:'bottom'});
    ctx.restore();
  }
}
function drawSlots(){
  const T=performance.now()/1000;
  const w=WEAPONS[gun];
  const M=20;                                   // margem da borda
  // ═══ Geometria dos slots primeiro — o cartão de calor alinha exato com eles ═══
  const s1W=116, s1H=88, s2W=94, s2H=74, gap=6;
  const s2X=VW-M-s2W, s2Y=VH-18-s2H;
  const s1X=s2X-gap-s1W, s1Y=VH-18-s1H;
  const s0W=64, s0H=s1H, s0X=s1X-gap-s0W, s0Y=s1Y;   // slot extra: faca automática
  // ═══ Cartão da arma: linha 1 = nome · modo · temperatura | linha 2 = termômetro cheio ═══
  const iH=58, iW=s1W+gap+s2W, iX=s1X, iY=s1Y-8-iH;
  drawCard(iX, iY, iW, iH, UI_CARD.gray, 10);
  const hc = heatColor(Math.round(gunHeat*24)/24);   // quantizado — cache de tinta da fonte por cor
  const temp = (20 + gunHeat*180)|0;                         // 20°C fria → 200°C estourando
  const blink = gunOverheat ? (Math.sin(T*10)>0 ? 1 : 0.35) : 1;
  // ── Linha 1: nome + chip de modo à esquerda, temperatura à direita ──
  const r1=iY+19;
  const nomeW = drawBmpText(w.nome, iX+14, r1, 15, {color:'#fff'});
  const chX=iX+14+nomeW+10, chW=40;
  ctx.fillStyle='#47324b'; roundRect(chX, r1-5, chW, 16, 4); ctx.fill();   // inset roxo da paleta
  drawBmpText(w.auto?'AUTO':'SEMI', chX+chW/2, r1+4, 10,
    {color: w.auto ? '#f2c14e' : 'rgba(255,255,255,.7)', align:'center'});
  // Temperatura à direita + chaminha que cresce com o calor
  ctx.save(); ctx.globalAlpha=blink;
  const tempW = drawBmpText(temp+'°C', iX+iW-14, r1+1, 18,
    {color:(gunHeat>0.5||gunOverheat) ? hc : '#fff', align:'right'});
  ctx.restore();
  if(gunHeat>0.05){
    const fl=Math.sin(T*22)*0.5+Math.sin(T*13.7)*0.5;
    ctx.save(); ctx.globalAlpha=0.35+gunHeat*0.65;
    tinyFlame(iX+iW-14-tempW-11, r1+1, 4+gunHeat*4.5, hc, fl);
    ctx.restore();
  }
  // ── Linha 2: termômetro de largura total (azul frio → vermelho brasa) ──
  const hbX=iX+14, hbW=iW-28, hbH=13, hbY=iY+iH-21;
  drawUIBar(hbX, hbY, hbW, hbH, 'orange', 0);           // só o trilho da folha
  if(gunHeat>0.02){
    ctx.save();
    ctx.beginPath(); ctx.rect(hbX+2, hbY+2, (hbW-4)*gunHeat, hbH-4); ctx.clip();
    const tg=ctx.createLinearGradient(hbX,0,hbX+hbW,0);   // gradiente fixo: a barra "revela" ele
    tg.addColorStop(0,'#4ac1ff'); tg.addColorStop(0.55,'#ffd24a'); tg.addColorStop(1,'#ff3b1e');
    ctx.globalAlpha=blink;
    ctx.fillStyle=tg; ctx.fillRect(hbX+2, hbY+2, hbW-4, hbH-4);
    ctx.restore(); ctx.globalAlpha=1;
  }
  // Marcas de 25/50/75%
  ctx.strokeStyle='rgba(71,50,75,.35)'; ctx.lineWidth=1;
  for(let i=1;i<4;i++){
    const tx=hbX+hbW*i/4;
    ctx.beginPath(); ctx.moveTo(tx, hbY+3); ctx.lineTo(tx, hbY+hbH-3); ctx.stroke();
  }
  // Superaqueceu: marcador branco piscando em 30% — onde a arma destrava
  if(gunOverheat){
    ctx.save(); ctx.globalAlpha=0.5+0.5*Math.sin(T*8);
    ctx.strokeStyle='#fff'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(hbX+hbW*0.30, hbY-2); ctx.lineTo(hbX+hbW*0.30, hbY+hbH+2); ctx.stroke();
    ctx.restore();
  }

  // ═══ Slots (arma ativa + medkit) ═══
  // ── Slot 1: arma (ativo, dourado) ──
  drawCard(s1X, s1Y, s1W, s1H, UI_CARD.gold, 10);   // card dourado = slot ativo
  // Borda: dourada fria → vermelha em brasa; pisca quando superaquece
  const hotBorder = gunHeat>0.35 ? heatColor(0.5+((gunHeat-0.35)/0.65)*0.5) : '#f2c14e';
  // Reto — o card da folha tem cantos vivos, um contorno arredondado destoaria
  ctx.save();
  ctx.shadowColor=hotBorder; ctx.shadowBlur=8+gunHeat*8;
  ctx.globalAlpha = gunOverheat ? (0.55+0.45*Math.sin(T*10)) : 1;
  ctx.strokeStyle=hotBorder; ctx.lineWidth=2; ctx.strokeRect(s1X,s1Y,s1W,s1H);
  ctx.restore();
  keycap(s1X+8, s1Y+8, '1', true);
  // Sprite da arma (com bounce na troca)
  ctx.save();
  ctx.imageSmoothingEnabled=false;
  let ws=1;
  if(swapAnim){ const bt=swapAnim.t/swapAnim.total; ws=0.5+0.5*bt+Math.sin(bt*Math.PI)*0.3*(1-bt); }
  ctx.translate(s1X+s1W/2, s1Y+s1H/2-4);
  ctx.scale(ws,ws);
  if(IMG.weapons) ctx.drawImage(IMG.weapons, w.spr*SPR,0, SPR,SPR, -30, -30, 60,60);
  ctx.restore();
  // Nome pequeno na base do slot
  drawBmpText(w.nome, s1X+s1W/2, s1Y+s1H-16, 11, {color:'rgba(255,255,255,.75)', align:'center'});

  // ── Slot 2: medkit ──
  const canHeal = medkits>0 && player.hp<100;
  drawCard(s2X, s2Y, s2W, s2H, UI_CARD.gray, 10);
  // Pulso verde quando dá pra curar
  ctx.strokeStyle = canHeal
    ? 'rgba(143,209,50,'+(0.45+0.35*Math.sin(T*4)).toFixed(3)+')'
    : 'rgba(255,255,255,.18)';
  ctx.lineWidth = canHeal ? 1.8 : 1.2;
  ctx.strokeRect(s2X,s2Y,s2W,s2H);   // reto — casa com os cantos vivos do card
  keycap(s2X+7, s2Y+7, '2', false);
  ctx.save();
  ctx.imageSmoothingEnabled=false;
  if(medkits<=0) ctx.globalAlpha=0.35;
  if(IMG.tiles) ctx.drawImage(IMG.tiles, 6*16, 12*16, 16, 16, s2X+s2W/2-20, s2Y+s2H/2-22, 40,40);
  ctx.restore();
  // Contador (badge no canto)
  ctx.fillStyle = medkits>0 ? '#47324b' : 'rgba(71,50,75,.45)';
  roundRect(s2X+s2W-28, s2Y+s2H-26, 22, 19, 6); ctx.fill();
  drawBmpText('X'+medkits, s2X+s2W-17, s2Y+s2H-16.5, 11,
    {color: medkits>0 ? '#fff' : 'rgba(255,255,255,.35)', align:'center'});

  // ── Slot extra: faca automática — passiva (sem tecla, golpeia sozinha por
  // proximidade), por isso o card fica cinza (não "ativo" como o slot 1) com uma
  // tag AUTO e uma barra de cooldown carregando embaixo.
  const mw = WEAPONS[meleeIdFor(player)];
  const facaPct = 1 - player.facaCooldown/mw.rate;   // 0 = acabou de golpear, 1 = pronta
  drawCard(s0X, s0Y, s0W, s0H, UI_CARD.gray, 10);
  ctx.strokeStyle = facaPct>=1 ? 'rgba(242,193,78,.55)' : 'rgba(255,255,255,.18)';
  ctx.lineWidth = facaPct>=1 ? 1.8 : 1.2;
  ctx.strokeRect(s0X, s0Y, s0W, s0H);
  ctx.save();
  ctx.imageSmoothingEnabled=false;
  if(facaPct<1) ctx.globalAlpha=0.5;
  {
    const isz = 40*(mw.scale||1);   // machados desenham um pouco maiores, também no HUD
    if(IMG.weapons) ctx.drawImage(IMG.weapons, mw.spr*SPR, (mw.row||0)*SPR, SPR, SPR, s0X+s0W/2-isz/2, s0Y+s0H/2-26*(mw.scale||1), isz, isz);
  }
  ctx.restore();
  const atW=34;
  ctx.fillStyle='#47324b'; roundRect(s0X+s0W/2-atW/2, s0Y+7, atW, 14, 4); ctx.fill();
  drawBmpText('AUTO', s0X+s0W/2, s0Y+14, 9, {color:'#f2c14e', align:'center'});
  drawUIBar(s0X+7, s0Y+s0H-15, s0W-14, 8, 'blue', facaPct);
}
function roundRect(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

//======================= MENU / LOJA DE PERSONAGENS (100% canvas) =======================
// Mesmo kit visual do HUD (fonte bitmap da folha interface + cards 9-slice) — nada de
// HTML/CSS aqui, pra ficar idêntico ao resto do jogo em vez de destoar com fonte de sistema.
let browseIdx = saveData.selected;   // qual card o carrossel mostra agora (não é sempre o equipado)
let menuAnimT = 0, menuFrame = 0;    // walk-cycle do mascote no preview do menu
let menuHit = {};                    // retângulos clicáveis do frame atual — ver canvas 'click' abaixo
let menuPulseT = 999;                // pulso do chip de moedas ao comprar

// Quebra um texto em linhas que cabem em maxW usando a MESMA fonte bitmap (uppercase —
// a folha não tem minúsculas, ver bmpNorm) — pro parágrafo de instruções do menu.
function wrapBmpLines(str, size, maxW){
  const words = bmpNorm(str).split(' ');
  const lines = []; let cur = '';
  for(const w of words){
    const test = cur ? cur+' '+w : w;
    if(cur && bmpTextW(test, size) > maxW){ lines.push(cur); cur = w; } else cur = test;
  }
  if(cur) lines.push(cur);
  return lines;
}
// ── Chrome dourado/violeta (estilo do mockup de referência): painel arredondado
// com gradiente + moldura dourada dupla. Nada disso vem de sprite — é tudo vetor,
// então escala liso em qualquer resolução (ao contrário dos cards em pixel da
// folha interface, que ficam granulados se esticados fora do tamanho nativo). ──
function drawMenuPanel(x, y, w, h, r, top, bot){
  // sombra projetada — só na base preenchida (a moldura por cima desenha sem
  // sombra, senão o contorno duplicava o efeito e ficava borrado).
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 6;
  const g = ctx.createLinearGradient(0, y, 0, y+h);
  g.addColorStop(0, top); g.addColorStop(1, bot);
  roundRect(x, y, w, h, r); ctx.fillStyle = g; ctx.fill();
  ctx.restore();
  // brilho "glacê" no topo — só dentro do painel (clip), dá o ar de superfície
  // polida em vez de cor chapada.
  ctx.save();
  roundRect(x, y, w, h, r); ctx.clip();
  const hi = ctx.createLinearGradient(0, y, 0, y+h*0.45);
  hi.addColorStop(0, 'rgba(255,255,255,.16)'); hi.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hi; ctx.fillRect(x, y, w, h*0.45);
  ctx.restore();
  // moldura dourada em relevo (clara em cima → escura embaixo, como metal sob luz)
  // + friso escuro fino por dentro pra separar nitidamente do fundo.
  const gb = ctx.createLinearGradient(0, y, 0, y+h);
  gb.addColorStop(0, '#fff3c2'); gb.addColorStop(0.45, '#e8b94a'); gb.addColorStop(1, '#8a5f1c');
  roundRect(x, y, w, h, r); ctx.strokeStyle = gb; ctx.lineWidth = Math.max(2.5, h*0.05); ctx.stroke();
  roundRect(x+1.5, y+1.5, w-3, h-3, Math.max(0,r-1.5)); ctx.strokeStyle = 'rgba(25,12,38,.85)'; ctx.lineWidth = 1; ctx.stroke();
}
// Botão "quente" genérico: fundo em gradiente + brilho glacê no topo + moldura em
// relevo — mesmo em qualquer paleta de cor (dourado pro JOGAR, verde pro REVIVER).
function drawColoredButton(x, y, w, h, r, fillTop, fillMid, fillBot, borderTop, borderBot){
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6;
  const g = ctx.createLinearGradient(0, y, 0, y+h);
  g.addColorStop(0, fillTop); g.addColorStop(0.5, fillMid); g.addColorStop(1, fillBot);
  roundRect(x, y, w, h, r); ctx.fillStyle = g; ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(x, y, w, h, r); ctx.clip();
  const hi = ctx.createLinearGradient(0, y, 0, y+h*0.5);
  hi.addColorStop(0, 'rgba(255,255,255,.4)'); hi.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hi; ctx.fillRect(x, y, w, h*0.5);
  ctx.restore();
  const gb = ctx.createLinearGradient(0, y, 0, y+h);
  gb.addColorStop(0, borderTop); gb.addColorStop(1, borderBot);
  roundRect(x, y, w, h, r); ctx.strokeStyle = gb; ctx.lineWidth = Math.max(2.5, h*0.08); ctx.stroke();
}
// Botão quente (JOGAR / comprar habilitado) — gradiente dourado-laranja, pra
// destacar como ação principal.
function drawGoldButton(x, y, w, h, r){
  drawColoredButton(x, y, w, h, r, '#ffe8a0', '#f0a838', '#c9711c', '#c99354', '#3c1f0a');
}
// Setas do carrossel: mesmo painel violeta/dourado, com um triângulo vetor por
// cima (mais limpo que esticar o sprite triangular da folha interface aqui).
// Cantos bem menos arredondados que os outros painéis — quadrado com "quina
// macia", não um blob circular.
function drawMenuArrow(x, y, size, dir){
  drawMenuPanel(x, y, size, size, size*0.1, '#4a3a72', '#241733');
  ctx.save();
  ctx.translate(x+size/2, y+size/2);
  if(dir<0) ctx.scale(-1,1);
  const s = size*0.22;
  ctx.beginPath(); ctx.moveTo(s*0.6,0); ctx.lineTo(-s*0.5,-s*0.85); ctx.lineTo(-s*0.5,s*0.85); ctx.closePath();
  ctx.fillStyle = '#f4ece0'; ctx.fill();
  ctx.restore();
}
// Logo "DESERT DUEL": fonte de sistema bem gorda (não a fonte bitmap do resto do
// HUD — pra um título pedir mais destaque que um label, ele precisa de uma cara
// diferente do texto normal) com contorno duplo, sombra funda e gradiente dourado
// + um brilho fino no topo das letras pra dar um verniz "logo de jogo".
function drawGameTitle(cx, y, size, maxW, text, palette){
  text = text || 'DESERT DUEL';
  palette = palette || ['#fff6c8', '#f9d35c', '#d9871c'];
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const fontStack = 'px "Arial Black", Impact, "Segoe UI", sans-serif';
  ctx.font = '900 '+size+fontStack;
  // ctx.font (fonte de sistema) não tem o bmpTextW que a fonte bitmap tem pra
  // caber no espaço — sem isso o título estoura a largura em tela estreita.
  if(maxW){
    const w = ctx.measureText(text).width;
    if(w > maxW){ size *= maxW/w; ctx.font = '900 '+size+fontStack; }
  }
  const baseY = y + size*0.32;

  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = size*0.16; ctx.shadowOffsetY = size*0.08;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#3a1c0a'; ctx.lineWidth = size*0.17;
  ctx.strokeText(text, cx, baseY);
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = '#7a3d14'; ctx.lineWidth = size*0.08;
  ctx.strokeText(text, cx, baseY);

  const g = ctx.createLinearGradient(0, y-size*0.62, 0, baseY+size*0.06);
  g.addColorStop(0, palette[0]); g.addColorStop(0.42, palette[1]); g.addColorStop(1, palette[2]);
  ctx.fillStyle = g;
  ctx.fillText(text, cx, baseY);

  ctx.save();
  ctx.beginPath(); ctx.rect(cx-size*3, y-size*0.62, size*6, size*0.34); ctx.clip();
  ctx.globalAlpha = 0.4; ctx.fillStyle = '#fff';
  ctx.fillText(text, cx, baseY);
  ctx.restore();
  ctx.restore();
}
// Fator de escala compartilhado pelo menu e pela tela de morte/vitória — o design
// foi feito com 1280x800 como referência. Abaixo de 1280 encolhe até um piso (senão
// estoura em celular); a partir de 1280 CRESCE de novo (senão fica sempre do tamanho
// de 1280 mesmo numa tela bem maior — texto e cards ficam minúsculos perdidos no
// meio da tela, que era exatamente o bug: o teto em 1 nunca deixava passar de lá).
function uiScale(){
  return VW < 1280
    ? Math.max(0.68, Math.min(1, VW/480))
    : Math.min(1.55, Math.min(VW/1280, VH/800));
}
function drawMenu(dt){
  ctx.setTransform(1,0,0,1,0,0);
  // ── Fundo: ilustração do deserto (assets/background.png), sempre "cover" —
  // enche a tela toda sem distorcer, cortando sobra nas bordas. Precisa de
  // suavização (a arte é pintada, não pixel-sprite) — desliga de novo depois,
  // senão o resto do HUD (fonte bitmap etc.) fica borrado.
  if(IMG.background){
    ctx.imageSmoothingEnabled = true;
    const bi = IMG.background, ir = bi.width/bi.height, vr = VW/VH;
    let dw, dh, dx, dy;
    if(vr > ir){ dw = VW; dh = dw/ir; dx = 0; dy = (VH-dh)/2; }
    else { dh = VH; dw = dh*ir; dy = 0; dx = (VW-dw)/2; }
    ctx.drawImage(bi, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = 'rgba(10,6,16,.22)'; ctx.fillRect(0, 0, VW, VH);   // leve vinheta pra texto não brigar com o céu
  } else {
    const bg = ctx.createRadialGradient(VW/2, VH*0.3, 30, VW/2, VH*0.3, Math.max(VW,VH)*0.8);
    bg.addColorStop(0, '#4a3527'); bg.addColorStop(1, '#17110d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, VW, VH);
  }

  const S = uiScale();
  const cx = VW/2;

  // ── Chip de moedas: linha própria bem no topo, canto direito — fica numa faixa
  // vertical SÓ dele, senão em tela estreita colide com o título grande. ──
  const chH=42*S, chW=Math.max(104*S, bmpTextW(''+saveData.bank, 20*S)+66*S), chX=VW-chW-18*S, chY=14*S;
  menuPulseT += dt;
  const pulseK = menuPulseT<0.3 ? 1+0.14*Math.sin((menuPulseT/0.3)*Math.PI) : 1;
  ctx.save(); ctx.translate(chX+chW/2, chY+chH/2); ctx.scale(pulseK, pulseK); ctx.translate(-chW/2, -chH/2);
  drawMenuPanel(0, 0, chW, chH, chH*0.14, '#4a3a72', '#241733');
  ctx.translate(23*S, chH/2); drawCoinShape(24*S); ctx.restore();
  drawBmpText(saveData.bank, chX+chW-15*S, chY+chH/2, 20*S, {color:'#f4e6c0', align:'right'});

  // ── Título ──
  const titleY = chY+chH+58*S;
  drawGameTitle(cx, titleY, 70*S, VW-36*S);

  // faíscas subindo perto do título — mesmo clima do pôr do sol do fundo, dá vida
  // à tela em vez de tudo estático.
  for(let i=0;i<10;i++){
    const seed = i*37.13;
    const t = (menuAnimT*0.11 + (seed%1)) % 1;
    const ex = cx + Math.sin(seed*3.1)*190*S;
    const ey = titleY - 6*S - t*100*S;
    const alpha = Math.sin(t*Math.PI) * 0.55;
    ctx.fillStyle = 'rgba(255,190,110,'+alpha.toFixed(3)+')';
    ctx.beginPath(); ctx.arc(ex, ey, (1+Math.sin(seed)*0.6)*S, 0, 6.283); ctx.fill();
  }

  const subSize = 15*S;
  const lines = wrapBmpLines('LAST MASCOT STANDING WINS - GRAB GUNS OFF THE GROUND - OUTRUN THE STORM', subSize, Math.min(620, VW-40));
  const subY0 = titleY+30*S;
  lines.forEach((ln,i)=> drawBmpText(ln, cx, subY0+i*20*S, subSize, {color:'#f0e6d8', align:'center'}));

  // ── Card do personagem ──
  const cardW=290*S, cardH=312*S, cardX=cx-cardW/2, cardY=subY0+lines.length*20*S+18*S, cardR=10*S;
  drawMenuPanel(cardX, cardY, cardW, cardH, cardR, '#5a4580', '#281b42');
  // vinheta interna — escurece os cantos, dá profundidade em vez de cor chapada
  ctx.save();
  roundRect(cardX, cardY, cardW, cardH, cardR); ctx.clip();
  const vig = ctx.createRadialGradient(cx, cardY+cardH*0.42, cardW*0.1, cx, cardY+cardH*0.5, cardW*0.72);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.4)');
  ctx.fillStyle = vig; ctx.fillRect(cardX, cardY, cardW, cardH);
  ctx.restore();

  const ch = CHARACTERS[browseIdx], img = IMG[ch.sheet];
  const pcx = cx, pfy = cardY+56*S, sc = 4.2*S;
  ctx.fillStyle='rgba(0,0,0,.32)';
  ctx.beginPath(); ctx.ellipse(pcx, pfy+74*S, 32*S, 9*S, 0, 0, 6.283); ctx.fill();
  if(img){
    ctx.drawImage(img, menuFrame*SPR, ch.row*SPR, SPR, SPR, pcx-SPR*sc/2, pfy+74*S-SPR*sc*0.94, SPR*sc, SPR*sc);
  }

  // ── Selo da arma branca desse personagem — canto superior direito do sprite ──
  if(IMG.weapons){
    const meleeId = MELEE_BY_SKIN[ch.sheet+','+ch.row] || 'faca';
    const mw = WEAPONS[meleeId];
    const spriteTop = pfy+74*S-SPR*sc*0.94, spriteHalfW = SPR*sc/2;
    const bx = pcx+spriteHalfW-8*S, by = spriteTop+10*S, br = 17*S;
    ctx.save();
    ctx.beginPath(); ctx.arc(bx, by, br, 0, 6.283);
    ctx.fillStyle = '#2a1b42'; ctx.fill();
    const gb = ctx.createLinearGradient(0, by-br, 0, by+br);
    gb.addColorStop(0, '#f9e6a8'); gb.addColorStop(1, '#8a5f1c');
    ctx.lineWidth = 2.4*S; ctx.strokeStyle = gb; ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.arc(bx, by, br-3*S, 0, 6.283); ctx.clip();
    const isc = (br*1.6*(mw.scale||1))/SPR;
    ctx.drawImage(IMG.weapons, mw.spr*SPR, (mw.row||0)*SPR, SPR, SPR, bx-SPR*isc/2, by-SPR*isc/2, SPR*isc, SPR*isc);
    ctx.restore();
  }

  // Nome dentro de uma pill própria — encolhe a fonte pra nomes longos (ex.: "Monstro
  // da Tempestade") nunca estourarem a largura do card.
  let nameSize = 16*S;
  const nameMaxW = cardW-56*S;
  const rawNameW = bmpTextW(ch.name, nameSize);
  if(rawNameW > nameMaxW) nameSize *= nameMaxW/rawNameW;
  const nameW = Math.min(cardW-30*S, bmpTextW(ch.name, nameSize)+40*S), nameH=32*S, nameX=cx-nameW/2, nameY=cardY+152*S;
  drawMenuPanel(nameX, nameY, nameW, nameH, nameH/2, '#3a2a5c', '#201430');
  drawBmpText(ch.name, cx, nameY+nameH/2, nameSize, {color:'#fff', align:'center'});

  const owned = saveData.owned.includes(browseIdx);
  const equipped = owned && saveData.selected === browseIdx;
  const statusY = nameY+nameH+14*S;
  menuHit.action = null;
  if(equipped){
    const pw=Math.max(130*S, bmpTextW('EQUIPPED',14*S)+76*S), ph=32*S, px=cx-pw/2;
    ctx.save(); ctx.shadowColor='rgba(0,0,0,.5)'; ctx.shadowBlur=10; ctx.shadowOffsetY=4;
    const g=ctx.createLinearGradient(0,statusY,0,statusY+ph); g.addColorStop(0,'#5bbf46'); g.addColorStop(1,'#2f7a24');
    roundRect(px,statusY,pw,ph,ph/2); ctx.fillStyle=g; ctx.fill();
    ctx.restore();
    ctx.save(); roundRect(px,statusY,pw,ph,ph/2); ctx.clip();
    const hig=ctx.createLinearGradient(0,statusY,0,statusY+ph*0.5);
    hig.addColorStop(0,'rgba(255,255,255,.3)'); hig.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=hig; ctx.fillRect(px,statusY,pw,ph*0.5);
    ctx.restore();
    roundRect(px,statusY,pw,ph,ph/2); ctx.strokeStyle='#1f5416'; ctx.lineWidth=2; ctx.stroke();
    ctx.strokeStyle='#fff'; ctx.lineWidth=2.4; ctx.lineCap='round'; ctx.lineJoin='round';
    const chkX=cx-bmpTextW('EQUIPPED',14*S)/2-16*S, chkY=statusY+ph/2;
    ctx.beginPath(); ctx.moveTo(chkX-5*S,chkY); ctx.lineTo(chkX-1*S,chkY+4*S); ctx.lineTo(chkX+6*S,chkY-5*S); ctx.stroke();
    drawBmpText('EQUIPPED', cx+8*S, statusY+ph/2, 14*S, {color:'#fff', align:'center'});
  } else if(owned){
    const pw=176*S, ph=36*S, px=cx-pw/2;
    drawMenuPanel(px, statusY, pw, ph, ph/2, '#4a3a72', '#251834');
    drawButtonLabel('SELECT', cx, statusY+ph/2+1, 15*S, '#fff');
    menuHit.action = {x:px, y:statusY, w:pw, h:ph, kind:'select'};
  } else {
    const afford = saveData.bank >= ch.price;
    const priceStr = ''+ch.price, priceSize=15*S, iconSize=16*S, gap=5*S;
    const groupW = iconSize+gap+bmpTextW(priceStr, priceSize), groupX0 = cx-groupW/2, rowY = statusY+iconSize/2;
    ctx.save(); ctx.translate(groupX0+iconSize/2, rowY); drawCoinShape(iconSize); ctx.restore();
    drawBmpText(priceStr, groupX0+iconSize+gap, rowY, priceSize, {color: afford?'#ffe9b0':'#a89bc0', align:'left'});
    const pw=176*S, ph=36*S, px=cx-pw/2, py=statusY+iconSize+8*S;
    if(afford) drawGoldButton(px, py, pw, ph, ph/2);
    else { roundRect(px,py,pw,ph,ph/2); ctx.fillStyle='#382a4a'; ctx.fill();
      roundRect(px,py,pw,ph,ph/2); ctx.strokeStyle='#5c4a78'; ctx.lineWidth=2; ctx.stroke(); }
    drawButtonLabel('BUY', cx, py+ph/2+1, 15*S, afford?'#fff8e8':'#8577a0');
    if(!afford) drawBmpText('NEED '+(ch.price-saveData.bank), cx, py+ph+15*S, 10*S, {color:'#e39a7a', align:'center'});
    menuHit.action = {x:px, y:py, w:pw, h:ph, kind:'buy'};
  }

  const arrSize=48*S, arrGap=18*S, arrY=cardY+cardH/2-arrSize/2;
  drawMenuArrow(cardX-arrSize-arrGap, arrY, arrSize, -1);
  drawMenuArrow(cardX+cardW+arrGap, arrY, arrSize, 1);
  menuHit.prev = {x:cardX-arrSize-arrGap, y:arrY, w:arrSize, h:arrSize};
  menuHit.next = {x:cardX+cardW+arrGap, y:arrY, w:arrSize, h:arrSize};

  // ── Dots de paginação — mostram quantos personagens tem e qual está aberto ──
  const dotY = cardY+cardH+20*S, dotGap=16*S, dotR=4.5*S;
  const dots0 = cx-(CHARACTERS.length-1)*dotGap/2;
  for(let i=0;i<CHARACTERS.length;i++){
    ctx.beginPath(); ctx.arc(dots0+i*dotGap, dotY, dotR, 0, 6.283);
    if(i===browseIdx){ ctx.fillStyle='#f4c95d'; ctx.fill(); }
    else { ctx.strokeStyle='rgba(255,255,255,.45)'; ctx.lineWidth=1.5; ctx.stroke(); }
  }

  // ── Jogar ──
  const pbW=240*S, pbH=62*S, pbX=cx-pbW/2, pbY=dotY+22*S;
  drawGoldButton(pbX, pbY, pbW, pbH, 9*S);
  const ornY = pbY+pbH/2;
  [[pbX+22*S,'#7a4718'],[pbX+pbW-22*S,'#7a4718']].forEach(([ox])=>{
    ctx.save(); ctx.translate(ox, ornY); ctx.rotate(Math.PI/4);
    ctx.fillStyle='rgba(255,255,255,.55)'; ctx.fillRect(-2*S,-7*S,4*S,14*S); ctx.fillRect(-7*S,-2*S,14*S,4*S);
    ctx.restore();
  });
  drawButtonLabel('PLAY', cx, pbY+pbH/2+1, 26*S, '#fff8e8');
  menuHit.play = {x:pbX, y:pbY, w:pbW, h:pbH};

  // ── Transição íris fase 1 (fechando por cima do menu) — quando termina, dispara
  // o start() de verdade, que já deixa preparada a fase 2 (abrindo, ver draw()). ──
  if(jogarWipe){
    jogarWipe.t += dt;
    const k = Math.min(1, jogarWipe.t/jogarWipe.dur);
    const e = Math.pow(k, 3);                 // ease-in: começa devagar, fecha rápido no fim
    const r = Math.max(0, jogarWipe.maxR * (1-e));
    drawIrisMask(jogarWipe.x, jogarWipe.y, r, 0.9*k);
    if(jogarWipe.t >= jogarWipe.dur){
      const {x, y} = jogarWipe;
      jogarWipe = null;
      start(x, y);
    }
  }

  // ── Transição de chegada (círculo ABRINDO por cima do menu, vindo da tela de
  // morte) — mesmo ease-out + anel dourado do introWipe do jogo. ──
  if(menuWipe){
    menuWipe.t += dt;
    const k = Math.min(1, menuWipe.t/menuWipe.dur);
    const e = 1-Math.pow(1-k, 3);
    const r = Math.max(0, menuWipe.maxR * e);
    drawIrisMask(menuWipe.x, menuWipe.y, r, k<1 ? 0.9*(1-k) : 0);
    if(menuWipe.t >= menuWipe.dur) menuWipe = null;
  }
}

// ── Tela de morte/vitória — mesmo kit visual do menu (painel violeta com borda
// dourada, título na fonte de sistema, botões com o mesmo relevo) pra não destoar
// da tela inicial. Desenhada por cima do jogo (que continua rodando atrás na morte,
// ou fica congelado num snapshot na vitória — ver showVictoryScreen). ──
let endHit = {};
// Label de botão: fonte de sistema em negrito + contorno sólido (nada de sombra
// suave por trás) — contraste garantido em qualquer cor de fundo, e não compete
// visualmente com a fonte bitmap "de dados" usada nos números/labels do HUD.
function drawButtonLabel(str, cx, cy, size, color){
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '800 '+size+'px "Arial Black", Impact, "Segoe UI", sans-serif';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(15,8,8,.9)'; ctx.lineWidth = size*0.22;
  ctx.strokeText(str, cx, cy);
  ctx.fillStyle = color;
  ctx.fillText(str, cx, cy);
  ctx.restore();
}
function drawEndScreen(dt){
  ctx.setTransform(1,0,0,1,0,0);
  if(state==='won' && wonSnapshot) ctx.drawImage(wonSnapshot, 0, 0);
  ctx.fillStyle = 'rgba(6,4,9,.7)';   // mais escuro que antes — texto sumia em cima de areia clara
  ctx.fillRect(0, 0, VW, VH);

  const S = uiScale();
  const cx = VW/2, won = state==='won';

  // Bloco inteiro (mascote + card + botões) centralizado na tela — antes ficava
  // colado no topo e sobrava um vão vazio enorme embaixo em telas grandes.
  const spriteH=150*S, cardW=360*S, cardH=118*S, gapB=30*S, btnH=60*S;
  const totalH = spriteH + cardH + gapB + btnH;
  const top = Math.max(20*S, (VH-totalH)/2);

  // ── Mascote em vez de um título de texto — o MESMO bicho que você tava jogando,
  // na pose de morto (ou de pé, na vitória), bem acima do card abaixo. A pose de
  // morto é "deitada" (só ocupa a metade de baixo do quadro 24x24, o resto é
  // transparente — ver assets/img/players_packed.png), então sem essa folga extra
  // ela ficava visualmente grudada no card mesmo com a matemática de ancoragem certa.
  const cardX=cx-cardW/2, cardY=top+spriteH;
  const sc=4.6*S, spriteGap=30*S;
  const pfy = cardY - spriteGap - SPR*sc*0.14;   // pé do sprite (onde a sombra fica) — SPR*sc*0.14
                                                  // é a fatia do desenho que sobra ABAIXO do pé;
                                                  // sem contar isso o card (desenhado por cima,
                                                  // depois) cortava a base do bicho.
  ctx.fillStyle='rgba(0,0,0,.35)';
  ctx.beginPath(); ctx.ellipse(cx, pfy, 34*S, 9*S, 0, 0, 6.283); ctx.fill();
  if(IMG[player.sheet]){
    const frame = won ? 0 : PLAYER_DEAD;
    ctx.drawImage(IMG[player.sheet], frame*SPR, player.skin*SPR, SPR, SPR, cx-SPR*sc/2, pfy-SPR*sc*0.86, SPR*sc, SPR*sc);
  }

  // ── Painel de estatísticas (mesmo visual do card de personagem do menu) ──
  drawMenuPanel(cardX, cardY, cardW, cardH, 12*S, '#5a4580', '#281b42');
  const mm=String(Math.floor(endElapsedT/60)).padStart(2,'0'), ss=String(Math.floor(endElapsedT%60)).padStart(2,'0');
  const colW = cardW/3, capY = cardY+24*S, statY = cardY+cardH*0.62;
  drawBmpText('KILLS', cardX+colW*0.5, capY, 12*S, {color:'rgba(255,255,255,.7)', align:'center'});
  if(IMG.interface) ctx.drawImage(IMG.interface, 1*16, 3*16, 16, 16, cardX+colW*0.5-34*S, statY-14*S, 28*S, 28*S);
  drawBmpText(kills, cardX+colW*0.5+8*S, statY, 24*S, {color:'#fff', align:'left'});
  drawBmpText('COINS', cardX+colW*1.5, capY, 12*S, {color:'rgba(255,255,255,.7)', align:'center'});
  ctx.save(); ctx.translate(cardX+colW*1.5-20*S, statY); drawCoinShape(22*S); ctx.restore();
  drawBmpText(coins, cardX+colW*1.5+5*S, statY, 24*S, {color:'#fff', align:'left'});
  drawBmpText('TIME', cardX+colW*2.5, capY, 12*S, {color:'rgba(255,255,255,.7)', align:'center'});
  drawPixelGlyph(GLYPH_HOURGLASS, cardX+colW*2.5-24*S, statY, 2.2*S, 'rgba(255,255,255,.9)');
  drawBmpText(mm+':'+ss, cardX+colW*2.5-4*S, statY, 19*S, {color:'#fff', align:'left'});

	  // ── Buttons: REVIVE (death only, 1x per match, up to zone limit,
	  //   and only within the DEATH_REVIVE_TIMEOUT window) + NEW GAME ──
	  if(!won){ deathTimer = Math.max(0, deathTimer - dt); }
	  const canRevive = !won && !reviveUsed && deathTimer > 0 && zoneNum < REVIVE_ZONE_LIMIT;
	  const secs = Math.ceil(deathTimer);
	  const btnY = cardY+cardH+gapB;
	  endHit.revive = null; endHit.newgame = null;
	  if(canRevive){
	    const gap=16*S, bw=(cardW-gap)/2, x0=cardX, x1=cardX+bw+gap;
	    drawColoredButton(x0, btnY, bw, btnH, 10*S, '#8bec6e','#4fa53a','#1f5416', '#a8d98f', '#173d10');
	    const label = secs <= 10 ? 'REVIVE ('+secs+')' : 'REVIVE';
	    drawButtonLabel(label, x0+bw/2, btnY+btnH/2+1, secs <= 10 ? 19*S : 21*S, '#fff');
	    endHit.revive = {x:x0, y:btnY, w:bw, h:btnH};
	    drawGoldButton(x1, btnY, bw, btnH, 10*S);
	    drawButtonLabel('NEW GAME', x1+bw/2, btnY+btnH/2+1, 15*S, '#fff8e8');
	    endHit.newgame = {x:x1, y:btnY, w:bw, h:btnH};
	  } else {
	    const bw=cardW, x0=cardX;
	    drawGoldButton(x0, btnY, bw, btnH, 10*S);
	    drawButtonLabel('NEW GAME', cx, btnY+btnH/2+1, 20*S, '#fff8e8');
	    endHit.newgame = {x:x0, y:btnY, w:bw, h:btnH};
	  }
	  // ── Exit transition (closes circle over death screen, same as PLAY
	  // but from death back to menu) ──
  if(deathWipe){
    deathWipe.t += dt;
    const k = Math.min(1, deathWipe.t/deathWipe.dur);
    const e = Math.pow(k, 3);
    const r = Math.max(0, deathWipe.maxR * (1-e));
    drawIrisMask(deathWipe.x, deathWipe.y, r, 0.9*k);
    if(deathWipe.t >= deathWipe.dur){
      const {x, y} = deathWipe;
      deathWipe = null;
      goToMenu();                           // troca de estado aqui — drawMenu() roda a partir do próximo frame
      const mR = Math.hypot(Math.max(x, VW-x), Math.max(y, VH-y));
      menuWipe = { x, y, t:0, dur:0.6, maxR: mR };
    }
  }
}
canvas.addEventListener('click', e=>{
  if(jogarWipe || deathWipe || menuWipe) return;
  const r=canvas.getBoundingClientRect();
  const x=(e.clientX-r.left)*(canvas.width/r.width), y=(e.clientY-r.top)*(canvas.height/r.height);
  const hit = rc => rc && x>=rc.x && x<=rc.x+rc.w && y>=rc.y && y<=rc.y+rc.h;
  if(state==='dead' || state==='won'){
    if(hit(endHit.revive)){ uiClickSound('confirm'); revivePlayer(); return; }
    if(hit(endHit.newgame)){
      uiClickSound('confirm');
      const maxR = Math.hypot(Math.max(x, VW-x), Math.max(y, VH-y));
      deathWipe = { x, y, t:0, dur:0.32, maxR };
      return;
    }
    return;
  }
  if(state!=='menu') return;
  if(hit(menuHit.prev)){ uiClickSound('tap'); browseIdx=(browseIdx-1+CHARACTERS.length)%CHARACTERS.length; return; }
  if(hit(menuHit.next)){ uiClickSound('tap'); browseIdx=(browseIdx+1)%CHARACTERS.length; return; }
  if(hit(menuHit.play)){
    uiClickSound('confirm');
    const maxR = Math.hypot(Math.max(x,VW-x), Math.max(y,VH-y));
    jogarWipe = { x, y, t:0, dur:0.32, maxR };
    return;
  }
  if(hit(menuHit.action)){
    const ch = CHARACTERS[browseIdx];
    if(menuHit.action.kind==='select'){ uiClickSound('tap'); saveData.selected = browseIdx; persistSaveData(); }
    else if(menuHit.action.kind==='buy' && saveData.bank >= ch.price){
      uiClickSound('confirm');
      saveData.bank -= ch.price; saveData.owned.push(browseIdx); saveData.selected = browseIdx;
      persistSaveData(); menuPulseT = 0;
    } else if(menuHit.action.kind==='buy'){
      uiClickSound('back');   // sem moeda suficiente — som "negado", mais seco
    }
  }
});
// Volta pro menu/loja — bancariza as moedas da partida que terminou (morte ou vitória)
// pra dar pra gastar num personagem novo antes da próxima; o state já vira 'menu' na
// hora do clique, então não tem brecha de clique duplo bancarizando 2x.
function goToMenu(){
  if(state==='dead' || state==='won'){ saveData.bank += coins; persistSaveData(); menuPulseT = 0; }
  state = 'menu';
  browseIdx = saveData.selected;
  wonSnapshot = null;
  canvas.style.cursor = 'pointer';
}

//======================= LOOP / FLUXO =======================
let state='menu', last=0;
function frame(t){
  const dt=Math.max(0,Math.min(0.05,(t-last)/1000))||0; last=t;
  // 'dead': o player já morreu, mas a partida continua rolando atrás do painel
  // (bots, zona, balas) — só o player para de responder a input. 'won': não tem mais
  // ninguém pra lutar, então a imagem congela de vez (nem step nem draw rodam mais,
  // ver wonSnapshot em showVictoryScreen).
  if(state==='playing' || state==='dead'){ step(dt); draw(); }
  if(state==='dead' || state==='won'){ drawEndScreen(dt); }
  else if(state==='menu'){
    menuAnimT += dt;
    menuFrame = 1 + (Math.floor(menuAnimT*8)%2);   // mesmo ritmo de passada do jogo (ver player.frame)
    drawMenu(dt);
  }
  requestAnimationFrame(frame);
}
function start(originX, originY){
  if(!MAP){ alert('map.json failed to load — save the map in the editor first.'); return; }
  loadLevel();
  elapsedT=0; kills=0; coins=0; coinPops=[]; matchWon=false; victoryTimer=-1; medkits=2; player.hp=100; player.armor=100;
  hpGhost=100; armorGhost=100;
  shieldRechargeTimer=0; prevHp=100;
  gunHeat=0; gunOverheat=false; overheatFlash=0;
  fireLatch=false; recoilForce=0; swapAnim=null;
  overlapGun=-1;                // sem isso o jogador podia "pisar" numa arma no frame 1 e pegá-la automaticamente
  healAura=0; player.facaCooldown=0; player.facaSwingT=0;
  gun='pistola';                // toda partida NOVA começa do zero — sem arrastar a arma da partida anterior
  reviveUsed=false; deathTimer=0; wonSnapshot=null;
  const equipped = CHARACTERS[saveData.selected] || CHARACTERS[0];
  player.sheet = equipped.sheet; player.skin = equipped.row;
  spawnEnemies();   // também posiciona o player — sorteia entre o mesmo pool de spawns dos bots
  cam.x=clamp(player.x-(VW/VIEW_SCALE)/2,0,Math.max(0,WORLD_W-VW/VIEW_SCALE));
  cam.y=clamp(player.y-(VH/VIEW_SCALE)/2,0,Math.max(0,WORLD_H-VH/VIEW_SCALE));
  canvas.style.cursor='none';  // custom crosshair
  initZones();
  state='playing'; last=performance.now();
  const ox = originX ?? VW/2, oy = originY ?? VH/2;
  const maxR = Math.hypot(Math.max(ox, VW-ox), Math.max(oy, VH-oy));
  introWipe = { x:ox, y:oy, t:0, dur:0.6, maxR };
  withSDK(sdk => sdk.game.gameplayStart());
}

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
window.__enemies=()=>enemies.map(e=>({c:Math.floor(e.x/MTILE), r:Math.floor(e.y/MTILE), L:e.L,
  hp:e.hp, armor:e.armor, st:e.st, fsm:e.fsm, gun:e.gun, gunHeat:e.gunHeat, gunOverheat:e.gunOverheat}));
window.__aim=(wx,wy)=>{ mouse.sx=(wx-cam.x)*VIEW_SCALE; mouse.sy=(wy-cam.y)*VIEW_SCALE; };
window.__menuHit=()=>menuHit;
window.__wipe=()=>({ state, jogarWipe: jogarWipe && {...jogarWipe}, introWipe: introWipe && {...introWipe}, deathWipe: deathWipe && {...deathWipe}, menuWipe: menuWipe && {...menuWipe}, now: performance.now() });
window.__endHit=()=>endHit;
window.__endState=()=>({ state, reviveUsed, zoneNum, kills, coins });
window.__menu=()=>({browseIdx, saveData:JSON.parse(JSON.stringify(saveData))});

//======================= BOOT =======================
withSDK(sdk => sdk.game.loadingStart());
Promise.all([
  loadImg('tiles','assets/img/tiles_packed.png'),
  loadImg('interface','assets/img/interface_packed.png'),
  loadImg('players','assets/img/players_packed.png'),
  loadImg('enemies','assets/img/enemies_packed.png'),
  loadImg('weapons','assets/img/weapons_packed.png'),
  loadImg('background','assets/background.png'),
  fetch('map.json?t='+Date.now()).then(r=>r.ok?r.json():null).then(d=>{MAP=d;}).catch(()=>{MAP=null;}),
  syncFromCloud(),   // espera o save da nuvem chegar antes do 1o frame — sem isso o menu
                     // podia piscar com o saldo antigo do localStorage por 1 frame.
]).then(()=>{
  withSDK(sdk => sdk.game.loadingStop());
  requestAnimationFrame(frame);
});
