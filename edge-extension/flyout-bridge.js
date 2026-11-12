(() => {
  'use strict';
  if (window.__hsaFlyoutBridge) return;
  window.__hsaFlyoutBridge = true;

  if (!/\/rewards\/panelflyout/i.test(location.href)) return;

  const POINTS_RE = /\+\s*(\d[\d,]*)(?!\d)/;
  const POINTS_WORD_RE = /(\d[\d,]*)\s*(?:个|点|分)?\s*(?:积分|点数|points?)/i;
  const POINTS_EARN_RE = /(?:领取|赚取|获得|获取|赢取|奖励|解锁|earn|get)\s*(\d[\d,]*)\s*(?:个|点)?\s*(?:积分|点数|points?)/i;
  const pointsIn = t => {
    const str = String(t || '');
    const m = POINTS_RE.exec(str) || POINTS_WORD_RE.exec(str) || POINTS_EARN_RE.exec(str);
    if (!m) return 0;
    const n = parseInt(String(m[1]).replace(/,/g, ''), 10);
    return (n > 0 && n <= 99999) ? n : 0;
  };
  const DONE_RE = /已完成|已领取|已拿满|已获得|completed|claimed|offer completed/i;
  const NOT_DONE_RE = /\bnot\s+(?:completed|claimed)\b|未完成|待完成|尚.?未/i;
  const isDoneCard = (text, aria) => {
    const s = String(text || '') + ' ' + String(aria || '');
    return !NOT_DONE_RE.test(s) && DONE_RE.test(s);
  };
  const LOGIN_RE = /登录到 Microsoft 帐户|使用你的 Microsoft 帐户|Sign in to your Microsoft account|需要启用 JavaScript/i;
  const pageScriptTexts = () => {
    const out = [];
    try {
      const ss = deepAll(document, 'script');
      for (let i = 0; i < ss.length; i++) {
        const t = String(ss[i].textContent || '');
        if (!t || /__hsaFlyoutBridge|hsa-flyout|HSA_REALCLICK/i.test(t)) continue;
        out.push(t);
      }
    } catch (e) {}
    return out;
  };
  const shellSignedOut = () => {
    try {
      if (window.flyoutViewModel && window.flyoutViewModel.isRewardsUser === false) return true;
    } catch (e0) {}
    try {
      const texts = pageScriptTexts();
      for (let z = 0; z < texts.length; z++)
        if (/"isRewardsUser"\s*:\s*false|"nonuser"\s*:\s*"True"/i.test(texts[z])) return true;
    } catch (e1) {}
    return false;
  };

  const clean = el => String((el && (el.innerText || el.textContent)) || '')
    .replace(/\s+/g, ' ').trim();
  const absUrl = h => {
    const s = String(h || '').trim();
    if (!s || /^(?:javascript:|#|mailto:|tel:|about:)/i.test(s)) return '';
    try { return new URL(s, location.href).href; } catch { return s; }
  };

  const deepAll = (root, selector) => {
    const out = [];
    const walk = node => {
      if (!node) return;
      try { out.push.apply(out, node.querySelectorAll(selector)); } catch {}
      try {
        const all = node.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) if (all[i].shadowRoot) walk(all[i].shadowRoot);
      } catch {}
    };
    walk(root || document);
    return out;
  };

  const topRect = el => {
    const r = el.getBoundingClientRect();
    let ox = 0, oy = 0;
    try {
      if (window.top !== window && window.frameElement) {
        const fr = window.frameElement.getBoundingClientRect();
        ox = fr.left; oy = fr.top;
      }
    } catch {}
    return { x: r.left + ox, y: r.top + oy, w: r.width, h: r.height };
  };

  const scrollOuter = y => {
    try { window.scrollTo(0, y); } catch {}
    try { document.documentElement.scrollTop = y; } catch {}
    try { document.body.scrollTop = y; } catch {}
    const h = Math.max(document.body.scrollHeight || 0,
      document.documentElement.scrollHeight || 0, 800);
    return { ok: true, y: window.scrollY || 0, scrollHeight: h,
      viewport: window.innerHeight || 700, url: location.href };
  };

  const scrollerEls = () => {
    const all = deepAll(document, '*'), out = [];
    for (let i = 0; i < all.length && i < 6000; i++) {
      const el = all[i];
      if (!el || el === document.body || el === document.documentElement) continue;
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      let st = null;
      try { st = window.getComputedStyle(el); } catch { continue; }
      if (!st || !/auto|scroll/i.test(st.overflowY || '')) continue;
      try { el.setAttribute('data-yb-scroller', String(out.length)); } catch {}
      out.push(el);
    }
    return out;
  };
  const scrollers = () => {
    const els = scrollerEls(), out = [];
    for (let i = 0; i < els.length; i++) {
      const el = els[i], max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (max <= 0) continue;
      const r = el.getBoundingClientRect();
      out.push({ idx: i, max, view: el.clientHeight || 400,
        scrollTop: el.scrollTop || 0,
        top: Math.round(r.top), left: Math.round(r.left),
        w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) });
    }
    return { ok: true, scrollers: out, url: location.href };
  };
  const findScroller = idx => {
    const all = deepAll(document, '[data-yb-scroller]');
    for (let i = 0; i < all.length; i++)
      if (all[i].getAttribute('data-yb-scroller') === String(idx)) return all[i];
    return scrollerEls()[idx] || null;
  };
  const scrollInner = (idx, y) => {
    const el = findScroller(idx);
    if (!el) return { ok: false, reason: 'no-scroller', idx };
    try { el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, y)); } catch {}
    return { ok: true, idx, y: el.scrollTop,
      max: Math.max(0, el.scrollHeight - el.clientHeight) };
  };

  const httpUrl = u => {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  };
  let vmCache = null, vmTried = false;
  const readViewModel = () => {
    if (vmTried) return vmCache;
    vmTried = true;
    try {
      if (window.flyoutViewModel && window.flyoutViewModel.flyoutResult)
        vmCache = window.flyoutViewModel.flyoutResult;
    } catch (e0) {}
    if (!vmCache) {
      const texts = pageScriptTexts();
      for (let i = 0; i < texts.length; i++) {
        try {
          const t = texts[i];
          const at = t.indexOf('flyoutViewModel');
          if (at < 0) continue;
          const eqSign = t.indexOf('=', at);
          if (eqSign < 0 || eqSign - at > 60) continue;
          const eq = t.indexOf('{', eqSign);
          if (eq < 0) continue;
          let d = 0, k = eq, instr = false, esc = false;
          while (k < t.length) {
            const c = t.charAt(k);
            if (instr) {
              if (esc) esc = false;
              else if (c === '\\') esc = true;
              else if (c === '"') instr = false;
            } else {
              if (c === '"') instr = true;
              else if (c === '{') d++;
              else if (c === '}') { d--; if (!d) { k++; break; } }
            }
            k++;
          }
          if (d !== 0) continue;
          const obj = JSON.parse(t.slice(eq, k));
          if (obj && obj.flyoutResult) { vmCache = obj.flyoutResult; break; }
        } catch (eParse) { continue; }
      }
    }
    return vmCache;
  };

  let officialCache = null;
  const officialTasks = () => {
    if (officialCache && officialCache.length) return officialCache;
    const fr = readViewModel(), out = [], seen = {};
    if (!fr) return out;
    const visit = (o, depth) => {
      if (!o || depth > 8 || out.length > 200) return;
      if (Array.isArray(o)) { for (let i = 0; i < o.length && i < 100; i++) visit(o[i], depth + 1); return; }
      if (typeof o !== 'object') return;
      const url = httpUrl(o.destinationUrl || o.destination || o.link || '');
      const title = String(o.title || o.showcaseTitle || o.description || '');
      const max = Number(o.pointProgressMax || o.pointsMax || 0);
      if (url && max > 0) {
        const key = String(o.offerId || url);
        if (!seen[key]) {
          seen[key] = 1;
          out.push({ offerId: String(o.offerId || ''), title, url,
            points: max, complete: !!o.complete,
            promotionType: String(o.promotionType || o.type || ''),
            isHidden: !!o.isHidden });
        }
        return;
      }
      for (const key in o) if (Object.prototype.hasOwnProperty.call(o, key)) visit(o[key], depth + 1);
    };
    visit(fr, 0);
    officialCache = out;
    return out;
  };
  const normText = s => String(s || '').toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 60);
  const matchOfficial = text => {
    const t = normText(text);
    if (t.length < 3) return '';
    const list = officialTasks();
    for (const o of list) {
      const n = normText(o.title);
      if (n && (t.indexOf(n) >= 0 || n.indexOf(t) >= 0)) return o.url;
    }
    return '';
  };

  /* v3.5 · 点击清单严格由预设任务列表决定，页面扫描只负责定位：
     不再按 URL / 标题把「将推荐转化为奖励」这类有积分卡排除。
     只保留结构识别（必须是 http(s) 链接、有标题、有可点矩形）。 */
  const EXCLUDE_URL_RE = /^(?:javascript:|#|mailto:|tel:)/i;
  /* v3.6 · 不再按标题排除任何卡片；只做链接 / 标题 / 矩形的结构识别。 */
  const EXCLUDE_TITLE_RE = /$^/;
  const isTaskUrl = u => /^https?:\/\//i.test(String(u || ''))
    && !EXCLUDE_URL_RE.test(String(u || ''));

  const officialByTitle = title => {
    const t = normText(title);
    if (t.length < 2) return null;
    const list = officialTasks(), exact = [], loose = [];
    for (const o of list) {
      const n = normText(o.title);
      if (!n) continue;
      if (n === t) exact.push(o);
      else if (n.indexOf(t) >= 0 || t.indexOf(n) >= 0) loose.push(o);
    }
    const rank = (a, b) => (a.isHidden ? 1 : 0) - (b.isHidden ? 1 : 0);
    exact.sort(rank); loose.sort(rank);
    return exact[0] || loose[0] || null;
  };
  const hashStr = s => {
    let h = 5381;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  let mainTaskStates = null;      
  const mainTaskDone = title => {
    if (!mainTaskStates) return false;
    const t = normText(title);
    if (t.length < 2) return false;
    let loose = null;
    for (const st of mainTaskStates) {
      const n = normText(st.name);
      if (!n) continue;
      if (n === t) return !!st.completed;
      if (!loose && (n.indexOf(t) >= 0 || t.indexOf(n) >= 0)) loose = st;
    }
    return loose ? !!loose.completed : false;
  };

  const collectTaskCards = includeDone => {
    const out = [], skipped = [], seen = new Set();
    let containers = deepAll(document, 'div.promo_cont');
    if (!containers.length)
      containers = deepAll(document, 'a.block[href]').map(a => a.parentElement).filter(Boolean);
    for (let order = 0; order < containers.length; order++) {
      const box = containers[order];
      let anchor = null;
      try {
        anchor = box.tagName === 'A' ? box
          : (box.querySelector('a.block[href]') || box.querySelector('a[href]'));
      } catch { continue; }
      if (!anchor) continue;
      const url = httpUrl(absUrl(anchor.getAttribute('href') || ''));
      let titleEl = null;
      try { titleEl = box.querySelector('.promo-title,[class*="promo-title"]'); } catch {}
      const title = clean(titleEl || box).slice(0, 80)
        .replace(/\s*[-—]\s*Offer.*$/i, '').trim();
      if (!title || title.length < 2) continue;
      /* v3.5 · 只做结构识别：链接 + 标题；official 仅用于补积分，不删卡片。 */
      if (!isTaskUrl(url) || EXCLUDE_TITLE_RE.test(title)) continue;
      const official = officialByTitle(title);
      const aria = String(box.getAttribute('aria-label')
        || anchor.getAttribute('aria-label') || '');
      /* v3.5 · 完成态只做诊断，不决定是否点击。 */
      const done = mainTaskDone(title);
      const idx = 'yb-task-' + hashStr(normText(title) + '|' + url);
      if (seen.has(idx)) continue;
      seen.add(idx);
      try {
        anchor.setAttribute('data-yb-hidx', idx);
        box.setAttribute('data-yb-task', title);
      } catch {}
      let pts = 0;
      try {
        const badge = box.querySelector('.shortPoint');
        pts = parseInt(String(clean(badge) || '').replace(/[^\d]/g, ''), 10) || 0;
      } catch {}
      if (!pts && official) pts = official.points;
      const tr = topRect(anchor);
      if ((tr.w || 0) < 2 && (tr.h || 0) < 2) continue;
      out.push({
        idx, href: url, targetUrl: url, order, domOrder: order,
        text: title, title, points: pts, done,
        target: anchor.getAttribute('target') || '',
        tag: 'A', kind: 'task'
      });
    }
    return { cards: out, skipped };
  };

  const DATA_URL_ATTRS = ['data-url', 'data-href', 'data-destination',
    'data-destinationurl', 'data-link', 'data-bi-url', 'data-target-url',
    'data-bi-dlnm', 'href'];
  const resolveTarget = (card, text) => {
    const scopes = [card];
    let p = card;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) scopes.push(p);
    for (const s of scopes) {
      if (!s || !s.getAttribute) continue;
      const u = httpUrl(absUrl(s.getAttribute('href') || ''));
      if (u) return u;
    }
    try {
      const links = card.querySelectorAll ? card.querySelectorAll('a[href]') : [];
      for (let i = 0; i < links.length; i++) {
        const u = httpUrl(absUrl(links[i].getAttribute('href') || ''));
        if (u) return u;
      }
    } catch {}
    for (const s of scopes) {
      if (!s || !s.getAttribute) continue;
      for (const a of DATA_URL_ATTRS) {
        const u = httpUrl(absUrl(s.getAttribute(a) || ''));
        if (u) return u;
      }
    }
    return matchOfficial(text);
  };

  const CARD_MIN_W = 120, CARD_MIN_H = 50;
  const CARD_MAX_W = 700, CARD_MAX_H = 500;
  const isCardLike = (el, text) => {
    const r = el.getBoundingClientRect();
    if (r.width > CARD_MAX_W || r.height > CARD_MAX_H) return false;
    const t = String(el.tagName || '').toUpperCase();
    if (t === 'A' || t === 'BUTTON' || el.getAttribute('role') === 'button') return true;
    if (r.width < CARD_MIN_W || r.height < CARD_MIN_H) return false;
    const body = String(text || '').replace(/\+\s*\d[\d,]*/g, '')
      .replace(/\d[\d,]*\s*(?:个|点|分)?\s*(?:积分|点数|points?)/gi, '')
      .replace(/\s+/g, ' ').trim();
    return body.length >= 3;      
  };
  const scoreCards = includeDone => {
    const precise = collectTaskCards(includeDone);
    if (precise.cards.length || precise.skipped.length) return precise;
    const all = deepAll(document, '*');
    const out = [], skipped = [], seen = [];
    for (let i = 0; i < all.length && i < 12000; i++) {
      const el = all[i];
      const tag0 = String(el.tagName || '').toUpperCase();
      if (tag0 === 'SCRIPT' || tag0 === 'STYLE' || tag0 === 'NOSCRIPT'
          || tag0 === 'TEMPLATE' || tag0 === 'SVG') continue;
      let own = '';
      try {
        for (let n = 0; n < el.childNodes.length; n++) {
          const nd = el.childNodes[n];
          if (nd && nd.nodeType === 3) own += nd.nodeValue;
        }
      } catch { continue; }
      const pts = pointsIn(String(own).replace(/\s+/g, ' '));
      if (!(pts > 0)) continue;

      let card = null, p = el;
      for (let up = 0; up < 8 && p; up++, p = p.parentElement) {
        if (p === document.body || p === document.documentElement) break;
        const tag = p.tagName || '';
        if (tag === 'A' || tag === 'BUTTON' || p.getAttribute('role') === 'button'
            || p.getAttribute('onclick')) {
          if (isCardLike(p, clean(p))) { card = p; break; }
        }
      }
      if (!card) {
        p = el;
        for (let up2 = 0; up2 < 8 && p; up2++, p = p.parentElement) {
          if (p === document.body || p === document.documentElement) break;
          const pr0 = p.getBoundingClientRect();
          if (pr0.width < CARD_MIN_W || pr0.height < CARD_MIN_H) continue;
          if (!isCardLike(p, clean(p))) continue;
          try { if (/pointer/i.test(window.getComputedStyle(p).cursor)) { card = p; break; } } catch {}
        }
      }
      if (!card) {
        p = el.parentElement;
        for (let up3 = 0; up3 < 4 && p; up3++, p = p.parentElement) {
          if (p === document.body || p === document.documentElement) break;
          if (isCardLike(p, clean(p))) { card = p; break; }
        }
      }
      if (!card) continue;               
      if (seen.indexOf(card) >= 0) continue;
      seen.push(card);

      const text = clean(card);
      const aria = String(card.getAttribute('aria-label') || '');
      let legacyHref = '';
      try {
        legacyHref = card.tagName === 'A'
          ? String(card.getAttribute('href') || '')
          : String((card.querySelector && card.querySelector('a[href]')
              ? card.querySelector('a[href]').getAttribute('href') : '') || '');
      } catch {}
      if ((legacyHref && !isTaskUrl(httpUrl(absUrl(legacyHref))))
          || EXCLUDE_TITLE_RE.test(text)) continue;   /* v3.5：仅结构识别 */
      if (/^offer (not )?completed/i.test(aria) && !isCardLike(card, text)) continue;

      /* v3.5 · 完成态只做诊断，不决定是否点击。 */
      const done = mainTaskDone(text);
      const tr = topRect(card);
      if ((tr.w || 0) < 2 && (tr.h || 0) < 2) continue;
      const targetUrl = resolveTarget(card, text);
      const stable = String(targetUrl || text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const idx = 'yb-' + stable;
      if (stable) { try { card.setAttribute('data-yb-hidx', idx); } catch {} }
      out.push({
        idx, href: targetUrl, targetUrl, text: text.slice(0, 120),
        title: text.replace(/\+\s*\d[\d,]*/g, '').replace(/\s+/g, ' ').trim().slice(0, 48),
        points: pts, done,
        target: card.getAttribute('target') || '',
        tag: String(card.tagName || ''), kind: 'badge'
      });
    }
    return { cards: out, skipped };
  };

  const pick = (cards, payload) => {
    for (const c of cards) if (c.idx === payload.idx) return c;
    for (const c of cards) if (payload.href && c.href === payload.href) return c;
    for (const c of cards) if (payload.title && c.title === payload.title) return c;
    return null;
  };

  const info = () => {
    const body = clean(document.body);
    const res = scoreCards(true);
    return { ok: true, url: location.href, title: document.title || '',
      inIframe: window.top !== window,
      signedOut: LOGIN_RE.test(body)
        || /login\.live\.com|account\.live\.com/i.test(location.href)
        || shellSignedOut(),
      shellSignedOut: shellSignedOut(),
      hasFlyoutRoot: !!document.querySelector('#gb_fo_content, .panelFlyout'),
      cardsNow: res.cards.length,
      withTarget: res.cards.filter(c => !!c.targetUrl).length,
      officialTasks: officialTasks().length,
      bodyHead: body.slice(0, 160),
      scrollHeight: Math.max(document.body.scrollHeight || 0,
        document.documentElement.scrollHeight || 0, 800),
      viewport: window.innerHeight || 700 };
  };

  const scan = payload => {
    const res = scoreCards(!!payload.includeDone);
    return { ok: true, cards: res.cards, skipped: res.skipped,
      url: location.href, scrollY: window.scrollY || 0 };
  };

  const aim = payload => {
    const cards = scoreCards(!!payload.includeDone).cards;
    const c = pick(cards, payload);
    if (!c) return { ok: false, reason: 'not-found', total: cards.length };
    const el = cards.length && c.idx
      ? (deepAll(document, '[data-yb-hidx]').find(x => x.getAttribute('data-yb-hidx') === c.idx) || null)
      : null;
    if (el) { try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {} }
    const r = el ? topRect(el) : { x: 0, y: 0, w: 0, h: 0 };
    return { ok: true, idx: c.idx, title: c.title, points: c.points,
      href: c.href, tag: c.tag, rect: r, scrollY: window.scrollY || 0 };
  };

  const click = payload => {
    const cards = scoreCards(!!payload.includeDone).cards;
    const c = pick(cards, payload);
    if (!c) return { ok: false, reason: 'not-found', total: cards.length };
    const el = deepAll(document, '[data-yb-hidx]')
      .find(x => x.getAttribute('data-yb-hidx') === c.idx);
    if (!el) return { ok: false, reason: 'element-gone', idx: c.idx };
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const anchor = (el.closest && el.closest('a[href]')) || null;
    const isBlank = anchor && /_blank/i.test(anchor.getAttribute('target') || '');
    const blocker = e => {
      if (!isBlank && anchor) { try { e.preventDefault(); } catch {} }
    };
    try { el.addEventListener('click', blocker, { capture: true }); } catch {}
    let dispatched = 0;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try {
        const ev = type.indexOf('pointer') === 0
          ? new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: cx, clientY: cy, button: 0,
              buttons: type.slice(-4) === 'down' ? 1 : 0, isPrimary: true })
          : new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: cx, clientY: cy, button: 0, buttons: type === 'mousedown' ? 1 : 0, detail: 1 });
        el.dispatchEvent(ev); dispatched++;
      } catch {}
    }
    let native = false;
    try {
      const t = (el.closest && el.closest('a[href],button,[role="button"]')) || el;
      if (typeof t.click === 'function') { t.click(); native = true; }
    } catch {}
    try { el.removeEventListener('click', blocker, true); } catch {}
    return { ok: true, idx: c.idx, title: c.title, points: c.points,
      href: c.targetUrl || c.href, targetUrl: c.targetUrl || c.href,
      target: c.target, dispatched, native, blankAllowed: !!isBlank };
  };

  const installHoverTip = () => {
    const ID = 'hsa-hover-tip';
    if (document.getElementById(ID)) return;
    const style = document.createElement('style');
    style.setAttribute('data-hsa-tip-style', '1');
    style.textContent = [
      '*[data-sbtip]:not(.disableTooltip):hover::after,',
      '*[data-sbtip]:not(.disableTooltip):hover::before,',
      '*[data-sbtip].shtip:not(.disableTooltip)::after,',
      '*[data-sbtip].shtip:not(.disableTooltip)::before,',
      '[vptest]::after,[vptest]::before{content:none !important;display:none !important;}',
      '#' + ID + '{',
      '  position:fixed !important; inset:0 auto auto 0 !important;',
      '  z-index:2147483647 !important; display:none; box-sizing:border-box;',
      '  max-width:92vw; padding:6px 10px; margin:0 !important;',
      '  border:0 !important; border-radius:6px;',
      '  background:#111 !important; color:#fff !important;',
      '  font:12px/1.4 "Microsoft YaHei","Segoe UI",Arial,sans-serif !important;',
      '  white-space:nowrap !important; word-break:keep-all !important;',
      '  overflow:hidden; text-overflow:ellipsis;',
      '  box-shadow:0 6px 18px rgba(0,0,0,.28);',
      '  pointer-events:none !important;',
      '}'
    ].join('\n');
    try { (document.head || document.documentElement).appendChild(style); } catch {}
    const tip = document.createElement('div');
    tip.id = ID;
    tip.setAttribute('role', 'tooltip');
    if ('popover' in tip) { try { tip.setAttribute('popover', 'manual'); } catch {} }
    try { (document.documentElement || document.body).appendChild(tip); }
    catch { return; }

    const firstLine = v => String(v || '').split(/[\r\n]/)[0]
      .replace(/\s+/g, ' ').trim().slice(0, 160);
    const tipText = host => {
      let v = host.getAttribute('data-hsa-tip')
        || host.getAttribute('data-tip')
        || host.getAttribute('data-sbtip')
        || host.getAttribute('title') || '';
      if (!v) v = String(host.getAttribute('aria-label') || '')
        .replace(/\s*[-—]\s*Offer\s+(?:is\s+|not\s+)?Completed.*$/i, '');
      return firstLine(v);
    };
    let popoverOn = false;
    const show = () => {
      tip.style.display = 'block';
      if (!popoverOn && typeof tip.showPopover === 'function') {
        try { tip.showPopover(); popoverOn = true; } catch {}
      }
    };
    const hide = () => {
      if (popoverOn && typeof tip.hidePopover === 'function') {
        try { tip.hidePopover(); } catch {}
        popoverOn = false;
      }
      tip.style.display = 'none';
    };
    const place = (x, y) => {
      const w = tip.offsetWidth || 120, h = tip.offsetHeight || 26;
      let left = x + 14, top = y + 18;
      if (left + w > window.innerWidth - 8) left = x - w - 14;
      if (top + h > window.innerHeight - 8) top = y - h - 14;
      tip.style.left = Math.max(8, left) + 'px';
      tip.style.top = Math.max(8, top) + 'px';
    };
    const firstLineOfTitle = firstLine;
    const syncOne = el => {
      if (!el || !el.getAttribute) return;
      const v = String(el.getAttribute('title') || '');
      if (v.trim()) el.setAttribute('data-hsa-tip', firstLineOfTitle(v));
      try { el.removeAttribute('title'); } catch {}
    };
    const migrate = root => {
      let els = [];
      try { els = root.querySelectorAll ? root.querySelectorAll('[title]') : []; } catch {}
      for (let i = 0; i < els.length; i++) syncOne(els[i]);
      if (root.nodeType === 1) syncOne(root);
    };
    migrate(document);
    try {
      const mo = new MutationObserver(list => {
        for (const rec of list) {
          if (rec.type === 'attributes') syncOne(rec.target);
          else if (rec.addedNodes && rec.addedNodes.length) {
            for (const n of rec.addedNodes) if (n && n.nodeType === 1) migrate(n);
          }
        }
      });
      mo.observe(document.documentElement || document.body,
        { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
    } catch {}

    const HOST_SEL = '[data-hsa-tip],[data-tip],[data-sbtip],[aria-label],[title]';
    const hostOf = node => node && node.closest ? node.closest(HOST_SEL) : null;
    document.addEventListener('mouseover', e => {
      const host = hostOf(e.target);
      if (!host) return;
      const text = tipText(host);
      if (!text) return;
      tip.textContent = text;      
      show();
      place(e.clientX || 0, e.clientY || 0);
    }, true);
    document.addEventListener('mousemove', e => {
      if (tip.style.display === 'block') place(e.clientX || 0, e.clientY || 0);
    }, true);
    document.addEventListener('mouseout', e => {
      const host = hostOf(e.target);
      if (!host) return;
      if (e.relatedTarget && host.contains(e.relatedTarget)) return;
      hide();
    }, true);
    try { window.addEventListener('scroll', hide, true); } catch {}
  };
  try { installHoverTip(); } catch (eTip) {  }

  const handle = (action, payload) => {
    switch (action) {
      case 'info':          return info();
      case 'scrollOuter':   return scrollOuter(Number(payload.y) || 0);
      case 'scrollers':     return scrollers();
      case 'scrollInner':   return scrollInner(Number(payload.idx) || 0, Number(payload.y) || 0);
      case 'scan':          return scan(payload || {});
      case 'aim':           return aim(payload || {});
      case 'click':         return click(payload || {});
      case 'open': {
        const cards = scoreCards(!!payload.includeDone).cards;
        const c = pick(cards, payload);
        return c ? { ok: true, idx: c.idx, title: c.title, points: c.points,
          targetUrl: c.targetUrl || c.href || '' }
          : { ok: false, reason: 'not-found', total: cards.length };
      }
      case 'setTaskStates': {
        const list = payload && Array.isArray(payload.tasks) ? payload.tasks : [];
        mainTaskStates = list.map(st => ({
          name: String((st && st.name) || ''),
          completed: !!(st && st.completed)
        })).filter(st => st.name);
        return { ok: true, states: mainTaskStates.length,
          pending: mainTaskStates.filter(s => !s.completed).length };
      }
      case 'reload': {
        try { setTimeout(() => { try { location.reload(); } catch {} }, 40); } catch {}
        return { ok: true, reloading: true, url: location.href };
      }
      case 'ping':          return { ok: true, at: Date.now(), url: location.href };
      default:              return { ok: false, reason: 'unknown-action', action };
    }
  };

  let port = null;
  try { port = chrome.runtime.connect({ name: 'hsa-flyout' }); } catch (e) { port = null; }
  if (port) {
    try {
      port.postMessage({ __hsaRpc: 'ready', url: location.href,
        inIframe: window.top !== window, at: Date.now() });
    } catch {}
    port.onMessage.addListener(msg => {
      if (!msg || !msg.__hsaRpcId) return;
      let out;
      try { out = handle(msg.action, msg.payload); }
      catch (err) { out = { ok: false, reason: String(err && err.message || err) }; }
      try { port.postMessage(Object.assign({ __hsaRpcId: msg.__hsaRpcId }, out)); } catch {}
    });
  }
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || String(msg.type || '').indexOf('hsa.flyout.') !== 0) return;
      const action = String(msg.type).slice('hsa.flyout.'.length);
      let out;
      try { out = handle(action, msg.payload || {}); }
      catch (err) { out = { ok: false, reason: String(err && err.message || err) }; }
      sendResponse(out);
      return true;
    });
  } catch {}
})();
