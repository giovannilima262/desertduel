'use strict';
/* Desert Duel — Map Editor. Draw the map from Kenney tiles + paint collision layers.
   Exports JSON consumed by the game. Autosaves to localStorage. */
window.addEventListener('error', e=>{ window.__err = (e.message||'?')+' @'+e.lineno+':'+e.colno; });
window.__mark = 'start';

const TILE = 24;
const SHEETS = {
  tiles:   { src:'assets/img/tiles_packed.png',   cols:12, rows:8,  label:'Tiles (terreno, props, cercas, portas)' },
  enemies: { src:'assets/img/enemies_packed.png', cols:4,  rows:4,  label:'Enemies' },
  players: { src:'assets/img/players_packed.png', cols:4,  rows:4,  label:'Players' },
  weapons: { src:'assets/img/weapons_packed.png', cols:10, rows:4,  label:'Weapons' },
};
// collision types (0 = none). Extend freely later.
const COLL = [
  { id:1, name:'Andar',   color:'rgba(80,205,110,0.50)', key:'walk'  },
  { id:2, name:'Escada',  color:'rgba(80,150,255,0.55)', key:'stair' },
  { id:3, name:'Bloqueio',color:'rgba(230,80,70,0.55)',  key:'block' },
  { id:4, name:'Spawn',   color:'rgba(244,201,93,0.55)', key:'spawn' },
  { id:5, name:'Mato',    color:'rgba(100,210,80,0.55)', key:'bush'  },
];

const IMG = {};
const $ = id => document.getElementById(id);

// ---------- state ----------
let cols = 60, rows = 46;
let base = [], top = [], coll = [];        // base/top: {sh,c,r}|null ; coll: int
let layer = 'base';                        // base | top | coll
let tool = 'paint';                        // paint | erase | fill | pick
let sheet = 'tiles';
let sel = { sh:'tiles', c:0, r:0 };        // selected tile
let collSel = 1;
let cell = 22;                             // display px per cell
let showGrid = true, showColl = true;
let hover = null;                          // {c,r}
let painting = false, eraseDrag = false;

function idx(c,r){ return r*cols+c; }
function blankLayers(){
  base = new Array(cols*rows).fill(null);
  top  = new Array(cols*rows).fill(null);
  coll = new Array(cols*rows).fill(0);
}

// ---------- palette ----------
const palCanvas = $('paletteCanvas'), palCtx = palCanvas.getContext('2d');
const PAL_SCALE = 3;
function drawPalette(){
  const s = SHEETS[sheet]; const img = IMG[sheet];
  const w = s.cols*TILE*PAL_SCALE, h = s.rows*TILE*PAL_SCALE;
  palCanvas.width = w; palCanvas.height = h;
  palCtx.imageSmoothingEnabled = false;
  // checker background to reveal tile transparency
  palCtx.fillStyle='#4a3e35'; palCtx.fillRect(0,0,w,h);
  palCtx.fillStyle='#564a40';
  for(let y=0;y<h;y+=16) for(let x=0;x<w;x+=16){ if(((x/16+y/16)&1)) palCtx.fillRect(x,y,16,16); }
  // tiles
  for(let r=0;r<s.rows;r++) for(let c=0;c<s.cols;c++){
    palCtx.drawImage(img, c*TILE,r*TILE,TILE,TILE, c*TILE*PAL_SCALE,r*TILE*PAL_SCALE,TILE*PAL_SCALE,TILE*PAL_SCALE);
  }
  // grid
  palCtx.strokeStyle='rgba(0,0,0,0.25)'; palCtx.lineWidth=1;
  for(let c=0;c<=s.cols;c++){ palCtx.beginPath(); palCtx.moveTo(c*TILE*PAL_SCALE+.5,0); palCtx.lineTo(c*TILE*PAL_SCALE+.5,h); palCtx.stroke(); }
  for(let r=0;r<=s.rows;r++){ palCtx.beginPath(); palCtx.moveTo(0,r*TILE*PAL_SCALE+.5); palCtx.lineTo(w,r*TILE*PAL_SCALE+.5); palCtx.stroke(); }
  // selection
  if(sel.sh===sheet){
    palCtx.strokeStyle='#f4c95d'; palCtx.lineWidth=3;
    palCtx.strokeRect(sel.c*TILE*PAL_SCALE+1.5, sel.r*TILE*PAL_SCALE+1.5, TILE*PAL_SCALE-3, TILE*PAL_SCALE-3);
  }
}
palCanvas.addEventListener('mousedown', e=>{
  const rect = palCanvas.getBoundingClientRect();
  const c = ((e.clientX-rect.left)/(TILE*PAL_SCALE))|0, r = ((e.clientY-rect.top)/(TILE*PAL_SCALE))|0;
  const s = SHEETS[sheet];
  if(c<0||r<0||c>=s.cols||r>=s.rows) return;
  sel = { sh:sheet, c, r }; drawPalette(); drawSel(); updateSelText();
  if(layer==='coll'){ layer='base'; setLayer(); }   // painting a tile implies a tile layer
});

