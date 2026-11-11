/* ============================================================================
 * v1.3.8-s1 · Bing Rewards 侧栏积分卡片识别 / 点击计划
 *
 * 自动完成任务时改为在 cn.bing.com/rewards/panelflyout 侧栏点卡片：
 *   ① 开始时先同步积分状态（desktopSyncRewards 写 todayTasks / taskClickIndex）
 *   ② 打开侧栏，扫描渲染后的 DOM，识别「真正提供积分」的卡片
 *   ③ 跳过已完成任务卡开启时只点未完成卡；关闭时点所有积分卡（含已完成）
 *   ④ 搜索、推荐、兑换、推广、0 分卡片一律不进入点击计划
 *   ⑤ 仍然只用 CDP 真鼠标事件点击，不用 el.click() / 合成 MouseEvent
 *
 * 本模块刻意不 require('electron')，主进程与离线回归脚本共用同一份识别逻辑。
 * SIDEBAR_SCAN_SOURCE / sidebarAimSource 都是自包含源码字符串，可直接注入页面。
 * ========================================================================== */
'use strict';

const SIDEBAR_FLYOUT_URLS = [
  'https://cn.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards',
  'https://www.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards'
];

/** 上传的测试侧栏（保存页的 iframe 内容），离线验证脚本会加载它。 */
const SIDEBAR_FIXTURE_REL = 'tests/必应任务侧栏 · 拟人搜索助手_files/panelflyout.html';

/* --------------------------------------------------------------------------
 * 注入到侧栏页面：扫描全部 a[href] 卡片，逐张判分、判完成、判「不给分」类型。
 * 不依赖任何外部变量 / 网络请求；结果按 DOM 顺序返回，并给元素打稳定序号。
 * ------------------------------------------------------------------------ */
