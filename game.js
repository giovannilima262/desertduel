'use strict';
/* Desert Duel — player movement demo: uses map.json with editor collision system. */

const TILE = 24, MTILE = 16;
let COLS = 60, ROWS = 46, WORLD_W, WORLD_H;
const VIEW_SCALE = 3;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
let VW = 0, VH = 0;
function resize(){ VW = canvas.width = innerWidth; VH = canvas.height = innerHeight; ctx.imageSmoothingEnabled = false; }
addEventListener('resize', resize); resize();

const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');
const IMG = {};
function loadImg(k, s){ return new Promise(r => { const i = new Image(); i.onload = () => { IMG[k] = i; r(); }; i.onerror = () => r(); i.src = s; }); }
function drawSprite(img, c, r, x, y, rot, sc, flip){
  ctx.save(); ctx.translate(x, y); if(rot) ctx.rotate(rot); ctx.scale(flip ? -sc : sc, sc);
  ctx.drawImage(img, c * TILE, r * TILE, TILE, TILE, -TILE / 2, -TILE / 2, TILE, TILE); ctx.restore();
}
const MS = { 0: ['tiles', 16], tiles: ['tiles', 16], interface: ['interface', 16], players: ['players', 24], enemies: ['enemies', 24], weapons: ['weapons', 24] };
function blitMap(t, x, y){ const s = MS[t[0]] || MS[0], img = IMG[s[0]]; if(!img) return; const ts = s[1]; ctx.drawImage(img, t[1] * ts, t[2] * ts, ts, ts, x, y, MTILE, MTILE); }

let state = 'menu', MAP = null, mapLayers = null, matoCells = [], player = null, cam = { x: 0, y: 0 }, elapsed = 0;
const keys = {};
addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

// --- collision (EXACT copy of editor) ---
let gameColl = [], gameOver = [];
function collInfo(v){
  if(!v) return null;
  if(v === 1) return { kind: 'block' };
  if(v === 2) return { kind: 'spawn', levels: [0] };
  if(v >= 10 && v < 20){ const L = v - 10; return { kind: 'piso', level: L, levels: [L] }; }
  if(v >= 20 && v < 30){ const s = v - 20; return { kind: 'escada', levels: [s, s + 1] }; }
  if(v >= 100 && v < 200){ const lo = ((v - 100) / 10) | 0, hi = (v - 100) % 10; return { kind: 'escada', levels: lo === hi ? [lo] : [lo, hi] }; }
  return null;
}
function collAt(c, r){ if(c < 0 || r < 0 || c >= COLS || r >= ROWS) return 1; return gameColl[r * COLS + c]; }
function overAt(c, r){ if(c < 0 || r < 0 || c >= COLS || r >= ROWS) return 0; return gameOver[r * COLS + c]; }
function bridgeActive(ov, L){ return ov > 0 && (ov - 1) === L; }
function canStep(fv, L, tv, to){
  const B = collInfo(tv); if(B && B.kind === 'block') return null;
  const A = collInfo(fv), br = bridgeActive(to, L);
  if(B && B.kind === 'escada'){ if(B.levels.includes(L)) return L; return br ? L : null; }
  if(B && (B.kind === 'piso' || B.kind === 'spawn')){
    const M = B.kind === 'spawn' ? 0 : B.level;
    if(M === L) return L;
    if(A && A.kind === 'escada' && A.levels.includes(L) && A.levels.includes(M)) return M;
    return br ? L : null;
  }
  return br ? L : null;
}

