/**
 * ui/settings.js — Settings, export/import, audit log, security info, custom services, cloud
 */

import { state } from '../state.js';
import { SERVICES, CATEGORIES } from '../services.js';
import { PBKDF2_ITERATIONS, evaluatePasswordStrength } from '../crypto.js';
import { auditLog, getAllAuditLogs } from '../audit.js';
import {
  showScreen, showToast, openModal, closeModal, showConfirm,
  escHtml
} from '../ui.js';
import { lockVault } from './screens.js';
import { loadVault, saveVault, loadCustomServices, saveCustomServices, getAllServices, renderDashboard } from './vault.js';
import {
  initFirebase, getFirebaseConfig, saveFirebaseConfig,
  cloudRegister, cloudLogin, cloudLogout,
  cloudUpload, cloudDownload, cloudStatus,
  isCloudConfigured, isCloudAuthenticated
} from '../cloud.js';

// ===== Export / Import =====

async function exportVault() {
  if (!state.masterKey) {
    showToast('Сначала разблокируйте хранилище');
    return;
  }
  try {
    const vaultEnc = localStorage.getItem('pv_vault');
    const customEnc = localStorage.getItem('pv_custom_services');
    const salt = localStorage.getItem('pv_salt');
    const hash = localStorage.getItem('pv_hash');
    const auditEnc = localStorage.getItem('pv_audit');
    const format = localStorage.getItem('pv_format') || 'v2';

    const exportObj = {
      version: 2,
      format: 'passvault-export',
      kdf: 'PBKDF2-SHA256',
      kdfIterations: PBKDF2_ITERATIONS,
      cipher: 'AES-256-GCM',
      salt: salt,
      hash: hash,
      vault: vaultEnc,
      customServices: customEnc,
      auditLog: auditEnc,
      formatVersion: format,
      timestamp: new Date().toISOString(),
      serviceCount: Object.keys((await loadVault()).credentials || {}).length
    };

    const jsonStr = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `passvault-backup-${dateStr}.vault`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    await auditLog('export', null, `Backup created (${exportObj.serviceCount} services)`, 'success');
    showToast('Резервная копия сохранена');
  } catch(e) {
    await auditLog('export', null, 'Export failed: ' + e.message, 'failure');
    showToast('Ошибка экспорта');
  }
}

function triggerImportVault() {
  document.getElementById('vault-file-input').click();
}

async function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';

  try {
    const text = await file.text();
    const importObj = JSON.parse(text);

    if (!importObj.format || importObj.format !== 'passvault-export') {
      showToast('Неверный формат файла');
      return;
    }
    if (!importObj.salt || !importObj.hash || !importObj.vault) {
      showToast('Файл повреждён или неполный');
      return;
    }

    if (state.masterKey) {
      showConfirm('Импорт хранилища', 'Текущие данные будут заменены данными из файла. Продолжить?', 'Импортировать', async () => {
        await doImportVault(importObj);
      });
    } else {
      window._pendingImport = importObj;
      showToast('Введите мастер-пароль от резервной копии');
      document.getElementById('unlock-pw').placeholder = 'Мастер-пароль от резервной копии';
      document.getElementById('unlock-pw').dataset.importMode = '1';
      showScreen('screen-unlock');
    }
  } catch(e) {
    showToast('Ошибка чтения файла');
  }
}

async function doImportVault(importObj) {
  try {
    localStorage.setItem('pv_salt', importObj.salt);
    localStorage.setItem('pv_hash', importObj.hash);
    if (importObj.vault) localStorage.setItem('pv_vault', importObj.vault);
    if (importObj.customServices) localStorage.setItem('pv_custom_services', importObj.customServices);
    if (importObj.auditLog) localStorage.setItem('pv_audit', importObj.auditLog);
    if (importObj.formatVersion) localStorage.setItem('pv_format', importObj.formatVersion);

    await auditLog('import', null, `Backup restored (${importObj.serviceCount || '?'} services)`, 'success');
    lockVault();
    showToast('Данные импортированы. Введите мастер-пароль от копии.');
  } catch(e) {
    showToast('Ошибка импорта');
  }
}

