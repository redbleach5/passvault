/**
 * updater.js — Auto-update system for PassVault
 *
 * Uses a native Capacitor plugin (UpdaterPlugin) to download APK updates
 * directly within the app and trigger Android's package installer.
 *
 * Flow:
 * 1. Check GitHub Releases API for newer versions
 * 2. If update found, show modal with release notes
 * 3. User taps "Download" → native plugin downloads APK to cache dir
 * 4. On download complete, Android package installer launches automatically
 * 5. User confirms install in system UI
 *
 * Fallback: If native plugin unavailable, opens GitHub releases page in browser.
 *
 * Rate limits: GitHub API allows 60 unauthenticated requests/hour.
 * We check at most once per app launch + once every 24 hours.
 */

import { showToast, openModal, closeModal } from './ui.js';

const APP_VERSION = '7.0.2';
const GITHUB_REPO = 'redbleach5/passvault';
const GITHUB_API = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LAST_CHECK_KEY = 'pv_update_last_check';
const SKIP_VERSION_KEY = 'pv_update_skip_version';
const LAST_VERSION_KEY = 'pv_update_last_known_version';

const IS_CAPACITOR = !!(window.Capacitor && Capacitor.Plugins);

/**
 * Get the native Updater plugin instance.
 */
let _updaterPluginInstance = null;
function getUpdaterPlugin() {
  if (!IS_CAPACITOR) return null;
  if (_updaterPluginInstance) return _updaterPluginInstance;
  try {
    if (Capacitor.Plugins.Updater) {
      _updaterPluginInstance = Capacitor.Plugins.Updater;
      return _updaterPluginInstance;
    }
    _updaterPluginInstance = Capacitor.registerPlugin('Updater');
    return _updaterPluginInstance;
  } catch(e) {
    console.warn('[Updater] Native plugin not available:', e);
    return null;
  }
}

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
 * Returns: { available, currentVersion, latestVersion, downloadUrl, releaseNotes, error }
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
    var htmlUrl = release.html_url || '';

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
    console.log('[Updater] Version comparison:', comparison, '(1=update, 0=same, -1=newer)');

    if (comparison > 0) {
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
        publishedAt: publishedAt,
        htmlUrl: htmlUrl
      };
    }

    console.log('[Updater] No update needed. Current:', APP_VERSION, 'Latest:', latestVersion);
    return {
      available: false,
      currentVersion: APP_VERSION,
      latestVersion: latestVersion,
      releaseName: releaseName,
      publishedAt: publishedAt,
      htmlUrl: htmlUrl
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

  if (result.available) {
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
    <div style="text-align:center;padding:8px 0 20px">
      <div style="font-size:52px">🚀</div>
      <div style="font-size:19px;font-weight:800;margin-top:10px">Доступно обновление!</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:10px">
        Версия <strong style="color:var(--accent)">${currentV}</strong> → <strong style="color:var(--accent)">${latestV}</strong>
      </div>
    </div>
    ${shortNotes ? '<div style="background:var(--bg-tertiary);border-radius:var(--radius);padding:14px 16px;margin-bottom:18px;font-size:13px;color:var(--text-secondary);line-height:1.6;max-height:200px;overflow-y:auto;border:1px solid var(--border)">' + shortNotes + '</div>' : ''}
    <div id="update-buttons" style="display:flex;gap:8px;flex-direction:column">
      <button class="btn btn-primary" onclick="downloadUpdate()" style="width:100%" id="btn-download-update">⬇️ Скачать и обновить</button>
      <button class="btn btn-outline" onclick="skipThisVersion('${latestV}')" style="width:100%">Пропустить это обновление</button>
      <button class="btn btn-ghost" onclick="closeModal('modal-update')" style="width:100%">Напомнить позже</button>
    </div>
  `;

  // Store download URL for the download handler
  window._updateDownloadUrl = updateInfo.downloadUrl;
  window._updateHtmlUrl = updateInfo.htmlUrl;

  openModal('modal-update');
}

/**
 * Download the update APK using the native UpdaterPlugin.
 * Falls back to opening GitHub releases page if plugin unavailable.
 */
async function downloadUpdate() {
  var url = window._updateDownloadUrl;
  if (!url) {
    showToast('Ошибка: ссылка на скачивание не найдена');
    return;
  }

  console.log('[Updater] Download URL:', url);

  var updaterPlugin = getUpdaterPlugin();

  if (updaterPlugin) {
    // ===== Native plugin available: download APK directly =====
    var downloadBtn = document.getElementById('btn-download-update');
    if (downloadBtn) {
      downloadBtn.disabled = true;
      downloadBtn.textContent = '⏳ Скачивание...';
    }

    // Hide other buttons during download
    var buttonsContainer = document.getElementById('update-buttons');
    if (buttonsContainer) {
      var allBtns = buttonsContainer.querySelectorAll('.btn-outline, .btn-ghost');
      allBtns.forEach(function(b) { b.style.display = 'none'; });
    }

    // Add progress bar
    var progressDiv = document.createElement('div');
    progressDiv.id = 'download-progress';
    progressDiv.style.cssText = 'margin-top:12px;';
    progressDiv.innerHTML = '<div style="background:var(--bg-tertiary);border-radius:var(--radius-sm);height:8px;overflow:hidden;border:1px solid var(--border)"><div id="progress-fill" style="height:100%;width:0%;background:var(--gradient-accent);border-radius:var(--radius-sm);transition:width 0.3s ease"></div></div><div id="progress-text" style="font-size:12px;color:var(--text-muted);margin-top:6px;text-align:center">Подготовка...</div>';
    if (buttonsContainer) {
      buttonsContainer.appendChild(progressDiv);
    }

    // Listen for download progress
    updaterPlugin.addListener('downloadProgress', function(data) {
      var fill = document.getElementById('progress-fill');
      var text = document.getElementById('progress-text');
      if (fill) fill.style.width = data.percent + '%';
      if (text) {
        var mb = (data.downloaded / (1024 * 1024)).toFixed(1);
        var totalMb = (data.total / (1024 * 1024)).toFixed(1);
        text.textContent = data.percent + '% — ' + mb + ' / ' + totalMb + ' МБ';
      }
    });

    try {
      // Check if we can install APKs first (Android 8+)
      var canInstall = await updaterPlugin.canInstallApk();
      if (canInstall.needsPermission && !canInstall.canInstall) {
        // Need to request install permission
        showToast('Требуется разрешение на установку приложений');
        var permResult = await updaterPlugin.requestInstallPermission();
        if (!permResult.granted) {
          showToast('Без разрешения обновление невозможно');
          resetDownloadUI();
          return;
        }
      }

      var result = await updaterPlugin.downloadAndInstall({ url: url });

      if (result.success) {
        closeModal('modal-update');
        showToast('APK скачан! Подтвердите установку');
      } else {
        showToast('Ошибка: ' + (result.error || 'скачивание не удалось'));
        resetDownloadUI();
      }
    } catch(e) {
      console.error('[Updater] Download failed:', e);
      showToast('Ошибка скачивания: ' + (e.message || e));
      resetDownloadUI();
    }
  } else {
    // ===== Fallback: no native plugin — open in browser =====
    console.warn('[Updater] Native Updater plugin not available, falling back to browser');
    closeModal('modal-update');
    showToast('Открываем страницу скачивания...');

    // Try opening GitHub releases page
    var releasesUrl = window._updateHtmlUrl || ('https://github.com/' + GITHUB_REPO + '/releases');

    if (IS_CAPACITOR) {
      try {
        var Browser = Capacitor.Plugins.Browser;
        if (Browser && Browser.open) {
          Browser.open({ url: releasesUrl });
          return;
        }
      } catch(e) {}
      window.open(releasesUrl, '_system');
    } else {
      window.open(releasesUrl, '_blank');
    }
  }
}

/**
 * Reset download UI to initial state.
 */
function resetDownloadUI() {
  var downloadBtn = document.getElementById('btn-download-update');
  if (downloadBtn) {
    downloadBtn.disabled = false;
    downloadBtn.textContent = '⬇️ Скачать и обновить';
  }

  var progressDiv = document.getElementById('download-progress');
  if (progressDiv) progressDiv.remove();

  var buttonsContainer = document.getElementById('update-buttons');
  if (buttonsContainer) {
    var allBtns = buttonsContainer.querySelectorAll('.btn-outline, .btn-ghost');
    allBtns.forEach(function(b) { b.style.display = ''; });
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
    var latestV = result.latestVersion || 'неизвестно';
    var currentV = result.currentVersion || APP_VERSION;
    var msg = 'У вас последняя версия! (' + currentV + ')';
    showToast(msg);
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
  var htmlUrl = result.htmlUrl || '';
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
    <div style="text-align:center;padding:8px 0 20px">
      <div style="font-size:52px">✅</div>
      <div style="font-size:19px;font-weight:800;margin-top:10px">Обновлений нет</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:10px">
        Установлена последняя версия
      </div>
    </div>
    <div style="background:var(--bg-tertiary);border-radius:var(--radius);padding:18px;margin-bottom:18px;border:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px">
        <span style="color:var(--text-secondary);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Ваша версия</span>
        <span style="font-weight:800;color:var(--accent)">${currentV}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px">
        <span style="color:var(--text-secondary);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Последняя на GitHub</span>
        <span style="font-weight:800">${latestV}</span>
      </div>
      ${dateStr ? '<div style="display:flex;justify-content:space-between"><span style="color:var(--text-secondary);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Дата релиза</span><span style="font-size:13px">' + dateStr + '</span></div>' : ''}
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

/**
 * Reset the skip-version flag (called from settings).
 */
function resetSkippedVersion() {
  localStorage.removeItem(SKIP_VERSION_KEY);
  localStorage.removeItem(LAST_CHECK_KEY);
  showToast('Пропущенное обновление сброшено');
}

// Make globally available
window.checkForUpdate = checkForUpdate;
window.autoCheckUpdate = autoCheckUpdate;
window.manualCheckUpdate = manualCheckUpdate;
window.downloadUpdate = downloadUpdate;
window.skipThisVersion = skipThisVersion;
window.openGitHubReleases = openGitHubReleases;
window.resetSkippedVersion = resetSkippedVersion;
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
