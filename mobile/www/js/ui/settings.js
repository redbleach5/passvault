/**
 * ui/settings.js — Settings, export/import, audit log, security info, custom services
 */

import { state } from '../state.js';
import { SERVICES, CATEGORIES } from '../services.js';
import { PBKDF2_ITERATIONS, evaluatePasswordStrength } from '../crypto.js';
import { auditLog, getAllAuditLogs } from '../audit.js';
import {
  showScreen, showToast, openModal, closeModal, showConfirm,
  escHtml
} from './ui.js';
import { lockVault } from './screens.js';
import { loadVault, saveVault, loadCustomServices, saveCustomServices, getAllServices, renderDashboard } from './vault.js';

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
    '<div class="cred-field"><div class="cred-label">Данные</div><div class="cred-value">Хранятся только локально на устройстве</div></div>' +
    '<div class="cred-field"><div class="cred-label">CSP</div><div class="cred-value">Content-Security-Policy включена</div></div>' +
  '</div>';
  openModal('modal-security');
}

function showAbout() {
  openModal('modal-about');
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

export {
  exportVault, triggerImportVault, handleImportFile, doImportVault,
  openAddCustomService, saveCustomService,
  showAuditLog, showSecurityInfo, showAbout
};
