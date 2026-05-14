/**
 * ui/wizard.js — Password change wizard (3 steps)
 */

import { state } from '../state.js';
import { generatePasswordString, evaluatePasswordStrength } from '../crypto.js';
import { auditLog } from '../audit.js';
import {
  showScreen, showToast, updateStrengthMeter, toggleVis,
  escHtml, escAttr, maskPassword, copyToClipboard
} from '../ui.js';

function startWizard(svcId) {
  state.wizardServiceId = svcId;
  state.wizardStep = 0;
  state.wizardNewPassword = '';
  showScreen('screen-wizard');
  renderWizardStep();
}

async function closeWizard() {
  showScreen('screen-detail');
  const { openDetail } = await import('./vault.js');
  await openDetail(state.currentDetailServiceId);
}

async function renderWizardStep() {
  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById('wdot-' + i);
    dot.className = 'wizard-dot' + (i === state.wizardStep ? ' active' : i < state.wizardStep ? ' done' : '');
  }

  const { getServiceByIdAsync, loadVault } = await import('./vault.js');
  const svc = await getServiceByIdAsync(state.wizardServiceId);
  if (!svc) return;
  const vault = await loadVault();
  const cred = vault.credentials[state.wizardServiceId];
  const content = document.getElementById('wizard-content');
  const actions = document.getElementById('wizard-actions');

  if (state.wizardStep === 0) {
    content.innerHTML = `
      <div class="wizard-step-title">Шаг 1: Подготовка</div>
      <div class="wizard-step-desc">Введите новый пароль для ${escHtml(svc.displayName)}</div>
      <div class="form-group">
        <label>Новый пароль</label>
        <div class="input-wrapper">
          <input type="password" id="wiz-new-pw" style="width:100%;padding:14px 48px 14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none" placeholder="Введите новый пароль">
          <button class="toggle-vis" onclick="toggleVis('wiz-new-pw')">👁️</button>
        </div>
        <div class="strength-meter"><div class="strength-meter-fill" id="wiz-strength-fill"></div></div>
        <div class="strength-text" id="wiz-strength-text"></div>
      </div>
      <div class="form-group">
        <label>Подтвердите пароль</label>
        <div class="input-wrapper">
          <input type="password" id="wiz-confirm-pw" style="width:100%;padding:14px 48px 14px 16px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:15px;outline:none" placeholder="Повторите пароль">
          <button class="toggle-vis" onclick="toggleVis('wiz-confirm-pw')">👁️</button>
        </div>
        <div class="match-hint" id="wiz-match"></div>
      </div>
      <div style="text-align:center;margin-top:8px">
        <button class="btn btn-outline btn-sm" onclick="wizFillGen()">🎲 Сгенерировать</button>
      </div>`;

    document.getElementById('wiz-new-pw').addEventListener('input', function() {
      updateStrengthMeter('wiz-new-pw', 'wiz-strength-fill', 'wiz-strength-text');
      checkWizMatch();
    });
    document.getElementById('wiz-confirm-pw').addEventListener('input', checkWizMatch);

    actions.innerHTML = `<button class="btn btn-outline" style="flex:1" onclick="closeWizard()">Отмена</button>
      <button class="btn btn-primary" style="flex:1" id="wiz-next-0" onclick="wizardNext()" disabled>Далее →</button>`;
  } else if (state.wizardStep === 1) {
    content.innerHTML = `
      <div class="wizard-step-title">Шаг 2: Смена пароля</div>
      <div class="wizard-step-desc">Следуйте инструкциям для смены пароля на ${escHtml(svc.displayName)}</div>

      ${svc.instructions ? `<div style="margin-bottom:16px"><div style="font-size:14px;font-weight:700;margin-bottom:8px">📋 Инструкции</div>
        <ol class="instructions-list">${svc.instructions.map((inst,i) => `<li><span class="step-num">${i+1}</span><span>${escHtml(inst)}</span></li>`).join('')}</ol>
      </div>` : ''}

      <div style="font-size:14px;font-weight:700;margin-bottom:8px">📋 Данные для копирования</div>
      <div class="copy-field">
        <span class="copy-label">Логин</span>
        <span class="copy-value">${escHtml((cred && cred.username) || '')}</span>
        <button class="copy-btn" onclick="copyToClipboard('${escAttr((cred && cred.username) || '')}')">Копировать</button>
      </div>
      <div class="copy-field">
        <span class="copy-label">Текущий</span>
        <span class="copy-value">${maskPassword((cred && cred.password) || '')}</span>
        <button class="copy-btn" onclick="copyToClipboard('${escAttr((cred && cred.password) || '')}')">Копировать</button>
      </div>
      <div class="copy-field">
        <span class="copy-label">Новый</span>
        <span class="copy-value">${escHtml(state.wizardNewPassword)}</span>
        <button class="copy-btn" onclick="copyToClipboard('${escAttr(state.wizardNewPassword)}')">Копировать</button>
      </div>

      ${svc.passwordChangeUrl ? `<button class="btn btn-outline" style="margin-top:12px" onclick="window.open('${svc.passwordChangeUrl}','_blank')">🔗 Открыть страницу смены пароля</button>` : ''}

      ${svc.twoFactorNote ? `<div class="twofa-warning" style="margin-top:12px">⚠️ ${escHtml(svc.twoFactorNote)}</div>` : ''}`;

    actions.innerHTML = `<button class="btn btn-outline" style="flex:1" onclick="wizardBack()">← Назад</button>
      <button class="btn btn-primary" style="flex:1" onclick="wizardNext()">Далее →</button>`;
  } else if (state.wizardStep === 2) {
    content.innerHTML = `
      <div class="wizard-step-title">Шаг 3: Подтверждение</div>
      <div class="wizard-step-desc">Подтвердите успешную смену пароля на ${escHtml(svc.displayName)}</div>
      <div style="text-align:center;padding:32px 0">
        <div style="font-size:64px;margin-bottom:16px">✅</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:4px">Пароль успешно изменён?</div>
        <div style="font-size:13px;color:var(--text-muted)">Нажмите «Подтвердить», чтобы обновить пароль в хранилище</div>
      </div>`;

    actions.innerHTML = `<button class="btn btn-outline" style="flex:1" onclick="wizardBack()">← Назад</button>
      <button class="btn btn-primary" style="flex:1" onclick="wizardConfirm()">✓ Подтвердить</button>`;
  }
}

