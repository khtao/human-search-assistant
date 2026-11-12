/* AUTO-GENERATED from shared/ — do not edit; run node scripts/sync-shared.js */
/* ============================================================================
 * hsa-geo.js · v3.9 地理位置一致性
 *
 *   让出口 IP、时区、语言、搜索市场(mkt)、当地作息互相自洽。
 *   风控最容易抓的一类「不一致」：
 *     · IP 在广州，浏览器时区却是 America/New_York
 *     · 时区 Asia/Shanghai，Accept-Language 却是 en-US
 *     · Bing 的 mkt=zh-CN，但请求来自境外 IP
 *     · 当地凌晨 3 点还在高频搜索（作息不合理）
 *   本模块探测出口 IP 的真实地理位置，推导出一整套自洽参数，并在 selftest
 *   里逐项校验是否冲突。探测失败时优雅降级到系统时区/语言，不让脚本跑不起来。
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HSA_GEO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SOURCES = Object.freeze([
    'https://ipwho.is/',
    'https://ipapi.co/json/'
  ]);
  var COUNTRY_PROFILE = Object.freeze({
    CN: { lang: 'zh', locale: 'zh-CN', mkt: 'zh-CN', tz: /^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)/ },
    TW: { lang: 'zh', locale: 'zh-TW', mkt: 'zh-TW', tz: /^Asia\/Taipei/ },
    HK: { lang: 'zh', locale: 'zh-HK', mkt: 'zh-HK', tz: /^Asia\/Hong_Kong/ },
    US: { lang: 'en', locale: 'en-US', mkt: 'en-US', tz: /^America\// },
    GB: { lang: 'en', locale: 'en-GB', mkt: 'en-GB', tz: /^Europe\/London/ },
    JP: { lang: 'ja', locale: 'ja-JP', mkt: 'ja-JP', tz: /^Asia\/Tokyo/ },
    KR: { lang: 'ko', locale: 'ko-KR', mkt: 'ko-KR', tz: /^Asia\/Seoul/ },
    DE: { lang: 'de', locale: 'de-DE', mkt: 'de-DE', tz: /^Europe\/Berlin/ },
    FR: { lang: 'fr', locale: 'fr-FR', mkt: 'fr-FR', tz: /^Europe\/Paris/ },
    SG: { lang: 'en', locale: 'en-SG', mkt: 'en-SG', tz: /^Asia\/Singapore/ },
    AU: { lang: 'en', locale: 'en-AU', mkt: 'en-AU', tz: /^Australia\// },
    CA: { lang: 'en', locale: 'en-CA', mkt: 'en-CA', tz: /^America\/(Toronto|Vancouver|Montreal)/ }
  });
  var TZ_COUNTRY = Object.freeze([
    [/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)/, 'CN'],
    [/^Asia\/Taipei/, 'TW'], [/^Asia\/Hong_Kong/, 'HK'],
    [/^America\//, 'US'], [/^Europe\/London/, 'GB'],
    [/^Asia\/Tokyo/, 'JP'], [/^Asia\/Seoul/, 'KR'],
    [/^Europe\/Berlin/, 'DE'], [/^Europe\/Paris/, 'FR'],
    [/^Asia\/Singapore/, 'SG'], [/^Australia\//, 'AU']
  ]);

  /** 兼容两种公开出口 IP 服务的字段。 */
  function parse(payload) {
    if (!payload || typeof payload !== 'object' || payload.success === false) return null;
    var tz = (payload.timezone && typeof payload.timezone === 'object')
      ? String(payload.timezone.id || '') : String(payload.timezone || '');
    var country = String(payload.country_code || payload.countryCode || '').toUpperCase();
    var langs = String(payload.languages || payload.language || '');
    return {
      ip: String(payload.ip || ''),
      country: country,
      city: String(payload.city || ''),
      countryName: String(payload.country_name || payload.country || ''),
      timezone: tz,
      languages: langs ? langs.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : []
    };
  }

  /** 由 IANA 时区算 UTC 偏移分钟；失败返回 fallback。 */
  function tzOffsetMinutes(tz, fallbackMinutes) {
    var fb = Number(fallbackMinutes);
    if (!Number.isFinite(fb)) fb = 0;
    if (!tz) return fb;
    try {
      var parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date());
      var name = parts.filter(function (p) { return p.type === 'timeZoneName'; })
        .map(function (p) { return p.value; }).join('');
      var m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
      if (m) {
        var sign = m[1] === '-' ? -1 : 1;
        return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
      }
    } catch (e) {}
    return fb;
  }

  /** 系统降级：Intl 时区 + navigator.language，绝不因为探测失败中断运行。 */
  function fallback(navLanguage, intlTz, nowMs) {
    var lang = String(navLanguage || 'zh-CN');
    var tz = String(intlTz || '');
    if (!tz) {
      try { tz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch (e) { tz = 'Asia/Shanghai'; }
    }
    var country = '';
    for (var i = 0; i < TZ_COUNTRY.length; i++) {
      if (TZ_COUNTRY[i][0].test(tz)) { country = TZ_COUNTRY[i][1]; break; }
    }
    var prof = COUNTRY_PROFILE[country];
    var locale = prof ? prof.locale : (lang || 'en-US');
    return {
      source: 'system', ip: '', country: country, city: '', timezone: tz,
      tzOffsetMinutes: tzOffsetMinutes(tz, 480), locale: locale,
      acceptLanguage: locale + ',' + locale.split('-')[0] + ';q=0.9',
      mkt: prof ? prof.mkt : locale,
      activeHours: [7, 23], probedAt: Number(nowMs) || Date.now(),
      degraded: true, note: '出口 IP 探测失败，已降级到系统时区/语言'
    };
  }

  /** 由出口 IP 结果推导整套自洽参数；无法解析时降级。 */
  function derive(payload, fb, nowMs) {
    var sys = fb || fallback('zh-CN', 'Asia/Shanghai', nowMs);
    var p = parse(payload);
    if (!p || !p.country || !p.timezone) return sys;
    var prof = COUNTRY_PROFILE[p.country];
    var locale = prof ? prof.locale
      : (p.languages.length ? p.languages[0] : sys.locale);
    var mkt = prof ? prof.mkt : locale;
    var first = locale.split('-')[0];
    return {
      source: 'ip', ip: p.ip, country: p.country, city: p.city,
      countryName: p.countryName, timezone: p.timezone,
      tzOffsetMinutes: tzOffsetMinutes(p.timezone, sys.tzOffsetMinutes),
      locale: locale,
      acceptLanguage: locale + ',' + first + ';q=0.9',
      mkt: mkt, activeHours: [7, 23],
      probedAt: Number(nowMs) || Date.now(), degraded: false,
      note: '按出口 IP 推导时区 / 语言 / 搜索市场 / 当地作息'
    };
  }

  function localParts(nowMs, geo) {
    var off = Number(geo && geo.tzOffsetMinutes) || 0;
    var d = new Date((Number(nowMs) || Date.now()) + off * 60000);
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), day: d.getUTCDay() };
  }

  /** 当地作息：凌晨不高频搜索（拉长间隔，而不是停止任务）。 */
  function scheduleFactor(nowMs, geo) {
    var lp = localParts(nowMs, geo);
    var h = lp.hour, factor, period, zh, en;
    if (h >= 0 && h < 6) { factor = 2.4; period = 'deepNight'; zh = '当地深夜，拉长间隔'; en = 'Local deep night, slower pacing'; }
    else if (h === 6) { factor = 1.6; period = 'dawn'; zh = '当地清晨，节奏放缓'; en = 'Local dawn, slower pacing'; }
    else if (h >= 7 && h <= 22) { factor = 1.0; period = 'active'; zh = '当地正常作息'; en = 'Normal local hours'; }
    else { factor = 1.5; period = 'lateNight'; zh = '当地夜间，节奏放缓'; en = 'Local late night, slower pacing'; }
    return { factor: factor, period: period, localHour: h, localMinute: lp.minute, zh: zh, en: en };
  }

  /** 逐项校验冲突：IP 国家 ↔ 时区 ↔ 语言 ↔ mkt ↔ 当地作息。 */
  function crossCheck(geo, nowMs) {
    var g = geo || {}, conflicts = [], passed = [];
    var push = function (code, zh, en, ok) {
      (ok ? passed : conflicts).push({ code: code, zh: zh, en: en });
    };
    var prof = COUNTRY_PROFILE[g.country];
    var tzCountry = '';
    for (var i = 0; i < TZ_COUNTRY.length; i++) {
      if (TZ_COUNTRY[i][0].test(String(g.timezone || ''))) { tzCountry = TZ_COUNTRY[i][1]; break; }
    }
    push('ip-timezone', '出口 IP 国家与时区一致', 'IP country matches timezone',
      !tzCountry || !g.country || tzCountry === g.country);
    var lang = String(g.locale || '').split('-')[0];
    push('timezone-language', '时区与语言一致', 'Timezone matches language',
      !prof || !lang || prof.lang === lang);
    push('mkt-locale', '搜索市场与语言一致', 'Market matches locale',
      !g.mkt || !g.locale || String(g.mkt) === String(g.locale));
    var mktCountry = String(g.mkt || '').split('-')[1];
    push('mkt-ip-country', '搜索市场国家与出口 IP 一致', 'Market country matches IP country',
      !mktCountry || !g.country || mktCountry === g.country);
    var sf = scheduleFactor(nowMs, g);
    push('local-hours', '当地作息合理（深夜降速）', 'Local schedule plausible',
      sf.factor >= 1.0);
    return { ok: conflicts.length === 0, conflicts: conflicts, passed: passed,
      schedule: sf, fields: { country: g.country, timezone: g.timezone,
        locale: g.locale, mkt: g.mkt, source: g.source, degraded: !!g.degraded } };
  }

  /** 探测：依次尝试公开源；全部失败返回系统降级，绝不抛异常。 */
  async function probe(fetchImpl, fb, nowMs) {
    var sys = fb || fallback('zh-CN', 'Asia/Shanghai', nowMs);
    if (typeof fetchImpl !== 'function') {
      return { geo: sys, source: 'system', error: 'no-fetch' };
    }
    for (var i = 0; i < SOURCES.length; i++) {
      try {
        var res = await fetchImpl(SOURCES[i], { cache: 'no-store' });
        if (!res || !res.ok) continue;
        var data = await res.json();
        var geo = derive(data, sys, nowMs);
        if (geo.source === 'ip') {
          return { geo: geo, source: SOURCES[i], check: crossCheck(geo, nowMs) };
        }
      } catch (e) { /* 单个源失败继续下一个 */ }
    }
    return { geo: sys, source: 'system', check: crossCheck(sys, nowMs),
      error: 'all-sources-failed-degraded' };
  }

  /** 给请求 URL 加上与出口地区一致的 mkt（只加参数，不改既有 URL 结构）。 */
  function withMarket(url, geo) {
    var u = String(url || '');
    var mkt = String(geo && geo.mkt || '');
    if (!mkt || !/^https?:\/\//i.test(u)) return u;
    try {
      var base = u.split('#')[0];
      var hash = u.indexOf('#') >= 0 ? u.slice(u.indexOf('#')) : '';
      var sep = base.indexOf('?') >= 0 ? '&' : '?';
      if (/([?&])mkt=/.test(base)) {
        return base.replace(/([?&])mkt=[^&]*/, '$1mkt=' + encodeURIComponent(mkt)) + hash;
      }
      return base + sep + 'mkt=' + encodeURIComponent(mkt) + hash;
    } catch (e) { return u; }
  }

  function selftest() {
    var good = derive({ success: true, ip: '113.108.x.x', country_code: 'CN',
      city: 'Guangzhou', timezone: { id: 'Asia/Shanghai' }, country: 'China' }, null, Date.now());
    var r1 = crossCheck(good, Date.now());
    var bad = derive({ success: true, ip: '8.8.8.8', country_code: 'US',
      city: 'Mountain View', timezone: { id: 'Asia/Shanghai' }, country: 'United States' }, null, Date.now());
    bad.locale = 'en-US'; bad.acceptLanguage = 'en-US,en;q=0.9'; bad.mkt = 'zh-CN';
    var r2 = crossCheck(bad, Date.now());
    var codes = r2.conflicts.map(function (c) { return c.code; });
    var degraded = derive(null, fallback('zh-CN', 'Asia/Shanghai', Date.now()), Date.now());
    var day = Date.UTC(2026, 10, 12, 4, 0, 0);   /* UTC 04:00 = 北京 12:00 */
    var night = Date.UTC(2026, 10, 11, 19, 0, 0); /* UTC 19:00 = 北京 03:00 */
    var fDay = scheduleFactor(day, good).factor;
    var fNight = scheduleFactor(night, good).factor;
    var mktUrl = withMarket('https://www.bing.com/?mkt=zh-CN', good);
    var ok = r1.ok && !r2.ok
      && codes.indexOf('ip-timezone') >= 0
      && codes.indexOf('mkt-ip-country') >= 0
      && degraded.source === 'system' && degraded.degraded === true
      && fNight > fDay && fDay === 1.0
      && mktUrl.indexOf('mkt=') >= 0;
    return { ok: ok, consistent: r1, brokenCodes: codes,
      degraded: degraded.source, dayFactor: fDay, nightFactor: fNight, marketUrl: mktUrl };
  }

  return {
    VERSION: '1.0.0', SOURCES: SOURCES, COUNTRY_PROFILE: COUNTRY_PROFILE,
    parse: parse, tzOffsetMinutes: tzOffsetMinutes, fallback: fallback,
    derive: derive, localParts: localParts, scheduleFactor: scheduleFactor,
    crossCheck: crossCheck, probe: probe, withMarket: withMarket,
    selftest: selftest
  };
});
