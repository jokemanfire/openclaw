export function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Memory Dashboard</title>
<style>
:root {
--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#c9d1d9;--text-muted:#8b949e;
--accent:#58a6ff;--green:#3fb950;--yellow:#d29922;--red:#f85149;--purple:#a371f7;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);padding:16px;min-width:800px}
h1{font-size:18px;margin-bottom:4px;color:var(--accent)}
.sub{font-size:12px;color:var(--yellow);margin-bottom:16px;min-height:18px}
h2{font-size:14px;margin:20px 0 8px;color:var(--text-muted);display:flex;align-items:center;gap:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-bottom:14px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px}
.card-label{font-size:10px;color:var(--text-muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.4px}
.card-value{font-size:18px;font-weight:600}
.gauges{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.gauge-row{display:flex;align-items:center;gap:6px}
.gauge-label{width:105px;font-size:11px;color:var(--text-muted);flex-shrink:0}
.gauge-bar{flex:1;height:8px;background:var(--border);border-radius:2px;overflow:hidden}
.gauge-fill{height:100%;border-radius:2px;transition:width .3s}
.gauge-fill.rss{background:var(--accent)}.gauge-fill.heap{background:var(--green)}
.gauge-value{width:90px;font-size:10px;text-align:right;flex-shrink:0}
.legend{display:flex;gap:14px;margin-bottom:6px;font-size:11px}
.legend-item{display:flex;align-items:center;gap:4px}
.legend-swatch{width:10px;height:10px;border-radius:2px}
.alerts{margin-top:6px}
.alert-row{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;border-bottom:1px solid var(--border)}
.alert-level{padding:1px 5px;border-radius:2px;font-size:9px;font-weight:600;text-transform:uppercase}
.alert-level.warning{background:rgba(210,153,34,.15);color:var(--yellow)}
.alert-level.critical{background:rgba(248,81,73,.15);color:var(--red)}.alert-ts{color:var(--text-muted)}
.refresh{font-size:10px;color:var(--text-muted);margin-top:10px}
.heap-spaces{margin-top:10px}
.heap-space-row{display:flex;gap:6px;padding:2px 0;font-size:10px;align-items:center}
.heap-space-name{width:125px;color:var(--text-muted);flex-shrink:0}
.heap-space-bar{flex:1;height:5px;background:var(--border);border-radius:2px;overflow:hidden}
.heap-space-fill{height:100%;border-radius:2px}
.heap-space-val{width:80px;text-align:right;flex-shrink:0}
.chart-wrap{position:relative;margin-bottom:14px}
/* heap objs + smaps table */
.obj-table{width:100%;border-collapse:collapse;font-size:10px}
.obj-table th{text-align:left;padding:3px 8px;color:var(--text-muted);font-weight:500;border-bottom:1px solid var(--border);font-size:9px;text-transform:uppercase}
.obj-table td{padding:2px 8px;border-bottom:1px solid var(--border);white-space:nowrap}
.obj-table tr:hover{background:rgba(88,166,255,.04)}
.obj-name{max-width:400px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:middle}
.obj-num{text-align:right;font-family:'SF Mono',Consolas,monospace;font-size:10px}
.smaps-table{width:100%;border-collapse:collapse;font-size:11px}
.smaps-table th{text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:500;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase}
.smaps-table td{padding:2px 8px;border-bottom:1px solid var(--border);white-space:nowrap}
.smaps-table tr:hover{background:rgba(88,166,255,.04)}
.smaps-path{max-width:360px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:middle}
.smaps-num{text-align:right;font-family:'SF Mono',Consolas,monospace;font-size:10px}
.btn{display:inline-block;padding:4px 12px;font-size:11px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--accent);cursor:pointer;margin-right:6px}
.btn:hover{background:#1f2937}
.btn:disabled{opacity:.5;cursor:not-allowed}
.toast{position:fixed;bottom:16px;right:16px;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 14px;font-size:12px;z-index:10;max-width:320px}
.filter-row{display:flex;gap:6px;margin-bottom:6px}
.filter-input{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:11px;color:var(--text);outline:none}
.filter-input:focus{border-color:var(--accent)}
.smaps-wrap,.obj-wrap{max-height:500px;overflow-y:auto;border:1px solid var(--border);border-radius:6px}
/* flame graph */
.fg-container{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden;min-height:200px}
.fg-svg{display:block;width:100%}
.fg-tooltip{position:absolute;background:#1a1a2e;border:1px solid var(--accent);border-radius:4px;padding:6px 10px;font-size:11px;color:var(--text);pointer-events:none;z-index:10;max-width:500px;white-space:nowrap;display:none}
.fg-search-bar{display:flex;gap:6px;margin-bottom:8px;align-items:center}
.fg-zoom-bar{font-size:10px;color:var(--text-muted);margin-bottom:6px;min-height:18px}
.fg-zoom-link{color:var(--accent);cursor:pointer;text-decoration:underline}
.fg-zoom-link:hover{color:#fff}
</style>
</head>
<body>
<h1>Memory Dashboard</h1>
<div class="sub" id="subtitle">Connecting...</div>
<div class="grid" id="gauges"></div>
<div class="gauges" id="gauges2"></div>

<h2>Growth Rate</h2>
<div class="grid" id="growthRates"></div>

<h2>OS Memory (proc/self/status)</h2>
<div class="grid" id="procStatus"></div>

<h2>Smaps Rollup</h2>
<div class="grid" id="smapsRollup"></div>

<h2>V8 Contexts & Global Handles</h2>
<div class="grid" id="contexts"></div>

<h2>Event Loop</h2>
<div class="grid" id="eventLoop"></div>

<h2>Active Resources (Node handles/requests)</h2>
<div id="activeResources"></div>

<h2>Heap Spaces</h2>
<div class="heap-spaces" id="heapSpaces"></div>

<h2>V8 C++ Heap (Embedder)</h2>
<div class="grid" id="cppHeapCards"></div>
<div class="gauges" id="cppHeapGauges"></div>
<div id="cppHeapSpaces"></div>

<h2>Memory Usage Over Time</h2>
<div class="legend"><div class="legend-item"><div class="legend-swatch" style="background:var(--accent)"></div>RSS</div><div class="legend-item"><div class="legend-swatch" style="background:var(--green)"></div>Heap Used</div><div class="legend-item"><div class="legend-swatch" style="background:var(--yellow)"></div>Heap Total</div></div>
<div class="chart-wrap"><div id="chart" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;height:240px;position:relative;overflow:hidden"></div></div>

<h2>Heap Space Trends (old_space vs new_space, 10 min)</h2>
<div class="chart-wrap"><div id="spaceChart" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;height:180px;position:relative;overflow:hidden"></div></div>

<h2>GC Events <span style="font-size:10px;color:var(--text-muted);font-weight:400" id="gcSummary"></span></h2>
<div class="alerts" id="gcEvents"></div>

<h2>Heap Objects<button class="btn" id="btnSnapshot" onclick="takeSnapshot()" style="margin-left:auto;font-size:10px">Take Heap Snapshot + Analyze</button></h2>
<div class="filter-row"><input class="filter-input" id="objFilter" placeholder="Filter by class name..." oninput="renderObj()"></div>
<div class="obj-wrap"><table class="obj-table" id="objTable"></table></div>

<h2>Process Memory Mappings (smaps)<button class="btn" id="btnSmaps" onclick="loadSmaps()" style="margin-left:auto;font-size:10px">Refresh</button></h2>
<div class="filter-row"><input class="filter-input" id="smapsFilter" placeholder="Filter by path..." oninput="renderSmaps()"></div>
<div class="smaps-wrap"><table class="smaps-table" id="smapsTable"></table></div>

<h2>Allocation Flame Graph<button class="btn" id="btnHeapStart" onclick="startHeapProfile()" style="margin-left:auto;font-size:10px;min-width:110px">Start Sampling</button><button class="btn" id="btnHeapStop" onclick="stopHeapProfile()" style="font-size:10px;display:none;min-width:110px">Stop &amp; Analyze</button><span style="font-size:9px;color:var(--yellow);margin-left:6px;display:none" id="heapProfilingLabel">Sampling allocations...</span></h2>
<div style="font-size:10px;color:var(--text-muted);margin-bottom:6px">Uses V8 allocation sampling via inspector HeapProfiler — tracks where objects are allocated on the heap, similar to heapprofd / perfetto memory profiling.</div>
<div class="fg-search-bar"><input class="filter-input" id="fgSearch" placeholder="Search function..." oninput="fgSearch()"><span style="font-size:10px;color:var(--text-muted)" id="fgStats"></span></div>
<div class="fg-zoom-bar" id="fgZoomBar"></div>
<div class="fg-container" id="fgContainer"><div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--text-muted);font-size:12px" id="fgEmpty">Click "Start Sampling" to begin tracking heap allocations, then "Stop &amp; Analyze" to view the allocation flame graph</div><svg class="fg-svg" id="fgSvg" style="display:none"></svg><div class="fg-tooltip" id="fgTooltip"></div></div>

<h2>Pressure Alerts</h2>
<div class="alerts" id="alerts"></div>
<div class="refresh" id="refresh"></div>
<div class="toast" id="toast" style="display:none"></div>

<script>
var hist=[],alerts=[],heapSpaces=[],smapsData=[],objData=[],gcEventList=[],spaceHist=[],procStatusData=null,smapsRollupData=null,growthRatesData=null,lastCurrent=null;
function fmt(b){if(b>=1073741824)return(b/1073741824).toFixed(1)+' GB';if(b>=1048576)return(b/1048576).toFixed(1)+' MB';if(b>=1024)return(b/1024).toFixed(1)+' KB';return b+' B'}
function ut(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);if(h)return h+'h'+(m%60)+'m'+(s%60)+'s';if(m)return m+'m'+(s%60)+'s';return s+'s'}
function cu(us){return(us/1000).toFixed(0)+'ms'}

var smapsLoaded=false;
async function loadSmaps(){try{var r=await fetch('/api/memory-dashboard/smaps');if(r.ok){smapsData=await r.json();smapsLoaded=true;renderSmaps();showToast('smaps refreshed')}}catch(e){}}
function renderSmaps(){
  var f=document.getElementById('smapsFilter').value.toLowerCase();
  var rows=smapsData.filter(function(r){return!f||r.path.toLowerCase().indexOf(f)>=0});
  var t='<tr><th>Mapping</th><th class="smaps-num">RSS</th><th class="smaps-num">PSS</th><th class="smaps-num">Private</th><th class="smaps-num">Shared</th><th class="smaps-num">VSS</th><th class="smaps-num">Regions</th></tr>';
  var totalRss=0;
  for(var i=0;i<rows.length;i++){
    var r=rows[i],p=r.path;if(p==='[heap]')p='<b style=color:#f85149>[heap]</b>';else if(p==='[stack]')p='<b style=color:#d29922>[stack]</b>';else if(p==='[anonymous]')p='<i>[anon]</i>';
    else{var lastSlash=p.lastIndexOf('/');p='<span class=smaps-path title="'+p.replace(/&/g,'&amp;')+'">'+(lastSlash>=0?p.slice(lastSlash+1):p)+'</span>'}
    totalRss+=r.rss;
    t+='<tr><td>'+p+'</td><td class=smaps-num>'+fmt(r.rss)+'</td><td class=smaps-num>'+fmt(r.pss||0)+'</td><td class=smaps-num>'+fmt(r.privateClean+r.privateDirty)+'</td><td class=smaps-num>'+fmt(r.sharedClean+r.sharedDirty)+'</td><td class=smaps-num>'+fmt(r.vss)+'</td><td class=smaps-num>'+r.regionCount+'</td></tr>';
  }
  t+='<tr style=font-weight:600;border-top:2px solid var(--border)><td>Total mapped RSS</td><td class=smaps-num>'+fmt(totalRss)+'</td><td colspan=5></td></tr>';
  document.getElementById('smapsTable').innerHTML=t;
}

function renderObj(){
  var f=document.getElementById('objFilter').value.toLowerCase();
  var rows=objData.filter(function(r){return!f||r.name.toLowerCase().indexOf(f)>=0});
  var totalSz=0;
  for(var i=0;i<rows.length;i++)totalSz+=rows[i].shallowSize;
  var t='<tr><th>Class / Constructor</th><th class=obj-num>Count</th><th class=obj-num>Shallow</th><th class=obj-num>%</th></tr>';
  for(var i=0;i<rows.length;i++){
    var r=rows[i],pct=totalSz>0?(r.shallowSize/totalSz*100).toFixed(1):'0';
    t+='<tr><td><span class=obj-name title="'+r.name+'">'+r.name+'</span></td><td class=obj-num>'+r.count.toLocaleString()+'</td><td class=obj-num>'+fmt(r.shallowSize)+'</td><td class=obj-num>'+pct+' %</td></tr>';
  }
  if(rows.length===0)t+='<tr><td colspan=4 style=color:var(--text-muted);padding:20px;text-align:center>No heap snapshot yet. Click "Take Heap Snapshot + Analyze" above.</td></tr>';
  else t+='<tr style=font-weight:600;border-top:2px solid var(--border)><td>Total shallow</td><td class=obj-num></td><td class=obj-num>'+fmt(totalSz)+'</td><td class=obj-num>100 %</td></tr>';
  document.getElementById('objTable').innerHTML=t;
}

async function fetchData(){
  var ok=false,errMsg='';
  try{var r=await fetch('/api/memory-dashboard/data');
    if(r.ok){var d=await r.json();hist=d.hist||[];alerts=(d.alerts||[]).slice(-20);
      heapSpaces=d.heapSpaces||[];
      gcEventList=(d.gcEvents||[]).slice(-50);
      procStatusData=d.procStatus||null;
      smapsRollupData=d.smapsRollup||null;
      growthRatesData=d.growthRates||null;
      spaceHist=d.spaceHistory||[];
      if(d.heapObjs&&d.heapObjs.length>0){objData=d.heapObjs;renderObj()}
      updateUi(d);ok=true;
      if(!smapsLoaded){loadSmaps();smapsLoaded=true}
    }else{errMsg='HTTP '+r.status}
  }catch(e){errMsg=e.message||String(e)}
  if(!ok){document.getElementById('subtitle').textContent=errMsg||'Fetch failed'}}
function updateUi(d){
  var s=d.current;if(!s)return;
  lastCurrent=s;
  var c=s.code||{};
  document.getElementById('subtitle').textContent='Uptime: '+ut(s.uptime)+' | Source Maps: '+(d.sourceMaps?'ENABLED':'DISABLED')+' | Node: '+d.nodeVersion+(d.snapshotPath?' | Snapshot: '+d.snapshotPath:'');
  document.getElementById('gauges').innerHTML=[{l:'RSS',v:s.rss,c:'var(--accent)'},{l:'Heap Used',v:s.heapUsed,c:'var(--green)'},{l:'Heap Total',v:s.heapTotal,c:'var(--yellow)'},{l:'External',v:s.external,c:'var(--text-muted)'},{l:'ArrayBuffers',v:s.arrayBuffers,c:'var(--text-muted)'},{l:'Malloced',v:s.mallocedMemory,c:'var(--text-muted)'},{l:'Native Ctx',v:s.nativeContexts||0,c:'var(--text-muted)',t:true},{l:'Detached Ctx',v:s.detachedContexts||0,c:s.detachedContexts>0?'var(--red)':'var(--green)',t:true},{l:'Code+Meta',v:c.codeAndMetadataSize||0,c:'var(--purple)'},{l:'CPU User',v:c.cpuUser||0,c:'var(--text-muted)',t2:true},{l:'CPU Sys',v:c.cpuSystem||0,c:'var(--text-muted)',t2:true}].map(function(g){var v=g.t2?cu(g.v):g.t?g.v.toLocaleString():fmt(g.v);return'<div class=card><div class=card-label>'+g.l+'</div><div class=card-value style=color:'+(g.c||'var(--text)')+'>'+v+'</div></div>'}).join('');
  var mx=s.heapSizeLimit||s.rss*2;
  document.getElementById('gauges2').innerHTML=[{l:'RSS',v:s.rss,max:mx,cls:'rss'},{l:'Heap Used',v:s.heapUsed,max:s.heapTotal||s.totalHeapSize||1,cls:'heap'},{l:'Heap Total',v:s.heapTotal,max:s.heapSizeLimit||s.heapTotal*1.5||1,cls:'heap'}].map(function(g){var p=Math.min(100,Math.round(g.v/g.max*100));return'<div class=gauge-row><span class=gauge-label>'+g.l+'</span><div class=gauge-bar><div class="gauge-fill '+g.cls+'" style=width:'+p+'%></div></div><span class=gauge-value>'+fmt(g.v)+' ('+p+'%)</span></div>'}).join('');
  var sc=['#58a6ff','#3fb950','#d29922','#f85149','#a371f7','#79c0ff','#56d364','#e3b341','#ff7b72','#d2a8ff'];
  document.getElementById('heapSpaces').innerHTML=heapSpaces.map(function(sp,i){var p=sp.size>0?Math.round(sp.used/sp.size*100):0;return'<div class=heap-space-row><span class=heap-space-name>'+sp.name+'</span><div class=heap-space-bar><div class=heap-space-fill style=width:'+p+'%;background:'+sc[i%sc.length]+'></div></div><span class=heap-space-val>'+fmt(sp.used)+' / '+fmt(sp.size)+'</span></div>'}).join('');
  document.getElementById('alerts').innerHTML=alerts.length===0?'<div style=color:var(--text-muted);font-size:11px;padding:3px 0>None</div>':alerts.map(function(a){return'<div class=alert-row><span class="alert-level '+a.level+'">'+a.level+'</span><span>'+a.reason+'</span><span class=alert-ts>'+new Date(a.ts).toLocaleTimeString()+'</span></div>'}).join('');
  renderGrowthRates();
  renderProcStatus();
  renderSmapsRollup();
  renderGcEvents();
  renderContexts();
  renderEventLoop();
  renderActiveResources();
  renderCppHeap();
  drawChart(hist);
  drawSpaceChart();
  document.getElementById('refresh').textContent='Updated: '+new Date().toLocaleTimeString()+' | 1s poll';
  updateHeapStatus(d);
}
function grate(bs){if(bs===0)return'0 B/s';var sign=bs>=0?'+':'';if(Math.abs(bs)>=1048576)return sign+(bs/1048576).toFixed(1)+' MB/s';if(Math.abs(bs)>=1024)return sign+(bs/1024).toFixed(1)+' KB/s';return sign+bs.toFixed(0)+' B/s'}
function renderGrowthRates(){
  if(!growthRatesData)return;
  document.getElementById('growthRates').innerHTML=[
    {l:'RSS (15s)',v:growthRatesData.rssInstant,c:growthRatesData.rssInstant>0?'var(--red)':'var(--green)'},
    {l:'RSS (1m)',v:growthRatesData.rss1m,c:growthRatesData.rss1m>0?'var(--red)':'var(--green)'},
    {l:'RSS (5m)',v:growthRatesData.rss5m,c:growthRatesData.rss5m>0?'var(--red)':'var(--green)'},
    {l:'Heap (15s)',v:growthRatesData.heapInstant,c:growthRatesData.heapInstant>0?'var(--red)':'var(--green)'},
    {l:'Heap (1m)',v:growthRatesData.heap1m,c:growthRatesData.heap1m>0?'var(--red)':'var(--green)'},
    {l:'Heap (5m)',v:growthRatesData.heap5m,c:growthRatesData.heap5m>0?'var(--red)':'var(--green)'}
  ].map(function(g){return'<div class=card><div class=card-label>'+g.l+'</div><div class=card-value style=color:'+g.c+'>'+grate(g.v)+'</div></div>'}).join('');
}
function renderProcStatus(){
  var p=procStatusData;if(!p){document.getElementById('procStatus').innerHTML='<div style=color:var(--text-muted);font-size:11px>/proc/self/status unavailable</div>';return}
  document.getElementById('procStatus').innerHTML=[
    {l:'VmPeak',v:p.vmPeak},{l:'VmHWM',v:p.vmHWM},{l:'VmRSS',v:p.vmRSS},
    {l:'RssAnon',v:p.rssAnon},{l:'RssFile',v:p.rssFile},{l:'RssShmem',v:p.rssShmem},
    {l:'VmData',v:p.vmData},{l:'VmStk',v:p.vmStk},{l:'Threads',v:p.threads,t:true}
  ].map(function(g){var v=g.t?g.v.toLocaleString():fmt(g.v);return'<div class=card><div class=card-label>'+g.l+'</div><div class=card-value style=color:var(--text)>'+v+'</div></div>'}).join('');
}
function renderSmapsRollup(){
  var r=smapsRollupData;if(!r){document.getElementById('smapsRollup').innerHTML='<div style=color:var(--text-muted);font-size:11px>smaps_rollup unavailable</div>';return}
  document.getElementById('smapsRollup').innerHTML=[
    {l:'Total RSS',v:r.rss},{l:'Total PSS',v:r.pss},{l:'Anonymous',v:r.anonymous},
    {l:'File-backed',v:r.fileBacked||(r.rss-r.anonymous)},{l:'Private',v:r.privateClean+r.privateDirty},{l:'Shared',v:r.sharedClean+r.sharedDirty}
  ].map(function(g){return'<div class=card><div class=card-label>'+g.l+'</div><div class=card-value style=color:var(--text)>'+fmt(g.v)+'</div></div>'}).join('');
}
function renderGcEvents(){
  var list=gcEventList||[];
  document.getElementById('gcSummary').textContent=gcEventList.length+' events';
  if(list.length===0){document.getElementById('gcEvents').innerHTML='<div style=color:var(--text-muted);font-size:11px;padding:3px 0>No GC events captured (enable with --expose-gc or use Node ≥16)</div>';return}
  var sc={'major':'var(--red)','minor':'var(--green)','incremental':'var(--yellow)','weakcb':'var(--purple)'};
  document.getElementById('gcEvents').innerHTML=list.slice(-30).reverse().map(function(g){
    return'<div class=alert-row><span class=alert-level style=background:rgba(136,166,255,.1);color:'+(sc[g.kind]||'var(--text-muted)')+'>'+g.kind+'</span><span>'+cu(g.duration)+'</span><span class=alert-ts>'+new Date(g.ts).toLocaleTimeString()+'</span></div>'
  }).join('');
}
function renderContexts(){
  var s=typeof lastCurrent!=='undefined'?lastCurrent:null;if(!s){document.getElementById('contexts').innerHTML='<div style=color:var(--text-muted);font-size:11px>Waiting for data...</div>';return}
  var d=s.detachedContexts||0;
  document.getElementById('contexts').innerHTML=[
    {l:'Native Contexts',v:s.nativeContexts||0,t:true},
    {l:'Detached Contexts',v:d,t:true,c:d>0?'var(--red)':'var(--green)'},
    {l:'Global Handles',v:s.globalHandlesSize||0},
    {l:'Used Handles',v:s.usedGlobalHandlesSize||0}
  ].map(function(g){var v=g.t?g.v.toLocaleString():fmt(g.v);return'<div class=card><div class=card-label>'+g.l+'</div><div class=card-value style=color:'+(g.c||'var(--text)')+'>'+v+'</div></div>'}).join('');
}
function renderEventLoop(){
  var s=typeof lastCurrent!=='undefined'?lastCurrent:null;
  var eluId='eventLoop';
  if(!s){document.getElementById(eluId).innerHTML='<div style=color:var(--text-muted);font-size:11px>Waiting for data...</div>';return}
  var util=s.eventLoopUtilization||0;
  document.getElementById(eluId).innerHTML=[
    {l:'Utilization',v:util,t:true,f:function(){return(util*100).toFixed(2)+' %'},c:util>0.8?'var(--red)':util>0.5?'var(--yellow)':'var(--green)'},
    {l:'Active (ms/s)',v:s.eventLoopActive||0,f:function(v){return v.toFixed(0)+' ms'}},
    {l:'Idle (ms/s)',v:s.eventLoopIdle||0,f:function(v){return v.toFixed(0)+' ms'}},
    {l:'Total (ms/s)',v:(s.eventLoopActive||0)+(s.eventLoopIdle||0),f:function(v){return v.toFixed(0)+' ms'}}
  ].map(function(g){return'<div class=card><div class=card-label>'+g.l+'</div><div class=card-value style=color:'+(g.c||'var(--text)')+'>'+(g.f?g.f(g.v):g.t?g.v.toLocaleString():fmt(g.v))+'</div></div>'}).join('');
}
function renderActiveResources(){
  var s=typeof lastCurrent!=='undefined'?lastCurrent:null;
  var arr=s&&s.activeResources?s.activeResources:[];
  var el=document.getElementById('activeResources');
  if(arr.length===0){el.innerHTML='<div style=color:var(--text-muted);font-size:11px;padding:3px 0'+(s?'':'')+'>'+(s?'None (or Node < 17.9)':'Waiting for data...')+'</div>';return}
  var counts={};for(var i=0;i<arr.length;i++){var t=arr[i];counts[t]=(counts[t]||0)+1}
  var items=Object.keys(counts).sort();var total=arr.length;
  el.innerHTML='<div style=display:flex;flex-wrap:wrap;gap:6px;margin-top:6px>'+
    items.map(function(k){var n=counts[k];var bad=n>100?'var(--red)':n>20?'var(--yellow)':'var(--text-muted)';
      return'<div class=card style=min-width:120px><div class=card-label>'+k+'</div><div class=card-value style=font-size:14px;color:'+bad+'>'+n.toLocaleString()+'</div></div>'}).join('')+
    '<div class=card style=min-width:80px><div class=card-label>Total Types</div><div class=card-value style=font-size:14px>'+items.length.toLocaleString()+'</div></div>'+
    '<div class=card style=min-width:80px><div class=card-label>Total Handles</div><div class=card-value style=font-size:14px;color:'+(total>500?'var(--red)':total>100?'var(--yellow)':'var(--text)')+'>'+total.toLocaleString()+'</div></div>'+
  '</div>';
}
function renderCppHeap(){
  var s=typeof lastCurrent!=='undefined'?lastCurrent:null;
  var cpp=s&&s.cppHeap?s.cppHeap:null;
  if(!cpp){document.getElementById('cppHeapCards').innerHTML='<div style=color:var(--text-muted);font-size:11px>Waiting for data...</div>';document.getElementById('cppHeapGauges').innerHTML='';document.getElementById('cppHeapSpaces').innerHTML='';return}
  var cmt=cpp.committed_size_bytes||0,res=cpp.resident_size_bytes||0,used=cpp.used_size_bytes||0;
  document.getElementById('cppHeapCards').innerHTML=[
    {l:'Committed',v:cmt},{l:'Resident',v:res},{l:'Used',v:used},{l:'Detail Level',v:cpp.detail_level||'?',t:true}
  ].map(function(g){return'<div class=card><div class=card-label>'+g.l+'</div><div class=card-value style=color:var(--text)>'+(g.t?g.v:fmt(g.v))+'</div></div>'}).join('');
  var mx=cmt||1;
  document.getElementById('cppHeapGauges').innerHTML=[
    {l:'Used / Committed',v:used,max:mx,cls:'heap'},{l:'Resident / Committed',v:res,max:mx,cls:'rss'}
  ].map(function(g){var p=Math.min(100,Math.round(g.v/g.max*100));return'<div class=gauge-row><span class=gauge-label>'+g.l+'</span><div class=gauge-bar><div class="gauge-fill '+g.cls+'" style=width:'+p+'%></div></div><span class=gauge-value>'+fmt(g.v)+' ('+p+'%)</span></div>'}).join('');
  var spaces=cpp.space_statistics;
  if(spaces&&Array.isArray(spaces)&&spaces.length>0){
    var t='<h2 style=margin-top:16px>Space Statistics</h2><div class=smaps-wrap><table class=smaps-table><tr><th>Space</th><th class=smaps-num>Committed</th><th class=smaps-num>Resident</th><th class=smaps-num>Used</th></tr>';
    for(var i=0;i<spaces.length;i++){
      var sp=spaces[i];if(!sp||typeof sp!=='object')continue;
      t+='<tr><td style=color:var(--accent)>'+sp.name+'</td><td class=smaps-num>'+fmt(sp.committed_size_bytes||0)+'</td><td class=smaps-num>'+fmt(sp.resident_size_bytes||0)+'</td><td class=smaps-num>'+fmt(sp.used_size_bytes||0)+'</td></tr>';
    }
    t+='</table></div>';
    document.getElementById('cppHeapSpaces').innerHTML=t;
  }else{document.getElementById('cppHeapSpaces').innerHTML=''}
}
function drawSpaceChart(){
  var el=document.getElementById('spaceChart');if(!el||!spaceHist||spaceHist.length<2){el&&(el.innerHTML='<div style=display:flex;align-items:center;justify-content:center;height:100%;color:#8b949e;font-size:12px>Waiting for space history data...</div>');return}
  var spaces={};for(var i=0;i<spaceHist.length;i++){var sp=spaceHist[i].spaces;for(var j=0;j<sp.length;j++){var n=sp[j].name;if(!spaces[n])spaces[n]=[];spaces[n].push({ts:spaceHist[i].ts,used:sp[j].used})}}
  var keys=['read_only_space','new_space','old_space','code_space','map_space','large_object_space','new_large_object_space'];
  var sc={read_only_space:'#8b949e',new_space:'#3fb950',old_space:'#f85149',code_space:'#a371f7',map_space:'#d29922',large_object_space:'#79c0ff',new_large_object_space:'#56d364'};
  var maxV=0;var allData=[];for(var k=0;k<keys.length;k++){var s=spaces[keys[k]];if(s)for(var i=0;i<s.length;i++)if(s[i].used>maxV)maxV=s[i].used;allData.push({name:keys[k],data:s||[]})}
  if(maxV===0)maxV=1;maxV*=1.05;var n=spaceHist.length;var barW=Math.max(3,Math.floor(800/n));var html='';
  for(var i=0;i<n;i++){var x=Math.floor(i*barW);
    var ly=0;
    for(var k=0;k<allData.length;k++){var d2=allData[k];if(i>=d2.data.length)continue;var h2=Math.max(1,Math.round(d2.data[i].used/maxV*170));html+='<div style=position:absolute;left:'+x+'px;bottom:'+ly+'px;width:'+(barW-1)+'px;height:'+h2+'px;background:'+(sc[d2.name]||'#8b949e')+';opacity:.7></div>';ly+=h2}
  }
  html+='<div style=position:absolute;left:4px;top:4px;color:#8b949e;font-size:9px>'+fmt(maxV)+'</div><div style=position:absolute;left:4px;bottom:4px;color:#8b949e;font-size:9px>0</div>';
  var leg='';for(var k=0;k<keys.length;k++)leg+='<div class=legend-item><div class=legend-swatch style=background:'+(sc[keys[k]]||'#8b949e')+'></div>'+keys[k]+'</div>';
  html+='<div style=position:absolute;right:4px;top:4px;font-size:8px;color:#8b949e;text-align:right>'+leg+'<br>'+n+' samples</div>';
  el.innerHTML=html;
}
function drawChart(h){
  var el=document.getElementById('chart');if(!el)return;
  if(!h||h.length<2){el.innerHTML='<div style=display:flex;align-items:center;justify-content:center;height:100%;color:#8b949e;font-size:12px>Waiting for data... ('+(h?h.length:0)+' points)</div>';return}
  var maxSamples=400;
  var win=h.length>maxSamples?h.slice(-maxSamples):h;
  var maxV=0;for(var i=0;i<win.length;i++){if(!win[i])continue;if(win[i].rss>maxV)maxV=win[i].rss;if(win[i].heapTotal>maxV)maxV=win[i].heapTotal}
  if(maxV===0){maxV=1}
  maxV*=1.05;var barW=Math.max(2,Math.floor(800/win.length));var html='';
  for(var i=0;i<win.length;i++){if(!win[i])continue;
    var x=Math.floor(i*barW),rH=Math.max(1,Math.round(win[i].rss/maxV*230)),uH=Math.max(1,Math.round(win[i].heapUsed/maxV*230)),tH=Math.max(1,Math.round(win[i].heapTotal/maxV*230));
    html+='<div style=position:absolute;left:'+x+'px;bottom:0;width:'+(barW-1)+'px;height:'+tH+'px;background:rgba(210,153,34,.15)></div>';
    html+='<div style=position:absolute;left:'+x+'px;bottom:0;width:'+(barW-1)+'px;height:'+uH+'px;background:rgba(63,185,80,.4)></div>';
    html+='<div style=position:absolute;left:'+x+'px;bottom:0;width:'+(barW-1)+'px;height:'+rH+'px;background:rgba(88,166,255,.6)></div>';
  }
  html+='<div style=position:absolute;left:4px;top:4px;color:#8b949e;font-size:9px>'+fmt(maxV)+'</div><div style=position:absolute;left:4px;bottom:4px;color:#8b949e;font-size:9px>0</div><div style=position:absolute;right:4px;bottom:4px;color:#8b949e;font-size:9px>'+h.length+' samples ('+win.length+' shown)</div>';
  el.innerHTML=html;
}
function showToast(msg){var t=document.getElementById('toast');t.textContent=msg;t.style.display='block';clearTimeout(t._tid);t._tid=setTimeout(function(){t.style.display='none'},3000)}
async function takeSnapshot(){
  var btn=document.getElementById('btnSnapshot');btn.disabled=true;btn.textContent='Taking...';
  try{
    var r=await fetch('/api/memory-dashboard/snapshot',{method:'POST'});
    if(r.ok){var d=await r.json();if(d.objs){objData=d.objs;renderObj()}showToast('Snapshot: '+d.path+(d.objs?' (+'+d.objs.length+' classes)':''))}
    else{showToast('Failed: '+r.status)}
  }catch(e){showToast('Error: '+e)}
  btn.disabled=false;btn.textContent='Take Heap Snapshot + Analyze';
}
var heapProfileData=null,heapProfiling=false,fgZoomNode=null,fgSearchTerm='',fgColorCache={},fgFontWidth=6.2;
function fgScriptColor(url,depth){var m=url.replace(/^.*[\\/]/,'');if(!m)m='(native)';var k=m+'|'+depth;if(fgColorCache[k])return fgColorCache[k];var h=0;for(var i=0;i<m.length;i++)h=((h<<5)-h)+m.charCodeAt(i);var hue=(Math.abs(h)%30)*12,sat=55+(depth%3)*8,lit=48+(depth%4)*6;fgColorCache[k]='hsl('+hue+','+sat+'%,'+lit+'%)';return fgColorCache[k]}
function fgShortName(n){var f=n.callFrame;return(f.functionName||'(anonymous)')}
function fgFullName(n){var f=n.callFrame;var url=f.url||'';var file=url.replace(/^.*[\\/]/,'');var line=f.lineNumber||0;return(f.functionName||'(anonymous)')+' @ '+(file||'(native)')+':'+line}
function fgTotalSize(n){var t=n.selfSize||0;if(n.children){for(var i=0;i<n.children.length;i++)t+=fgTotalSize(n.children[i])}return t}
function fgMaxDepth(n,d){var max=d;if(n.children){for(var i=0;i<n.children.length;i++){var cd=fgMaxDepth(n.children[i],d+1);if(cd>max)max=cd}}return max}
function fgRenderNode(n,total,x,y,w,depth,rowH,container,svg,tooltip){if(w<0.8||!n)return;var matched=!fgSearchTerm||fgFullName(n).toLowerCase().indexOf(fgSearchTerm.toLowerCase())>=0;var color=matched?fgScriptColor(n.callFrame.url||'',depth):'rgba(80,80,80,0.1)';var rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.setAttribute('x',x.toFixed(1));rect.setAttribute('y',y.toFixed(1));rect.setAttribute('width',Math.max(0.5,w).toFixed(1));rect.setAttribute('height',String(rowH-1));rect.setAttribute('fill',color);rect.setAttribute('rx','1');rect.style.cursor='pointer';var self=n.selfSize||0,totalSz=fgTotalSize(n);(function(n2){rect.addEventListener('click',function(){fgZoomNode=n2;fgRefresh()})})(n);rect.addEventListener('mousemove',function(ev){var cr=container.getBoundingClientRect();tooltip.style.display='block';tooltip.style.left=(ev.clientX-cr.left+14)+'px';tooltip.style.top=(ev.clientY-cr.top-30)+'px';var pct=total>0?(totalSz/total*100).toFixed(2):'0';var spct=total>0?(self/total*100).toFixed(2):'0';tooltip.innerHTML='<b>'+fgShortName(n)+'</b><br><span style=color:#8b949e>'+fgFullName(n)+'</span><br>Total: '+fmt(totalSz)+' ('+pct+'% of all)<br>Self: '+fmt(self)+' ('+spct+'%)'});rect.addEventListener('mouseout',function(){tooltip.style.display='none'});svg.appendChild(rect);var label=fgShortName(n);var maxChars=Math.floor((w-3)/fgFontWidth);if(maxChars>2&&label.length>maxChars)label=label.substring(0,maxChars-1)+'\u2026';if(w>24&&label.length>0){var txt=document.createElementNS('http://www.w3.org/2000/svg','text');txt.setAttribute('x',(x+3).toFixed(1));txt.setAttribute('y',(y+rowH-5).toFixed(1));txt.setAttribute('font-size','10');txt.setAttribute('font-family','-apple-system,BlinkMacSystemFont,sans-serif');txt.setAttribute('fill',matched?'rgba(255,255,255,0.9)':'rgba(255,255,255,0.15)');txt.style.pointerEvents='none';txt.textContent=label;svg.appendChild(txt)}if(n.children&&n.children.length>0&&totalSz>0){var childX=x;var childrenSorted=n.children.slice().sort(function(a,b){return fgTotalSize(b)-fgTotalSize(a)});for(var i=0;i<childrenSorted.length;i++){var child=childrenSorted[i];var childTotal=fgTotalSize(child);var cw=w*childTotal/totalSz;if(cw>=0.5){fgRenderNode(child,total,childX,y+rowH,cw,depth+1,rowH,container,svg,tooltip);childX+=cw}}}}
function fgRefresh(){var el=document.getElementById('fgSvg'),empty=document.getElementById('fgEmpty'),container=document.getElementById('fgContainer'),zoomBar=document.getElementById('fgZoomBar'),stats=document.getElementById('fgStats'),tooltip=document.getElementById('fgTooltip');if(!heapProfileData||!heapProfileData.head){el.style.display='none';empty.style.display='flex';stats.textContent='';zoomBar.innerHTML='';return}el.style.display='block';empty.style.display='none';el.innerHTML='';var root=heapProfileData.head;var displayNode=fgZoomNode||root;var total=fgTotalSize(displayNode);stats.textContent='Total allocated: '+fmt(total)+' | traced by allocation sampling';var rowH=20;var levels=fgMaxDepth(displayNode,0);var h=(levels+1)*rowH+10;el.setAttribute('viewBox','0 0 1200 '+h);el.setAttribute('width','100%');el.setAttribute('height',String(h));el.style.height=h+'px';container.style.height=Math.max(200,h+20)+'px';fgColorCache={};fgRenderNode(displayNode,total,2,3,1192,0,rowH,container,el,tooltip);if(fgZoomNode&&fgZoomNode!==root){zoomBar.innerHTML='<b>Zoomed:</b> '+fgFullName(fgZoomNode)+' (Self: '+fmt(fgZoomNode.selfSize||0)+', Total: '+fmt(fgTotalSize(fgZoomNode))+') | <span class=fg-zoom-link onclick="fgZoomOut()">\u2191 Reset</span>'}else{zoomBar.innerHTML=''}}
async function startHeapProfile(){try{var r=await fetch('/api/memory-dashboard/heap-profile/start',{method:'POST'});var d=await r.json();if(d.ok){heapProfiling=true;document.getElementById('btnHeapStart').style.display='none';document.getElementById('btnHeapStop').style.display='';document.getElementById('heapProfilingLabel').style.display='';showToast('Allocation sampling started — perform memory-heavy operations now')}else{showToast('Inspector not available (start with --inspect)')}}catch(e){showToast('Error: '+e)}}
async function stopHeapProfile(){try{var r=await fetch('/api/memory-dashboard/heap-profile/stop',{method:'POST'});var d=await r.json();heapProfiling=false;document.getElementById('btnHeapStart').style.display='';document.getElementById('btnHeapStop').style.display='none';document.getElementById('heapProfilingLabel').style.display='none';if(d.ok&&d.profile&&d.profile.head){heapProfileData=d.profile;fgZoomNode=null;fgRefresh();showToast('Profile captured — '+fmt(fgTotalSize(heapProfileData.head))+' total traced allocations')}else{showToast('No allocation profile data — may need longer sampling')}}catch(e){showToast('Error: '+e)}}
function fgSearch(){fgSearchTerm=document.getElementById('fgSearch').value;fgRefresh()}
function fgZoomOut(){fgZoomNode=null;fgRefresh()}
function updateHeapStatus(d){var profiling=d.heapProfiling||false;var available=d.heapInspectorAvailable!==false;document.getElementById('btnHeapStart').style.display=(profiling||!available)?'none':'';document.getElementById('btnHeapStop').style.display=profiling?'':'none';document.getElementById('heapProfilingLabel').style.display=profiling?'':'none';if(!heapProfiling&&d.heapProfile&&d.heapProfile.head&&(!heapProfileData||fgTotalSize(d.heapProfile.head)!==fgTotalSize(heapProfileData.head||{selfSize:0}))){heapProfileData=d.heapProfile;fgZoomNode=null;fgRefresh()}if(profiling&&!heapProfiling){heapProfiling=true}if(!profiling&&heapProfiling){heapProfiling=false;if(d.heapProfile&&d.heapProfile.head){heapProfileData=d.heapProfile;fgZoomNode=null;fgRefresh()}}}
fetchData();setInterval(fetchData,1000);
</script>
</body>
</html>`;
}
