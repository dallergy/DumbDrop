/**
 * Applies the saved theme before first paint.
 * Loaded as a plain blocking script in <head> so there is no light-mode flash;
 * CSP disallows inline scripts, hence a separate file. theme.js handles toggling.
 */
(function applyInitialTheme() {
  try {
    var preference = localStorage.getItem('theme') || 'system';
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = preference === 'system' ? (dark ? 'dark' : 'light') : preference;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-pref', preference);
  } catch {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