// --- level loading ---
function loadLevel(){
  const d = MAP;
  COLS = d.cols; ROWS = d.rows; WORLD_W = COLS * MTILE; WORLD_H = ROWS * MTILE;
  mapLayers = d.layers.filter(L => L.type !== 'image' && Array.isArray(L.tiles)).map(L => ({ name: L.name, tiles: L.tiles }));
  gameColl = (d.coll || []).slice(); while(gameColl.length < COLS * ROWS) gameColl.push(0);
  gameOver = (d.over || []).slice(); while(gameOver.length < COLS * ROWS) gameOver.push(0);
  if(!d.coll || d.coll.every(v => !v)) gameColl.fill(10);
  const isB = n => /andar/i.test(n);
  for(const L of mapLayers){ if(isB(L.name)) for(let i = 0; i < L.tiles.length; i++){ if(L.tiles[i] && !gameColl[i]) gameColl[i] = 1; } }
  matoCells = []; const mo = d.mato || [];
  for(let i = 0; i < mo.length; i++){ if(mo[i]) matoCells.push({ c: i % COLS, r: (i / COLS) | 0 }); }
  let si = null;
  for(let i = 0; i < gameColl.length; i++){ if(gameColl[i] === 2){ si = i; break; } }
  if(si === null) for(let i = 0; i < gameColl.length; i++){ const ci = collInfo(gameColl[i]); if(ci && ci.kind === 'piso'){ si = i; break; } }
  if(si === null) si = 0;
  const sc = si % COLS, sr = (si / COLS) | 0, sv = collInfo(gameColl[si]);
  player = { x: sc * MTILE + MTILE / 2, y: sr * MTILE + MTILE / 2, L: sv && sv.level != null ? sv.level : 0, moving: false, animT: 0, frame: 0, skin: 0, aim: 0 };
  cam.x = clamp(player.x - (VW / VIEW_SCALE) / 2, 0, WORLD_W - VW / VIEW_SCALE);
  cam.y = clamp(player.y - (VH / VIEW_SCALE) / 2, 0, WORLD_H - VH / VIEW_SCALE);
}

// --- movement (1:1 copy of editor heroStep + heroAxis) ---
function heroStep(p, dt){
  let dx = 0, dy = 0;
  if(keys['w'] || keys['arrowup']) dy--; if(keys['s'] || keys['arrowdown']) dy++;
  if(keys['a'] || keys['arrowleft']) dx--; if(keys['d'] || keys['arrowright']) dx++;
  p.moving = !!(dx || dy);
  if(dx || dy){ const l = Math.hypot(dx, dy), spd = 6.5 * MTILE * dt; heroAxis(p, p.x + dx / l * spd, p.y, true); heroAxis(p, p.x, p.y + dy / l * spd, false); }
}
function heroAxis(p, nx, ny, horiz){
  const R = MTILE * 0.34, cc = { c: Math.floor(p.x / MTILE), r: Math.floor(p.y / MTILE) };
  const fv = collAt(cc.c, cc.r);
  const ld = horiz ? { c: Math.floor((nx + Math.sign(nx - p.x) * R) / MTILE), r: Math.floor(p.y / MTILE) }
                   : { c: Math.floor(p.x / MTILE), r: Math.floor((ny + Math.sign(ny - p.y) * R) / MTILE) };
  const res = canStep(fv, p.L, collAt(ld.c, ld.r), overAt(ld.c, ld.r));
  if(res === null) return;
  if(horiz) p.x = nx; else p.y = ny;
  const nc = Math.floor(p.x / MTILE), nr = Math.floor(p.y / MTILE);
  const nv = collInfo(collAt(nc, nr));
  if(!bridgeActive(overAt(nc, nr), p.L) && nv && nv.kind !== 'escada') p.L = nv.kind === 'spawn' ? 0 : nv.level;
}

// --- update ---
function update(dt){
  heroStep(player, dt);
  player.x = clamp(player.x, MTILE * 0.34, WORLD_W - MTILE * 0.34);
  player.y = clamp(player.y, MTILE * 0.34, WORLD_H - MTILE * 0.34);
}
function updateCam(){
  const tx = clamp(player.x - (VW / VIEW_SCALE) / 2, 0, WORLD_W - VW / VIEW_SCALE);
  const ty = clamp(player.y - (VH / VIEW_SCALE) / 2, 0, WORLD_H - VH / VIEW_SCALE);
  cam.x += (tx - cam.x) * 0.15; cam.y += (ty - cam.y) * 0.15;
}

