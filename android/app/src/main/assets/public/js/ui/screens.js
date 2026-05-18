/**
 * ui/screens.js — Tab switching, theme, auto-lock
 */

import { state } from '../state.js';
import { showScreen, showToast } from '../ui.js';
import { auditLog } from '../audit.js';
import { syncToSecureStorage } from '../storage.js';
import { decryptCloudConfigs } from '../storage.js';

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
    try {
      const { renderDashboard } = await import('./vault.js');
      await renderDashboard();
    } catch(e) {
      console.error('renderDashboard failed:', e);
      // Show fallback content
      const cardsList = document.getElementById('cards-list');
      const statsRow = document.getElementById('stats-row');
      if (statsRow && !statsRow.innerHTML) {
        statsRow.innerHTML = '<div class="stat-card"><div class="stat-num">0</div><div class="stat-label">Сохранено</div></div><div class="stat-card"><div class="stat-num">0%</div><div class="stat-label">Здоровье</div></div><div class="stat-card"><div class="stat-num">24</div><div class="stat-label">Без пароля</div></div>';
      }
      if (cardsList && !cardsList.innerHTML) {
        cardsList.innerHTML = '<div class="empty-state"><div class="empty-icon">🔐</div><h3>Начните добавлять пароли</h3><p>Нажмите + чтобы сохранить первый пароль</p><button class="btn btn-primary" onclick="openAddCredential()" style="font-size:15px;padding:12px 24px;margin-top:16px">Добавить сервис</button></div>';
      }
    }
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
  // Decrypt cloud configs back to plaintext before losing the key
  // so they can be used when vault is locked (e.g. for sync)
  if (state.masterKey) {
    const key = state.masterKey;
    decryptCloudConfigs(key).catch(e => console.warn('Cloud config decryption on lock failed:', e));
  }
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
  // Don't reset auto-lock timer during vault creation grace period
  if (state._justCreatedVault) return;
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
  state._vaultUnlockTime = Date.now(); // Grace period start
  state._justCreatedVault = true;     // Prevent auto-lock for 30s after vault creation/unlock
  state.masterKeyTtlTimer = null;
  // Clear the _justCreatedVault flag after 30 seconds
  setTimeout(() => { state._justCreatedVault = false; }, state.VAULT_LOCK_GRACE_MS || 30000);
  resetAutoLock();
  if (!state._autoLockListenersAdded) {
    state._autoLockListenersAdded = true;
    ['click','keydown','mousemove','touchstart','scroll'].forEach(evt => {
      document.addEventListener(evt, resetAutoLock, { passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.masterKey) {
        // Flag check: don't lock during vault creation/unlock grace period
        if (state._justCreatedVault) {
          console.log('Auto-lock skipped (vault just created/unlocked)');
          return;
        }
        // Grace period: don't lock immediately after vault creation/unlock
        const elapsed = Date.now() - state._vaultUnlockTime;
        if (elapsed < (state.VAULT_LOCK_GRACE_MS || 30000)) {
          console.log('Auto-lock skipped (grace period)');
          return;
        }
        lockVault();
        showToast('Хранилище заблокировано (приложение в фоне)');
      }
    });
  }
}

// ===== App entry =====

async function enterApp() {
  try {
    // Apply saved theme mode (defaults to 'system')
    const mode = localStorage.getItem('pv_theme_mode') || 'system';
    applyThemeMode(mode);
    showScreen('screen-main');
    await switchTab('vault');
    // Dynamic import to avoid circular dependency
    const { generatePassword } = await import('./generator.js');
    generatePassword();
    // Sync autofill credentials in background (best-effort)
    try {
      const { syncAllAutofillCredentials } = await import('../autofill.js');
      const { loadVault, getAllServices } = await import('./vault.js');
      const vault = await loadVault();
      const allSvc = await getAllServices();
      const creds = Object.entries(vault.credentials || {}).map(([svcId, cred]) => {
        const svc = allSvc.find(s => s.id === svcId);
        return {
          serviceId: svcId,
          username: cred.username || '',
          password: cred.password || '',
          urls: svc ? [svc.loginUrl, svc.passwordChangeUrl].filter(Boolean) : []
        };
      }).filter(c => c.username && c.password);
      await syncAllAutofillCredentials(creds);
    } catch(e) { console.warn('Autofill sync skipped:', e); }
    // Initialize autofill UI
    try {
      const { initAutofillUI } = await import('../autofill.js');
      await initAutofillUI();
    } catch(e) { console.warn('Autofill UI init skipped:', e); }
  } catch(e) {
    console.error('enterApp error:', e);
    // Ensure main screen is shown even on error
    showScreen('screen-main');
    const cardsList = document.getElementById('cards-list');
    if (cardsList && !cardsList.innerHTML) {
      cardsList.innerHTML = '<div class="empty-state"><div class="empty-icon">🔐</div><h3>Начните добавлять пароли</h3><p>Нажмите + чтобы сохранить первый пароль</p><button class="btn btn-primary" onclick="openAddCredential()" style="font-size:15px;padding:12px 24px;margin-top:16px">Добавить сервис</button></div>';
    }
  }
}

export {
  switchTab, toggleTheme, updateThemeToggle, initTheme,
  lockVault, resetAutoLock, startAutoLock, enterApp
};
