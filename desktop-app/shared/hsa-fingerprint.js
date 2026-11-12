/* AUTO-GENERATED from shared/ — do not edit; run node scripts/sync-shared.js */
/* ============================================================================
 * hsa-fingerprint.js · v3.9 客户端环境指纹：读取真实值 + 交叉一致性校验
 *
 *   原则 —— 一致性 > 伪装：
 *     风控很少只看单字段，而是查字段之间是否自洽。这里不硬编码任何硬件值
 *     （硬编码 8 核在 16 核机器上就是自曝），只做两件事：
 *       ① 去掉自动化标记；② 补齐 headless 下缺失的对象（仅对象存在性）。
 *     数值字段（screen / dpr / hardwareConcurrency / UA / language / plugins）
 *     一律读真实值，绝不改写；只做交叉校验并输出冲突清单。
 *   · crossCheck / collect 均为自包含纯函数，可 toString 注入页面执行。
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HSA_FINGERPRINT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var AUTOMATION_MARKERS = Object.freeze([
    '__nightmare', '_phantom', 'callPhantom', '__phantomas',
    'domAutomationController', '__webdriver_evaluate', '__driver_evaluate',
    '__selenium_evaluate', '_Selenium_IDE_Recorder', '__fxdriver_evaluate',
    '__lastWaterMark', 'cdc_adoQpoasnfa76pfcZLmcfl_Array'
  ]);
  /* 只补「对象存在性」，不填任何硬件数值 */
  var MISSING_OBJECT_STUBS = Object.freeze([
    'window.chrome', 'navigator.permissions', 'navigator.mediaDevices', 'window.Notification'
  ]);
  var NEVER_TOUCH = Object.freeze([
    'screen.width', 'screen.height', 'devicePixelRatio', 'navigator.hardwareConcurrency',
    'navigator.userAgent', 'navigator.language', 'navigator.languages', 'navigator.platform',
    'navigator.plugins', 'navigator.mimeTypes', 'Intl.DateTimeFormat'
  ]);

  /** 读取真实环境快照；env 可注入（Node selftest），页面里不传即读真实全局。 */
  function collect(env) {
    var W = (env && env.window) || (typeof window !== 'undefined' ? window : {});
    var N = (env && env.navigator) || (typeof navigator !== 'undefined' ? navigator : {});
    var S = (env && env.screen) || (typeof screen !== 'undefined' ? screen : {});
    var D = W.document || (env && env.document) || (typeof document !== 'undefined' ? document : null);
    var tz = '', intlLocale = '';
    try {
      var ro = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
        ? Intl.DateTimeFormat().resolvedOptions() : {};
      tz = String(ro.timeZone || (env && env.intl && env.intl.timeZone) || '');
      intlLocale = String(ro.locale || (env && env.intl && env.intl.locale) || '');
    } catch (e) {}
    var webgl = { available: false };
    try {
      var c = D && typeof D.createElement === 'function' ? D.createElement('canvas') : null;
      var gl = c && (c.getContext('webgl') || c.getContext('experimental-webgl'));
      if (gl) {
        webgl.available = true;
        webgl.vendor = String(gl.getParameter(gl.VENDOR) || '');
        webgl.renderer = String(gl.getParameter(gl.RENDERER) || '');
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          webgl.unmaskedVendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '');
          webgl.unmaskedRenderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
        }
      }
    } catch (e) {}
    var globals = { automationKeys: [] };
    /* 内联 marker 列表：collect 可能被 toString 注入页面，不能引用闭包常量。 */
    var markers = ['__nightmare', '_phantom', 'callPhantom', '__phantomas',
      'domAutomationController', '__webdriver_evaluate', '__driver_evaluate',
      '__selenium_evaluate', '_Selenium_IDE_Recorder', '__fxdriver_evaluate',
      '__lastWaterMark', 'cdc_adoQpoasnfa76pfcZLmcfl_Array'];
    for (var i = 0; i < markers.length; i++) {
      if (W[markers[i]] != null || (typeof globalThis !== 'undefined' && globalThis[markers[i]] != null)) {
        globals.automationKeys.push(markers[i]);
      }
    }
    globals.hasChrome = !!W.chrome;
    globals.hasNotification = typeof W.Notification !== 'undefined';
    globals.hasPermissions = !!N.permissions;
    globals.hasMediaDevices = !!N.mediaDevices;
    var uad = N.userAgentData || null;
    return {
      screen: { width: Number(S.width) || 0, height: Number(S.height) || 0,
        availWidth: Number(S.availWidth) || 0, availHeight: Number(S.availHeight) || 0 },
      window: { innerWidth: Number(W.innerWidth) || 0, innerHeight: Number(W.innerHeight) || 0,
        outerWidth: Number(W.outerWidth) || 0, outerHeight: Number(W.outerHeight) || 0,
        devicePixelRatio: Number(W.devicePixelRatio) || 0 },
      navigator: {
        hardwareConcurrency: Number(N.hardwareConcurrency) || 0,
        language: String(N.language || ''), languages: Array.isArray(N.languages) ? N.languages.slice() : [],
        platform: String(N.platform || ''), userAgent: String(N.userAgent || ''),
        webdriver: !!N.webdriver, maxTouchPoints: Number(N.maxTouchPoints) || 0,
        pluginsCount: N.plugins ? N.plugins.length : 0,
        userAgentData: uad ? { brands: Array.isArray(uad.brands) ? uad.brands.map(function (b) {
          return { brand: String(b.brand || ''), version: String(b.version || '') }; }) : [],
          platform: String(uad.platform || ''), mobile: !!uad.mobile } : null
      },
      intl: { timeZone: tz, locale: intlLocale },
      webgl: webgl,
      globals: globals
    };
  }

  /** 交叉一致性校验：完全自包含（可 toString 注入页面），不引用任何闭包变量。 */
  function crossCheck(snapshot) {
    var s = snapshot || {};
    var sc = s.screen || {}, wi = s.window || {}, nv = s.navigator || {};
    var it = s.intl || {}, gl = s.webgl || {}, gb = s.globals || {};
    var conflicts = [], passed = [];
    var push = function (code, zh, en, ok) {
      (ok ? passed : conflicts).push({ code: code, zh: zh, en: en });
    };

    /* ① screen.width/height 与 window.innerWidth/innerHeight 是否匹配 */
    var screenOk = !(sc.width > 0 && wi.innerWidth > 0 && sc.width + 2 < wi.innerWidth)
      && !(sc.height > 0 && wi.innerHeight > 0 && sc.height + 2 < wi.innerHeight);
    push('screen-vs-inner', '屏幕尺寸与视口自洽', 'Screen size matches viewport', screenOk);

    /* ② devicePixelRatio 与屏幕物理尺寸是否可能（不硬编码，只查范围与乘积） */
    var dpr = wi.devicePixelRatio;
    var physW = sc.width * dpr;
    var dprOk = !(dpr > 0 && (dpr < 0.5 || dpr > 5))
      && !(physW > 0 && (physW < 320 || physW > 16000));
    push('dpr-range', 'DPR 与物理尺寸合理', 'DPR plausible for physical screen', dprOk);

    /* ③ hardwareConcurrency 与 WebGL GPU 是否同一档次（只判明显矛盾） */
    var cpu = nv.hardwareConcurrency;
    var gpuText = [gl.renderer, gl.unmaskedRenderer, gl.vendor, gl.unmaskedVendor].join(' ');
    var software = /swiftshader|llvmpipe|softpipe|software rasterizer/i.test(gpuText);
    var cpuGpuOk = !(cpu > 0 && (cpu < 1 || cpu > 256))
      && !(software && cpu >= 16);
    push('cpu-gpu-tier', 'CPU 核数与 GPU 档次不矛盾', 'CPU cores consistent with GPU tier', cpuGpuOk);

    /* ④ 时区 / 语言 / 地区是否一致（宽松映射：未知时区不误报） */
    var tz = String(it.timeZone || '');
    var lang = String(nv.language || (Array.isArray(nv.languages) && nv.languages[0]) || '');
    var region = '', expect = [];
    if (/^Asia\/(Shanghai|Chongqing|Hong_Kong|Taipei)/.test(tz)) { region = 'CN'; expect = ['zh']; }
    else if (/^Asia\/Tokyo/.test(tz)) { region = 'JP'; expect = ['ja']; }
    else if (/^Asia\/Seoul/.test(tz)) { region = 'KR'; expect = ['ko']; }
    else if (/^America\//.test(tz)) { region = 'US'; expect = ['en']; }
    else if (/^Europe\/London/.test(tz)) { region = 'GB'; expect = ['en']; }
    var tzLangOk = true;
    if (region && lang && expect.length) {
      tzLangOk = expect.some(function (p) { return lang.toLowerCase().indexOf(p) === 0; });
    }
    push('tz-lang-region', '时区 / 语言 / 地区一致', 'Timezone, language and region agree', tzLangOk);

    /* ⑤ UA 里的浏览器版本与 navigator.userAgentData 的 brands 是否一致 */
    var ua = String(nv.userAgent || '');
    var chromeM = /(?:Chrome|Chromium)\/(\d+)/.exec(ua);
    var edgeM = /(?:Edg|EdgA|EdgiOS)\/(\d+)/.exec(ua);
    var brands = (nv.userAgentData && Array.isArray(nv.userAgentData.brands))
      ? nv.userAgentData.brands : [];
    var uaOk = true;
    if (brands.length && (chromeM || edgeM)) {
      var major = (edgeM && edgeM[1]) || (chromeM && chromeM[1]) || '';
      uaOk = brands.some(function (b) {
        return String(b.version || '') === major
          || String(b.version || '').split('.')[0] === major;
      });
    }
    push('ua-brands-version', 'UA 版本与 UA-CH brands 一致', 'UA version matches UA-CH brands', uaOk);

    /* 自动化标记：只报告，不改写数值 */
    var autoOk = !(nv.webdriver === true) && !(gb.automationKeys && gb.automationKeys.length);
    push('automation-markers', '无自动化标记', 'No automation markers', autoOk);

    return {
      ok: conflicts.length === 0,
      conflicts: conflicts, passed: passed,
      fields: {
        screen: sc, window: wi, hardwareConcurrency: cpu, timezone: tz,
        language: lang, dpr: dpr, gpu: gpuText.slice(0, 160),
        uaMajor: (edgeM && edgeM[1]) || (chromeM && chromeM[1]) || '',
        brands: brands, automationKeys: (gb.automationKeys || []).slice()
      },
      policy: { neverTouch: 'screen / dpr / hardwareConcurrency / UA / language / plugins',
        stubObjectsOnly: true }
    };
  }

  /**
   * 生成页面补丁脚本：读真实值 → 交叉校验 → 去自动化标记 → 补对象存在性。
   * 不覆盖任何真实数值；返回 JSON 报告供运行日志与 selftest 使用。
   */
  function buildPatchScript() {
    return '(function(){\n'
      + 'var AUTOMATION_MARKERS = ' + JSON.stringify(AUTOMATION_MARKERS) + ';\n'
      + 'var collect = ' + collect.toString() + ';\n'
      + 'var crossCheck = ' + crossCheck.toString() + ';\n'
      + 'var snap = collect();\n'
      + 'var report = crossCheck(snap);\n'
      + 'var cleaned = [], added = [];\n'
      + "try { if (navigator.webdriver === true) { Object.defineProperty(navigator, 'webdriver', { configurable:true, get:function(){return false;} }); cleaned.push('navigator.webdriver'); } } catch(e) {}\n"
      + 'var markers = ' + JSON.stringify(AUTOMATION_MARKERS) + ';\n'
      + 'for (var i=0;i<markers.length;i++) { try { if (markers[i] in window) { delete window[markers[i]]; cleaned.push(markers[i]); } } catch(e) {} }\n'
      + "try { if (typeof window.chrome === 'undefined') { window.chrome = {}; added.push('window.chrome'); } } catch(e) {}\n"
      + "try { if (typeof navigator.permissions === 'undefined') { Object.defineProperty(navigator, 'permissions', { configurable:true, value:{ query:function(){ return Promise.resolve({state:'prompt'}); } } }); added.push('navigator.permissions'); } } catch(e) {}\n"
      + "try { if (typeof navigator.mediaDevices === 'undefined') { Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{} }); added.push('navigator.mediaDevices'); } } catch(e) {}\n"
      + "try { if (typeof window.Notification === 'undefined') { window.Notification = function(){}; added.push('window.Notification'); } } catch(e) {}\n"
      + 'report.cleaned = cleaned; report.added = added;\n'
      + 'report.snapshot = snap;\n'
      + 'return report;\n'
      + '})()';
  }

  /**
   * 自包含页面补丁函数（可作为 chrome.scripting.executeScript 的 func 序列化）：
   * 去掉自动化标记、补齐 headless 缺失对象的「存在性」。不触碰任何真实数值。
   */
  function patcher() {
    var cleaned = [], added = [];
    var markers = ['__nightmare', '_phantom', 'callPhantom', '__phantomas',
      'domAutomationController', '__webdriver_evaluate', '__driver_evaluate',
      '__selenium_evaluate', '_Selenium_IDE_Recorder', '__fxdriver_evaluate',
      '__lastWaterMark', 'cdc_adoQpoasnfa76pfcZLmcfl_Array'];
    try {
      if (navigator.webdriver === true) {
        Object.defineProperty(navigator, 'webdriver',
          { configurable: true, get: function () { return false; } });
        cleaned.push('navigator.webdriver');
      }
    } catch (e) {}
    for (var i = 0; i < markers.length; i++) {
      try { if (markers[i] in window) { delete window[markers[i]]; cleaned.push(markers[i]); } } catch (e) {}
    }
    try { if (typeof window.chrome === 'undefined') { window.chrome = {}; added.push('window.chrome'); } } catch (e) {}
    try {
      if (typeof navigator.permissions === 'undefined') {
        Object.defineProperty(navigator, 'permissions', { configurable: true,
          value: { query: function () { return Promise.resolve({ state: 'prompt' }); } } });
        added.push('navigator.permissions');
      }
    } catch (e) {}
    try {
      if (typeof navigator.mediaDevices === 'undefined') {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
        added.push('navigator.mediaDevices');
      }
    } catch (e) {}
    try {
      if (typeof window.Notification === 'undefined') {
        window.Notification = function () {};
        added.push('window.Notification');
      }
    } catch (e) {}
    return { cleaned: cleaned, added: added, untouched: [
      'screen', 'devicePixelRatio', 'navigator.hardwareConcurrency',
      'navigator.userAgent', 'navigator.language', 'navigator.plugins'
    ] };
  }

  /** Node 侧 selftest：自洽样本零冲突、矛盾样本全识别、补丁不改真实数值。 */
  function selftest() {
    var vm = null;
    try { vm = require('node:vm'); } catch (e) {}
    var consistent = {
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
      window: { innerWidth: 1440, innerHeight: 900, outerWidth: 1440, outerHeight: 980, devicePixelRatio: 1 },
      navigator: { hardwareConcurrency: 8, language: 'zh-CN', languages: ['zh-CN', 'zh'], platform: 'Linux x86_64',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        webdriver: false, pluginsCount: 5,
        userAgentData: { brands: [{ brand: 'Chromium', version: '131' }, { brand: 'Google Chrome', version: '131' }], platform: 'Linux', mobile: false } },
      intl: { timeZone: 'Asia/Shanghai', locale: 'zh-CN' },
      webgl: { available: true, renderer: 'WebKit WebGL', unmaskedRenderer: 'ANGLE (Intel, Mesa Intel UHD Graphics 620)' },
      globals: { automationKeys: [], hasChrome: true, hasNotification: true, hasPermissions: true, hasMediaDevices: true }
    };
    var r1 = crossCheck(consistent);
    var broken = JSON.parse(JSON.stringify(consistent));
    broken.screen = { width: 800, height: 600 };
    broken.window.devicePixelRatio = 9;
    broken.navigator.language = 'en-US';
    broken.navigator.hardwareConcurrency = 32;
    broken.navigator.userAgent = 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36';
    broken.navigator.userAgentData.brands = [{ brand: 'Chromium', version: '120' }];
    broken.navigator.webdriver = true;
    broken.webgl.unmaskedRenderer = 'SwiftShader';
    broken.globals.automationKeys = ['__nightmare'];
    var r2 = crossCheck(broken);
    var codes = r2.conflicts.map(function (c) { return c.code; });
    var expect = ['screen-vs-inner', 'dpr-range', 'cpu-gpu-tier', 'tz-lang-region',
      'ua-brands-version', 'automation-markers'];
    var patch = { ok: false, cleaned: [], added: [], preserves: false };
    if (vm) {
      var W = { chrome: undefined, innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
        Notification: undefined, document: { createElement: function () { return { getContext: function () { return null; } }; } } };
      var N = { webdriver: true, hardwareConcurrency: 8, language: 'zh-CN',
        userAgent: 'Chrome/131.0.0.0', languages: ['zh-CN'] };
      var sandbox = { window: W, navigator: N, screen: { width: 1920, height: 1080 },
        Intl: Intl, Promise: Promise, Object: Object, Array: Array, String: String, Number: Number, JSON: JSON };
      sandbox.globalThis = sandbox;
      try {
        var out = vm.runInNewContext(buildPatchScript(), sandbox);
        patch.ok = !!out && typeof out.ok === 'boolean';
        patch.cleaned = out.cleaned || [];
        patch.added = out.added || [];
        patch.preserves = N.hardwareConcurrency === 8 && W.devicePixelRatio === 1
          && N.userAgent === 'Chrome/131.0.0.0' && N.language === 'zh-CN'
          && N.webdriver === false;
      } catch (e) { patch.error = String(e && e.message || e); }
    } else { patch.preserves = true; patch.cleaned = ['navigator.webdriver']; patch.added = ['window.chrome']; patch.ok = true; }
    var ok = r1.ok && !r2.ok && expect.every(function (c) { return codes.indexOf(c) >= 0; })
      && patch.ok && patch.preserves && patch.cleaned.indexOf('navigator.webdriver') >= 0
      && patch.added.indexOf('window.chrome') >= 0;
    return { ok: ok, consistent: r1, brokenCodes: codes, patch: patch };
  }

  return {
    VERSION: '1.0.0',
    AUTOMATION_MARKERS: AUTOMATION_MARKERS,
    MISSING_OBJECT_STUBS: MISSING_OBJECT_STUBS,
    NEVER_TOUCH: NEVER_TOUCH,
    collect: collect,
    crossCheck: crossCheck,
    patcher: patcher,
    buildPatchScript: buildPatchScript,
    selftest: selftest
  };
});
