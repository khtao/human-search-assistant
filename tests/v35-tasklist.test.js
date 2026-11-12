'use strict';
/* ============================================================================
 * v3.5 · 预设点击列表 / 统一运行提示词（动态 + 静态）
 *   node --test tests/v35-tasklist.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = require(path.join(ROOT, 'shared', 'hsa-core.js'));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const width = t => {
  let w = 0;
  for (const ch of String(t)) w += ch.charCodeAt(0) < 0x80 ? 0.5 : 1;
  return w;
};

/* ---------------------------------------------------------------- 纯模型 */
test('v3.6 · 只跳过任务列表标记已完成的卡，其余一项不删、不合并、不重排', () => {
  const items = [
    { name: '将推荐转化为奖励', points: 10 },
    { name: '迪拜沙漠舒适宜人', points: 10, completed: true },
    { name: '将推荐转化为奖励', points: 10 },   // 重复项也保留
    { name: '古代创新', points: 10, completed: true },
    { name: '完成此拼图', points: 5, completed: true },
    { name: '0 分未完成', points: 0 },
    { name: 'referral 未完成', points: 0, kind: 'referral' }
  ];
  const dom = [
    { idx: 3, name: '迪拜沙漠舒适宜人', href: 'u2' },
    { idx: 7, name: '将推荐转化为奖励', href: 'u1', kind: 'referral' },
    { idx: 9, name: '古代创新', href: 'u3' }
  ];
  const plan = CORE.planTaskClicks(items, dom);
  assert.equal(plan.length, 4, '只跳过 3 张列表标记已完成的卡');
  assert.deepEqual(plan.map(c => c.name),
    ['将推荐转化为奖励', '将推荐转化为奖励', '0 分未完成', 'referral 未完成'],
    '其余严格保持列表顺序，重复项 / 0 分 / referral 都保留');
  assert.deepEqual(plan.map(c => c.domOrder), [0, 1, 2, 3]);
  assert.equal(plan[0].matched, true, '有积分卡不得被 referral / 完成态判断排除');
  assert.equal(plan[0].idx, 7, 'DOM 扫描只补定位序号');
  assert.equal(plan[3].matched, false, '未匹配项仍保留，点击时记失败');
  assert.equal(plan[3].idx, -1);
});

test('v3.6 · 完成标记只认任务列表自身字段，DOM 完成标记 / kind / scored 不参与', () => {
  const items = [
    { name: 'A', completed: false },
    { name: 'B', completed: true },
    { name: 'C', completed: false, points: 0 },
    { name: 'D', completed: false, kind: 'referral' },
    { name: 'A', completed: false }
  ];
  const dom = [
    { idx: 1, name: 'A', completed: true, scored: false },
    { idx: 2, name: 'B', completed: false, scored: true },
    { idx: 3, name: 'C', completed: true, scored: false },
    { idx: 4, name: 'D', completed: true, kind: 'referral', scored: false }
  ];
  const plan = CORE.planTaskClicks(items, dom);
  assert.deepEqual(plan.map(c => c.name), ['A', 'C', 'D', 'A'],
    'B 因列表 completed=true 跳过；DOM 完成标记全部忽略');
  assert.deepEqual(plan.map(c => c.matched), [true, true, true, true]);
  assert.equal(CORE.pendingTaskItems(items).length, 4);
  assert.equal(CORE.planTaskClicks([{ name: 'X', completed: true }], []).length, 0,
    '列表全部已完成 → 空计划，与 allDone 零动作一致');
});

test('v3.5 · 计划按预设列表自身的 domOrder/idx 排序，两端同一规则', () => {
  const items = [
    { name: 'C', idx: 9 }, { name: 'A', idx: 1 }, { name: 'B', idx: 5 }
  ];
  assert.deepEqual(CORE.planTaskClicks(items, []).map(c => c.name), ['A', 'B', 'C']);
});

/* ------------------------------------------------------------ 运行提示词 */
test('v3.5 · 所有运行提示词 ≤15 显示宽度、只报当前动作、无下一步', () => {
  const ctx = { n: 9, m: 17, s: 10, sec: 10, clicked: 3, searches: 12,
    card: '将推荐转化为奖励', page: '/dashboard', points: 10,
    query: '今日热搜词', at: 1794413797301 };
  for (const st of Object.keys(CORE.RUN_LINES)) {
    const a = CORE.runActivity(st, ctx);
    for (const t of [a.zh, a.en]) {
      assert.ok(width(t) <= 15, st + ' 超宽：' + t);
      assert.ok(!/下一步|Next|之后|then|搜索任务|check points/.test(t),
        st + ' 含下一步：' + t);
    }
    assert.equal(a.next, '', st + ' next 必须为空');
    assert.ok(a.fullZh.includes('拟人搜索助手'));
    assert.ok(a.fullEn.includes('Human Search Assistant'));
    assert.ok(/\+08:00/.test(a.fullZh), st + ' 详细全文带系统时间');
  }
});

test('v3.5 · 详细全文保留卡片名 / 页面 / 积分 / 顺序 / 完整列表', () => {
  const a = CORE.runActivity('clicking', {
    n: 9, m: 17, card: '将推荐转化为奖励', page: '/dashboard',
    points: 10, order: '1.将推荐转化为奖励 → 2.古代创新',
    list: '将推荐转化为奖励、古代创新', query: '今日热搜',
    reason: '未完成 8 张', at: 1794413797301
  });
  assert.equal(a.zh, '点卡 9/17');
  assert.equal(a.en, 'Cards 9/17');
  for (const k of ['将推荐转化为奖励', '/dashboard', '+10 分', '执行顺序',
                   '任务列表', '关键词', '原因', '00:16:37.301']) {
    assert.ok(a.fullZh.includes(k), '详细全文缺 ' + k);
  }
  assert.ok(a.fullEn.includes('Card: 将推荐转化为奖励'));
});

