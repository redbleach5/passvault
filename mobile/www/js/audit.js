/**
 * audit.js — Encrypted activity log
 * All log entries are encrypted with the vault master key (AES-256-GCM).
 * When vault is locked, entries are stored unencrypted as a temporary fallback
 * and migrated to encrypted storage on next unlock.
 */

import { encrypt, decryptData } from './crypto.js';
import { state } from './state.js';

const MAX_AUDIT_ENTRIES = 200;

/**
 * Log an action. If state.masterKey is available, encrypts the log.
 * Otherwise falls back to plaintext (migrated later on unlock).
 */
async function auditLog(action, serviceId, details, result) {
  try {
    const entry = {
      ts: Date.now(),
      action: action,
      svc: serviceId || null,
      detail: details || null,
      result: result || null,
      ua: navigator.userAgent.substring(0, 80) || null,
      platform: navigator.platform || null
    };

    if (state.masterKey) {
      const raw = localStorage.getItem('pv_audit');
      let logs = [];
      if (raw) {
        const dec = await decryptData(raw, state.masterKey);
        if (dec) { try { logs = JSON.parse(dec); } catch(e) { logs = []; } }
      }
      logs.push(entry);
      while (logs.length > MAX_AUDIT_ENTRIES) logs.shift();
      const enc = await encrypt(JSON.stringify(logs), state.masterKey);
      localStorage.setItem('pv_audit', enc);
    } else {
      const logs = JSON.parse(localStorage.getItem('pv_audit_plain') || '[]');
      logs.push(entry);
      while (logs.length > MAX_AUDIT_ENTRIES) logs.shift();
      localStorage.setItem('pv_audit_plain', JSON.stringify(logs));
    }
  } catch(e) {}
}

/**
 * Get all audit logs (encrypted + plain), merge and sort.
 * Migrate plain logs to encrypted if state.masterKey is available.
 */
async function getAllAuditLogs() {
  let encLogs = [];
  let plainLogs = [];
  if (state.masterKey) {
    const raw = localStorage.getItem('pv_audit');
    if (raw) {
      const dec = await decryptData(raw, state.masterKey);
      if (dec) { try { encLogs = JSON.parse(dec); } catch(e) {} }
    }
  }
  try { plainLogs = JSON.parse(localStorage.getItem('pv_audit_plain') || '[]'); } catch(e) {}

  const all = [...encLogs, ...plainLogs].sort((a, b) => b.ts - a.ts);

  // Migrate plain logs to encrypted if we have a key
  if (state.masterKey && plainLogs.length > 0) {
    const merged = [...encLogs, ...plainLogs].sort((a, b) => a.ts - b.ts);
    while (merged.length > MAX_AUDIT_ENTRIES) merged.shift();
    const enc = await encrypt(JSON.stringify(merged), state.masterKey);
    localStorage.setItem('pv_audit', enc);
    localStorage.removeItem('pv_audit_plain');
  }

  return all;
}

export { MAX_AUDIT_ENTRIES, auditLog, getAllAuditLogs };
