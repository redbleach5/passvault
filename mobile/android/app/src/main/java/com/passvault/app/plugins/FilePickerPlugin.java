package com.passvault.app.plugins;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;

/**
 * FilePickerPlugin — Capacitor plugin for native file picking and saving on Android.
 *
 * Uses ACTION_OPEN_DOCUMENT for picking files and ACTION_CREATE_DOCUMENT for saving.
 * These system dialogs give access to the full filesystem: Downloads, internal
 * storage, cloud storage, USB drives, etc.
 *
 * Provides:
 * - pickFile(options): Open system file picker and return file content
 * - saveFile(options): Open system save dialog and write data to chosen location
 */
@CapacitorPlugin(
    name = "FilePicker",
    permissions = {}
)
public class FilePickerPlugin extends Plugin {

    private static final String TAG = "FilePickerPlugin";
    private static final int PICK_FILE_REQUEST = 1001;
    private static final int SAVE_FILE_REQUEST = 1002;

    private PluginCall savedPickCall = null;
    private PluginCall savedSaveCall = null;
    private String saveData = null;
    private String saveMimeType = null;

    /**
     * Pick a file using the system document picker.
     * Returns: { success, fileName, textData, base64Data, size, error }
     */
    @PluginMethod
    public void pickFile(PluginCall call) {
        String mimeType = call.getString("mimeType", "*/*");

        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mimeType);

            savedPickCall = call;

            startActivityForResult(call, intent, "handlePickResult");
        } catch (Exception e) {
            JSObject result = new JSObject();
            result.put("success", false);
            result.put("error", e.getMessage());
            call.resolve(result);
        }
    }

    /**
     * Handle the result from the file picker activity.
     */
    @ActivityCallback
    private void handlePickResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            call = savedPickCall;
        }

        if (call == null) return;

        try {
            int resultCode = result.getResultCode();
            Intent data = result.getData();

            if (resultCode != Activity.RESULT_OK || data == null) {
                JSObject ret = new JSObject();
                ret.put("success", false);
                ret.put("error", "User cancelled");
                call.resolve(ret);
                return;
            }

            Uri uri = data.getData();
            if (uri == null) {
                JSObject ret = new JSObject();
                ret.put("success", false);
                ret.put("error", "No file selected");
                call.resolve(ret);
                return;
            }

            // Take persistent URI permission so we can read later
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (Exception e) {
                // Not critical
            }

            // Get file name
            String fileName = getFileName(uri);

            // Read file content as text
            String textData = null;
            String base64Data = null;
            int size = 0;

            try {
                InputStream is = getContext().getContentResolver().openInputStream(uri);
                if (is != null) {
                    byte[] bytes = readAllBytes(is);
                    size = bytes.length;
                    is.close();

                    // Try to decode as text
                    try {
                        textData = new String(bytes, "UTF-8");
                    } catch (Exception e) {
                        // Not valid text, use base64
                        textData = null;
                    }

                    // If text failed or is empty, provide base64
                    if (textData == null) {
                        base64Data = android.util.Base64.encodeToString(
                            bytes, android.util.Base64.NO_WRAP
                        );
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to read file content", e);
            }

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("fileName", fileName);
            ret.put("size", size);
            if (textData != null) {
                ret.put("textData", textData);
            }
            if (base64Data != null) {
                ret.put("base64Data", base64Data);
            }
            call.resolve(ret);

        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("error", "Failed to process file: " + e.getMessage());
            call.resolve(ret);
        }

        savedPickCall = null;
    }

    /**
     * Save data to a file using the system save dialog.
     * Returns: { success, fileName, size, error }
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String fileName = call.getString("fileName", "passvault-backup.vault");
        String data = call.getString("data", "");
        String mimeType = call.getString("mimeType", "application/json");

        try {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mimeType);
            intent.putExtra(Intent.EXTRA_TITLE, fileName);

            savedSaveCall = call;
            saveData = data;
            saveMimeType = mimeType;

            startActivityForResult(call, intent, "handleSaveResult");
        } catch (Exception e) {
            JSObject result = new JSObject();
            result.put("success", false);
            result.put("error", e.getMessage());
            call.resolve(result);
        }
    }

    /**
     * Handle the result from the save file activity.
     */
    @ActivityCallback
    private void handleSaveResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            call = savedSaveCall;
        }

        if (call == null) return;

        try {
            int resultCode = result.getResultCode();
            Intent data = result.getData();

            if (resultCode != Activity.RESULT_OK || data == null) {
                JSObject ret = new JSObject();
                ret.put("success", false);
                ret.put("error", "User cancelled");
                call.resolve(ret);
                return;
            }

            Uri uri = data.getData();
            if (uri == null) {
                JSObject ret = new JSObject();
                ret.put("success", false);
                ret.put("error", "No location selected");
                call.resolve(ret);
                return;
            }

            // Write data to the selected location
            String dataToWrite = saveData != null ? saveData : "";
            OutputStream os = getContext().getContentResolver().openOutputStream(uri);
            if (os != null) {
                os.write(dataToWrite.getBytes("UTF-8"));
                os.flush();
                os.close();
            }

            String fileName = getFileName(uri);

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("fileName", fileName);
            ret.put("size", dataToWrite.length());
            call.resolve(ret);

        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("error", "Failed to save file: " + e.getMessage());
            call.resolve(ret);
        }

        savedSaveCall = null;
        saveData = null;
        saveMimeType = null;
    }

    /**
     * Get the display name of a file from its URI.
     */
    private String getFileName(Uri uri) {
        String fileName = "unknown";
        try (Cursor cursor = getContext().getContentResolver().query(
            uri, null, null, null, null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameIndex >= 0) {
                    fileName = cursor.getString(nameIndex);
                }
            }
        } catch (Exception e) {
            // Fallback to last path segment
            fileName = uri.getLastPathSegment();
            if (fileName == null) fileName = "unknown";
        }
        return fileName;
    }

    /**
     * Read all bytes from an InputStream.
     */
    private byte[] readAllBytes(InputStream is) throws Exception {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] data = new byte[8192];
        int nRead;
        while ((nRead = is.read(data, 0, data.length)) != -1) {
            buffer.write(data, 0, nRead);
        }
        return buffer.toByteArray();
    }
}