const SIDEBAR_SCAN_SOURCE = String.raw`(() => {
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const norm = s => clean(s).replace(/[\s\u3000]+/g, '').toLowerCase();
  const abs = v => { try { return new URL(String(v || ''), location.href).href; } catch { return String(v || ''); } };
  const num = v => { const m = String(v || '').match(/\d[\d,]*/); return m ? Number(m[0].replace(/,/g, '')) : 0; };

  /* 侧栏里这些入口本身不能通过「点一下」获得积分 */
  const REDEEM_URL = /\/redeem(?:\/|[?#]|$)|rewards\.microsoft\.com\/redeem/i;
  const REFERRAL_URL = /\/referandearn(?:\/|[?#]|$)|ref=recommendedsku/i;
  const SEARCH_COUNTER = /[?&]form=RWSE01|在\s*(?:Microsoft\s*)?(?:必应|Bing)\s*上搜索|每天继续搜索|你已获得\s*\d+\s*积分|使用必应搜索\s*\(|Search\s*(?:and\s*)?Earn/i;
  const REFERRAL_TEXT = /推荐|邀请|分享给?好友|refer(?:ral)?|RAF/i;
  const REDEEM_TEXT = /兑换|奖品|礼品卡|自动兑换|redeem/i;
  const PROMO_TEXT = /即时赢奖|赢取惊喜|活动现已开启|sweepstakes|giveaway|推广/i;
  /* 顶部签到进度条 / 每日集进度不是任务卡：它们会写出一串 +3 / +30，
     必须和真正带积分徽章的任务卡区分开，否则会把进度条当成卡片点开。 */
  const PROGRESS_TEXT = /每日集|使用必应搜索|checkins|stepbar|\(\d+\/\d+\s*(?:搜索|活动)\)|form=ML2PCO/i;

  const candidates = [...document.querySelectorAll('a[href]')].filter(el => {
    if (!el || !el.getBoundingClientRect) return false;
    const raw = el.getAttribute('href') || '';
    if (!raw || /^(?:javascript:|#|mailto:|tel:)/i.test(raw)) return false;
    /* 卡片内还有 CTA 小链接时只认外层整卡，避免同一张卡被算两次 */
    if (el.parentElement && el.parentElement.closest('a[href]')) return false;
    return true;
  });

  const cards = [];
  for (const el of candidates) {
    const text = clean(el.innerText || el.textContent).slice(0, 400);
    const href = abs(el.getAttribute('href'));
    const titleEl = el.querySelector('.promo-title, .b_card_header, .b_hva_title, [class*="promo-title"], h3, h4');
    const name = clean(titleEl && (titleEl.innerText || titleEl.textContent))
      || clean(el.getAttribute('title')) || text.split(' ')[0] || '';

    /* 积分徽标：.point_cont > .shortPoint，兼容「10 积分」「10 添加到帐户的积分」 */
    const badge = el.querySelector('.point_cont, [class*="point_cont"]');
    const promoCard = el.querySelector('.promo_card, [class*="promo_card"]');
    const promoTitle = el.querySelector('.promo-title, [class*="promo-title"]');
    let badgeAria = '';
    let points = 0;
    if (badge) {
      const short = badge.querySelector('.shortPoint, [class*="shortPoint"]') || badge;
      badgeAria = String(short.getAttribute('aria-label') || badge.getAttribute('aria-label') || '');
      points = num(clean(short.innerText || short.textContent));
      if (!points) points = num(badgeAria);
      if (!points) points = num(clean(badge.innerText || badge.textContent));
    } else {
      /* 没有徽章时只有「整张 promo 卡 + 唯一一个 +N」才算给分卡；
         签到进度条一串 +3/+30、纯导航锚点一律不算。 */
      const plusAll = text.match(/(?:\+|＋)\s*\d{1,4}(?!\d)/g) || [];
      if (promoCard && promoTitle && plusAll.length === 1) points = num(plusAll[0]);
    }

    /* 完成态：.complete 容器 / 勾号 SVG / 「已添加到帐户」徽标 / 已完成文案 */
    const completeWrap = badge ? (badge.closest('.complete, [class*="complete"]') || null) : null;
    const checkMark = !!(badge && badge.querySelector('svg.checkMark, svg[class*="checkMark"], svg[class*="check"]'));
    const earnedAria = /添加到帐户的积分|added to (?:your )?account|points added/i.test(badgeAria);
    const completeText = /已完成|已领取|已获得|completed|claimed/i.test(text);
    const completed = !!(completeWrap || checkMark || earnedAria || (badge && completeText));

    /* 不给分卡片：搜索配额 / 推荐邀请 / 兑换奖品 / 推广活动 / 进度条 / 0 分 */
    const isSearch = SEARCH_COUNTER.test(text) || SEARCH_COUNTER.test(href);
    const isReferral = REFERRAL_URL.test(href) || REFERRAL_TEXT.test(name) || REFERRAL_TEXT.test(text);
    const isRedeem = REDEEM_URL.test(href) || REDEEM_TEXT.test(name) || REDEEM_TEXT.test(text);
    const isPromo = PROMO_TEXT.test(text) || /aka\.ms\/.+promo/i.test(href);
    const isProgress = PROGRESS_TEXT.test(text) || PROGRESS_TEXT.test(href);
    const nonTaskUrl = REDEEM_URL.test(href) || REFERRAL_URL.test(href) || /ref=recommendedsku/i.test(href);
    /* 真正给分卡必须落在 .promo_card 容器内：搜索配额、签到进度条、
       推荐/兑换/推广入口都没有这个容器，或积分徽章为 0。 */
    const scored = points > 0 && !!promoCard && !nonTaskUrl && !isPromo;
    let kind = 'task';
    let excludedReason = '';
    if (!scored) {
      kind = isPromo ? 'promotion'
        : isRedeem ? 'redeem'
        : isReferral ? 'referral'
        : isSearch ? 'search'
        : isProgress ? 'progress' : 'no-points';
      excludedReason = points > 0 ? 'non-scored-card' : kind;
    }

    const idx = cards.length;
    el.setAttribute('data-hsa-sidebar-idx', String(idx));
    cards.push({
      idx: idx,
      name: String(name).slice(0, 120),
      text: text.slice(0, 200),
      href: href,
      target: String(el.getAttribute('target') || ''),
      points: Number(points) || 0,
      completed: !!completed,
      kind: kind,
      excludedReason: excludedReason,
      scored: scored,
      badgeAria: badgeAria.slice(0, 120)
    });
  }
  return {
    url: String(location.href),
    at: Date.now(),
    total: cards.length,
    scoredCount: cards.filter(c => c.scored).length,
    excludedCount: cards.filter(c => !c.scored).length,
    cards: cards
  };
})()`;

/** 用「序号 → href → 标题」三级定位，滚入视口后做 elementFromPoint 命中检查。 */
function sidebarAimSource(card) {
  const want = JSON.stringify({
    idx: Number(card && card.idx),
    name: String((card && card.name) || ''),
    href: String((card && card.href) || ''),
    points: Number(card && card.points) || 0
  });
  return String.raw`(() => {
    const want = ` + want + `;
    const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const abs = v => { try { return new URL(String(v || ''), location.href).href; } catch { return String(v || ''); } };
    let el = document.querySelector('a[data-hsa-sidebar-idx="' + want.idx + '"]');
    if (!el) {
      const all = [...document.querySelectorAll('a[href]')];
      el = all.find(a => abs(a.getAttribute('href')) === want.href)
        || all.find(a => clean(a.innerText || a.textContent).indexOf(want.name) >= 0);
    }
    if (!el) return { ok: false, reason: 'sidebar-card-missing' };
    const href = abs(el.getAttribute('href') || '');
    const text = clean(el.innerText || el.textContent);
    if (want.href && href && href !== want.href && text.indexOf(want.name) < 0) {
      return { ok: false, reason: 'sidebar-card-mismatch', href: href };
    }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const left = Math.max(0, r.left), top = Math.max(0, r.top);
    const right = Math.min(window.innerWidth, r.right), bottom = Math.min(window.innerHeight, r.bottom);
    if (right - left < 8 || bottom - top < 8) return { ok: false, reason: 'sidebar-card-outside-viewport' };
    const tries = [
      [(left + right) / 2, (top + bottom) / 2],
      [left + (right - left) * 0.35, top + (bottom - top) * 0.35],
      [left + (right - left) * 0.65, top + (bottom - top) * 0.35],
      [left + (right - left) * 0.35, top + (bottom - top) * 0.65],
      [left + (right - left) * 0.65, top + (bottom - top) * 0.65]
    ];
    let point = null;
    for (const [x, y] of tries) {
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) { point = [x, y]; break; }
    }
    if (!point) return { ok: false, reason: 'sidebar-card-covered' };
    return {
      ok: true, x: point[0], y: point[1], href: href,
      target: String(el.getAttribute('target') || ''),
      name: want.name, points: want.points,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      strategy: 'sidebar-card'
    };
  })()`;
}

