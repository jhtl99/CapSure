// The /live page: camera view, table status and sensor sliders. Served by hLive().
#pragma once

static const char LIVE_HTML[] = R"HTML(<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>CapSure live</title>
<style>
body{margin:0;background:#0e1013;color:#e8ebee;font:15px system-ui,sans-serif}
main{max-width:720px;margin:auto;padding:12px 16px;display:grid;gap:12px}
img{width:100%;height:auto;min-height:120px;background:#000;border-radius:8px;display:block}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pill{padding:3px 10px;border-radius:99px;font-weight:600;font-size:13px}
.on{background:#143024;color:#4cc488}.off{background:#36270f;color:#f0a648}
.k{color:#9aa4af;font-size:13px}
label{display:grid;grid-template-columns:110px 1fr 36px;gap:8px;align-items:center}
input{accent-color:#4c8dff}output{font-variant-numeric:tabular-nums;text-align:right}
h2{font-size:16px;margin:10px 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.st{background:#171a1f;border-radius:8px;padding:8px 10px}.st b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
select,button{background:#20242c;color:#e8ebee;border:1px solid #333a44;border-radius:6px;padding:5px 8px;font:inherit}
button{cursor:pointer}button:disabled{opacity:.5}
#hint{padding:8px 10px;border-radius:8px;background:#20242c}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
td,th{padding:5px 6px;border-bottom:1px solid #262b33;text-align:right}th{color:#9aa4af;font-weight:500}
td:first-child,th:first-child{text-align:left}tr.best td{color:#4cc488}tr[data-i]{cursor:pointer}
.tw{overflow-x:auto}
code{background:#20242c;padding:8px;border-radius:6px;display:block;font-size:12px;overflow-x:auto;white-space:pre}
</style></head><body><main>
<img id="v" alt="camera">
<div class="bar"><span id="t" class="pill off">-</span><span id="r" class="pill off">-</span>
<span class="k" id="g">-</span><span class="k" id="fps"></span></div>
<div id="s"></div>
<div class="k">Copy into capsure_fw.ino once it looks right:</div><code id="c"></code>
<h2>Speed</h2>
<div class="grid" id="sp"></div>
<div id="hint" class="k">-</div>
<div id="ss"></div>
<div class="bar"><button id="sw">Run sweep (~45 s)</button><span class="k" id="swk">Tries 12 settings and measures each. Tap a row to use it.</span></div>
<div class="tw"><table id="res"></table></div>
<div class="k">Speed settings for capsure_fw.ino:</div><code id="c2"></code>
</main><script>
const F=[["brightness",-2,2],["contrast",-2,2],["saturation",-2,2],["ae",-2,2],["gain",0,6]];
// gain is a power of two on the sensor (2x..128x): the slider picks the step
const gx=i=>2<<i, gi=v=>Math.max(0,Math.min(6,Math.round(Math.log2(v))-1));
const box=document.getElementById("s");let cur={};
F.forEach(([k,lo,hi])=>{const l=document.createElement("label");
l.innerHTML=`<span>${k=="ae"?"exposure":k=="gain"?"gain cap (x)":k}</span><input id="i_${k}" type="range" min="${lo}" max="${hi}" step="1"><output id="o_${k}"></output>`;
box.appendChild(l);const i=l.querySelector("input");
i.oninput=()=>{document.getElementById("o_"+k).textContent=k=="gain"?gx(+i.value):i.value};
i.onchange=()=>fetch(`/admin/camera?${k}=${k=="gain"?gx(+i.value):i.value}`).then(r=>r.json()).then(show)});
function show(j){cur=j;F.forEach(([k])=>{const i=document.getElementById("i_"+k);
if(document.activeElement!==i){i.value=k=="gain"?gi(j[k]):j[k];document.getElementById("o_"+k).textContent=j[k]}});
const t=document.getElementById("t");t.textContent=j.table?"table":"no table";t.className="pill "+(j.table?"on":"off");
const r=document.getElementById("r");r.textContent=j.recording?"recording":"paused";r.className="pill "+(j.recording?"on":"off");
document.getElementById("g").textContent=`table colour ${j.green_pct.toFixed(1)}% (needs 10%)`;
document.getElementById("c").textContent=`#define CAM_BRIGHTNESS     ${j.brightness}\n#define CAM_CONTRAST       ${j.contrast}\n#define CAM_SATURATION     ${j.saturation}\n#define CAM_AE_LEVEL       ${j.ae}\n#define CAM_GAIN_X         ${j.gain}`}
function poll(){fetch("/admin/camera").then(r=>r.json()).then(show).catch(()=>{}).finally(()=>setTimeout(poll,500))}
let n=0,t0=Date.now();const v=document.getElementById("v");
function next(){const im=new Image();im.onload=()=>{v.src=im.src;n++;
if(Date.now()-t0>2000){document.getElementById("fps").textContent=(n*1000/(Date.now()-t0)).toFixed(1)+" fps";n=0;t0=Date.now()}
setTimeout(next,150)};im.onerror=()=>setTimeout(next,1000);im.src="/api/preview?t="+Date.now()}
// ---- Speed ----
const S=[["xclk","XCLK (MHz)",[10,16,20,24]],["mul","PLL multiplier",160,252,4],["pclk","PCLK divider",2,8,1],
["maxexp","max exposure (lines)",300,1000,4],["band","flicker filter",[[0,"driver (50 Hz)"],[60,"60 Hz (US)"],[50,"50 Hz"],[-1,"off"]]],["q","JPEG quality",8,30,1]];
const DEF={mul:200,pclk:4,maxexp:984};const eff=(k,v)=>v||DEF[k]||v;
const sbox=document.getElementById("ss");let sp={},sweeping=false;
const setSpeed=q=>fetch("/admin/speed?"+q).then(r=>r.json()).then(showSpeed);
S.forEach(([k,name,a,hi,st])=>{const l=document.createElement("label");let ctl;
if(Array.isArray(a)){ctl=`<select id="j_${k}">${a.map(o=>Array.isArray(o)?`<option value="${o[0]}">${o[1]}</option>`:`<option value="${o}">${o}</option>`).join("")}</select>`}
else ctl=`<input id="j_${k}" type="range" min="${a}" max="${hi}" step="${st}">`;
l.innerHTML=`<span>${name}</span>${ctl}<output id="p_${k}"></output>`;sbox.appendChild(l);
const i=l.querySelector("select,input");i.oninput=()=>{document.getElementById("p_"+k).textContent=i.tagName=="SELECT"?"":i.value};
i.onchange=()=>setSpeed(`${k}=${i.value}`)});
function mhz(j){const pll=j.xclk/2*eff("mul",j.mul)/4*2/5;return[pll/4,pll/4/eff("pclk",j.pclk)]}
function showSpeed(j){sp=j;S.forEach(([k])=>{const i=document.getElementById("j_"+k);if(document.activeElement===i)return;
i.value=eff(k,j[k]);document.getElementById("p_"+k).textContent=i.tagName=="SELECT"?"":eff(k,j[k])});
const [sys,pc]=mhz(j);
const st=[["sensor fps",j.sensor_fps.toFixed(1)],["recorded fps",j.recording?j.rec_fps.toFixed(1):"paused"],["frame size",j.frame_kb.toFixed(0)+" KB"],
["brightness",j.luma+" / 255"],["exposure",j.ov5640?`${j.exposure} / ${j.vts} lines`:"n/a"],["gain",j.ov5640?j.gain_x.toFixed(1)+"x":"n/a"],
["sensor clock",j.ov5640?sys.toFixed(0)+" MHz":"n/a"],["pixel clock",j.ov5640?pc.toFixed(1)+" MHz":"n/a"]];
document.getElementById("sp").innerHTML=st.map(([a,b])=>`<div class="st"><span class="k">${a}</span><b>${b}</b></div>`).join("");
let h;if(!j.ov5640)h=`Sensor PID 0x${j.pid.toString(16)} is not an OV5640: only XCLK and JPEG quality apply.`;
else if(j.sensor_fps>=24.5)h="The sensor keeps up with 24 fps.";
else if(j.exposure>=j.vts-8)h="Exposure is stretching frames: each frame is held open longer than its "+j.vts+" lines. Lower max exposure to "+j.vts+" or below, or add light.";
else h="Exposure fits in the frame, so the sensor clock is the limit: raise the PLL multiplier or XCLK.";
document.getElementById("hint").textContent=h;
document.getElementById("c2").textContent=`#define CAM_XCLK_HZ        ${j.xclk}000000\n#define CAM_PLL_MUL        ${j.mul}\n#define CAM_PCLK_DIV       ${j.pclk}\n#define CAM_MAX_EXP        ${j.maxexp}\n#define CAM_BAND           ${j.band}\n#define CAM_JPEG_Q         ${j.q}`}
function spoll(){(sweeping?Promise.resolve():fetch("/admin/speed").then(r=>r.json()).then(showSpeed)).catch(()=>{}).finally(()=>setTimeout(spoll,1000))}
const wait=ms=>new Promise(r=>setTimeout(r,ms));let rows=[];
const CLK=[{xclk:20,mul:200},{xclk:24,mul:200},{xclk:20,mul:240}],EXP=[984,744,600,450];
document.getElementById("sw").onclick=async()=>{const b=document.getElementById("sw");b.disabled=true;sweeping=true;
const keep=`xclk=${sp.xclk}&mul=${sp.mul}&pclk=${sp.pclk}&maxexp=${sp.maxexp}&band=${sp.band}&q=${sp.q}`;rows=[];let n=0;
for(const c of CLK)for(const e of EXP){n++;document.getElementById("swk").textContent=`Testing ${n} of ${CLK.length*EXP.length}...`;
const q=`xclk=${c.xclk}&mul=${c.mul}&pclk=${eff("pclk",sp.pclk)}&maxexp=${e}&band=${sp.band}&q=${sp.q}`;
try{await fetch("/admin/speed?"+q);await wait(2600);const j=await (await fetch("/admin/speed")).json();rows.push({q,c,e,j})}catch(_){rows.push({q,c,e,j:null})}
drawRows()}
await setSpeed(keep);sweeping=false;b.disabled=false;
document.getElementById("swk").textContent="Done, settings put back. Green = fastest row that is still at least 80% as bright as the brightest. Tap a row to use it."};
function drawRows(){const ok=rows.filter(r=>r.j&&r.j.sensor_fps>1),maxL=Math.max(1,...ok.map(r=>r.j.luma));
const good=ok.filter(r=>r.j.luma>=0.8*maxL).sort((a,b)=>b.j.sensor_fps-a.j.sensor_fps)[0];
document.getElementById("res").innerHTML=`<tr><th>XCLK / PLL</th><th>max exp</th><th>fps</th><th>bright</th><th>KB</th><th>exp / frame</th></tr>`+
rows.map((r,i)=>`<tr data-i="${i}" class="${r===good?"best":""}"><td>${r.c.xclk} MHz x${r.c.mul}</td><td>${r.e}</td>`+
(r.j&&r.j.sensor_fps>1?`<td>${r.j.sensor_fps.toFixed(1)}</td><td>${r.j.luma}</td><td>${r.j.frame_kb.toFixed(0)}</td><td>${r.j.exposure} / ${r.j.vts}</td>`:`<td colspan="4">no frames</td>`)+`</tr>`).join("");
document.querySelectorAll("#res tr[data-i]").forEach(t=>t.onclick=()=>{if(!sweeping)setSpeed(rows[+t.dataset.i].q)})}
poll();next();spoll();
</script></body></html>)HTML";
