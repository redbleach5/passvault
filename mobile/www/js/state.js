/**
 * state.js — Shared mutable application state
 * Central state object that is imported by multiple modules.
 * All mutable state is stored as properties of the `state` object
 * so that changes are visible across all importers.
 */

const state = {
  // Master key (CryptoKey object, non-extractable)
  masterKey: null,
  masterHash: null,

  // UI state
  currentTab: 'vault',
  currentCategory: 'all',
  currentDetailServiceId: null,
  wizardServiceId: null,
  wizardStep: 0,
  wizardNewPassword: '',
  confirmCallback: null,
  credMap: new Map(),

  // Auto-lock
  autoLockTimer: null,
  AUTO_LOCK_MS: 5 * 60 * 1000,        // 5 minutes inactivity auto-lock
  MASTER_KEY_TTL_MS: 30 * 60 * 1000,   // 30 minutes max master key lifetime
  masterKeyCreatedAt: 0,
  masterKeyTtlTimer: null,
  detailPwVisible: false,

  // Rate limiting
  failedAttempts: parseInt(localStorage.getItem('pv_failed_attempts') || '0', 10),
  lockoutUntil: parseInt(localStorage.getItem('pv_lockout_until') || '0', 10),
  MAX_FAILED_ATTEMPTS: 5,
  LOCKOUT_DURATION_MS: 15 * 60 * 1000,
  LOCKOUT_DELAYS: [0, 1000, 2000, 5000, 15000, 60000],

  // Auto-lock listener flag (prevent duplicate listeners)
  _autoLockListenersAdded: false
};

export { state };
