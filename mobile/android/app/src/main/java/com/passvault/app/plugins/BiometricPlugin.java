package com.passvault.app.plugins;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.fragment.app.FragmentActivity;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * BiometricPlugin — Capacitor plugin for biometric authentication and secure storage.
 *
 * Uses EncryptedSharedPreferences (Android Keystore-backed) to store the master
 * password, and BiometricPrompt with simple authentication (no CryptoObject) to
 * support both Class 2 (BIOMETRIC_WEAK) and Class 3 (BIOMETRIC_STRONG) biometrics.
 *
 * CRITICAL: We do NOT use setUserAuthenticationRequired(true) on the SecretKey,
 * because that causes "crypto-based authentication is not supported for class 2
 * biometrics" error. Instead, we use BiometricPrompt for simple authentication,
 * then retrieve the password from EncryptedSharedPreferences after auth succeeds.
 *
 * Provides:
 * - isAvailable(): Check if biometric hardware is present and enrolled
 * - authenticate(reason): Show biometric prompt
 * - enable(password): Store master password in EncryptedSharedPreferences
 * - disable(): Remove stored biometric credentials
 * - isEnabled(): Check if biometric unlock is enabled
 * - authenticateAndRetrieve(reason): Show biometric prompt and return stored password on success
 */
@CapacitorPlugin(
    name = "Biometric",
    permissions = {}
)
public class BiometricPlugin extends Plugin {

    private static final String ENCRYPTED_PREFS_NAME = "passvault_biometric_encrypted";
    private static final String KEY_PASSWORD = "pv_master_password";
    private static final String KEY_BIO_ENABLED = "pv_bio_enabled";

