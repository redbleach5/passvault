/**
 * ui/generator.js — Password generator UI
 */

import { state } from '../state.js';
import { generatePasswordString, evaluatePasswordStrength } from '../crypto.js';
import { copyToClipboard } from '../ui.js';

function updateGenLength() {
  document.getElementById('gen-length-val').textContent = document.getElementById('gen-length').value;
}

function toggleGen(id) {
  const btn = document.getElementById(id);
  btn.classList.toggle('on');
  generatePassword();
}

function generatePassword() {
  const length = parseInt(document.getElementById('gen-length').value);
  const options = {
    upper: document.getElementById('gen-upper').classList.contains('on'),
    lower: document.getElementById('gen-lower').classList.contains('on'),
    digits: document.getElementById('gen-digits').classList.contains('on'),
    symbols: document.getElementById('gen-symbols').classList.contains('on'),
    noAmbiguous: document.getElementById('gen-noAmbiguous').classList.contains('on')
  };
  const pw = generatePasswordString(length, options);
  document.getElementById('gen-output').textContent = pw;
  const s = evaluatePasswordStrength(pw);
  document.getElementById('gen-strength-fill').style.width = s.width;
  document.getElementById('gen-strength-fill').style.background = s.color;
  document.getElementById('gen-strength-text').textContent = s.label;
  document.getElementById('gen-strength-text').style.color = s.color;
}

function copyGenPassword() {
  const pw = document.getElementById('gen-output').textContent;
  if (pw && pw !== '—') copyToClipboard(pw);
}

// Make globally available for onclick handlers
window.updateGenLength = updateGenLength;
window.toggleGen = toggleGen;
window.generatePassword = generatePassword;
window.copyGenPassword = copyGenPassword;

export { updateGenLength, toggleGen, generatePassword, copyGenPassword };
