package com.passvault.app.autofill;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * AutofillHelper — Manages reading/writing the autofill credentials store.
 *
 * SECURITY: Credentials are stored in EncryptedSharedPreferences (Android Keystore-backed)
 * to prevent plaintext credential exposure on rooted devices.
 *
 * Storage format:
 *   Key:   package name (e.g. "com.example.app") or web domain (e.g. "example.com")
 *   Value: JSON array of {"u": "username", "p": "password"} objects
 */
public class AutofillHelper {

    private static final String AUTOFILL_PREFS_NAME = "passvault_autofill_encrypted";
    private static final String KEY_AUTOFILL_ENABLED = "autofill_enabled";

    private SharedPreferences prefs;

    public AutofillHelper(Context context) {
        try {
            Context appContext = context.getApplicationContext();
            MasterKey masterKey = new MasterKey.Builder(appContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();

            prefs = EncryptedSharedPreferences.create(
                appContext,
                AUTOFILL_PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        } catch (Exception e) {
            // Fallback to regular SharedPreferences if EncryptedSharedPreferences fails
            // (e.g., on devices with corrupted Keystore)
            prefs = context.getApplicationContext()
                    .getSharedPreferences("passvault_autofill", Context.MODE_PRIVATE);
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Credential CRUD
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Save a credential entry for a given package name or domain.
     * If a credential with the same username already exists for this key,
     * it will be updated (password overwritten). Otherwise, it is appended.
     */
    public void saveCredentialsForPackage(String key, String username, String password) {
        if (key == null || key.isEmpty() || username == null || username.isEmpty()) {
            return;
        }

        JSONArray credentials = getCredentialsArray(key);
        JSONArray updated = updateOrAppend(credentials, username, password);

        prefs.edit()
             .putString(key, updated.toString())
             .putBoolean(KEY_AUTOFILL_ENABLED, true)
             .apply();
    }

    /**
     * Get all credentials for a given package name or domain.
     */
    public List<Credential> getCredentialsForPackage(String key) {
        List<Credential> result = new ArrayList<>();
        if (key == null || key.isEmpty()) {
            return result;
        }

        JSONArray credentials = getCredentialsArray(key);
        for (int i = 0; i < credentials.length(); i++) {
            try {
                JSONObject entry = credentials.getJSONObject(i);
                result.add(new Credential(
                    entry.optString("u", ""),
                    entry.optString("p", "")
                ));
            } catch (JSONException e) {
                // Skip malformed entries
            }
        }
        return result;
    }

    /**
     * Remove all credentials for a given package name or domain.
     */
    public void removeCredentialsForPackage(String key) {
        if (key == null || key.isEmpty()) {
            return;
        }
        prefs.edit().remove(key).apply();
    }

    /**
     * Remove a specific credential by username for a given key.
     */
    public void removeCredentialByUsername(String key, String username) {
        if (key == null || key.isEmpty() || username == null || username.isEmpty()) {
            return;
        }

        JSONArray credentials = getCredentialsArray(key);
        JSONArray filtered = new JSONArray();

        for (int i = 0; i < credentials.length(); i++) {
            try {
                JSONObject entry = credentials.getJSONObject(i);
                if (!username.equals(entry.optString("u", ""))) {
                    filtered.put(entry);
                }
            } catch (JSONException e) {
                // Skip malformed entries
            }
        }

        if (filtered.length() == 0) {
            prefs.edit().remove(key).apply();
        } else {
            prefs.edit().putString(key, filtered.toString()).apply();
        }
    }

    /**
     * Clear all stored autofill credentials.
     */
    public void clearAllCredentials() {
        prefs.edit().clear().apply();
    }

    /**
     * Check if autofill data exists (at least one credential stored).
     */
    public boolean isAutofillEnabled() {
        for (String key : prefs.getAll().keySet()) {
            if (!KEY_AUTOFILL_ENABLED.equals(key)) {
                return true;
            }
        }
        return false;
    }

    // ────────────────────────────────────────────────────────────────────────
    // URL / Domain helpers
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Extract the domain from a URL.
     */
    public static String extractDomain(String url) {
        if (url == null || url.isEmpty()) {
            return "";
        }

        String domain = url;

        if (domain.contains("://")) {
            domain = domain.substring(domain.indexOf("://") + 3);
        }

        int slashIndex = domain.indexOf('/');
        if (slashIndex > 0) {
            domain = domain.substring(0, slashIndex);
        }

        int colonIndex = domain.indexOf(':');
        if (colonIndex > 0) {
            domain = domain.substring(0, colonIndex);
        }

        if (domain.startsWith("www.")) {
            domain = domain.substring(4);
        }

        return domain.toLowerCase();
    }

    /**
     * Find credentials that match a given domain, including subdomain matching.
     */
    public List<Credential> getCredentialsForDomain(String requestDomain) {
        List<Credential> result = new ArrayList<>();
        if (requestDomain == null || requestDomain.isEmpty()) {
            return result;
        }

        String normalizedRequest = requestDomain.toLowerCase();

        result.addAll(getCredentialsForPackage(normalizedRequest));

        for (String storedKey : prefs.getAll().keySet()) {
            if (KEY_AUTOFILL_ENABLED.equals(storedKey)) continue;

            String normalizedStored = storedKey.toLowerCase();

            if (normalizedStored.equals(normalizedRequest)) continue;

            if (normalizedRequest.endsWith("." + normalizedStored)) {
                result.addAll(getCredentialsForPackage(storedKey));
            }

            if (normalizedStored.endsWith("." + normalizedRequest)) {
                result.addAll(getCredentialsForPackage(storedKey));
            }
        }

        return result;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ────────────────────────────────────────────────────────────────────────

    private JSONArray getCredentialsArray(String key) {
        String json = prefs.getString(key, "[]");
        try {
            return new JSONArray(json);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /**
     * Update an existing entry with the same username, or append a new entry.
     */
    private JSONArray updateOrAppend(JSONArray credentials, String username, String password) {
        JSONArray result = new JSONArray();
        boolean updated = false;

        for (int i = 0; i < credentials.length(); i++) {
            try {
                JSONObject entry = credentials.getJSONObject(i);
                if (username.equals(entry.optString("u", ""))) {
                    entry.put("p", password);
                    updated = true;
                }
                result.put(entry);
            } catch (JSONException e) {
                // Skip malformed entries
            }
        }

        if (!updated) {
            try {
                JSONObject newEntry = new JSONObject();
                newEntry.put("u", username);
                newEntry.put("p", password);
                result.put(newEntry);
            } catch (JSONException e) {
                // Should never happen
            }
        }

        return result;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Credential data class
    // ────────────────────────────────────────────────────────────────────────

    public static class Credential {
        public final String username;
        public final String password;

        public Credential(String username, String password) {
            this.username = username;
            this.password = password;
        }
    }
}
