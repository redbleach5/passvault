/**
 * biometric.js — Biometric authentication wrapper for PassVault
 *
 * Provides a web-layer interface to the native BiometricPlugin.
 * On web (non-Capacitor), all methods gracefully fail.
 */

const IS_CAPACITOR = !!(window.Capacitor && Capacitor.Plugins);

/**
 * Get the Biometric plugin instance (Capacitor native only).
 * In Capacitor 8, custom plugins must be registered on the JS side
 * via Capacitor.registerPlugin() before they can be used.
 */
let _biometricPluginInstance = null;
function getBiometricPlugin() {
  if (!IS_CAPACITOR) return null;
  if (_biometricPluginInstance) return _biometricPluginInstance;
  try {
    // Try direct access first (works if plugin auto-registered)
    if (Capacitor.Plugins.Biometric) {
      _biometricPluginInstance = Capacitor.Plugins.Biometric;
      return _biometricPluginInstance;
    }
    // Custom plugins need explicit JS-side registration
    _biometricPluginInstance = Capacitor.registerPlugin('Biometric');
    return _biometricPluginInstance;
  } catch(e) {
    console.warn('[Biometric] Plugin not available:', e);
    return null;
  }
}

/**
 * Check if biometric authentication is available on this device.
 * @returns {Promise<{available: boolean, reason: string}>}
 */
async function isBiometricAvailable() {
  const plugin = getBiometricPlugin();
  if (!plugin) {
    return { available: false, reason: 'Not a Capacitor app' };
  }
  try {
    const result = await plugin.isAvailable();
    return { available: result.available, reason: result.reason || '' };
  } catch(e) {
    return { available: false, reason: e.message || 'Unknown error' };
  }
}

/**
 * Check if biometric unlock is enabled for this vault.
 * @returns {Promise<boolean>}
 */
async function isBiometricEnabled() {
  const plugin = getBiometricPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.isEnabled();
    return result.enabled === true;
  } catch(e) {
    return false;
  }
}

/**
 * Enable biometric unlock — stores the master password in secure storage.
 * Stores the master password in EncryptedSharedPreferences after
 * the user has confirmed their identity by entering the master password.
 * @param {string} password — The master password to store
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function enableBiometricUnlock(password) {
  const plugin = getBiometricPlugin();
  if (!plugin) {
    return { success: false, error: 'Биометрия недоступна на этом устройстве' };
  }

  // Verify that biometric is available
  const avail = await isBiometricAvailable();
  if (!avail.available) {
    return { success: false, error: 'Биометрия недоступна: ' + avail.reason };
  }

  // Store the password directly — the user has already verified their identity
  // by entering the master password in the setup dialog.
  // No need for a separate biometric confirmation prompt.
  try {
    const result = await plugin.enable({ password });
    if (result.success) {
      localStorage.setItem('pv_biometric_enabled', '1');
      return { success: true };
    }
    return { success: false, error: 'Не удалось сохранить' };
  } catch(e) {
    return { success: false, error: 'Ошибка сохранения: ' + (e.message || e) };
  }
}

/**
 * Disable biometric unlock — removes stored credentials.
 * @returns {Promise<{success: boolean}>}
 */
async function disableBiometricUnlock() {
  const plugin = getBiometricPlugin();
  if (!plugin) {
    localStorage.removeItem('pv_biometric_enabled');
    return { success: true };
  }
  try {
    await plugin.disable();
    localStorage.removeItem('pv_biometric_enabled');
    return { success: true };
  } catch(e) {
    localStorage.removeItem('pv_biometric_enabled');
    return { success: false };
  }
}

/**
 * Authenticate with biometric and retrieve the stored master password.
 * @returns {Promise<{success: boolean, password?: string, error?: string}>}
 */
async function biometricUnlock() {
  const plugin = getBiometricPlugin();
  if (!plugin) {
    return { success: false, error: 'Биометрия недоступна' };
  }

  try {
    const result = await plugin.authenticateAndRetrieve({ reason: 'Разблокируйте PassVault' });
    if (result.success && result.password) {
      return { success: true, password: result.password };
    }
    return { success: false, error: result.error || 'Аутентификация не пройдена' };
  } catch(e) {
    return { success: false, error: 'Ошибка: ' + (e.message || e) };
  }
}

/**
 * Initialize biometric UI — show/hide fingerprint button on unlock screen,
 * show/hide biometric toggle in settings.
 * Should be called on app init after determining if vault exists.
 */
async function initBiometricUI() {
  const avail = await isBiometricAvailable();
  const enabled = await isBiometricEnabled();

  // Show/hide fingerprint button on unlock screen
  const bioUnlockBtn = document.getElementById('biometric-unlock-btn');
  if (bioUnlockBtn) {
    if (avail.available && enabled) {
      bioUnlockBtn.style.display = '';
    } else {
      bioUnlockBtn.style.display = 'none';
    }
  }

  // Show/hide biometric toggle in settings
  const bioSettingsItem = document.getElementById('biometric-settings-item');
  if (bioSettingsItem) {
    if (avail.available) {
      bioSettingsItem.style.display = '';
    } else {
      bioSettingsItem.style.display = 'none';
    }
  }

  // Update toggle state
  const bioToggle = document.getElementById('biometric-toggle');
  if (bioToggle) {
    if (enabled) {
      bioToggle.classList.add('on');
    } else {
      bioToggle.classList.remove('on');
    }
  }

  // Update status text
  const bioStatusText = document.getElementById('biometric-status-text');
  if (bioStatusText) {
    bioStatusText.textContent = enabled ? 'Включено' : 'Отпечаток / Face / PIN';
  }

  // Update last backup text in settings
  const lastBackupText = document.getElementById('last-backup-text');
  if (lastBackupText && window.getLastBackupTimeText) {
    const lastTime = window.getLastBackupTimeText();
    if (lastTime) {
      lastBackupText.textContent = 'Последняя копия: ' + lastTime;
    }
  }
}

// Make globally available
window.isBiometricAvailable = isBiometricAvailable;
window.isBiometricEnabled = isBiometricEnabled;
window.enableBiometricUnlock = enableBiometricUnlock;
window.disableBiometricUnlock = disableBiometricUnlock;
window.biometricUnlock = biometricUnlock;
window.initBiometricUI = initBiometricUI;

export {
  isBiometricAvailable, isBiometricEnabled,
  enableBiometricUnlock, disableBiometricUnlock,
  biometricUnlock, initBiometricUI
};
