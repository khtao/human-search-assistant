/* 拟人动作计划生成器。
 * 只产出「几何 + 时长」计划，由 service worker 用 CDP 真正派发；
 * 因此本模块可在 Node 里直接测试，也不绑定 chrome.* API。 */
import { clamp } from "./util.js";

export const PROFILES = {
  1: { steps: [4, 10], mouse: [0.004, 0.02], overshoot: 0, scroll: [0.2, 0.8], read: [1, 4], wander: 0 },
  2: { steps: [12, 30], mouse: [0.004, 0.02], overshoot: 0.22, scroll: [0.4, 1.6], read: [3, 10], wander: 0.35 },
  3: { steps: [24, 52], mouse: [0.006, 0.03], overshoot: 0.4, scroll: [0.6, 2.8], read: [6, 25], wander: 0.75 },
};

export class Human {
  constructor(level = 2, rng, circadian = null) {
    this.level = clamp(Math.round(level), 1, 3);
    this.p = PROFILES[this.level];
    this.rng = rng;
    this.circ = circadian;
  }

  /** 速度剖面：最小急动度（Flash & Hogan）的导数，峰速度处步间隔更小。 */
  static jerk(t) {
    return 30 * t * t - 60 * t * t * t + 30 * t ** 4;
  }

  /** 二次贝塞尔 + 手抖 + ease-in-out；返回 [{x,y,dt}]，dt 为毫秒。 */
  mousePath(from, to, { quick = false, lowTime = false } = {}) {
    let steps = this.rng.int(...this.p.steps);
    if (quick || lowTime) steps = Math.max(3, Math.floor(steps / 4));
    const [x0, y0] = from;
    const [x1, y1] = to;
    const cx = x0 + (x1 - x0) * this.rng.uniform(0.2, 0.5) + this.rng.uniform(-60, 60);
    const cy = y0 + (y1 - y0) * this.rng.uniform(0.1, 0.6) + this.rng.uniform(-40, 40);
    const [lo, hi] = this.p.mouse;
    const n = Math.max(2, steps);
    const points = [];
    for (let i = 0; i <= n; i++) {
      const raw = i / n;
      const t = raw * raw * (3 - 2 * raw);
      let x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1;
      let y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1;
      if (i > 0 && i < n) {
        x += this.rng.uniform(-1.5, 1.5);
        y += this.rng.uniform(-1.5, 1.5);
      }
      const v = Human.jerk((i + 0.5) / n);
      const speed = this.circ ? this.circ.speed() : 1;
      const dt = this.rng.uniform(lo, hi) * (1 / Math.max(0.25, v * 1.6)) * speed;
      points.push({ x, y, dt: Math.min(dt, hi * 3) * 1000 });
    }
    // 过冲修正：真人瞄不准会冲过去再拉回来
    if (!quick && this.rng.bool(this.p.overshoot)) {
      const dist = Math.hypot(x1 - x0, y1 - y0);
      if (dist > 80) {
        const ux = (x1 - x0) / dist, uy = (y1 - y0) / dist;
        const over = this.rng.uniform(4, 18);
        points.push({ x: x1 + ux * over, y: y1 + uy * over, dt: 40 });
        points.push({ x: x1 + this.rng.uniform(-2, 2), y: y1 + this.rng.uniform(-2, 2), dt: 60 });
      }
    }
    return points;
  }

  /** 元素内随机落点（真人不会每次点正中心）。 */
  clickPlan(box, from = [120, 140], opts = {}) {
    const cx = box.x + box.w * this.rng.uniform(0.25, 0.75);
    const cy = box.y + box.h * this.rng.uniform(0.3, 0.7);
    return {
      center: [cx, cy],
      path: this.mousePath(from, [cx, cy], opts),
      beforeMs: this.rng.uniform(50, 300),
      downMs: this.rng.uniform(20, 100),
    };
  }

  scrollPlan(screens = 1.2, { maxSeconds = 8 } = {}) {
    const total = Math.round(screens * 900);
    const out = [];
    let moved = 0, elapsed = 0;
    while (moved < total && elapsed < maxSeconds) {
      const dy = this.rng.bool(0.85) ? this.rng.int(220, 620) : -this.rng.int(80, 260);
      const dt = this.rng.uniform(...this.p.scroll);
      out.push({ dy, dt });
      moved += Math.abs(dy);
      elapsed += dt;
    }
    if (this.rng.bool(0.4) && elapsed < maxSeconds) {
      out.push({ dy: -this.rng.int(120, 400), dt: this.rng.uniform(0.5, 1.5) });
    }
    return out;
  }

  pastePlan(text, { seconds } = {}) {
    const scale = this.level === 3 ? 1.4 : this.level === 2 ? 0.8 : 0.3;
    let pre = this.rng.uniform(scale * 0.3, scale);
    let gap = this.rng.uniform(scale * 0.3, scale);
    if (seconds) {
      pre = Math.min(pre, Math.max(0.05, seconds * 0.35));
      gap = Math.min(gap, Math.max(0.05, seconds * 0.35));
    }
    return { text, pre, gap, post: this.rng.uniform(0.05, scale * 0.5) };
  }

  readPause() { return this.rng.uniform(...this.p.read); }

  wanderPlan(w = 1440, h = 900, n = null) {
    if (!this.rng.bool(this.p.wander)) return [];
    const count = n ?? this.rng.int(2, 6);
    let from = [this.rng.uniform(0, 200), this.rng.uniform(0, 200)];
    const out = [];
    for (let i = 0; i < count; i++) {
      const to = [this.rng.uniform(0.1 * w, 0.9 * w), this.rng.uniform(0.1 * h, 0.9 * h)];
      out.push({ path: this.mousePath(from, to, { quick: true }), pause: this.rng.uniform(0.05, 0.35) });
      from = to;
    }
    return out;
  }
}
