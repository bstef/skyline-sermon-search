(() => {
  let theme;
  try { theme = localStorage.getItem('skyline-echo-docs-theme'); } catch {}
  if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme');
    const update = () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      button.textContent = dark ? '☀' : '☾';
      button.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
      document.querySelector('meta[name="theme-color"]').content = dark ? '#101c23' : '#f5f8f7';
    };
    button.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('skyline-echo-docs-theme', next); } catch {}
      update();
    });
    update();
  });
})();
