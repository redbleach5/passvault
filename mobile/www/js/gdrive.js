/**
 * gdrive.js — Google Drive Sync for PassVault
 *
 * Uses the Google Drive REST API v3 for cloud sync.
 * All data is AES-256-GCM encrypted before upload —
 * Google never sees plaintext.
 *
 * Token-based approach (v1):
 * - User provides an OAuth2 access token (obtained via
 *   Google OAuth Playground or a custom OAuth flow)
 * - The token is stored locally in localStorage
 * - We provide instructions on how to obtain a token
 *
 * API Reference:
 * - Search: GET  https://www.googleapis.com/drive/v3/files?q=...
 * - Upload: PATCH https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=media
 * - Create: POST  https://www.googleapis.com/drive/v3/files
 * - Create+upload: POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart
 * - Download: GET  https://www.googleapis.com/drive/v3/files/{id}?alt=media
 */

import { showToast, openModal, closeModal } from './ui.js';

const GDRIVE_CONFIG_KEY = 'pv_gdrive_config';
const GDRIVE_FILE_NAME = 'passvault-sync.vault';
const GDRIVE_BASE_URL = 'https://www.googleapis.com/drive/v3/files';
const GDRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

// ===== Configuration =====

/**
 * Get stored Google Drive configuration.
 * @returns {{ accessToken: string } | null}
 */
