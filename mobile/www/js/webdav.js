/**
 * webdav.js — WebDAV client for PassVault cloud sync
 *
 * Supports any WebDAV-compatible service:
 * - Яндекс.Диск (https://webdav.yandex.ru)
 * - Nextcloud (https://your-server/remote.php/dav/files/USER/)
 * - ownCloud (https://your-server/remote.php/dav/files/USER/)
 * - Box, Koofr, Synology, etc.
 *
 * Uses fetch() with Basic auth. All data is AES-256-GCM encrypted
 * before upload — the WebDAV server never sees plaintext.
 */

const WEBDAV_FILE_NAME = 'passvault-sync.vault';
const WEBDAV_CONFIG_KEY = 'pv_webdav_config';

// Popular WebDAV service presets
const WEBDAV_PRESETS = [
  { id: 'yandex', name: 'Яндекс.Диск', url: 'https://webdav.yandex.ru/', icon: '📬' },
  { id: 'nextcloud', name: 'Nextcloud', url: '', icon: '☁️', placeholder: 'https://your-server/remote.php/dav/files/USER/' },
  { id: 'owncloud', name: 'ownCloud', url: '', icon: '📁', placeholder: 'https://your-server/remote.php/dav/files/USER/' },
  { id: 'koofr', name: 'Koofr', url: 'https://app.koofr.net/dav/Koofr/', icon: '💾' },
  { id: 'custom', name: 'Другой WebDAV', url: '', icon: '🔗', placeholder: 'https://your-server/dav/' }
];

/**
 * Get stored WebDAV configuration.
 */
function getWebDAVConfig() {
  try {
    const raw = localStorage.getItem(WEBDAV_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch(e) {}
  return null;
}

/**
 * Save WebDAV configuration.
 */
function saveWebDAVConfig(config) {
  localStorage.setItem(WEBDAV_CONFIG_KEY, JSON.stringify(config));
}

/**
 * Remove WebDAV configuration.
 */
function removeWebDAVConfig() {
  localStorage.removeItem(WEBDAV_CONFIG_KEY);
}

/**
 * Build Basic Authorization header value.
 */
function buildAuthHeader(username, password) {
  return 'Basic ' + btoa(username + ':' + password);
}

/**
 * Ensure URL ends with a slash for WebDAV operations.
 */
function normalizeUrl(url) {
  if (!url) return '';
  return url.endsWith('/') ? url : url + '/';
}

/**
 * Test WebDAV connection by performing a PROPFIND request.
 * @param {string} url — WebDAV server URL
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function testWebDAVConnection(url, username, password) {
  if (!url || !username || !password) {
    return { success: false, error: 'Заполните все поля' };
  }

  const normalizedUrl = normalizeUrl(url);

  try {
    const response = await fetch(normalizedUrl, {
      method: 'PROPFIND',
      headers: {
        'Authorization': buildAuthHeader(username, password),
        'Depth': '0',
        'Content-Type': 'application/xml'
      },
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop></prop></propfind>'
    });

    if (response.status === 207 || response.status === 200) {
      return { success: true };
    } else if (response.status === 401) {
      return { success: false, error: 'Неверное имя пользователя или пароль' };
    } else if (response.status === 404) {
      return { success: false, error: 'Папка не найдена. Проверьте URL.' };
    } else if (response.status === 405) {
      // Some servers return 405 for PROPFIND on root, but connection works
      return { success: true };
    } else {
      return { success: false, error: 'Ошибка: HTTP ' + response.status };
    }
  } catch(e) {
    return { success: false, error: 'Не удалось подключиться: ' + (e.message || e) };
  }
}

/**
 * Upload encrypted vault data to WebDAV.
 * @param {string} url — WebDAV server URL
 * @param {string} username
 * @param {string} password
 * @param {string} data — Encrypted JSON string to upload
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function webdavUpload(url, username, password, data) {
  const normalizedUrl = normalizeUrl(url);
  const fileUrl = normalizedUrl + WEBDAV_FILE_NAME;

  try {
    const response = await fetch(fileUrl, {
      method: 'PUT',
      headers: {
        'Authorization': buildAuthHeader(username, password),
        'Content-Type': 'application/octet-stream'
      },
      body: data
    });

    if (response.status === 200 || response.status === 201 || response.status === 204) {
      return { success: true };
    } else if (response.status === 401) {
      return { success: false, error: 'Ошибка авторизации' };
    } else if (response.status === 409) {
      // Try to create parent directory first
      const mkcolResponse = await fetch(normalizedUrl, {
        method: 'MKCOL',
        headers: {
          'Authorization': buildAuthHeader(username, password)
        }
      });
      // Retry upload
      if (mkcolResponse.status === 201 || mkcolResponse.status === 405) {
        const retryResponse = await fetch(fileUrl, {
          method: 'PUT',
          headers: {
            'Authorization': buildAuthHeader(username, password),
            'Content-Type': 'application/octet-stream'
          },
          body: data
        });
        if (retryResponse.status === 200 || retryResponse.status === 201 || retryResponse.status === 204) {
          return { success: true };
        }
      }
      return { success: false, error: 'Не удалось создать папку на сервере' };
    } else {
      return { success: false, error: 'Ошибка загрузки: HTTP ' + response.status };
    }
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

/**
 * Download encrypted vault data from WebDAV.
 * @param {string} url — WebDAV server URL
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{success: boolean, data?: string, error?: string}>}
 */
async function webdavDownload(url, username, password) {
  const normalizedUrl = normalizeUrl(url);
  const fileUrl = normalizedUrl + WEBDAV_FILE_NAME;

  try {
    const response = await fetch(fileUrl, {
      method: 'GET',
      headers: {
        'Authorization': buildAuthHeader(username, password)
      }
    });

    if (response.status === 200) {
      const data = await response.text();
      return { success: true, data };
    } else if (response.status === 401) {
      return { success: false, error: 'Ошибка авторизации' };
    } else if (response.status === 404) {
      return { success: false, error: 'Файл не найден на сервере' };
    } else {
      return { success: false, error: 'Ошибка загрузки: HTTP ' + response.status };
    }
  } catch(e) {
    return { success: false, error: 'Ошибка сети: ' + (e.message || e) };
  }
}

/**
 * Check if WebDAV is configured.
 */
function isWebDAVConfigured() {
  const config = getWebDAVConfig();
  return !!(config && config.url && config.username && config.password);
}

/**
 * Get the cloud provider type (webdav or firebase).
 */
function getCloudProvider() {
  return localStorage.getItem('pv_cloud_provider') || 'webdav';
}

/**
 * Set the cloud provider type.
 */
function setCloudProvider(provider) {
  localStorage.setItem('pv_cloud_provider', provider);
}

// Make globally available
window.testWebDAVConnection = testWebDAVConnection;
window.webdavUpload = webdavUpload;
window.webdavDownload = webdavDownload;
window.getWebDAVConfig = getWebDAVConfig;
window.saveWebDAVConfig = saveWebDAVConfig;
window.removeWebDAVConfig = removeWebDAVConfig;
window.isWebDAVConfigured = isWebDAVConfigured;
window.getCloudProvider = getCloudProvider;
window.setCloudProvider = setCloudProvider;
window.WEBDAV_PRESETS = WEBDAV_PRESETS;

export {
  testWebDAVConnection, webdavUpload, webdavDownload,
  getWebDAVConfig, saveWebDAVConfig, removeWebDAVConfig,
  isWebDAVConfigured, getCloudProvider, setCloudProvider,
  WEBDAV_PRESETS
};