/**
 * 纯函数：完成状态**只由主界面任务状态**决定。
 *
 * 用户明确要求：点哪张卡片不以下拉侧栏上显示的「已完成 / 未完成」为依据，
 * 而取决于主界面上的任务状态，即开始时同步得到的
 *   · todayTasks.items（主界面「今日任务」列表，最权威）
 *   · taskClickIndex.items（同一批同步建立的定位索引，作为补充）
 * 侧栏 DOM 的 .complete / 勾号 / 已入账文案只保留成 domCompleted 诊断字段，
 * 绝不参与点击决策；同步里查不到的卡片一律按「未完成」处理（保守多点不漏）。
 * 这样即使侧栏显示滞后或被改过，点击清单仍与积分同步结果一致。
 */
function mergeSidebarWithSync(cards, syncSummary, clickIndex) {
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  /* 同步索引在前、主界面今日任务在后：同名时主界面状态覆盖索引状态。 */
  const rows = []
    .concat(clickIndex && Array.isArray(clickIndex.items) ? clickIndex.items : [])
    .concat(syncSummary && Array.isArray(syncSummary.items) ? syncSummary.items : []);
  const byName = new Map();
  for (const it of rows) {
    if (!it) continue;
    const key = norm(it.name || it.title || '');
    if (!key) continue;
    const points = Number(it.points) || 0;
    const completed = !!(it.completed || (points > 0 && Number(it.earned) >= points));
    byName.set(key, { completed: completed, points: points });
  }
  const findState = key => {
    if (byName.has(key)) return byName.get(key);
    /* 名称略有出入时做一次双向包含匹配，仍只认同步侧的数据 */
    for (const [k, v] of byName) {
      if (k.length >= 4 && key.length >= 4 && (k.includes(key) || key.includes(k))) return v;
    }
    return null;
  };
  return (Array.isArray(cards) ? cards : []).map(c => {
    const m = findState(norm(c.name));
    const syncCompleted = !!(m && m.completed && (!m.points || !c.points || m.points === c.points));
    return Object.assign({}, c, {
      domCompleted: !!c.completed,        // 仅诊断：侧栏自己怎么显示
      syncMatched: !!m,                  // 是否在主界面任务状态里找到
      syncedCompleted: syncCompleted,
      syncCompleted: !!(m && m.completed),
      completed: syncCompleted            // 唯一决策字段：来自主界面任务状态
    });
  });
}

/** 纯函数：生成真实点击计划。skipCompleted=false 时点全部积分卡（含已完成）。 */
function planSidebarClicks(cards, skipCompleted) {
  /* 严格按侧栏 DOM 顺序（截图任务列表从上到下）执行：
     不按分组 / 积分 / 完成态 / 同步索引重排；分段滚动补齐的卡片也按 idx 归位。 */
  var domIndex = function (c, i) {
    var v = c && (c.idx != null ? c.idx : (c.domOrder != null ? c.domOrder : c.order));
    var n = Number(v);
    return Number.isFinite(n) ? n : i;
  };
  var ordered = (Array.isArray(cards) ? cards : []).slice()
    .map(function (c, i) { return { c: c, i: i, d: domIndex(c, i) }; })
    .sort(function (a, b) { return (a.d - b.d) || (a.i - b.i); })
    .map(function (x) { return x.c; });
  return ordered
    .filter(c => c && c.scored && Number(c.points) > 0 && (!skipCompleted || !c.completed))
    .map(c => ({
      idx: c.idx, name: c.name, points: c.points, completed: !!c.completed,
      href: c.href, target: c.target || '', kind: c.kind
    }));
}

module.exports = {
  SIDEBAR_FLYOUT_URLS: SIDEBAR_FLYOUT_URLS,
  SIDEBAR_FIXTURE_REL: SIDEBAR_FIXTURE_REL,
  SIDEBAR_SCAN_SOURCE: SIDEBAR_SCAN_SOURCE,
  sidebarAimSource: sidebarAimSource,
  mergeSidebarWithSync: mergeSidebarWithSync,
  planSidebarClicks: planSidebarClicks
};
