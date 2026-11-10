#!/usr/bin/env node
'use strict';
/* R3 cross-platform requirements; checks exact behavior, not merely comments. */
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const ROOT=path.resolve(__dirname,'..');
const EXT=fs.readFileSync(path.join(ROOT,'../edge-extension/background.js'),'utf8');
const DESK=fs.readFileSync(path.join(ROOT,'src/background.js'),'utf8');
const MAIN=fs.readFileSync(path.join(ROOT,'main.js'),'utf8');
const EPOP=fs.readFileSync(path.join(ROOT,'../edge-extension/popup.js'),'utf8');
const DPOP=fs.readFileSync(path.join(ROOT,'src/popup.js'),'utf8');
const EHTML=fs.readFileSync(path.join(ROOT,'../edge-extension/popup.html'),'utf8');
const DHTML=fs.readFileSync(path.join(ROOT,'src/popup.html'),'utf8');
const ECSS=fs.readFileSync(path.join(ROOT,'../edge-extension/popup.css'),'utf8');
const DCSS=fs.readFileSync(path.join(ROOT,'src/popup.css'),'utf8');
(async()=>{
 for(const [label,bg,pop,html,css] of [['Edge',EXT,EPOP,EHTML,ECSS],['Desktop',DESK,DPOP,DHTML,DCSS]]) {
  assert(bg.includes('const TASK_CLICK_INTERVAL_MS = 10000;'),label+' default interval');
  assert(bg.includes('const seconds = Number(cfg.cardClickIntervalSec)'),label+' reads user interval');
  assert(bg.includes('await nap(left, token)'),label+' waits using cancelable delay');
  assert(pop.includes('cardClickIntervalSec: 10') && pop.includes('saveSettings({ cardClickIntervalSec: interval })'),label+' persists setting');
  assert(html.includes('id="set-card-interval" min="1" max="60"'),label+' user input range');
  assert(html.includes('id="cal-prev"') && html.includes('id="cal-next"'),label+' navigation controls');
  assert(pop.includes("calMode === 'week'") && pop.includes('cal-week-strip'),label+' weekly strips');
  assert(pop.includes("vals.length === 0 || !hasPointsIn(step)"),label+' no-points navigation grey');
  assert(css.includes('.cal-grid.cal-week { grid-template-columns:1fr') &&
    css.includes('.cal-grid.cal-month { grid-template-columns:repeat(3'),label+' calendar layouts');
  assert(css.includes('.cal-nav.cal-nav-empty'),label+' grey period navigation');
 }
 const edgeFlow=EXT.slice(EXT.lastIndexOf('humanClickTasks = async function (token, stat) {'));
 assert(edgeFlow.indexOf('const initialAttached = await cdpAttach(tabId)') <
   edgeFlow.indexOf('const liveScan = await collectFlyoutCardsFull') &&
   edgeFlow.indexOf('const liveScan = await collectFlyoutCardsFull') <
   edgeFlow.indexOf('if (!attached) {'),
   'CDP is attempted before scanning, but failure never prevents scrolling');
 assert(EXT.includes("type: 'mouseWheel'") && EXT.includes('stat.cdpWheelEvents'),
   'Live scanning dispatches real CDP wheel events when debugger is attached');
 assert(edgeFlow.includes('stat.cdpUnavailable = lastTaskCdpError') &&
   edgeFlow.includes('stat.pages.push({ page: pg.page, clicked: 0'), 'Attach failure must be explicit and safe');
 assert(edgeFlow.indexOf('const aim = await hsaLocateCurrentTask') < edgeFlow.indexOf('await taskClickSpacing(token)') &&
   edgeFlow.indexOf('await taskClickSpacing(token)') < edgeFlow.indexOf('await cdpClickAt(tabId, aim.x, aim.y)'),
   'Interval is measured immediately before actual CDP mouse click');
 assert(EXT.includes('chrome.debugger.onDetach.addListener'), 'Detached debugger session must be invalidated');
 assert(MAIN.includes('lastPhysicalClickAt = Date.now()') &&
   MAIN.includes('await waitClickSpacing()') &&
   MAIN.indexOf('await waitClickSpacing()') < MAIN.indexOf('await dispatchTaskMouseClick(dbg, aim.x, aim.y)'),
   'Desktop interval guards physical mouse clicks, not only discovery');
 assert(DESK.includes('cardClickIntervalSec: clickSettings.cardClickIntervalSec'), 'Desktop passes interval via IPC');
 // Execute exactly the real spacing function using mocked time / settings.
 const beg=EXT.indexOf('async function taskClickSpacing(token) {');
 const end=EXT.indexOf('\n/**',beg);
 let virtualNow=12000, last=11000, waited=0, seconds=10;
 const fakeDate={now:()=>virtualNow};
 const ctx={Date:fakeDate, getSettings:async()=>({cardClickIntervalSec:seconds}),
   nap:async(ms)=>{waited+=ms;virtualNow+=ms},isCurrent:()=>true,
   TASK_CLICK_INTERVAL_MS:10000,STOP:Error('STOP'),lastTaskClickAt:last};
 vm.createContext(ctx);
 vm.runInContext(EXT.slice(beg,end)+'\nthis.spacing=taskClickSpacing;',ctx);
 await ctx.spacing(1);
 assert.strictEqual(waited,9000,'10 second default must wait remaining 9 seconds');
 assert.strictEqual(ctx.lastTaskClickAt,virtualNow);
 virtualNow+=1000; seconds=3;
 await ctx.spacing(1);
 assert.strictEqual(waited,11000,'3 second custom interval waits remaining 2 seconds');
 console.log('PASS R3: Edge CDP and scrolling, default/custom gap timing, desktop IPC and mouse timing, both calendar views, grey empty navigation');
})().catch(e=>{console.error(e);process.exitCode=1});
