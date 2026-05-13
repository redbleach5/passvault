/**
 * ui/screens.js — Tab switching, theme, auto-lock
 */

import { state } from '../state.js';
import { showScreen, showToast, updateThemeToggle } from './ui.js';
import { auditLog } from '../audit.js';
import { syncToSecureStorage } from '../storage.js';

// ===== Tab switching =====

async function switchTab(tab) {
  state.currentTab = tab;
  showScreen(tab === 'vault' ? 'screen-main' : tab === 'generator' ? 'screen-generator' : 'screen-settings');
  document.querySelectorAll('.tab-bar').forEach(bar => {
    bar.querySelectorAll('.tab-item').forEach((item, idx) => {
      const tabs = ['vault','generator','settings'];
      item.classList.toggle('active', tabs[idx] === tab);
    });
  });
  if (tab === 'vault') {
    const { renderDashboard } = await import('./vault.js');
    renderDashboard();
  }
}

// ===== Theme =====

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('pv_theme', next);
  updateThemeToggle();
}

function updateThemeToggle() {
  const theme = document.documentElement.getAttribute('data-theme');
  const toggle = document.getElementById('theme-toggle');
  const status = document.getElementById('theme-status');
  if (toggle) toggle.className = 'toggle-switch' + (theme === 'dark' ? ' on' : '');
  if (status) status.textContent = theme === 'dark' ? 'Включена' : 'Выключена';
}

// ===== Lock / Unlock =====

function lockVault() {
  if (state.masterKey) {
    state.masterKey = null;
  }
  state.masterHash = null;
  state.masterKeyCreatedAt = 0;
  if (state.masterKeyTtlTimer) { clearTimeout(state.masterKeyTtlTimer); state.masterKeyTtlTimer = null; }
  state.credMap.clear();
  clearTimeout(state.autoLockTimer);
  document.querySelectorAll('input[type="password"], input[type="text"][id$="-pw"], textarea').forEach(inp => { inp.value = ''; });
  state.detailPwVisible = false;
  auditLog('lock', null, null, 'success');
  showScreen('screen-unlock');
  document.getElementById('unlock-error').style.display = 'none';
}

function resetAutoLock() {
  if (!state.masterKey) return;
  clearTimeout(state.autoLockTimer);
  state.autoLockTimer = setTimeout(() => { lockVault(); showToast('Хранилище заблокировано (таймаут)'); }, state.AUTO_LOCK_MS || 5 * 60 * 1000);
  // Absolute 30-minute TTL for master key in memory
  if (!state.masterKeyTtlTimer && state.masterKeyCreatedAt > 0) {
    const MASTER_KEY_TTL_MS = 30 * 60 * 1000;
    const remaining = MASTER_KEY_TTL_MS - (Date.now() - state.masterKeyCreatedAt);
    if (remaining <= 0) {
      lockVault();
      showToast('Мастер-пароль очищен (30 мин истекли)');
    } else {
      state.masterKeyTtlTimer = setTimeout(() => {
        state.masterKeyTtlTimer = null;
        lockVault();
        showToast('Мастер-пароль очищен (30 мин истекли)');
      }, remaining);
    }
  }
}

function startAutoLock() {
  state.masterKeyCreatedAt = Date.now();
  state.masterKeyTtlTimer = null;
  resetAutoLock();
  if (!state._autoLockListenersAdded) {
    state._autoLockListenersAdded = true;
    ['click','keydown','mousemove','touchstart','scroll'].forEach(evt => {
      document.addEventListener(evt, resetAutoLock, { passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.masterKey) {
        lockVault();
        showToast('Хранилище заблокировано (приложение в фоне)');
      }
    });
  }
}

// ===== App entry =====

async function enterApp() {
  const theme = localStorage.getItem('pv_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeToggle();
  showScreen('screen-main');
  switchTab('vault');
  // Dynamic import to avoid circular dependency
  const { generatePassword } = await import('./generator.js');
  generatePassword();
}

export {
  switchTab, toggleTheme, updateThemeToggle,
  lockVault, resetAutoLock, startAutoLock, enterApp
};
