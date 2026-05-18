/**
 * ui/generator.js — Password generator UI
 */

import { state } from '../state.js';
import { generatePasswordString, evaluatePasswordStrength } from '../crypto.js';
import { copyToClipboard } from '../ui.js';

const PRESETS = [
  { label: 'ПИН',         length: 4,  upper: false, lower: false, digits: true,  symbols: false, noAmbiguous: false },
  { label: 'Стандартный', length: 16, upper: true,  lower: true,  digits: true,  symbols: true,  noAmbiguous: false },
  { label: 'Максимальный', length: 24, upper: true,  lower: true,  digits: true,  symbols: true,  noAmbiguous: true  }
];

function renderPresets() {
  const container = document.getElementById('gen-presets');
  if (!container) return;
  container.innerHTML = '';
  PRESETS.forEach((preset, idx) => {
    const chip = document.createElement('button');
    chip.className = 'gen-preset-chip';
    chip.textContent = preset.label;
    chip.type = 'button';
    chip.addEventListener('click', () => applyPreset(preset));
    container.appendChild(chip);
  });
}

function applyPreset(preset) {
  const slider = document.getElementById('gen-length');
  slider.value = preset.length;

  const toggleMap = {
    'gen-upper':      preset.upper,
    'gen-lower':      preset.lower,
    'gen-digits':     preset.digits,
    'gen-symbols':    preset.symbols,
    'gen-noAmbiguous': preset.noAmbiguous
  };

  Object.entries(toggleMap).forEach(([id, on]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (on) {
      btn.classList.add('on');
    } else {
      btn.classList.remove('on');
    }
  });

  updateGenLength();
  generatePassword();
}

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

// Auto-render presets when DOM is ready
document.addEventListener('DOMContentLoaded', renderPresets);

// Make globally available for onclick handlers
window.updateGenLength = updateGenLength;
window.toggleGen = toggleGen;
window.generatePassword = generatePassword;
window.copyGenPassword = copyGenPassword;
window.applyPreset = applyPreset;

export { updateGenLength, toggleGen, generatePassword, copyGenPassword, applyPreset, renderPresets };
