#!/usr/bin/env node
'use strict';
/* R4.1: real source evaluated with simulated long/short/dynamically growing pages.
 * Virtual clock is advanced by the actual delay calls, not textual assertions. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const edge = fs.readFileSync(path.join(root,'../edge-extension/background.js'),'utf8');
const desktop = fs.readFileSync(path.join(root,'main.js'),'utf8');
const extract = (src, start, end) => {
  const a=src.indexOf(start), b=src.indexOf(end,a+start.length);
  assert(a>=0 && b>a,`Missing function markers ${start}`);
  return src.slice(a,b);
};
const edgeFn = extract(edge,'async function collectFlyoutCardsFull(', '\n/* HSA_TASK_LOCATOR_REPAIR_20261109');
const desktopFn = extract(desktop,'async function discoverLiveScoredCards(', '\n/* HSA_TASK_LOCATOR_REPAIR_20261109: sweep SPA/');
async function testEdge(initialHeight, growthAt=Infinity) {
  let virtualMs=0, height=initialHeight, lastY=0;
  const moves=[], wheel=[];
  const context={console, Math, Number, String, Date, URL, Set,
    FLYOUT_SCAN_STEP_MS:520, FLYOUT_SCAN_MAX_SEGMENTS:160,
    FLYOUT_SCAN_SETTLE_MS:900, FLYOUT_INNER_MAX_SEGMENTS:48,
    cdpAttached:new Set([7]), isCurrent:()=>true, ybInject:()=>{},
    nap:async(ms)=>{virtualMs+=ms},
    cdpCmd:async(id, command, options)=>{
      assert.strictEqual(command,'Input.dispatchMouseEvent');
      wheel.push({t:virtualMs,delta:options.deltaY});
    },
    inject:async (_id,_fn,[action,args])=>{
      if(action==='human.scrollTo') {
        if(args.y>=growthAt) height=Math.max(height,3800);
        lastY=args.y; moves.push({t:virtualMs,y:lastY});
        return {scrollHeight:height,viewport:800};
      }
      if(action==='human.scrollers') return {scrollers:[]};
      if(action==='human.scan') return {cards:lastY>=3000?[{idx:'dynamic-offer',title:'Task',points:10}]:[]};
      return {};
    }
  };
  vm.createContext(context);vm.runInContext(edgeFn,context);
  const result=await context.collectFlyoutCardsFull(7,1,{},false,true);
  assert(result.segments>=12,'Edge should scan at least 12 ticks');
  const forward=moves.filter((v,i)=>i>0 && v.y>moves[i-1].y);
  assert(forward.length>0,'Edge should move when page is scrollable');
  for(const event of wheel) assert(event.delta<=220,`Edge fast jump: ${event.delta}`);
  if(initialHeight===1400) {
    assert(wheel.length>=11,'Edge short-page movement must last 5+ seconds');
    assert(wheel.at(-1).t-wheel[0].t>=5000,'Edge short-page movement time <5 seconds');
  }
  if(growthAt<Infinity) assert(result.cards.some(x=>x.idx==='dynamic-offer'),'Edge missed dynamically loaded bottom task');
  return {virtualMs,moves:moves.length,wheel:wheel.length};
}
async function testDesktop(initialHeight, growthAt=Infinity) {
  let virtualMs=0,height=initialHeight,latestY=0;
  const moves=[],wheel=[];
  const context={console, Math, Number, String, Date, URL, Array, Promise,
    state:{running:true},TASK_SCAN_STEP_DELAY_MS:520,
    setTimeout(callback,delay){virtualMs+=delay;callback();return 1},DBG:{log() {}}};
  vm.createContext(context);vm.runInContext(desktopFn,context);
  const wc={debugger:{isAttached:()=>true,sendCommand:async(method,options)=>{
    assert.strictEqual(method,'Input.dispatchMouseEvent');
    wheel.push({t:virtualMs,delta:options.deltaY});
  }},executeJavaScript:async script=>{
    const match=script.match(/window\.scrollTo\(0,(\d+)\)/);
    if(match){latestY=Number(match[1]);if(latestY>=growthAt)height=Math.max(3800,height);
      moves.push({t:virtualMs,y:latestY});return height;}
    if(script.includes('rows.slice(0, 120)'))return [];
    if(script.includes('__hsaDiscoverScrollers.length'))return 0;
    if(script.includes('document.scrollingElement||document.documentElement).scrollHeight'))return height;
    return {h:height,v:800};
  }};
  await context.discoverLiveScoredCards(wc,{page:'/dashboard',url:'https://rewards.bing.com/dashboard'});
  assert(moves.length>=12,'Desktop should scan at least 12 ticks');
  assert(moves.some(x=>x.y>0),'Desktop should scroll when possible');
  for(const event of wheel) assert(event.delta<=220,`Desktop fast jump: ${event.delta}`);
  if(initialHeight===1400){
    assert(wheel.length>=11,'Desktop short-page movement must last 5+ seconds');
    assert(wheel.at(-1).t-wheel[0].t>=5000,'Desktop short-page movement time <5 seconds');
  }
  if(growthAt<Infinity) assert(moves.some(x=>x.y>=3000),'Desktop failed to reach dynamic content');
  return {virtualMs,moves:moves.length,wheel:wheel.length};
}
(async()=>{
  // Both application modes wait five seconds after each page load.
  assert(edge.includes('const HUMAN_PAGE_SETTLE_MS = 5000;'));
  assert(desktop.includes('const TASK_PAGE_READY_WAIT_MS = 5000;'));
  assert(edge.includes("{ page: '/dashboard', url: DASHBOARD_URL"));
  assert(edge.includes("{ page: '/earn', url: EARN_URL"));
  assert(desktop.includes("{ page: '/dashboard', url: 'https://rewards.bing.com/dashboard' }"));
  assert(desktop.includes("{ page: '/earn', url: 'https://rewards.bing.com/earn' }"));
  const scenarios=[
    ['short',1400,Infinity],
    ['dynamic',2200,900],
    ['long',9000,Infinity],
  ];
  for (const [label,height,growthAt] of scenarios) {
    const e=await testEdge(height,growthAt);
    const d=await testDesktop(height,growthAt);
    assert(e.virtualMs>=5000 && d.virtualMs>=5000, `${label} scan <5s`);
    console.log(`  ${label}: Edge ${e.wheel} wheels, ${e.virtualMs} virtual ms; desktop ${d.wheel} wheels, ${d.virtualMs} virtual ms`);
  }
  console.log('PASS R4.1: 5s page settle, 5s+ real slow-scroll movement, 220px cap, dynamic content, both platforms');
})().catch(e=>{console.error(e);process.exitCode=1});
