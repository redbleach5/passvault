/**
 * dropbox.js — Dropbox Sync for PassVault
 *
 * Uses the Dropbox API v2 for cloud sync.
 * All data is AES-256-GCM encrypted before upload —
 * Dropbox never sees plaintext.
 *
 * Token-based approach (v1):
 * - User provides a Dropbox access token
 *   (obtained via Dropbox App Console or OAuth flow)
 * - The token is stored locally in localStorage
 * - We provide instructions on how to obtain a token
 *
 * API Reference:
 * - Upload:   POST https://content.dropboxapi.com/2/files/upload
 * - Download: POST https://content.dropboxapi.com/2/files/download
 * - Metadata: POST https://api.dropboxapi.com/2/files/get_metadata
 * - Auth:     POST https://api.dropboxapi.com/2/check/user
 */

import { showToast, openModal, closeModal } from './ui.js';

const DROPBOX_CONFIG_KEY = 'pv_dropbox_config';
const DROPBOX_FILE_PATH = '/passvault-sync.vault';
const DROPBOX_API_CONTENT = 'https://content.dropboxapi.com/2/files';
const DROPBOX_API_RPC = 'https://api.dropboxapi.com/2';

// ===== Configuration =====

/**
 * Get stored Dropbox configuration.
 * @returns {{ accessToken: string } | null}
 */
