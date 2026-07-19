'use strict';
/* Desert Duel — top-down .io arena shooter with autotiled elevation + climbable stairs.
   Assets: Kenney Desert Shooter Pack (CC0). Sprites sliced from packed 24px sheets. */

//======================= CONFIG =======================
const TILE = 24;                        // player/weapon sprite source size (those sheets are 24px)
const MTILE = 16;                       // map cell size in world units (terrain sheet is 16px)
let COLS = 60, ROWS = 46;               // set from the loaded map
let WORLD_W = COLS*MTILE, WORLD_H = ROWS*MTILE;
const VIEW_SCALE = 3;
const N_FIGHTERS = 8;
const PLAYER_R = 11;
const ELEV = 8;                          // pixels a fighter/tile rises when on a plateau
const NAMES = ['You','Bandit','Coyote','Rex','Vex','Sandy','Dune','Cobra','Fang','Jinx'];

// Tile atlas coords [col,row] into tiles.png (12x8 @24px). Verified against the sheet.
const T = {
  sand:[[7,6]], sandDot:[9,6],
  pTop:[7,4],                            // clean grey-stone plateau top (the sample's walkable surface)
  pS:[8,4],                              // grey south cliff dropping to sand
  stair:[4,7],                           // climbable steps
  cactus:[6,2], tree:[5,2], skull:[8,2], rock:[7,2], barrel:[3,7],
  lamp:[9,2], plant:[2,1],
  fenceG:[[10,6],[11,6]], fenceO:[[10,3],[11,3]],
};

const WEAPONS = {
  pistol:  { name:'Pistol',  spr:0,  dmg:14, rate:0.34, speed:620, spread:0.03, pellets:1, ammo:Infinity, auto:false, range:520 },
  smg:     { name:'SMG',     spr:2,  dmg:9,  rate:0.10, speed:680, spread:0.10, pellets:1, ammo:60,  auto:true,  range:460 },
  shotgun: { name:'Shotgun', spr:5,  dmg:8,  rate:0.72, speed:560, spread:0.26, pellets:6, ammo:18,  auto:false, range:300 },
  rifle:   { name:'Rifle',   spr:3,  dmg:20, rate:0.24, speed:760, spread:0.04, pellets:1, ammo:40,  auto:true,  range:620 },
  sniper:  { name:'Sniper',  spr:7,  dmg:52, rate:1.05, speed:1100,spread:0.0,  pellets:1, ammo:10,  auto:false, range:900 },
};
const DROP_TYPES = ['smg','shotgun','rifle','sniper','smg','shotgun','rifle'];

//======================= CANVAS / STATE =======================
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
let VW=0, VH=0;
function resize(){ VW=canvas.width=innerWidth; VH=canvas.height=innerHeight; ctx.imageSmoothingEnabled=false; }
addEventListener('resize', resize); resize();

const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');
const oh1 = overlay.querySelector('h1');
const op  = overlay.querySelector('p');

//======================= ASSETS =======================
const IMG = {};
function loadImg(key,src){ return new Promise(res=>{ const i=new Image(); i.onload=()=>{IMG[key]=i;res();}; i.src=src; }); }
const SFX = {};
function loadSfx(key,src){ const a=new Audio(src); a.preload='auto'; SFX[key]=a; }
function play(key,vol=0.5){ const a=SFX[key]; if(!a) return; const c=a.cloneNode(); c.volume=vol; c.play().catch(()=>{}); }

// draw a 24px sprite (center origin, rotatable) — used for fighters/guns/pickups
function drawSprite(img,col,row,x,y,rot=0,scale=1,flip=false){
  ctx.save(); ctx.translate(x,y); if(rot) ctx.rotate(rot);
  ctx.scale(flip?-scale:scale, scale);
  ctx.drawImage(img, col*TILE,row*TILE,TILE,TILE, -TILE/2,-TILE/2,TILE,TILE);
  ctx.restore();
}
// draw one authored map tile [sheetId,col,row] — each sheet has its own source tile size
const MAP_SHEETS = { 0:['tiles',16], tiles:['tiles',16], interface:['interface',16],
  players:['players',24], enemies:['enemies',24], weapons:['weapons',24] };
