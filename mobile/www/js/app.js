/**
 * app.js — Main entry point: setup, unlock, initialization
 */

import { state } from './state.js';
import { deriveKeyAndHash, constantTimeEqual, migrateVaultIfNeeded } from './crypto.js';
import { preLoadSecureData, syncToSecureStorage } from './storage.js';
import { auditLog } from './audit.js';
import { showScreen, showToast, updateStrengthMeter, closeConfirm, confirmAction } from './ui.js';
import { lockVault, startAutoLock, enterApp, switchTab } from './ui/screens.js';
import { renderDashboard, saveVault } from './ui/vault.js';
import { generatePassword } from './ui/generator.js';

// ===== Setup =====

document.getElementById('setup-pw1').addEventListener('input', function() {
  updateStrengthMeter('setup-pw1', 'setup-strength-fill', 'setup-strength-text');
  checkSetupMatch();
});

document.getElementById('setup-pw2').addEventListener('input', checkSetupMatch);

function checkSetupMatch() {
  const pw1 = document.getElementById('setup-pw1').value;
  const pw2 = document.getElementById('setup-pw2').value;
  const hint = document.getElementById('setup-match');
  const btn = document.getElementById('setup-btn');
  if (!pw2) { hint.textContent = ''; btn.disabled = true; return; }
  if (pw1 === pw2) {
    hint.textContent = '✓ Пароли совпадают';
    hint.className = 'match-hint ok';
    btn.disabled = pw1.length < 8;
  } else {
    hint.textContent = '✗ Пароли не совпадают';
    hint.className = 'match-hint err';
    btn.disabled = true;
  }
}

async function doSetup() {
  const btn = document.getElementById('setup-btn');
  const errEl = document.getElementById('setup-error');
  const pw = document.getElementById('setup-pw1').value;
  if (pw.length < 8) return;

  if (!crypto || !crypto.subtle) {
    errEl.textContent = 'Ошибка: Web Crypto API недоступен. Используйте HTTPS или localhost.';
    errEl.style.display = 'block';
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Создание...';
    errEl.style.display = 'none';

    const { key, hash, salt } = await deriveKeyAndHash(pw);
    state.masterKey = key;
    state.masterHash = hash;
    state.failedAttempts = 0;
    localStorage.setItem('pv_salt', salt);
    localStorage.setItem('pv_hash', hash);
    localStorage.setItem('pv_format', 'v2');
    await saveVault({ credentials: {} });
    auditLog('vault_created', null, null, 'success');
    document.getElementById('setup-pw1').value = '';
    document.getElementById('setup-pw2').value = '';
    startAutoLock();
    enterApp();
    btn.disabled = false;
    btn.textContent = 'Создать хранилище';
  } catch(e) {
    console.error('Setup failed:', e);
    errEl.textContent = 'Ошибка создания хранилища: ' + (e.message || e);
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Создать хранилище';
  }
}

// ===== Unlock =====