const selCanvas = $('selCanvas'), selCtx = selCanvas.getContext('2d');
function drawSel(){
  selCtx.clearRect(0,0,48,48); selCtx.imageSmoothingEnabled=false;
  selCtx.drawImage(IMG[sel.sh], sel.c*TILE,sel.r*TILE,TILE,TILE, 0,0,48,48);
}
function updateSelText(){ $('selText').textContent = `${sel.sh} (${sel.c},${sel.r})`; }

// ---------- map ----------
const mapCanvas = $('mapCanvas'), mapCtx = mapCanvas.getContext('2d');
function drawTileTo(ctx, ref, x, y, size){
  if(!ref) return; const img = IMG[ref.sh]; if(!img) return;
  ctx.drawImage(img, ref.c*TILE, ref.r*TILE, TILE, TILE, x, y, size, size);
}
function renderMap(){
  mapCanvas.width = cols*cell; mapCanvas.height = rows*cell;
  mapCtx.imageSmoothingEnabled = false;
  mapCtx.fillStyle = '#c99a63'; mapCtx.fillRect(0,0,mapCanvas.width,mapCanvas.height); // sand backdrop
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const x=c*cell, y=r*cell;
    drawTileTo(mapCtx, base[idx(c,r)], x,y,cell);
    drawTileTo(mapCtx, top[idx(c,r)],  x,y,cell);
  }
  if(showColl){
    for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
      const v = coll[idx(c,r)]; if(!v) continue;
      const t = COLL.find(k=>k.id===v); if(!t) continue;
      mapCtx.fillStyle = t.color; mapCtx.fillRect(c*cell,r*cell,cell,cell);
    }
  }
  if(showGrid){
    mapCtx.strokeStyle='rgba(0,0,0,0.18)'; mapCtx.lineWidth=1;
    for(let c=0;c<=cols;c++){ mapCtx.beginPath(); mapCtx.moveTo(c*cell+.5,0); mapCtx.lineTo(c*cell+.5,rows*cell); mapCtx.stroke(); }
    for(let r=0;r<=rows;r++){ mapCtx.beginPath(); mapCtx.moveTo(0,r*cell+.5); mapCtx.lineTo(cols*cell,r*cell+.5); mapCtx.stroke(); }
  }
  if(hover){
    mapCtx.strokeStyle='#f4c95d'; mapCtx.lineWidth=2;
    mapCtx.strokeRect(hover.c*cell+1, hover.r*cell+1, cell-2, cell-2);
  }
}

function cellFromEvent(e){
  const rect = mapCanvas.getBoundingClientRect();
  const c = ((e.clientX-rect.left)/cell)|0, r = ((e.clientY-rect.top)/cell)|0;
  if(c<0||r<0||c>=cols||r>=rows) return null;
  return {c,r};
}
function applyAt(c,r,erase){
  const i = idx(c,r);
  if(layer==='coll'){
    coll[i] = erase ? 0 : collSel;
  } else {
    const arr = layer==='base'?base:top;
    if(erase || tool==='erase') arr[i]=null;
    else arr[i] = { sh:sel.sh, c:sel.c, r:sel.r };
  }
}
function floodFill(c,r){
  const i=idx(c,r);
  if(layer==='coll'){
    const target=coll[i], repl=collSel; if(target===repl) return;
    const st=[[c,r]]; while(st.length){ const [x,y]=st.pop(); if(x<0||y<0||x>=cols||y>=rows) continue;
      if(coll[idx(x,y)]!==target) continue; coll[idx(x,y)]=repl; st.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]); }
  } else {
    const arr=layer==='base'?base:top; const key=v=>v?`${v.sh},${v.c},${v.r}`:'';
    const target=key(arr[i]); const repl=`${sel.sh},${sel.c},${sel.r}`; if(target===repl) return;
    const st=[[c,r]]; while(st.length){ const [x,y]=st.pop(); if(x<0||y<0||x>=cols||y>=rows) continue;
      if(key(arr[idx(x,y)])!==target) continue; arr[idx(x,y)]={sh:sel.sh,c:sel.c,r:sel.r}; st.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]); }
  }
}
function pickAt(c,r){
  const ref = (layer==='top'?top:base)[idx(c,r)] || top[idx(c,r)] || base[idx(c,r)];
  if(ref){ sel={sh:ref.sh,c:ref.c,r:ref.r}; if(sel.sh!==sheet){ sheet=sel.sh; $('sheetSel').value=sheet; drawPalette(); } else drawPalette(); drawSel(); updateSelText(); }
}