function getDropboxConfig() {
  try {
    const raw = localStorage.getItem(DROPBOX_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch(e) {}
  return null;
}

/**
 * Save Dropbox configuration.
 * @param {{ accessToken: string }} config
 */
function saveDropboxConfig(config) {
  localStorage.setItem(DROPBOX_CONFIG_KEY, JSON.stringify(config));
}

/**
 * Remove Dropbox configuration.
 */
function removeDropboxConfig() {
  localStorage.removeItem(DROPBOX_CONFIG_KEY);
}

/**
 * Check if Dropbox is configured.
 * @returns {boolean}
 */
function isDropboxConfigured() {
  const config = getDropboxConfig();
  return !!(config && config.accessToken);
}

// ===== API Helpers =====

/**
 * Build Authorization header for Dropbox API.
 * @param {string} accessToken
 * @returns {{ Authorization: string }}
 */
function dropboxAuthHeaders(accessToken) {
  return { 'Authorization': 'Bearer ' + accessToken };
}

/**
 * Build Dropbox-API-Arg header value.
 * @param {object} args
 * @returns {{ 'Dropbox-API-Arg': string }}
 */
function dropboxApiArg(args) {
  return { 'Dropbox-API-Arg': JSON.stringify(args) };
}

// ===== Public Sync Functions =====

/**
 * Test Dropbox connection by calling the check/user endpoint.
 * @param {string} [accessToken] — Optional; uses stored config if omitted
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function testDropboxConnection(accessToken) {
  const token = accessToken || (getDropboxConfig() || {}).accessToken;
  if (!token) {
    return { success: false, error: 'Укажите токен доступа Dropbox' };
  }

  try {
    const response = await fetch(DROPBOX_API_RPC + '/check/user', {
      method: 'POST',
      headers: {
        ...dropboxAuthHeaders(token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: 'ping' })
    });

    if (response.status === 401) {
      return { success: false, error: 'Токен недействителен или истёк. Получите новый токен доступа.' };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: 'Ошибка подключения: ' + (err.error_summary || 'HTTP ' + response.status) };
    }

    return { success: true };
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

/**
 * Upload encrypted vault data to Dropbox.
 * Overwrites the file if it already exists (mode: 'overwrite').
 * @param {string} [accessToken] — Optional; uses stored config if omitted
 * @param {string} data — Encrypted vault data string
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function dropboxUpload(accessToken, data) {
  const token = accessToken || (getDropboxConfig() || {}).accessToken;
  if (!token) {
    return { success: false, error: 'Токен Dropbox не настроен' };
  }
  if (!data) {
    return { success: false, error: 'Нет данных для загрузки' };
  }

  try {
    const response = await fetch(DROPBOX_API_CONTENT + '/upload', {
      method: 'POST',
      headers: {
        ...dropboxAuthHeaders(token),
        ...dropboxApiArg({
          path: DROPBOX_FILE_PATH,
          mode: 'overwrite',
          autorename: false,
          mute: true
        }),
        'Content-Type': 'application/octet-stream'
      },
      body: data
    });

    if (response.status === 401) {
      return { success: false, error: 'Токен недействителен или истёк. Получите новый токен.' };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: 'Ошибка загрузки: ' + (err.error_summary || 'HTTP ' + response.status) };
    }

    return { success: true };
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

/**
 * Download encrypted vault data from Dropbox.
 * @param {string} [accessToken] — Optional; uses stored config if omitted
 * @returns {Promise<{success: boolean, data?: string, modifiedTime?: string, error?: string}>}
 */
async function dropboxDownload(accessToken) {
  const token = accessToken || (getDropboxConfig() || {}).accessToken;
  if (!token) {
    return { success: false, error: 'Токен Dropbox не настроен' };
  }

  try {
    const response = await fetch(DROPBOX_API_CONTENT + '/download', {
      method: 'POST',
      headers: {
        ...dropboxAuthHeaders(token),
        ...dropboxApiArg({ path: DROPBOX_FILE_PATH })
      }
    });

    if (response.status === 401) {
      return { success: false, error: 'Токен недействителен или истёк. Получите новый токен.' };
    }
    if (response.status === 409) {
      // Path not found
      return { success: false, error: 'Файл не найден в Dropbox' };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: 'Ошибка скачивания: ' + (err.error_summary || 'HTTP ' + response.status) };
    }

    const data = await response.text();

    // Dropbox returns metadata in the 'Dropbox-API-Result' response header
    let modifiedTime = null;
    try {
      const apiResult = response.headers.get('Dropbox-API-Result');
      if (apiResult) {
        const meta = JSON.parse(apiResult);
        modifiedTime = meta.server_modified || null;
      }
    } catch(e) {}

    return { success: true, data, modifiedTime };
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

/**
 * Get file metadata from Dropbox (used to check if file exists and get modified time).
 * @param {string} [accessToken] — Optional; uses stored config if omitted
 * @returns {Promise<{success: boolean, exists?: boolean, modifiedTime?: string, error?: string}>}
 */
async function dropboxGetMetadata(accessToken) {
  const token = accessToken || (getDropboxConfig() || {}).accessToken;
  if (!token) {
    return { success: false, error: 'Токен Dropbox не настроен' };
  }

  try {
    const response = await fetch(DROPBOX_API_RPC + '/files/get_metadata', {
      method: 'POST',
      headers: {
        ...dropboxAuthHeaders(token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: DROPBOX_FILE_PATH })
    });

    if (response.status === 401) {
      return { success: false, error: 'Токен недействителен или истёк.' };
    }
    if (response.status === 409) {
      // Path not found — file doesn't exist yet
      return { success: true, exists: false };
    }
    if (!response.ok) {
      return { success: false, error: 'Ошибка получения метаданных: HTTP ' + response.status };
    }

    const meta = await response.json();
    return { success: true, exists: true, modifiedTime: meta.server_modified || null };
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

// ===== Dropbox Settings UI =====

/**
 * Open the Dropbox configuration modal.
 */
function openDropboxSettings() {
  const config = getDropboxConfig() || {};
  const tokenInput = document.getElementById('dropbox-token-input');
  if (tokenInput && config.accessToken) {
    tokenInput.value = config.accessToken;
  }
  openModal('dropbox-settings-modal');
}

/**
 * Save Dropbox settings from the modal form.
 */
async function saveDropboxSettings() {
  const tokenInput = document.getElementById('dropbox-token-input');
  const accessToken = tokenInput ? tokenInput.value.trim() : '';

  if (!accessToken) {
    showToast('Введите токен доступа Dropbox');
    return;
  }

  // Test connection before saving
  showToast('Проверка подключения...');
  const result = await testDropboxConnection(accessToken);

  if (!result.success) {
    showToast(result.error);
    return;
  }

  saveDropboxConfig({ accessToken });
  showToast('Dropbox настроен успешно!');
  closeModal('dropbox-settings-modal');
}

/**
 * Remove Dropbox configuration.
 */
function disconnectDropbox() {
  removeDropboxConfig();
  showToast('Dropbox отключён');
}

// Make globally available
window.getDropboxConfig = getDropboxConfig;
window.saveDropboxConfig = saveDropboxConfig;
window.removeDropboxConfig = removeDropboxConfig;
window.isDropboxConfigured = isDropboxConfigured;
window.testDropboxConnection = testDropboxConnection;
window.dropboxUpload = dropboxUpload;
window.dropboxDownload = dropboxDownload;
window.dropboxGetMetadata = dropboxGetMetadata;
window.openDropboxSettings = openDropboxSettings;
window.saveDropboxSettings = saveDropboxSettings;
window.disconnectDropbox = disconnectDropbox;

export {
  getDropboxConfig, saveDropboxConfig, removeDropboxConfig,
  isDropboxConfigured,
  testDropboxConnection,
  dropboxUpload, dropboxDownload, dropboxGetMetadata,
  openDropboxSettings, saveDropboxSettings, disconnectDropbox
};
