package com.passvault.app.autofill;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * AutofillHelper — Manages reading/writing the autofill credentials store.
 *
 * Credentials are stored in a SharedPreferences file called "passvault_autofill"
 * in PLAINTEXT format. This is a deliberate trade-off: convenience vs security.
 * Many password managers (like KeePassDX) store credentials for autofill in a
 * protected store that doesn't require master password decryption at autofill time.
 *
 * Storage format:
 *   Key:   package name (e.g. "com.example.app") or web domain (e.g. "example.com")
 *   Value: JSON array of {"u": "username", "p": "password"} objects
 *
 * Example:
 *   "com.example.app" => [{"u": "user@example.com", "p": "pass123"}]
 *   "github.com"      => [{"u": "dev@github.com", "p": "ghp_xxx"}, {"u": "admin@github.com", "p": "ghp_yyy"}]
 */
public class AutofillHelper {

    private static final String AUTOFILL_PREFS_NAME = "passvault_autofill";
    private static final String KEY_AUTOFILL_ENABLED = "autofill_enabled";

    private final SharedPreferences prefs;

    public AutofillHelper(Context context) {
        prefs = context.getApplicationContext()
                .getSharedPreferences(AUTOFILL_PREFS_NAME, Context.MODE_PRIVATE);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Credential CRUD
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Save a credential entry for a given package name or domain.
     * If a credential with the same username already exists for this key,
     * it will be updated (password overwritten). Otherwise, it is appended.
     *
     * @param key      Package name or web domain
     * @param username Username / email
     * @param password Password
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
     *
     * @param key Package name or web domain
     * @return List of Credential objects (may be empty)
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
     *
     * @param key Package name or web domain
     */
    public void removeCredentialsForPackage(String key) {
        if (key == null || key.isEmpty()) {
            return;
        }
        prefs.edit().remove(key).apply();
    }

    /**
     * Remove a specific credential by username for a given key.
     *
     * @param key      Package name or web domain
     * @param username The username to remove
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
        // Check if there are any credential keys stored
        // (excluding the internal enabled flag)
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
     * e.g. "https://www.example.com/login" => "example.com"
     *
     * @param url The URL to extract from
     * @return The domain, or the original string if parsing fails
     */
    public static String extractDomain(String url) {
        if (url == null || url.isEmpty()) {
            return "";
        }

        String domain = url;

        // Remove protocol
        if (domain.contains("://")) {
            domain = domain.substring(domain.indexOf("://") + 3);
        }

        // Remove path
        int slashIndex = domain.indexOf('/');
        if (slashIndex > 0) {
            domain = domain.substring(0, slashIndex);
        }

        // Remove port
        int colonIndex = domain.indexOf(':');
        if (colonIndex > 0) {
            domain = domain.substring(0, colonIndex);
        }

        // Remove www. prefix for matching purposes
        if (domain.startsWith("www.")) {
            domain = domain.substring(4);
        }

        return domain.toLowerCase();
    }

    /**
     * Find credentials that match a given domain, including subdomain matching.
     * e.g. stored "example.com" will match request for "login.example.com"
     *
     * @param requestDomain The domain from the autofill request
     * @return List of matching credentials
     */
    public List<Credential> getCredentialsForDomain(String requestDomain) {
        List<Credential> result = new ArrayList<>();
        if (requestDomain == null || requestDomain.isEmpty()) {
            return result;
        }

        String normalizedRequest = requestDomain.toLowerCase();

        // First try exact match
        result.addAll(getCredentialsForPackage(normalizedRequest));

        // Then try subdomain / parent domain matching
        for (String storedKey : prefs.getAll().keySet()) {
            if (KEY_AUTOFILL_ENABLED.equals(storedKey)) continue;

            String normalizedStored = storedKey.toLowerCase();

            // Skip if we already found exact match
            if (normalizedStored.equals(normalizedRequest)) continue;

            // Check if stored key is a parent domain of the request domain
            // e.g. stored "example.com" matches request "login.example.com"
            if (normalizedRequest.endsWith("." + normalizedStored)) {
                result.addAll(getCredentialsForPackage(storedKey));
            }

            // Also check reverse: request domain is parent of stored
            // e.g. request "example.com" matches stored "login.example.com"
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
                    // Update existing
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
