/**
 * updater.js — Auto-update checker for PassVault
 *
 * Checks GitHub Releases API for new versions.
 * If a newer version is found, shows a notification with a download link.
 *
 * On Android (Capacitor), the APK can be downloaded directly and installed
 * by tapping the notification (with INSTALL_PACKAGES permission or
 * standard Android install flow).
 *
 * Rate limits: GitHub API allows 60 unauthenticated requests/hour.
 * We check at most once per app launch + once every 24 hours.
 */

import { showToast, openModal, closeModal } from './ui.js';

const APP_VERSION = '6.2.0';
const GITHUB_REPO = 'redbleach5/passvault';
const GITHUB_API = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LAST_CHECK_KEY = 'pv_update_last_check';
const SKIP_VERSION_KEY = 'pv_update_skip_version';

const IS_CAPACITOR = !!(window.Capacitor && Capacitor.Plugins);

/**
 * Compare two semver version strings.
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
  var pa = a.replace(/^v/, '').split('.');
  var pb = b.replace(/^v/, '').split('.');
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var na = parseInt(pa[i] || '0', 10);
    var nb = parseInt(pb[i] || '0', 10);
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Check if an update is available.
 * Returns: { available: boolean, latestVersion: string, downloadUrl: string, releaseNotes: string, error: string }
 */
async function checkForUpdate() {
  // Check if we should skip this version
  var skipVersion = localStorage.getItem(SKIP_VERSION_KEY);

  try {
    var response = await fetch(GITHUB_API, {
      method: 'GET',
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      cache: 'no-cache'
    });

    if (!response.ok) {
      return { available: false, error: 'GitHub API error: ' + response.status };
    }

    var release = await response.json();
    var latestVersion = release.tag_name || '';
    var downloadUrl = '';
    var releaseNotes = release.body || '';

    // Find APK asset
    if (release.assets && release.assets.length > 0) {
      for (var i = 0; i < release.assets.length; i++) {
        if (release.assets[i].name && release.assets[i].name.endsWith('.apk')) {
          downloadUrl = release.assets[i].browser_download_url;
          break;
        }
      }
    }

    var comparison = compareVersions(latestVersion, APP_VERSION);

    if (comparison > 0) {
      // New version available
      if (skipVersion === latestVersion) {
        // User chose to skip this version
        return { available: false, latestVersion: latestVersion, skipped: true };
      }

      return {
        available: true,
        currentVersion: APP_VERSION,
        latestVersion: latestVersion,
        downloadUrl: downloadUrl,
        releaseNotes: releaseNotes
      };
    }

    return { available: false, currentVersion: APP_VERSION, latestVersion: latestVersion };

  } catch (e) {
    return { available: false, error: 'Network error: ' + (e.message || e) };
  }
}

/**
 * Perform the update check if enough time has passed.
 * Shows a modal if an update is available.
 */
async function autoCheckUpdate() {
  // Don't check too often
  var lastCheck = parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10);
  var now = Date.now();
  if (now - lastCheck < CHECK_INTERVAL_MS) {
    return; // Too soon
  }

  localStorage.setItem(LAST_CHECK_KEY, String(now));

  var result = await checkForUpdate();

  if (result.available && result.downloadUrl) {
    showUpdateNotification(result);
  }
}

/**
 * Show update notification modal.
 */
function showUpdateNotification(updateInfo) {
  var currentV = updateInfo.currentVersion || APP_VERSION;
  var latestV = updateInfo.latestVersion;
  var notes = updateInfo.releaseNotes || '';

  // Truncate release notes if too long
  var shortNotes = notes.length > 500 ? notes.substring(0, 500) + '...' : notes;
  // Convert markdown-style headers and bold to simple HTML
  shortNotes = shortNotes
    .replace(/### (.+)/g, '<strong>$1</strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  var body = document.getElementById('update-modal-body');
  if (!body) return;

  body.innerHTML = `
    <div style="text-align:center;padding:8px 0 16px">
      <div style="font-size:48px">🚀</div>
      <div style="font-size:18px;font-weight:700;margin-top:8px">Доступно обновление!</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:8px">
        Версия <strong style="color:var(--accent)">${currentV}</strong> → <strong style="color:var(--accent)">${latestV}</strong>
      </div>
    </div>
    ${shortNotes ? '<div style="background:var(--bg-tertiary);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;font-size:13px;color:var(--text-secondary);line-height:1.5;max-height:200px;overflow-y:auto">' + shortNotes + '</div>' : ''}
    <div style="display:flex;gap:8px;flex-direction:column">
      <button class="btn btn-primary" onclick="downloadUpdate()" style="width:100%">⬇️ Скачать и обновить</button>
      <button class="btn btn-outline" onclick="skipThisVersion('${latestV}')" style="width:100%">Пропустить это обновление</button>
      <button class="btn btn-ghost" onclick="closeModal('modal-update')" style="width:100%">Напомнить позже</button>
    </div>
  `;

  // Store download URL for the download handler
  window._updateDownloadUrl = updateInfo.downloadUrl;

  openModal('modal-update');
}

/**
 * Download the update APK.
 */
function downloadUpdate() {
  var url = window._updateDownloadUrl;
  if (!url) {
    showToast('Ошибка: ссылка на скачивание не найдена');
    return;
  }

  closeModal('modal-update');
  showToast('Скачивание обновления...');

  // On Android Capacitor, opening the APK URL in the browser will
  // trigger the download. After download, Android will prompt to install.
  // On newer Android (8+), REQUEST_INSTALL_PACKAGES permission is needed
  // for in-app install, so we use the browser approach.
  window.open(url, '_blank');
}

/**
 * Skip a specific version update.
 */
function skipThisVersion(version) {
  localStorage.setItem(SKIP_VERSION_KEY, version);
  closeModal('modal-update');
  showToast('Обновление ' + version + ' пропущено');
}

/**
 * Manually trigger an update check from settings.
 */
async function manualCheckUpdate() {
  showToast('Проверка обновлений...');

  var result = await checkForUpdate();

  if (result.error) {
    showToast('Ошибка проверки: ' + result.error);
    return;
  }

  if (result.skipped) {
    showToast('Обновление ' + result.latestVersion + ' пропущено');
    return;
  }

  if (result.available) {
    showUpdateNotification(result);
  } else {
    showToast('У вас последняя версия (' + APP_VERSION + ')');
  }
}

// Make globally available
window.checkForUpdate = checkForUpdate;
window.autoCheckUpdate = autoCheckUpdate;
window.manualCheckUpdate = manualCheckUpdate;
window.downloadUpdate = downloadUpdate;
window.skipThisVersion = skipThisVersion;
window.APP_VERSION = APP_VERSION;

// Update version displays in settings and about
function updateVersionDisplay() {
  var versionText = 'Версия ' + APP_VERSION;
  var settingsEl = document.getElementById('settings-version-text');
  if (settingsEl) settingsEl.textContent = versionText;
  var aboutEl = document.getElementById('about-version-text');
  if (aboutEl) aboutEl.textContent = versionText;
}

export { APP_VERSION, checkForUpdate, autoCheckUpdate, manualCheckUpdate, updateVersionDisplay };
