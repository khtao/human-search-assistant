/** Unit tests for 2026-11-09 live-card repair. No Microsoft login or network required. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const extension = fs.readFileSync(path.resolve(__dirname, '../../edge-extension/background.js'), 'utf8');
const desktop = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
function extract(source,start,end) {
  const a=source.indexOf(start), b=source.indexOf(end,a+start.length);
  assert(a>=0 && b>a, `Missing tested source section: ${start}`);
  return source.slice(a,b);
}
const extHelpers = extract(extension, 'async function hsaLocateCurrentTask(', '\nconst humanClickTasksV136Original = humanClickTasks;');
const context={Set,Promise,console,Number,Math,String,Array,
  isCurrent:()=>true, nap:async()=>{}, ybInject:()=>{}, inject:async()=>null};
vm.createContext(context);
vm.runInContext(extHelpers+'\nthis.merge=hsaMergeLiveTaskCards; this.locate=hsaLocateCurrentTask;',context);
const indexed=[{name:'积分活动',points:10,url:'https://www.bing.com/search?q=one',locator:{}}];
const live=[
  {title:'积分活动',points:10,href:'https://www.bing.com/search?q=one',idx:'a'},
  {title:'积分活动',points:10,href:'https://www.bing.com/search?q=two',idx:'b'},
  {title:'额外任务',points:5,href:'',idx:'c'}
];
const merged=context.merge(indexed,live,'/earn');
assert.strictEqual(merged.length,3,'must preserve distinct same-title offer URLs and add unmatched DOM card');
assert.strictEqual(merged.filter(x=>x._hsaLive).length,2);
let scrollPositions=[], latestY=0;
context.inject=async(_tab,_fn,[act,arg])=>{
  if (act==='human.aimIndexed') return latestY>=600?{ok:true,x:120,y:145,vp:{w:1000,h:700}}:{ok:false};
  if (act==='human.scrollTo') {latestY=arg.y;scrollPositions.push(arg.y);return {scrollHeight:1900,viewport:700};}
  if (act==='human.scrollers') return {scrollers:[]};
  return null;
};
(async()=>{
  const result=await context.locate(10,{name:'积分活动',points:10,locator:{href:'https://www.bing.com/search?q=one'}},0,true);
  assert(result.ok,'indexed card becomes visible only after incremental scrolling');
  assert(scrollPositions.some(x=>x>=600),'must genuinely visit later scroll positions');
  latestY=0;
  context.inject=async(_tab,_fn,[act,arg])=>{
    if(act==='human.aim')return latestY>=200?{ok:true,x:50,y:50,vp:{w:600,h:600}}:{ok:false};
    if(act==='human.scrollTo'){latestY=arg.y;return {scrollHeight:1500,viewport:600};}
    return {scrollers:[]};
  };
  const liveResult=await context.locate(10,merged[1],0,true);
  assert(liveResult.ok,'live-only task is not omitted when sync index misses it');

  const desktopHelpers=extract(desktop,'async function discoverLiveScoredCards(',"\nipcMain.handle('chrome:task:clickAll'");
  const desktopCtx={state:{running:true},Promise,console,TASK_SCAN_STEP_DELAY_MS:520,setTimeout:fn=>fn()};
  vm.createContext(desktopCtx);
  vm.runInContext(desktopHelpers+'\nthis.collect=discoverLiveScoredCards;this.locate=locateIndexedCardAcrossScroll;',desktopCtx);
  const el={tagName:'A',innerText:'额外积分卡 +10',textContent:'额外积分卡 +10',id:'offer-11',
    getAttribute:k=>k==='href'?'https://www.bing.com/search?q=bonus':k==='data-bi-id'?'offer-11':'',
    getBoundingClientRect:()=>({width:160,height:45}),querySelector:()=>null};
  const page={document:{querySelectorAll:()=>[el]},location:{href:'https://rewards.bing.com/earn'},URL};
  const wc={executeJavaScript:async script=>{
    if(script.includes('rows.slice(0, 120)'))return vm.runInNewContext(script,page);
    if(script.includes('__hsaDiscoverScrollers.length'))return 0;
    return {h:880,v:800};
  }};
  const rows=await desktopCtx.collect(wc,{page:'/earn',url:page.location.href});
  assert.strictEqual(rows.length,1,'desktop live collector should find one scored card');
  assert.strictEqual(rows[0].locator.dataBiId,'offer-11');
  let desktopScroll=0;
  desktopCtx.taskAimIndexedSrc=()=> '__MOCK_DESKTOP_AIM__';
  const wc2={executeJavaScript:async script=>{
    if(script==='__MOCK_DESKTOP_AIM__')return desktopScroll>=500?{ok:true,x:180,y:220}:{ok:false};
    const match=script.match(/window\.scrollTo\(0,(\d+)\)/);
    if(match){desktopScroll=Number(match[1]);return 1800;}
    if(script.includes('__hsaLocateScrollers.length'))return 0;
    return {height:1800,view:700};
  }};
  const aimed=await desktopCtx.locate(wc2,{name:'extra',locator:{}});
  assert(aimed.ok && desktopScroll>=500,'desktop must revisit dynamic positions before giving up');
  console.log('PASS task repair: distinct tasks, index/live merge, extension & desktop scrolling, live DOM detection');
})().catch(err=>{console.error(err);process.exitCode=1;});
