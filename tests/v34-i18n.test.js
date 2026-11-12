'use strict';
/* ============================================================================
 * v3.4 · 语言按钮字典键泄漏修复：全量键覆盖 / 两端文案一致 / applyI18n 护栏
 *   node --test tests/v34-i18n.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 从 popup.js 抽出 I18N 的 zh / en 两本字典（纯字面量，不执行 DOM 代码）。 */
function dictionaries(jsPath) {
  const s = read(jsPath);
  const start = s.indexOf('const I18N');
  const end = s.indexOf('\n  };', start);
  const enStart = s.indexOf('en: {', start);
  assert.ok(start >= 0 && end > enStart, jsPath + ' I18N 结构不可解析');
  const block = s.slice(start, end + '\n  };'.length);
  // 整体求值 I18N 对象字面量（字典只含字符串，不依赖 DOM / 运行时变量）
  const ctx = {};
  vm.runInNewContext('const I18N = ' + block.slice(block.indexOf('{')) + '; globalThis.__I18N = I18N;', ctx);
  const I18N = ctx.__I18N;
  assert.ok(I18N && I18N.zh && I18N.en, jsPath + ' 缺少 zh/en 字典');
  return I18N;
}

function htmlDataKeys(htmlPath) {
  const s = read(htmlPath);
  return [...s.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)].map(m => m[1]);
}

