/* 定时自动启动：每天在用户设置的若干个 HH:MM 启动一次拟人搜索。
 *
 * 用一个每分钟的 tick alarm 比对当前时间，而不是为每个时间点各建一个
 * periodInMinutes=1440 的 alarm —— 这样浏览器重启 / 系统休眠 / 时间点
 * 改动都能自恢复，也不会因为 DST 或跨天偏移错过。
 * 当天已触发过的时间点记在 storage.local，跨天自动清空。 */
import { dayStr, hhmm } from "../lib/util.js";
import { BUSY_STATES } from "../lib/messages.js";
import { getSettings, getFired, markFired } from "./store.js";
import { currentState, log } from "./state.js";

const TICK = "mra:tick";

/** 幂等：无开关或无时间点时清掉 tick，不留下空轮询。 */
export async function rebuild() {
  const s = await getSettings();
  if (!s.autoRunEnabled || !s.autoRunTimes.length) {
    await chrome.alarms.clear(TICK);
    return { enabled: false, times: [] };
  }
  await chrome.alarms.create(TICK, { delayInMinutes: 0.5, periodInMinutes: 1 });
  return { enabled: true, times: s.autoRunTimes };
}

/**
 * @param {chrome.alarms.Alarm} alarm
 * @param {{run: (params:{auto:boolean})=>Promise<any>, now?: string}} deps
 *        now 可注入，便于离线自检固定钟点；生产环境默认读当前 HH:MM。
 */
export async function handleAlarm(alarm, { run, now = hhmm() }) {
  if (alarm?.name !== TICK) return;
  const s = await getSettings();
  if (!s.autoRunEnabled || !s.autoRunTimes.length) return;

  if (!s.autoRunTimes.includes(now)) return;
  if (!s.autoRunTimes.includes(now)) return;

  const day = dayStr();
  const key = `${day}:${now}`;
  const fired = await getFired(day);
  if (fired.keys.includes(key)) return;      // 同一分钟不重复启动
  await markFired(key, day);                 // 先占位，避免并发 tick 重复跑

  const runState = await currentState();
  if (BUSY_STATES.includes(runState.state)) {
    await log("schedule", `${now} 定时触发，但已有搜索在运行，本次跳过`);
    return;
  }
  await log("schedule", `${now} 定时启动 ${s.repeat} 轮拟人搜索`);
  try {
    await run({ auto: true });
  } catch (e) {
    await log("schedule", `${now} 定时启动失败：${e?.message || e}`);
  }
}
