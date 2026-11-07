document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;
  const main = $('main');
  const btnAction = $('btn-action');
  const actionLabel = $('btn-action-label');
  // 首页「搜索次数」输入已移除；次数由今日 Bing 搜索剩余分数自动决定
  const countInput = { value: '30', disabled: false, addEventListener() {} };
  const themeBtn = $('theme-toggle');
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

  const ARC_LENGTH = 2 * Math.PI * 52;
  const POINTS_PER_SEARCH = 3;
  const TODAY_REFRESH_MS = 5 * 60 * 1000;
  const KEYS = [
    'phase', 'running', 'currentSearch', 'totalSearch', 'startPoints', 'startKnown',
    'endPoints', 'finalEarned', 'earnedIsEstimate', 'todaySearch', 'error', 'warning', 'stopRequested',
    'diag', 'diagLimit', 'todayStart', 'liveCheck', 'stoppedEarly', 'currentQuery', 'todayActivities',
    'cooldownUntil', 'cooldownWaitMs', 'cooldownCycles', 'cooldownGaveUp', 'searchMaxedAtStart',
    'runAuto', 'runAutoTime', 'runLevel', 'todayTasks', 'pointsSummary'
  ];
  const DEFAULTS = {
    defaultCount: 30,
    pace: 'normal',
    autoStop: true,
    reduceMotion: false,
    cooldownAware: true,
    cooldownMinutes: 15
  };
  const AUTO_DEFAULTS = { enabled: false, times: [], count: 30, level: 3 };
  const AUTO_MAX_TIMES = 10;
  const MAX_COOLDOWNS = 6;

  /* --------------------------------------------------------------- 双语字典 */
  const I18N = {
    zh: {
      'app.title': '拟人搜索助手',
      'a11y.language': '切换语言', 'a11y.settings': '打开设置', 'a11y.theme': '切换主题',
      'a11y.progress': '今日任务进度', 'a11y.points': '积分概览', 'a11y.dismiss': '关闭',
      'a11y.back': '返回', 'a11y.customCount': '自定义搜索次数', 'a11y.autoTime': '启动时间',
      'theme.light': '浅色', 'theme.dark': '深色', 'theme.system': '跟随系统',
      'theme.toLight': '切换到浅色主题', 'theme.toDark': '切换到深色主题',
      'progress.searches': '次搜索', 'progress.tasks': '今日任务', 'progress.ptsToday': '今日积分', 'progress.cooldown': '冷却中',
      'progress.pleaseWait': '请稍候',
      'status.ready': '就绪', 'status.reading': '读取积分', 'status.checking': '检查今日进度',
      'status.searching': '搜索中', 'status.cooldown': 'Bing 冷却', 'status.finalizing': '收尾中',
      'status.completed': '已完成', 'status.limit': '已达上限', 'status.error': '出错',
      'status.allDone': '任务已完成，无需任何动作',
      'status.completingTasks': '正在完成任务',
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
      'tasks.added': '已添加 {time}', 'tasks.removed': '已删除 {time}',
      'tasks.duplicate': '该时间点已存在。', 'tasks.limit': '最多只能添加 10 个时间点。',
      'tasks.invalid': '请选择有效的时间（HH:MM）。',
      'tasks.disabledTip': '总开关已关闭，打开「设置 → 自动完成任务 → 定时自动运行」后才会定时执行。',
      'settings.title': '设置', 'settings.appearance': '外观', 'settings.language': '语言 / Language',
      'settings.theme': '主题', 'settings.reduce': '减少动画', 'settings.reduceHint': '关闭动效',
      'settings.searches': '搜索', 'settings.defaultCount': '默认搜索次数', 'settings.other': '其他',
      'settings.pace': '节奏', 'settings.paceHint': '每次结果停留时长',
      'pace.normal': '标准', 'pace.relaxed': '舒缓',
      'settings.autostop': '到达每日上限即停止', 'settings.autostopHint': 'Bing 搜索计满后提前结束',
      'settings.automation': '自动化', 'settings.cooldown': '等待 Bing 冷却',
      'settings.cooldownHint': '积分暂停时等待后继续', 'settings.cooldownWait': '等待时长',
      'auto.title': '自动完成任务', 'auto.enable': '定时自动运行',
      'auto.enableHint': '到点自动点击未完成任务卡片，并按剩余分数搜索，最多 10 个时间点',
      'auto.count': '搜索次数上限', 'auto.countHint': '按今日 Bing 搜索剩余分数自动决定，不超过此值', 'auto.times': '启动时间',
      'auto.timesHint': '可添加多个，自动去重排序', 'auto.addTime': '添加',
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
      'test.title': '测试拟人搜索', 'test.run': '单次拟人搜索测试',
      'test.runHint': '在后台标签页跑一次真实键鼠搜索，不读积分、不影响自动任务',
      'test.runButton': '运行测试', 'test.running': '测试中…',
      'test.ok': '测试通过', 'test.fail': '测试失败',
      'test.runningBusy': '已有搜索在运行，请先停止',
      'test.keyword': '关键词', 'test.input': '输入方式', 'test.inputCdp': 'CDP 真实键鼠',
      'test.inputFallback': '页面内合成事件', 'test.mode': '路径', 'test.modePaste': '粘贴关键词',
      'test.level': '拟人强度', 'test.elapsed': '耗时', 'test.error': '原因',
      'test.hint': '测试会在后台标签页完成一次搜索后自动关闭，不会写入积分或自动任务记录。'
    },
    en: {
      'app.title': 'Human Search Assistant',
      'a11y.language': 'Switch language', 'a11y.settings': 'Open settings', 'a11y.theme': 'Switch theme',
      'a11y.progress': 'Today\'s tasks progress', 'a11y.points': 'Points summary', 'a11y.dismiss': 'Dismiss',
      'a11y.back': 'Back', 'a11y.customCount': 'Custom number of searches', 'a11y.autoTime': 'Start time',
      'theme.light': 'Light', 'theme.dark': 'Dark', 'theme.system': 'System',
      'theme.toLight': 'Switch to light theme', 'theme.toDark': 'Switch to dark theme',
      'progress.searches': 'searches', 'progress.tasks': 'Today\'s tasks', 'progress.ptsToday': 'pts today', 'progress.cooldown': 'cooldown',
      'progress.pleaseWait': 'please wait',
      'status.ready': 'Ready', 'status.reading': 'Reading points', 'status.checking': 'Checking today',
      'status.searching': 'Searching', 'status.cooldown': 'Bing cooldown', 'status.finalizing': 'Finalizing',
      'status.completed': 'Completed', 'status.limit': 'Limit reached', 'status.error': 'Error',
      'status.allDone': 'All tasks done — nothing to do',
      'status.completingTasks': 'Completing tasks',
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
      'tasks.added': 'Added {time}', 'tasks.removed': 'Removed {time}',
      'tasks.duplicate': 'That time is already in the list.', 'tasks.limit': 'You can add up to 10 times.',
      'tasks.invalid': 'Pick a valid time (HH:MM).',
      'tasks.disabledTip': 'Scheduling is off. Turn on Settings → Auto-complete tasks → Scheduled runs.',
      'settings.title': 'Settings', 'settings.appearance': 'Appearance', 'settings.language': '语言 / Language',
      'settings.theme': 'Theme', 'settings.reduce': 'Reduce animations', 'settings.reduceHint': 'Turn off motion effects',
      'settings.searches': 'Searches', 'settings.defaultCount': 'Default searches', 'settings.other': 'Other',
      'settings.pace': 'Pace', 'settings.paceHint': 'Time spent on each result',
      'pace.normal': 'Normal', 'pace.relaxed': 'Relaxed',
      'settings.autostop': 'Stop at daily limit', 'settings.autostopHint': 'End early once Bing search is maxed',
      'settings.automation': 'Automation', 'settings.cooldown': 'Wait out Bing cooldown',
      'settings.cooldownHint': 'Pause when points stop counting, then resume', 'settings.cooldownWait': 'Wait for',
      'auto.title': 'Auto-complete tasks', 'auto.enable': 'Scheduled runs',
      'auto.enableHint': 'Click unfinished cards, then search as needed, up to 10 start times',
      'auto.count': 'Search cap', 'auto.countHint': 'Decided from remaining Bing search points, capped here', 'auto.times': 'Start times',
      'auto.timesHint': 'Add multiple times, auto-sorted and deduped', 'auto.addTime': 'Add',
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
      'test.title': 'Test human-like search', 'test.run': 'Single test search',
      'test.runHint': 'Runs one real mouse/keyboard search in a background tab — no points read, no auto-task changes',
      'test.runButton': 'Run test', 'test.running': 'Testing…',
      'test.ok': 'Test passed', 'test.fail': 'Test failed',
      'test.runningBusy': 'A search is already running. Stop it first.',
      'test.keyword': 'Keyword', 'test.input': 'Input', 'test.inputCdp': 'CDP real mouse/keyboard',
      'test.inputFallback': 'In-page synthetic events', 'test.mode': 'Path', 'test.modePaste': 'Paste keyword',
      'test.level': 'Intensity', 'test.elapsed': 'Elapsed', 'test.error': 'Reason',
      'test.hint': 'The test opens a background tab, performs one search, then closes it. No points or auto-task logs are written.'
    }
  };

  let lang = 'zh';
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
    $('lang-toggle-text').textContent = lang === 'zh' ? 'EN' : '中';
    const label = root.getAttribute('data-theme') === 'dark' ? t('theme.toLight') : t('theme.toDark');
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
    noticeCopy.textContent = t('notice.copy');
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    chrome.storage.local.set({ uiLang: lang });
    applyI18n();
    syncSettingsUI();
    if (lastTestResult) renderTestResult(lastTestResult);
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
  let lastTestResult = null;

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
    const chars = [...text];
    const shape = chars.map(c => (isDigit(c) ? '#' : c)).join('');
    let sr = el.querySelector(':scope > .sr-only');
    let odo = el.querySelector(':scope > .odo');
    if (!odo || el.dataset.shape !== shape) {
      el.dataset.shape = shape;
      el.textContent = '';
      sr = document.createElement('span');
      sr.className = 'sr-only';
      odo = document.createElement('span');
      odo.className = 'odo';
      odo.setAttribute('aria-hidden', 'true');
      for (const c of chars) {
        if (isDigit(c)) {
          const col = document.createElement('span');
          col.className = 'odo-digit';
          const strip = document.createElement('span');
          strip.className = 'odo-strip';
          for (let d = 0; d <= 9; d++) {
            const cell = document.createElement('span');
            cell.textContent = String(d);
            strip.appendChild(cell);
          }
          col.appendChild(strip);
          odo.appendChild(col);
        } else {
          const s = document.createElement('span');
          s.className = 'odo-static';
          s.textContent = c;
          odo.appendChild(s);
        }
      }
      el.append(sr, odo);
      void odo.offsetWidth;
    }
    sr.textContent = text;
    const strips = odo.querySelectorAll('.odo-strip');
    const digits = chars.filter(isDigit);
    strips.forEach((strip, i) => {
      strip.style.transitionDelay = `${(strips.length - 1 - i) * 45}ms`;
      strip.style.transform = `translateY(${-Number(digits[i]) * 10}%)`;
    });
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
  $('lang-toggle').addEventListener('click', () => setLang(lang === 'zh' ? 'en' : 'zh'));

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

  function setAction(mode, label, disabled) {
    btnAction.classList.toggle('is-stop', mode === 'stop');
    btnAction.dataset.mode = mode;
    if (actionLabel.textContent !== label) {
      actionLabel.textContent = label;
      if (!motionOff()) restart(actionLabel, 'swap');
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
      pendingStartUntil = Date.now() + 4000;
      setAction('stop', t('controls.starting'), true);
      const res = await send('autoComplete', { level: autoTasks.level });
      // v2.9：后台确认全完成 → 零动作，只在圆圈下方显示绿色小字。
      // 注意：正常流程返回的是 skippedCards（跳过的不给分卡片数），不能当成整轮跳过。
      if (res && (res.reason === 'allDone' || res.skipped === true)) {
        showAllDoneNotice();
      } else if (!res) {
        // 后台无响应：错误横幅已由 send() 显示，按钮别一直卡在「启动中」
        pendingStartUntil = 0;
        setAction('start', t('controls.start'), false);
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
    setStatus(t('status.allDone'), 'completed all-done', false);
    setAction('start', t('controls.start'), false);
    // 让读屏软件也读得到
    statusEl.setAttribute('aria-label', t('status.allDone'));
  }

  let statusTimer = null;
  function setStatus(text, cls, isQuery, title) {
    const key = `${cls}|${isQuery ? 'q' : ''}|${text}|${lang}`;
    if (statusEl.dataset.key === key) return;
    const first = !statusEl.dataset.key;
    statusEl.dataset.key = key;
    const from = statusEl.offsetWidth;
    clearTimeout(statusTimer);
    statusEl.style.width = '';
    statusEl.className = 'status ' + cls + (isQuery ? ' show-query' : '');
    statusText.textContent = text;
    if (title) statusEl.title = title;
    else statusEl.removeAttribute('title');
    if (first || motionOff()) return;
    restart(statusText, 'swap');
    const to = statusEl.offsetWidth;
    if (Math.abs(to - from) < 1) return;
    statusEl.style.width = from + 'px';
    void statusEl.offsetWidth;
    statusEl.style.width = to + 'px';
    statusTimer = setTimeout(() => { statusEl.style.width = ''; }, 380);
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
    completed: [t('status.completed'), 'completed'],
    limitReached: [t('status.limit'), 'completed'],
    error: [t('status.error'), 'error']
  });

  function render(d) {
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
    const clock = ms => {
      const s = Math.ceil(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    const [label, cls] = statusMap[phase];
    const showQuery = phase === 'searching' && !d.stopRequested && !!d.currentQuery;
    // 全完成提示优先：storage 变化触发的 render 不能把绿色小字冲掉
    if (running) allDoneNoticeUntil = 0;
    const noticeActive = !running && Date.now() < allDoneNoticeUntil;
    if (noticeActive) {
      setStatus(t('status.allDone'), 'completed all-done', false);
    } else if (showQuery) {
      setStatus(d.currentQuery, cls, true, t('status.searchingTitle', { q: d.currentQuery }));
    } else if (phase === 'searching') {
      setStatus(d.stopRequested ? t('status.stopping') : t('status.of', { a: current, b: total }), cls, false);
    } else {
      setStatus(label, cls, false);
    }

    // 圆环与下方「今日任务」汇总保持一致：只显示百分比，不显示积分/搜索次数
    const tt = d.todayTasks || {};
    const hasTasks = Array.isArray(tt.items) && tt.items.length > 0;
    const taskPct = hasTasks ? Math.max(0, Math.min(100, Number(tt.percent) || 0)) : 0;
    ring.classList.remove('spinning');
    setOdometer(progressText, hasTasks ? `${taskPct}%` : '—');
    progressSub.textContent = t('progress.tasks');
    setRing(hasTasks ? taskPct / 100 : 0);

    // 三张卡固定取 dashboard / earn 页面解析出的值，不再随运行状态估算
    const ps = d.pointsSummary || {};
    const panelVal = v => Number.isFinite(v) ? fmt(v) : '—';
    setOdometer(startEl, panelVal(ps.available));
    setOdometer(currentEl, panelVal(ps.today));
    setOdometer(earnedEl, panelVal(ps.claimable));
    earnedEl.className = 'point-value';
    earnedLabel.textContent = t('points.earned');

    const panelNote = ps.signedOut ? t('tip.signedOut') : (ps.updatedAt ? '' : t('tip.loading'));
    setTip('tip-start', t('tip.startTitle'), [], panelNote || t('tip.available'));
    setTip('tip-current', t('tip.currentTitle'), [], panelNote || t('tip.todayPoints'));
    setTip('tip-earned', t('tip.earnedTitle'), [], panelNote || t('tip.claimable'));

    // 「今日搜索积分已领完」等提示与「今日 Bing 搜索」进度条已从界面移除
    setNotice(null);
    daily.hidden = true;
    renderTodayTasks(d.todayTasks);
    diagText = JSON.stringify({ start: d.diag || null, limit: d.diagLimit || null }, null, 2);
    noticeCopy.hidden = true;

    if (d.error) showError(d.error);

    if (running) {
      pendingStartUntil = 0;
      countInput.disabled = true;
      if (phase === 'fetchingEndPoints') setAction('stop', t('controls.finishing'), true);
      else if (d.stopRequested) setAction('stop', t('controls.stopping'), true);
      else setAction('stop', t('controls.stop'), false);
    } else if (Date.now() < pendingStartUntil) {
      setAction('stop', t('controls.starting'), true);
    } else {
      countInput.disabled = false;
      setAction('start', t('controls.start'), false);
    }
  }

  let pending = false;
  function refresh() {
    if (pending) return;
    pending = true;
    setTimeout(async () => {
      pending = false;
      try {
        render(await chrome.storage.local.get(KEYS));
      } catch (err) {
        console.warn('Render failed:', err.message);
      }
    }, 0);
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

  function saveAutoTasks(patch) {
    autoTasks = normalizeAutoTasks(Object.assign({}, autoTasks, patch));
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
    $('auto-opts').classList.toggle('off', !autoTasks.enabled);
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
    $('set-lang') && setSegment('set-lang', lang);
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
      empty.textContent = data && data.signedOut ? t('todayTasks.emptyLogin') : t('todayTasks.empty');
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
    const btn = $('today-tasks-refresh');
    btn.disabled = true;
    setTodayMsg(t('todayTasks.refreshing'));
    const res = await send('refreshTasks');
    btn.disabled = false;
    const failed = !!res && res.ok === false;
    setTodayMsg(failed ? t('todayTasks.refreshFailed') : t('todayTasks.refreshed'), failed);
    refresh();
  });

  /* ------------------------------------------------------- 测试拟人搜索（设置页） */
  function renderTestResult(res) {
    const box = $('set-test-result');
    const status = $('set-test-status');
    if (!res) { box.hidden = true; status.textContent = ''; return; }
    const ok = !!res.ok;
    status.textContent = t(ok ? 'test.ok' : 'test.fail');
    status.className = 'test-status ' + (ok ? 'ok' : 'warn');

    const rows = [];
    if (res.keyword) rows.push([t('test.keyword'), res.keyword]);
    rows.push([t('test.input'), res.realInput ? t('test.inputCdp') : t('test.inputFallback')]);
    rows.push([t('test.mode'), t('test.modePaste')]);
    rows.push([t('test.level'), t('tasks.level' + clampInt(res.level || 3, 1, 3, 3))]);
    rows.push([t('test.elapsed'), ((Number(res.ms) || 0) / 1000).toFixed(1) + ' s']);
    if (!ok) {
      const reason = res.reason === 'running'
        ? t('test.runningBusy')
        : (res.message || t('error.extension', { msg: 'unknown' }));
      rows.push([t('test.error'), localizeError(reason)]);
    }

    box.textContent = '';
    for (const [k, v] of rows) {
      const line = document.createElement('div');
      line.className = 'test-row' + (k === t('test.error') ? ' err' : '');
      const key = document.createElement('span');
      key.textContent = k;
      const val = document.createElement('span');
      val.textContent = v;
      line.append(key, val);
      box.appendChild(line);
    }
    const hint = document.createElement('p');
    hint.className = 'test-hint';
    hint.textContent = t('test.hint');
    box.appendChild(hint);
    box.hidden = false;
  }

  $('set-test-run').addEventListener('click', async () => {
    const btn = $('set-test-run');
    btn.disabled = true;
    $('set-test-status').textContent = t('test.running');
    $('set-test-status').className = 'test-status';
    $('set-test-result').hidden = true;
    const res = await send('testSearch', { level: autoTasks.level });
    btn.disabled = false;
    btn.textContent = t('test.runButton');
    lastTestResult = res || { ok: false, reason: 'error', message: 'no response', level: autoTasks.level };
    renderTestResult(lastTestResult);
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
    setSegment('set-lang', lang);
    $('set-reduce').checked = !!settings.reduceMotion;
    setSegment('set-count-chips', settings.defaultCount);
    const isPreset = [10, 20, 30, 50].includes(Number(settings.defaultCount));
    const custom = $('set-count');
    if (document.activeElement !== custom) custom.value = isPreset ? '' : settings.defaultCount;
    custom.placeholder = t('settings.other');
    custom.classList.toggle('custom', !isPreset);
    setSegment('set-pace', settings.pace);
    $('set-autostop').checked = !!settings.autoStop;
    $('set-cooldown').checked = !!settings.cooldownAware;
    $('cooldown-opts').classList.toggle('off', !settings.cooldownAware);
    setSegment('set-cooldown-min', settings.cooldownMinutes);
    syncAutoUI();
  }

  onSegment('set-lang', v => setLang(v));
  onSegment('set-theme', mode => applyTheme(mode));
  $('set-reduce').addEventListener('change', e => {
    setReduceMotion(e.target.checked);
    saveSettings({ reduceMotion: e.target.checked });
  });

  function setDefaultCount(v) {
    const count = clampInt(v, 1, 150, settings.defaultCount);
    saveSettings({ defaultCount: count });
    if (!countInput.disabled) countInput.value = count;
    refresh();
  }
  onSegment('set-count-chips', v => setDefaultCount(v));
  $('set-count').addEventListener('change', e => {
    if (e.target.value !== '') setDefaultCount(e.target.value);
  });
  onSegment('set-pace', v => saveSettings({ pace: v }));
  $('set-autostop').addEventListener('change', e => saveSettings({ autoStop: e.target.checked }));
  $('set-cooldown').addEventListener('change', e => saveSettings({ cooldownAware: e.target.checked }));
  onSegment('set-cooldown-min', v => saveSettings({ cooldownMinutes: Number(v) }));

  /* 自动完成任务设置 */
  $('set-auto').addEventListener('change', e => saveAutoTasks({ enabled: e.target.checked }));
  onSegment('set-auto-count-chips', v => saveAutoTasks({ count: v }));
  $('set-auto-count').addEventListener('change', e => {
    if (e.target.value !== '') saveAutoTasks({ count: e.target.value });
  });
  onSegment('set-auto-level', v => saveAutoTasks({ level: Number(v) }));

  function addAutoTime() {
    const input = $('set-auto-time');
    const value = String(input.value || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) { setAutoMsg(t('tasks.invalid'), true); return; }
    if (autoTasks.times.includes(value)) { setAutoMsg(t('tasks.duplicate'), true); return; }
    if (autoTasks.times.length >= AUTO_MAX_TIMES) { setAutoMsg(t('tasks.limit'), true); return; }
    saveAutoTasks({ times: [...autoTasks.times, value] });
    input.value = '';
    setAutoMsg(t('tasks.added', { time: value }));
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
    if (!countInput.disabled) countInput.value = DEFAULTS.defaultCount;
    refresh();
  });

  /* ------------------------------------------------------------------ 启动 */
  async function loadUiLang() {
    const { uiLang } = await chrome.storage.local.get(['uiLang']);
    lang = uiLang === 'en' ? 'en' : 'zh';
    applyI18n();
    syncSettingsUI();
    refresh();
  }

  async function loadAutoTasks() {
    const { autoTasks: saved } = await chrome.storage.local.get(['autoTasks']);
    autoTasks = normalizeAutoTasks(saved);
    syncAutoUI();
  }

  syncThemeControls();
  chrome.storage.local.set({ uiTheme: savedThemeMode() === 'system' ? null : savedThemeMode() });
  loadUiLang();
  loadSettings();
  loadAutoTasks();
  chrome.storage.local.get(['running', 'todayCheckedAt', 'todayTasks', 'pointsSummary']).then(s => {
    if (s.running) return;
    const stale = Date.now() - (s.todayCheckedAt || 0) > TODAY_REFRESH_MS;
    if (stale) send('refreshToday');                 // 会顺带刷新任务列表 + 三项积分
    if (!stale) {
      const tt = s.todayTasks && s.todayTasks.updatedAt;
      const ps = s.pointsSummary && s.pointsSummary.updatedAt;
      if (!tt || Date.now() - tt > TODAY_REFRESH_MS) send('refreshTasks');
      else if (!ps || Date.now() - ps > TODAY_REFRESH_MS) send('refreshPoints');
    }
  });

  refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.uiLang) {
      lang = changes.uiLang.newValue === 'en' ? 'en' : 'zh';
      applyI18n();
    }
    if (changes.autoTasks) {
      autoTasks = normalizeAutoTasks(changes.autoTasks.newValue);
      syncAutoUI();
    }
    refresh();
  });
  const pollId = setInterval(refresh, 1000);
  window.addEventListener('pagehide', () => clearInterval(pollId));
});
