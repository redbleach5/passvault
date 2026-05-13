/**
 * ui.js — UI utility functions
 * Toast, modal, confirm dialog, screen switching, HTML helpers
 */

import { CATEGORIES } from './services.js';
import { evaluatePasswordStrength } from './crypto.js';

function showScreen(id) {
  document.querySelectorAll('.screen, .auth-screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function toggleVis(inputId) {
  const inp = document.getElementById(inputId);
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

function updateStrengthMeter(inputId, fillId, textId) {
  const pw = document.getElementById(inputId).value;
  const s = evaluatePasswordStrength(pw);
  const fill = document.getElementById(fillId);
  const text = document.getElementById(textId);
  if (fill) { fill.style.width = s.width; fill.style.background = s.color; }
  if (text) { text.textContent = s.label; text.style.color = s.color; }
}

function catBadge(category) {
  const cat = CATEGORIES[category] || CATEGORIES.custom;
  return `<span class="cat-badge" style="background:${cat.color}22;color:${cat.color}">${cat.name}</span>`;
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

function showConfirm(title, text, okText, cb) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('confirm-ok').textContent = okText;
  document.getElementById('confirm-overlay').classList.add('active');
  // Store callback in a way accessible to confirmAction
  window._confirmCallback = cb;
}

function closeConfirm() {
  document.getElementById('confirm-overlay').classList.remove('active');
  window._confirmCallback = null;
}

function confirmAction() {
  if (window._confirmCallback) window._confirmCallback();
  closeConfirm();
}

function maskPassword(pw) {
  if (!pw) return '';
  return '\u2022'.repeat(Math.min(pw.length, 12));
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  if (!s) return '';
  return s.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"');
}

/**
 * Copy to clipboard with auto-clear after 30 seconds.
 */
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) { btn.classList.add('copied'); setTimeout(() => btn.classList.remove('copied'), 1200); }
    showToast('Скопировано! (очищено через 30с)');
    setTimeout(() => {
      navigator.clipboard.readText().then(current => {
        if (current === text) navigator.clipboard.writeText('');
      }).catch(() => {});
    }, 30000);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.value = '';
    document.body.removeChild(ta);
    showToast('Скопировано! (очищено через 30с)');
    setTimeout(() => { try { navigator.clipboard.writeText(''); } catch(e){} }, 30000);
  });
}

export {
  showScreen, showToast, toggleVis, updateStrengthMeter,
  catBadge, openModal, closeModal,
  showConfirm, closeConfirm, confirmAction,
  maskPassword, escHtml, escAttr, copyToClipboard
};
