package com.passvault.app.autofill;

import android.app.assist.AssistStructure;
import android.os.CancellationSignal;
import android.service.autofill.AutofillService;
import android.service.autofill.Dataset;
import android.service.autofill.FillCallback;
import android.service.autofill.FillContext;
import android.service.autofill.FillRequest;
import android.service.autofill.FillResponse;
import android.service.autofill.SaveCallback;
import android.service.autofill.SaveInfo;
import android.service.autofill.SaveRequest;
import android.util.Log;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import android.widget.RemoteViews;

import com.passvault.app.R;

import java.util.ArrayList;
import java.util.List;

/**
 * PassVault AutofillService — Provides autofill suggestions for login forms.
 *
 * Design decisions:
 * - Credentials are stored in a separate SharedPreferences file ("passvault_autofill")
 *   in plaintext. This is because the main vault uses AES-256-GCM encryption that
 *   requires the master password to decrypt, which we cannot prompt for during autofill.
 * - Many password managers (KeePassDX, etc.) use the same approach.
 * - The AutofillPlugin (Capacitor bridge) is responsible for syncing credentials
 *   from the encrypted vault to the autofill store.
 *
 * Flow:
 * 1. Android detects a login form and calls onFillRequest()
 * 2. We parse the AssistStructure to find username/password fields
 * 3. We look up matching credentials by package name or web domain
 * 4. We return a FillResponse with Dataset entries for each matching credential
 * 5. When the user taps a suggestion, Android fills in the username and password
 */
public class AutofillService extends AutofillService {

    private static final String TAG = "PassVaultAutofill";

    @Override
    public void onFillRequest(FillRequest request, CancellationSignal cancellationSignal, FillCallback callback) {
        try {
            AutofillHelper helper = new AutofillHelper(this);

            // Check if we have any credentials at all
            if (!helper.isAutofillEnabled()) {
                callback.onSuccess(null);
                return;
            }

            // Get the AssistStructure from the fill contexts
            List<FillContext> contexts = request.getFillContexts();
            if (contexts.isEmpty()) {
                callback.onSuccess(null);
                return;
            }

            AssistStructure structure = contexts.get(contexts.size() - 1).getStructure();
            if (structure == null) {
                callback.onSuccess(null);
                return;
            }

            // Parse the structure to find login fields
            ParsedStructure parsed = parseStructure(structure);
            if (parsed == null || parsed.usernameIds.isEmpty()) {
                // No login fields found — nothing to fill
                callback.onSuccess(null);
                return;
            }

            // Find matching credentials
            List<AutofillHelper.Credential> credentials = findMatchingCredentials(helper, parsed);

            if (credentials.isEmpty()) {
                // No credentials found for this app/site
                callback.onSuccess(null);
                return;
            }

            // Build the FillResponse with datasets
            FillResponse.Builder responseBuilder = new FillResponse.Builder();

            // Determine which password fields to use
            List<AutofillId> passwordIds = parsed.passwordIds.isEmpty()
                ? new ArrayList<>() : parsed.passwordIds;

            for (AutofillHelper.Credential cred : credentials) {
                // Build the presentation (RemoteViews) for this dataset
                RemoteViews presentation = new RemoteViews(
                    getPackageName(),
                    R.layout.autofill_suggestion
                );
                presentation.setTextViewText(R.id.autofill_username, cred.username);
                presentation.setTextViewText(R.id.autofill_app_name,
                    parsed.packageName != null ? parsed.packageName : parsed.webDomain);

                // Build the dataset
                Dataset.Builder datasetBuilder = new Dataset.Builder(presentation);

                // Fill username fields
                for (AutofillId id : parsed.usernameIds) {
                    datasetBuilder.setValue(id, AutofillValue.forText(cred.username));
                }

                // Fill password fields
                for (AutofillId id : passwordIds) {
                    datasetBuilder.setValue(id, AutofillValue.forText(cred.password));
                }

                try {
                    responseBuilder.addDataset(datasetBuilder.build());
                } catch (Exception e) {
                    Log.w(TAG, "Failed to build dataset for " + cred.username, e);
                }
            }

            // Add SaveInfo if we have both username and password fields
            // (so Android can offer to save new credentials)
            if (!parsed.usernameIds.isEmpty() && !parsed.passwordIds.isEmpty()) {
                SaveInfo saveInfo = new SaveInfo.Builder(
                    SaveInfo.SAVE_DATA_TYPE_USERNAME | SaveInfo.SAVE_DATA_TYPE_PASSWORD,
                    concatArrays(parsed.usernameIds, parsed.passwordIds)
                ).build();
                responseBuilder.setSaveInfo(saveInfo);
            }

            FillResponse response = responseBuilder.build();
            callback.onSuccess(response);

        } catch (Exception e) {
            Log.e(TAG, "onFillRequest error", e);
            callback.onSuccess(null);
        }
    }

