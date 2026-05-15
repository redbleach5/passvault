/**
 * ui/vault.js — Dashboard, service cards, search, detail view, add credential
 */

import { state } from '../state.js';
import { SERVICES, CATEGORIES } from '../services.js';
import { encrypt, decryptData, generatePasswordString, evaluatePasswordStrength } from '../crypto.js';
import { auditLog } from '../audit.js';
import { syncToSecureStorage } from '../storage.js';
import {
  showScreen, showToast, updateStrengthMeter, catBadge,
  openModal, closeModal, showConfirm,
  maskPassword, escHtml, escAttr, copyToClipboard, toggleVis
} from '../ui.js';
import { lockVault, startAutoLock } from './screens.js';
import { getCachedIcon } from '../icons.js';
import { saveAutofillCredential, removeAutofillCredential, syncAllAutofillCredentials } from '../autofill.js';
import { setLocalModifiedTimestamp } from '../conflicts.js';

// ===== Data helpers =====

async function getAllServices() {
  let custom = [];
  try { custom = await loadCustomServices(); } catch(e) {}
  return [...SERVICES, ...custom];
}

function getServiceById(id) {
  const builtin = SERVICES.find(s => s.id === id);
  if (builtin) return builtin;
  try {
    const raw = localStorage.getItem('pv_custom_services');
    if (raw) {
      try { const arr = JSON.parse(raw); const found = arr.find(s => s.id === id); if (found) return found; } catch(e) {}
    }
  } catch(e) {}
  return null;
}

async function getServiceByIdAsync(id) {
  const builtin = SERVICES.find(s => s.id === id);
  if (builtin) return builtin;
  const all = await getAllServices();
  return all.find(s => s.id === id);
}

async function saveVault(vaultData) {
  const json = JSON.stringify(vaultData);
  const enc = await encrypt(json, state.masterKey);
  localStorage.setItem('pv_vault', enc);
  // Update local modified timestamp for conflict detection
  try { setLocalModifiedTimestamp(); } catch(e) {}
  // Sync to secure storage immediately on mobile to prevent data loss on resume
  try { await syncToSecureStorage(); } catch(e) {}
}

async function loadVault() {
  const enc = localStorage.getItem('pv_vault');
  if (!enc) return { credentials: {} };
  const json = await decryptData(enc, state.masterKey);
  if (!json) return { credentials: {} };
  try { return JSON.parse(json); } catch(e) { return { credentials: {} }; }
}

async function saveCustomServices(svcs) {
  if (state.masterKey) {
    const enc = await encrypt(JSON.stringify(svcs), state.masterKey);
    localStorage.setItem('pv_custom_services', enc);
  } else {
    localStorage.setItem('pv_custom_services', JSON.stringify(svcs));
  }
  // Sync to secure storage immediately on mobile to prevent data loss on resume
  try { await syncToSecureStorage(); } catch(e) {}
}

async function loadCustomServices() {
  const raw = localStorage.getItem('pv_custom_services');
  if (!raw) return [];
  if (state.masterKey) {
    const dec = await decryptData(raw, state.masterKey);
    if (dec) { try { return JSON.parse(dec); } catch(e) {} }
  }
  try { return JSON.parse(raw); } catch(e) { return []; }
}

// ===== Dashboard =====

