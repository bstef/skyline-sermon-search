// Apply before the stylesheet paints, avoiding a flash of the wrong theme.
(() => {
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { preference = localStorage.getItem('skyline-theme'); } catch { /* Private browsers can block storage. */ }
  if (!['light', 'dark'].includes(preference)) preference = null;
  function apply(theme) {
    root.dataset.theme = theme;
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(theme === 'dark'));
      toggle.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
    }
  }
  apply(preference || (system.matches ? 'dark' : 'light'));
  system.addEventListener('change', event => {
    if (!preference) apply(event.matches ? 'dark' : 'light');
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme);
    document.getElementById('theme-toggle').addEventListener('click', () => {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('skyline-theme', preference); } catch { /* The toggle still works without persistence. */ }
      apply(preference);
    });
  });
})();