function blitMap(t,x,y){
  const s=MAP_SHEETS[t[0]]||MAP_SHEETS[0], img=IMG[s[0]]; if(!img) return;
  const ts=s[1]; ctx.drawImage(img, t[1]*ts, t[2]*ts, ts, ts, x, y, MTILE, MTILE);
}

let state='menu';
let fighters=[], bullets=[], pickups=[], parts=[];
let cam={x:0,y:0};
let zone={r:0,tr:0,cx:0,cy:0,dmgT:0};
let elapsed=0, shrinkStage=0;
let player=null;
let grid=[];            // grid[r][c] = {solid, spawn}
let MAP=null;           // the authored map.json document
let mapLayers=null;     // [{name, tiles}] to render, in bottom→top order
let spawnCells=[];      // cells painted as spawn (if any)
let matoCells=[];       // cells with bush/grass (coll value 5) — rendered on top with wind sway

const keys={};
addEventListener('keydown',e=>{ keys[e.key.toLowerCase()]=true; });
addEventListener('keyup',  e=>{ keys[e.key.toLowerCase()]=false; });
const mouse={x:0,y:0,down:false};
canvas.addEventListener('mousemove',e=>{ mouse.x=e.clientX; mouse.y=e.clientY; });
canvas.addEventListener('mousedown',()=>{ mouse.down=true; });
addEventListener('mouseup',()=>{ mouse.down=false; });
canvas.addEventListener('touchstart',e=>{ mouse.down=true; const t=e.touches[0]; mouse.x=t.clientX; mouse.y=t.clientY; e.preventDefault(); },{passive:false});
canvas.addEventListener('touchmove', e=>{ const t=e.touches[0]; mouse.x=t.clientX; mouse.y=t.clientY; e.preventDefault(); },{passive:false});
canvas.addEventListener('touchend',  e=>{ mouse.down=false; e.preventDefault(); },{passive:false});

const rand=(a,b)=>a+Math.random()*(b-a);
const dist2=(ax,ay,bx,by)=>{const dx=ax-bx,dy=ay-by;return dx*dx+dy*dy;};
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const pick=a=>a[(Math.random()*a.length)|0];

//======================= GRID HELPERS =======================
function cellAt(x,y){ const c=clamp(x/MTILE|0,0,COLS-1), r=clamp(y/MTILE|0,0,ROWS-1); return grid[r][c]; }
function heightAt(){ return 0; }
function passable(ax,ay,bx,by){ return !cellAt(bx,by).solid; }   // buildings block; ground/doors/bridges are open

//======================= LEVEL (from the authored map.json) =======================
function buildLevel(){
  if(MAP && MAP.layers){ loadLevelFromMap(); return; }
  // fallback: a plain walkable sand arena so combat still works if map.json is missing
  COLS=60; ROWS=46; WORLD_W=COLS*MTILE; WORLD_H=ROWS*MTILE;
  grid=[]; for(let r=0;r<ROWS;r++){ const row=[]; for(let c=0;c<COLS;c++) row.push({solid:false,spawn:false}); grid.push(row); }
  const sand=new Array(COLS*ROWS).fill([0,10,3]);
  mapLayers=[{name:'Chão',tiles:sand}]; spawnCells=[]; matoCells=[];
}
function loadLevelFromMap(){
  const d=MAP;
  COLS=d.cols; ROWS=d.rows; WORLD_W=COLS*MTILE; WORLD_H=ROWS*MTILE;
  mapLayers = d.layers.filter(L=>L.type!=='image' && Array.isArray(L.tiles)).map(L=>({name:L.name,tiles:L.tiles}));
  grid=[]; for(let r=0;r<ROWS;r++){ const row=[]; for(let c=0;c<COLS;c++) row.push({solid:false,spawn:false}); grid.push(row); }
  // Buildings (the "andar" floor layers) are solid cover; doors and bridges stay open.
  const isBuild=n=>/andar/i.test(n), isOpen=n=>/porta|ponte/i.test(n);
  for(const L of mapLayers){
    if(isBuild(L.name)){ for(let i=0;i<L.tiles.length;i++){ if(L.tiles[i]) grid[(i/COLS)|0][i%COLS].solid=true; } }
  }
  for(const L of mapLayers){
    if(isOpen(L.name)){ for(let i=0;i<L.tiles.length;i++){ if(L.tiles[i]) grid[(i/COLS)|0][i%COLS].solid=false; } }
  }
  // honour any painted collision from the editor:
  //   1=block  2=spawn  10+L=piso(floor)  100+lo*10+hi=escada(stair)
  spawnCells=[]; const co=d.coll||[];
  for(let i=0;i<co.length;i++){ const v=co[i]; if(!v)continue; const c=i%COLS, r=(i/COLS)|0, g=grid[r][c];
    if(v===1) g.solid=true;                                           // block
    else if(v===2){ g.solid=false; g.spawn=true; spawnCells.push({c,r}); }  // spawn
    else if((v>=10&&v<20)||v>=100){ g.solid=false; }                 // piso / escada — walkable
  }
  // mato (decorative bushes) — independent array, doesn't affect collision
  matoCells=[]; const mo=d.mato||[];
  for(let i=0;i<mo.length;i++){ if(mo[i]){ const c=i%COLS, r=(i/COLS)|0; matoCells.push({c,r}); } }
}

