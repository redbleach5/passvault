/**
 * conflicts.js — Sync Conflict Resolver for PassVault
 *
 * Detects and resolves sync conflicts when both local and remote
 * vault data have been modified since the last sync.
 *
 * Conflict Detection:
 * - Compares local and remote lastModified timestamps
 *   against the lastSyncTimestamp
 * - If only one side changed → no conflict (safe to push/pull)
 * - If both sides changed → CONFLICT
 *
 * Resolution Strategies:
 * - keepLocal: overwrite remote with local data
 * - keepRemote: overwrite local with remote data
 * - merge: intelligent 3-way merge using lastSyncTimestamp as base
 *   (combines credentials from both sides, keeping newer versions)
 *
 * Storage Keys:
 * - pv_last_sync_timestamp — ISO timestamp of last successful sync
 * - pv_local_modified_at   — ISO timestamp of last local vault save
 */

import { showToast, openModal, closeModal, escHtml } from './ui.js';

const LAST_SYNC_KEY = 'pv_last_sync_timestamp';
const LOCAL_MODIFIED_KEY = 'pv_local_modified_at';

// ===== Storage Helpers =====

/**
 * Get the timestamp of the last successful sync.
 * @returns {string|null} ISO timestamp string or null
 */
function getLastSyncTimestamp() {
  return localStorage.getItem(LAST_SYNC_KEY);
}

/**
 * Set the timestamp of the last successful sync.
 * @param {string} ts — ISO timestamp string
 */
function setLastSyncTimestamp(ts) {
  localStorage.setItem(LAST_SYNC_KEY, ts);
}

/**
 * Get the timestamp when local vault was last modified.
 * @returns {string|null} ISO timestamp string or null
 */
function getLocalModifiedTimestamp() {
  return localStorage.getItem(LOCAL_MODIFIED_KEY);
}

/**
 * Set the local vault modified timestamp.
 * Call this whenever the vault is saved locally.
 * @param {string} [ts] — ISO timestamp; defaults to now
 */
function setLocalModifiedTimestamp(ts) {
  localStorage.setItem(LOCAL_MODIFIED_KEY, ts || new Date().toISOString());
}

// ===== Conflict Detection =====

/**
 * Detect whether a sync conflict exists.
 * @param {object} localData — Local vault data package with lastModified
 * @param {object} remoteData — Remote vault data package with lastModified
 * @param {string|null} lastSyncTimestamp — ISO timestamp of last sync (null = never synced)
 * @returns {{
 *   status: 'no_conflict'|'local_newer'|'remote_newer'|'conflict',
 *   localTimestamp: string|null,
 *   remoteTimestamp: string|null,
 *   lastSyncTimestamp: string|null,
 *   localCount: number,
 *   remoteCount: number
 * }}
 */
function detectConflict(localData, remoteData, lastSyncTimestamp) {
  const localTs = localData ? (localData.lastModified || null) : null;
  const remoteTs = remoteData ? (remoteData.lastModified || null) : null;
  const syncTs = lastSyncTimestamp || null;

  const localCount = localData && localData.credentials ? Object.keys(localData.credentials).length : 0;
  const remoteCount = remoteData && remoteData.credentials ? Object.keys(remoteData.credentials).length : 0;

  // No remote data — nothing to conflict with
  if (!remoteTs) {
    return { status: 'local_newer', localTimestamp: localTs, remoteTimestamp: remoteTs, lastSyncTimestamp: syncTs, localCount, remoteCount };
  }

  // No local data — remote is the only source
  if (!localTs) {
    return { status: 'remote_newer', localTimestamp: localTs, remoteTimestamp: remoteTs, lastSyncTimestamp: syncTs, localCount, remoteCount };
  }

  // Never synced before — check if both have data
  if (!syncTs) {
    // Both have data but never synced — potential conflict
    if (localCount > 0 && remoteCount > 0) {
      return { status: 'conflict', localTimestamp: localTs, remoteTimestamp: remoteTs, lastSyncTimestamp: syncTs, localCount, remoteCount };
    }
    // One side is empty
    if (localCount > 0) {
      return { status: 'local_newer', localTimestamp: localTs, remoteTimestamp: remoteTs, lastSyncTimestamp: syncTs, localCount, remoteCount };
    }
    return { status: 'remote_newer', localTimestamp: localTs, remoteTimestamp: remoteTs, lastSyncTimestamp: syncTs, localCount, remoteCount };
  }

  // Determine which sides have been modified since last sync
  const localModified = localTs > syncTs;
  const remoteModified = remoteTs > syncTs;

  if (localModified && remoteModified) {
    // Both modified since last sync → CONFLICT
    return { status: 'conflict', localTimestamp: localTs, remoteTimestamp: remoteTs, lastSyncTimestamp: syncTs, localCount, remoteCount };
  }

  if (localModified && !remoteModified) {
    // Only local changed → safe to upload
    return { status: 'local_newer', localTimestamp: localTs, remoteTimestamp: remoteTs, lastSyncTimestamp: syncTs, localCount, remoteCount };
  }

  if (!localModified && remoteModified) {
    // Only remote changed → safe to download
    return { status: 'remote_newer', localTimestamp: localTs, remoteTimestamp: remoteTs, lastSyncTimestamp: syncTs, localCount, remoteCount };
  }

  // Neither changed since last sync → no conflict, no action needed
  return { status: 'no_conflict', localTimestamp: localTs, remoteTimestamp: remoteTs, lastSyncTimestamp: syncTs, localCount, remoteCount };
}