function tKeys(jsPath) {
  const s = read(jsPath);
  return [...s.matchAll(/\bt\('([^']+)'/g)].map(m => m[1]);
}

const PAIRS = [
  ['插件版', 'edge-extension/popup.js', 'edge-extension/popup.html'],
  ['桌面版', 'desktop-app/src/popup.js', 'desktop-app/src/popup.html']
];

test('v3.4 · 两端 HTML 的全部 data-i18n* 键在 zh / en 字典都命中，杜绝 key 泄漏', () => {
  for (const [name, js, html] of PAIRS) {
    const I18N = dictionaries(js);
    const keys = htmlDataKeys(html);
    assert.ok(keys.length >= 60, name + ' 提取键数异常：' + keys.length);
    const missZh = keys.filter(k => !(k in I18N.zh));
    const missEn = keys.filter(k => !(k in I18N.en));
    assert.deepEqual(missZh, [], name + ' 中文字典缺键：' + missZh.join(', '));
    assert.deepEqual(missEn, [], name + ' 英文字典缺键：' + missEn.join(', '));
  }
});

test('v3.4 · 插件版语言按钮：lang.zh / lang.en 已补齐且与桌面逐字一致', () => {
  const E = dictionaries('edge-extension/popup.js');
  const D = dictionaries('desktop-app/src/popup.js');
  for (const lang of ['zh', 'en']) {
    assert.equal(E[lang]['lang.zh'], D[lang]['lang.zh'], lang + ' · lang.zh');
    assert.equal(E[lang]['lang.en'], D[lang]['lang.en'], lang + ' · lang.en');
    assert.equal(E[lang]['lang.system'], D[lang]['lang.system'], lang + ' · lang.system');
  }
  assert.equal(E.zh['lang.zh'], '中文');
  assert.equal(E.zh['lang.en'], 'English');
  assert.equal(E.en['lang.zh'], 'Chinese');
  assert.equal(E.en['lang.en'], 'English');
  assert.notEqual(E.zh['lang.zh'], 'lang.zh', '绝不能让字典值等于 key 本身');
});

test('v3.4 · 两端共有字典键文案一致，只剩 U01=C 决策保留的 a11y.login', () => {
  const E = dictionaries('edge-extension/popup.js');
  const D = dictionaries('desktop-app/src/popup.js');
  for (const lang of ['zh', 'en']) {
    const common = Object.keys(E[lang]).filter(k => k in D[lang]);
    const diff = common.filter(k => E[lang][k] !== D[lang][k]);
    assert.deepEqual(diff, ['a11y.login'], lang + ' 不应再有其他共键差异：' + diff.join(', '));
  }
  /* 上一轮遗留的两个提示文案已对齐 */
  assert.equal(E.zh['auto.cardIntervalHint'], D.zh['auto.cardIntervalHint']);
  assert.equal(E.zh['auto.enableHint'], D.zh['auto.enableHint']);
});

test('v3.4 · 所有 t(\'key\') 调用（含共享模块）都能在字典命中', () => {
  for (const [name, js] of PAIRS) {
    const I18N = dictionaries(js);
    const miss = tKeys(js).filter(k => !(k in I18N.zh));
    assert.deepEqual(miss, [], name + ' t() 缺 zh 键：' + miss.join(', '));
  }
  for (const p of ['shared/hsa-calendar.js', 'shared/hsa-pull-refresh.js']) {
    const keys = [...read(p).matchAll(/\bt\('([^']+)'/g)].map(m => m[1]);
    for (const k of keys) {
      assert.ok(k in dictionaries('edge-extension/popup.js').zh,
        p + ' 用到插件版缺失的字典键 ' + k);
      assert.ok(k in dictionaries('desktop-app/src/popup.js').zh,
        p + ' 用到桌面版缺失的字典键 ' + k);
    }
  }
});

test('v3.4 · applyI18n 护栏：字典缺键时保留 HTML 静态文案，不写 key 原文', () => {
  for (const [name, js] of PAIRS) {
    const s = read(js);
    assert.match(s, /const hasI18n = key =>/, name + ' 缺少 hasI18n');
    assert.match(s, /if \(hasI18n\(el\.dataset\.i18n\)\) el\.textContent/,
      name + ' data-i18n 循环未走护栏');
    assert.match(s, /if \(hasI18n\(el\.dataset\.i18nTitle\)\) el\.title/,
      name + ' data-i18n-title 循环未走护栏');
    /* 动态执行 t / hasI18n：补齐后的键返回文案；故意删掉键时 hasI18n=false */
    const I18N = dictionaries(js);
    delete I18N.zh['lang.zh'];
    delete I18N.en['lang.zh'];
    const start = s.indexOf('const t = (key, vars) =>');
    const end = s.indexOf('function applyI18n()', start);
    const ctx = { I18N, lang: 'zh' };
    vm.runInNewContext(s.slice(start, end) + '\nglobalThis.__t = t; globalThis.__has = hasI18n;', ctx);
    assert.equal(ctx.__has('lang.zh'), false, name + ' 缺键时 hasI18n 应为 false');
    assert.equal(ctx.__has('lang.system'), true, name + ' 已有键 hasI18n 应为 true');
    // 恢复真实源码时（不删键）t('lang.zh') 必须返回「中文」而非 key
    const I2 = dictionaries(js);
    const ctx2 = { I18N: I2, lang: 'zh' };
    vm.runInNewContext(s.slice(start, end) + '\nglobalThis.__t = t; globalThis.__has = hasI18n;', ctx2);
    assert.equal(ctx2.__t('lang.zh'), '中文', name + ' t(lang.zh) 应返回中文');
    assert.equal(ctx2.__t('lang.en'), 'English', name + ' t(lang.en) 应返回 English');
  }
});

test('v3.4 · HTML 静态文案不是 key 形状（护栏兜底显示的正确文本）', () => {
  for (const [name, , html] of PAIRS) {
    const s = read(html);
    assert.match(s, /data-i18n="lang\.zh"[^>]*>中文</, name + ' 中文按钮静态文案');
    assert.match(s, /data-i18n="lang\.en"[^>]*>English</, name + ' 英文按钮静态文案');
    assert.doesNotMatch(s, />lang\.zh</, name + ' 不得把 key 当静态文案');
    assert.doesNotMatch(s, />lang\.en</, name + ' 不得把 key 当静态文案');
  }
});
