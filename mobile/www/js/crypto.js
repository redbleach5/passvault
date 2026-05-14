/**
 * crypto.js — Web Crypto API: AES-256-GCM encryption, PBKDF2 key derivation
 * All cryptographic operations are performed with non-extractable CryptoKey objects.
 */

const PBKDF2_ITERATIONS = 600000;
const SALT_LENGTH = 16;   // bytes
const IV_LENGTH = 12;     // bytes for GCM
const KEY_LENGTH = 256;   // bits

// ===== Encoding utilities =====

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  return bytes.buffer;
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ===== Key derivation =====

/**
 * Derive an AES-256-GCM key and verification hash from a password.
 * Uses PBKDF2-SHA256 with 600,000 iterations.
 * Returns { key: CryptoKey (non-extractable), hash: string, salt: string }
 */
async function deriveKeyAndHash(password, saltHex) {
  const salt = saltHex
    ? new Uint8Array(hexToBuffer(saltHex))
    : crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );

  // Derive 512 bits: 32 bytes for AES key + 32 bytes for verification hash
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    512
  );
  const keyBits = bits.slice(0, 32);
  const hashBits = bits.slice(32, 64);

  // Import as non-extractable AES-GCM key
  const aesKey = await crypto.subtle.importKey(
    'raw', keyBits, { name: 'AES-GCM', length: KEY_LENGTH }, false, ['encrypt', 'decrypt']
  );

  // Securely zero out raw key material from memory
  new Uint8Array(bits).fill(0);
  new Uint8Array(keyBits).fill(0);

  return {
    key: aesKey,  // CryptoKey object, non-extractable!
    hash: bufferToHex(hashBits),
    salt: bufferToHex(salt)
  };
}

// ===== Encrypt / Decrypt =====

/**
 * Encrypt data with AES-256-GCM (authenticated encryption).
 * Format: base64(iv):base64(ciphertext)
 */
async function encrypt(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(data)
  );
  return bufferToBase64(iv) + ':' + bufferToBase64(encrypted);
}

/**
 * Decrypt data with AES-256-GCM.
 * Returns null on failure (tampered or wrong key — GCM verifies automatically).
 */
async function decryptData(encData, key) {
  try {
    const parts = encData.split(':');
    if (parts.length !== 2) return null;
    const iv = base64ToBuffer(parts[0]);
    const ct = base64ToBuffer(parts[1]);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ct
    );
    return new TextDecoder().decode(decrypted);
  } catch(e) {
    return null;
  }
}

// ===== Constant-time comparison =====

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ===== Password strength =====

function evaluatePasswordStrength(pw) {
  if (!pw) return { score: 0, label: '', color: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  if (pw.length >= 16) score++;
  // Deductions
  if (/^[a-z]+$/.test(pw) || /^[0-9]+$/.test(pw) || /^[A-Z]+$/.test(pw)) score = Math.max(score - 2, 0);
  score = Math.min(score, 4);
  const labels = ['', 'Слабый', 'Средний', 'Хороший', 'Отличный'];
  const colors = ['', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4'];
  const widths = ['0%', '25%', '50%', '75%', '100%'];
  return { score, label: labels[score], color: colors[score], width: widths[score] };
}

// ===== Password generation =====

const CHARS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
  ambiguous: 'Il1O0o'
};

function generatePasswordString(length, options) {
  let charset = '';
  if (options.upper) charset += CHARS.upper;
  if (options.lower) charset += CHARS.lower;
  if (options.digits) charset += CHARS.digits;
  if (options.symbols) charset += CHARS.symbols;
  if (!charset) charset = CHARS.lower;
  if (options.noAmbiguous) {
    for (const c of CHARS.ambiguous) {
      charset = charset.split(c).join('');
    }
  }
  let pw = '';
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  for (let i = 0; i < length; i++) {
    pw += charset[arr[i] % charset.length];
  }
  return pw;
}

// ===== Migration from old CryptoJS format =====

async function migrateVaultIfNeeded(aesKey, migratePw) {
  const vaultData = localStorage.getItem('pv_vault');
  if (!vaultData) return;

  // Check if it's new format (base64:base64, 2 parts)
  const parts = vaultData.split(':');
  if (parts.length === 2) return; // Already new format

  // Old format: has 3 parts (hmac:iv:ciphertext) - try to migrate
  try {
    if (typeof CryptoJS !== 'undefined') {
      const salt = localStorage.getItem('pv_salt');
      const pw = migratePw;
      if (!pw) return;

      const oldKey = CryptoJS.PBKDF2(pw, salt, { keySize: 256/32, iterations: 600000, hasher: CryptoJS.algo.SHA256 });
      const oldKeyHex = oldKey.toString();

      let decrypted = null;
      if (parts.length >= 3) {
        const [storedHmac, ivHex, ct] = parts;
        const ciphertext = ivHex + ':' + ct;
        const hmacKey = CryptoJS.HmacSHA256('hmac-key-derivation', CryptoJS.enc.Hex.parse(oldKeyHex)).toString();
        const computedHmac = CryptoJS.HmacSHA256(ciphertext, CryptoJS.enc.Hex.parse(hmacKey)).toString();
        if (constantTimeEqual(storedHmac, computedHmac)) {
          const iv = CryptoJS.enc.Hex.parse(ivHex);
          const dec = CryptoJS.AES.decrypt(ct, CryptoJS.enc.Hex.parse(oldKeyHex), { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
          decrypted = dec.toString(CryptoJS.enc.Utf8);
        }
      }

      if (decrypted) {
        const newEnc = await encrypt(decrypted, aesKey);
        localStorage.setItem('pv_vault', newEnc);
        localStorage.setItem('pv_format', 'v2');
      }

      // Also migrate custom services
      const customRaw = localStorage.getItem('pv_custom_services');
      if (customRaw) {
        try {
          let customDecrypted = null;
          const customParts = customRaw.split(':');
          if (customParts.length >= 3) {
            const [storedHmac, ivHex, ct] = customParts;
            const ciphertext = ivHex + ':' + ct;
            const hmacKey = CryptoJS.HmacSHA256('hmac-key-derivation', CryptoJS.enc.Hex.parse(oldKeyHex)).toString();
            const computedHmac = CryptoJS.HmacSHA256(ciphertext, CryptoJS.enc.Hex.parse(hmacKey)).toString();
            if (constantTimeEqual(storedHmac, computedHmac)) {
              const iv = CryptoJS.enc.Hex.parse(ivHex);
              const dec = CryptoJS.AES.decrypt(ct, CryptoJS.enc.Hex.parse(oldKeyHex), { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
              customDecrypted = dec.toString(CryptoJS.enc.Utf8);
            }
          } else {
            customDecrypted = customRaw;
          }
          if (customDecrypted) {
            const newCustomEnc = await encrypt(customDecrypted, aesKey);
            localStorage.setItem('pv_custom_services', newCustomEnc);
          }
        } catch(e) {}
      }
    }
  } catch(e) {
    console.error('Migration failed:', e);
  }
}

export {
  PBKDF2_ITERATIONS, SALT_LENGTH, IV_LENGTH, KEY_LENGTH,
  hexToBuffer, bufferToHex, bufferToBase64, base64ToBuffer,
  deriveKeyAndHash, encrypt, decryptData, constantTimeEqual,
  evaluatePasswordStrength, generatePasswordString, CHARS,
  migrateVaultIfNeeded
};