mapCanvas.addEventListener('mousedown', e=>{
  const cr = cellFromEvent(e); if(!cr) return;
  const rightOrAlt = e.button===2 || e.altKey;
  if(e.altKey){ pickAt(cr.c,cr.r); return; }
  if(tool==='pick'){ pickAt(cr.c,cr.r); return; }
  if(tool==='fill' && !rightOrAlt){ floodFill(cr.c,cr.r); renderMap(); save(); return; }
  painting = true; eraseDrag = rightOrAlt;
  applyAt(cr.c,cr.r,eraseDrag); renderMap();
  e.preventDefault();
});
window.addEventListener('mousemove', e=>{
  const cr = cellFromEvent(e);
  hover = cr;
  $('stCell').textContent = cr ? `célula: ${cr.c}, ${cr.r}` : 'célula: —';
  if(painting && cr){ applyAt(cr.c,cr.r,eraseDrag); }
  renderMap();
});
window.addEventListener('mouseup', ()=>{ if(painting){ painting=false; save(); } });
mapCanvas.addEventListener('contextmenu', e=>e.preventDefault());

// ---------- toolbar ----------
function setLayer(){
  ['base','top','coll'].forEach(l=>$('L'+l).classList.toggle('on', layer===l));
  $('collGroup').style.display = layer==='coll' ? 'flex' : 'none';
  $('toolGroup').style.display = 'flex';
  $('stLayer').textContent = 'camada: ' + (layer==='coll'?'colisão':layer==='top'?'objetos':'base');
}
document.querySelectorAll('[data-layer]').forEach(b=> b.onclick=()=>{ layer=b.dataset.layer; setLayer(); });
document.querySelectorAll('[data-tool]').forEach(b=> b.onclick=()=>{ tool=b.dataset.tool;
  document.querySelectorAll('[data-tool]').forEach(x=>x.classList.toggle('on',x===b)); });

// collision buttons
const collGroup = $('collGroup');
COLL.forEach(t=>{
  const b=document.createElement('button'); b.className='coll'; b.innerHTML=`<span class="swatch" style="background:${t.color}"></span>${t.name}`;
  b.onclick=()=>{ collSel=t.id; layer='coll'; setLayer(); [...collGroup.querySelectorAll('button')].forEach(x=>x.classList.toggle('on',x===b)); };
  collGroup.appendChild(b);
});
setTimeout(()=>collGroup.querySelector('button')?.classList.add('on'),0);

$('zoomIn').onclick =()=>{ cell=Math.min(48,cell+3); renderMap(); };
$('zoomOut').onclick=()=>{ cell=Math.max(8,cell-3); renderMap(); };
$('gridToggle').onclick=e=>{ showGrid=!showGrid; e.target.classList.toggle('on',showGrid); renderMap(); };
$('collView').onclick =e=>{ showColl=!showColl; e.target.classList.toggle('on',showColl); renderMap(); };
$('resizeBtn').onclick=()=>{
  const nc=clamp(+$('mCols').value|0,8,200), nr=clamp(+$('mRows').value|0,8,200);
  const ob=base,otp=top,oc=coll,ocols=cols,orows=rows;
  cols=nc; rows=nr; blankLayers();
  for(let r=0;r<Math.min(nr,orows);r++)for(let c=0;c<Math.min(nc,ocols);c++){
    base[idx(c,r)]=ob[r*ocols+c]; top[idx(c,r)]=otp[r*ocols+c]; coll[idx(c,r)]=oc[r*ocols+c];
  }
  renderMap(); save();
};
$('clearBtn').onclick=()=>{ if(confirm('Limpar todo o mapa?')){ blankLayers(); renderMap(); save(); } };
function clamp(v,a,b){ return v<a?a:v>b?b:v; }

window.__mark = 'before-sheetsel';
// sheet selector
const sheetSel=$('sheetSel');
Object.entries(SHEETS).forEach(([k,s])=>{ const o=document.createElement('option'); o.value=k; o.textContent=s.label; sheetSel.appendChild(o); });
sheetSel.onchange=()=>{ sheet=sheetSel.value; drawPalette(); };