    /**
     * Get or create the EncryptedSharedPreferences instance.
     * This uses a MasterKey backed by Android Keystore — no manual
     * key management needed, and no setUserAuthenticationRequired.
     */
    private SharedPreferences getEncryptedPrefs() throws Exception {
        Context context = getContext();
        MasterKey masterKey = new MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build();

        return EncryptedSharedPreferences.create(
            context,
            ENCRYPTED_PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }

    /**
     * Check if biometric authentication is available on this device.
     */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        try {
            Context context = getContext();
            BiometricManager biometricManager = BiometricManager.from(context);

            // Check with biometric authenticators only (STRONG | WEAK).
            // NOTE: DEVICE_CREDENTIAL cannot be OR'd with BIOMETRIC_STRONG/WEAK on Android 11+
            // (throws IllegalArgumentException). We try biometrics first, then fallback to device credential.
            int canAuthenticate = biometricManager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG |
                BiometricManager.Authenticators.BIOMETRIC_WEAK
            );

            // If no biometrics enrolled, check if device credential is available
            if (canAuthenticate != BiometricManager.BIOMETRIC_SUCCESS) {
                int canAuthDeviceCred = biometricManager.canAuthenticate(
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL
                );
                if (canAuthDeviceCred == BiometricManager.BIOMETRIC_SUCCESS) {
                    canAuthenticate = BiometricManager.BIOMETRIC_SUCCESS;
                }
            }

            JSObject result = new JSObject();
            result.put("available", canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS);
            result.put("code", canAuthenticate);

            switch (canAuthenticate) {
                case BiometricManager.BIOMETRIC_SUCCESS:
                    result.put("reason", "Available");
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                    result.put("reason", "No biometric hardware");
                    break;
                case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                    result.put("reason", "Hardware unavailable");
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                    result.put("reason", "No fingerprints enrolled");
                    break;
                default:
                    result.put("reason", "Unknown error");
                    break;
            }

            call.resolve(result);
        } catch (Exception e) {
            JSObject result = new JSObject();
            result.put("available", false);
            result.put("reason", e.getMessage());
            call.resolve(result);
        }
    }

    /**
     * Show biometric authentication prompt (simple auth, no crypto binding).
     * This works with both Class 2 (WEAK) and Class 3 (STRONG) biometrics.
     */
    @PluginMethod
    public void authenticate(PluginCall call) {
        String reason = call.getString("reason", "Confirm your identity");

        try {
            Activity activity = getActivity();
            if (!(activity instanceof FragmentActivity)) {
                call.reject("Activity is not a FragmentActivity");
                return;
            }

            FragmentActivity fragmentActivity = (FragmentActivity) activity;
            Executor executor = Executors.newSingleThreadExecutor();

            BiometricPrompt biometricPrompt = new BiometricPrompt(fragmentActivity,
                executor, new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    call.resolve(ret);
                }

                @Override
                public void onAuthenticationFailed() {
                    // Don't reject yet — user can try again
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence errString) {
                    JSObject ret = new JSObject();
                    ret.put("success", false);
                    ret.put("error", errString != null ? errString.toString() : "Authentication error");
                    ret.put("errorCode", errorCode);
                    call.resolve(ret);
                }
            });

            // Build PromptInfo — try biometrics first. If no biometrics enrolled,
            // fall back to DEVICE_CREDENTIAL only (PIN/pattern/password).
            // CRITICAL: Cannot OR DEVICE_CREDENTIAL with BIOMETRIC_STRONG|WEAK on Android 11+.
            BiometricManager biometricManager = BiometricManager.from(getContext());
            int bioStatus = biometricManager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG |
                BiometricManager.Authenticators.BIOMETRIC_WEAK
            );

            int authenticators;
            if (bioStatus == BiometricManager.BIOMETRIC_SUCCESS) {
                authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG |
                                BiometricManager.Authenticators.BIOMETRIC_WEAK;
            } else {
                authenticators = BiometricManager.Authenticators.DEVICE_CREDENTIAL;
            }

            BiometricPrompt.PromptInfo.Builder promptBuilder = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("PassVault")
                .setSubtitle(reason)
                .setAllowedAuthenticators(authenticators);

            // DEVICE_CREDENTIAL doesn't allow setNegativeButtonText, only biometric modes do
            if ((authenticators & BiometricManager.Authenticators.DEVICE_CREDENTIAL) == 0) {
                promptBuilder.setNegativeButtonText("Отмена");
            }

            BiometricPrompt.PromptInfo promptInfo = promptBuilder.build();

            // Simple authenticate — NO CryptoObject. This is the key fix:
            // Using CryptoObject would require BIOMETRIC_STRONG only and
            // setUserAuthenticationRequired(true) on the key, which causes
            // "crypto-based authentication is not supported for class 2 biometrics".
            biometricPrompt.authenticate(promptInfo);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    /**
     * Enable biometric unlock by storing the master password in EncryptedSharedPreferences.
     * EncryptedSharedPreferences uses Android Keystore internally to encrypt all values.
     * No manual AES key management needed.
     */
    @PluginMethod
    public void enable(PluginCall call) {
        String password = call.getString("password");
        if (password == null || password.isEmpty()) {
            call.reject("Password is required");
            return;
        }

        try {
            SharedPreferences encryptedPrefs = getEncryptedPrefs();
            SharedPreferences.Editor editor = encryptedPrefs.edit();
            editor.putString(KEY_PASSWORD, password);
            editor.putBoolean(KEY_BIO_ENABLED, true);
            editor.apply();

            JSObject result = new JSObject();
            result.put("success", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to enable biometric: " + e.getMessage());
        }
    }

    /**
     * Disable biometric unlock by removing stored credentials.
     */
    @PluginMethod
    public void disable(PluginCall call) {
        try {
            SharedPreferences encryptedPrefs = getEncryptedPrefs();
            SharedPreferences.Editor editor = encryptedPrefs.edit();
            editor.remove(KEY_PASSWORD);
            editor.remove(KEY_BIO_ENABLED);
            editor.apply();

            JSObject result = new JSObject();
            result.put("success", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to disable biometric: " + e.getMessage());
        }
    }

    /**
     * Check if biometric unlock is enabled.
     */
    @PluginMethod
    public void isEnabled(PluginCall call) {
        try {
            SharedPreferences encryptedPrefs = getEncryptedPrefs();
            boolean enabled = encryptedPrefs.getBoolean(KEY_BIO_ENABLED, false) &&
                              encryptedPrefs.getString(KEY_PASSWORD, null) != null;

            JSObject result = new JSObject();
            result.put("enabled", enabled);
            call.resolve(result);
        } catch (Exception e) {
            JSObject result = new JSObject();
            result.put("enabled", false);
            call.resolve(result);
        }
    }

    /**
     * Authenticate with biometric and retrieve the stored master password.
     *
     * Flow:
     * 1. Show biometric prompt with BIOMETRIC_STRONG | BIOMETRIC_WEAK | DEVICE_CREDENTIAL
     * 2. On success, read the password from EncryptedSharedPreferences
     * 3. Return the decrypted password to the JS layer
     *
     * NOTE: We do NOT use CryptoObject with the biometric prompt, because that
     * requires BIOMETRIC_STRONG and setUserAuthenticationRequired(true), which
     * causes "crypto-based authentication is not supported for class 2 biometrics".
     * Instead, we use simple biometric auth and then just read from EncryptedSharedPreferences.
     */
    @PluginMethod
    public void authenticateAndRetrieve(PluginCall call) {
        String reason = call.getString("reason", "Unlock PassVault");

        try {
            // Check if biometric data exists first
            SharedPreferences encryptedPrefs = getEncryptedPrefs();
            String storedPassword = encryptedPrefs.getString(KEY_PASSWORD, null);

            if (storedPassword == null) {
                JSObject ret = new JSObject();
                ret.put("success", false);
                ret.put("error", "Biometric data not found");
                call.resolve(ret);
                return;
            }

            Activity activity = getActivity();
            if (!(activity instanceof FragmentActivity)) {
                call.reject("Activity is not a FragmentActivity");
                return;
            }

            FragmentActivity fragmentActivity = (FragmentActivity) activity;
            Executor executor = Executors.newSingleThreadExecutor();

            // Store the password in a final variable for the callback
            final String password = storedPassword;

            BiometricPrompt biometricPrompt = new BiometricPrompt(fragmentActivity,
                executor, new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    // Biometric auth succeeded — retrieve the password from EncryptedSharedPreferences
                    try {
                        // Re-read from EncryptedSharedPreferences to ensure fresh data
                        SharedPreferences prefs = getEncryptedPrefs();
                        String pw = prefs.getString(KEY_PASSWORD, null);

                        if (pw != null) {
                            JSObject ret = new JSObject();
                            ret.put("success", true);
                            ret.put("password", pw);
                            call.resolve(ret);
                        } else {
                            JSObject ret = new JSObject();
                            ret.put("success", false);
                            ret.put("error", "Password not found in secure storage");
                            call.resolve(ret);
                        }
                    } catch (Exception e) {
                        JSObject ret = new JSObject();
                        ret.put("success", false);
                        ret.put("error", "Failed to retrieve password: " + e.getMessage());
                        call.resolve(ret);
                    }
                }

                @Override
                public void onAuthenticationFailed() {
                    // Don't resolve — user can try again
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence errString) {
                    JSObject ret = new JSObject();
                    ret.put("success", false);
                    ret.put("error", errString != null ? errString.toString() : "Authentication error");
                    ret.put("errorCode", errorCode);
                    call.resolve(ret);
                }
            });

            // Build PromptInfo — try biometrics first. If no biometrics enrolled,
            // fall back to DEVICE_CREDENTIAL only (PIN/pattern/password).
            // CRITICAL: Cannot OR DEVICE_CREDENTIAL with BIOMETRIC_STRONG|WEAK on Android 11+.
            BiometricManager biometricManager = BiometricManager.from(getContext());
            int bioStatus = biometricManager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG |
                BiometricManager.Authenticators.BIOMETRIC_WEAK
            );

            int authenticators;
            if (bioStatus == BiometricManager.BIOMETRIC_SUCCESS) {
                authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG |
                                BiometricManager.Authenticators.BIOMETRIC_WEAK;
            } else {
                authenticators = BiometricManager.Authenticators.DEVICE_CREDENTIAL;
            }

            BiometricPrompt.PromptInfo.Builder promptBuilder = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("PassVault")
                .setSubtitle(reason)
                .setAllowedAuthenticators(authenticators);

            // DEVICE_CREDENTIAL doesn't allow setNegativeButtonText, only biometric modes do
            if ((authenticators & BiometricManager.Authenticators.DEVICE_CREDENTIAL) == 0) {
                promptBuilder.setNegativeButtonText("Отмена");
            }

            BiometricPrompt.PromptInfo promptInfo = promptBuilder.build();

            // Simple authenticate — NO CryptoObject!
            biometricPrompt.authenticate(promptInfo);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }
}
