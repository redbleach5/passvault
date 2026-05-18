/**
 * cloud.js — Firebase Cloud Sync for PassVault
 *
 * Architecture:
 * - User authenticates via email/password (Firebase Auth)
 * - Encrypted vault data is stored in Firestore (user-specific document)
 * - The server NEVER sees unencrypted data — AES-256-GCM encryption
 *   happens client-side BEFORE upload. The master password is never sent.
 * - Sync is manual (button press) to avoid unintended data exposure
 * - Conflict resolution: last-write-wins with timestamp comparison
 */

import { state } from './state.js';
import { encrypt, decryptData } from './crypto.js';
import { auditLog } from './audit.js';
// Lazy imports for ui.js and ui/vault.js to avoid circular dependency issues:
// cloud.js -> ui/vault.js -> ui/screens.js -> storage.js
// and settings.js -> cloud.js -> ui/vault.js (circular via settings)
// These modules are only needed inside functions, not at module load time.

// ===== Firebase SDK (loaded from CDN) =====

let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let currentUser = null;

const FIREBASE_CDN = 'https://cdn.jsdelivr.net/npm/firebase@11.6.0';

/**
 * Lazy-load Firebase SDK modules
 */
async function loadFirebaseSDK() {
  if (window.firebase) return window.firebase;

  return new Promise((resolve, reject) => {
    const loadScript = (src) => new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });

    Promise.all([
      loadScript(`${FIREBASE_CDN}/firebase-app-compat.js`),
      loadScript(`${FIREBASE_CDN}/firebase-auth-compat.js`),
      loadScript(`${FIREBASE_CDN}/firebase-firestore-compat.js`),
    ]).then(() => {
      if (window.firebase) resolve(window.firebase);
      else reject(new Error('Firebase SDK failed to load'));
    }).catch(reject);
  });
}

// ===== Firebase Configuration =====
// These are PUBLIC config values (safe to embed — they identify the project, not secrets)
// User should replace with their own Firebase project config in Settings > Cloud

const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

function getFirebaseConfig() {
  const saved = localStorage.getItem('pv_firebase_config');
  if (saved) {
    try { return JSON.parse(saved); } catch(e) {}
  }
  return null;
}

function saveFirebaseConfig(config) {
  localStorage.setItem('pv_firebase_config', JSON.stringify(config));
}

// ===== Initialize Firebase =====

async function initFirebase(config) {
  try {
    const firebase = await loadFirebaseSDK();

    if (firebaseApp) {
      // Already initialized — delete and re-init if config changed
      firebase.app().delete();
    }

    firebaseApp = firebase.initializeApp(config);
    firebaseAuth = firebase.auth();
    firebaseDb = firebase.firestore();

    // Listen for auth state changes
    firebaseAuth.onAuthStateChanged((user) => {
      currentUser = user;
    });

    return { success: true };
  } catch(e) {
    console.error('Firebase init failed:', e);
    return { success: false, error: e.message };
  }
}

// ===== Authentication =====

async function cloudRegister(email, password) {
  if (!firebaseAuth) {
    const config = getFirebaseConfig();
    if (!config || !config.apiKey) {
      return { success: false, error: 'Сначала настройте Firebase в настройках' };
    }
    const init = await initFirebase(config);
    if (!init.success) return init;
  }

  try {
    const cred = await firebaseAuth.createUserWithEmailAndPassword(email, password);
    currentUser = cred.user;
    await auditLog('cloud_register', null, null, 'success');
    return { success: true, user: cred.user };
  } catch(e) {
    await auditLog('cloud_register', null, e.message, 'failure');
    const errorMessages = {
      'auth/email-already-in-use': 'Этот email уже зарегистрирован',
      'auth/weak-password': 'Пароль слишком слабый (минимум 6 символов)',
      'auth/invalid-email': 'Неверный формат email',
      'auth/network-request-failed': 'Ошибка сети. Проверьте подключение к интернету.'
    };
    return { success: false, error: errorMessages[e.code] || e.message };
  }
}

async function cloudLogin(email, password) {
  if (!firebaseAuth) {
    const config = getFirebaseConfig();
    if (!config || !config.apiKey) {
      return { success: false, error: 'Сначала настройте Firebase в настройках' };
    }
    const init = await initFirebase(config);
    if (!init.success) return init;
  }

  try {
    const cred = await firebaseAuth.signInWithEmailAndPassword(email, password);
    currentUser = cred.user;
    await auditLog('cloud_login', null, null, 'success');
    return { success: true, user: cred.user };
  } catch(e) {
    await auditLog('cloud_login', null, e.message, 'failure');
    const errorMessages = {
      'auth/user-not-found': 'Пользователь не найден',
      'auth/wrong-password': 'Неверный пароль',
      'auth/invalid-email': 'Неверный формат email',
      'auth/network-request-failed': 'Ошибка сети. Проверьте подключение к интернету.',
      'auth/too-many-requests': 'Слишком много попыток. Попробуйте позже.'
    };
    return { success: false, error: errorMessages[e.code] || e.message };
  }
}

async function cloudLogout() {
  if (!firebaseAuth) return;
  try {
    await firebaseAuth.signOut();
    currentUser = null;
    await auditLog('cloud_logout', null, null, 'success');
  } catch(e) {
    console.error('Logout failed:', e);
  }
}

