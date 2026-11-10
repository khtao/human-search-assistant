#!/usr/bin/env node
'use strict';
/* R4.2 · Keep shared extension / desktop UI features aligned.
 * Desktop-only login panel, tray and startup settings are intentionally not
 * copied. The shared calendar markup, calendar JS/CSS, and bilingual labels
 * must remain byte-for-byte equal across the two distributed interfaces. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..', '..');
const sources = [path.join(root, 'edge-extension'),path.join(root,'desktop-app','src')];
const files = name => sources.map(dir => fs.readFileSync(path.join(dir,name),'utf8'));
function segment(data, from, until) {
  const at = data.indexOf(from);
  assert(at >= 0, `Missing start marker: ${from}`);
  const end = until ? data.indexOf(until, at + from.length) : data.length;
  assert(end > at, `Missing end marker: ${until}`);
  return data.slice(at, end);
}
function matching(name, begin, end, label) {
  const [edge, desk] = files(name);
  assert.strictEqual(segment(desk,begin,end),segment(edge,begin,end),
    `${label} is different in desktop-app/src and edge-extension`);
  console.log('  ✓ '+label);
}
matching('popup.html','<!-- v1.3.8 · 积分日历','<!-- 原 Daily reminders','Calendar HTML layout');
matching('popup.js','  let calMode = ','  /* 桌面版专有设置','Calendar behavior and statistics');
matching('popup.css','/* ==========================================================================\n * v1.3.8 · 积分日历',null,'Calendar visual styles including week/month and grey navigation');
matching('popup.html','<label class="set-row" data-i18n-title="auto.cardIntervalHint"','</label>', 'Shared card click interval setting');
const [edgeJs,deskJs] = files('popup.js');
const keyMatches = source => [...source.matchAll(/'calendar\.[a-zA-Z]+':\s*('(?:[^'\\]|\\.)*')/g)]
  .map(m=>m[0]);
assert.deepStrictEqual(keyMatches(deskJs),keyMatches(edgeJs),'Calendar translations differ');
console.log('  ✓ Calendar Chinese/English dictionary entries');
const [edgeBg,deskBg] = files('background.js');
const record = src => segment(src,'let desktopActivityLast = ', 'function desktopActivityTaskNames');
assert.strictEqual(record(edgeBg),record(deskBg),'Points history recording logic differs');
console.log('  ✓ Calendar points-history capture');
const [edgeCss,deskCss] = files('popup.css');
assert(edgeCss.includes('grid-template-columns:repeat(3,minmax(0,1fr))') &&
  deskCss.includes('grid-template-columns:repeat(3,minmax(0,1fr))'),'Month cards absent');
for (const js of [edgeJs,deskJs]) {
  assert(js.includes('const earningDays = []') &&
    js.includes('n: earningDays.length') &&
    js.includes('Math.max.apply(null, earningDays)'), 'Daily statistics missing');
  assert(js.includes("const empty = vals.length === 0 || !hasPointsIn(step)"),
    'Empty-period navigation must be grey');
}
const builder = fs.readFileSync(path.join(root,'desktop-app','electron-builder.win.yml'),'utf8');
const main = fs.readFileSync(path.join(root,'desktop-app','main.js'),'utf8');
assert(builder.includes('src/**/*'),'Windows package does not include desktop UI assets');
assert(main.includes("popupWin.loadFile(path.join(SRC, 'popup.html'))"),
  'Desktop window is not loading packaged popup.html');
console.log('  ✓ Windows package contains the current desktop UI assets');
console.log('PASS R4.2 shared UI parity: calendar markup, CSS, JS, history, bilingual texts, packaging');
