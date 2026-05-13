/**
 * storage.js — SecureStorage layer using @capacitor/preferences on mobile
 *
 * SECURITY: All vault data is AES-256-GCM encrypted before storage.
 * The master key is derived from the user's password via PBKDF2 with 600k iterations.
 * Even though Preferences uses SharedPreferences on Android (not Android Keystore),
 * the encrypted data is safe because an attacker with access to SharedPreferences
 * would still need the user's password to decrypt.
 */

const IS_CAPACITOR = !!(window.Capacitor && Capacitor.Plugins);
const Preferences = IS_CAPACITOR ? Capacitor.Plugins.Preferences || null : null;

// Abstract storage layer: uses @capacitor/preferences on mobile, localStorage on web
const SecureStorage = {
  async getItem(key) {
    try {
      if (IS_CAPACITOR && Preferences) {
        const result = await Preferences.get({ key });
        return result.value; // returns null when not found (no throw)
      }
    } catch(e) {}
    return localStorage.getItem(key);
  },
  async setItem(key, value) {
    try {
      if (IS_CAPACITOR && Preferences) {
        await Preferences.set({ key, value });
        return;
      }
    } catch(e) {}
    localStorage.setItem(key, value);
  },
  async removeItem(key) {
    try {
      if (IS_CAPACITOR && Preferences) {
        await Preferences.remove({ key }); // .remove() not .delete()
        return;
      }
    } catch(e) {}
    localStorage.removeItem(key);
  }
};

// Override localStorage for sensitive vault data on mobile
const _origLocalStorageSet = localStorage.setItem.bind(localStorage);
const _origLocalStorageGet = localStorage.getItem.bind(localStorage);
const _origLocalStorageRemove = localStorage.removeItem.bind(localStorage);

const SENSITIVE_KEYS = [
  'pv_salt', 'pv_hash', 'pv_vault', 'pv_custom_services',
  'pv_audit', 'pv_audit_plain', 'pv_format', 'pv_failed_attempts',
  'pv_lockout_until', 'pv_theme'
];

localStorage.setItem = function(key, value) {
  if (SENSITIVE_KEYS.includes(key) && IS_CAPACITOR && Preferences) {
    SecureStorage.setItem(key, value).catch(() => {});
  }
  _origLocalStorageSet(key, value);
};

localStorage.getItem = function(key) {
  if (SENSITIVE_KEYS.includes(key) && IS_CAPACITOR && Preferences) {
    // Synchronous fallback for localStorage API - data is pre-loaded at startup
    return _origLocalStorageGet(key);
  }
  return _origLocalStorageGet(key);
};

localStorage.removeItem = function(key) {
  if (SENSITIVE_KEYS.includes(key) && IS_CAPACITOR && Preferences) {
    SecureStorage.removeItem(key).catch(() => {});
  }
  _origLocalStorageRemove(key);
};

/**
 * Pre-load sensitive data from Preferences into localStorage at startup.
 * Must be called and awaited BEFORE checking vault state.
 */
async function preLoadSecureData() {
  if (!IS_CAPACITOR || !Preferences) return;
  for (const key of SENSITIVE_KEYS) {
    try {
      const value = await SecureStorage.getItem(key);
      if (value !== null) {
        _origLocalStorageSet(key, value);
      }
    } catch(e) {}
  }
}

/**
 * Sync data back to Preferences (called before app close).
 */
async function syncToSecureStorage() {
  if (!IS_CAPACITOR || !Preferences) return;
  for (const key of SENSITIVE_KEYS) {
    try {
      const value = _origLocalStorageGet(key);
      if (value !== null) {
        await SecureStorage.setItem(key, value);
      } else {
        await SecureStorage.removeItem(key);
      }
    } catch(e) {}
  }
}

export {
  IS_CAPACITOR, Preferences, SecureStorage,
  SENSITIVE_KEYS,
  _origLocalStorageSet, _origLocalStorageGet, _origLocalStorageRemove,
  preLoadSecureData, syncToSecureStorage
};