// ===== Cloud Sync =====

/**
 * Upload encrypted vault data to Firestore.
 * Data is ALREADY encrypted client-side — the server never sees plaintext.
 */
async function cloudUpload() {
  if (!firebaseDb || !currentUser) {
    return { success: false, error: 'Не авторизован в облаке' };
  }
  if (!state.masterKey) {
    return { success: false, error: 'Сначала разблокируйте хранилище' };
  }

  try {
    const vaultEnc = localStorage.getItem('pv_vault');
    const customEnc = localStorage.getItem('pv_custom_services');
    const auditEnc = localStorage.getItem('pv_audit');
    const salt = localStorage.getItem('pv_salt');
    const hash = localStorage.getItem('pv_hash');
    const format = localStorage.getItem('pv_format') || 'v2';

    const syncData = {
      vault: vaultEnc || null,
      customServices: customEnc || null,
      auditLog: auditEnc || null,
      salt: salt,
      hash: hash,
      format: format,
      lastSyncAt: firebaseDb.FieldValue.serverTimestamp(),
      version: 2
    };

    await firebaseDb.collection('vaults').doc(currentUser.uid).set(syncData);
    await auditLog('cloud_upload', null, null, 'success');
    return { success: true };
  } catch(e) {
    await auditLog('cloud_upload', null, e.message, 'failure');
    return { success: false, error: 'Ошибка загрузки: ' + e.message };
  }
}

/**
 * Download encrypted vault data from Firestore and REPLACE local data.
 * Data is downloaded ENCRYPTED — needs the master password to decrypt.
 */
async function cloudDownload() {
  if (!firebaseDb || !currentUser) {
    return { success: false, error: 'Не авторизован в облаке' };
  }

  try {
    const doc = await firebaseDb.collection('vaults').doc(currentUser.uid).get();

    if (!doc.exists) {
      return { success: false, error: 'Облачная копия не найдена' };
    }

    const data = doc.data();

    // Validate cloud data before overwriting local
    if (!data.salt || !data.hash) {
      return { success: false, error: 'Облачная копия повреждена: отсутствуют salt или hash' };
    }
    // Verify salt format (must be 32 hex chars = 16 bytes)
    if (!/^[0-9a-f]{32}$/i.test(data.salt)) {
      return { success: false, error: 'Облачная копия повреждена: неверный формат salt' };
    }
    // Verify hash format (must be 64 hex chars = 32 bytes)
    if (!/^[0-9a-f]{64}$/i.test(data.hash)) {
      return { success: false, error: 'Облачная копия повреждена: неверный формат hash' };
    }

    // Save cloud data locally (it's still encrypted)
    if (data.salt) localStorage.setItem('pv_salt', data.salt);
    if (data.hash) localStorage.setItem('pv_hash', data.hash);
    if (data.vault) localStorage.setItem('pv_vault', data.vault);
    if (data.customServices) localStorage.setItem('pv_custom_services', data.customServices);
    if (data.auditLog) localStorage.setItem('pv_audit', data.auditLog);
    if (data.format) localStorage.setItem('pv_format', data.format);

    await auditLog('cloud_download', null, null, 'success');
    return { success: true, timestamp: data.lastSyncAt };
  } catch(e) {
    await auditLog('cloud_download', null, e.message, 'failure');
    return { success: false, error: 'Ошибка загрузки: ' + e.message };
  }
}

/**
 * Get cloud sync status (last sync time, whether data exists)
 */
async function cloudStatus() {
  if (!firebaseDb || !currentUser) {
    return { connected: false, authenticated: false };
  }

  try {
    const doc = await firebaseDb.collection('vaults').doc(currentUser.uid).get();
    if (doc.exists) {
      const data = doc.data();
      return {
        connected: true,
        authenticated: true,
        hasCloudData: true,
        lastSyncAt: data.lastSyncAt ? data.lastSyncAt.toDate().toLocaleString('ru') : 'Неизвестно',
        version: data.version || 1
      };
    }
    return { connected: true, authenticated: true, hasCloudData: false };
  } catch(e) {
    return { connected: false, authenticated: true, error: e.message };
  }
}

// ===== Cloud Settings UI =====

function isCloudConfigured() {
  const config = getFirebaseConfig();
  return !!(config && config.apiKey);
}

function isCloudAuthenticated() {
  return !!currentUser;
}

// Make globally available
window.cloudRegister = cloudRegister;
window.cloudLogin = cloudLogin;
window.cloudLogout = cloudLogout;
window.cloudUpload = cloudUpload;
window.cloudDownload = cloudDownload;
window.cloudStatus = cloudStatus;
window.getFirebaseConfig = getFirebaseConfig;
window.saveFirebaseConfig = saveFirebaseConfig;
window.isCloudConfigured = isCloudConfigured;
window.isCloudAuthenticated = isCloudAuthenticated;

export {
  initFirebase, getFirebaseConfig, saveFirebaseConfig,
  cloudRegister, cloudLogin, cloudLogout,
  cloudUpload, cloudDownload, cloudStatus,
  isCloudConfigured, isCloudAuthenticated
};