function checkWizMatch() {
  const pw1 = document.getElementById('wiz-new-pw').value;
  const pw2 = document.getElementById('wiz-confirm-pw').value;
  const hint = document.getElementById('wiz-match');
  const btn = document.getElementById('wiz-next-0');
  if (!pw2) { hint.textContent = ''; btn.disabled = true; return; }
  if (pw1 === pw2 && pw1.length >= 8) {
    hint.textContent = '✓ Пароли совпадают';
    hint.className = 'match-hint ok';
    btn.disabled = false;
  } else {
    hint.textContent = pw1 !== pw2 ? '✗ Пароли не совпадают' : '✗ Минимум 8 символов';
    hint.className = 'match-hint err';
    btn.disabled = true;
  }
}

function wizFillGen() {
  const pw = generatePasswordString(16, { upper:true, lower:true, digits:true, symbols:true, noAmbiguous:false });
  document.getElementById('wiz-new-pw').value = pw;
  document.getElementById('wiz-new-pw').type = 'text';
  document.getElementById('wiz-confirm-pw').value = pw;
  document.getElementById('wiz-confirm-pw').type = 'text';
  updateStrengthMeter('wiz-new-pw', 'wiz-strength-fill', 'wiz-strength-text');
  checkWizMatch();
}

function wizardNext() {
  if (state.wizardStep === 0) {
    state.wizardNewPassword = document.getElementById('wiz-new-pw').value;
    if (state.wizardNewPassword.length < 8) return;
  }
  state.wizardStep++;
  renderWizardStep();
}

function wizardBack() {
  state.wizardStep--;
  renderWizardStep();
}

async function wizardConfirm() {
  const { loadVault, saveVault } = await import('./vault.js');
  const vault = await loadVault();
  if (vault.credentials[state.wizardServiceId]) {
    vault.credentials[state.wizardServiceId].password = state.wizardNewPassword;
    vault.credentials[state.wizardServiceId].updatedAt = Date.now();
    await saveVault(vault);
  }
  showToast('Пароль обновлён!');
  closeWizard();
  const { renderDashboard } = await import('./vault.js');
  renderDashboard();
}

// Make globally available for onclick handlers
window.startWizard = startWizard;
window.closeWizard = closeWizard;
window.wizardNext = wizardNext;
window.wizardBack = wizardBack;
window.wizardConfirm = wizardConfirm;
window.wizFillGen = wizFillGen;
window.checkWizMatch = checkWizMatch;
window.toggleVis = toggleVis;
window.copyToClipboard = copyToClipboard;

export { startWizard, closeWizard, renderWizardStep, checkWizMatch, wizFillGen, wizardNext, wizardBack, wizardConfirm };
