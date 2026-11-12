'use strict';
/* ============================================================================
 * v3.8 · 设置页重新分类排布与外观美化（两端一致）
 *   node --test tests/v38-settings-layout.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const EH = read('edge-extension/popup.html');
const DH = read('desktop-app/src/popup.html');
const CSS = read('shared/hsa-shared.css');

const body = s => {
  const a = s.indexOf('<div class="settings-body">');
  const b = s.indexOf('</section>', a);
  return s.slice(a, b);
};
/** 去掉桌面专有组块，剩下的就是两端共有的 DOM。 */
const commonBody = s => {
  const d = body(s);
  const ds = d.indexOf('<!-- v1.3.8 · 桌面版专有功能');
  if (ds < 0) return d.trim();
  const de = d.indexOf('id="set-reset"', ds);
  return (d.slice(0, ds) + d.slice(d.lastIndexOf('\n', de) + 1)).trim();
};

test('v3.9 · 两端共有设置 DOM 逐字一致，仅桌面多一组专有设置', () => {
  assert.equal(commonBody(EH), commonBody(DH), '共有部分必须逐字一致');
  assert.match(DH, /id="desktop-group" style="--g:5"/);
  assert.doesNotMatch(EH, /id="desktop-group"/);
  assert.equal((EH.match(/class="set-group-head"/g) || []).length, 4);
  assert.equal((DH.match(/class="set-group-head"/g) || []).length, 5);
});

test('v3.9 · 分组重新分类为 6 组且顺序固定', () => {
  const order = ['appearance-group', 'run-group', 'auto-group',
    'calendar-group', 'diag-group'];
  for (const [name, s] of [['plugin', EH], ['desktop', DH]]) {
    let last = -1;
    for (const id of order) {
      const i = s.indexOf('id="' + id + '"');
      assert.ok(i > last, name + ' 分组顺序错误：' + id);
      last = i;
    }
    assert.ok(s.indexOf('id="set-reset"') > last, '恢复默认在最后');
    /* 组序号徽标 01/02/03/05；日历用 CSS ::before 显示 04 */
    const badges = [...s.matchAll(/<span class="set-badge" aria-hidden="true">(\d\d)<\/span>/g)]
      .map(m => m[1]);
    assert.deepEqual(badges, name === 'plugin' ? ['01', '02', '03', '05']
      : ['01', '02', '03', '05', '06']);
    assert.match(s, /data-i18n="settings.subtitle"/);
    for (const key of ['settings.appearanceDesc', 'run.title', 'run.desc',
      'auto.desc', 'diag.desc']) {
      assert.match(s, new RegExp('data-i18n="' + key.replace('.', '\\.') + '"'));
    }
  }
  assert.match(DH, /data-i18n="desktop.desc"/);
  assert.ok(DH.indexOf('id="diag-group"') < DH.indexOf('id="desktop-group"'),
    '桌面专有组排在共有组之后');
  /* 既有约束：日历仍排在自动任务之后、默认展开 */
  assert.ok(EH.indexOf('id="auto-group"') < EH.indexOf('id="calendar-group"'));
  assert.match(EH, /<details class="set-group cal-fold" id="calendar-group"[^>]*\bopen\b/);
  const cal = s => {
    const i = s.indexOf('<details class="set-group cal-fold" id="calendar-group"');
    return s.slice(i, s.indexOf('</details>', i) + 10);
  };
  assert.equal(cal(EH), cal(DH), '日历 DOM 仍逐字一致');
});

