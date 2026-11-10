document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;
  const main = $('main');
  const btnAction = $('btn-action');
  const actionLabel = $('btn-action-label');
  // 首页「搜索次数」输入已移除；次数由今日 Bing 搜索剩余分数自动决定
  const countInput = { value: '30', disabled: false, addEventListener() {} };
  /* v1.1.5：顶端主题按钮已移除（设置页里仍有主题三态切换）。
   保留一个空壳引用，避免 applyI18n / applyTheme 里的旧代码抛 TypeError。 */
  const themeBtn = $('theme-toggle') || {
    setAttribute() {}, addEventListener() {}, title: ''
  };
  const ring = document.querySelector('.progress-ring');
  const arc = $('progress-arc');
  const progressText = $('progress-text');
  const progressSub = $('progress-sub');
  const statusEl = $('status');
  const statusText = $('status-text');
  const startEl = $('start-points');
  const currentEl = $('end-points');
  const earnedEl = $('earned-points');
  const earnedLabel = $('earned-label');
  // 「今日搜索积分已领完」提示与「今日 Bing 搜索」进度条模块已整体删除
  const daily = { hidden: true };
  const notice = { hidden: true, className: '' };
  const noticeTitle = { textContent: '' };
  const noticeBody = { textContent: '' };
  const noticeCopy = { textContent: '', hidden: true, addEventListener() {} };
  const errorBanner = $('error-banner');
  const errorText = $('error-text');
  const loginBadge = $('login-badge');
  const loginBadgeText = $('login-badge-text');
  const loginBadgeIcon = $('login-badge-icon');
  const panelBtn = $('panel-toggle');   // v1.1.5：DOM 已移除，所有引用保留判空兼容
  let panelOpen = false;
  /* 只有用户主动点过「登录」才在登录成功后自动收起侧栏，
     避免后台把状态从 unknown 刷成 in 时误收用户手动展开的官网。 */
  let awaitingLogin = false;

  const ARC_LENGTH = 2 * Math.PI * 52;
  const POINTS_PER_SEARCH = 3;
  const TODAY_REFRESH_MS = 5 * 60 * 1000;
  const KEYS = [
    'phase', 'running', 'currentSearch', 'totalSearch', 'startPoints', 'startKnown',
    'endPoints', 'finalEarned', 'earnedIsEstimate', 'todaySearch', 'error', 'warning', 'stopRequested',
    'diag', 'diagLimit', 'todayStart', 'liveCheck', 'stoppedEarly', 'currentQuery', 'todayActivities',
    'cooldownUntil', 'cooldownWaitMs', 'cooldownCycles', 'cooldownGaveUp', 'searchMaxedAtStart',
    'runAuto', 'runAutoTime', 'runLevel', 'todayTasks', 'pointsSummary',
    'loginStatus', 'loginCheckedAt', 'autoResult', 'activityDetail', 'pointsHistory'
  ];
  const DEFAULTS = {
    defaultCount: 30,
    pace: 'normal',
    autoStop: true,
    reduceMotion: false,
    cardClickIntervalSec: 10,
    notSkipCompletedCards: false
  };
  const AUTO_DEFAULTS = { enabled: false, times: [], count: 30, level: 3 };
  const AUTO_MAX_TIMES = 10;
  const MAX_COOLDOWNS = 6;

  /* --------------------------------------------------------------- 双语字典 */
  const I18N = {
    zh: {
      'app.title': '拟人搜索助手',
      'login.checking': '未确认', 'login.in': '已登录', 'login.out': '未登录',
      'login.action': '登录',
      'login.hint': '点击展开右侧官方登录页；积分与今日任务从同一个官网页面读取，登录后自动复检',
      'login.tip': '单击切换侧栏 · 双击打开官网',
      'ring.tipTitle': '今日进度速览', 'ring.tipHint': '鼠标移入显示 · 点击主按钮开始执行',
      'a11y.login': '登录状态，点击切换侧栏、双击打开官网',
      'a11y.panel': '展开或收起右侧官网页面', 'a11y.panelClose': '收起右侧官网页面',
      'panel.open': '官网', 'panel.close': '收起',
      'a11y.language': '切换语言', 'a11y.settings': '打开设置', 'a11y.theme': '切换主题',
      'a11y.progress': '今日任务进度', 'a11y.points': '积分概览', 'a11y.dismiss': '关闭',
      'a11y.back': '返回', 'a11y.customCount': '自定义搜索次数', 'a11y.autoTime': '启动时间',
      'theme.light': '浅色', 'theme.dark': '深色', 'theme.system': '跟随系统',
      'theme.toLight': '切换到浅色主题', 'theme.toDark': '切换到深色主题',
      'progress.searches': '次搜索', 'progress.tasks': '今日任务', 'progress.ptsToday': '今日积分', 'progress.cooldown': '冷却中',
      'progress.pleaseWait': '请稍候', 'progress.cooldownLeft': '冷却中 · {t} 后继续',
      'status.ready': '就绪', 'status.reading': '读取积分', 'status.checking': '检查今日进度',
      'status.searching': '搜索中', 'status.cooldown': 'Bing 冷却', 'status.finalizing': '收尾中',
      'status.completed': '已完成', 'status.limit': '已达上限', 'status.error': '出错',
      'status.allDone': '任务已完成，无需任何动作',
      'status.synced': '已同步积分',
      'status.cooldownRound': 'Bing 冷却（第 {n} / {max} 次等待）',
      'status.gaveUp': 'Bing 持续冷却，积分未恢复，已提前结束',
      'status.completingTasks': '正在完成任务',
      'status.syncing': '正在同步状态',
      'status.stopping': '正在停止', 'status.of': '第 {a} / {b} 次',
      'status.searchingTitle': '正在搜索：{q}',
      'points.start': '可用积分', 'points.current': '今日积分', 'points.earned': '可领取',
      'daily.title': '今日 Bing 搜索', 'daily.maxed': '今日已满，继续搜索不再计分。',
      'daily.remaining': '约还需 {n} 次搜索达到今日上限',
      'tip.startTitle': '可用积分', 'tip.available': 'Rewards 面板余额',
      'tip.currentTitle': '今日积分', 'tip.todayPoints': '今日已获积分',
      'tip.earnedTitle': '可领取', 'tip.claimable': '待领取积分',
      'tip.loading': '读取中…', 'tip.signedOut': '请先登录',
      'notice.copy': '复制详情', 'notice.copied': '已复制 ✓', 'notice.copyFailed': '复制失败',
      'notice.cooldownTitle': '等待 Bing 冷却',
      'notice.cooldownBody': 'Bing 暂时停止计分，将在 {time} 自动继续（第 {n} / {max} 次等待）。',
      'notice.limitTitle': '今日搜索积分已领完',
      'notice.limitBody': '今日 Bing 搜索：{p}/{m} 分。继续搜索不会再加分，明天再来。',
      'notice.earlyTitle': '已达每日搜索上限',
      'notice.earlyBody': '完成 {n} 次搜索后停止 — 今日 Bing 搜索：{p}/{m} 分。',
      'notice.gaveUpTitle': 'Bing 持续冷却中',
      'notice.gaveUpBody': '等待 {max} 次后积分仍未恢复，本次已提前结束，请稍后再试。',
      'notice.headsUp': '提示',
      'controls.searches': '搜索次数', 'controls.start': '自动完成任务', 'controls.stop': '停止',
      'controls.starting': '正在启动…', 'controls.stopping': '正在停止…', 'controls.finishing': '正在收尾…',
      'tasks.title': '自动完成任务', 'tasks.add': '+ 添加时间',
      'tasks.empty': '还没有任务，去「设置 → 自动完成任务」添加启动时间。',
      'tasks.meta': '{n} 次 · 强度{lv}', 'tasks.level1': '低', 'tasks.level2': '中', 'tasks.level3': '高',
      'tasks.pending': '待执行', 'tasks.running': '运行中', 'tasks.done': '今日已执行',
      'tasks.skipped': '今日已跳过', 'tasks.off': '已停用', 'tasks.runNow': '立即运行',
      'tasks.remove': '删除该时间点', 'tasks.runningBusy': '已有任务在运行中，请稍后再试。',
      'tasks.started': '任务已启动，可在上方进度环查看。',
      'tasks.added': '已添加 {time}', 'tasks.autoAdded': '已自动添加 {time}',
      'tasks.removed': '已删除 {time}',
      'tasks.duplicate': '该时间点已存在。', 'tasks.limit': '最多只能添加 10 个时间点。',
      'tasks.invalid': '请选择有效的时间（HH:MM）。',
      'tasks.disabledTip': '总开关已关闭，打开「设置 → 自动完成任务 → 定时自动运行」后才会定时执行。',
      'settings.title': '设置', 'settings.appearance': '外观', 'settings.language': '语言 / Language',
      'lang.system': '跟随系统', 'points.earnedOpen': '打开 Rewards 领取积分',
      'tip.claimOpen': '点击前往 Rewards 领取积分',
      'settings.theme': '主题', 'settings.reduce': '减少动画', 'settings.reduceHint': '关闭动效',
      'settings.searches': '搜索', 'settings.defaultCount': '默认搜索次数', 'settings.other': '其他',
      'settings.pace': '节奏', 'settings.paceHint': '每次结果停留时长',
      'pace.normal': '标准', 'pace.relaxed': '舒缓',
      'settings.autostop': '到达每日上限即停止', 'settings.autostopHint': 'Bing 搜索计满后提前结束',
      'settings.automation': '自动化',
      'settings.seconds': '秒', 'auto.cardInterval': '卡片点击间隔', 'auto.cardIntervalHint': '相邻两张卡片的 CDP 鼠标点击至少间隔设定秒数（1–60 秒）',
      'auto.notSkipCompleted': '不跳过已完成任务卡', 'auto.notSkipCompletedHint': '默认关闭：跳过已完成任务卡，只点未完成卡片；开启后点所有积分卡，且积分与任务全部完成时仍发起点击流程',
      'auto.title': '自动完成任务', 'auto.enable': '定时自动运行',
      'auto.enableHint': '到点自动点击积分任务卡片，并按剩余分数搜索；关闭总开关时仍可配置时间点',
      'auto.count': '搜索次数上限', 'auto.countHint': '按今日 Bing 搜索剩余分数自动决定，不超过此值', 'auto.times': '启动时间',
      'auto.timesHint': '留空直接点「添加」：首个默认 08:00，之后比最晚时间顺延 30 分钟，自动去重排序', 'auto.addTime': '添加',
      'auto.level': '拟人强度', 'auto.levelHint': '影响鼠标轨迹、滚动与每轮时长',
      'level.low': '低', 'level.mid': '中', 'level.high': '高',
      'settings.reset': '恢复默认设置', 'settings.resetConfirm': '再点一次确认重置',
      'error.extension': '扩展异常：{msg}',
      'error.signIn': '请先在浏览器中登录 Microsoft Rewards（rewards.bing.com），然后重新开始。',
      'error.topics': '所有热搜源均不可用，请检查网络后重试（不使用本地词库）。',
      'error.network': 'Bing 没有响应，请检查网络连接。',
      'error.runStopped': '运行已中止：{msg}', 'error.startFailed': '启动失败：{msg}',
      'error.stale': '上次运行被中断（浏览器关闭或电脑休眠），请重新点击开始。',
      'error.busy': '已有搜索正在运行，请先停止。',
      'todayTasks.title': '今日任务', 'todayTasks.refresh': '刷新',
      'todayTasks.loading': '正在读取今日任务…',
      'todayTasks.empty': '暂无带积分的任务数据',
      'todayTasks.noData': '暂时读不到任务数据，点「刷新」重试',
      'todayTasks.emptyLogin': '未登录 Microsoft Rewards，请先登录后点「刷新」。',
      'todayTasks.summary': '今日任务 {p}%（{a} / {b} 分）', 'todayTasks.approx': '估算',
      'todayTasks.refreshed': '今日任务与积分已刷新', 'todayTasks.refreshing': '正在刷新…',
      'todayTasks.refreshFailed': '刷新失败，请稍后重试',
      'todayTasks.onlyPoints': '仅显示带积分的任务',
      'todayTasks.sectionSearch': '搜索', 'todayTasks.sectionDaily': '每日活动',
      'todayTasks.sectionPromo': '日常任务', 'todayTasks.sectionOther': '其他任务',
      'todayTasks.groupTotal': '{a} / {b} 分',
      'todayTasks.done': '已完成', 'todayTasks.pending': '待完成',
      'todayTasks.points': '{p} 分', 'todayTasks.open': '打开任务',
      'lang.zh': '中文', 'lang.en': '英文',
      'calendar.title': '积分赚取日历', 'calendar.day': '日', 'calendar.week': '周', 'calendar.month': '月',
      'calendar.prev': '上一周期', 'calendar.next': '下一周期', 'calendar.unit': '分',
      'calendar.weekLabel': '{n}周', 'calendar.monthLabel': '{n}月',
      'calendar.totalLabel': '本月累计积分', 'calendar.yearLabel': '本年累计积分',
      'calendar.summary': '日均 {avg} · 最高 {max} · {n} 天有积分',
      'calendar.empty': '暂无历史数据，同步后自动记录',
      'calendar.earnedDays': '{n} 天有积分', 'calendar.legendHas': '已获得', 'calendar.legendNone': '无积分',
      'calendar.navEmpty': '该周期暂无积分（仍可查看）',
      'calendar.hoverTip': '日视图显示每日积分，周/月视图显示汇总 · 淡蓝为有积分、灰色为无积分、未来留空。悬停查看详情',
      'calendar.cellTip': '{date} · 积分 {points} 分',
      'calendar.noPointsTip': '{date} · 无积分记录',
      'desktop.title': '桌面版', 'desktop.autoLaunch': '开机自动启动',
      'desktop.autoLaunchHint': '登录系统后自动运行桌面版', 'desktop.silent': '静默完成任务',
      'desktop.silentHint': '仅隐藏页面过程；流程、进度与运行详情和正常模式一致',
      'desktop.onlyDesktop': '以上两项仅桌面版可用，浏览器插件中不可设置',
      'desktop.autoLaunchOn': '已开启开机自动启动', 'desktop.autoLaunchOff': '已关闭开机自动启动',
      'desktop.silentOn': '已开启静默完成任务（隐藏页面执行）',
      'desktop.silentOff': '已关闭静默完成任务'
    },
    en: {
      'app.title': 'Human Search Assistant',
      'login.checking': 'Not verified', 'login.in': 'Signed in', 'login.out': 'Not signed in',
      'login.action': 'Sign in',
      'login.hint': "Open the official sign-in page on the right; points and tasks are read from that same page",
      'ring.tipTitle': "Today at a glance", 'ring.tipHint': 'Hover to show · press the main button to start',
      'a11y.login': 'Sign-in status; click to sign in or re-check',
      'a11y.panel': 'Show or hide the official Rewards page on the right',
      'a11y.panelClose': 'Hide the official Rewards page',
      'panel.open': 'Site', 'panel.close': 'Hide',
      'a11y.language': 'Switch language', 'a11y.settings': 'Open settings', 'a11y.theme': 'Switch theme',
      'a11y.progress': 'Today\'s tasks progress', 'a11y.points': 'Points summary', 'a11y.dismiss': 'Dismiss',
      'a11y.back': 'Back', 'a11y.customCount': 'Custom number of searches', 'a11y.autoTime': 'Start time',
      'theme.light': 'Light', 'theme.dark': 'Dark', 'theme.system': 'System',
      'theme.toLight': 'Switch to light theme', 'theme.toDark': 'Switch to dark theme',
      'progress.searches': 'searches', 'progress.tasks': 'Today\'s tasks', 'progress.ptsToday': 'pts today', 'progress.cooldown': 'cooldown',
      'progress.pleaseWait': 'please wait', 'progress.cooldownLeft': 'Cooldown · resume in {t}',
      'status.ready': 'Ready', 'status.reading': 'Reading points', 'status.checking': 'Checking today',
      'status.searching': 'Searching', 'status.cooldown': 'Bing cooldown', 'status.finalizing': 'Finalizing',
      'status.completed': 'Completed', 'status.limit': 'Limit reached', 'status.error': 'Error',
      'status.allDone': 'All tasks done — nothing to do',
      'status.synced': 'Points synced',
      'status.cooldownRound': 'Bing cooldown (wait {n} of {max})',
      'status.gaveUp': 'Bing kept cooling — points stalled, stopped early',
      'status.completingTasks': 'Completing tasks',
      'status.syncing': 'Syncing status',
      'status.stopping': 'Stopping', 'status.of': 'Search {a} of {b}',
      'status.searchingTitle': 'Searching: {q}',
      'points.start': 'Available', 'points.current': "Today's points", 'points.earned': 'Claimable',
      'daily.title': "Today's Bing search", 'daily.maxed': 'Maxed for today — searches won’t earn more.',
      'daily.remaining': '~{n} more searches to max today',
      'tip.startTitle': 'Available', 'tip.available': 'Rewards balance',
      'tip.currentTitle': "Today's points", 'tip.todayPoints': 'Points earned today',
      'tip.earnedTitle': 'Claimable', 'tip.claimable': 'Points to claim',
      'tip.loading': 'Loading…', 'tip.signedOut': 'Sign in first',
      'notice.copy': 'Copy details', 'notice.copied': 'Copied ✓', 'notice.copyFailed': 'Copy failed',
      'notice.cooldownTitle': 'Waiting out Bing cooldown',
      'notice.cooldownBody': 'Bing stopped counting points for a while. Searching resumes by itself at {time} (round {n} of {max}).',
      'notice.limitTitle': 'Daily search points already earned',
      'notice.limitBody': 'Bing search today: {p}/{m} pts. More searches won’t add points — come back tomorrow.',
      'notice.earlyTitle': 'Daily search limit reached',
      'notice.earlyBody': 'Stopped after {n} searches — Bing search today: {p}/{m} pts.',
      'notice.gaveUpTitle': 'Bing kept the cooldown on',
      'notice.gaveUpBody': 'Points stayed paused after {max} waits, so the run ended early. Try again later today.',
      'notice.headsUp': 'Heads up',
      'controls.searches': 'Searches', 'controls.start': 'Auto-complete Tasks', 'controls.stop': 'Stop',
      'controls.starting': 'Starting…', 'controls.stopping': 'Stopping…', 'controls.finishing': 'Finishing…',
      'tasks.title': 'Auto-complete tasks', 'tasks.add': '+ Add time',
      'tasks.empty': 'No tasks yet. Add a start time in Settings → Auto-complete tasks.',
      'tasks.meta': '{n} searches · Level {lv}', 'tasks.level1': 'Low', 'tasks.level2': 'Medium', 'tasks.level3': 'High',
      'tasks.pending': 'Pending', 'tasks.running': 'Running', 'tasks.done': 'Ran today',
      'tasks.skipped': 'Skipped today', 'tasks.off': 'Disabled', 'tasks.runNow': 'Run now',
      'tasks.remove': 'Remove this time', 'tasks.runningBusy': 'A task is already running. Please try again later.',
      'tasks.started': 'Task started — watch the progress ring above.',
      'tasks.added': 'Added {time}', 'tasks.autoAdded': 'Added {time} automatically',
      'tasks.removed': 'Removed {time}',
      'tasks.duplicate': 'That time is already in the list.', 'tasks.limit': 'You can add up to 10 times.',
      'tasks.invalid': 'Pick a valid time (HH:MM).',
      'tasks.disabledTip': 'Scheduling is off. Turn on Settings → Auto-complete tasks → Scheduled runs.',
      'settings.title': 'Settings', 'settings.appearance': 'Appearance', 'settings.language': '语言 / Language',
      'lang.system': 'System', 'points.earnedOpen': 'Open Rewards to claim points',
      'tip.claimOpen': 'Click to open Rewards and claim',
      'settings.theme': 'Theme', 'settings.reduce': 'Reduce animations', 'settings.reduceHint': 'Turn off motion effects',
      'settings.searches': 'Searches', 'settings.defaultCount': 'Default searches', 'settings.other': 'Other',
      'settings.pace': 'Pace', 'settings.paceHint': 'Time spent on each result',
      'pace.normal': 'Normal', 'pace.relaxed': 'Relaxed',
      'settings.autostop': 'Stop at daily limit', 'settings.autostopHint': 'End early once Bing search is maxed',
      'settings.automation': 'Automation',
      'settings.seconds': 'sec', 'auto.cardInterval': 'Card click interval', 'auto.cardIntervalHint': 'Minimum time between CDP mouse clicks on cards (1–60 seconds)',
      'auto.notSkipCompleted': 'Do not skip completed task cards', 'auto.notSkipCompletedHint': 'Off by default: skip completed cards; when on, click every scored card even if all points and tasks are done',
      'auto.title': 'Auto-complete tasks', 'auto.enable': 'Scheduled runs',
      'auto.enableHint': 'Click scored cards and search at the set times; times stay editable when the switch is off',
      'auto.count': 'Search cap', 'auto.countHint': 'Decided from remaining Bing search points, capped here', 'auto.times': 'Start times',
      'auto.timesHint': 'Leave empty and tap Add: first defaults to 08:00, then +30 min from the latest time; auto-sorted and deduped', 'auto.addTime': 'Add',
      'auto.level': 'Human-like intensity', 'auto.levelHint': 'Affects mouse path, scrolling and round length',
      'level.low': 'Low', 'level.mid': 'Medium', 'level.high': 'High',
      'settings.reset': 'Reset to defaults', 'settings.resetConfirm': 'Tap again to reset',
      'error.extension': 'Extension error: {msg}',
      'error.signIn': 'Sign in to Microsoft Rewards (rewards.bing.com) in this browser, then press Start again.',
      'error.topics': 'All trending sources are unavailable. Check your connection (no local word list).',
      'error.network': 'Bing is not responding. Check your connection.',
      'error.runStopped': 'Run stopped: {msg}', 'error.startFailed': 'Start failed: {msg}',
      'error.stale': 'The last run was cut off (browser closed or PC slept). Press Start to run again.',
      'error.busy': 'A search is already running. Stop it first.',
      'todayTasks.title': "Today's tasks", 'todayTasks.refresh': 'Refresh',
      'todayTasks.loading': 'Loading today’s tasks…',
      'todayTasks.empty': 'No scored tasks found yet',
      'todayTasks.noData': 'Could not load tasks. Tap Refresh to retry.',
      'todayTasks.emptyLogin': 'Not signed in to Microsoft Rewards. Sign in, then tap Refresh.',
      'todayTasks.summary': "Today's tasks {p}% ({a} / {b} pts)", 'todayTasks.approx': 'estimated',
      'todayTasks.refreshed': 'Tasks and points refreshed', 'todayTasks.refreshing': 'Refreshing…',
      'todayTasks.refreshFailed': 'Refresh failed. Try again in a moment.',
      'todayTasks.onlyPoints': 'Only tasks with points are listed',
      'todayTasks.sectionSearch': 'Search', 'todayTasks.sectionDaily': 'Daily activities',
      'todayTasks.sectionPromo': 'Daily tasks', 'todayTasks.sectionOther': 'Other',
      'todayTasks.groupTotal': '{a} / {b} pts',
      'todayTasks.done': 'Done', 'todayTasks.pending': 'Pending',
      'todayTasks.points': '{p} pts', 'todayTasks.open': 'Open task',
      'lang.zh': 'Chinese', 'lang.en': 'English',
      'calendar.title': 'Points earning calendar', 'calendar.day': 'Day', 'calendar.week': 'Week', 'calendar.month': 'Month',
      'calendar.prev': 'Previous period', 'calendar.next': 'Next period', 'calendar.unit': 'pts',
      'calendar.weekLabel': 'W{n}', 'calendar.monthLabel': 'M{n}',
      'calendar.totalLabel': 'Points this month', 'calendar.yearLabel': 'Points this year',
      'calendar.summary': 'Avg {avg} · Best {max} · {n} days with points',
      'calendar.empty': 'No history yet — recorded after the next sync',
      'calendar.earnedDays': '{n} days earned', 'calendar.legendHas': 'Earned', 'calendar.legendNone': 'No points',
      'calendar.navEmpty': 'No points in this period (still viewable)',
      'calendar.hoverTip': 'Daily points with weekly/monthly summaries · blue = earned, grey = none, future = blank. Hover for details',
      'calendar.cellTip': '{date} · {points} pts',
      'calendar.noPointsTip': '{date} · no points recorded',
      'desktop.title': 'Desktop', 'desktop.autoLaunch': 'Launch at login',
      'desktop.autoLaunchHint': 'Start the desktop app after signing in to the system',
      'desktop.silent': 'Silent task completion',
      'desktop.silentHint': 'Hides page views only; flow and progress stay the same',
      'desktop.onlyDesktop': 'These two options are desktop-only and disabled in the extension',
      'desktop.autoLaunchOn': 'Launch at login enabled', 'desktop.autoLaunchOff': 'Launch at login disabled',
      'desktop.silentOn': 'Silent completion enabled (hidden pages)',
      'desktop.silentOff': 'Silent completion disabled'
    }
  };

  /* 语言模式：system（默认，跟随浏览器/系统语言）| zh | en */
  const normalizeLangMode = v => (v === 'zh' || v === 'en' ? v : 'system');
  const systemLang = () => {
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^zh\b/i.test(nav) ? 'zh' : 'en';
  };
  const resolveLang = mode => (mode === 'zh' || mode === 'en' ? mode : systemLang());
  let langMode = 'system';
  let lang = resolveLang(langMode);
  const t = (key, vars) => {
    let s = (I18N[lang] && I18N[lang][key]) || (I18N.zh[key]) || key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
    return s;
  };

  /* v1.0.9 · 右侧官网面板按钮：桌面版显示并可切换，扩展版无该能力则隐藏。
     面板状态由主进程广播 ui:panel（窗口 resize / 自动运行时也会同步）。 */
  function setPanelButton(open) {
    panelOpen = !!open;
    /* v1.1.5：「收起」按钮虽已删除，body.panel-open 仍必须同步 ——
       左侧 400px 固定宽度靠这个 class，漏掉会让展开侧栏时布局被拉宽。 */
    document.body.classList.toggle('panel-open', panelOpen);
    if (!panelBtn) return;
    panelBtn.textContent = t(panelOpen ? 'panel.close' : 'panel.open');
    panelBtn.setAttribute('aria-pressed', String(panelOpen));
    panelBtn.setAttribute('aria-label', t(panelOpen ? 'a11y.panelClose' : 'a11y.panel'));
    document.body.classList.toggle('panel-open', panelOpen);
  }

  function applyI18n() {
    root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    document.title = t('app.title');
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
    for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
    setPanelButton(panelOpen);
    const label = root.getAttribute('data-theme') === 'dark' ? t('theme.toLight') : t('theme.toDark');
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
    noticeCopy.textContent = t('notice.copy');
  }

  function setLang(next) {
    langMode = normalizeLangMode(next);
    lang = resolveLang(langMode);
    chrome.storage.local.set({ uiLang: langMode });
    applyI18n();
    syncSettingsUI();
    refresh();
  }

  /** 后台写进 storage.error 的英文/中文消息，统一按当前语言显示。 */
  function localizeError(msg) {
    const s = String(msg || '');
    const map = [
      [/sign in to microsoft rewards|请先在浏览器中登录/i, 'error.signIn'],
      [/热搜源|trending sources|search topics|Could not load search/i, 'error.topics'],
      [/bing is not responding|bing 没有响应|check your connection|检查网络/i, 'error.network'],
      [/last run was cut off|上次运行被中断/i, 'error.stale'],
      [/已在运行中|already running/i, 'error.busy']
    ];
    for (const [re, key] of map) if (re.test(s)) return t(key);
    let m = s.match(/^Run stopped:\s*(.*)$/i);
    if (m) return t('error.runStopped', { msg: m[1] });
    m = s.match(/^Start failed:\s*(.*)$/i);
    if (m) return t('error.startFailed', { msg: m[1] });
    return s;
  }

  let settings = Object.assign({}, DEFAULTS);
  let autoTasks = Object.assign({}, AUTO_DEFAULTS);
  let diagText = '';

  const fmt = n => Number(n || 0).toLocaleString();
  const isDigit = c => c >= '0' && c <= '9';
  const clampInt = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const motionOff = () =>
    root.classList.contains('reduce-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const restart = (el, cls) => {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };

  /* v1.3.1：刷新时不做逐位滚动 / 错峰过渡。数据完整到达后一次静态替换，
     避免「先清空再转半天」的观感；dataset.odo 仍保留供界面验证读取。 */
  function setOdometer(el, value) {
    const text = String(value);
    if (el.dataset.odo === text) return;
    el.dataset.odo = text;
    el.classList.toggle('odo-empty', text === '');
    el.textContent = text;
  }

  function showError(msg) {
    errorText.textContent = localizeError(msg);
    errorBanner.hidden = false;
  }

  function send(type, extra) {
    return chrome.runtime.sendMessage(Object.assign({ type }, extra)).catch(err => {
      showError(t('error.extension', { msg: err.message }));
    });
  }

  $('error-dismiss').addEventListener('click', () => {
    errorBanner.hidden = true;
    chrome.storage.local.set({ error: null });
  });

  /* 「可领取」卡片：外观与其他卡片一致，点击/键盘激活后在右侧官网面板领取 */
  const CLAIM_URL = 'https://rewards.bing.com/dashboard';
  const claimCard = $('claim-card');
  /* 桌面版优先直连内嵌面板（即时展开，不新开窗口）；浏览器扩展版回退到新标签页。
     登录样式不自定义：右侧加载的就是官方 Rewards / Microsoft 登录页。 */
  /* v1.1.3：四级回退，任何一级抛错都不会让「点击没反应」。
     旧版最后的 chrome.tabs.create 在 window.chrome 注入失败时会同步抛
     TypeError，连带后面的复检逻辑全部不执行 —— 这正是真机的表现。 */
  const openOfficialPanel = url => {
    const target = url || 'https://rewards.bing.com/dashboard';
    try {
      if (chrome.desktopPanel && typeof chrome.desktopPanel.show === 'function') {
        return Promise.resolve(chrome.desktopPanel.show(target));
      }
    } catch {}
    try {
      const d = window.__desktop;
      if (d && typeof d.openOfficial === 'function') {
        return Promise.resolve(d.openOfficial(target));
      }
    } catch {}
    try {
      if (chrome.tabs && typeof chrome.tabs.create === 'function') {
        return Promise.resolve(chrome.tabs.create({ url: target, active: true }));
      }
    } catch {}
    // 最后一层：让后台 host 转交主进程（host 的 shim 通常仍完整）
    try {
      if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage({ type: 'openOfficial', url: target }).catch(() => {});
      }
    } catch {}
    // 全部失败：给出可见反馈，并把现场留给 debug-captures
    try { showError('无法打开官方页面：桌面壳未就绪，请导出 debug-captures 现场包'); } catch {}
    return Promise.resolve(null);
  };
  /* v1.1.5：收起 / 关闭右侧官网面板（登录成功后自动调用） */
  const hideOfficialPanel = () => {
    try {
      if (chrome.desktopPanel && typeof chrome.desktopPanel.hide === 'function') {
        return Promise.resolve(chrome.desktopPanel.hide());
      }
    } catch {}
    try {
      const d = window.__desktop;
      if (d && typeof d.hidePanel === 'function') return Promise.resolve(d.hidePanel());
    } catch {}
    try {
      if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        return Promise.resolve(chrome.runtime.sendMessage({ type: 'hidePanel' })).catch(() => {});
      }
    } catch {}
    return Promise.resolve(null);
  };
  const openClaimPage = () => {
    openOfficialPanel(CLAIM_URL).catch(() => {});
  };
  claimCard.addEventListener('click', openClaimPage);
  claimCard.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClaimPage(); }
  });

  /* 右上角登录徽标：展开右侧「官方登录界面」，随后自动复检直到已登录。
     官网未登录时访问 /dashboard 会自行 302 到 Microsoft 登录页 ——
     登录 UI 由官方页面渲染，我们不仿制。主进程对显式 URL 会强制展开、
     聚焦并重新导航，所以点击一定有可见反馈（旧版常被主窗口挡住）。 */
  /* v1.1.5 · 顶端徽标的两态交互
     未登录：显示「登录」两字，单击打开右侧官网（官方登录页由官网自己渲染）。
     已登录：显示重绘的橙色圆环勋章图标。
             单击 → 收起/关闭右侧侧栏；双击 → 跳转官网页面。
     单击延迟 260ms 派发，双击时取消，避免一次 dblclick 顺带把面板收掉。 */
  let badgeClickTimer = null;
  /* v1.1.6：单击切换侧栏开合，双击打开官网页面（两态行为一致）。
     未登录时单击展开侧栏即为官网登录入口；登录成功后由 awaitingLogin 自动收起。 */
  loginBadge.addEventListener('click', () => {
    try { errorBanner.hidden = true; } catch {}
    try { chrome.storage && chrome.storage.local && chrome.storage.local.set({ error: null }); } catch {}
    if (badgeClickTimer) return;
    badgeClickTimer = setTimeout(() => {
      badgeClickTimer = null;
      /* v1.1.6：panelOpen 由主进程 ui:panel 广播维护；body class 作兜底，
         避免广播延迟时把「切换」误判成「打开」。 */
      const isOpen = panelOpen || document.body.classList.contains('panel-open');
      /* v1.3.3：图标状态由 pointsSummary.available 决定，class 只是它的镜像。
         已登录时单击 / 双击都是纯界面动作：不登记等待登录、不派发同步、
         不写任何业务键，金色图标与三张积分卡保持原样。 */
      const signedIn = loginBadge.classList.contains('in');
      if (isOpen) {
        try { hideOfficialPanel().catch(() => {}); } catch {}
      } else {
        /* 只有未登录时展开官网才是在「去登录」：登录跳回后收起侧栏并同步一次。
           已登录时绝不设 awaitingLogin，否则后续一次状态写回会把刚展开的
           侧栏自动收掉，也会让图标被误判刷新。 */
        awaitingLogin = !signedIn;
        try { openOfficialPanel(CLAIM_URL).catch(() => {}); } catch (e) {
          try { showError('打开官方页面失败：' + (e && e.message || e)); } catch {}
        }
      }
    }, 260);
  });
  loginBadge.addEventListener('dblclick', e => {
    try { e.preventDefault(); } catch {}
    if (badgeClickTimer) { clearTimeout(badgeClickTimer); badgeClickTimer = null; }
    /* 双击打开官网主页（dashboard）。不登记登录、不改图标状态；
       主进程的用户面板动作保护窗口会挡住导航期间的登出信号。 */
    awaitingLogin = false;
    try { openOfficialPanel(CLAIM_URL).catch(() => {}); } catch {}
  });

  if (panelBtn) {
    /* v1.1.3：真机上 chrome.desktopPanel 可能缺失，旧版直接把按钮 hidden，
       用户看到的就是「没有官网按钮、点登录也没反应」。现在按钮始终可用：
       桌面版优先切内嵌面板，缺了就走 __desktop 或新标签页，一定看得见结果。 */
    panelBtn.hidden = false;
    panelBtn.addEventListener('click', () => {
      try {
        if (chrome.desktopPanel && typeof chrome.desktopPanel.toggle === 'function') {
          chrome.desktopPanel.toggle()
            .then(st => setPanelButton(st && st.open)).catch(() => {});
          return;
        }
      } catch {}
      try {
        const d = window.__desktop;
        if (d && typeof d.togglePanel === 'function') {
          d.togglePanel().then(st => setPanelButton(st && st.open)).catch(() => {});
          return;
        }
      } catch {}
      openOfficialPanel(null).catch(() => {});
    });
    try {
      if (chrome.desktopPanel && typeof chrome.desktopPanel.state === 'function') {
        chrome.desktopPanel.state().then(st => setPanelButton(st && st.open)).catch(() => {});
      } else if (window.__desktop && typeof window.__desktop.panelState === 'function') {
        window.__desktop.panelState().then(st => setPanelButton(st && st.open)).catch(() => {});
      }
    } catch {}
    if (chrome.onPanel) chrome.onPanel.addListener(ev => setPanelButton(ev && ev.open));
  }

  /* v1.1.5：收起按钮已删除，仍要接收主进程的面板开合广播，
     否则 body.panel-open 不会更新，侧栏展开时左侧布局会被拉宽。 */
  try {
    if (chrome.onPanel && typeof chrome.onPanel.addListener === 'function') {
      chrome.onPanel.addListener(ev => setPanelButton(ev && ev.open));
    }
    const dp = window.__desktop;
    if (dp && typeof dp.panelState === 'function') {
      dp.panelState().then(st => setPanelButton(st && st.open)).catch(() => {});
    } else if (chrome.desktopPanel && typeof chrome.desktopPanel.state === 'function') {
      chrome.desktopPanel.state().then(st => setPanelButton(st && st.open)).catch(() => {});
    }
  } catch {}

  noticeCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(diagText);
      noticeCopy.textContent = t('notice.copied');
    } catch {
      noticeCopy.textContent = t('notice.copyFailed');
    }
    setTimeout(() => { noticeCopy.textContent = t('notice.copy'); }, 1800);
  });

  const savedThemeMode = () => {
    try {
      const v = localStorage.getItem('theme');
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch { return 'system'; }
  };

  function syncThemeControls() {
    const label = root.getAttribute('data-theme') === 'dark' ? t('theme.toLight') : t('theme.toDark');
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
    setSegment('set-theme', savedThemeMode());
  }

  let fadeTimer = null;
  function applyTheme(mode) {
    const resolved = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;
    const apply = () => {
      root.setAttribute('data-theme', resolved);
      try {
        if (mode === 'system') localStorage.removeItem('theme');
        else localStorage.setItem('theme', mode);
      } catch {}
      chrome.storage.local.set({ uiTheme: mode === 'system' ? null : mode });
      syncThemeControls();
    };
    if (motionOff() || root.getAttribute('data-theme') === resolved) apply();
    else if (typeof document.startViewTransition === 'function') document.startViewTransition(apply);
    else {
      root.classList.add('theme-fade');
      apply();
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => root.classList.remove('theme-fade'), 600);
    }
  }

  themeBtn.addEventListener('click', () => {
    applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  /* 系统语言变化时，跟随系统模式下自动刷新界面文案 */
  window.addEventListener('languagechange', () => {
    if (langMode !== 'system') return;
    lang = systemLang();
    applyI18n();
    refresh();
  });

  function saveSettings(patch) {
    settings = Object.assign({}, settings, patch);
    chrome.storage.local.set({ settings });
    syncSettingsUI();
  }

  function setReduceMotion(on) {
    root.classList.toggle('reduce-motion', on);
    try { localStorage.setItem('reduceMotion', on ? '1' : '0'); } catch {}
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get(['settings']);
    let legacyCount = null;
    try { legacyCount = parseInt(localStorage.getItem('searchCount'), 10); } catch {}
    const base = Object.assign({}, DEFAULTS, Number.isFinite(legacyCount) ? { defaultCount: legacyCount } : {});
    settings = Object.assign(base, data.settings || {});
    setReduceMotion(!!settings.reduceMotion);
    if (!countInput.disabled) countInput.value = settings.defaultCount;
    syncSettingsUI();
    refresh();
  }

  function clampCount() {
    const v = clampInt(countInput.value, 1, 150, settings.defaultCount);
    countInput.value = v;
    return v;
  }

  countInput.addEventListener('change', () => {
    saveSettings({ defaultCount: clampCount() });
    refresh();
  });

  let pendingStartUntil = 0;
  /* v2.9：全完成时在圆圈下方显示绿色小字的时长（毫秒） */
  let allDoneNoticeUntil = 0;
  /* v1.3.3：手动刷新完成后，圆圈下方显示 8 秒绿字「已同步积分」 */
  let syncedNoticeUntil = 0;
  let lastAutoResultAt = 0;
  /* v1.1.8 · 零监控、零自动刷新界面。
     重绘唯一入口：storage.onChanged（业务数据真的写回时）+ 用户交互回调。
     下面两个一次性定时器只用于「用户点击后」收尾临时文案，不读取官网、
     不抓积分、不周期运行；空闲时完全没有定时器在跑。 */
  const uiBootAt = Date.now();
  let uiStartAt = 0;
  const oneShotTimers = new Set();
  function oneShotRefresh(ms) {
    const id = setTimeout(() => { oneShotTimers.delete(id); refresh(); }, Math.max(0, ms));
    oneShotTimers.add(id);
    return id;
  }
  let cooldownRefreshAt = 0;
  /* 启动看门狗（保留作二次保险） */
  let startWatchdogTimer = null;

  function setAction(mode, label, disabled) {
    btnAction.classList.toggle('is-stop', mode === 'stop');
    btnAction.dataset.mode = mode;
    if (actionLabel.textContent !== label) {
      /* v1.3.1：状态切换直接替换文字，不再做弹跳动画 */
      actionLabel.textContent = label;
    }
    btnAction.disabled = !!disabled;
  }

  function ripple(e) {
    if (motionOff()) return;
    const rect = btnAction.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const fromPointer = e.detail > 0 && e.clientX;
    const x = (fromPointer ? e.clientX : rect.left + rect.width / 2) - rect.left - size / 2;
    const y = (fromPointer ? e.clientY : rect.top + rect.height / 2) - rect.top - size / 2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
    btnAction.appendChild(dot);
    dot.addEventListener('animationend', () => dot.remove());
  }

  btnAction.addEventListener('click', async e => {
    ripple(e);
    errorBanner.hidden = true;
    if (btnAction.dataset.mode === 'start') {
      pendingStartUntil = Date.now() + 3000;
      uiStartAt = Date.now();
      oneShotRefresh(3100);              // 到点收尾「正在启动…」，不引入周期刷新
      setAction('stop', t('controls.starting'), true);
      // 看门狗：8 秒内后台没把 running 置 true，就恢复按钮，绝不永久卡在「正在启动…」
      clearTimeout(startWatchdogTimer);
      startWatchdogTimer = setTimeout(async () => {
        try {
          const s = await chrome.storage.local.get(['running']);
          if (!s.running) {
            pendingStartUntil = 0;
            setAction('start', t('controls.start'), false);
          }
        } catch {}
      }, 8000);
      const res = await send('autoComplete', { level: autoTasks.level });
      // v2.9：后台确认全完成 → 零动作，只在圆圈下方显示绿色小字。
      // 注意：正常流程返回的是 skippedCards（跳过的不给分卡片数），不能当成整轮跳过。
      if (res && res.reason === 'signedOut') {
        clearTimeout(startWatchdogTimer);
        pendingStartUntil = 0;
        setAction('start', t('controls.start'), false);
        showError(t('error.signIn'));
      } else if (res && (res.reason === 'allDone' || res.skipped === true)) {
        clearTimeout(startWatchdogTimer);
        showAllDoneNotice();
      } else if (!res) {
        // 后台无响应：错误横幅已由 send() 显示，按钮别一直卡在「启动中」
        clearTimeout(startWatchdogTimer);
        pendingStartUntil = 0;
        setAction('start', t('controls.start'), false);
      } else {
        // 立即应答只表示「已受理」：保留看门狗，后台异常未写 running 时仍能复位按钮
      }
    } else {
      setAction('stop', t('controls.stopping'), true);
      send('stop');
    }
  });

  /* v2.9：圆圈下面那行小字用绿色提示「任务已完成，无需任何动作」。
     不新建元素、不弹窗、不改圆环、不启动任何流程。 */
  function showAllDoneNotice() {
    pendingStartUntil = 0;
    allDoneNoticeUntil = Date.now() + 8000;
    oneShotRefresh(8100);               // 8 秒后收回绿字，替代每秒渲染
    setStatus(t('status.allDone'), 'completed all-done', false);
    setAction('start', t('controls.start'), false);
    // 让读屏软件也读得到
    statusEl.setAttribute('aria-label', t('status.allDone'));
  }

  /* v1.3.3：刷新积分/任务列表完成后的一次性绿色反馈。
     不弹窗、不改圆环、不启动流程，8 秒后由 oneShotRefresh 收回。 */
  function showSyncedNotice() {
    syncedNoticeUntil = Date.now() + 8000;
    oneShotRefresh(8100);
    setStatus(t('status.synced'), 'completed all-done', false);
    statusEl.setAttribute('aria-label', t('status.synced'));
  }

  function setStatus(text, cls, isQuery, title) {
    const key = `${cls}|${isQuery ? 'q' : ''}|${text}|${lang}`;
    if (statusEl.dataset.key === key) return;
    /* v1.3.1：状态文字直接替换，不做宽度补间 / 文字弹跳，刷新时界面更安静 */
    statusEl.dataset.key = key;
    statusEl.style.width = '';
    statusEl.className = 'status ' + cls + (isQuery ? ' show-query' : '');
    statusText.textContent = text;
    if (title) statusEl.title = title;
    else statusEl.removeAttribute('title');
  }

  function setTip(id, title, lines, note) {
    const tip = $(id);
    const key = JSON.stringify([title, lines, note]);
    if (tip.dataset.key === key) return;
    tip.dataset.key = key;
    tip.textContent = '';
    const head = document.createElement('span');
    head.className = 'tip-title';
    head.textContent = title;
    tip.appendChild(head);
    for (const line of lines) {
      const row = document.createElement('span');
      row.className = 'tip-line' + (line.done ? ' done' : '') + (line.sub ? ' sub' : '');
      const name = document.createElement('span');
      name.textContent = line.name;
      const val = document.createElement('span');
      val.className = 'tip-val';
      val.textContent = line.value;
      row.append(name, val);
      tip.appendChild(row);
    }
    if (note) {
      const n = document.createElement('span');
      n.className = 'tip-note';
      n.textContent = note;
      tip.appendChild(n);
    }
  }

  function setRing(pct) {
    const p = Math.max(0, Math.min(1, pct));
    arc.style.strokeDashoffset = ARC_LENGTH * (1 - p);
    arc.classList.toggle('empty', p === 0);
    ring.setAttribute('aria-valuenow', Math.round(p * 100));
  }

  function setNotice() { /* 提示模块已移除，不再显示任何积分/冷却提示 */ }

  const STATUS = () => ({
    idle: [t('status.ready'), 'stopped'],
    fetchingStartPoints: [t('status.reading'), 'running'],
    checkingLimit: [t('status.checking'), 'running'],
    searching: [t('status.searching'), 'running'],
    cooldown: [t('status.cooldown'), 'cooldown'],
    fetchingEndPoints: [t('status.finalizing'), 'running'],
    completingTasks: [t('status.completingTasks'), 'running'],
    syncing: [t('status.syncing'), 'running'],
    completed: [t('status.completed'), 'completed'],
    limitReached: [t('status.limit'), 'completed'],
    error: [t('status.error'), 'error']
  });

  /* v1.1.1 · 右上角登录徽标：与官网 Rewards 右上角同款。
     已登录 → 可用积分 + 橙色勋章 + 圆形头像（官网右上角那一组）；
     未登录 / 未确认 → 官网的「登录」按钮。两态都点击展开右侧官方登录页。 */
  function renderLoginBadge(d) {
    /* v1.3.2：登录状态直接绑定可用积分——能解析出 available 就是已登录。
       不再读 loginStatus / todayTasks：运行中一次页面抖动、/earn 单页登录页、
       或主进程把 loginStatus 写成 'out'，都不会把 20,192 分显示成「未登录」。 */
    const ps = d.pointsSummary || {};
    const signedIn = Number.isFinite(ps.available);
    loginBadge.className = 'login-badge ' + (signedIn ? 'in' : 'signed-out');
    /* v1.1.6：两态都显示重绘的勋章图标 + 下方状态文字。
       未登录 → 灰色图标 +「未登录」；已登录 → 金色图标 +「已登录」。
       不显示积分数字、不显示头像 —— 顶端只有两个按键。 */
    try { loginBadgeText.hidden = false; } catch {}
    try { loginBadgeText.textContent = t(signedIn ? 'login.in' : 'login.out'); } catch {}
    try { if (loginBadgeIcon) loginBadgeIcon.hidden = false; } catch {}
    loginBadge.removeAttribute('title');   // 不要原生黑色 tooltip，用自定义气泡
    const tip = $('login-badge-tip');
    const tipText = t('login.tip');
    try { if (tip) tip.textContent = tipText; } catch {}
    loginBadge.setAttribute('aria-label',
      (signedIn ? t('login.in') : t('login.out')) + ' · ' + tipText);
  }

  function render(d) {
    renderLoginBadge(d);
    const statusMap = STATUS();
    const phase = statusMap[d.phase] ? d.phase : 'idle';
    const running = !!d.running;
    const current = d.currentSearch || 0;
    const total = d.totalSearch || 0;
    const start = d.startPoints || 0;
    const startKnown = !!d.startKnown;
    const today = d.todaySearch && d.todaySearch.max > 0 ? d.todaySearch : null;
    const todayStart = d.todayStart && d.todayStart.max > 0 ? d.todayStart : null;
    const live = !!(d.liveCheck && today && todayStart);
    const remaining = todayStart ? Math.max(0, todayStart.max - todayStart.progress) : Infinity;
    const estimate = live
      ? Math.max(0, today.progress - todayStart.progress)
      : Math.min(current * POINTS_PER_SEARCH, remaining);
    const inSearch = ['searching', 'cooldown', 'fetchingEndPoints'].includes(phase);
    const cooldownLeft = phase === 'cooldown' ? Math.max(0, (d.cooldownUntil || 0) - Date.now()) : 0;
    const [label, cls] = statusMap[phase];
    const showQuery = phase === 'searching' && !d.stopRequested && !!d.currentQuery;
    // 全完成提示优先：storage 变化触发的 render 不能把绿色小字冲掉
    if (running) { allDoneNoticeUntil = 0; syncedNoticeUntil = 0; }
    const noticeActive = !running && Date.now() < allDoneNoticeUntil;
    const syncedActive = !running && Date.now() < syncedNoticeUntil;
    /* v1.3.8：运行详情直接复用这个状态行（原绿色小字所在位置），不新增文本框 */
    const act = activityLine(d, cls);
    if (act) {
      setStatus(act.text, act.cls, false);
      statusEl.setAttribute('aria-label', act.text);
      statusEl.title = act.text; // 长句被省略时，悬停仍可读到全文
      if (act.until) scheduleCountdown(act.until, act.template, act.cls);
      else stopCountdown();
    } else {
      stopCountdown();
      if (noticeActive) {
        setStatus(t('status.allDone'), 'completed all-done', false);
      } else if (syncedActive) {
        setStatus(t('status.synced'), 'completed all-done', false);
      } else if (d.cooldownGaveUp && !running) {
        // 等待次数用尽仍无法增加积分：明确告知已提前结束
        setStatus(t('status.gaveUp'), 'completed all-done', false);
      } else if (phase === 'cooldown') {
        const n = clampInt(d.cooldownCycles || 1, 1, MAX_COOLDOWNS);
        setStatus(t('status.cooldownRound', { n, max: MAX_COOLDOWNS }), 'cooldown', false);
      } else if (showQuery) {
        setStatus(d.currentQuery, cls, true, t('status.searchingTitle', { q: d.currentQuery }));
      } else if (phase === 'searching') {
        setStatus(d.stopRequested ? t('status.stopping') : t('status.of', { a: current, b: total }), cls, false);
      } else {
        setStatus(label, cls, false);
      }
    }

    // 圆环与下方「今日任务」汇总保持一致：只显示百分比，不显示积分/搜索次数
    const tt = d.todayTasks || {};
    const hasTasks = Array.isArray(tt.items) && tt.items.length > 0;
    const taskPct = hasTasks ? Math.max(0, Math.min(100, Number(tt.percent) || 0)) : 0;
    ring.classList.remove('spinning');
    setOdometer(progressText, hasTasks ? `${taskPct}%` : '—');
    // v1.1.8：不再逐秒重绘，也不再安排等待结束的自动刷新。
    // 冷却结束时后台会写 phase / 积分，storage.onChanged 自然触发一次重绘。
    if (phase === 'cooldown' && cooldownLeft > 0) {
      const mins = Math.max(1, Math.ceil(cooldownLeft / 60000));
      progressSub.textContent = t('progress.cooldownLeft',
        { t: mins + (lang === 'en' ? ' min' : ' 分钟') });
      progressSub.classList.add('cooldown');
      cooldownRefreshAt = d.cooldownUntil || 0;
    } else {
      cooldownRefreshAt = 0;
      progressSub.textContent = t('progress.tasks');
      progressSub.classList.remove('cooldown');
    }
    setRing(hasTasks ? taskPct / 100 : 0);

    // 三张卡固定取 dashboard / earn 页面解析出的值，不再随运行状态估算
    const ps = d.pointsSummary || {};
    const panelVal = v => Number.isFinite(v) ? fmt(v) : '—';
    setOdometer(startEl, panelVal(ps.available));
    setOdometer(currentEl, panelVal(ps.today));
    setOdometer(earnedEl, panelVal(ps.claimable));
    earnedEl.className = 'point-value';
    earnedLabel.textContent = t('points.earned');

    const hc = $('ring-hover-card');
    if (hc) {
      const row = hc.querySelector('.rhc-row');
      if (row) row.textContent = t('progress.tasks') + ' · ' + (hasTasks ? taskPct + '%' : '—');
    }
    const panelNote = ps.signedOut ? t('tip.signedOut') : (ps.updatedAt ? '' : t('tip.loading'));
    setTip('tip-start', t('tip.startTitle'), [], panelNote || t('tip.available'));
    setTip('tip-current', t('tip.currentTitle'), [], panelNote || t('tip.todayPoints'));
    setTip('tip-earned', t('tip.earnedTitle'), [], panelNote || t('tip.claimOpen'));

    // 「今日搜索积分已领完」等提示与「今日 Bing 搜索」进度条已从界面移除
    setNotice(null);
    daily.hidden = true;
    renderTodayTasks(d.todayTasks);
    diagText = JSON.stringify({ start: d.diag || null, limit: d.diagLimit || null }, null, 2);
    noticeCopy.hidden = true;

    if (d.error) showError(d.error);

    /* 后台把长流程结果写进 autoResult：未登录/数据不可用时立刻复位按钮并复检，
       全完成时显示绿色小字，不必等 8 秒看门狗。 */
    if (d.autoResult && d.autoResult.at && d.autoResult.at !== lastAutoResultAt) {
      lastAutoResultAt = d.autoResult.at;
      const r = d.autoResult;
      if (!running) {
        clearTimeout(startWatchdogTimer);
        pendingStartUntil = 0;
        if (r.reason === 'allDone' || r.skipped === true) showAllDoneNotice();
        else setAction('start', t('controls.start'), false);
        /* v1.1.8：不再启动登录轮询，避免空闲时反复探测登录态 */
      }
    }

    if (running) {
      pendingStartUntil = 0;
      countInput.disabled = true;
      if (phase === 'fetchingEndPoints') setAction('stop', t('controls.finishing'), true);
      else if (d.stopRequested) setAction('stop', t('controls.stopping'), true);
      else setAction('stop', t('controls.stop'), false);
    } else if (uiStartAt && Date.now() - uiStartAt < 3000 && Date.now() < pendingStartUntil) {
      setAction('stop', t('controls.starting'), true);
    } else {
      uiStartAt = 0;
      countInput.disabled = false;
      setAction('start', t('controls.start'), false);
    }
  }

  let pending = false;
  function refresh() {
    if (pending) return;
    pending = true;
    // 必须用微任务：失焦窗口的 setTimeout(0) 会被 Chromium 节流到分钟级，
    // 旧版就是因此让「正在启动… / 正在读取今日任务…」永远不更新。
    Promise.resolve().then(async () => {
      pending = false;
      try {
        render(await chrome.storage.local.get(KEYS));
      } catch (err) {
        console.warn('Render failed:', err.message);
      }
    });
  }

  /* ------------------------------------------------------- 自动完成任务设置状态 */
  function normalizeAutoTasks(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const times = [...new Set(
      (Array.isArray(src.times) ? src.times : [])
        .map(v => String(v || '').trim())
        .filter(v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v))
    )].sort().slice(0, AUTO_MAX_TIMES);
    return {
      enabled: !!src.enabled,
      times,
      count: clampInt(src.count, 1, 150, AUTO_DEFAULTS.count),
      level: clampInt(src.level, 1, 3, AUTO_DEFAULTS.level)
    };
  }

  let autoSavedAt = 0;
  function saveAutoTasks(patch) {
    autoTasks = normalizeAutoTasks(Object.assign({}, autoTasks, patch));
    autoSavedAt = Date.now();
    chrome.storage.local.set({ autoTasks });
    syncAutoUI();
  }

  function setAutoMsg(text, warn) {
    const el = $('set-auto-msg');
    const stamp = String(text || '');
    el.textContent = stamp;
    el.classList.toggle('warn', !!warn);
    el.hidden = !stamp;
    if (stamp) setTimeout(() => { if (el.textContent === stamp) el.hidden = true; }, 4000);
  }

  function setTodayMsg(text, warn) {
    const el = $('today-tasks-msg');
    const stamp = String(text || '');
    el.textContent = stamp;
    el.classList.toggle('warn', !!warn);
    el.hidden = !stamp;
    if (stamp) setTimeout(() => { if (el.textContent === stamp) el.hidden = true; }, 4000);
  }

  function syncAutoUI() {
    $('set-auto').checked = !!autoTasks.enabled;
    const opts = $('auto-opts');
    opts.classList.toggle('off', !autoTasks.enabled);
    // 关闭总开关时仍可配置时间点；说明写进页内提示，不再用原生 title
    // （原生 title 是鼠标悬停时的黑色系统提示框，观感像「只有黑圈提示」）
    const hint = $('auto-disabled-hint');
    if (hint) { hint.hidden = !!autoTasks.enabled; hint.textContent = t('tasks.disabledTip'); }
    opts.removeAttribute('title');
    setSegment('set-auto-count-chips', autoTasks.count);
    const isPreset = [10, 20, 30, 50].includes(Number(autoTasks.count));
    const custom = $('set-auto-count');
    if (document.activeElement !== custom) custom.value = isPreset ? '' : autoTasks.count;
    custom.classList.toggle('custom', !isPreset);
    setSegment('set-auto-level', autoTasks.level);
    const wrap = $('set-auto-times');
    wrap.textContent = '';
    for (const time of autoTasks.times) {
      const chip = document.createElement('span');
      chip.className = 'time-chip';
      const label = document.createElement('span');
      label.textContent = time;
      const del = document.createElement('button');
      del.type = 'button';
      del.dataset.time = time;
      del.setAttribute('aria-label', t('tasks.remove'));
      del.title = t('tasks.remove');
      del.textContent = '×';
      chip.append(label, del);
      wrap.appendChild(chip);
    }
    $('set-lang') && setSegment('set-lang', langMode);
  }

  /* ------------------------------------------------------- 今日任务列表（首页） */
  const SECTION_TITLES = {
    search: 'todayTasks.sectionSearch', daily: 'todayTasks.sectionDaily',
    promo: 'todayTasks.sectionPromo', other: 'todayTasks.sectionOther'
  };
  const SECTION_ORDER = ['search', 'daily', 'promo'];

  function renderTodayTasks(data) {
    const summary = $('today-tasks-summary');
    const fill = $('today-tasks-fill');
    const groups = $('today-tasks-groups');
    const empty = $('today-tasks-empty');
    const note = $('today-tasks-note');
    // 只显示有积分的任务：后台已过滤，这里再兜一次，避免旧缓存混入推广卡片
    const items = (data && Array.isArray(data.items) ? data.items : [])
      .filter(it => Number(it.points) > 0 || Number(it.total) > 0);

    if (!items.length) {
      groups.textContent = '';
      groups.dataset.key = '';
      empty.hidden = false;
      empty.textContent = data && data.signedOut ? t('todayTasks.emptyLogin')
        : (Date.now() - uiBootAt > 6000 && !(data && data.updatedAt)
            ? t('todayTasks.noData') : t('todayTasks.empty'));
      note.hidden = true;
      summary.textContent = '—';
      fill.style.width = '0%';
      return;
    }

    empty.hidden = true;
    note.hidden = false;
    const pct = Math.max(0, Math.min(100, Number(data.percent) || 0));
    // 任务积分合计与「今日积分」不一致是正常现象（周任务、额外奖励分），二者互不换算、不比较
    summary.textContent = t('todayTasks.summary', { p: pct, a: fmt(data.earned), b: fmt(data.total) })
      + (data.approx ? ' · ' + t('todayTasks.approx') : '');
    fill.style.width = pct + '%';

    const key = JSON.stringify([lang, items, data.earned, data.total, data.percent, data.approx, data.signedOut]);
    if (groups.dataset.key === key) return;
    groups.dataset.key = key;
    groups.textContent = '';

    for (const section of SECTION_ORDER) {
      const list = items.filter(it => (it.section || 'other') === section);
      if (!list.length) continue;
      const group = document.createElement('div');
      group.className = 'tt-group';
      const head = document.createElement('div');
      head.className = 'tt-group-head';
      const label = document.createElement('span');
      label.textContent = t(SECTION_TITLES[section] || SECTION_TITLES.other);
      const totals = document.createElement('span');
      const got = list.reduce((n, it) => n + (Number(it.earned) || 0), 0);
      const all = list.reduce((n, it) => n + (Number(it.points) || 0), 0);
      totals.textContent = t('todayTasks.groupTotal', { a: fmt(got), b: fmt(all) });
      head.append(label, totals);
      group.appendChild(head);

      const cards = document.createElement('div');
      cards.className = 'tt-cards';
      for (const it of list) {
        const pts = Number(it.points) || 0;
        const done = !!it.completed || Number(it.earned) >= pts;
        const card = document.createElement('div');
        card.className = 'tt-card' + (done ? ' done' : '');
        const badge = document.createElement('span');
        badge.className = 'tt-badge' + (done ? '' : ' pending');
        badge.textContent = (done ? '✓' : '') + pts;
        const main = document.createElement('span');
        main.className = 'tt-card-main';
        const title = document.createElement('span');
        title.className = 'tt-card-title';
        title.textContent = it.name;
        title.title = it.name;
        main.appendChild(title);
        if (it.description) {
          const desc = document.createElement('span');
          desc.className = 'tt-card-desc';
          desc.textContent = it.description;
          desc.title = it.description;
          main.appendChild(desc);
        }
        const state = document.createElement('span');
        state.className = 'tt-card-state' + (done ? '' : ' pending');
        state.textContent = t(done ? 'todayTasks.done' : 'todayTasks.pending');
        card.append(badge, main, state);
        cards.appendChild(card);
      }
      group.appendChild(cards);
      groups.appendChild(group);
    }
  }

  $('today-tasks-refresh').addEventListener('click', async () => {
    /* v1.3.1：刷新期间界面完全不动（不清空、不显示「正在刷新…」）。
       后台 desktopSyncRewards 拿到完整两页数据后一次原子写回，
       storage.onChanged 只重绘一次，没有中间态与动画。 */
    const btn = $('today-tasks-refresh');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await send('refreshTasks');
    } catch (err) {
      console.warn('Refresh failed:', err && err.message || err);
    } finally {
      btn.disabled = false;
    }
  });

  /* ------------------------------------------------------------- 设置面板 */
  const panel = $('settings');
  const openBtn = $('settings-open');

  function openSettings() {
    syncSettingsUI();
    body.classList.add('settings-open');
    panel.inert = false;
    main.inert = true;
    panel.classList.add('open');
    setTimeout(() => $('settings-back').focus(), 60);
  }

  function closeSettings() {
    panel.classList.remove('open');
    panel.inert = true;
    main.inert = false;
    body.classList.remove('settings-open');
    openBtn.focus();
    refresh();
  }

  openBtn.addEventListener('click', openSettings);
  $('settings-back').addEventListener('click', closeSettings);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && panel.classList.contains('open')) closeSettings();
  });

  function setSegment(id, value) {
    const el = $(id);
    if (!el) return;
    for (const b of el.querySelectorAll('button[data-value]')) {
      b.setAttribute('aria-checked', String(b.dataset.value === String(value)));
    }
  }

  function onSegment(id, handler) {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', e => {
      const b = e.target.closest('button[data-value]');
      if (b) handler(b.dataset.value);
    });
  }

  function syncSettingsUI() {
    setSegment('set-theme', savedThemeMode());
    setSegment('set-lang', langMode);
    $('set-reduce').checked = !!settings.reduceMotion;
    $('set-not-skip-completed').checked = !!settings.notSkipCompletedCards;
    $('set-card-interval').value = Number.isFinite(Number(settings.cardClickIntervalSec))
      ? Math.max(1, Math.min(60, Math.round(Number(settings.cardClickIntervalSec)))) : 10;
    /* 搜索次数 / 节奏 / 每日上限使用自动任务设置；桌面和插件 UI 保持一致。 */
    syncAutoUI();
    renderPointsCalendar();
  }

  onSegment('set-lang', v => setLang(v));
  onSegment('cal-mode', v => { calMode = v; renderPointsCalendar(); });
  $('cal-prev').addEventListener('click', () => moveCalendar(-1));
  $('cal-next').addEventListener('click', () => moveCalendar(1));
  onSegment('set-theme', mode => applyTheme(mode));
  $('set-reduce').addEventListener('change', e => {
    setReduceMotion(e.target.checked);
    saveSettings({ reduceMotion: e.target.checked });
  });

  $('set-not-skip-completed').addEventListener('change', e =>
    saveSettings({ notSkipCompletedCards: e.target.checked }));
  $('set-card-interval').addEventListener('change', e => {
    const n = Number(e.target.value);
    const interval = Number.isFinite(n) ? Math.max(1, Math.min(60, Math.round(n))) : 10;
    saveSettings({ cardClickIntervalSec: interval });
  });

  /* 自动完成任务设置 */
  $('set-auto').addEventListener('change', e => saveAutoTasks({ enabled: e.target.checked }));
  onSegment('set-auto-count-chips', v => saveAutoTasks({ count: v }));
  $('set-auto-count').addEventListener('change', e => {
    if (e.target.value !== '') saveAutoTasks({ count: e.target.value });
  });
  onSegment('set-auto-level', v => saveAutoTasks({ level: Number(v) }));

  /* 启动时间：不手动输入时按默认规则生成
     · 第一个时间点 = 当地时间 08:00
     · 之后 = 当前最晚时间点 + 30 分钟（跨天取模，撞上已有时间就继续顺延） */
  const toMinutes = hhmm => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const toHHMM = mins => {
    const v = ((mins % 1440) + 1440) % 1440;
    return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
  };
  function defaultAutoTime(times) {
    if (!times.length) return '08:00';
    const used = new Set(times);
    const latest = Math.max(...times.map(toMinutes));
    for (let step = 1; step <= 48; step++) {
      const candidate = toHHMM(latest + step * 30);
      if (!used.has(candidate)) return candidate;
    }
    return null;
  }

  function addAutoTime() {
    const input = $('set-auto-time');
    const raw = String(input.value || '').trim();
    const auto = raw === '';
    let value = raw;
    if (auto) {
      if (autoTasks.times.length >= AUTO_MAX_TIMES) { setAutoMsg(t('tasks.limit'), true); return; }
      value = defaultAutoTime(autoTasks.times);
      if (!value) { setAutoMsg(t('tasks.duplicate'), true); return; }
    } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      setAutoMsg(t('tasks.invalid'), true); return;
    }
    if (autoTasks.times.includes(value)) { setAutoMsg(t('tasks.duplicate'), true); return; }
    if (autoTasks.times.length >= AUTO_MAX_TIMES) { setAutoMsg(t('tasks.limit'), true); return; }
    saveAutoTasks({ times: [...autoTasks.times, value] });
    input.value = '';
    setAutoMsg(t(auto ? 'tasks.autoAdded' : 'tasks.added', { time: value }));
  }
  $('set-auto-time-add').addEventListener('click', addAutoTime);
  $('set-auto-time').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addAutoTime(); }
  });
  $('set-auto-times').addEventListener('click', e => {
    const btn = e.target.closest('button[data-time]');
    if (!btn) return;
    saveAutoTasks({ times: autoTasks.times.filter(v => v !== btn.dataset.time) });
    setAutoMsg(t('tasks.removed', { time: btn.dataset.time }));
  });

  const resetBtn = $('set-reset');
  let resetTimer = null;
  function resetLabel(text) { resetBtn.textContent = text; }
  resetBtn.addEventListener('click', () => {
    if (!resetBtn.classList.contains('confirm')) {
      resetBtn.classList.add('confirm');
      resetLabel(t('settings.resetConfirm'));
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        resetBtn.classList.remove('confirm');
        resetLabel(t('settings.reset'));
      }, 3000);
      return;
    }
    clearTimeout(resetTimer);
    resetBtn.classList.remove('confirm');
    resetLabel(t('settings.reset'));
    setReduceMotion(false);
    saveSettings(Object.assign({}, DEFAULTS));
    saveAutoTasks(Object.assign({}, AUTO_DEFAULTS));
    applyTheme('system');
    langMode = 'system';
    lang = systemLang();
    chrome.storage.local.set({ uiLang: 'system' });
    applyI18n();
    syncSettingsUI();
    if (!countInput.disabled) countInput.value = DEFAULTS.defaultCount;
    refresh();
  });

  /* ------------------------------------------------------------------
   * v1.3.8 · 运行详情（单行、稍详细）
   * 不新增文本框：写进进度圆圈下方原有状态行 #status-text（原绿色小字位置）。
   * 等待类动作把 {s} 换成剩余秒数倒计时；到点即停，不写 storage。
   * ---------------------------------------------------------------- */
  let countdownTimer = null;
  function stopCountdown() {
    if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }
  }
  function scheduleCountdown(until, template, cls) {
    stopCountdown();
    const step = () => {
      countdownTimer = null;
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      const text = template.split('{s}').join(String(left));
      if (statusText.textContent !== text) {
        statusText.textContent = text;
        statusEl.dataset.key = cls + '||' + text + '|' + lang;
      }
      if (until <= Date.now()) return;
      const nextTick = Math.min(1000, Math.max(120, (until - Date.now()) - (left - 1) * 1000));
      countdownTimer = setTimeout(step, nextTick);
    };
    step();
  }
  function activityLine(d, phaseCls) {
    const a = d && d.activityDetail;
    if (!a || !a.at) return null;
    if (!d.running && Date.now() - a.at > 12000) return null;
    const tpl = (lang === 'en' ? a.en : a.zh) || '';
    if (!tpl) return null;
    const green = a.state === 'synced' || a.state === 'allDone' || a.state === 'done';
    const cls = green ? 'completed all-done'
      : (a.state === 'syncFailed' ? 'error' : phaseCls);
    const until = a.state === 'waiting' && Number(a.until) > Date.now()
      ? Number(a.until) : 0;
    const text = tpl.split('{s}').join(
      String(until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0));
    return { text: text, cls: cls + ' activity', green: green,
             until: until, template: tpl };
  }

  /* ------------------------------------------------------------------
   * v1.3.8 · 积分日历（支付宝收益日历风格）
   *  · 日 / 周 / 月三种汇总，统一圆角正方形格子
   *  · 格子只显示积分，不显示日期数字；日期放在悬停提示里
   *  · 过去无积分 = 浅灰；未来 = 不显示方块；有积分 = 淡蓝；今日 = 细描边
   * ---------------------------------------------------------------- */
  let calMode = 'day';
  let calCursor = new Date();
  let calRenderId = 0;
  const pad2 = n => String(n).padStart(2, '0');
  const dkey = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const addDays = (d, n) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  };
  const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
  const histValue = (h, k) => {
    const e = h && h[k];
    if (!e) return null;
    const v = Number(e.today != null ? e.today : e.points);
    return Number.isFinite(v) ? v : null;
  };
  const ptsText = n => Number(n || 0).toLocaleString();
  const calDateLabel = d => lang === 'en'
    ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
      + ' ' + d.getDate()
    : (d.getMonth() + 1) + '月' + d.getDate() + '日';

  function calCell(value, cls, tip, tag) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell ' + cls;
    cell.setAttribute('role', 'gridcell');
    cell.textContent = value == null ? '·' : ptsText(value);
    if (tip) { cell.dataset.tip = tip; cell.dataset.tipRole = 'cell'; }
    if (tag) {
      const el = document.createElement('span');
      el.className = 'cal-tag';
      el.textContent = tag;
      cell.appendChild(el);
    }
    return cell;
  }
  function dayClass(k, value, todayK) {
    if (k > todayK) return 'cal-day cal-blank';
    return 'cal-day ' + (value > 0 ? 'cal-has' : 'cal-past-empty')
      + (k === todayK ? ' cal-today' : '');
  }
  // Week: spacious horizontal cards with a 7-day activity strip. Month:
  // twelve balanced summary cards. Both are real DOM, not canvas snapshots.
  function periodCell(value, cls, tag, tip, detail) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell ' + cls;
    cell.setAttribute('role', 'gridcell');
    if (tip) { cell.dataset.tip = tip; cell.dataset.tipRole = 'cell'; }
    const heading = document.createElement('span');
    heading.className = 'cal-period-name';
    heading.textContent = tag;
    const points = document.createElement('strong');
    points.className = 'cal-period-points';
    points.textContent = value != null && value > 0 ? ptsText(value) : '—';
    const days = document.createElement('span');
    days.className = 'cal-period-days';
    days.textContent = detail && detail.subtext || '';
    cell.append(heading, points, days);
    if (detail && Array.isArray(detail.daily)) {
      const strip = document.createElement('div');
      strip.className = 'cal-week-strip';
      for (const d of detail.daily) {
        const bar = document.createElement('span');
        bar.className = 'cal-week-dot' + (d.future ? ' is-future' : d.value > 0 ? ' is-earned' : '');
        bar.title = d.label + ' · ' + (d.value > 0 ? ptsText(d.value) : '0');
        bar.setAttribute('aria-label', bar.title);
        strip.appendChild(bar);
      }
      cell.appendChild(strip);
    }
    return cell;
  }

  async function renderPointsCalendar() {
    const renderId = ++calRenderId;
    const grid = $('cal-grid');
    if (!grid) return;
    let s = {};
    try { s = await chrome.storage.local.get(['pointsHistory', 'pointsSummary']); } catch {}
    if (renderId !== calRenderId) return;
    const hist = Object.assign({}, (s && s.pointsHistory) || {});
    const ps = (s && s.pointsSummary) || {};
    const now = new Date();
    const todayK = dkey(now);
    if (!hist[todayK] && Number.isFinite(ps.today)) {
      hist[todayK] = { today: ps.today, at: Date.now() };
    }
    const weekdays = $('cal-weekdays');
    if (weekdays) {
      weekdays.textContent = '';
      if (calMode === 'day') {
        const names = lang === 'en'
          ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
          : ['一', '二', '三', '四', '五', '六', '日'];
        for (const n of names) {
          const sp = document.createElement('span');
          sp.textContent = n;
          weekdays.appendChild(sp);
        }
      }
    }
    const range = $('cal-range'), sum = $('cal-summary');
    const heroTotal = $('cal-total'), heroLabel = $('cal-hero-label');
    grid.className = 'cal-grid cal-' + calMode;
    grid.textContent = '';
    const y = calCursor.getFullYear(), m = calCursor.getMonth();
    // Period values determine which cards are highlighted; daily values determine
    // the true day-average, day-maximum, and number of earning days in every view.
    const vals = [];
    const earningDays = [];
    if (calMode === 'day') {
      if (range) range.textContent = y + ' / ' + pad2(m + 1);
      const start = mondayOf(new Date(y, m, 1));
      for (let i = 0; i < 42; i++) {
        const d = addDays(start, i);
        const inMonth = d.getMonth() === m;
        const k = dkey(d);
        const v = inMonth ? histValue(hist, k) : null;
        const blank = !inMonth || k > todayK;
        if (inMonth && v > 0 && k <= todayK) { vals.push(v); earningDays.push(v); }
        const tip = blank ? '' : (v > 0
          ? t('calendar.cellTip', { date: calDateLabel(d), points: ptsText(v) })
          : t('calendar.noPointsTip', { date: calDateLabel(d) }));
        grid.appendChild(calCell(blank ? null : (v > 0 ? v : null),
          blank ? 'cal-day cal-blank' : dayClass(k, v, todayK), tip));
      }
    } else if (calMode === 'week') {
      if (range) range.textContent = y + ' / ' + pad2(m + 1);
      const first = new Date(y, m, 1);
      const start = mondayOf(first);
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const weeks = Math.ceil((((first.getDay() + 6) % 7) + daysInMonth) / 7);
      for (let w = 0; w < weeks; w++) {
        let total = 0, hit = 0;
        const weekStart = addDays(start, w * 7);
        const weekEnd = addDays(weekStart, 6);
        const daily = [];
        for (let i = 0; i < 7; i++) {
          const d = addDays(weekStart, i), k = dkey(d);
          const within = d.getMonth() === m && k <= todayK;
          const v = within ? histValue(hist, k) : null;
          if (v > 0) { total += v; hit++; earningDays.push(v); }
          daily.push({value:v || 0, label:calDateLabel(d), future: !within});
        }
        if (hit) vals.push(total);
        const tag = t('calendar.weekLabel', {n:w + 1}) + '  ·  '
          + pad2(weekStart.getMonth() + 1) + '/' + pad2(weekStart.getDate())
          + ' – ' + pad2(weekEnd.getMonth() + 1) + '/' + pad2(weekEnd.getDate());
        const future = dkey(weekStart) > todayK;
        const cls = 'cal-week ' + (future ? 'cal-blank' : hit ? 'cal-has' : 'cal-past-empty');
        const tip = future ? '' : (hit
          ? t('calendar.cellTip', {date:tag, points:ptsText(total)})
          : t('calendar.noPointsTip', {date:tag}));
        const details = {daily:daily, subtext:t('calendar.earnedDays', {n:hit})};
        grid.appendChild(periodCell(future ? null : total, cls, tag, tip, details));
      }
    } else {
      if (range) range.textContent = String(y);
      for (let mm = 0; mm < 12; mm++) {
        let total = 0, hit = 0;
        const prefix = y + '-' + pad2(mm + 1);
        const future = prefix > todayK.slice(0, 7);
        for (const k of Object.keys(hist)) {
          if (k.slice(0, 7) !== prefix || k > todayK) continue;
          const v = histValue(hist, k);
          if (v > 0) { total += v; hit++; earningDays.push(v); }
        }
        if (hit) vals.push(total);
        const tag = t('calendar.monthLabel', {n:mm + 1});
        const cls = 'cal-month ' + (future ? 'cal-blank' : hit ? 'cal-has' : 'cal-past-empty');
        const tip = future ? '' : (hit
          ? t('calendar.cellTip', {date:tag, points:ptsText(total)})
          : t('calendar.noPointsTip', {date:tag}));
        grid.appendChild(periodCell(future ? null : total, cls, tag, tip,
          {subtext:future ? '' : t('calendar.earnedDays', {n:hit})}));
      }
    }
    const total = vals.reduce((a, b) => a + b, 0);
    // A week/month contains multiple earning days: report actual daily
    // averages and daily peaks instead of averaging whole period totals.
    const avg = earningDays.length ? Math.round(total / earningDays.length) : 0;
    const max = earningDays.length ? Math.max.apply(null, earningDays) : 0;
    if (heroTotal) heroTotal.textContent = ptsText(total);
    if (heroLabel) heroLabel.textContent = t(calMode === 'month'
      ? 'calendar.yearLabel' : 'calendar.totalLabel');
    if (sum) {
      sum.textContent = t('calendar.summary', {
        total: ptsText(total), avg: ptsText(avg), max: ptsText(max), n: earningDays.length
      }) + (earningDays.length ? '' : ' · ' + t('calendar.empty'));
    }
    setSegment('cal-mode', calMode);
    // Do not imply available history outside the recorded range. The arrows
    // stay operable for navigating gaps, but both become grey on empty pages.
    const hasPointsIn = step => {
      const base = calMode === 'month'
        ? new Date(y + step, 0, 1) : new Date(y, m + step, 1);
      const prefix = calMode === 'month'
        ? String(base.getFullYear()) : base.getFullYear() + '-' + pad2(base.getMonth() + 1);
      return Object.keys(hist).some(k => k.startsWith(prefix)
        && k > '0000-00-00' && k <= todayK && histValue(hist, k) > 0);
    };
    for (const [id, step] of [['cal-prev', -1], ['cal-next', 1]]) {
      const btn = $(id);
      if (!btn) continue;
      const empty = vals.length === 0 || !hasPointsIn(step);
      btn.classList.toggle('cal-nav-empty', empty);
      btn.setAttribute('data-empty', String(empty));
      btn.setAttribute('aria-description', empty ? t('calendar.navEmpty') : '');
    }
  }

  function moveCalendar(step) {
    const y = calCursor.getFullYear(), m = calCursor.getMonth();
    calCursor = calMode === 'month'
      ? new Date(y + step, m, 1)
      : new Date(y, m + step, 1);
    renderPointsCalendar();
  }

  /* 桌面版专有设置：扩展端没有这组 DOM，直接返回。 */
  function setDesktopMsg(text) {
    const el = $('desktop-msg');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.hidden = true; }, 4000);
  }
  async function loadDesktopPrefs() {
    const auto = $('set-auto-launch'), silent = $('set-silent-run');
    if (!auto || !silent) return;
    const api = (typeof chrome !== 'undefined' && chrome.desktopApp) || null;
    if (!api || typeof api.setAutoLaunch !== 'function') return;
    let on = false;
    try { on = !!(await api.getAutoLaunch()); } catch {}
    auto.checked = on;
    try {
      const s = await chrome.storage.local.get(['silentRun']);
      silent.checked = !!s.silentRun;
    } catch {}
    auto.addEventListener('change', async e => {
      const v = !!e.target.checked;
      try { await api.setAutoLaunch(v); } catch {}
      chrome.storage.local.set({ launchAtLogin: v });
      setDesktopMsg(t(v ? 'desktop.autoLaunchOn' : 'desktop.autoLaunchOff'));
    });
    silent.addEventListener('change', e => {
      const v = !!e.target.checked;
      chrome.storage.local.set({ silentRun: v });
      setDesktopMsg(t(v ? 'desktop.silentOn' : 'desktop.silentOff'));
    });
  }

  /* ------------------------------------------------------------------
   * v1.3.8 · 悬停提示：设置页不再放小字注释，全部改为轻量浮层
   *  · applyI18n 会把 [data-i18n-title] 的 title 按当前语言重设；
   *    这里用 MutationObserver 把新 title 同步到 data-tip，并移除原生
   *    黑色系统提示框，改由挂在 body 上的 fixed 浮层显示（不受滚动裁剪）。
   *  · 日历格子动态写 data-tip，同一个委托即可覆盖。
   * ---------------------------------------------------------------- */
  function initHoverTips() {
    if ($('hover-tip')) return;
    const tip = document.createElement('div');
    tip.id = 'hover-tip';
    tip.className = 'hover-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    const sync = el => {
      const v = el.getAttribute('title') || '';
      if (!v) return;
      el.dataset.tip = v;
      el.removeAttribute('title');
      if (!el.hasAttribute('data-i18n-aria')) {
        /* applyI18n 先更新可见文本、再更新 title，观察者回调里已是新语言 */
        const label = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (label) el.setAttribute('aria-label', label + ' — ' + v);
      }
    };
    document.querySelectorAll('[data-tip-role="hint"]').forEach(sync);
    const mo = new MutationObserver(list => {
      for (const x of list) {
        const el = x.target;
        if (el.nodeType === 1 && el.matches && el.matches('[data-tip-role="hint"]')) sync(el);
      }
    });
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['title'] });
    const place = host => {
      const r = host.getBoundingClientRect();
      const w = tip.offsetWidth, h = tip.offsetHeight;
      const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2),
                            Math.max(8, window.innerWidth - w - 8));
      let top = r.top - h - 8;
      if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
      tip.style.left = left + 'px';
      tip.style.top = Math.max(8, top) + 'px';
    };
    const closestTip = node => node && node.closest ? node.closest('[data-tip]') : null;
    document.addEventListener('mouseover', e => {
      const host = closestTip(e.target);
      if (!host || !host.dataset.tip) return;
      tip.textContent = host.dataset.tip;
      tip.hidden = false;
      place(host);
    });
    document.addEventListener('mouseout', e => {
      const host = closestTip(e.target);
      if (!host) return;
      if (e.relatedTarget && host.contains(e.relatedTarget)) return;
      tip.hidden = true;
    });
    window.addEventListener('scroll', () => { tip.hidden = true; }, true);
  }
  initHoverTips();

  /* ------------------------------------------------------------------ 启动 */
  async function loadUiLang() {
    const { uiLang } = await chrome.storage.local.get(['uiLang']);
    langMode = normalizeLangMode(uiLang);
    lang = resolveLang(langMode);
    applyI18n();
    syncSettingsUI();
    refresh();
  }

  async function loadAutoTasks() {
    const { autoTasks: saved } = await chrome.storage.local.get(['autoTasks']);
    autoTasks = normalizeAutoTasks(saved);
    syncAutoUI();
  }

  applyI18n();
  syncThemeControls();
  renderPointsCalendar();
  loadDesktopPrefs();
  chrome.storage.local.set({ uiTheme: savedThemeMode() === 'system' ? null : savedThemeMode() });
  loadUiLang();
  loadSettings();
  loadAutoTasks();
  /* v1.1.8 · 初始化零抓取：删掉旧版「数据过期就 send refreshToday /
     refreshTasks / refreshPoints」的整段逻辑。未登录时空闲就安静地显示
     storage 里已有的值，不请求任何官网页面。 */
  refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).every(key => key === 'taskClickIndex')) return;
    if (changes.uiLang) {
      langMode = normalizeLangMode(changes.uiLang.newValue);
      lang = resolveLang(langMode);
      applyI18n();
      setSegment('set-lang', langMode);
    }
    /* v1.1.5：登录刚完成时自动收起右侧官网面板。
       必须是「loginStatus 与 pointsSummary 同一批写回、且积分有效」——
       refreshPointsSummary 成功解析才会这样写；后台 fetchBothPages 偶尔
       单独把状态刷回 in（不带积分）时绝不收起用户正在看的官网页面。 */
    if (changes.loginStatus) {
      const newStatus = changes.loginStatus.newValue;
      const ps = changes.pointsSummary && changes.pointsSummary.newValue;
      /* v1.3.1：统一同步一次原子写回 loginStatus + pointsSummary。
         登录完成后即使之前已有缓存数据（徽标显示已登录），也照样收起侧栏。 */
      if (awaitingLogin && newStatus === 'in' &&
          ps && Number.isFinite(ps.available) && !ps.signedOut) {
        awaitingLogin = false;
        try { hideOfficialPanel().catch(() => {}); } catch {}
      }
    }
    if (changes.autoTasks) {
      // 桌面版 IPC 广播可能带回写盘前的旧快照；本地刚保存过就以本地为准，
      // 否则用户会看到「点了最大次数 / 添加时间却又跳回去」，观感即设置无效。
      if (Date.now() - autoSavedAt > 1500) {
        autoTasks = normalizeAutoTasks(changes.autoTasks.newValue);
        syncAutoUI();
      }
    }
    /* v1.3.3：后台统一同步完成后才写这个键，绿字一定出现在「刷新之后」 */
    if (changes.syncNotice && changes.syncNotice.newValue &&
        Number.isFinite(changes.syncNotice.newValue.at)) {
      showSyncedNotice();
    }
    if (changes.pointsHistory || changes.pointsSummary) renderPointsCalendar();
    refresh();
  });
  /* v1.1.8 · 重绘入口只剩 storage.onChanged（见上方 addListener）。
     onTick / onSync 专用刷新事件已删除，启动时的 6.2 秒自动刷新也删除：
     空闲时不会有任何定时器触发渲染。 */
  window.addEventListener('pagehide', () => {
    for (const id of oneShotTimers) clearTimeout(id);
    oneShotTimers.clear();
    stopCountdown();
  });
});