    @Override
    public void onSaveRequest(SaveRequest request, SaveCallback callback) {
        // No-op for now — we handle credential saving through the Capacitor plugin
        // instead of through the Android autofill save flow.
        // The plugin's saveCredential() method is called from the JS layer
        // when the user explicitly saves a vault entry.
        callback.onSuccess();
    }

    @Override
    public void onConnected() {
        Log.d(TAG, "AutofillService connected");
    }

    @Override
    public void onDisconnected() {
        Log.d(TAG, "AutofillService disconnected");
    }

    // ────────────────────────────────────────────────────────────────────────
    // AssistStructure parsing
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Parse the AssistStructure to find username and password input fields.
     *
     * We look for:
     * - Fields with AUTOFILL_HINT_USERNAME or AUTOFILL_HINT_EMAIL_ADDRESS → username
     * - Fields with AUTOFILL_HINT_PASSWORD → password
     * - Heuristics: EditText with "password" in the hint, inputType, or resourceName
     */
    private ParsedStructure parseStructure(AssistStructure structure) {
        ParsedStructure parsed = new ParsedStructure();
        int windowNodeCount = structure.getWindowNodeCount();

        for (int i = 0; i < windowNodeCount; i++) {
            AssistStructure.WindowNode windowNode = structure.getWindowNodeAt(i);
            parseViewNode(windowNode.getRootViewNode(), parsed);
        }

        return parsed;
    }

    private void parseViewNode(AssistStructure.ViewNode node, ParsedStructure parsed) {
        String className = node.getClassName();
        if (className == null) className = "";

        // Only process editable text fields (EditText, TextInputEditText, etc.)
        if (isEditText(className)) {
            String[] hints = node.getAutofillHints();
            String hint = node.getHint();
            String idEntry = node.getIdEntry();
            String resourceName = node.getHintIdEntry();
            int inputType = node.getInputType();

            boolean isUsername = false;
            boolean isPassword = false;

            // Check explicit autofill hints first (most reliable)
            if (hints != null && hints.length > 0) {
                for (String h : hints) {
                    if (h == null) continue;
                    String hLower = h.toLowerCase();
                    if (hLower.contains("username") || hLower.contains("email")
                        || hLower.contains("phone")) {
                        isUsername = true;
                    }
                    if (hLower.contains("password")) {
                        isPassword = true;
                    }
                }
            }

            // Check Android view autofill hints
            if (hints != null) {
                for (String h : hints) {
                    if (h == null) continue;
                    if (h.equals(android.view.View.AUTOFILL_HINT_USERNAME)
                        || h.equals(android.view.View.AUTOFILL_HINT_EMAIL_ADDRESS)
                        || h.equals(android.view.View.AUTOFILL_HINT_PHONE)) {
                        isUsername = true;
                    }
                    if (h.equals(android.view.View.AUTOFILL_HINT_PASSWORD)) {
                        isPassword = true;
                    }
                }
            }

            // Heuristic: check hint text
            if (!isUsername && !isPassword) {
                if (hint != null) {
                    String hintLower = hint.toLowerCase();
                    if (hintLower.contains("password") || hintLower.contains("пароль")) {
                        isPassword = true;
                    } else if (hintLower.contains("email") || hintLower.contains("e-mail")
                               || hintLower.contains("username") || hintLower.contains("login")
                               || hintLower.contains("user") || hintLower.contains("логин")
                               || hintLower.contains("почта")) {
                        isUsername = true;
                    }
                }
            }

            // Heuristic: check resource/ID name
            if (!isUsername && !isPassword) {
                String idStr = (idEntry != null ? idEntry : "")
                               + " " + (resourceName != null ? resourceName : "");
                String idLower = idStr.toLowerCase();
                if (idLower.contains("password") || idLower.contains("passwd")) {
                    isPassword = true;
                } else if (idLower.contains("email") || idLower.contains("username")
                           || idLower.contains("login") || idLower.contains("user")) {
                    isUsername = true;
                }
            }

            // Heuristic: check inputType for password
            if (!isPassword && !isUsername) {
                // InputType.TYPE_TEXT_VARIATION_PASSWORD = 129 (text | variation_password)
                // InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD = 151 (text | variation_visible_password)
                // InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD = 225 (text | variation_web_password)
                int variation = inputType & 0x0000000F; // lower 4 bits are the class
                int fullType = inputType & 0x00000FF0; // bits for variation

                // TYPE_TEXT_VARIATION_PASSWORD = 0x80
                // TYPE_TEXT_VARIATION_VISIBLE_PASSWORD = 0x90
                // TYPE_TEXT_VARIATION_WEB_PASSWORD = 0xE0
                if ((fullType & 0x00000080) != 0   // TYPE_TEXT_VARIATION_PASSWORD
                    || (fullType & 0x00000090) != 0 // TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    || (fullType & 0x000000E0) != 0) { // TYPE_TEXT_VARIATION_WEB_PASSWORD
                    isPassword = true;
                }
            }

            // Record the field
            AutofillId autofillId = node.getAutofillId();
            if (isPassword) {
                parsed.passwordIds.add(autofillId);
            } else if (isUsername) {
                parsed.usernameIds.add(autofillId);
            }
        }

        // Capture package name and web domain from the root/top-level nodes
        if (parsed.packageName == null || parsed.packageName.isEmpty()) {
            String pkg = node.getPackageName();
            if (pkg != null && !pkg.isEmpty()) {
                parsed.packageName = pkg;
            }
        }

        if (parsed.webDomain == null || parsed.webDomain.isEmpty()) {
            String domain = node.getWebDomain();
            if (domain != null && !domain.isEmpty()) {
                parsed.webDomain = domain;
            }
        }

        // Recurse into children
        int childCount = node.getChildCount();
        for (int i = 0; i < childCount; i++) {
            AssistStructure.ViewNode child = node.getChildAt(i);
            if (child != null) {
                parseViewNode(child, parsed);
            }
        }
    }

