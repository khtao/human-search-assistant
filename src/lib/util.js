/* 通用工具：纯函数，可在 service worker / offscreen / Node 自检中通用。 */
export function dayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function hhmm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function isoNow() {
  return new Date().toISOString();
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function safeInt(v, fallback = 0) {
  const n = parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** FNV-1a，用于给 DOM 卡片生成稳定的本地 key（不依赖页面 ID）。 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function dedupeBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export class Rng {
  constructor(seed) {
    const s = Number(seed);
    this.s = Number.isFinite(s) && s !== 0 ? s >>> 0 : (Math.random() * 0xffffffff) >>> 0 || 0x9e3779b9;
  }

  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.uniform(a, b + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  pick(arr) { return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]; }

  weighted(items) {
    const total = items.reduce((n, it) => n + (Number(it[1]) || 0), 0);
    if (total <= 0) return items[0]?.[0];
    let r = this.next() * total;
    for (const [value, weight] of items) {
      r -= Number(weight) || 0;
      if (r <= 0) return value;
    }
    return items[items.length - 1][0];
  }

  gauss() {
    const u = Math.max(1e-9, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  lognorm(median, sigma = 0.45) {
    return median <= 0 ? 0 : Math.exp(Math.log(median) + sigma * this.gauss());
  }

  expovariate(rate) {
    return rate <= 0 ? Infinity : -Math.log(Math.max(1e-9, this.next())) / rate;
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

/**
 * 可中断等待。stop() 返回 true 或 signal 被 abort 时立即 resolve(false)，
 * 不需要等定时器走完 —— 这是「点停止立即停」的关键。
 */
export async function sleep(ms, stop, signal) {
  if (signal?.aborted || (stop && stop())) return false;
  const end = Date.now() + Math.max(0, ms);
  return new Promise((resolve) => {
    let timer = null;
    const done = (ok) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    const tick = () => {
      if (signal?.aborted || (stop && stop())) return done(false);
      const left = end - Date.now();
      if (left <= 0) return done(true);
      timer = setTimeout(tick, Math.min(80, Math.max(1, left)));
    };
    tick();
  });
}

export function formatSeconds(s) {
  return `${(Number(s) || 0).toFixed(1)}s`;
}

export function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
