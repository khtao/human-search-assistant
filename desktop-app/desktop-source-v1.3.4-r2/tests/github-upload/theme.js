(function () {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const read = key => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const saved = () => {
    const t = read('theme');
    return t === 'light' || t === 'dark' ? t : null;
  };
  root.setAttribute('data-theme', saved() || (media.matches ? 'dark' : 'light'));
  if (read('reduceMotion') === '1') root.classList.add('reduce-motion');
  media.addEventListener('change', e => {
    if (!saved()) root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
  });
})();