//======================= ENTITIES =======================
function freeCell(cx,cy){
  for(let rad=0;rad<48;rad++){
    for(let a=0;a<16;a++){
      const c=clamp((cx+Math.cos(a/16*6.28)*rad)|0,1,COLS-2);
      const r=clamp((cy+Math.sin(a/16*6.28)*rad)|0,1,ROWS-2);
      if(!grid[r][c].solid) return {x:c*MTILE+MTILE/2, y:r*MTILE+MTILE/2};
    }
  }
  return {x:cx*MTILE+8, y:cy*MTILE+8};
}
function makeFighter(i){
  let pos, ang=(i/N_FIGHTERS)*Math.PI*2;
  if(spawnCells.length){ const s=spawnCells[i%spawnCells.length]; pos={x:s.c*MTILE+8, y:s.r*MTILE+8}; }
  else { const rr=Math.min(COLS,ROWS)*0.36; pos=freeCell(COLS/2+Math.cos(ang)*rr, ROWS/2+Math.sin(ang)*rr); }
  return { id:i, name:NAMES[i]||('Bot'+i), isPlayer:i===0, skin:i%4,
    x:pos.x, y:pos.y, aim:ang+Math.PI, hp:100, alive:true, h:0,
    weapon:'pistol', ammo:Infinity, cd:0, animT:0, frame:0, hurtT:0, moving:false,
    bt:{ retimer:0, strafe:Math.random()<0.5?1:-1 } };
}

function newGame(){
  bullets=[]; pickups=[]; parts=[]; elapsed=0; shrinkStage=0;
  buildLevel();
  fighters=[]; for(let i=0;i<N_FIGHTERS;i++) fighters.push(makeFighter(i));
  player=fighters[0];
  for(let k=0;k<14;k++) spawnPickup();
  zone={ r:Math.max(WORLD_W,WORLD_H)*0.6, tr:0, cx:WORLD_W/2, cy:WORLD_H/2, dmgT:0 };
  cam.x=clamp(player.x-(VW/VIEW_SCALE)/2,0,WORLD_W-VW/VIEW_SCALE);
  cam.y=clamp(player.y-(VH/VIEW_SCALE)/2,0,WORLD_H-VH/VIEW_SCALE);
}

function spawnPickup(){
  const type=pick(DROP_TYPES);
  for(let t=0;t<40;t++){
    const c=1+((Math.random()*(COLS-2))|0), r=1+((Math.random()*(ROWS-2))|0);
    if(!grid[r][c].solid){ pickups.push({x:c*MTILE+8,y:r*MTILE+8,type,bob:rand(0,6.28)}); return; }
  }
}