    /**
     * Check if a class name looks like an EditText widget.
     */
    private boolean isEditText(String className) {
        if (className == null) return false;
        String lower = className.toLowerCase();
        return lower.contains("edittext")
               || lower.contains("autocompletetextview")
               || lower.contains("textinputedittext")
               || lower.contains("input")
               || lower.contains("textfield");
    }

    // ────────────────────────────────────────────────────────────────────────
    // Credential matching
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Find credentials matching the parsed structure.
     * Tries package name first, then web domain.
     */
    private List<AutofillHelper.Credential> findMatchingCredentials(
            AutofillHelper helper, ParsedStructure parsed) {

        List<AutofillHelper.Credential> credentials = new ArrayList<>();

        // Try package name match
        if (parsed.packageName != null && !parsed.packageName.isEmpty()) {
            List<AutofillHelper.Credential> pkgCreds =
                helper.getCredentialsForPackage(parsed.packageName);
            if (!pkgCreds.isEmpty()) {
                credentials.addAll(pkgCreds);
            }
        }

        // Try web domain match (for Chrome / WebView)
        if (parsed.webDomain != null && !parsed.webDomain.isEmpty()) {
            String domain = AutofillHelper.extractDomain(parsed.webDomain);
            List<AutofillHelper.Credential> domainCreds =
                helper.getCredentialsForDomain(domain);
            if (!domainCreds.isEmpty()) {
                // Add only if not already matched by package name
                for (AutofillHelper.Credential cred : domainCreds) {
                    boolean alreadyExists = false;
                    for (AutofillHelper.Credential existing : credentials) {
                        if (existing.username.equals(cred.username)) {
                            alreadyExists = true;
                            break;
                        }
                    }
                    if (!alreadyExists) {
                        credentials.add(cred);
                    }
                }
            }
        }

        return credentials;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Utility
    // ────────────────────────────────────────────────────────────────────────

    private AutofillId[] concatArrays(List<AutofillId> a, List<AutofillId> b) {
        AutofillId[] result = new AutofillId[a.size() + b.size()];
        int i = 0;
        for (AutofillId id : a) result[i++] = id;
        for (AutofillId id : b) result[i++] = id;
        return result;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Parsed structure holder
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Holds the results of parsing an AssistStructure.
     */
    private static class ParsedStructure {
        String packageName;
        String webDomain;
        final List<AutofillId> usernameIds = new ArrayList<>();
        final List<AutofillId> passwordIds = new ArrayList<>();
    }
}