test('v3.5 · waiting 保留 {s} 占位符供前端倒计时，until 正确', () => {
  const at = 1794413797301;
  const a = CORE.runActivity('waiting', { sec: 10, delayMs: 10000, at });
  assert.equal(a.zh, '等待 {s} 秒');
  assert.equal(a.en, 'Wait {s}s');
  assert.equal(a.until, at + 10000);
  assert.equal(CORE.formatActivityLine(Object.assign({}, a, { active: true }),
    'zh', at + 2000).text, '等待 8 秒');
});

test('v3.5 · 两端同一份 runActivity / planTaskClicks，无各自硬编码文案', () => {
  const files = [
    'desktop-app/src/background.js', 'desktop-app/main.js',
    'edge-extension/background.js', 'edge-extension/flyout-bridge.js'
  ];
  for (const p of files) {
    const s = read(p);
    assert.ok(!/下一步：| · Next:|之后核对|then check points|继续下一步/.test(s),
      p + ' 残留下一步文案');
  }
  for (const p of ['desktop-app/src/background.js', 'desktop-app/main.js',
                   'edge-extension/background.js']) {
    assert.match(read(p), /HSA_CORE\.runActivity\(/, p + ' 未走共享提示词');
  }
  assert.match(read('desktop-app/main.js'), /HSA_CORE\.buildTaskPlan\(/);
  assert.match(read('edge-extension/background.js'), /HSA_CORE\.buildTaskPlan\(/);
  /* 两端 activity 写入函数签名一致 */
  assert.match(read('desktop-app/src/background.js'),
    /async function desktopActivityWrite\(runState, ctx\)/);
  assert.match(read('desktop-app/main.js'),
    /function desktopActivityPush\(runState, ctx\)/);
  assert.match(read('edge-extension/background.js'),
    /async function hsaActivityPush\(runState, ctx\)/);
});

test('v3.5/v3.6 · 运行时不再有任何「是否跳过」参数或二次判断', () => {
  for (const p of ['desktop-app/src/background.js', 'desktop-app/main.js',
                   'edge-extension/background.js']) {
    const s = read(p);
    assert.ok(!/const skipCompletedCards = true;/.test(s), p + ' 残留 skipCompletedCards');
    assert.ok(!/const includeDone = false;/.test(s), p + ' 残留 includeDone=false');
    assert.ok(!/if \([^)]*!includeDone/.test(s), p + ' 残留完成态跳过分支');
  }
  const main = read('desktop-app/main.js');
  assert.ok(!/merged\.filter\(c => c && c\.scored\)/.test(main));
  assert.ok(!/planSidebarClicks\(merged/.test(main));
  assert.ok(!/matchedScored/.test(main));
  assert.ok(!/将推荐\|/.test(read('edge-extension/flyout-bridge.js')));
  assert.ok(!/将推荐\|/.test(read('edge-extension/background.js')));
  /* v3.6 · 唯一过滤来自共享 pendingTaskItems，两端包装层同源 */
  assert.match(read('shared/hsa-core.js'), /function pendingTaskItems\(/);
  assert.match(read('desktop-app/src/background.js'),
    /HSA_CORE\.taskPlanNames\(idxItems, snap\.todayTasks\)/);
  assert.match(read('edge-extension/background.js'),
    /HSA_CORE\.taskPlanNames\(taskStates, \{ items: taskStates \}\)/);
});

test('v3.5 · 全完成零动作与当日停止态仍保留（与 v3.2/v3.3 不冲突）', () => {
  for (const p of ['desktop-app/src/background.js', 'edge-extension/background.js']) {
    const s = read(p);
    assert.match(s, /if \(sync\.allDone\) \{/);
    assert.match(s, /syncGate\.noteAllDone\('all-tasks-done'\)/);
  }
  assert.doesNotMatch(read('desktop-app/src/background.js'), /!o\.force/);
});

test('v3.6 · 两端提示词 m 与待点计划长度同源（不再出现 9/17）', () => {
  const items = [
    { name: '将推荐转化为奖励', points: 10, completed: false },
    { name: '古代创新', points: 10, completed: true },
    { name: '足球传奇', points: 5, completed: true },
    { name: '完成此拼图', points: 5, completed: false }
  ];
  const plan = CORE.planTaskClicks(items, []);
  const shown = CORE.taskListNames(CORE.pendingTaskItems(items));
  assert.equal(shown.length, plan.length, '包装层 m 必须等于实际计划长度');
  assert.deepEqual(shown, plan.map(c => c.name));
  const a = CORE.runActivity('cardsDone', { n: 2, m: plan.length });
  assert.equal(a.zh, '点卡完成 2/2');
  assert.ok(!/9\/17/.test(a.zh + a.fullZh), '不得再出现日志式 9/17 不一致');
});

test('v3.6 · 页面 DOM 扫描只补定位，反转完成标记后计划完全不变', () => {
  const items = [
    { name: '将推荐转化为奖励', completed: false },
    { name: 'A', completed: false },
    { name: 'B', completed: true }
  ];
  const dom1 = [
    { idx: 1, name: '将推荐转化为奖励', completed: false },
    { idx: 2, name: 'A', completed: false },
    { idx: 3, name: 'B', completed: false }
  ];
  const dom2 = dom1.map(c => Object.assign({}, c, { completed: !c.completed }));
  const p1 = CORE.planTaskClicks(items, dom1);
  const p2 = CORE.planTaskClicks(items, dom2);
  assert.deepEqual(p1.map(c => [c.name, c.idx]), p2.map(c => [c.name, c.idx]));
  assert.deepEqual(p1.map(c => c.name), ['将推荐转化为奖励', 'A']);
});