test('v3.8/v3.9 · 5 项基准间隔集中在「02 运行设置」两列网格', () => {
  /* v4.2 · 5 项间隔 + 2 项风险数值统一收进三组只读预设 */
  const keys = ['cardClickIntervalSec', 'actionGapSec', 'pageStableSec',
    'roundGapSec', 'roundWaitSec', 'singleRunCapPct', 'scheduleJitterMin'];
  for (const [name, s] of [['plugin', EH], ['desktop', DH]]) {
    const a = s.indexOf('id="run-group"');
    const b = s.indexOf('id="auto-group"', a);
    const timing = s.slice(a, b);
    assert.ok(timing.includes('id="run-preset-groups"'), name + ' 缺三组预设容器');
    assert.equal((timing.match(/data-group="(quota|action|page)"/g) || []).length, 3);
    for (const key of keys) {
      assert.ok(timing.includes('data-preset="' + key + '"'), name + ' 缺 ' + key);
      assert.equal((timing.match(new RegExp('data-preset="' + key + '"', 'g')) || []).length, 1);
    }
    for (const gone of ['set-card-interval', 'set-action-gap', 'set-page-stable',
                        'set-round-gap', 'set-round-wait', 'set-stealth-cap', 'set-stealth-jitter']) {
      assert.ok(!timing.includes('id="' + gone + '"'), name + ' 仍暴露 ' + gone);
    }
    const auto = s.slice(b, s.indexOf('id="calendar-group"', b));
    assert.ok(!auto.includes('id="set-card-interval"'),
      name + ' 自动任务组不应再放卡片点击间隔');
    assert.ok(!auto.includes('id="set-action-gap"'));
    /* 所有原有 ID / 文案 / title 都保留，行为不变 */
    for (const id of ['set-auto', 'set-auto-time-add', 'set-auto-count',
      'set-auto-level', 'set-reduce', 'set-lang', 'set-theme',
      'set-run-log', 'btn-export-runlog', 'btn-capture-keypages']) {
      assert.ok(s.includes('id="' + id + '"'), name + ' 丢了 ' + id);
    }
  }
});

test('v3.8 · 美化样式写在共享单一真源，两端副本同步', () => {
  const rules = [
    'v3.8 · 设置页重新分类与外观美化',
    '.settings-head-sub', '.set-group-head', '.set-group-heading',
    '.set-badge', '.set-desc', '.set-grid',
    '.set-inline-number input[type="number"]',
    '.cal-fold > summary::before', 'body.reduce-motion',
    '@media (max-width: 350px)'
  ];
  for (const r of rules) assert.ok(CSS.includes(r), '共享 CSS 缺 ' + r);
  /* 渐变徽标按组分类 */
  for (const tone of ['violet', 'blue', 'amber', 'teal', 'rose']) {
    assert.match(CSS, new RegExp('data-tone="' + tone + '"'));
  }
  /* 两列网格 + 窄屏单列 + 数字输入统一 */
  assert.match(CSS, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(CSS, /grid-template-columns: 1fr/);
  assert.match(CSS, /\.set-grid > \.set-row \.set-inline-number input\[type="number"\] \{ width: 100%/);
  assert.match(CSS, /\.set-group-head \+ \.set-row \{ border-top: none; \}/);

  for (const p of ['edge-extension/shared/hsa-shared.css',
    'desktop-app/shared/hsa-shared.css']) {
    const copy = read(p).replace(/^\/\* AUTO-GENERATED[^\n]*\n/, '');
    assert.equal(copy, CSS.trim() + '\n', p + ' 未同步');
  }
  /* 两端 popup.css 不再各自写一套 v3.8 样式 */
  for (const p of ['edge-extension/popup.css', 'desktop-app/src/popup.css']) {
    assert.doesNotMatch(read(p), /v3\.8 · 设置页重新分类/);
  }
});

test('v3.8 · 新增 i18n 键两端 zh/en 齐全，HTML 全部键零缺失', () => {
  const keys = ['settings.subtitle', 'settings.appearanceDesc',
    'timing.title', 'timing.desc', 'auto.desc', 'diag.desc', 'desktop.desc'];
  for (const [hk, jk] of [['EH', 'edge-extension/popup.js'],
    ['DH', 'desktop-app/src/popup.js']]) {
    const html = hk === 'EH' ? EH : DH;
    const js = read(jk);
    for (const key of keys) {
      assert.ok(js.includes("'" + key + "':"), jk + ' 缺 ' + key);
    }
    const all = [...html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)]
      .map(m => m[1]);
    assert.ok(all.length > 40, 'i18n 键扫描数量异常');
    for (const key of new Set(all)) {
      assert.ok(js.includes("'" + key + "':"), jk + ' 字典缺键 ' + key);
    }
  }
  /* 两端新增键值一致（不引入新的 UI 文案差异） */
  const ep = read('edge-extension/popup.js'), dp = read('desktop-app/src/popup.js');
  for (const key of keys) {
    const line = s => s.split('\n').find(l => l.includes("'" + key + "':"));
    assert.equal(line(ep).trim(), line(dp).trim(), key + ' 两端文案不一致');
  }
});