async function renderDashboard() {
  try {
    const vault = await loadVault();
    const allServices = await getAllServices();
    const search = ((document.getElementById('search-input') || {}).value || '').toLowerCase();

    const credKeys = Object.keys(vault.credentials);
    const credCount = credKeys.length;

    // Password health score: percentage of passwords with score >= 3 (Good/Excellent)
    let goodCount = 0;
    let evaluatedCount = 0;
    credKeys.forEach(key => {
      const pw = (vault.credentials[key] || {}).password;
      if (pw) {
        const strength = evaluatePasswordStrength(pw);
        evaluatedCount++;
        if (strength.score >= 3) goodCount++;
      }
    });
    const healthPct = evaluatedCount > 0 ? Math.round((goodCount / evaluatedCount) * 100) : 0;
    const healthColor = healthPct >= 75 ? '#22c55e' : healthPct >= 50 ? '#f59e0b' : '#ef4444';

    // Services without credentials
    const svcIdsWithCreds = new Set(credKeys);
    const withoutCredCount = allServices.filter(s => !svcIdsWithCreds.has(s.id)).length;

    document.getElementById('stats-row').innerHTML = `
      <div class="stat-card"><div class="stat-num">${credCount}</div><div class="stat-label">Сохранено</div></div>
      <div class="stat-card"><div class="stat-num" style="color:${healthColor};text-shadow:0 0 16px ${healthColor}40">${healthPct}%</div><div class="stat-label">Здоровье</div></div>
      <div class="stat-card"><div class="stat-num">${withoutCredCount}</div><div class="stat-label">Без пароля</div></div>
    `;

    const cats = ['all', ...Object.keys(CATEGORIES)];
    const catLabels = { all:'Все', ...Object.fromEntries(Object.entries(CATEGORIES).map(([k,v])=>[k,v.name])) };
    document.getElementById('chips-row').innerHTML = cats.map(c =>
      `<div class="chip ${state.currentCategory===c?'active':''}" onclick="setCategory('${c}')">${catLabels[c]}</div>`
    ).join('');

    let filtered = allServices;
    if (state.currentCategory !== 'all') filtered = filtered.filter(s => s.category === state.currentCategory);
    if (search) filtered = filtered.filter(s => s.name.toLowerCase().includes(search) || s.displayName.toLowerCase().includes(search));

    if (filtered.length === 0 && credCount === 0) {
      // First-time user — helpful empty state with action
      document.getElementById('cards-list').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔐</div>
          <h3>Начните добавлять пароли</h3>
          <p>Нажмите + чтобы сохранить первый пароль</p>
          <button class="btn btn-primary" onclick="openAddCredential()" style="margin-top:16px;max-width:280px;">Добавить первый сервис</button>
        </div>`;
      return;
    }

    if (filtered.length === 0) {
      document.getElementById('cards-list').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <h3>Ничего не найдено</h3>
          <p>Попробуйте другой запрос или категорию</p>
        </div>`;
      return;
    }

    document.getElementById('cards-list').innerHTML = filtered.map(svc => {
      const cred = vault.credentials[svc.id];
      const safeId = escHtml(svc.id);
      const cachedIcon = getCachedIcon(svc.id);
      const iconHtml = cachedIcon
        ? `<img src="${cachedIcon}" alt="${escHtml(svc.displayName)}" style="width:32px;height:32px;border-radius:6px;object-fit:contain;" onerror="this.style.display='none';this.parentNode.textContent='${svc.iconEmoji}'">`
        : svc.iconEmoji;
      if (cred) {
        const strength = evaluatePasswordStrength(cred.password);
        const dotColor = strength.score >= 3 ? '#22c55e' : strength.score === 2 ? '#f59e0b' : '#ef4444';
        return `<div class="svc-card fade-in" data-action="detail" data-svc="${safeId}">
          <div class="svc-icon">${iconHtml}</div>
          <div class="svc-info">
            <div class="svc-name">${escHtml(svc.displayName)} ${catBadge(svc.category)}</div>
            <div class="svc-detail"><span style="color:${dotColor};margin-right:4px;">●</span>${escHtml(cred.username)} \u00b7 ${escHtml(maskPassword(cred.password))}</div>
          </div>
          <button class="svc-action-btn" style="font-size:12px;padding:4px 8px;" data-action="quick-copy-pw" data-svc="${safeId}" title="Скопировать пароль">📋</button>
        </div>`;
      } else {
        return `<div class="svc-card fade-in" data-action="add-for" data-svc="${safeId}">
          <div class="svc-icon">${iconHtml}</div>
          <div class="svc-info">
            <div class="svc-name">${escHtml(svc.displayName)} ${catBadge(svc.category)}</div>
            <div class="svc-detail">Нет учётных данных</div>
          </div>
          <button class="svc-action-btn">+ Добавить</button>
        </div>`;
      }
    }).join('');

    document.getElementById('cards-list').onclick = function(e) {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      const svcId = el.dataset.svc;
      if (action === 'quick-copy-pw') {
        e.stopPropagation();
        const cred = vault.credentials[svcId];
        if (cred) {
          copyToClipboard(cred.password, el);
          auditLog('copy_password', svcId, null, 'success');
        }
        return;
      }
      if (action === 'detail') openDetail(svcId);
      else if (action === 'add-for') openAddCredentialFor(svcId);
    };
  } catch(e) {
    console.error('renderDashboard error:', e);
    // Show fallback UI instead of blank screen
    const cardsList = document.getElementById('cards-list');
    const statsRow = document.getElementById('stats-row');
    if (statsRow) {
      statsRow.innerHTML = '<div class="stat-card"><div class="stat-num">0</div><div class="stat-label">Сохранено</div></div><div class="stat-card"><div class="stat-num">—</div><div class="stat-label">Здоровье</div></div><div class="stat-card"><div class="stat-num">24</div><div class="stat-label">Без пароля</div></div>';
    }
    if (cardsList) {
      cardsList.innerHTML = '<div class="empty-state"><div class="empty-icon">🔐</div><h3>Начните добавлять пароли</h3><p>Нажмите + чтобы сохранить первый пароль</p><button class="btn btn-primary" onclick="openAddCredential()" style="margin-top:16px;max-width:280px;">Добавить сервис</button></div>';
    }
  }
}