function getGDriveConfig() {
  try {
    const raw = localStorage.getItem(GDRIVE_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch(e) {}
  return null;
}

/**
 * Save Google Drive configuration.
 * @param {{ accessToken: string }} config
 */
function saveGDriveConfig(config) {
  localStorage.setItem(GDRIVE_CONFIG_KEY, JSON.stringify(config));
}

/**
 * Remove Google Drive configuration.
 */
function removeGDriveConfig() {
  localStorage.removeItem(GDRIVE_CONFIG_KEY);
}

/**
 * Check if Google Drive is configured.
 * @returns {boolean}
 */
function isGDriveConfigured() {
  const config = getGDriveConfig();
  return !!(config && config.accessToken);
}

// ===== API Helpers =====

/**
 * Build Authorization header for Google Drive API.
 * @param {string} accessToken
 * @returns {{ Authorization: string }}
 */
function gdriveAuthHeaders(accessToken) {
  return { 'Authorization': 'Bearer ' + accessToken };
}

/**
 * Search for the sync file by name in Google Drive.
 * @param {string} accessToken
 * @returns {Promise<{success: boolean, fileId?: string, error?: string}>}
 */
async function gdriveFindFile(accessToken) {
  try {
    const query = encodeURIComponent("name='" + GDRIVE_FILE_NAME + "' and trashed=false");
    const url = GDRIVE_BASE_URL + '?q=' + query + '&spaces=drive&fields=files(id,name,modifiedTime)';

    const response = await fetch(url, {
      method: 'GET',
      headers: gdriveAuthHeaders(accessToken)
    });

    if (response.status === 401) {
      return { success: false, error: 'Токен недействителен или истёк. Получите новый токен.' };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: 'Ошибка поиска файла: ' + (err.error?.message || 'HTTP ' + response.status) };
    }

    const data = await response.json();
    if (data.files && data.files.length > 0) {
      return { success: true, fileId: data.files[0].id, modifiedTime: data.files[0].modifiedTime };
    }
    return { success: true, fileId: null };
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

/**
 * Create a new file in Google Drive and upload content.
 * @param {string} accessToken
 * @param {string} data — Encrypted vault data
 * @returns {Promise<{success: boolean, fileId?: string, error?: string}>}
 */
async function gdriveCreateFile(accessToken, data) {
  try {
    // Multipart upload: metadata + content
    const metadata = {
      name: GDRIVE_FILE_NAME,
      mimeType: 'application/octet-stream'
    };

    const boundary = 'passvault_boundary_' + Date.now();
    const body =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n' +
      data + '\r\n' +
      '--' + boundary + '--';

    const url = GDRIVE_UPLOAD_URL + '?uploadType=multipart';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...gdriveAuthHeaders(accessToken),
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body: body
    });

    if (response.status === 401) {
      return { success: false, error: 'Токен недействителен или истёк. Получите новый токен.' };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: 'Ошибка создания файла: ' + (err.error?.message || 'HTTP ' + response.status) };
    }

    const result = await response.json();
    return { success: true, fileId: result.id };
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

/**
 * Update an existing file's content in Google Drive.
 * @param {string} accessToken
 * @param {string} fileId
 * @param {string} data — Encrypted vault data
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function gdriveUpdateFile(accessToken, fileId, data) {
  try {
    const url = GDRIVE_UPLOAD_URL + '/' + fileId + '?uploadType=media';

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...gdriveAuthHeaders(accessToken),
        'Content-Type': 'application/octet-stream'
      },
      body: data
    });

    if (response.status === 401) {
      return { success: false, error: 'Токен недействителен или истёк. Получите новый токен.' };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: 'Ошибка обновления файла: ' + (err.error?.message || 'HTTP ' + response.status) };
    }

    return { success: true };
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

// ===== Public Sync Functions =====

/**
 * Test Google Drive connection by listing files with the provided token.
 * @param {string} [accessToken] — Optional; uses stored config if omitted
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function testGDriveConnection(accessToken) {
  const token = accessToken || (getGDriveConfig() || {}).accessToken;
  if (!token) {
    return { success: false, error: 'Укажите токен доступа Google Drive' };
  }

  try {
    // Minimal request: list files with pageSize=1 to verify token
    const url = GDRIVE_BASE_URL + '?pageSize=1&fields=files(id)';
    const response = await fetch(url, {
      method: 'GET',
      headers: gdriveAuthHeaders(token)
    });

    if (response.status === 401) {
      return { success: false, error: 'Токен недействителен или истёк. Получите новый токен доступа.' };
    }
    if (response.status === 403) {
      return { success: false, error: 'Нет доступа к Google Drive. Проверьте разрешения токена.' };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: 'Ошибка подключения: ' + (err.error?.message || 'HTTP ' + response.status) };
    }

    return { success: true };
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

/**
 * Upload encrypted vault data to Google Drive.
 * If the file already exists, updates it; otherwise creates a new one.
 * @param {string} [accessToken] — Optional; uses stored config if omitted
 * @param {string} data — Encrypted vault data string
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function gdriveUpload(accessToken, data) {
  const token = accessToken || (getGDriveConfig() || {}).accessToken;
  if (!token) {
    return { success: false, error: 'Токен Google Drive не настроен' };
  }
  if (!data) {
    return { success: false, error: 'Нет данных для загрузки' };
  }

  // Step 1: Check if file already exists
  const findResult = await gdriveFindFile(token);
  if (!findResult.success) {
    return { success: false, error: findResult.error };
  }

  // Step 2: Create or update
  if (findResult.fileId) {
    // File exists — update content
    const updateResult = await gdriveUpdateFile(token, findResult.fileId, data);
    if (updateResult.success) {
      return { success: true };
    }
    return { success: false, error: updateResult.error };
  } else {
    // File doesn't exist — create with content
    const createResult = await gdriveCreateFile(token, data);
    if (createResult.success) {
      return { success: true };
    }
    return { success: false, error: createResult.error };
  }
}

/**
 * Download encrypted vault data from Google Drive.
 * @param {string} [accessToken] — Optional; uses stored config if omitted
 * @returns {Promise<{success: boolean, data?: string, modifiedTime?: string, error?: string}>}
 */
async function gdriveDownload(accessToken) {
  const token = accessToken || (getGDriveConfig() || {}).accessToken;
  if (!token) {
    return { success: false, error: 'Токен Google Drive не настроен' };
  }

  // Step 1: Find the file
  const findResult = await gdriveFindFile(token);
  if (!findResult.success) {
    return { success: false, error: findResult.error };
  }
  if (!findResult.fileId) {
    return { success: false, error: 'Файл не найден на Google Drive' };
  }

  // Step 2: Download content
  try {
    const url = GDRIVE_BASE_URL + '/' + findResult.fileId + '?alt=media';
    const response = await fetch(url, {
      method: 'GET',
      headers: gdriveAuthHeaders(token)
    });

    if (response.status === 401) {
      return { success: false, error: 'Токен недействителен или истёк. Получите новый токен.' };
    }
    if (!response.ok) {
      return { success: false, error: 'Ошибка скачивания файла: HTTP ' + response.status };
    }

    const data = await response.text();
    return { success: true, data, modifiedTime: findResult.modifiedTime };
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

// ===== GDrive Settings UI =====

/**
 * Open the Google Drive configuration modal.
 */
function openGDriveSettings() {
  const config = getGDriveConfig() || {};
  const tokenInput = document.getElementById('gdrive-token-input');
  if (tokenInput && config.accessToken) {
    tokenInput.value = config.accessToken;
  }
  openModal('gdrive-settings-modal');
}

/**
 * Save Google Drive settings from the modal form.
 */
async function saveGDriveSettings() {
  const tokenInput = document.getElementById('gdrive-token-input');
  const accessToken = tokenInput ? tokenInput.value.trim() : '';

  if (!accessToken) {
    showToast('Введите токен доступа Google Drive');
    return;
  }

  // Test connection before saving
  showToast('Проверка подключения...');
  const result = await testGDriveConnection(accessToken);

  if (!result.success) {
    showToast(result.error);
    return;
  }

  saveGDriveConfig({ accessToken });
  showToast('Google Drive настроен успешно!');
  closeModal('gdrive-settings-modal');
}

/**
 * Remove Google Drive configuration.
 */
function disconnectGDrive() {
  removeGDriveConfig();
  showToast('Google Drive отключён');
}

// Make globally available
window.getGDriveConfig = getGDriveConfig;
window.saveGDriveConfig = saveGDriveConfig;
window.removeGDriveConfig = removeGDriveConfig;
window.isGDriveConfigured = isGDriveConfigured;
window.testGDriveConnection = testGDriveConnection;
window.gdriveUpload = gdriveUpload;
window.gdriveDownload = gdriveDownload;
window.openGDriveSettings = openGDriveSettings;
window.saveGDriveSettings = saveGDriveSettings;
window.disconnectGDrive = disconnectGDrive;

export {
  getGDriveConfig, saveGDriveConfig, removeGDriveConfig,
  isGDriveConfigured,
  testGDriveConnection,
  gdriveUpload, gdriveDownload,
  openGDriveSettings, saveGDriveSettings, disconnectGDrive
};
