/**
 * updater.js — Auto-update checker for PassVault
 *
 * Checks GitHub Releases API for new versions.
 * If a newer version is found, shows a notification with a download link.
 *
 * On Android (Capacitor), the APK can be downloaded via the system browser
 * or InAppBrowser, which triggers Android's package installer.
 *
 * Rate limits: GitHub API allows 60 unauthenticated requests/hour.
 * We check at most once per app launch + once every 24 hours.
 */

import { showToast, openModal, closeModal } from './ui.js';

const APP_VERSION = '6.3.0';
const GITHUB_REPO = 'redbleach5/passvault';
const GITHUB_API = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LAST_CHECK_KEY = 'pv_update_last_check';
const SKIP_VERSION_KEY = 'pv_update_skip_version';
const LAST_VERSION_KEY = 'pv_update_last_known_version';

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
  var skipVersion = localStorage.getItem(SKIP_VERSION_KEY);

  try {
    console.log('[Updater] Checking GitHub API:', GITHUB_API);

    var response = await fetch(GITHUB_API, {
      method: 'GET',
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      cache: 'no-cache'
    });

    console.log('[Updater] GitHub API response status:', response.status);

    if (!response.ok) {
      var errText = '';
      try { errText = await response.text(); } catch(e) {}
      console.error('[Updater] GitHub API error:', response.status, errText);
      return { available: false, error: 'GitHub API error: ' + response.status };
    }

    var release = await response.json();
    var latestVersion = release.tag_name || '';
    var downloadUrl = '';
    var releaseNotes = release.body || '';
    var releaseName = release.name || '';
    var publishedAt = release.published_at || '';

    console.log('[Updater] Latest release:', latestVersion, '| App version:', APP_VERSION);

    // Find APK asset
    if (release.assets && release.assets.length > 0) {
      for (var i = 0; i < release.assets.length; i++) {
        if (release.assets[i].name && release.assets[i].name.endsWith('.apk')) {
          downloadUrl = release.assets[i].browser_download_url;
          console.log('[Updater] Found APK asset:', release.assets[i].name, downloadUrl);
          break;
        }
      }
    }

    if (!downloadUrl) {
      console.warn('[Updater] No APK asset found in release');
    }

    // Save the latest known version
    localStorage.setItem(LAST_VERSION_KEY, latestVersion);

    var comparison = compareVersions(latestVersion, APP_VERSION);
    console.log('[Updater] Version comparison result:', comparison, '(1=update available, 0=same, -1=app newer)');

    if (comparison > 0) {
      // New version available
      if (skipVersion === latestVersion) {
        console.log('[Updater] Version', latestVersion, 'was skipped by user');
        return { available: false, latestVersion: latestVersion, skipped: true };
      }

      console.log('[Updater] Update available:', APP_VERSION, '->', latestVersion);
      return {
        available: true,
        currentVersion: APP_VERSION,
        latestVersion: latestVersion,
        downloadUrl: downloadUrl,
        releaseNotes: releaseNotes,
        releaseName: releaseName,
        publishedAt: publishedAt
      };
    }

    console.log('[Updater] No update needed. Current:', APP_VERSION, 'Latest:', latestVersion);
    return {
      available: false,
      currentVersion: APP_VERSION,
      latestVersion: latestVersion,
      releaseName: releaseName,
      publishedAt: publishedAt
    };

  } catch (e) {
    console.error('[Updater] Network error:', e);
    return { available: false, error: 'Network error: ' + (e.message || e) };
  }
}

/**
 * Perform the update check if enough time has passed.
 * Shows a modal if an update is available.
 */