// --- render ---
function draw(){
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#c99a63'; ctx.fillRect(0, 0, VW, VH);
  ctx.setTransform(VIEW_SCALE, 0, 0, VIEW_SCALE, -cam.x * VIEW_SCALE, -cam.y * VIEW_SCALE);
  const c0 = Math.max(0, (cam.x / MTILE | 0) - 1), r0 = Math.max(0, (cam.y / MTILE | 0) - 1);
  const c1 = Math.min(COLS, c0 + (VW / VIEW_SCALE / MTILE | 0) + 3), r1 = Math.min(ROWS, r0 + (VH / VIEW_SCALE / MTILE | 0) + 3);

  const matoTop = {};
  for(const m of matoCells){ const i = m.r * COLS + m.c; if(mapLayers) for(let li = mapLayers.length - 1; li >= 0; li--){ if(mapLayers[li].tiles[i]){ matoTop[i] = li; break; } } }

  if(mapLayers){
    const tc = {};
    for(let li = 0; li < mapLayers.length; li++){ const L = mapLayers[li], t = L.tiles;
      for(let r = r0; r < r1; r++){ const base = r * COLS; for(let c = c0; c < c1; c++){
        const i = base + c, tt = t[i]; if(!tt) continue;
        if(matoTop[i] === li){
          const ss = MS[tt[0]] || MS[0], si = IMG[ss[0]]; if(!si) continue; const ts = ss[1];
          const key = tt[0] + '_' + tt[1] + '_' + tt[2]; let tcv = tc[key];
          if(!tcv){ tcv = document.createElement('canvas'); tcv.width = ts; tcv.height = ts;
            const tctx = tcv.getContext('2d'); tctx.imageSmoothingEnabled = false;
            tctx.drawImage(si, tt[1] * ts, tt[2] * ts, ts, ts, 0, 0, ts, ts); tc[key] = tcv; }
          const ph = c * 0.6 + r * 0.9, rot = Math.sin(elapsed * 2.0 + ph) * 0.06;
          ctx.save(); ctx.translate(c * MTILE + MTILE / 2, r * MTILE + MTILE); ctx.rotate(rot);
          ctx.drawImage(tcv, 0, 0, ts, ts, -MTILE / 2, -MTILE, MTILE, MTILE); ctx.restore();
        } else { blitMap(tt, c * MTILE, r * MTILE); }
      }}
    }
  }
  ctx.strokeStyle = '#8a6a44'; ctx.lineWidth = 6; ctx.strokeRect(0, 0, WORLD_W, WORLD_H);

  if(player){
    ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.beginPath(); ctx.ellipse(player.x, player.y + 10, 10, 4, 0, 0, 6.28); ctx.fill();
    player.animT += 0.016; player.frame = player.moving ? 1 + (Math.floor(player.animT * 8) % 3) : 0;
    drawSprite(IMG.players, player.frame, player.skin, player.x, player.y, 0, 1.0, false);
    const fc = Math.floor(player.x / MTILE), fr = Math.floor(player.y / MTILE), drawn = new Set();
    for(let dc = -1; dc <= 1; dc++) for(let dr = -1; dr <= 1; dr++){
      const cc = fc + dc, cr = fr + dr;
      if(!bridgeActive(overAt(cc, cr), player.L)) continue;
      const key = cr * COLS + cc; if(drawn.has(key)) continue; drawn.add(key);
      if(mapLayers) for(let li = mapLayers.length - 1; li >= 0; li--){ const tt = mapLayers[li].tiles[key]; if(!tt) continue; blitMap(tt, cc * MTILE, cr * MTILE); break; }
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgba(30,22,18,.72)'; ctx.beginPath(); ctx.moveTo(12, 14); ctx.arcTo(180, 14, 180, 30, 8); ctx.arcTo(180, 30, 12, 30, 8); ctx.arcTo(12, 30, 12, 14, 8); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f4c95d'; ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'left';
  ctx.fillText('Nivel ' + (player ? player.L : 0) + ' - WASD move', 20, 26);
}

let last = 0;
function frame(t){
  const dt = Math.min(0.05, (t - last) / 1000) || 0; last = t;
  if(state === 'playing'){ elapsed += dt; update(dt); updateCam(); draw(); }
  requestAnimationFrame(frame);
}
function start(){ overlay.classList.add('hidden'); loadLevel(); state = 'playing'; last = performance.now(); }
startBtn.addEventListener('click', start);

Promise.all([
  loadImg('players', 'assets/img/players_packed.png'),
  loadImg('tiles', 'assets/img/tiles_packed.png'),
  loadImg('interface', 'assets/img/interface_packed.png'),
  loadImg('enemies', 'assets/img/enemies_packed.png'),
  loadImg('weapons', 'assets/img/weapons_packed.png'),
  fetch('map.json?t=' + Date.now()).then(r => r.ok ? r.json() : null).then(d => { MAP = d; }).catch(() => { MAP = null; }),
]).then(() => { if(!MAP) console.warn('map.json nao carregou'); requestAnimationFrame(frame); });
