/**
 * autofill.js — Autofill service wrapper for PassVault
 *
 * Provides a web-layer interface to the native AutofillPlugin.
 * On web (non-Capacitor), all methods gracefully fail.
 */

const IS_CAPACITOR = !!(window.Capacitor && Capacitor.Plugins);

let _autofillPluginInstance = null;
function getAutofillPlugin() {
  if (!IS_CAPACITOR) return null;
  if (_autofillPluginInstance) return _autofillPluginInstance;
  try {
    if (Capacitor.Plugins.Autofill) {
      _autofillPluginInstance = Capacitor.Plugins.Autofill;
      return _autofillPluginInstance;
    }
    _autofillPluginInstance = Capacitor.registerPlugin('Autofill');
    return _autofillPluginInstance;
  } catch(e) {
    console.warn('[Autofill] Plugin not available:', e);
    return null;
  }
}

/**
 * Check if PassVault is set as the autofill provider on this device.
 * @returns {Promise<boolean>}
 */
async function isAutofillEnabled() {
  const plugin = getAutofillPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.isEnabled();
    return result.enabled === true;
  } catch(e) {
    return false;
  }
}

/**
 * Save a credential for autofill.
 * @param {string} serviceId
 * @param {string} username
 * @param {string} password
 * @param {string[]} urls — Array of URLs associated with this service
 * @returns {Promise<{success: boolean}>}
 */
async function saveAutofillCredential(serviceId, username, password, urls) {
  const plugin = getAutofillPlugin();
  if (!plugin) return { success: false };
  try {
    const result = await plugin.saveCredential({
      serviceId,
      username,
      password,
      urls: urls || []
    });
    return result;
  } catch(e) {
    console.warn('[Autofill] saveCredential failed:', e);
    return { success: false };
  }
}

/**
 * Remove a credential from autofill store.
 * @param {string} serviceId
 * @param {string} username
 * @returns {Promise<{success: boolean}>}
 */
async function removeAutofillCredential(serviceId, username) {
  const plugin = getAutofillPlugin();
  if (!plugin) return { success: false };
  try {
    const result = await plugin.removeCredential({ serviceId, username });
    return result;
  } catch(e) {
    return { success: false };
  }
}

/**
 * Sync all current vault credentials to the autofill store.
 * @param {Array} credentials — Array of {serviceId, username, password, urls}
 * @returns {Promise<{success: boolean}>}
 */
async function syncAllAutofillCredentials(credentials) {
  const plugin = getAutofillPlugin();
  if (!plugin) return { success: false };
  try {
    const result = await plugin.syncAllCredentials({ credentials });
    return result;
  } catch(e) {
    return { success: false };
  }
}

/**
 * Clear all stored autofill credentials.
 * @returns {Promise<{success: boolean}>}
 */
async function clearAutofillCredentials() {
  const plugin = getAutofillPlugin();
  if (!plugin) return { success: false };
  try {
    const result = await plugin.clearAllCredentials();
    return result;
  } catch(e) {
    return { success: false };
  }
}

/**
 * Open Android autofill settings so the user can enable PassVault.
 */
async function openAutofillSettings() {
  const plugin = getAutofillPlugin();
  if (!plugin) {
    showToast('Автозаполнение доступно только на Android');
    return;
  }
  try {
    await plugin.openAutofillSettings();
  } catch(e) {
    console.warn('[Autofill] openSettings failed:', e);
  }
}

/**
 * Initialize autofill UI — show/hide autofill toggle in settings.
 */
async function initAutofillUI() {
  const enabled = await isAutofillEnabled();
  const autofillItem = document.getElementById('autofill-settings-item');
  if (autofillItem) {
    if (IS_CAPACITOR) {
      autofillItem.style.display = '';
    } else {
      autofillItem.style.display = 'none';
    }
  }
  const autofillToggle = document.getElementById('autofill-toggle');
  if (autofillToggle) {
    if (enabled) {
      autofillToggle.classList.add('on');
    } else {
      autofillToggle.classList.remove('on');
    }
  }
  const autofillStatus = document.getElementById('autofill-status-text');
  if (autofillStatus) {
    autofillStatus.textContent = enabled ? 'Включено' : 'Нажмите для настройки';
  }
}

/**
 * Toggle autofill on/off.
 */
async function toggleAutofill() {
  const enabled = await isAutofillEnabled();
  if (!enabled) {
    await openAutofillSettings();
  } else {
    // Already enabled — offer to disable or clear
    if (window.showConfirm) {
      window.showConfirm(
        'Автозаполнение',
        'Отключить автозаполнение PassVault? Сохранённые данные для автозаполнения будут удалены.',
        'Отключить',
        async () => {
          await clearAutofillCredentials();
          await initAutofillUI();
          if (window.showToast) window.showToast('Автозаполнение отключено');
        }
      );
    }
  }
}

// Make globally available
window.isAutofillEnabled = isAutofillEnabled;
window.saveAutofillCredential = saveAutofillCredential;
window.removeAutofillCredential = removeAutofillCredential;
window.syncAllAutofillCredentials = syncAllAutofillCredentials;
window.clearAutofillCredentials = clearAutofillCredentials;
window.openAutofillSettings = openAutofillSettings;
window.initAutofillUI = initAutofillUI;
window.toggleAutofill = toggleAutofill;

export {
  isAutofillEnabled, saveAutofillCredential, removeAutofillCredential,
  syncAllAutofillCredentials, clearAutofillCredentials,
  openAutofillSettings, initAutofillUI, toggleAutofill
};