async function autoCheckUpdate() {
  var lastCheck = parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10);
  var now = Date.now();
  if (now - lastCheck < CHECK_INTERVAL_MS) {
    console.log('[Updater] Auto-check skipped: too soon since last check');
    return;
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
 * On Capacitor Android: use InAppBrowser or system browser to download.
 * On web: open in new tab.
 */
function downloadUpdate() {
  var url = window._updateDownloadUrl;
  if (!url) {
    showToast('Ошибка: ссылка на скачивание не найдена');
    return;
  }

  closeModal('modal-update');
  showToast('Открываем скачивание...');

  console.log('[Updater] Download URL:', url);

  if (IS_CAPACITOR) {
    // On Android Capacitor, we need to open the URL in the system browser
    // so Android can download the APK and offer to install it.
    // Try using the Browser plugin first, then fallback to window.open.
    try {
      var Browser = Capacitor.Plugins.Browser;
      if (Browser && Browser.open) {
        Browser.open({ url: url });
        return;
      }
    } catch(e) {
      console.warn('[Updater] Browser plugin not available:', e);
    }

    // Fallback: use InAppBrowser plugin
    try {
      var InAppBrowser = Capacitor.Plugins.InAppBrowser;
      if (InAppBrowser && InAppBrowser.open) {
        InAppBrowser.open({ url: url });
        return;
      }
    } catch(e) {
      console.warn('[Updater] InAppBrowser plugin not available:', e);
    }

    // Last fallback: window.open (may not work in Capacitor WebView)
    window.open(url, '_system');
  } else {
    // Web: open in new tab
    window.open(url, '_blank');
  }
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
 * Shows detailed info about the check result.
 */
async function manualCheckUpdate() {
  showToast('Проверка обновлений...');

  var result = await checkForUpdate();

  if (result.error) {
    showToast('Ошибка проверки: ' + result.error);
    return;
  }

  if (result.skipped) {
    showToast('Обновление ' + result.latestVersion + ' пропущено (сброс в настройках)');
    return;
  }

  if (result.available) {
    showUpdateNotification(result);
  } else {
    // Show detailed info — what's the latest version on GitHub vs our version
    var latestV = result.latestVersion || 'неизвестно';
    var currentV = result.currentVersion || APP_VERSION;
    var msg = 'У вас последняя версия! (' + currentV + ')';
    showToast(msg);

    // Also show a detailed modal with version info
    showVersionInfoModal(result);
  }
}

/**
 * Show version info modal — tells the user exactly what version they have
 * and what's available on GitHub, even when up-to-date.
 */
function showVersionInfoModal(result) {
  var latestV = result.latestVersion || '—';
  var currentV = result.currentVersion || APP_VERSION;
  var publishedAt = result.publishedAt || '';
  var dateStr = '';
  if (publishedAt) {
    try {
      var d = new Date(publishedAt);
      dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch(e) { dateStr = publishedAt; }
  }

  var body = document.getElementById('update-modal-body');
  if (!body) return;

  body.innerHTML = `
    <div style="text-align:center;padding:8px 0 16px">
      <div style="font-size:48px">✅</div>
      <div style="font-size:18px;font-weight:700;margin-top:8px">Обновлений нет</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:8px">
        Установлена последняя версия
      </div>
    </div>
    <div style="background:var(--bg-tertiary);border-radius:var(--radius);padding:16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;margin-bottom:10px">
        <span style="color:var(--text-secondary);font-size:13px">Ваша версия</span>
        <span style="font-weight:700;color:var(--accent)">${currentV}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:10px">
        <span style="color:var(--text-secondary);font-size:13px">Последняя на GitHub</span>
        <span style="font-weight:700">${latestV}</span>
      </div>
      ${dateStr ? '<div style="display:flex;justify-content:space-between"><span style="color:var(--text-secondary);font-size:13px">Дата релиза</span><span style="font-size:13px">' + dateStr + '</span></div>' : ''}
    </div>
    <div style="display:flex;gap:8px;flex-direction:column">
      <button class="btn btn-outline" onclick="openGitHubReleases()" style="width:100%">📂 Открыть страницу релизов</button>
      <button class="btn btn-ghost" onclick="closeModal('modal-update')" style="width:100%">Закрыть</button>
    </div>
  `;

  openModal('modal-update');
}

/**
 * Open GitHub releases page in the system browser.
 */
function openGitHubReleases() {
  var url = 'https://github.com/' + GITHUB_REPO + '/releases';
  closeModal('modal-update');

  if (IS_CAPACITOR) {
    try {
      var Browser = Capacitor.Plugins.Browser;
      if (Browser && Browser.open) {
        Browser.open({ url: url });
        return;
      }
    } catch(e) {}

    window.open(url, '_system');
  } else {
    window.open(url, '_blank');
  }
}

// Make globally available
window.checkForUpdate = checkForUpdate;
window.autoCheckUpdate = autoCheckUpdate;
window.manualCheckUpdate = manualCheckUpdate;
window.downloadUpdate = downloadUpdate;
window.skipThisVersion = skipThisVersion;
window.openGitHubReleases = openGitHubReleases;
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