function setCategory(cat) {
  state.currentCategory = cat;
  renderDashboard();
}

// ===== Service Detail =====

async function openDetail(svcId) {
  state.currentDetailServiceId = svcId;
  const svc = await getServiceByIdAsync(svcId);
  if (!svc) return;
  const vault = await loadVault();
  const cred = vault.credentials[svcId];

  if (cred) state.credMap.set(svcId, cred);

  const detailCachedIcon = getCachedIcon(svcId);
  const detailIconEl = document.getElementById('detail-icon');
  if (detailCachedIcon) {
    detailIconEl.innerHTML = `<img src="${detailCachedIcon}" alt="${escHtml(svc.displayName)}" style="width:40px;height:40px;border-radius:8px;object-fit:contain;">`;
  } else {
    detailIconEl.textContent = svc.iconEmoji;
  }
  document.getElementById('detail-name').textContent = svc.displayName;
  const cat = CATEGORIES[svc.category] || CATEGORIES.custom;
  document.getElementById('detail-cat').innerHTML = `<span style="color:${cat.color}">${escHtml(cat.name)}</span>`;

  let html = '';

  if (cred) {
    html += `
      <div class="cred-field">
        <div class="cred-label">Имя пользователя</div>
        <div class="cred-value-row">
          <div class="cred-value" id="detail-username">${escHtml(cred.username)}</div>
          <button class="cred-btn" data-action="copy-user" data-svc="${escHtml(svcId)}">📋</button>
        </div>
      </div>
      <div class="cred-field">
        <div class="cred-label">Пароль</div>
        <div class="cred-value-row">
          <div class="cred-value" id="detail-password">${escHtml(maskPassword(cred.password))}</div>
          <button class="cred-btn" data-action="toggle-pw" data-svc="${escHtml(svcId)}">👁️</button>
          <button class="cred-btn" data-action="copy-pw" data-svc="${escHtml(svcId)}">📋</button>
        </div>
      </div>`;

    if (cred.notes) {
      html += `<div class="cred-field"><div class="cred-label">Заметки</div><div class="cred-value">${escHtml(cred.notes)}</div></div>`;
    }

    html += `
      <div style="margin-top:16px; display:flex; flex-direction:column; gap:8px;">
        <button class="btn btn-primary" data-action="wizard" data-svc="${escHtml(svcId)}">🔄 Сменить пароль</button>
        ${svc.passwordChangeUrl && svc.passwordChangeUrl.startsWith('https://') ? `<button class="btn btn-outline" data-action="open-url" data-url="${escHtml(svc.passwordChangeUrl)}">🔗 Открыть страницу смены пароля</button>` : ''}
        <button class="btn btn-danger btn-sm" style="margin-top:8px" data-action="delete" data-svc="${escHtml(svcId)}">🗑️ Удалить учётные данные</button>
      </div>`;
  }

  if (svc.instructions && svc.instructions.length > 0) {
    html += `<div style="margin-top:20px;"><div style="font-size:14px;font-weight:700;margin-bottom:8px;">📋 Инструкции по смене пароля</div><ol class="instructions-list">`;
    svc.instructions.forEach((inst, i) => {
      html += `<li><span class="step-num">${i+1}</span><span>${escHtml(inst)}</span></li>`;
    });
    html += `</ol></div>`;
  }

  if (cred && svc.twoFactorNote) {
    html += `<div class="twofa-warning">⚠️ ${escHtml(svc.twoFactorNote)}</div>`;
  }

  document.getElementById('detail-content').innerHTML = html;
  document.getElementById('detail-content').onclick = function(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const clickSvcId = btn.dataset.svc;
    if (action === 'copy-user' && clickSvcId) { const c = state.credMap.get(clickSvcId); if (c) { copyToClipboard(c.username, btn); auditLog('copy_username', clickSvcId, null, 'success'); } }
    else if (action === 'copy-pw' && clickSvcId) { const c = state.credMap.get(clickSvcId); if (c) { copyToClipboard(c.password, btn); auditLog('copy_password', clickSvcId, null, 'success'); } }
    else if (action === 'toggle-pw' && clickSvcId) { const c = state.credMap.get(clickSvcId); if (c) { toggleDetailPw(c.password, btn); auditLog('view_password', clickSvcId, null, 'success'); } }
    else if (action === 'wizard' && clickSvcId) { import('./wizard.js').then(({ startWizard }) => { startWizard(clickSvcId); auditLog('wizard_start', clickSvcId, null, 'success'); }); }
    else if (action === 'delete' && clickSvcId) { deleteCredential(clickSvcId); }
    else if (action === 'open-url') { const url = btn.dataset.url; if (url && url.startsWith('https://')) { window.open(url, '_blank'); auditLog('open_url', clickSvcId, null, 'success'); } }
  };
  showScreen('screen-detail');
}