// ===== Custom Services =====

function openAddCustomService() {
  const body = document.getElementById('custom-svc-body');
  body.innerHTML = `
    <div class="form-group">
      <label>Идентификатор (латиница, без пробелов)</label>
      <input type="text" id="cs-id" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none" placeholder="my-service">
    </div>
    <div class="form-group">
      <label>Название</label>
      <input type="text" id="cs-display" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none" placeholder="Мой Сервис">
    </div>
    <div class="form-group">
      <label>Категория</label>
      <select class="form-select" id="cs-category">
        ${Object.entries(CATEGORIES).map(([k,v]) => `<option value="${k}">${v.name}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>URL смены пароля</label>
      <input type="url" id="cs-pwurl" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none" placeholder="https://...">
    </div>
    <div class="form-group">
      <label>URL входа</label>
      <input type="url" id="cs-loginurl" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none" placeholder="https://...">
    </div>
    <div class="form-group">
      <label>Инструкции (по одной на строку)</label>
      <textarea class="form-textarea" id="cs-instructions" placeholder="Перейдите на сайт&#10;Откройте настройки&#10;Смените пароль"></textarea>
    </div>
    <div class="form-group">
      <label>Примечание о 2FA (необязательно)</label>
      <input type="text" id="cs-2fa" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none" placeholder="Сервис использует 2FA...">
    </div>
    <button class="btn btn-primary" onclick="saveCustomService()">💾 Сохранить сервис</button>
  `;
  openModal('modal-custom-svc');
}

async function saveCustomService() {
  const idRaw = document.getElementById('cs-id').value.trim().replace(/\s+/g, '-').toLowerCase();
  const id = idRaw.replace(/[^a-z0-9-]/g, '');
  const displayName = document.getElementById('cs-display').value.trim();
  const category = document.getElementById('cs-category').value;
  const passwordChangeUrl = document.getElementById('cs-pwurl').value.trim();
  const loginUrl = document.getElementById('cs-loginurl').value.trim();
  const instructionsRaw = document.getElementById('cs-instructions').value.trim();
  const twoFactorNote = document.getElementById('cs-2fa').value.trim() || null;

  if (!id || !displayName) { showToast('Заполните обязательные поля'); return; }
  if (id.length < 2) { showToast('ID слишком короткий'); return; }
  if (passwordChangeUrl && !passwordChangeUrl.startsWith('https://')) { showToast('URL смены пароля должен начинаться с https://'); return; }
  if (loginUrl && !loginUrl.startsWith('https://')) { showToast('URL входа должен начинаться с https://'); return; }

  const instructions = instructionsRaw ? instructionsRaw.split('\n').map(s=>s.trim()).filter(Boolean) : [];
  const emojis = { email:'📧', social:'💬', dev:'🔧', cloud:'☁️', messaging:'📱', finance:'💰', streaming:'🎬', gaming:'🎮', ecommerce:'🛒', custom:'⭐' };

  const newSvc = {
    id: 'custom_' + id, name: displayName, displayName, category,
    iconEmoji: emojis[category] || '⭐',
    passwordChangeUrl, loginUrl,
    usernameSelector: '', currentPasswordSelector: '', newPasswordSelector: '',
    confirmPasswordSelector: '', submitSelector: '', instructions, twoFactorNote
  };

  const custom = await loadCustomServices();
  const allSvc = await getAllServices();
  if (allSvc.find(s => s.id === newSvc.id)) { showToast('Сервис с таким ID уже существует'); return; }
  custom.push(newSvc);
  await saveCustomServices(custom);
  closeModal('modal-custom-svc');
  showToast('Сервис добавлен!');
  renderDashboard();
}

// ===== Audit log view =====

async function showAuditLog() {
  const body = document.getElementById('audit-log-body');
  const logs = await getAllAuditLogs();
  const actionLabels = {
    vault_created: 'Создание хранилища', unlock: 'Разблокировка', lock: 'Блокировка',
    lockout: 'Блокировка (превышен лимит)', credential_save: 'Сохранение учётных данных',
    credential_delete: 'Удаление учётных данных', copy_password: 'Копирование пароля',
    copy_username: 'Копирование логина', view_password: 'Просмотр пароля',
    wizard_start: 'Запуск мастера смены пароля', open_url: 'Открытие ссылки смены пароля'
  };
  const resultLabels = { success: 'Успешно', failure: 'Ошибка' };
  if (logs.length === 0) {
    body.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><h3>Журнал пуст</h3><p>Действия будут отображаться здесь</p></div>';
  } else {
    body.innerHTML = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Последние ' + logs.length + ' событий (зашифровано)</div>' +
      logs.map(log => {
        const d = new Date(log.ts);
        const time = d.toLocaleDateString('ru') + ' ' + d.toLocaleTimeString('ru');
        const label = actionLabels[log.action] || log.action;
        const resultTag = log.result ? '<span style="font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px;background:' + (log.result === 'success' ? 'rgba(34,197,94,0.15);color:#22c55e' : 'rgba(239,68,68,0.15);color:#ef4444') + '">' + (resultLabels[log.result] || log.result) + '</span>' : '';
        return '<div class="cred-field" style="padding:10px 12px;margin-bottom:6px"><div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:13px;font-weight:600">' + escHtml(label) + resultTag + '</div><div style="font-size:11px;color:var(--text-muted)">' + time + '</div></div>' + (log.svc ? '<div style="font-size:12px;color:var(--text-secondary);margin-top:2px">Сервис: ' + escHtml(log.svc) + '</div>' : '') + (log.detail ? '<div style="font-size:12px;color:var(--danger);margin-top:2px">' + escHtml(log.detail) + '</div>' : '') + (log.platform ? '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">Платформа: ' + escHtml(log.platform) + '</div>' : '') + '</div>';
      }).join('');
  }
  openModal('modal-audit');
}

// ===== Security info view =====

function showSecurityInfo() {
  const body = document.getElementById('security-info-body');
  const vaultFormat = localStorage.getItem('pv_format') || 'v1';
  body.innerHTML = '<div style="padding:8px 0">' +
    '<div class="cred-field"><div class="cred-label">Алгоритм шифрования</div><div class="cred-value">AES-256-GCM</div></div>' +
    '<div class="cred-field"><div class="cred-label">Ключевая деривация</div><div class="cred-value">PBKDF2-SHA256 (600 000 итераций)</div></div>' +
    '<div class="cred-field"><div class="cred-label">Генерация IV</div><div class="cred-value">crypto.getRandomValues() (CSPRNG)</div></div>' +
    '<div class="cred-field"><div class="cred-label">Хранение ключа</div><div class="cred-value">Non-extractable CryptoKey</div></div>' +
    '<div class="cred-field"><div class="cred-label">Формат хранилища</div><div class="cred-value">' + (vaultFormat === 'v2' ? 'v2 (Web Crypto API)' : 'v1 (устаревший)') + '</div></div>' +
    '<div class="cred-field"><div class="cred-label">Автоблокировка</div><div class="cred-value">5 мин бездействия / 30 мин TTL ключа / при уходе в фон</div></div>' +
    '<div class="cred-field"><div class="cred-label">Защита от брутфорса</div><div class="cred-value">5 попыток, затем блокировка 15 мин</div></div>' +
    '<div class="cred-field"><div class="cred-label">Очистка буфера</div><div class="cred-value">Через 30 секунд после копирования</div></div>' +
    '<div class="cred-field"><div class="cred-label">Сравнение хэшей</div><div class="cred-value">Constant-time (защита от timing-атак)</div></div>' +
    '<div class="cred-field"><div class="cred-label">Данные</div><div class="cred-value">Локально на устройстве + облако (опционально)</div></div>' +
    '<div class="cred-field"><div class="cred-label">CSP</div><div class="cred-value">Content-Security-Policy включена</div></div>' +
  '</div>';
  openModal('modal-security');
}

function showAbout() {
  openModal('modal-about');
}

// ===== Password Health Check =====

async function showPasswordHealth() {
  if (!state.masterKey) {
    showToast('Сначала разблокируйте хранилище');
    return;
  }
  try {
    const vault = await loadVault();
    const allSvc = await getAllServices();
    const creds = vault.credentials || {};
    const credKeys = Object.keys(creds);

    if (credKeys.length === 0) {
      showToast('Хранилище пусто');
      return;
    }

    // Evaluate each credential
    const items = [];
    const passwordMap = {}; // password -> [svcId, ...] for duplicate detection
    const weakWarnings = [];
    const duplicateWarnings = [];
    const oldWarnings = [];
    const now = Date.now();
    const OLD_THRESHOLD = 180 * 24 * 60 * 60 * 1000; // 180 days in ms

    credKeys.forEach(svcId => {
      const cred = creds[svcId];
      const svc = allSvc.find(s => s.id === svcId);
      const strength = evaluatePasswordStrength(cred.password);

      items.push({
        svcId,
        displayName: svc ? svc.displayName : svcId,
        iconEmoji: svc ? svc.iconEmoji : '🔑',
        username: cred.username || '',
        strength,
        updatedAt: cred.updatedAt || null
      });

      // Track duplicates
      if (!passwordMap[cred.password]) passwordMap[cred.password] = [];
      passwordMap[cred.password].push(svcId);

      // Weak password warning
      if (strength.score <= 1) {
        weakWarnings.push(svcId);
      }

      // Old password warning
      if (cred.updatedAt && (now - cred.updatedAt > OLD_THRESHOLD)) {
        const daysSince = Math.floor((now - cred.updatedAt) / (24 * 60 * 60 * 1000));
        oldWarnings.push({ svcId, daysSince });
      }
    });

    // Find duplicate passwords
    Object.entries(passwordMap).forEach(([pw, svcIds]) => {
      if (svcIds.length > 1) {
        duplicateWarnings.push({ password: pw, svcIds });
      }
    });

    const duplicateSvcIdSet = new Set();
    duplicateWarnings.forEach(dw => dw.svcIds.forEach(id => duplicateSvcIdSet.add(id)));

    // Overall health score: percentage of passwords with score >= 3
    const strongCount = items.filter(i => i.strength.score >= 3).length;
    const healthPercent = Math.round((strongCount / items.length) * 100);

    // Strength dot + label helper
    const strengthDot = (s) => `<span style="color:${s.color};font-size:14px">●</span> <span style="font-size:12px;color:var(--text-secondary)">${escHtml(s.label)}</span>`;

    // Build credential list items
    const listHtml = items.map(item => {
      const isWeak = item.strength.score <= 1;
      const isDuplicate = duplicateSvcIdSet.has(item.svcId);
      const isOld = oldWarnings.some(ow => ow.svcId === item.svcId);
      let bgColor = '';
      if (isWeak) bgColor = 'background:rgba(239,68,68,0.08);';
      else if (isDuplicate) bgColor = 'background:rgba(245,158,11,0.08);';

      let badges = '';
      if (isWeak) badges += '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(239,68,68,0.15);color:#ef4444;margin-left:4px">Слабый</span>';
      if (isDuplicate) badges += '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(245,158,11,0.15);color:#f59e0b;margin-left:4px">Дубликат</span>';
      if (isOld) badges += '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(107,114,128,0.15);color:#6b7280;margin-left:4px">Устарел</span>';

      return `<div class="cred-field" style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:6px;${bgColor}">
        <div style="font-size:20px">${item.iconEmoji}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;display:flex;align-items:center;flex-wrap:wrap;gap:4px">${escHtml(item.displayName)}${badges}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${escHtml(item.username)}</div>
        </div>
        <div style="flex-shrink:0">${strengthDot(item.strength)}</div>
      </div>`;
    }).join('');

    // Build warnings section
    let warningsHtml = '';
    if (weakWarnings.length > 0 || duplicateWarnings.length > 0 || oldWarnings.length > 0) {
      warningsHtml = '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">';
      warningsHtml += '<div style="font-size:14px;font-weight:700;margin-bottom:8px">⚠️ Предупреждения</div>';

      if (weakWarnings.length > 0) {
        warningsHtml += `<div style="font-size:12px;color:#ef4444;margin-bottom:4px">🔒 Слабые пароли (${weakWarnings.length}): ${weakWarnings.map(id => {
          const svc = allSvc.find(s => s.id === id);
          return escHtml(svc ? svc.displayName : id);
        }).join(', ')}</div>`;
      }

      if (duplicateWarnings.length > 0) {
        duplicateWarnings.forEach(dw => {
          warningsHtml += `<div style="font-size:12px;color:#f59e0b;margin-bottom:4px">🔄 Одинаковый пароль: ${dw.svcIds.map(id => {
            const svc = allSvc.find(s => s.id === id);
            return escHtml(svc ? svc.displayName : id);
          }).join(', ')}</div>`;
        });
      }

      if (oldWarnings.length > 0) {
        oldWarnings.forEach(ow => {
          const svc = allSvc.find(s => s.id === ow.svcId);
          warningsHtml += `<div style="font-size:12px;color:#6b7280;margin-bottom:4px">⏰ Не обновлён ${ow.daysSince} дн.: ${escHtml(svc ? svc.displayName : ow.svcId)}</div>`;
        });
      }

      warningsHtml += '</div>';
    }

    // Health score color
    const scoreColor = healthPercent >= 75 ? '#22c55e' : healthPercent >= 50 ? '#f59e0b' : '#ef4444';

    const body = document.getElementById('password-health-body');
    body.innerHTML = `
      <div style="text-align:center;padding:8px 0 16px">
        <div style="font-size:48px;font-weight:800;color:${scoreColor}">${healthPercent}%</div>
        <div style="font-size:14px;font-weight:600;margin-top:4px">Общая оценка безопасности</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${strongCount} из ${items.length} паролей — надёжные</div>
      </div>
      ${listHtml}
      ${warningsHtml}
    `;

    openModal('modal-password-health');
    await auditLog('password_health', null, `Health check: ${healthPercent}% (${strongCount}/${items.length} strong)`, 'success');
  } catch(e) {
    showToast('Ошибка проверки паролей');
    console.error('Password health error:', e);
  }
}

// ===== Auto-lock Settings =====

function showAutoLockSettings() {
  const currentAutoLockMs = state.AUTO_LOCK_MS || 5 * 60 * 1000;
  const currentTTLms = state.MASTER_KEY_TTL_MS || 30 * 60 * 1000;

  const timeoutOptions = [
    { value: 1 * 60 * 1000, label: '1 мин' },
    { value: 3 * 60 * 1000, label: '3 мин' },
    { value: 5 * 60 * 1000, label: '5 мин' },
    { value: 10 * 60 * 1000, label: '10 мин' },
    { value: 15 * 60 * 1000, label: '15 мин' }
  ];
  const ttlOptions = [
    { value: 15 * 60 * 1000, label: '15 мин' },
    { value: 30 * 60 * 1000, label: '30 мин' },
    { value: 60 * 60 * 1000, label: '60 мин' }
  ];

  const timeoutIdx = timeoutOptions.findIndex(o => o.value === currentAutoLockMs);
  const ttlIdx = ttlOptions.findIndex(o => o.value === currentTTLms);

  const body = document.getElementById('autolock-body');
  body.innerHTML = `
    <div style="padding:8px 0">
      <div style="text-align:center;margin-bottom:16px">
        <div style="font-size:32px">🔒</div>
        <div style="font-size:16px;font-weight:700;margin-top:4px">Автоблокировка</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Настройте таймауты автоматической блокировки</div>
      </div>

      <div class="form-group">
        <label style="display:flex;justify-content:space-between;align-items:center">
          <span>Блокировка при бездействии</span>
          <span id="autolock-timeout-label" style="font-size:13px;color:var(--accent);font-weight:600">${timeoutOptions[Math.max(0, timeoutIdx)].label}</span>
        </label>
        <input type="range" id="autolock-timeout-slider" min="0" max="${timeoutOptions.length - 1}" value="${Math.max(0, timeoutIdx)}" style="width:100%;accent-color:var(--accent)">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:2px">
          ${timeoutOptions.map(o => `<span>${o.label}</span>`).join('')}
        </div>
      </div>

      <div class="form-group" style="margin-top:20px">
        <label style="display:flex;justify-content:space-between;align-items:center">
          <span>Время жизни мастер-ключа</span>
          <span id="autolock-ttl-label" style="font-size:13px;color:var(--accent);font-weight:600">${ttlOptions[Math.max(0, ttlIdx)].label}</span>
        </label>
        <input type="range" id="autolock-ttl-slider" min="0" max="${ttlOptions.length - 1}" value="${Math.max(0, ttlIdx)}" style="width:100%;accent-color:var(--accent)">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:2px">
          ${ttlOptions.map(o => `<span>${o.label}</span>`).join('')}
        </div>
      </div>

      <button class="btn btn-primary" style="width:100%;margin-top:20px" onclick="saveAutoLockSettings()">💾 Сохранить настройки</button>
    </div>
  `;

  // Wire up slider labels
  const timeoutSlider = document.getElementById('autolock-timeout-slider');
  const ttlSlider = document.getElementById('autolock-ttl-slider');

  timeoutSlider.addEventListener('input', () => {
    const idx = parseInt(timeoutSlider.value);
    document.getElementById('autolock-timeout-label').textContent = timeoutOptions[idx].label;
  });

  ttlSlider.addEventListener('input', () => {
    const idx = parseInt(ttlSlider.value);
    document.getElementById('autolock-ttl-label').textContent = ttlOptions[idx].label;
  });

  // Store options on window for save handler
  window._autoLockTimeoutOptions = timeoutOptions;
  window._autoLockTTLOptions = ttlOptions;

  openModal('modal-autolock');
}

function saveAutoLockSettings() {
  const timeoutIdx = parseInt(document.getElementById('autolock-timeout-slider').value);
  const ttlIdx = parseInt(document.getElementById('autolock-ttl-slider').value);

  const timeoutOptions = window._autoLockTimeoutOptions;
  const ttlOptions = window._autoLockTTLOptions;

  const autoLockMs = timeoutOptions[timeoutIdx].value;
  const ttlMs = ttlOptions[ttlIdx].value;

  state.AUTO_LOCK_MS = autoLockMs;
  state.MASTER_KEY_TTL_MS = ttlMs;

  localStorage.setItem('pv_auto_lock_ms', String(autoLockMs));
  localStorage.setItem('pv_master_key_ttl_ms', String(ttlMs));

  closeModal('modal-autolock');
  showToast('Настройки автоблокировки сохранены');
  auditLog('autolock_settings', null, `Timeout: ${timeoutOptions[timeoutIdx].label}, TTL: ${ttlOptions[ttlIdx].label}`, 'success');
}

// ===== Cloud Sync =====

function showCloudSettings() {
  const body = document.getElementById('cloud-settings-body');
  const config = getFirebaseConfig();
  const configured = !!(config && config.apiKey);

  body.innerHTML = `
    <div style="text-align:center;padding:8px 0 16px">
      <div style="font-size:40px">☁️</div>
      <div style="font-size:16px;font-weight:700;margin-top:4px">Облачная синхронизация</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Данные шифруются перед отправкой. Сервер не видит пароли.</div>
    </div>

    <div class="form-group">
      <label>Firebase API Key</label>
      <input type="text" id="fb-apiKey" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:14px;outline:none" placeholder="AIzaSy..." value="${escHtml(config?.apiKey || '')}">
    </div>
    <div class="form-group">
      <label>Firebase Auth Domain</label>
      <input type="text" id="fb-authDomain" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:14px;outline:none" placeholder="my-project.firebaseapp.com" value="${escHtml(config?.authDomain || '')}">
    </div>
    <div class="form-group">
      <label>Firebase Project ID</label>
      <input type="text" id="fb-projectId" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:14px;outline:none" placeholder="my-project-id" value="${escHtml(config?.projectId || '')}">
    </div>
    <div class="form-group">
      <label>Storage Bucket (необязательно)</label>
      <input type="text" id="fb-storageBucket" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:14px;outline:none" placeholder="my-project.appspot.com" value="${escHtml(config?.storageBucket || '')}">
    </div>
    <div class="form-group">
      <label>Messaging Sender ID (необязательно)</label>
      <input type="text" id="fb-messagingSenderId" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:14px;outline:none" placeholder="123456789" value="${escHtml(config?.messagingSenderId || '')}">
    </div>
    <div class="form-group">
      <label>App ID (необязательно)</label>
      <input type="text" id="fb-appId" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:14px;outline:none" placeholder="1:123:web:abc" value="${escHtml(config?.appId || '')}">
    </div>

    <button class="btn btn-primary" onclick="saveCloudConfig()" style="margin-bottom:12px">💾 Сохранить конфигурацию</button>

    <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:8px">
      <div style="font-size:14px;font-weight:700;margin-bottom:12px">Аккаунт</div>
      <div id="cloud-auth-status" style="margin-bottom:12px">
        ${isCloudAuthenticated() ? '<div style="color:var(--accent);font-size:13px">✓ Авторизован</div>' : '<div style="color:var(--text-muted);font-size:13px">Не авторизован</div>'}
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="cloud-email" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none" placeholder="user@example.com">
      </div>
      <div class="form-group">
        <label>Пароль</label>
        <input type="password" id="cloud-password" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none" placeholder="Пароль облака (минимум 6 символов)">
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" style="flex:1" onclick="doCloudRegister()">Регистрация</button>
        <button class="btn btn-primary btn-sm" style="flex:1" onclick="doCloudLogin()">Войти</button>
      </div>
      ${isCloudAuthenticated() ? '<button class="btn btn-outline btn-sm" style="width:100%;margin-top:8px" onclick="doCloudLogout()">🚪 Выйти из облака</button>' : ''}
    </div>

    <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:16px">
      <div style="font-size:14px;font-weight:700;margin-bottom:12px">Синхронизация</div>
      <div id="cloud-sync-status" style="margin-bottom:12px;font-size:13px;color:var(--text-muted)">Загрузка статуса...</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" style="flex:1" onclick="doCloudUpload()">⬆️ Загрузить в облако</button>
        <button class="btn btn-outline btn-sm" style="flex:1" onclick="doCloudDownload()">⬇️ Скачать из облака</button>
      </div>
    </div>
  `;

  openModal('modal-cloud-settings');

  // Load cloud status
  if (isCloudConfigured() && isCloudAuthenticated()) {
    cloudStatus().then(status => {
      const el = document.getElementById('cloud-sync-status');
      if (el) {
        if (status.hasCloudData) {
          el.innerHTML = `<span style="color:var(--accent)">✓ Облачная копия существует</span><br>Последняя синхронизация: ${escHtml(status.lastSyncAt || 'Неизвестно')}`;
        } else {
          el.innerHTML = '<span style="color:var(--warning)">Облачная копия не найдена</span>';
        }
      }
    }).catch(() => {
      const el = document.getElementById('cloud-sync-status');
      if (el) el.textContent = 'Не удалось подключиться к облаку';
    });
  } else {
    const el = document.getElementById('cloud-sync-status');
    if (el) el.textContent = 'Настройте Firebase и авторизуйтесь';
  }
}

async function saveCloudConfigFn() {
  const config = {
    apiKey: document.getElementById('fb-apiKey').value.trim(),
    authDomain: document.getElementById('fb-authDomain').value.trim(),
    projectId: document.getElementById('fb-projectId').value.trim(),
    storageBucket: document.getElementById('fb-storageBucket').value.trim(),
    messagingSenderId: document.getElementById('fb-messagingSenderId').value.trim(),
    appId: document.getElementById('fb-appId').value.trim()
  };

  if (!config.apiKey || !config.projectId) {
    showToast('Заполните минимум API Key и Project ID');
    return;
  }

  saveFirebaseConfig(config);
  const result = await initFirebase(config);
  if (result.success) {
    showToast('Firebase настроен!');
    auditLog('cloud_config', null, null, 'success');
  } else {
    showToast('Ошибка Firebase: ' + (result.error || ''));
  }
}

async function doCloudRegisterFn() {
  const email = document.getElementById('cloud-email').value.trim();
  const password = document.getElementById('cloud-password').value;
  if (!email || !password) { showToast('Заполните email и пароль'); return; }
  const result = await cloudRegister(email, password);
  if (result.success) {
    showToast('Регистрация успешна!');
    showCloudSettings(); // refresh UI
  } else {
    showToast(result.error || 'Ошибка регистрации');
  }
}

async function doCloudLoginFn() {
  const email = document.getElementById('cloud-email').value.trim();
  const password = document.getElementById('cloud-password').value;
  if (!email || !password) { showToast('Заполните email и пароль'); return; }
  const result = await cloudLogin(email, password);
  if (result.success) {
    showToast('Вход выполнен!');
    showCloudSettings(); // refresh UI
  } else {
    showToast(result.error || 'Ошибка входа');
  }
}

async function doCloudLogoutFn() {
  await cloudLogout();
  showToast('Вы вышли из облака');
  showCloudSettings();
}

async function doCloudUploadFn() {
  if (!state.masterKey) { showToast('Сначала разблокируйте хранилище'); return; }
  showToast('Загрузка в облако...');
  const result = await cloudUpload();
  if (result.success) {
    showToast('✓ Данные загружены в облако');
  } else {
    showToast(result.error || 'Ошибка загрузки');
  }
}

async function doCloudDownloadFn() {
  showConfirm('Скачать из облака?', 'Локальные данные будут заменены данными из облака. Продолжить?', 'Скачать', async () => {
    const result = await cloudDownload();
    if (result.success) {
      showToast('✓ Данные скачаны. Разблокируйте хранилище.');
      lockVault();
    } else {
      showToast(result.error || 'Ошибка загрузки');
    }
  });
}

// Make globally available for onclick handlers
window.exportVault = exportVault;
window.triggerImportVault = triggerImportVault;
window.handleImportFile = handleImportFile;
window.openAddCustomService = openAddCustomService;
window.saveCustomService = saveCustomService;
window.showAuditLog = showAuditLog;
window.showSecurityInfo = showSecurityInfo;
window.showAbout = showAbout;
window.lockVault = lockVault;
window.showCloudSettings = showCloudSettings;
window.saveCloudConfig = saveCloudConfigFn;
window.doCloudRegister = doCloudRegisterFn;
window.doCloudLogin = doCloudLoginFn;
window.doCloudLogout = doCloudLogoutFn;
window.doCloudUpload = doCloudUploadFn;
window.doCloudDownload = doCloudDownloadFn;
window.showPasswordHealth = showPasswordHealth;
window.showAutoLockSettings = showAutoLockSettings;
window.saveAutoLockSettings = saveAutoLockSettings;

export {
  exportVault, triggerImportVault, handleImportFile, doImportVault,
  openAddCustomService, saveCustomService,
  showAuditLog, showSecurityInfo, showAbout, showCloudSettings,
  showPasswordHealth, showAutoLockSettings
};