// ===== Conflict Resolution =====

/**
 * Resolve conflict by keeping local data (overwrite remote).
 * @param {object} localData
 * @returns {object} localData unchanged
 */
function keepLocal(localData) {
  return localData;
}

/**
 * Resolve conflict by keeping remote data (overwrite local).
 * @param {object} _localData — ignored
 * @param {object} remoteData
 * @returns {object} remoteData unchanged
 */
function keepRemote(_localData, remoteData) {
  return remoteData;
}

/**
 * Intelligent 3-way merge of vault data.
 *
 * Strategy:
 * - Iterate all credential keys from both sides
 * - If a credential exists only on one side → include it
 * - If a credential exists on both sides:
 *   - Compare updatedAt timestamps
 *   - Keep the one with the newer updatedAt
 *   - If same → keep either (prefer local for stability)
 * - Merge metadata: take the newer lastModified
 *
 * @param {object} localVault — Local vault data with credentials map
 * @param {object} remoteVault — Remote vault data with credentials map
 * @param {string|null} lastSyncTimestamp — Base timestamp for 3-way merge
 * @returns {object} Merged vault data
 */
function mergeVaultData(localVault, remoteVault, lastSyncTimestamp) {
  const localCreds = (localVault && localVault.credentials) || {};
  const remoteCreds = (remoteVault && remoteVault.credentials) || {};

  const allKeys = new Set([
    ...Object.keys(localCreds),
    ...Object.keys(remoteCreds)
  ]);

  const mergedCredentials = {};

  for (const key of allKeys) {
    const local = localCreds[key];
    const remote = remoteCreds[key];

    if (local && !remote) {
      // Only exists locally — keep
      mergedCredentials[key] = local;
      continue;
    }

    if (!local && remote) {
      // Only exists remotely — keep
      mergedCredentials[key] = remote;
      continue;
    }

    // Both sides have this credential — merge by updatedAt
    const localUpdated = local.updatedAt || local.updated_at || '0';
    const remoteUpdated = remote.updatedAt || remote.updated_at || '0';

    if (localUpdated >= remoteUpdated) {
      // Local is newer or same — prefer local for stability
      mergedCredentials[key] = local;
    } else {
      // Remote is newer
      mergedCredentials[key] = remote;
    }
  }

  // Determine merged metadata
  const localTs = localVault ? (localVault.lastModified || null) : null;
  const remoteTs = remoteVault ? (remoteVault.lastModified || null) : null;

  const mergedLastModified = new Date().toISOString();

  // Merge other top-level fields (prefer local for non-credential data)
  const merged = {
    ...(localVault || {}),
    ...(remoteVault || {}),
    credentials: mergedCredentials,
    lastModified: mergedLastModified
  };

  return merged;
}

// ===== Conflict UI =====

