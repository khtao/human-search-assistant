/* 一轮拟人搜索的硬性时间预算：所有等待都先问剩余时间，时间不够就压缩/跳过。
 * signal 被 abort 时 sleep 立即返回，保证点「停止」后不会卡在等待里。 */
import { sleep } from "./util.js";

export class Budget {
  constructor(total, rng, { reserve = 0 } = {}) {
    this.total = Math.max(0.5, Number(total) || 0.5);
    this.rng = rng;
    this.reserve = reserve;
    this.t0 = Date.now();
  }
  get elapsed() { return (Date.now() - this.t0) / 1000; }
  get left() { return Math.max(0, this.total - this.elapsed); }
  usable(reserve) { return Math.max(0, this.left - (reserve ?? this.reserve)); }
  fits(need, reserve) { return this.usable(reserve) > need; }

  async sleepRange(a, b, { reserve, share = 0.7, stop, signal } = {}) {
    const want = this.rng.uniform(a, b);
    const room = this.usable(reserve);
    if (room <= 0) return 0;
    const t = Math.min(want, room * share, room);
    await sleep(t * 1000, stop, signal);
    return t;
  }

  async sleepExact(seconds, stop, signal) {
    const t = Math.max(0, Math.min(seconds, this.left));
    await sleep(t * 1000, stop, signal);
    return t;
  }
}
