(() => {
  'use strict';
  const FLYOUT_URL =
    'https://cn.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards';
  const frame = document.getElementById('flyout');
  const statusEl = document.getElementById('status');

  const setStatus = (text, cls) => {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  };

  let port = null;
  try { port = chrome.runtime.connect({ name: 'hsa-sidepanel' }); } catch { port = null; }
  const register = () => {
    if (!port) return;
    try {
      port.postMessage({ __hsaPanel: 'register', url: location.href,
        at: Date.now(), inSidePanel: !!(chrome.sidePanel) });
    } catch {}
  };
  register();

  const closeSelf = () => { try { window.close(); } catch {} };
  if (port) {
    port.onMessage.addListener(msg => {
      if (!msg) return;
      if (msg.__hsaPanel === 'close') { closeSelf(); return; }
      if (msg.__hsaPanel !== 'status') return;
      setStatus(String(msg.text || ''), msg.cls || '');
    });
    port.onDisconnect.addListener(() => { port = null; });
  }

  try {
    chrome.runtime.onMessage.addListener(msg => {
      if (!msg) return;
      if (msg.type === 'hsa.sidepanel.close') { closeSelf(); return; }
      if (msg.type !== 'hsa.sidepanel.status') return;
      setStatus(String(msg.text || ''), msg.cls || '');
    });
  } catch {}

  document.getElementById('btn-reload').addEventListener('click', () => {
    setStatus('正在重新加载 Bing 侧栏…', 'running');
    try {
      frame.src = 'about:blank';
      setTimeout(() => { frame.src = FLYOUT_URL; register(); }, 120);
    } catch {
      frame.src = FLYOUT_URL;
    }
  });

  document.getElementById('btn-login').addEventListener('click', () => {
    setStatus('已在新标签页打开 Rewards，登录完成后回来点「重新加载」', '');
    try { chrome.tabs.create({ url: 'https://rewards.bing.com/' }); } catch {}
  });

  frame.addEventListener('load', () => {
    setStatus('Bing 侧栏已加载，等待自动任务…', '');
    register();
  });
})();
