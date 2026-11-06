/* 行为节奏：用真实人类时间分布替换均匀随机。
 * 1/f 自相似 + 对数正态长尾 + 会话内疲劳漂移 + 阅读时长模型 + 昼夜节律。
 * 不依赖浏览器 API，可由 Node 自检直接 import。 */
import { clamp } from "./util.js";

export function lognormal(rng, median, sigma = 0.45) {
  return rng.lognorm(median, sigma);
}

export function pareto(rng, xm, alpha = 1.6) {
  return xm / Math.pow(Math.max(1e-9, rng.next()), 1 / Math.max(0.1, alpha));
}

export function bounded(rng, sampler, low, high, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const v = sampler();
    if (v >= low && v <= high) return v;
  }
  return clamp(sampler(), low, high);
}

/** Voss-McCartney 粉红噪声：功率谱 ~ 1/f，制造成串操作 + 长时间静默。 */
export class PinkNoise {
  constructor(rng, octaves = 6) {
    this.rng = rng;
    this.n = Math.max(2, octaves);
    this.state = Array.from({ length: this.n }, () => rng.gauss());
    this.counter = 0;
    this.norm = Math.sqrt(this.n);
  }
  next() {
    let i = 0;
    while (i < this.n && ((this.counter >> i) & 1) === 0) {
      this.state[i] = this.rng.gauss();
      i++;
    }
    this.counter = (this.counter + 1) & 0xffffffff;
    return this.state.reduce((a, b) => a + b, 0) / this.norm;
  }
}

/** 整段会话共享一个噪声状态：动作间隔彼此相关，越往后越慢。 */
export class Cadence {
  constructor(rng, { sigma = 0.45, driftCap = 1.22, sessionLen = 12, tailP = 0.05 } = {}) {
    this.rng = rng;
    this.sigma = sigma;
    this.driftCap = driftCap;
    this.sessionLen = Math.max(1, sessionLen);
    this.tailP = tailP;
    this.noise = new PinkNoise(rng);
    this.n = 0;
    this.bias = Math.exp(-(sigma * sigma) / 2);
  }
  interval(median, low, high) {
    if (median <= 0) return 0;
    const lo = low ?? median * 0.35;
    const hi = high ?? median * 4.5;
    let v = this.rng.lognorm(median, this.sigma * 0.5)
      * Math.exp(this.sigma * this.noise.next()) * this.bias;
    v *= 1 + (this.driftCap - 1) * Math.min(1, this.n / this.sessionLen);
    this.n++;
    if (this.rng.bool(this.tailP)) {
      v += Math.min(pareto(this.rng, median * 1.2, 2.6), median * 6);
    }
    return bounded(this.rng, () => v, lo, hi);
  }
}

/** 阅读时长 ∝ 内容长度；扫读为主，偶尔细读。 */
export class ReadingModel {
  constructor(rng, { deepP = 0.25, floor = 1.2, ceil = 45 } = {}) {
    this.rng = rng;
    this.deepP = deepP;
    this.floor = floor;
    this.ceil = ceil;
  }
  dwell(chars) {
    const n = Math.max(0, Math.floor(chars || 0));
    if (!n) return this.rng.uniform(this.floor, this.floor * 2);
    const deep = this.rng.bool(this.deepP);
    const cpm = deep ? this.rng.uniform(200, 340) : this.rng.uniform(420, 700);
    let t = (n * this.rng.uniform(0.25, 0.6) / cpm) * 60;
    if (n > 1200) t *= 0.75;
    return clamp(this.rng.lognorm(Math.max(0.1, t), 0.35), this.floor, this.ceil);
  }
}

/** 当地时间 → 速度系数与活跃度（>1 表示更慢/疲惫）。 */
export class Circadian {
  static CURVE = [
    1.35, 1.40, 1.45, 1.45, 1.40, 1.30, 1.20, 1.10, 1.00, 0.92, 0.90, 0.92,
    0.98, 1.02, 1.00, 0.98, 0.96, 0.95, 0.98, 1.00, 1.05, 1.10, 1.18, 1.28,
  ];
  constructor(tzOffsetHours = null) { this.offset = tzOffsetHours; }
  localHour() {
    if (this.offset == null) return new Date().getHours();
    const h = new Date().getUTCHours() + this.offset;
    return ((Math.round(h) % 24) + 24) % 24;
  }
  speed() { return Circadian.CURVE[this.localHour()] ?? 1.0; }
  describe() {
    return `当地 ${String(this.localHour()).padStart(2, "0")} 时 · 节奏 x${this.speed().toFixed(2)}`;
  }
}
