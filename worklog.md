# PassVault Bug Fix Worklog

## Date: 2026-05-13

## Summary
Fixed critical bugs preventing the PassVault app from loading and rebuilt the APK.

## Issues Fixed

### 1. Missing SENSITIVE_KEYS in storage.js
**File**: `/home/z/my-project/mobile/www/js/storage.js`
**Problem**: The `SENSITIVE_KEYS` array that controls which localStorage keys are synced to Capacitor Preferences was missing several important keys used throughout the app. This caused data loss on mobile — settings and configuration would not persist across app restarts.

**Missing keys added**:
- `pv_theme_mode` — Used by `screens.js` for theme persistence (dark/light/system)
- `pv_auto_lock_ms` — Auto-lock timeout setting saved by settings.js
- `pv_master_key_ttl_ms` — Master key TTL setting saved by settings.js
- `pv_firebase_config` — Firebase cloud configuration (JSON string)
- `pv_biometric_enabled` — Biometric authentication flag used by biometric.js

### 2. Error boundary added to app.js init()
**File**: `/home/z/my-project/mobile/www/js/app.js`
**Problem**: The `init()` function had no error handling. If any import failed or initialization threw an error, the entire app would show a blank screen with no feedback to the user.

**Fix**: Wrapped the entire `init()` function body in a try-catch. On error, a full-screen error overlay is displayed with:
- Warning icon
- Error message (HTML-escaped inline, not using escHtml which might itself be broken)
- "Reload" button to restart the app

### 3. Removed unused circular-dependency-causing imports in cloud.js
**File**: `/home/z/my-project/mobile/www/js/cloud.js`
**Problem**: `cloud.js` imported from `./ui.js` and `./ui/vault.js` at the top level. This created a potential circular dependency chain:
- `settings.js` → `cloud.js` → `./ui/vault.js` → `./screens.js`
- `app.js` → `settings.js` → `cloud.js` (and also `app.js` → `vault.js`)

**Fix**: Removed the top-level imports of `showToast`/`showConfirm` from `./ui.js` and `loadVault`/`saveVault`/`loadCustomServices`/`saveCustomServices` from `./ui/vault.js`. These imports were **never actually used** in cloud.js — they were dead code that only contributed to circular dependency issues. The cloud sync functions in cloud.js use `localStorage` directly for encrypted data and don't need the vault helper functions.

## Build
- Ran `npx cap sync android` to sync updated web assets
- Built APK with `./gradlew assembleDebug` (BUILD SUCCESSFUL)
- Output: `/home/z/my-project/download/passvault.apk` (7.45 MB)

## Files Modified
1. `/home/z/my-project/mobile/www/js/storage.js` — Added 5 missing SENSITIVE_KEYS
2. `/home/z/my-project/mobile/www/js/app.js` — Added try-catch error boundary in init()
3. `/home/z/my-project/mobile/www/js/cloud.js` — Removed unused circular-dependency imports

## Files NOT Modified (as instructed)
- All native Android Java code
- All other JS files (no syntax errors found)