//======================= COMBAT =======================
function fire(f){
  const w=WEAPONS[f.weapon];
  if(f.cd>0) return;
  if(f.ammo<=0){ f.weapon='pistol'; f.ammo=Infinity; return; }
  f.cd=w.rate;
  for(let p=0;p<w.pellets;p++){
    const a=f.aim+rand(-w.spread,w.spread);
    const mx=f.x+Math.cos(f.aim)*16, my=f.y+Math.sin(f.aim)*16;
    bullets.push({ x:mx,y:my, vx:Math.cos(a)*w.speed, vy:Math.sin(a)*w.speed,
      dmg:w.dmg, owner:f.id, life:w.range/w.speed, r:4, h:f.h });
  }
  if(w.ammo!==Infinity) f.ammo--;
  parts.push({x:f.x+Math.cos(f.aim)*18,y:f.y+Math.sin(f.aim)*18-(f.h?ELEV:0),r:7,life:0.06,max:0.06,col:'#ffd97a'});
  if(f.isPlayer) play('shoot'+'abc'[(Math.random()*3)|0],0.35);
  else if(Math.hypot(f.x-player.x,f.y-player.y)<600) play('shootc',0.12);
}
function hurt(f,dmg,kx,ky,ownerId){
  if(!f.alive) return;
  f.hp-=dmg; f.hurtT=0.12; f.x+=kx*0.4; f.y+=ky*0.4;
  const yo=f.h?ELEV:0;
  for(let i=0;i<4;i++) parts.push({x:f.x,y:f.y-yo,r:rand(2,4),life:0.3,max:0.3,vx:rand(-60,60),vy:rand(-60,60),col:'#c94b3a'});
  if(f.hp<=0){ f.alive=false; die(f,ownerId); }
  else if(f.isPlayer) play('hurt'+'ab'[(Math.random()*2)|0],0.5);
}
function die(f,ownerId){
  const yo=f.h?ELEV:0;
  for(let i=0;i<16;i++) parts.push({x:f.x,y:f.y-yo,r:rand(2,5),life:rand(0.4,0.8),max:0.8,vx:rand(-140,140),vy:rand(-140,140),col:Math.random()<0.5?'#c94b3a':'#e8dccb'});
  play('explosiona', f.isPlayer?0.6:0.2);
  if(f.weapon!=='pistol') pickups.push({x:f.x,y:f.y,type:f.weapon,bob:0});
  checkEnd();
}

//======================= UPDATE =======================
function moveFighter(f,dx,dy){
  if(dx){ const ex=f.x+Math.sign(dx)*PLAYER_R; if(passable(f.x,f.y,ex+dx,f.y)) f.x+=dx; }
  if(dy){ const ey=f.y+Math.sign(dy)*PLAYER_R; if(passable(f.x,f.y,f.x,ey+dy)) f.y+=dy; }
  f.x=clamp(f.x,PLAYER_R,WORLD_W-PLAYER_R); f.y=clamp(f.y,PLAYER_R,WORLD_H-PLAYER_R);
  f.h=heightAt(f.x,f.y);
  f.moving=!!(dx||dy);
}
function updatePlayer(dt){
  if(!player.alive) return;
  let mx=0,my=0;
  if(keys['w']||keys['arrowup'])my--; if(keys['s']||keys['arrowdown'])my++;
  if(keys['a']||keys['arrowleft'])mx--; if(keys['d']||keys['arrowright'])mx++;
  const len=Math.hypot(mx,my)||1, spd=185;
  moveFighter(player,(mx/len)*spd*dt,(my/len)*spd*dt);
  const wx=cam.x+mouse.x/VIEW_SCALE, wy=cam.y+mouse.y/VIEW_SCALE;
  player.aim=Math.atan2(wy-(player.y-(player.h?ELEV:0)),wx-player.x);
  const w=WEAPONS[player.weapon];
  if(mouse.down){ if(w.auto||!player.fired){ fire(player); player.fired=true; } } else player.fired=false;
}
function nearestEnemy(f){ let best=null,bd=1e9; for(const o of fighters){ if(o===f||!o.alive)continue; const d=dist2(f.x,f.y,o.x,o.y); if(d<bd){bd=d;best=o;} } return {e:best,d:Math.sqrt(bd)}; }
function nearestPickup(f){ let best=null,bd=1e9; for(const p of pickups){ const d=dist2(f.x,f.y,p.x,p.y); if(d<bd){bd=d;best=p;} } return {p:best,d:Math.sqrt(bd)}; }

