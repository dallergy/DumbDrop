/**
 * Theme handling: light, dark, or follow system.
 */

const STORAGE_KEY = 'theme';

function systemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getThemePreference() {
  return localStorage.getItem(STORAGE_KEY) || 'system';
}

export function applyTheme(preference = getThemePreference()) {
  const resolved = preference === 'system' ? systemTheme() : preference;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-pref', preference);
  localStorage.setItem(STORAGE_KEY, preference);
  return resolved;
}

export function cycleTheme() {
  const current = getThemePreference();
  const next = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
  return applyTheme(next);
}

export function initTheme() {
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemePreference() === 'system') applyTheme('system');
  });
}