function toggleDetailPw(pw, btn) {
  state.detailPwVisible = !state.detailPwVisible;
  const el = document.getElementById('detail-password');
  el.textContent = state.detailPwVisible ? pw : maskPassword(pw);
  btn.textContent = state.detailPwVisible ? '🙈' : '👁️';
}

function closeDetail() {
  showScreen('screen-main');
  // Dynamic import to avoid circular dependency
  import('./screens.js').then(({ switchTab }) => switchTab('vault'));
}

async function deleteCredential(svcId) {
  const svc = await getServiceByIdAsync(svcId);
  if (!svc) return;
  showConfirm('Удалить учётные данные?', `Удалить данные для ${svc.displayName}? Это действие нельзя отменить.`, 'Удалить', async () => {
    const vault = await loadVault();
    delete vault.credentials[svcId];
    state.credMap.delete(svcId);
    await saveVault(vault);
    // Remove credential from autofill store
    try { await removeAutofillCredential(svcId); } catch(e) {}
    auditLog('credential_delete', svcId, null, 'success');
    showToast('Удалено');
    closeDetail();
    renderDashboard();
  });
}

// ===== Add Credential =====

async function openAddCredential() {
  const allServices = await getAllServices();
  const body = document.getElementById('add-cred-body');
  body.innerHTML = `
    <div class="form-group" style="margin-bottom:12px">
      <div class="search-wrap">
        <input class="search-input" id="add-cred-search" placeholder="Поиск сервиса..." oninput="filterServicePicker()">
      </div>
    </div>
    <div id="svc-picker-list" style="max-height:300px;overflow-y:auto">
      ${allServices.map(svc => {
        const pickerIcon = getCachedIcon(svc.id);
        const pickerIconHtml = pickerIcon
          ? `<img src="${pickerIcon}" alt="${escHtml(svc.displayName)}" style="width:28px;height:28px;border-radius:4px;object-fit:contain;">`
          : svc.iconEmoji;
        return `
        <div class="svc-picker-item" data-name="${escHtml(svc.name.toLowerCase())}" data-action="select-svc" data-svc="${escHtml(svc.id)}">
          <div class="svc-picker-icon">${pickerIconHtml}</div>
          <div>
            <div class="svc-picker-name">${escHtml(svc.displayName)}</div>
            <div class="svc-picker-cat">${escHtml((CATEGORIES[svc.category]||CATEGORIES.custom).name)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  body.querySelector('#svc-picker-list').onclick = function(e) {
    const item = e.target.closest('[data-action="select-svc"]');
    if (item) selectServiceForAdd(item.dataset.svc);
  };
  openModal('modal-add-cred');
  setTimeout(() => document.getElementById('add-cred-search') && document.getElementById('add-cred-search').focus(), 100);
}

function openAddCredentialFor(svcId) {
  selectServiceForAdd(svcId);
}

function filterServicePicker() {
  const q = document.getElementById('add-cred-search').value.toLowerCase();
  document.querySelectorAll('#svc-picker-list .svc-picker-item').forEach(el => {
    el.style.display = el.dataset.name.includes(q) ? '' : 'none';
  });
}

async function selectServiceForAdd(svcId) {
  const svc = await getServiceByIdAsync(svcId);
  if (!svc) return;
  closeModal('modal-add-cred');
  const body = document.getElementById('add-cred-body');
  body.innerHTML = `
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:44px;margin-bottom:4px">${(() => { const ci = getCachedIcon(svc.id); return ci ? `<img src="${ci}" alt="${escHtml(svc.displayName)}" style="width:44px;height:44px;border-radius:10px;object-fit:contain;">` : svc.iconEmoji; })()}</div>
      <div style="font-size:17px;font-weight:800;letter-spacing:-0.2px">${svc.displayName}</div>
    </div>
    <div class="form-group">
      <label>Имя пользователя / Email</label>
      <input type="text" class="form-input" id="add-username" style="width:100%;padding:14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none;transition:all 0.25s" placeholder="user@example.com">
    </div>
    <div class="form-group">
      <label>Пароль</label>
      <div class="input-wrapper">
        <input type="password" id="add-password" style="width:100%;padding:14px 48px 14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none;transition:all 0.25s" placeholder="Пароль">
        <button class="toggle-vis" onclick="toggleVis('add-password')">👁️</button>
      </div>
      <div class="strength-meter"><div class="strength-meter-fill" id="add-strength-fill"></div></div>
      <div class="strength-text" id="add-strength-text"></div>
    </div>
    <div style="text-align:center;margin-bottom:12px">
      <button class="btn btn-outline btn-sm" onclick="fillGenPw()">🎲 Сгенерировать пароль</button>
    </div>
    <div class="form-group">
      <label>Заметки (необязательно)</label>
      <textarea class="form-textarea" id="add-notes" placeholder="Дополнительная информация..."></textarea>
    </div>
    <button class="btn btn-primary" data-action="save-cred" data-svc="${escHtml(svcId)}">💾 Сохранить</button>
  `;

  body.querySelector('[data-action="save-cred"]').onclick = function() {
    saveCredential(this.dataset.svc);
  };

  document.getElementById('add-password').addEventListener('input', function() {
    updateStrengthMeter('add-password', 'add-strength-fill', 'add-strength-text');
  });

  openModal('modal-add-cred');
}

function fillGenPw() {
  const pw = generatePasswordString(16, { upper:true, lower:true, digits:true, symbols:true, noAmbiguous:false });
  document.getElementById('add-password').value = pw;
  document.getElementById('add-password').type = 'text';
  updateStrengthMeter('add-password', 'add-strength-fill', 'add-strength-text');
}

async function saveCredential(svcId) {
  const username = document.getElementById('add-username').value.trim();
  const password = document.getElementById('add-password').value;
  const notes = document.getElementById('add-notes').value.trim();
  if (!username || !password) { showToast('Заполните все обязательные поля'); return; }
  const vault = await loadVault();
  vault.credentials[svcId] = { username, password, notes, updatedAt: Date.now() };
  await saveVault(vault);
  // Sync credential to autofill service
  try {
    const svc = await getServiceByIdAsync(svcId);
    if (svc) {
      const urls = [svc.loginUrl, svc.passwordChangeUrl].filter(Boolean);
      await saveAutofillCredential(svcId, username, password, urls);
    }
  } catch(e) { /* autofill sync is best-effort */ }
  closeModal('modal-add-cred');
  auditLog('credential_save', svcId, null, 'success');
  showToast('Сохранено!');
  renderDashboard();
}

// Make key functions globally available for onclick handlers
window.setCategory = setCategory;
window.filterServicePicker = filterServicePicker;
window.fillGenPw = fillGenPw;
window.toggleVis = toggleVis;
window.openAddCredential = openAddCredential;

export {
  getAllServices, getServiceById, getServiceByIdAsync,
  saveVault, loadVault, saveCustomServices, loadCustomServices,
  renderDashboard, setCategory,
  openDetail, toggleDetailPw, closeDetail, deleteCredential,
  openAddCredential, openAddCredentialFor, selectServiceForAdd, saveCredential, fillGenPw
};