function updateBot(f,dt){
  if(!f.alive) return;
  const bt=f.bt; bt.retimer-=dt;
  const {e:foe,d:foeD}=nearestEnemy(f);
  const w=WEAPONS[f.weapon];
  const {p:pk,d:pkD}=nearestPickup(f);
  let tx=f.x,ty=f.y,move=false;
  if(pk && (f.weapon==='pistol'||pkD<120) && pkD<420){ tx=pk.x; ty=pk.y; move=true; }
  else if(foe){
    f.aim=Math.atan2(foe.y-f.y,foe.x-f.x)+rand(-0.06,0.06);
    const ideal=w.range*0.6;
    if(foeD>ideal+40){ tx=foe.x; ty=foe.y; move=true; }
    else if(foeD<ideal-60){ tx=f.x-(foe.x-f.x); ty=f.y-(foe.y-f.y); move=true; }
    else { const px=-Math.sin(f.aim)*bt.strafe, py=Math.cos(f.aim)*bt.strafe; tx=f.x+px*100; ty=f.y+py*100; move=true;
      if(bt.retimer<=0){ bt.strafe*=-1; bt.retimer=rand(0.8,1.8); } }
    if(foeD<w.range && Math.random()<0.7) fire(f);
  }
  const zc=Math.hypot(f.x-zone.cx,f.y-zone.cy);
  if(zc>zone.r*0.88){ tx=zone.cx; ty=zone.cy; move=true; }
  if(move){ const a=Math.atan2(ty-f.y,tx-f.x), spd=160;
    moveFighter(f,Math.cos(a)*spd*dt,Math.sin(a)*spd*dt); if(!foe) f.aim=a; }
  else f.moving=false;
}

function updateBullets(dt){
  for(let i=bullets.length-1;i>=0;i--){ const b=bullets[i];
    b.x+=b.vx*dt; b.y+=b.vy*dt; b.life-=dt;
    let dead=b.life<=0||b.x<0||b.y<0||b.x>WORLD_W||b.y>WORLD_H;
    if(!dead && cellAt(b.x,b.y).solid) dead=true;   // walls / buildings block shots (cover)
    if(!dead) for(const f of fighters){ if(!f.alive||f.id===b.owner)continue;
      if(dist2(b.x,b.y,f.x,f.y)<(PLAYER_R+b.r)*(PLAYER_R+b.r)){ hurt(f,b.dmg,b.vx*0.02,b.vy*0.02,b.owner); dead=true; break; } }
    if(dead) bullets.splice(i,1);
  }
}
function updatePickups(){
  for(let i=pickups.length-1;i>=0;i--){ const p=pickups[i];
    for(const f of fighters){ if(!f.alive)continue;
      if(dist2(p.x,p.y,f.x,f.y)<(PLAYER_R+12)*(PLAYER_R+12)){ const w=WEAPONS[p.type];
        f.weapon=p.type; f.ammo=w.ammo; f.cd=0; if(f.isPlayer) play('coina',0.4); pickups.splice(i,1); break; } }
  }
  if(pickups.length<8 && Math.random()<0.02) spawnPickup();
}
function updateParts(dt){ for(let i=parts.length-1;i>=0;i--){ const p=parts[i]; p.life-=dt;
  if(p.vx){ p.x+=p.vx*dt; p.y+=p.vy*dt; p.vx*=0.9; p.vy*=0.9; } if(p.life<=0) parts.splice(i,1); } }

function updateZone(dt){
  elapsed+=dt;
  const stages=[0.6,0.46,0.34,0.24,0.16,0.11];
  const want=Math.min(shrinkStage,stages.length-1);
  zone.tr=Math.max(WORLD_W,WORLD_H)*stages[want];
  if(elapsed>(shrinkStage+1)*14 && shrinkStage<stages.length-1) shrinkStage++;
  zone.r+=(zone.tr-zone.r)*Math.min(1,dt*0.6);
  zone.dmgT-=dt;
  if(zone.dmgT<=0){ zone.dmgT=0.5;
    for(const f of fighters){ if(!f.alive)continue; if(Math.hypot(f.x-zone.cx,f.y-zone.cy)>zone.r) hurt(f,6,0,0,null); } }
}
function aliveCount(){ return fighters.reduce((n,f)=>n+(f.alive?1:0),0); }
function checkEnd(){ const a=fighters.filter(f=>f.alive); if(a.length<=1){ state='over'; showOver(player.alive,a[0]); } }

