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

## Files NOT Modified (as instructed in previous session)
- All other JS files (no syntax errors found)

---

## Date: 2026-05-13 (Session 2)

## Task ID: PASSVAULT-APK-BUILD-v5.9.0

## Summary
Rebuilt PassVault APK v5.9.0 from scratch with critical biometric plugin fix and upgraded plugin architecture.

## Issues Fixed

### 1. BiometricPlugin — Fixed "crypto-based auth not supported for class 2 biometrics" error
**File**: `/home/z/my-project/mobile/android/app/src/main/java/com/passvault/app/plugins/BiometricPlugin.java` (NEW)
**Problem**: The previous BiometricPlugin stored the AES encryption key in regular SharedPreferences and used manual AES-GCM encryption. This was functional but not using Android's recommended EncryptedSharedPreferences, and the approach was fragile.

**Fix**: Rewrote BiometricPlugin to use `EncryptedSharedPreferences` (Android Keystore-backed) for password storage:
- Uses `MasterKey.KeyScheme.AES256_GCM` for the master key (no `setUserAuthenticationRequired(true)`)
- Uses `EncryptedSharedPreferences` with AES256_SIV key encryption and AES256_GCM value encryption
- Uses simple `BiometricPrompt.authenticate()` without `CryptoObject` — supports both BIOMETRIC_STRONG and BIOMETRIC_WEAK
- After biometric auth succeeds, password is retrieved from EncryptedSharedPreferences
- Added `androidx.security:security-crypto:1.1.0-alpha06` dependency

### 2. Plugin package restructure
**Problem**: Custom plugins were in the root app package (`com.passvault.app`), mixing app code with plugin code.

**Fix**: Moved plugins to dedicated sub-package `com.passvault.app.plugins`:
- `FilePickerPlugin.java` → `com.passvault.app.plugins.FilePickerPlugin`
- `BiometricPlugin.java` → `com.passvault.app.plugins.BiometricPlugin`
- Updated `MainActivity.java` imports accordingly

### 3. Version bump to 5.9.0
**Files**:
- `/home/z/my-project/mobile/package.json` — version 5.8.0 → 5.9.0
- `/home/z/my-project/mobile/android/app/build.gradle` — versionCode 9 → 10, versionName "5.8.0" → "5.9.0"

### 4. Added security-crypto dependency
**File**: `/home/z/my-project/mobile/android/app/build.gradle`
**Change**: Added `implementation "androidx.security:security-crypto:1.1.0-alpha06"` for EncryptedSharedPreferences support.

### 5. Added required Android permissions
**File**: `/home/z/my-project/mobile/android/app/src/main/AndroidManifest.xml`
**Added permissions**:
- `android.permission.USE_BIOMETRIC` — Required for biometric authentication
- `android.permission.READ_EXTERNAL_STORAGE` — Required for file picker import
- `android.permission.WRITE_EXTERNAL_STORAGE` — Required for file export/save

### 6. Removed incompatible dependency
**File**: `/home/z/my-project/mobile/package.json`
**Problem**: `capacitor-secure-storage-plugin@0.10.0` required `@capacitor/core@^6.0.0`, conflicting with `@capacitor/core@^8.3.4`.
**Fix**: Removed from package.json (not needed — we use our own BiometricPlugin with EncryptedSharedPreferences).

## Build Steps
1. Removed incompatible `capacitor-secure-storage-plugin` from package.json
2. Ran `npm install` — 95 packages, 0 vulnerabilities
3. Android platform already existed — kept existing platform
4. Created `com.passvault.app.plugins` package directory
5. Wrote new `FilePickerPlugin.java` and `BiometricPlugin.java` in plugins package
6. Updated `MainActivity.java` with new plugin imports
7. Removed old plugin files from root package
8. Updated `build.gradle` with version 5.9.0 and security-crypto dependency
9. Updated `AndroidManifest.xml` with required permissions
10. Ran `npx cap sync android` — sync successful
11. Built APK with `JAVA_HOME=/tmp/jdk-21.0.2 ./gradlew assembleDebug` — BUILD SUCCESSFUL in 14s
12. Copied APK to `/home/z/my-project/download/passvault.apk` (5.27 MB)

## Files Modified/Created
1. `/home/z/my-project/mobile/package.json` — Version bump, removed incompatible dep
2. `/home/z/my-project/mobile/android/app/src/main/java/com/passvault/app/plugins/FilePickerPlugin.java` — NEW (moved from root package)
3. `/home/z/my-project/mobile/android/app/src/main/java/com/passvault/app/plugins/BiometricPlugin.java` — NEW (rewritten with EncryptedSharedPreferences)
4. `/home/z/my-project/mobile/android/app/src/main/java/com/passvault/app/MainActivity.java` — Updated imports for plugins package
5. `/home/z/my-project/mobile/android/app/build.gradle` — Version 5.9.0, added security-crypto dep
6. `/home/z/my-project/mobile/android/app/src/main/AndroidManifest.xml` — Added USE_BIOMETRIC, READ/WRITE_EXTERNAL_STORAGE permissions

## Files Deleted
1. `/home/z/my-project/mobile/android/app/src/main/java/com/passvault/app/BiometricPlugin.java` — Moved to plugins package
2. `/home/z/my-project/mobile/android/app/src/main/java/com/passvault/app/FilePickerPlugin.java` — Moved to plugins package

## Deliverable
- APK: `/home/z/my-project/download/passvault.apk` (5.27 MB, version 5.9.0)