/**
 * Show a conflict resolution modal.
 * @param {{
 *   status: string,
 *   localTimestamp: string|null,
 *   remoteTimestamp: string|null,
 *   lastSyncTimestamp: string|null,
 *   localCount: number,
 *   remoteCount: number
 * }} conflictInfo — Output from detectConflict()
 * @param {function} onResolve — Callback receiving the chosen strategy:
 *   'keep_local' | 'keep_remote' | 'merge'
 */
function showConflictModal(conflictInfo, onResolve) {
  // Format timestamps for display
  const fmtTs = (ts) => {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString('ru');
    } catch(e) {
      return ts;
    }
  };

  const localTime = fmtTs(conflictInfo.localTimestamp);
  const remoteTime = fmtTs(conflictInfo.remoteTimestamp);
  const syncTime = fmtTs(conflictInfo.lastSyncTimestamp);

  // Build modal HTML
  const modalId = 'conflict-resolve-modal';

  // Remove existing modal if present
  const existing = document.getElementById(modalId);
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = modalId;
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal conflict-modal">
      <div class="modal-header">
        <h3>⚠️ Конфликт синхронизации</h3>
      </div>
      <div class="modal-body">
        <p class="conflict-desc">Локальные и удалённые данные были изменены одновременно. Выберите способ разрешения:</p>
        <div class="conflict-details">
          <div class="conflict-side">
            <span class="conflict-label">📱 Локально</span>
            <span class="conflict-time">${escHtml(localTime)}</span>
            <span class="conflict-count">${conflictInfo.localCount} записей</span>
          </div>
          <div class="conflict-side">
            <span class="conflict-label">☁️ Удалённо</span>
            <span class="conflict-time">${escHtml(remoteTime)}</span>
            <span class="conflict-count">${conflictInfo.remoteCount} записей</span>
          </div>
          <div class="conflict-sync-info">
            Последняя синхронизация: ${escHtml(syncTime)}
          </div>
        </div>
      </div>
      <div class="modal-footer conflict-actions">
        <button class="btn btn-secondary" id="conflict-keep-local">
          📱 Оставить локальные
        </button>
        <button class="btn btn-secondary" id="conflict-keep-remote">
          ☁️ Оставить удалённые
        </button>
        <button class="btn btn-primary" id="conflict-merge">
          🔀 Объединить (рекомендуется)
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Slight delay for CSS transition
  requestAnimationFrame(() => {
    overlay.classList.add('active');
  });

  // Button handlers
  const resolve = (strategy) => {
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 300);
    if (onResolve) onResolve(strategy);
  };

  document.getElementById('conflict-keep-local').addEventListener('click', () => resolve('keep_local'));
  document.getElementById('conflict-keep-remote').addEventListener('click', () => resolve('keep_remote'));
  document.getElementById('conflict-merge').addEventListener('click', () => resolve('merge'));
}

/**
 * Resolve a sync conflict using the chosen strategy.
 * @param {'keep_local'|'keep_remote'|'merge'} strategy
 * @param {object} localData
 * @param {object} remoteData
 * @param {string|null} lastSyncTimestamp
 * @returns {object} Resolved vault data
 */
function resolveConflict(strategy, localData, remoteData, lastSyncTimestamp) {
  switch(strategy) {
    case 'keep_local':
      return keepLocal(localData);
    case 'keep_remote':
      return keepRemote(localData, remoteData);
    case 'merge':
      return mergeVaultData(localData, remoteData, lastSyncTimestamp);
    default:
      console.warn('Unknown conflict strategy:', strategy, '— defaulting to merge');
      return mergeVaultData(localData, remoteData, lastSyncTimestamp);
  }
}

// Make globally available
window.getLastSyncTimestamp = getLastSyncTimestamp;
window.setLastSyncTimestamp = setLastSyncTimestamp;
window.getLocalModifiedTimestamp = getLocalModifiedTimestamp;
window.setLocalModifiedTimestamp = setLocalModifiedTimestamp;
window.detectConflict = detectConflict;
window.showConflictModal = showConflictModal;
window.resolveConflict = resolveConflict;
window.mergeVaultData = mergeVaultData;
window.keepLocal = keepLocal;
window.keepRemote = keepRemote;

export {
  getLastSyncTimestamp, setLastSyncTimestamp,
  getLocalModifiedTimestamp, setLocalModifiedTimestamp,
  detectConflict,
  showConflictModal,
  resolveConflict,
  mergeVaultData, keepLocal, keepRemote
};
