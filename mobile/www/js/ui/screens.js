/**
 * ui/screens.js — Tab switching, theme, auto-lock
 */

import { state } from '../state.js';
import { showScreen, showToast } from '../ui.js';
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

/** Reference to the system theme media query listener so we can remove it later */
let _systemThemeHandler = null;

/**
 * Resolve the actual theme value from a mode.
 * @param {'dark'|'light'|'system'} mode
 * @returns {'dark'|'light'}
 */
function resolveTheme(mode) {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

/**
 * Apply a theme mode: persist the mode, resolve the actual theme,
 * set data-theme, and listen for system changes when in 'system' mode.
 * @param {'dark'|'light'|'system'} mode
 */
function applyThemeMode(mode) {
  localStorage.setItem('pv_theme_mode', mode);
  const resolved = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', resolved);

  // Remove any existing system theme listener
  if (_systemThemeHandler) {
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', _systemThemeHandler);
    _systemThemeHandler = null;
  }

  // When in system mode, listen for OS theme changes
  if (mode === 'system') {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    _systemThemeHandler = () => {
      const newResolved = resolveTheme('system');
      document.documentElement.setAttribute('data-theme', newResolved);
      updateThemeToggle();
    };
    mql.addEventListener('change', _systemThemeHandler);
  }

  // Keep legacy key in sync for any code that still reads it
  localStorage.setItem('pv_theme', resolved);
  updateThemeToggle();
}

function toggleTheme() {
  const currentMode = localStorage.getItem('pv_theme_mode') || 'system';
  const cycle = ['dark', 'light', 'system'];
  const idx = cycle.indexOf(currentMode);
  const nextMode = cycle[(idx + 1) % cycle.length];
  applyThemeMode(nextMode);
}

async function updateThemeToggle() {
  const mode = localStorage.getItem('pv_theme_mode') || 'system';
  const resolved = document.documentElement.getAttribute('data-theme');
  const toggle = document.getElementById('theme-toggle');
  const status = document.getElementById('theme-status');

  if (toggle) {
    toggle.classList.remove('on', 'half');
    if (mode === 'dark') {
      toggle.classList.add('on');
    } else if (mode === 'system') {
      toggle.classList.add('half');
    }
    // 'light' mode: no extra classes (toggle is off)
  }

  if (status) {
    const labels = { dark: 'Тёмная', light: 'Светлая', system: 'Системная' };
    status.textContent = labels[mode] || 'Системная';
  }
}

/**
 * Initialise theme early (can be called from app.js before enterApp).
 * Reads saved mode from localStorage (defaults to 'system') and applies it.
 */
function initTheme() {
  const mode = localStorage.getItem('pv_theme_mode') || 'system';
  applyThemeMode(mode);
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
  // Absolute TTL for master key in memory
  const MASTER_KEY_TTL_MS = state.MASTER_KEY_TTL_MS || 30 * 60 * 1000;
  if (!state.masterKeyTtlTimer && state.masterKeyCreatedAt > 0) {
    const remaining = MASTER_KEY_TTL_MS - (Date.now() - state.masterKeyCreatedAt);
    if (remaining <= 0) {
      lockVault();
      showToast('Мастер-пароль очищен (TTL истёк)');
    } else {
      state.masterKeyTtlTimer = setTimeout(() => {
        state.masterKeyTtlTimer = null;
        lockVault();
        showToast('Мастер-пароль очищен (TTL истёк)');
      }, remaining);
    }
  }
}

function startAutoLock() {
  // Read auto-lock settings from localStorage (with defaults)
  const savedAutoLockMs = localStorage.getItem('pv_auto_lock_ms');
  const savedMasterKeyTtlMs = localStorage.getItem('pv_master_key_ttl_ms');
  state.AUTO_LOCK_MS = savedAutoLockMs !== null ? parseInt(savedAutoLockMs, 10) : 5 * 60 * 1000;
  state.MASTER_KEY_TTL_MS = savedMasterKeyTtlMs !== null ? parseInt(savedMasterKeyTtlMs, 10) : 30 * 60 * 1000;

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
  // Apply saved theme mode (defaults to 'system')
  const mode = localStorage.getItem('pv_theme_mode') || 'system';
  applyThemeMode(mode);
  showScreen('screen-main');
  switchTab('vault');
  // Dynamic import to avoid circular dependency
  const { generatePassword } = await import('./generator.js');
  generatePassword();
}

export {
  switchTab, toggleTheme, updateThemeToggle, initTheme,
  lockVault, resetAutoLock, startAutoLock, enterApp
};
