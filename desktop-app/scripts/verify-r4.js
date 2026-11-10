#!/usr/bin/env node
'use strict';
/* R4: 5s post-load wait, minimum 5s *active* scan, Windows cache-first build. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {spawnSync} = require('child_process');
const root = path.resolve(__dirname,'..');
const ext = fs.readFileSync(path.join(root,'../edge-extension/background.js'),'utf8');
const main = fs.readFileSync(path.join(root,'main.js'),'utf8');
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const part=(s,a,b)=>{const x=s.indexOf(a), y=s.indexOf(b,x+a.length); assert(x>=0&&y>x,'Missing source: '+a);return s.slice(x,y);};
(async()=>{
  assert(ext.includes('const HUMAN_PAGE_SETTLE_MS = 5000;'), 'Edge waits 5 seconds after each page load');
  assert(main.includes('const TASK_PAGE_READY_WAIT_MS = 5000;'), 'Desktop waits 5 seconds after each page load');
  assert(main.includes('const TASK_SCAN_STEP_DELAY_MS = 520;'), 'Desktop uses slow scan ticks');
  assert(ext.includes('const FLYOUT_SCAN_STEP_MS = 520;'), 'Edge uses slow scan ticks');
  // Execute real Edge scan with mocked DOM and debugger, tracking every scroll and wait.
  const ctx={console,Number,Math,String,Set,Date,
    FLYOUT_SCAN_MAX_SEGMENTS:64,FLYOUT_SCAN_STEP_MS:520, FLYOUT_SCAN_SETTLE_MS:900,
    FLYOUT_INNER_MAX_SEGMENTS:48, cdpAttached:new Set([15]),
    isCurrent:()=>true,ybInject:()=>{}};
  let edgeMs=0, edgeOuter=[], edgeWheels=0;
  ctx.nap=async ms=>{edgeMs+=ms};
  ctx.cdpCmd=async(_t,cmd,p)=>{assert(cmd==='Input.dispatchMouseEvent');assert(p.type==='mouseWheel');edgeWheels++};
  ctx.inject=async (_t,_fn,[action,args])=>{
    if(action==='human.scrollTo') {edgeOuter.push(args.y);return {scrollHeight:2200,viewport:800}};
    if(action==='human.scrollers') return {scrollers:[]};
    if(action==='human.scan') return {cards:edgeOuter.at(-1)>=1300?[{idx:'offer-1300',title:'Earn',points:10}]:[]};
    return {};
  };
  vm.createContext(ctx);
  vm.runInContext(part(ext,'async function collectFlyoutCardsFull(', '\n/* HSA_TASK_LOCATOR_REPAIR_20261109'),ctx);
  const r=await ctx.collectFlyoutCardsFull(15,1,{},false,true);
  assert(r.segments>=12,'Edge must perform at least twelve distinct scan ticks');
  assert(edgeMs>=5000,'Edge scroll scan must last at least 5 seconds');
  assert(edgeWheels>0,'Edge CDP wheel events must occur');
  assert(edgeOuter.some(y=>y>=1300),'Edge scan must reach the lower page');
  assert(r.cards.length>=1,'Edge scan must collect lower cards');
  assert(edgeOuter.filter(y=>y>0).length>=8,'Edge scroll movement must be gradual');
  const human=part(ext,'async function humanWaitPage(', '\n/**');
  const ctxWait={chrome:{tabs:{get:async()=>({status:'complete'})}}, isCurrent:()=>true,
    HUMAN_PAGE_SETTLE_MS:5000,nap:async ms=>{assert(ms===5000)}};
  vm.createContext(ctxWait);vm.runInContext(human,ctxWait);
  await ctxWait.humanWaitPage(15,1);
  // Execute real desktop live collector with timers recorded in a fake virtual clock.
  let desktopMs=0;const positions=[];
  const desktopCtx={Promise,Math,Number,String,Array,console,Date, URL,
    TASK_SCAN_STEP_DELAY_MS:520, state:{running:true},
    setTimeout(fn,ms){desktopMs+=ms;fn();return 1},
    DBG:{log() {}}};
  vm.createContext(desktopCtx);
  vm.runInContext(part(main,'async function discoverLiveScoredCards(', '\n/* HSA_TASK_LOCATOR_REPAIR_20261109: sweep SPA/'),desktopCtx);
  const wc={debugger:{isAttached:()=>true,sendCommand:async()=>{}},executeJavaScript:async script=>{
    const m=script.match(/window\.scrollTo\(0,(\d+)\)/);
    if(m){positions.push(+m[1]);return 2300;}
    if(script.includes('rows.slice(0, 120)')) return [];
    if(script.includes('__hsaDiscoverScrollers.length')) return 0;
    return {h:2300,v:800};
  }};
  await desktopCtx.discoverLiveScoredCards(wc,{page:'/earn',url:'https://rewards.bing.com/earn'});
  assert(desktopMs>=5000,'Desktop scroll scan must last at least five seconds');
  assert(positions.length>=12 && positions.some(y=>y>=1400),'Desktop scroll must reach the bottom gradually');
  // A real dry-run of Windows builder: should neither download nor modify filesystem.
  const proc=spawnSync(process.execPath,[path.join(root,'scripts/build-win-safe.js'),'--dry-run'],{encoding:'utf8'});
  assert.strictEqual(proc.status,0,proc.stderr);
  const info=JSON.parse(proc.stdout);
  assert(info.uniqueOutput && info.cacheFirst, 'Windows build must restore Electron and isolate outputs');
  assert(info.arguments.includes('--win') && info.arguments.includes('--x64'),'Windows target must be x64');
  assert(info.arguments.join(' ').includes('--config electron-builder.win.yml'),'Use correct Windows config');
  assert(info.arguments.some(s=>s.startsWith('--config.directories.output=')),'Use isolated output');
  assert(read('build-win-local.cmd').includes('npm run dist:win'),'CMD and npm use same robust builder');
  const pkg=JSON.parse(read('package.json'));
  assert(pkg.scripts['dist:win']==='node scripts/build-win-safe.js');
  console.log('PASS R4: both pages wait 5s, Edge/Desktop perform slow >=5s scrolling, Windows build cache restore & isolated output');
})().catch(e=>{console.error(e);process.exitCode=1});
