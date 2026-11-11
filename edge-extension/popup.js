document.addEventListener('DOMContentLoaded', () => {
  const HSA_CORE = globalThis.HSA_CORE;
  let uiRunning = false;
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;
  const main = $('main');
  const btnAction = $('btn-action');
  const actionLabel = $('btn-action-label');
  const countInput = { value: '30', disabled: false, addEventListener() {} };
  const themeBtn = { setAttribute() {}, addEventListener() {}, title: '' };
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

  const ARC_LENGTH = 2 * Math.PI * 52;
  const POINTS_PER_SEARCH = 3;
  const KEYS = [
    'phase', 'running', 'currentSearch', 'totalSearch', 'startPoints', 'startKnown',
    'endPoints', 'finalEarned', 'earnedIsEstimate', 'todaySearch', 'error', 'warning', 'stopRequested',
    'diag', 'diagLimit', 'todayStart', 'liveCheck', 'stoppedEarly', 'currentQuery', 'todayActivities',
    'cooldownUntil', 'cooldownWaitMs', 'cooldownCycles', 'cooldownGaveUp', 'searchMaxedAtStart',
    'runAuto', 'runAutoTime', 'runLevel', 'todayTasks', 'pointsSummary',
    'loginStatus', 'loginCheckedAt', 'autoResult', 'activityDetail'
  ];
  const DEFAULTS = {
    defaultCount: 30,
    pace: 'normal',
    autoStop: true,
    reduceMotion: false,
    dontSkipCompletedCards: false,   
    cardClickIntervalSec: HSA_CORE.DEFAULTS.cardClickIntervalSec,
    runLogEnabled: true,
  };
  const AUTO_DEFAULTS = { enabled: false, times: [], count: 30, level: 3 };
  const AUTO_MAX_TIMES = 10;
  const MAX_COOLDOWNS = 6;

  const I18N = {
    zh: {
      'app.title': '拟人搜索助手',
       'login.in': '已登录', 'login.out': '未登录',
      
      
      'ring.tipTitle': '今日进度速览', 'ring.tipHint': '鼠标移入显示 · 点击主按钮开始执行',
      'a11y.login': '登录状态提示（不可点击）',
       
       
       'a11y.settings': '打开设置', 
      'a11y.progress': '今日任务进度', 'a11y.points': '积分概览', 'a11y.dismiss': '关闭',
      'a11y.back': '返回', 'a11y.customCount': '自定义搜索次数', 'a11y.autoTime': '启动时间',
      'theme.light': '浅色', 'theme.dark': '深色', 'theme.system': '跟随系统',
      'theme.toLight': '切换到浅色主题', 'theme.toDark': '切换到深色主题',
       'progress.tasks': '今日任务',  
       'progress.cooldownLeft': '冷却中 · {t} 后继续',
      'status.ready': '就绪', 'status.reading': '读取积分', 'status.checking': '检查今日进度',
      'status.searching': '搜索中', 'status.cooldown': 'Bing 冷却', 'status.finalizing': '收尾中',
      'status.completed': '已完成', 'status.limit': '已达上限', 'status.error': '出错',
      'status.allDone': '已完成，无需动作',
      'status.synced': '已同步积分',
      'status.cooldownRound': 'Bing 冷却（第 {n} / {max} 次等待）',
      'status.gaveUp': 'Bing 持续冷却，积分未恢复，已提前结束',
      'status.completingTasks': '正在完成任务',
      'status.syncing': '正在同步状态',
      'status.stopping': '正在停止', 'status.of': '第 {a} / {b} 次',
      'status.searchingTitle': '正在搜索：{q}',
      'points.start': '可用积分', 'points.current': '今日积分', 'points.earned': '可领取',
       
      
      'tip.startTitle': '可用积分', 'tip.available': 'Rewards 面板余额',
      'tip.currentTitle': '今日积分', 'tip.todayPoints': '今日已获积分',
      'tip.earnedTitle': '可领取', 
      'tip.loading': '读取中…', 'tip.signedOut': '请先登录',
      'notice.copy': '复制详情', 'notice.copied': '已复制 ✓', 'notice.copyFailed': '复制失败',
      
      
      
      
      
      
      
      
      
       'controls.start': '自动完成任务', 'controls.stop': '停止',
      'controls.starting': '正在启动…', 'controls.stopping': '正在停止…', 'controls.finishing': '正在收尾…',
       
      
         
        
        
      'tasks.remove': '删除该时间点', 
      
      'tasks.added': '已添加 {time}', 'tasks.autoAdded': '已自动添加 {time}',
      'tasks.removed': '已删除 {time}',
      'tasks.duplicate': '该时间点已存在。', 'tasks.limit': '最多只能添加 10 个时间点。',
      'tasks.invalid': '请选择有效的时间（HH:MM）。',
      'tasks.disabledTip': '总开关已关闭，打开「设置 → 自动完成任务 → 定时自动运行」后才会定时执行。',
      'settings.title': '设置', 'settings.appearance': '外观', 'settings.language': '语言 / Language',
      'lang.system': '跟随系统', 'points.earnedOpen': '打开 Rewards 领取积分',
      'tip.claimOpen': '点击前往 Rewards 领取积分',
      'settings.theme': '主题', 'settings.reduce': '减少动画', 'settings.reduceHint': '关闭动效',
        'settings.other': '其他',
       
       
       
      
      'settings.seconds': '秒', 'auto.cardInterval': '卡片点击间隔',
      'auto.cardIntervalHint': '相邻两张任务卡片的点击至少间隔设定秒数（1–60 秒）',
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
      'auto.dontSkipCompleted': '不跳过已完成任务卡',
      'auto.dontSkipCompletedHint': '默认关闭：只点击主界面显示未完成的任务卡。开启后即使积分和任务都已全完成，也会逐张点击所有任务卡',
      
      'auto.title': '自动完成任务', 'auto.enable': '定时自动运行',
      'auto.enableHint': '到点自动点击未完成任务卡片，并按剩余分数搜索，最多 10 个时间点',
      'auto.count': '搜索次数上限', 'auto.countHint': '按今日 Bing 搜索剩余分数自动决定，不超过此值', 'auto.times': '启动时间',
      'auto.timesHint': '留空直接点「添加」：首个默认 08:00，之后比最晚时间顺延 30 分钟，自动去重排序', 'auto.addTime': '添加',
      'auto.level': '拟人强度', 'auto.levelHint': '影响鼠标轨迹、滚动与每轮时长',
      'level.low': '低', 'level.mid': '中', 'level.high': '高',
      'settings.reset': '恢复默认设置', 'settings.resetConfirm': '再点一次确认重置',
      'calendar.navBlocked': '该周期没有积分记录，不能跳转',
      'pull.idle': '下拉刷新', 'pull.pull': '下拉刷新',
      'pull.armed': '释放刷新', 'pull.refreshing': '加载中...',
      'pull.done': '刷新成功', 'pull.error': '刷新失败',
      'pull.blocked': '自动运行中：刷新已禁用',
      'diag.title': '运行日志与网页抓取',
      'diag.logEnabled': '记录运行日志',
      'diag.logHint': '日志含系统时间、用户操作、运行过程、结果与错误；网页 HTML 不写进日志',
      'diag.note': '日常运行只有运行日志；关键网页按需实时抓取 /dashboard、/earn 与 Bing 侧边栏，导出 HTML 的 zip 包，不复用缓存或旧快照。',
      'diag.exportLog': '导出运行日志', 'diag.capturePages': '抓取关键网页（HTML zip）',
      'diag.exporting': '正在准备运行日志…', 'diag.capturing': '正在实时抓取 /dashboard、/earn 与 Bing 侧边栏…',
      'diag.exportOk': '已导出运行日志（{count} 条）',
      'diag.captureOk': '已实时抓取并导出 {count} 个关键网页（HTML zip 包）',
      'diag.empty': '暂无运行日志', 'diag.fail': '操作失败：{msg}',
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
       
      
      'todayTasks.onlyPoints': '仅显示带积分的任务',
      'todayTasks.sectionSearch': '搜索', 'todayTasks.sectionDaily': '每日活动',
      'todayTasks.sectionPromo': '日常任务', 'todayTasks.sectionOther': '其他任务',
      'todayTasks.groupTotal': '{a} / {b} 分',
      'todayTasks.done': '已完成', 'todayTasks.pending': '待完成',
       
    },
    en: {
      'app.title': 'Human Search Assistant',
       'login.in': 'Signed in', 'login.out': 'Not signed in',
      
      
      'ring.tipTitle': "Today at a glance", 'ring.tipHint': 'Hover to show · press the main button to start',
      'a11y.login': 'Sign-in status indicator (not clickable)',
      
      
       
       'a11y.settings': 'Open settings', 
      'a11y.progress': 'Today\'s tasks progress', 'a11y.points': 'Points summary', 'a11y.dismiss': 'Dismiss',
      'a11y.back': 'Back', 'a11y.customCount': 'Custom number of searches', 'a11y.autoTime': 'Start time',
      'theme.light': 'Light', 'theme.dark': 'Dark', 'theme.system': 'System',
      'theme.toLight': 'Switch to light theme', 'theme.toDark': 'Switch to dark theme',
       'progress.tasks': 'Today\'s tasks',  
       'progress.cooldownLeft': 'Cooldown · resume in {t}',
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
       
      
      'tip.startTitle': 'Available', 'tip.available': 'Rewards balance',
      'tip.currentTitle': "Today's points", 'tip.todayPoints': 'Points earned today',
      'tip.earnedTitle': 'Claimable', 
      'tip.loading': 'Loading…', 'tip.signedOut': 'Sign in first',
      'notice.copy': 'Copy details', 'notice.copied': 'Copied ✓', 'notice.copyFailed': 'Copy failed',
      
      
      
      
      
      
      
      
      
       'controls.start': 'Auto-complete Tasks', 'controls.stop': 'Stop',
      'controls.starting': 'Starting…', 'controls.stopping': 'Stopping…', 'controls.finishing': 'Finishing…',
       
      
         
        
        
      'tasks.remove': 'Remove this time', 
      
      'tasks.added': 'Added {time}', 'tasks.autoAdded': 'Added {time} automatically',
      'tasks.removed': 'Removed {time}',
      'tasks.duplicate': 'That time is already in the list.', 'tasks.limit': 'You can add up to 10 times.',
      'tasks.invalid': 'Pick a valid time (HH:MM).',
      'tasks.disabledTip': 'Scheduling is off. Turn on Settings → Auto-complete tasks → Scheduled runs.',
      'settings.title': 'Settings', 'settings.appearance': 'Appearance', 'settings.language': '语言 / Language',
      'lang.system': 'System', 'points.earnedOpen': 'Open Rewards to claim points',
      'tip.claimOpen': 'Click to open Rewards and claim',
      'settings.theme': 'Theme', 'settings.reduce': 'Reduce animations', 'settings.reduceHint': 'Turn off motion effects',
        'settings.other': 'Other',
       
       
       
      
      'settings.seconds': 'sec', 'auto.cardInterval': 'Card click interval',
      'auto.cardIntervalHint': 'Minimum time between clicks on task cards (1–60 seconds)',
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
      'auto.dontSkipCompleted': "Don't skip completed cards",
      'auto.dontSkipCompletedHint': 'Off by default: only click cards the main UI shows as pending. When on, click every task card even if points and tasks are already complete',
      
      'auto.title': 'Auto-complete tasks', 'auto.enable': 'Scheduled runs',
      'auto.enableHint': 'Click unfinished cards, then search as needed, up to 10 start times',
      'auto.count': 'Search cap', 'auto.countHint': 'Decided from remaining Bing search points, capped here', 'auto.times': 'Start times',
      'auto.timesHint': 'Leave empty and tap Add: first defaults to 08:00, then +30 min from the latest time; auto-sorted and deduped', 'auto.addTime': 'Add',
      'auto.level': 'Human-like intensity', 'auto.levelHint': 'Affects mouse path, scrolling and round length',
      'level.low': 'Low', 'level.mid': 'Medium', 'level.high': 'High',
      'settings.reset': 'Reset to defaults', 'settings.resetConfirm': 'Tap again to reset',
      'calendar.navBlocked': 'No points recorded in that period — navigation blocked',
      'pull.idle': 'Pull down to refresh', 'pull.pull': 'Pull down to refresh',
      'pull.armed': 'Release to refresh', 'pull.refreshing': 'Loading…',
      'pull.done': 'Refreshed', 'pull.error': 'Refresh failed',
      'pull.blocked': 'Strict run active — refresh disabled',
      'diag.title': 'Run log & page capture',
      'diag.logEnabled': 'Record run log',
      'diag.logHint': 'System time, user actions, run steps, results and errors; page HTML is never stored',
      'diag.note': 'Daily runs keep a run log only. Capture /dashboard, /earn and the Bing sidebar live on demand and export them as an HTML zip — never a cached page or an old snapshot.',
      'diag.exportLog': 'Export run log', 'diag.capturePages': 'Capture key pages (HTML zip)',
      'diag.exporting': 'Preparing run log…', 'diag.capturing': 'Fetching /dashboard, /earn and Bing sidebar live…',
      'diag.exportOk': 'Run log exported ({count} entries)',
      'diag.captureOk': 'Captured and exported {count} key pages as an HTML zip',
      'diag.empty': 'No run log entries yet', 'diag.fail': 'Operation failed: {msg}',
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
       
      
      'todayTasks.onlyPoints': 'Only tasks with points are listed',
      'todayTasks.sectionSearch': 'Search', 'todayTasks.sectionDaily': 'Daily activities',
      'todayTasks.sectionPromo': 'Daily tasks', 'todayTasks.sectionOther': 'Other',
      'todayTasks.groupTotal': '{a} / {b} pts',
      'todayTasks.done': 'Done', 'todayTasks.pending': 'Pending',
       
    }
  };

  const normalizeLangMode = v => (v === 'zh' || v === 'en' ? v : 'system');
  const systemLang = () => {
    let nav = '';
    try {
      if (chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
        nav = chrome.i18n.getUILanguage();
      }
    } catch (err) {}
    nav = nav || (navigator.languages && navigator.languages[0]) || navigator.language || '';
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

  function applyI18n() {
    root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    document.title = t('app.title');
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
    for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
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

  /* 详细运行日志：所有用户操作都记一条（严格运行期白名单放行，只读不改运行）。 */
  function logUserAction(action, detail) {
    try {
      chrome.runtime.sendMessage({
        type: 'logUserAction', actor: 'user', action: String(action || ''),
        detail: String(detail || '')
      }).catch(() => {});
    } catch (err) {}
  }
  function summarize(extra) {
    if (!extra || typeof extra !== 'object') return '';
    try {
      return Object.keys(extra).slice(0, 8).map(k => {
        const v = extra[k];
        return k + '=' + (v == null || typeof v !== 'object' ? String(v) : '[object]');
      }).join(', ').slice(0, 200);
    } catch (err) { return ''; }
  }
  function send(type, extra) {
    if (type !== 'logUserAction' && type !== 'panelState') {
      logUserAction(type, summarize(extra));
    }
    return chrome.runtime.sendMessage(Object.assign({ type }, extra)).catch(err => {
      showError(t('error.extension', { msg: err.message }));
    });
  }

  $('error-dismiss').addEventListener('click', () => {
    errorBanner.hidden = true;
    chrome.storage.local.set({ error: null });
  });

  const CLAIM_URL = 'https://rewards.bing.com/dashboard';
  const claimCard = $('claim-card');
  const panelMessage = (type, url) => new Promise(resolve => {
    try {
      const p = chrome.runtime.sendMessage(Object.assign({ type: type }, url ? { url: url } : {}));
      if (p && typeof p.then === 'function') {
        p.then(r => resolve(r || null)).catch(() => resolve(null));
        return;
      }
    } catch (err) {}
    try {
      if (type === 'openOfficial' && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: url || CLAIM_URL, active: true })
          .then(t => resolve({ ok: true, open: true, tabId: t && t.id }))
          .catch(() => resolve(null));
        return;
      }
    } catch (err) {}
    resolve(null);
  });
  const openOfficialPanel = url => panelMessage('openOfficial', url || CLAIM_URL);
  const openClaimPage = () => {
    openOfficialPanel(CLAIM_URL).catch(() => {});
  };
  claimCard.addEventListener('click', openClaimPage);
  claimCard.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClaimPage(); }
  });


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
  window.addEventListener('languagechange', () => {
    if (langMode !== 'system') return;
    lang = systemLang();
    applyI18n();
    refresh();
  });

  /* 严格运行模式：自动运行期间禁止改设置、改定时配置、手动刷新等影响运行的操作。 */
  function strictRunGuard(type) {
    if (!uiRunning || !HSA_CORE.strictBlockedMessage(type || 'saveSettings', true)) return false;
    const msg = lang === 'en' ? HSA_CORE.TEXT.strictRunBlockedEn : HSA_CORE.TEXT.strictRunBlocked;
    setStatus(msg, 'completed all-done', false);
    try { statusEl.setAttribute('aria-label', msg); } catch (err) {}
    return true;
  }

  function saveSettings(patch) {
    if (strictRunGuard('saveSettings')) return;
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
  let allDoneNoticeUntil = 0;
  let lastRunningSeen = false;   
  let syncedNoticeUntil = 0;
  let lastAutoResultAt = 0;
  const uiBootAt = Date.now();
  let uiStartAt = 0;
  const oneShotTimers = new Set();
  function oneShotRefresh(ms) {
    const id = setTimeout(() => { oneShotTimers.delete(id); refresh(); }, Math.max(0, ms));
    oneShotTimers.add(id);
    return id;
  }
  let cooldownRefreshAt = 0;
  let startWatchdogTimer = null;

  function setAction(mode, label, disabled) {
    btnAction.classList.toggle('is-stop', mode === 'stop');
    btnAction.dataset.mode = mode;
    if (actionLabel.textContent !== label) {
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
      oneShotRefresh(3100);              
      setAction('stop', t('controls.starting'), true);
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
      if (res && res.reason === 'signedOut') {
        clearTimeout(startWatchdogTimer);
        pendingStartUntil = 0;
        setAction('start', t('controls.start'), false);
        showError(t('error.signIn'));
      } else if (res && (res.reason === 'allDone' || res.skipped === true)) {
        clearTimeout(startWatchdogTimer);
        showAllDoneNotice();
      } else if (!res) {
        clearTimeout(startWatchdogTimer);
        pendingStartUntil = 0;
        setAction('start', t('controls.start'), false);
      } else {
      }
    } else {
      setAction('stop', t('controls.stopping'), true);
      send('stop');
    }
  });

  function showAllDoneNotice() {
    pendingStartUntil = 0;
    allDoneNoticeUntil = Date.now() + 8000;
    oneShotRefresh(8100);               
    const allDoneText = (typeof lang !== 'undefined' && lang === 'en')
      ? HSA_CORE.TEXT.allDoneEn : HSA_CORE.TEXT.allDone;
    setStatus(allDoneText, 'completed all-done', false);
    setAction('start', t('controls.start'), false);
    statusEl.setAttribute('aria-label', allDoneText);
  }

  function showSyncedNotice() {
    syncedNoticeUntil = Date.now() + 8000;
    oneShotRefresh(8100);
    setStatus(t('status.synced'), 'completed all-done', false);
    statusEl.setAttribute('aria-label', t('status.synced'));
  }

  /* S01=B：状态行显示运行详情与动态倒计时；全文可悬停查看，不新增日志框。 */
  let hsaCountdownTimer = null;
  function hsaStopCountdown() {
    if (hsaCountdownTimer) { clearTimeout(hsaCountdownTimer); hsaCountdownTimer = null; }
  }
  function hsaScheduleCountdown(until, template, cls) {
    hsaStopCountdown();
    const step = () => {
      hsaCountdownTimer = null;
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      const text = template.split('{s}').join(String(left));
      if (statusText.textContent !== text) {
        statusText.textContent = text;
        statusEl.dataset.key = cls + '||' + text + '|' + lang;
      }
      if (until <= Date.now()) return;
      hsaCountdownTimer = setTimeout(step,
        Math.min(1000, Math.max(120, (until - Date.now()) - (left - 1) * 1000)));
    };
    step();
  }
  function hsaActivityLine(d, phaseCls) {
    const a = d && d.activityDetail;
    if (!a || !a.at) return null;
    if (!d.running && Date.now() - Number(a.at) > 12000) return null;
    const line = HSA_CORE.formatActivityLine(Object.assign({}, a, { active: !!d.running }),
      lang, Date.now());
    if (!line) return null;
    const cls = line.green ? 'completed all-done'
      : (a.state === 'syncFailed' ? 'error' : phaseCls);
    return { text: line.text, cls: cls + ' activity', until: line.until,
             template: line.template };
  }

  /* T05=D：未确认的任务卡只给「可手动打开的链接」，不自动代开、不计成功。 */
  function renderManualLinks(links) {
    const box = $('today-tasks-msg');
    if (!box) return;
    const list = (Array.isArray(links) ? links : [])
      .filter(x => x && /^https?:\/\//i.test(String(x.url || ''))).slice(0, 8);
    if (!list.length) { box.hidden = true; box.textContent = ''; return; }
    box.textContent = '';
    const label = document.createElement('span');
    label.textContent = HSA_CORE.manualLinkNotice(list.length, lang);
    box.appendChild(label);
    for (const item of list) {
      const a = document.createElement('a');
      a.href = String(item.url);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = String(item.title || item.url).slice(0, 40);
      a.style.marginRight = '8px';
      box.appendChild(a);
    }
    box.hidden = false;
  }

  function setStatus(text, cls, isQuery, title) {
    const key = `${cls}|${isQuery ? 'q' : ''}|${text}|${lang}`;
    if (statusEl.dataset.key === key) return;
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

  function setNotice() {  }

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

  function renderLoginBadge(d) {
    const ps = d.pointsSummary || {};
    const signedIn = Number.isFinite(ps.available);
    loginBadge.className = 'login-badge ' + (signedIn ? 'in' : 'signed-out');
    try { loginBadgeText.hidden = false; } catch {}
    try { loginBadgeText.textContent = t(signedIn ? 'login.in' : 'login.out'); } catch {}
    try { if (loginBadgeIcon) loginBadgeIcon.hidden = false; } catch {}
    loginBadge.removeAttribute('title');
    loginBadge.setAttribute('aria-label', t(signedIn ? 'login.in' : 'login.out'));
  }

  function render(d) {
    renderLoginBadge(d);
    const statusMap = STATUS();
    const phase = statusMap[d.phase] ? d.phase : 'idle';
    const running = !!d.running;
    uiRunning = running;
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
    if (running && !lastRunningSeen) { allDoneNoticeUntil = 0; syncedNoticeUntil = 0; }
    lastRunningSeen = running;
    const noticeActive = !running && Date.now() < allDoneNoticeUntil;
    const syncedActive = !running && Date.now() < syncedNoticeUntil;
    /* S01=B：运行时优先显示当前步骤 / 倒计时详情。 */
    const act = hsaActivityLine(d, cls);
    if (act) {
      setStatus(act.text, act.cls, false, act.text);
      statusEl.setAttribute('aria-label', act.text);
      if (act.until) hsaScheduleCountdown(act.until, act.template, act.cls);
      else hsaStopCountdown();
    } else {
      hsaStopCountdown();
      if (noticeActive) {
        setStatus(t('status.allDone'), 'completed all-done', false);
      } else if (syncedActive) {
        setStatus(t('status.synced'), 'completed all-done', false);
      } else if (d.cooldownGaveUp && !running) {
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

    const tt = d.todayTasks || {};
    const hasTasks = Array.isArray(tt.items) && tt.items.length > 0;
    const taskPct = hasTasks ? Math.max(0, Math.min(100, Number(tt.percent) || 0)) : 0;
    ring.classList.remove('spinning');
    setOdometer(progressText, hasTasks ? `${taskPct}%` : '—');
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
    /* D05=D：确认登出后保留历史值并标注「上次记录」。 */
    const panelNote = ps.signedOut ? t('tip.signedOut')
      : ps.displayLabel
        ? String(lang === 'en' ? (ps.displayLabelEn || HSA_CORE.TEXT.historyLabelEn) : ps.displayLabel)
        : (ps.updatedAt ? '' : t('tip.loading'));
    setTip('tip-start', t('tip.startTitle'), [], panelNote || t('tip.available'));
    setTip('tip-current', t('tip.currentTitle'), [], panelNote || t('tip.todayPoints'));
    setTip('tip-earned', t('tip.earnedTitle'), [], panelNote || t('tip.claimOpen'));

    setNotice(null);
    daily.hidden = true;
    renderTodayTasks(d.todayTasks);
    diagText = JSON.stringify({ start: d.diag || null, limit: d.diagLimit || null }, null, 2);
    noticeCopy.hidden = true;

    if (d.error) showError(d.error);

    if (d.autoResult && d.autoResult.at && d.autoResult.at !== lastAutoResultAt) {
      lastAutoResultAt = d.autoResult.at;
      const r = d.autoResult;
      renderManualLinks(r.manualLinks);
      if (!running) {
        clearTimeout(startWatchdogTimer);
        pendingStartUntil = 0;
        if (r.reason === 'allDone' || r.skipped === true) showAllDoneNotice();
        else setAction('start', t('controls.start'), false);
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
  let uiDirty = false;
  function refresh() {
    if (pending) return;
    pending = true;
    Promise.resolve().then(async () => {
      pending = false;
      try {
        render(await chrome.storage.local.get(KEYS));
      } catch (err) {
        console.warn('Render failed:', err.message);
      }
    });
  }

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
    if (strictRunGuard('saveAutoTasks')) return;
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
    const btn = $('today-tasks-refresh');
    if (btn.disabled) return;
    if (strictRunGuard('refreshTasks')) return;
    btn.disabled = true;
    try {
      await send('refreshTasks');
    } catch (err) {
      console.warn('Refresh failed:', err && err.message || err);
    } finally {
      btn.disabled = false;
    }
  });

  const panel = $('settings');
  const openBtn = $('settings-open');

  function openSettings() {
    syncSettingsUI();
    resetCalendar();
    logUserAction('openSettings', 'settings panel opened');
    body.classList.add('settings-open');
    panel.inert = false;
    main.inert = true;
    panel.classList.add('open');
    setTimeout(() => $('settings-back').focus(), 60);
  }

  function closeSettings() {
    logUserAction('closeSettings', 'settings panel closed');
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
    $('set-run-log').checked = settings.runLogEnabled !== false;
    $('set-dont-skip-completed').checked = !!settings.dontSkipCompletedCards;
    const ci = $('set-card-interval');
    if (ci) ci.value = Number.isFinite(Number(settings.cardClickIntervalSec))
      ? HSA_CORE.clampIntervalSec(settings.cardClickIntervalSec)
      : HSA_CORE.DEFAULTS.cardClickIntervalSec;
    syncAutoUI();
    renderPointsCalendar();
  }

  onSegment('set-lang', v => setLang(v));
  onSegment('set-theme', mode => applyTheme(mode));
  $('set-reduce').addEventListener('change', e => {
    setReduceMotion(e.target.checked);
    saveSettings({ reduceMotion: e.target.checked });
  });
  $('set-run-log').addEventListener('change', e => {
    if (strictRunGuard('saveSettings')) {
      e.target.checked = settings.runLogEnabled !== false;
      return;
    }
    saveSettings({ runLogEnabled: e.target.checked });
  });
  $('set-dont-skip-completed').addEventListener('change', e =>
    saveSettings({ dontSkipCompletedCards: e.target.checked }));
  const cardIntervalInput = $('set-card-interval');
  if (cardIntervalInput) cardIntervalInput.addEventListener('change', e => {
    const n = Number(e.target.value);
    const sec = HSA_CORE.clampIntervalSec(n);
    e.target.value = sec;
    saveSettings({ cardClickIntervalSec: sec });
  });

  /* 诊断数据：导出运行日志 / 实时抓取关键网页（设置页操作）。
     桌面优先走系统保存对话框，插件走 Blob 下载；都不经过运行链路。 */
  function setDiagStatus(text, warn) {
    const el = $('diag-status');
    if (!el) return;
    el.textContent = String(text || '');
    el.classList.toggle('warn', !!warn);
    el.hidden = false;
  }
  function exportDiagFile(fileName, content, encoding) {
    /* 后台 captureKeyPages 返回 base64 编码的 zip；导出日志是纯文本 JSON。 */
    const isBin = String(encoding || '') === 'base64';
    const d = typeof window !== 'undefined' && window.__desktop;
    if (d && typeof d.saveExport === 'function') {
      return d.saveExport(fileName, content, isBin ? 'base64' : '').then(r => {
        if (!r || !r.ok) throw new Error((r && (r.message || r.reason)) || 'save failed');
        return r;
      });
    }
    let blob;
    if (isBin) {
      /* 关键网页导出：base64 → 二进制 → HTML zip 包，绝不当成文本写坏。 */
      const raw = String(content || '');
      const bytes = (globalThis.HSA_ZIP && typeof HSA_ZIP.fromBase64 === 'function')
        ? HSA_ZIP.fromBase64(raw)
        : Uint8Array.from(atob(raw), c => c.charCodeAt(0));
      blob = new Blob([bytes], { type: 'application/zip' });
    } else {
      blob = new Blob([String(content || '')], { type: 'application/json;charset=utf-8' });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = String(fileName || (isBin ? 'hsa-export.zip' : 'hsa-export.json'));
    a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (err) {} }, 2000);
    return Promise.resolve({ ok: true });
  }
  async function runDiagAction(type, button, busyText) {
    if (button.disabled) return;
    if (type === 'captureKeyPages' && strictRunGuard('captureKeyPages')) return;
    button.disabled = true;
    setDiagStatus(busyText);
    try {
      const r = await send(type);
      if (!r || !r.ok) throw new Error((r && (r.message || r.reason)) || 'no response');
      if (type === 'exportRunLog' && !r.count) {
        setDiagStatus(t('diag.empty'), true);
        return;
      }
      logUserAction(type, (r.fileName || '') + ' · ' + (r.count || 0) + ' 项');
      const isBin = r.encoding === 'base64' || r.binary === true;
      const payload = isBin ? (r.base64 || r.content) : r.content;
      await exportDiagFile(r.fileName, payload, isBin ? 'base64' : '');
      setDiagStatus(t(type === 'exportRunLog' ? 'diag.exportOk' : 'diag.captureOk',
        { count: r.count || 0 }));
    } catch (err) {
      setDiagStatus(t('diag.fail', { msg: (err && err.message) || String(err) }), true);
    } finally {
      button.disabled = false;
    }
  }
  $('btn-export-runlog').addEventListener('click', () =>
    runDiagAction('exportRunLog', $('btn-export-runlog'), t('diag.exporting')));
  $('btn-capture-keypages').addEventListener('click', () =>
    runDiagAction('captureKeyPages', $('btn-capture-keypages'), t('diag.capturing')));

  $('set-auto').addEventListener('change', e => saveAutoTasks({ enabled: e.target.checked }));
  onSegment('set-auto-count-chips', v => saveAutoTasks({ count: v }));
  $('set-auto-count').addEventListener('change', e => {
    if (e.target.value !== '') saveAutoTasks({ count: e.target.value });
  });
  onSegment('set-auto-level', v => saveAutoTasks({ level: Number(v) }));

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


  let calMode = 'day';
  let calCursor = new Date();
  let lastCalHist = {};
  let calNavTimer = null;
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
    lastCalHist = Object.assign({}, hist);
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
    /* 与 moveCalendar 同口径：目标周期完全没有积分记录 → 禁止跳转。 */
    const hasPointsIn = step =>
      HSA_CORE.calendarNavAllowed(hist, calMode, y, m, step, todayK);
    for (const [id, step] of [['cal-prev', -1], ['cal-next', 1]]) {
      const btn = $(id);
      if (!btn) continue;
      const empty = !hasPointsIn(step);
      btn.disabled = empty;
      btn.classList.toggle('cal-nav-empty', empty);
      btn.setAttribute('data-empty', String(empty));
      btn.setAttribute('aria-description', empty ? t('calendar.navEmpty') : '');
    }
  }

  /* 每次打开设置：积分日历自动复位到当天 / 日视图（两版一致）。 */
  function resetCalendar() {
    const r = HSA_CORE.calendarReset();
    calCursor = r.cursor;
    calMode = r.mode;
    renderPointsCalendar();
  }
  function calNavNotice() {
    const el = $('cal-nav-msg');
    if (!el) return;
    el.textContent = t('calendar.navBlocked');
    el.hidden = false;
    clearTimeout(calNavTimer);
    calNavTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
  function moveCalendar(step) {
    const y = calCursor.getFullYear(), m = calCursor.getMonth();
    /* 禁止跳转到完全没有积分记录的日期 / 周期（共享纯逻辑，两端口径一致）。 */
    if (!HSA_CORE.calendarNavAllowed(lastCalHist, calMode, y, m, step, dkey(new Date()))) {
      calNavNotice();
      logUserAction('calendar-nav-blocked', calMode + ' step=' + step);
      return;
    }
    calCursor = calMode === 'month'
      ? new Date(y + step, m, 1)
      : new Date(y, m + step, 1);
    renderPointsCalendar();
  }
  /* 与插件版完全一致的共享悬浮提示：挂在 <html> 末尾、z-index 最高，始终在最上层。 */
  if (globalThis.HSA_HOVER_TIP) globalThis.HSA_HOVER_TIP.install(document);

  /* v2.5 · 下拉刷新页面：两端共用共享手势模块（触摸 / 鼠标拖拽 / 顶部滚轮）。
     运行期由严格模式守卫拦截；设置面板打开时不接管手势；刷新复用 refreshTasks。 */
  if (globalThis.HSA_PULL_REFRESH) {
    globalThis.HSA_PULL_REFRESH.install({
      scroller: () => $('scroll-root') || document.scrollingElement,
      wrap: () => $('main') || $('scroll-root') || document.scrollingElement,
      indicator: $('pull-refresh'),
      enabled: () => !body.classList.contains('settings-open'),
      blocked: () => strictRunGuard('refreshTasks'),
      labels: () => ({
        idle: t('pull.idle'), pull: t('pull.pull'), armed: t('pull.armed'),
        refreshing: t('pull.refreshing'), done: t('pull.done'),
        error: t('pull.error'), blocked: t('pull.blocked')
      }),
      onRefresh: async () => {
        await send('refreshTasks');
        refresh();
        logUserAction('pull-refresh', '下拉刷新页面（手势触发）');
      },
      onLog: (phase, detail) => {
        if (phase === 'trigger') logUserAction('pull-refresh-trigger', detail);
      }
    });
  }

  onSegment('cal-mode', v => { calMode = v; renderPointsCalendar(); });
  if ($('cal-prev')) $('cal-prev').addEventListener('click', () => moveCalendar(-1));
  if ($('cal-next')) $('cal-next').addEventListener('click', () => moveCalendar(1));

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
  chrome.storage.local.set({ uiTheme: savedThemeMode() === 'system' ? null : savedThemeMode() });
  loadUiLang();
  loadSettings();
  loadAutoTasks();
  /* ======================================================================
   * v3.0 · 打开主界面时同步一次（正在运行时例外）
   * 插件版每次打开 popup 都是新文档，DOMContentLoaded 即触发；
   * 桌面版 popup 常驻隐藏到托盘，额外由主进程 ui:opened 广播触发。
   * 判定与节流全部走共享核心 syncOnOpenAllowed，两端行为严格一致。
   * ==================================================================== */
  async function requestSyncOnOpen() {
    try {
      const s = await chrome.storage.local.get(['running', HSA_CORE.SYNC_ON_OPEN.storageKey]);
      const now = Date.now();
      const running = !!(s && s.running);
      const lastAt = s && s[HSA_CORE.SYNC_ON_OPEN.storageKey];
      if (!HSA_CORE.syncOnOpenAllowed(running, lastAt, now)) return;
      await chrome.storage.local.set({ [HSA_CORE.SYNC_ON_OPEN.storageKey]: now });
      send(HSA_CORE.SYNC_ON_OPEN.messageType, { at: now, source: HSA_CORE.SYNC_ON_OPEN.reason });
    } catch (err) {}
  }
  refresh();
  requestSyncOnOpen();
  const scheduleRefresh = () => {
    if (document.hidden) { uiDirty = true; return; }
    uiDirty = false;
    refresh();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !uiDirty) return;
    uiDirty = false;
    loadUiLang();
    loadSettings();
    loadAutoTasks();
    renderPointsCalendar();
    refresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (document.hidden) { uiDirty = true; return; }
    if (changes.uiLang) {
      langMode = normalizeLangMode(changes.uiLang.newValue);
      lang = resolveLang(langMode);
      applyI18n();
      setSegment('set-lang', langMode);
    }
    if (changes.autoTasks) {
      if (Date.now() - autoSavedAt > 1500) {
        autoTasks = normalizeAutoTasks(changes.autoTasks.newValue);
        syncAutoUI();
      }
    }
    if (changes.syncNotice && changes.syncNotice.newValue &&
        Number.isFinite(changes.syncNotice.newValue.at)) {
      showSyncedNotice();
    }
    if (changes.pointsHistory || changes.pointsSummary) renderPointsCalendar();
    scheduleRefresh();
  });
  window.addEventListener('pagehide', () => {
    uiDirty = false;
    pending = false;
    for (const id of oneShotTimers) clearTimeout(id);
    oneShotTimers.clear();
  });
});