//======================= RENDER =======================
function updateCamera(){
  const tx=clamp((player.x)-(VW/VIEW_SCALE)/2,0,WORLD_W-VW/VIEW_SCALE);
  const ty=clamp((player.y-(player.h?ELEV:0))-(VH/VIEW_SCALE)/2,0,WORLD_H-VH/VIEW_SCALE);
  cam.x+=(tx-cam.x)*0.15; cam.y+=(ty-cam.y)*0.15;
}
function sandTile(c,r){ if(((c*13+r*7)%37)===0) return T.sandDot; return T.sand[0]; }

function draw(){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle='#c99a63'; ctx.fillRect(0,0,VW,VH);
  ctx.setTransform(VIEW_SCALE,0,0,VIEW_SCALE,-cam.x*VIEW_SCALE,-cam.y*VIEW_SCALE);

  const c0=Math.max(0,(cam.x/MTILE|0)-1), r0=Math.max(0,(cam.y/MTILE|0)-1);
  const c1=Math.min(COLS,c0+(VW/VIEW_SCALE/MTILE|0)+3), r1=Math.min(ROWS,r0+(VH/VIEW_SCALE/MTILE|0)+3);

  // pre-compute: for each mato cell, which layer holds the front sprite to animate
  const matoTop = {};
  for(const m of matoCells){
    const i=m.r*COLS+m.c;
    if(mapLayers) for(let li=mapLayers.length-1;li>=0;li--){
      if(mapLayers[li].tiles[i]){ matoTop[i]=li; break; }
    }
  }

  // the authored map: every visible tile layer, bottom → top  (mato animates in its own layer)
  if(mapLayers){
    const tileCache = {};
    for(let li=0; li<mapLayers.length; li++){ const L=mapLayers[li], t=L.tiles;
      for(let r=r0;r<r1;r++){ const base=r*COLS; for(let c=c0;c<c1;c++){
        const i=base+c; const tt=t[i]; if(!tt) continue;
        if(matoTop[i]===li){
          // ── animated mato (in-layer) ──
          const ss=MAP_SHEETS[tt[0]]||MAP_SHEETS[0], srcImg=IMG[ss[0]]; if(!srcImg) continue;
          const ts=ss[1];
          const key=tt[0]+'_'+tt[1]+'_'+tt[2];
          let tc=tileCache[key];
          if(!tc){ tc=document.createElement('canvas'); tc.width=ts; tc.height=ts;
            const tctx=tc.getContext('2d'); tctx.imageSmoothingEnabled=false;
            tctx.drawImage(srcImg, tt[1]*ts, tt[2]*ts, ts, ts, 0, 0, ts, ts);
            tileCache[key]=tc; }
          const ph=c*0.6+r*0.9;
          const rot=Math.sin(elapsed*2.0+ph)*0.06;
          ctx.save();
          ctx.translate(c*MTILE+MTILE/2, r*MTILE+MTILE);
          ctx.rotate(rot);
          ctx.drawImage(tc, 0, 0, ts, ts, -MTILE/2, -MTILE, MTILE, MTILE);
          ctx.restore();
        } else {
          blitMap(tt, c*MTILE, r*MTILE);
        }
      }}
    }
  }

  // world border
  ctx.strokeStyle='#8a6a44'; ctx.lineWidth=6; ctx.strokeRect(0,0,WORLD_W,WORLD_H);

  // pickups
  for(const p of pickups){ p.bob+=0.05; const yo=Math.sin(p.bob)*2;
    ctx.save(); ctx.globalAlpha=0.5; ctx.fillStyle='#f4c95d'; ctx.beginPath(); ctx.ellipse(p.x,p.y+8,11,4,0,0,6.28); ctx.fill(); ctx.restore();
    const w=WEAPONS[p.type]; drawSprite(IMG.weapons, w.spr%10, (w.spr/10)|0, p.x, p.y+yo, 0, 0.9);
  }

  // storm zone (darken outside)
  ctx.save(); ctx.beginPath(); ctx.rect(0,0,WORLD_W,WORLD_H); ctx.arc(zone.cx,zone.cy,zone.r,0,6.28,true);
  ctx.fillStyle='rgba(150,90,40,0.30)'; ctx.fill('evenodd');
  ctx.strokeStyle='#f2a33c'; ctx.lineWidth=4; ctx.beginPath(); ctx.arc(zone.cx,zone.cy,zone.r,0,6.28); ctx.stroke(); ctx.restore();

  // fighters (shadow on ground, body raised if on plateau) — sorted by y for overlap
  const order=fighters.filter(f=>f.alive).sort((a,b)=>a.y-b.y);
  for(const f of order){ const yo=f.h?ELEV:0;
    ctx.fillStyle='rgba(0,0,0,.22)'; ctx.beginPath(); ctx.ellipse(f.x,f.y+10,10,4,0,0,6.28); ctx.fill();
    f.animT+=0.016; f.frame=f.moving?1+(Math.floor(f.animT*8)%3):0;
    const flip=Math.cos(f.aim)<0;
    drawSprite(IMG.players, f.frame, f.skin, f.x, f.y-yo, 0, 1.0, flip);
    const w=WEAPONS[f.weapon]; const gx=f.x+Math.cos(f.aim)*10, gy=f.y-yo+Math.sin(f.aim)*8;
    drawSprite(IMG.weapons, w.spr%10, (w.spr/10)|0, gx, gy, flip?f.aim+Math.PI:f.aim, 0.85, flip);
    const bw=24, bx=f.x-bw/2, by=f.y-yo-20;
    ctx.fillStyle='rgba(0,0,0,.5)'; ctx.fillRect(bx-1,by-1,bw+2,5);
    ctx.fillStyle=f.isPlayer?'#5fd35f':'#e0533a'; ctx.fillRect(bx,by,bw*clamp(f.hp/100,0,1),3);
    if(!f.isPlayer){ ctx.fillStyle='#3a2a1c'; ctx.font='7px system-ui'; ctx.textAlign='center'; ctx.fillText(f.name,f.x,by-3); }
  }

  // bullets
  ctx.fillStyle='#fff4c2';
  for(const b of bullets){ ctx.beginPath(); ctx.arc(b.x,b.y,b.r,0,6.28); ctx.fill();
    ctx.strokeStyle='rgba(255,200,80,.5)'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(b.x,b.y); ctx.lineTo(b.x-b.vx*0.01,b.y-b.vy*0.01); ctx.stroke(); ctx.fillStyle='#fff4c2'; }

  // particles
  for(const p of parts){ ctx.globalAlpha=clamp(p.life/p.max,0,1); ctx.fillStyle=p.col; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.28); ctx.fill(); }
  ctx.globalAlpha=1;

  drawHUD();
}