async function doUnlock() {
  const now = Date.now();
  const storedLockout = parseInt(localStorage.getItem('pv_lockout_until') || '0', 10);
  if (storedLockout > now) state.lockoutUntil = storedLockout;
  if (now < state.lockoutUntil) {
    const waitSec = Math.ceil((state.lockoutUntil - now) / 1000);
    const waitMin = Math.floor(waitSec / 60);
    const remSec = waitSec % 60;
    showToast('Подождите ' + (waitMin > 0 ? waitMin + ' мин ' : '') + remSec + 'с перед повторной попыткой');
    return;
  }
  const pw = document.getElementById('unlock-pw').value;
  if (!pw) return;
  const salt = localStorage.getItem('pv_salt');
  const storedHash = localStorage.getItem('pv_hash');

  if (!salt || !storedHash) {
    showToast('Хранилище не найдено. Создайте новое.');
    showScreen('screen-setup');
    return;
  }

  let _migratePw = pw;

  try {
    const { key, hash } = await deriveKeyAndHash(pw, salt);

    if (constantTimeEqual(hash, storedHash)) {
      state.masterKey = key;
      state.masterHash = hash;
      state.failedAttempts = 0;
      localStorage.setItem('pv_failed_attempts', '0');
      localStorage.removeItem('pv_lockout_until');
      document.getElementById('unlock-pw').value = '';
      document.getElementById('unlock-error').style.display = 'none';

      // Check if this is an import-mode unlock
      const unlockInput = document.getElementById('unlock-pw');
      const isImportMode = unlockInput.dataset.importMode === '1';
      delete unlockInput.dataset.importMode;
      unlockInput.placeholder = 'Введите пароль';

      if (isImportMode && window._pendingImport) {
        const importObj = window._pendingImport;
        window._pendingImport = null;
        const { hash: importHash } = await deriveKeyAndHash(pw, importObj.salt);
        if (constantTimeEqual(importHash, importObj.hash)) {
          const { doImportVault } = await import('./ui/settings.js');
          await doImportVault(importObj);
          _migratePw = null;
          return;
        } else {
          showToast('Пароль не подходит к резервной копии');
          _migratePw = null;
          lockVault();
          return;
        }
      }

      await migrateVaultIfNeeded(key, _migratePw);
      _migratePw = null;

      startAutoLock();
      auditLog('unlock', null, null, 'success');
      enterApp();
    } else {
      state.failedAttempts++;
      localStorage.setItem('pv_failed_attempts', String(state.failedAttempts));
      _migratePw = null;
      const LOCKOUT_DELAYS = [0, 1000, 2000, 5000, 15000, 60000];
      const delay = LOCKOUT_DELAYS[Math.min(state.failedAttempts, LOCKOUT_DELAYS.length - 1)] || 60000;
      if (delay > 0) {
        state.lockoutUntil = Date.now() + delay;
        localStorage.setItem('pv_lockout_until', String(state.lockoutUntil));
      }
      if (state.failedAttempts >= 5) {
        state.lockoutUntil = Date.now() + 15 * 60 * 1000;
        localStorage.setItem('pv_lockout_until', String(state.lockoutUntil));
        showToast('Слишком много попыток! Хранилище заблокировано на 15 минут.');
        auditLog('lockout', null, state.failedAttempts + ' неудачных попыток', 'failure');
      }
      const form = document.querySelector('#screen-unlock .auth-form');
      form.classList.add('shake');
      setTimeout(() => form.classList.remove('shake'), 500);
      document.getElementById('unlock-error').style.display = 'block';
      const remain = Math.max(0, 5 - state.failedAttempts);
      document.getElementById('unlock-error').textContent = '\u274c \u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 \u043f\u0430\u0440\u043e\u043b\u044c (' + state.failedAttempts + '/5. \u041e\u0441\u0442\u0430\u043b\u043e\u0441\u044c ' + remain + ' \u043f\u043e\u043f\u044b\u0442\u043e\u043a)';
    }
  } catch(e) {
    console.error('Unlock failed:', e);
    document.getElementById('unlock-error').textContent = 'Ошибка: ' + (e.message || e);
    document.getElementById('unlock-error').style.display = 'block';
    _migratePw = null;
  }
}

// ===== Init =====

async function init() {
  await preLoadSecureData();

  if (!crypto || !crypto.subtle) {
    document.getElementById('setup-error').textContent = 'Web Crypto API недоступен. Откройте страницу по HTTPS или localhost.';
    document.getElementById('setup-error').style.display = 'block';
    document.getElementById('setup-btn').disabled = true;
  }

  const hash = localStorage.getItem('pv_hash');
  if (hash) {
    showScreen('screen-unlock');
  } else {
    showScreen('screen-setup');
  }

  const theme = localStorage.getItem('pv_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
}

// ===== Global event handlers =====

// Sync to secure storage before page unload
window.addEventListener('beforeunload', syncToSecureStorage);
document.addEventListener('pause', syncToSecureStorage);

// Make functions globally available for onclick handlers
window.doSetup = doSetup;
window.doUnlock = doUnlock;
window.closeConfirm = closeConfirm;
window.confirmAction = confirmAction;
window.switchTab = switchTab;
window.lockVault = lockVault;
window.renderDashboard = renderDashboard;
window.openAddCredential = async () => {
  const { openAddCredential } = await import('./ui/vault.js');
  openAddCredential();
};
window.closeDetail = async () => {
  const { closeDetail } = await import('./ui/vault.js');
  closeDetail();
};

// Start the app
init();
