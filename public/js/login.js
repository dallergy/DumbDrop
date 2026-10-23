/**
 * PIN login page. Uses a single field so PIN length is not leaked.
 */

import { loadAppConfig, apiUrl } from './utils.js';
import { initTheme } from './theme.js';

window.APP_CONFIG = { basePath: '/', ...loadAppConfig() };

initTheme();

const form = document.getElementById('pin-form');
const input = document.getElementById('pin-input');
const errorEl = document.getElementById('pin-error');

fetch(apiUrl('/api/auth/pin-required'))
  .then((response) => {
    if (response.status === 429)
      throw new Error('Too many attempts. Please wait before trying again.');
    return response.json();
  })
  .then((data) => {
    if (!data.required && !data.adminLogin) {
      window.location.href = apiUrl('/');
      return;
    }
    if (!data.required) {
      // Uploads are open; this page is only for the admin.
      document.getElementById('pin-prompt').textContent = 'Enter the admin PIN to manage files.';
      document.getElementById('skip-login').hidden = false;
    } else if (data.adminLogin) {
      document.getElementById('pin-prompt').textContent =
        'Enter your PIN. The admin PIN also unlocks file management.';
    }
    input.focus();
  })
  .catch((err) => {
    errorEl.textContent = err.message || 'Error checking PIN requirement';
    input.disabled = true;
  });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = input.value.replace(/\D/g, '');
  if (pin.length < 4) {
    errorEl.textContent = 'PIN must be at least 4 digits.';
    return;
  }
  try {
    const response = await fetch(apiUrl('/api/auth/verify-pin'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ pin }),
    });
    const data = await response.json();
    if (data.success) {
      window.location.href = apiUrl('/');
      return;
    }
    errorEl.textContent = data.error || 'Authentication failed';
    const locked = (data.error || '').includes('Too many PIN verification attempts');
    if (locked) {
      input.disabled = true;
    } else {
      input.value = '';
      input.focus();
    }
  } catch {
    errorEl.textContent = 'Error verifying PIN';
  }
});