// keyboard
window.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if(e.key==='b') { layer='base'; setLayer(); }
  else if(e.key==='o'){ layer='top'; setLayer(); }
  else if(e.key==='c'){ layer='coll'; setLayer(); }
  else if(e.key==='e'){ tool='erase'; document.querySelectorAll('[data-tool]').forEach(x=>x.classList.toggle('on',x.dataset.tool==='erase')); }
  else if(e.key==='p'){ tool='paint'; document.querySelectorAll('[data-tool]').forEach(x=>x.classList.toggle('on',x.dataset.tool==='paint')); }
  else if(e.key==='g'){ $('gridToggle').click(); }
  else if(e.key==='+'||e.key==='='){ $('zoomIn').click(); }
  else if(e.key==='-'){ $('zoomOut').click(); }
});

// ---------- persistence / io ----------
const LS='desertduel_map';
function serialize(){
  return { v:2, tile:16, cols, rows,
    layers: [
      { type:'tiles', name:'Chão',    visible:true, locked:false, alpha:1, tiles:base.map(t=>t?[t.sh==='tiles'?0:t.sh,t.c,t.r]:null) },
      { type:'tiles', name:'Objetos', visible:true, locked:false, alpha:1, tiles:top.map(t=>t?[t.sh==='tiles'?0:t.sh,t.c,t.r]:null) },
    ],
    coll };
}
function save(){ try{ localStorage.setItem(LS, JSON.stringify(serialize())); }catch(e){} }
function deserialize(d){
  if(!d||!d.cols) return false;
  cols=d.cols; rows=d.rows; blankLayers();
  const un=t=>{ if(!t) return null; const sh = t[0]===0?'tiles':t[0]; return {sh,c:t[1],r:t[2]}; };
  // v2 format: layers array
  if(d.layers){
    for(const L of d.layers){
      if(!L.tiles) continue;
      const isBase = /chão|base|ground/i.test(L.name||'');
      const isTop  = /objetos|top|props|objetos/i.test(L.name||'');
      const arr = isBase ? base : isTop ? top : null;
      if(arr) L.tiles.forEach((t,i)=>arr[i]=un(t));
    }
  } else {
    // legacy v1 format
    if(d.base) d.base.forEach((t,i)=>base[i]=un(t));
    if(d.top)  d.top.forEach((t,i)=>top[i]=un(t));
  }
  if(d.coll) d.coll.forEach((v,i)=>coll[i]=v||0);
  $('mCols').value=cols; $('mRows').value=rows;
  return true;
}
function loadLS(){ try{ const d=JSON.parse(localStorage.getItem(LS)); return d&&deserialize(d); }catch(e){ return false; } }

const dlg=$('ioDlg');
$('exportBtn').onclick=()=>{ $('ioTitle').textContent='Exportar mapa'; $('ioText').value=JSON.stringify(serialize());
  $('ioLoad').style.display='none'; dlg.showModal(); $('ioText').select(); };
$('importBtn').onclick=()=>{ $('ioTitle').textContent='Importar mapa (cole o JSON)'; $('ioText').value='';
  $('ioLoad').style.display='inline-block'; dlg.showModal(); $('ioText').focus(); };
$('ioCopy').onclick=()=>{ $('ioText').select(); document.execCommand('copy'); };
$('ioDownload').onclick=()=>{ const blob=new Blob([$('ioText').value||JSON.stringify(serialize())],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='map.json'; a.click(); };
$('ioLoad').onclick=()=>{ try{ const d=JSON.parse($('ioText').value); if(deserialize(d)){ renderMap(); save(); dlg.close(); } else alert('JSON inválido'); }catch(e){ alert('Erro: '+e.message); } };
$('ioClose').onclick=()=>dlg.close();
$('saveBtn').onclick=()=>{ save(); $('saveBtn').textContent='✔ Salvo'; setTimeout(()=>$('saveBtn').textContent='💾 Salvar',900); };

// ---------- boot ----------
window.__mark = 'before-boot';
Promise.all(Object.entries(SHEETS).map(([k,s])=>new Promise(res=>{
  const i=new Image(); i.onload=()=>{IMG[k]=i;res();}; i.onerror=()=>res(); i.src=s.src;
}))).then(()=>{
  window.__mark = 'boot-done';
  if(!loadLS()) blankLayers();
  sheetSel.value=sheet; drawPalette(); drawSel(); updateSelText(); setLayer(); renderMap();
});