function drawHUD(){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle='rgba(30,22,18,.72)'; roundRect(VW/2-70,14,140,40,8); ctx.fill();
  ctx.fillStyle='#f4c95d'; ctx.font='bold 26px system-ui'; ctx.textAlign='center'; ctx.fillText(aliveCount()+' ALIVE',VW/2,42);
  if(!player.alive) return;
  const px=24,py=VH-70;
  ctx.fillStyle='rgba(30,22,18,.72)'; roundRect(px-12,py-14,238,64,10); ctx.fill();
  ctx.fillStyle='#3a2a20'; roundRect(px,py,180,16,6); ctx.fill();
  ctx.fillStyle='#5fd35f'; roundRect(px,py,180*clamp(player.hp/100,0,1),16,6); ctx.fill();
  ctx.fillStyle='#fff'; ctx.font='bold 12px system-ui'; ctx.textAlign='left'; ctx.fillText(Math.max(0,player.hp|0)+' HP',px+6,py+13);
  const w=WEAPONS[player.weapon];
  ctx.fillStyle='#f4c95d'; ctx.font='bold 18px system-ui'; ctx.fillText(w.name,px,py+40);
  ctx.fillStyle='#e8dccb'; ctx.font='14px system-ui'; ctx.fillText(w.ammo===Infinity?'∞':(player.ammo+' / '+w.ammo),px+120,py+40);
  ctx.fillStyle='rgba(30,22,18,.6)'; roundRect(16,14,150,26,7); ctx.fill();
  ctx.fillStyle='#f2a33c'; ctx.font='bold 13px system-ui'; ctx.textAlign='left';
  ctx.fillText('⛈ storm closing '+Math.max(0,Math.ceil((shrinkStage+1)*14-elapsed))+'s',26,32);
}
function roundRect(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

//======================= LOOP =======================
let last=0;
function step(dt){
  for(const f of fighters){ if(f.cd>0)f.cd-=dt; if(f.hurtT>0)f.hurtT-=dt; }
  updatePlayer(dt);
  for(const f of fighters) if(!f.isPlayer) updateBot(f,dt);
  updateBullets(dt); updatePickups(); updateParts(dt); updateZone(dt); updateCamera();
}
function frame(t){ const dt=Math.min(0.05,(t-last)/1000)||0; last=t; if(state==='playing'){ step(dt); draw(); } requestAnimationFrame(frame); }
// debug pump for headless verification — never draw without a level loaded
window.__tick=(n=1,dt=0.016)=>{ if(state!=='playing') return 'not-playing';
  for(let i=0;i<n;i++){ if(state!=='playing')break; step(dt); } draw(); return state; };
window.__solid=(c,r)=>(grid[r]&&grid[r][c])?grid[r][c].solid:null;
window.__firstSolid=()=>{ for(let r=1;r<ROWS-1;r++)for(let c=1;c<COLS-1;c++){ if(grid[r][c].solid && !grid[r][c-1].solid) return {c,r}; } return null; };
window.__tp=(c,r)=>{ player.x=c*MTILE+8; player.y=r*MTILE+8;
  cam.x=clamp(player.x-(VW/VIEW_SCALE)/2,0,WORLD_W-VW/VIEW_SCALE); cam.y=clamp(player.y-(VH/VIEW_SCALE)/2,0,WORLD_H-VH/VIEW_SCALE); draw(); };
window.DBG=()=>({ state, keys:Object.keys(keys).filter(k=>keys[k]),
  p:{x:player.x|0,y:player.y|0,hp:player.hp|0,alive:player.alive,weapon:player.weapon},
  cam:{x:cam.x|0,y:cam.y|0}, alive:aliveCount(), pickups:pickups.length,
  world:COLS+'x'+ROWS, solids: grid.flat().filter(g=>g.solid).length, spawns:spawnCells.length,
  layers: mapLayers?mapLayers.map(l=>l.name):null });

//======================= FLOW =======================
function showOver(won,survivor){
  overlay.classList.remove('hidden');
  oh1.textContent=won?'🏆 WINNER!':'YOU DIED';
  op.innerHTML=won ? `You are the last mascot standing.<br><span class="sub">Survived ${elapsed|0}s</span>`
    : `${survivor?survivor.name:'A bandit'} took the crown. You placed #${aliveCount()+1}.<br><span class="sub">Survived ${elapsed|0}s</span>`;
  startBtn.textContent='PLAY AGAIN';
  if(!won) play('losea',0.5);
}
function start(){ overlay.classList.add('hidden'); newGame(); state='playing'; last=performance.now(); }
startBtn.addEventListener('click',start);

//======================= BOOT =======================
Promise.all([
  loadImg('players','assets/img/players_packed.png'),
  loadImg('weapons','assets/img/weapons_packed.png'),
  loadImg('enemies','assets/img/enemies_packed.png'),
  loadImg('tiles','assets/img/tiles_packed.png'),
  loadImg('interface','assets/img/interface_packed.png'),
  fetch('map.json?t='+Date.now()).then(r=>r.ok?r.json():null).then(d=>{ MAP=d; }).catch(()=>{ MAP=null; }),
]).then(()=>{
  ['shoota','shootb','shootc','explosiona','hurta','hurtb','coina','losea','selecta']
    .forEach(k=>loadSfx(k,'assets/sfx/'+k.replace(/([a-z])$/,'-$1')+'.ogg'));
  if(!MAP) console.warn('map.json não carregou — usando arena de areia padrão');
  requestAnimationFrame(frame);
});
