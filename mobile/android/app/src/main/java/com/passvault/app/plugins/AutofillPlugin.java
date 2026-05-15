package com.passvault.app.plugins;

import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.passvault.app.autofill.AutofillHelper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;

/**
 * AutofillPlugin — Capacitor plugin that bridges JS to the Android AutofillService.
 *
 * Provides:
 * - isEnabled(): Check if PassVault is set as the autofill provider
 * - saveCredential({serviceId, username, password, urls}): Save credential for autofill
 * - removeCredential({serviceId}): Remove credential from autofill store
 * - syncAllCredentials(credentials[]): Sync all current vault credentials to autofill store
 * - clearAllCredentials(): Clear autofill store
 * - openAutofillSettings(): Open Android autofill settings
 *
 * Storage format:
 *   Key:   serviceId (package name or web domain)
 *   Value: JSON array of {"u": "username", "p": "password"} objects
 *
 * When saving a credential with URLs, we store it under each domain extracted
 * from the URLs, so the AutofillService can match both by package name and web domain.
 */
@CapacitorPlugin(
    name = "Autofill",
    permissions = {}
)
public class AutofillPlugin extends Plugin {

    private static final String TAG = "PassVaultAutofillPlugin";

    /**
     * Check if PassVault is set as the autofill provider on this device.
     * This checks the system setting for the current autofill service.
     */
    @PluginMethod
    public void isEnabled(PluginCall call) {
        try {
            Context context = getContext();
            String autofillService = Settings.Secure.getString(
                context.getContentResolver(),
                "autofill_service"
            );

            boolean enabled = autofillService != null
                && autofillService.contains(context.getPackageName());

            JSObject result = new JSObject();
            result.put("enabled", enabled);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "isEnabled error", e);
            JSObject result = new JSObject();
            result.put("enabled", false);
            call.resolve(result);
        }
    }

    /**
     * Save a credential for autofill.
     *
     * Expected parameters:
     *   serviceId: string — A unique identifier for the service (e.g. "github.com")
     *   username: string — The username or email
     *   password: string — The password
     *   urls: string[] (optional) — Associated URLs for web domain matching
     */
    @PluginMethod
    public void saveCredential(PluginCall call) {
        String serviceId = call.getString("serviceId");
        String username = call.getString("username");
        String password = call.getString("password");
        JSArray urls = call.getArray("urls");

        if (serviceId == null || serviceId.isEmpty()) {
            call.reject("serviceId is required");
            return;
        }
        if (username == null || username.isEmpty()) {
            call.reject("username is required");
            return;
        }
        if (password == null || password.isEmpty()) {
            call.reject("password is required");
            return;
        }

        try {
            AutofillHelper helper = new AutofillHelper(getContext());

            // Save under the serviceId key
            helper.saveCredentialsForPackage(serviceId, username, password);

            // Also save under each URL domain for web matching
            if (urls != null) {
                for (int i = 0; i < urls.length(); i++) {
                    try {
                        String url = urls.getString(i);
                        String domain = AutofillHelper.extractDomain(url);
                        if (!domain.isEmpty() && !domain.equals(serviceId)) {
                            helper.saveCredentialsForPackage(domain, username, password);
                        }
                    } catch (JSONException e) {
                        // Skip invalid URL entries
                    }
                }
            }

            JSObject result = new JSObject();
            result.put("success", true);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "saveCredential error", e);
            call.reject("Failed to save credential: " + e.getMessage());
        }
    }

    /**
     * Remove a credential from the autofill store.
     *
     * Expected parameters:
     *   serviceId: string — The service identifier to remove
     *   username: string (optional) — Specific username to remove.
     *                If not provided, removes all credentials for the serviceId.
     *   urls: string[] (optional) — Associated URLs to also remove from
     */
    @PluginMethod
    public void removeCredential(PluginCall call) {
        String serviceId = call.getString("serviceId");
        String username = call.getString("username");
        JSArray urls = call.getArray("urls");

        if (serviceId == null || serviceId.isEmpty()) {
            call.reject("serviceId is required");
            return;
        }

        try {
            AutofillHelper helper = new AutofillHelper(getContext());

            if (username != null && !username.isEmpty()) {
                helper.removeCredentialByUsername(serviceId, username);
            } else {
                helper.removeCredentialsForPackage(serviceId);
            }

            // Also remove from URL domains
            if (urls != null) {
                for (int i = 0; i < urls.length(); i++) {
                    try {
                        String url = urls.getString(i);
                        String domain = AutofillHelper.extractDomain(url);
                        if (!domain.isEmpty() && !domain.equals(serviceId)) {
                            if (username != null && !username.isEmpty()) {
                                helper.removeCredentialByUsername(domain, username);
                            } else {
                                helper.removeCredentialsForPackage(domain);
                            }
                        }
                    } catch (JSONException e) {
                        // Skip invalid URL entries
                    }
                }
            }

            JSObject result = new JSObject();
            result.put("success", true);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "removeCredential error", e);
            call.reject("Failed to remove credential: " + e.getMessage());
        }
    }

    /**
     * Sync all current vault credentials to the autofill store.
     * This replaces ALL existing autofill data with the provided credentials.
     *
     * Expected parameters:
     *   credentials: Array of objects with:
     *     - serviceId: string
     *     - username: string
     *     - password: string
     *     - urls: string[] (optional)
     */
    @PluginMethod
    public void syncAllCredentials(PluginCall call) {
        JSArray credentials = call.getArray("credentials");

        if (credentials == null) {
            call.reject("credentials array is required");
            return;
        }

        try {
            AutofillHelper helper = new AutofillHelper(getContext());

            // Clear existing data first
            helper.clearAllCredentials();

            // Add all credentials
            for (int i = 0; i < credentials.length(); i++) {
                try {
                    JSONObject cred = credentials.getJSONObject(i);
                    String serviceId = cred.optString("serviceId", "");
                    String username = cred.optString("username", "");
                    String password = cred.optString("password", "");

                    if (serviceId.isEmpty() || username.isEmpty()) continue;

                    // Save under serviceId
                    helper.saveCredentialsForPackage(serviceId, username, password);

                    // Save under each URL domain
                    JSONArray urls = cred.optJSONArray("urls");
                    if (urls != null) {
                        for (int j = 0; j < urls.length(); j++) {
                            String url = urls.getString(j);
                            String domain = AutofillHelper.extractDomain(url);
                            if (!domain.isEmpty() && !domain.equals(serviceId)) {
                                helper.saveCredentialsForPackage(domain, username, password);
                            }
                        }
                    }
                } catch (JSONException e) {
                    Log.w(TAG, "Skipping malformed credential entry", e);
                }
            }

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("count", credentials.length());
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "syncAllCredentials error", e);
            call.reject("Failed to sync credentials: " + e.getMessage());
        }
    }

    /**
     * Clear all stored autofill credentials.
     */
    @PluginMethod
    public void clearAllCredentials(PluginCall call) {
        try {
            AutofillHelper helper = new AutofillHelper(getContext());
            helper.clearAllCredentials();

            JSObject result = new JSObject();
            result.put("success", true);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "clearAllCredentials error", e);
            call.reject("Failed to clear credentials: " + e.getMessage());
        }
    }

    /**
     * Open the Android autofill settings so the user can enable PassVault
     * as the autofill provider.
     */
    @PluginMethod
    public void openAutofillSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE);
            intent.setData(
                android.net.Uri.parse("package:" + getContext().getPackageName())
            );

            // On some devices, ACTION_REQUEST_SET_AUTOFILL_SERVICE may not be available.
            // Fall back to the general autofill settings.
            try {
                getActivity().startActivity(intent);
            } catch (Exception e) {
                Log.w(TAG, "ACTION_REQUEST_SET_AUTOFILL_SERVICE failed, trying fallback", e);
                Intent fallback = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                getActivity().startActivity(fallback);
            }

            JSObject result = new JSObject();
            result.put("success", true);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "openAutofillSettings error", e);
            call.reject("Failed to open autofill settings: " + e.getMessage());
        }
    }
}
