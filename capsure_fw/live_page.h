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
code{background:#20242c;padding:8px;border-radius:6px;display:block;font-size:12px;overflow-x:auto;white-space:pre}
</style></head><body><main>
<img id="v" alt="camera">
<div class="bar"><span id="t" class="pill off">-</span><span id="r" class="pill off">-</span>
<span class="k" id="g">-</span><span class="k" id="fps"></span></div>
<div id="s"></div>
<div class="k">Copy into capsure_fw.ino once it looks right:</div><code id="c"></code>
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
poll();next();
</script></body></html>)HTML";
