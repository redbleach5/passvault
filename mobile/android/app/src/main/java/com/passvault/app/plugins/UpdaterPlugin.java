package com.passvault.app.plugins;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * UpdaterPlugin — Capacitor plugin for downloading and installing APK updates.
 *
 * Downloads an APK from a given URL to the app's cache directory,
 * then triggers Android's package installer via an Intent with FileProvider.
 *
 * Provides:
 * - downloadAndInstall(url): Download APK and prompt user to install
 * - canInstallApk(): Check if the app has permission to install APKs (Android 8+)
 * - requestInstallPermission(): Request the install permission (Android 8+)
 */
@CapacitorPlugin(
    name = "Updater",
    permissions = {}
)
public class UpdaterPlugin extends Plugin {

    private static final String TAG = "UpdaterPlugin";
    private static final int REQUEST_INSTALL_PERMISSION = 1001;
    private static final int REQUEST_INSTALL_APK = 1002;

    private PluginCall savedCall = null;
    private File pendingApkFile = null;

    /**
     * Download an APK from the given URL and prompt the user to install it.
     * This runs the download on a background thread and reports progress.
     */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String downloadUrl = call.getString("url");
        if (downloadUrl == null || downloadUrl.isEmpty()) {
            call.reject("Download URL is required");
            return;
        }

        // Save the call so we can resolve it after install prompt
        savedCall = call;

        Log.i(TAG, "Starting APK download: " + downloadUrl);

        // Run download on a background thread
        new Thread(() -> {
            try {
                File apkFile = downloadApk(downloadUrl);

                if (apkFile == null || !apkFile.exists()) {
                    if (savedCall != null) {
                        savedCall.reject("Download failed: file not created");
                        savedCall = null;
                    }
                    return;
                }

                Log.i(TAG, "APK downloaded: " + apkFile.getAbsolutePath() +
                       " (" + apkFile.length() + " bytes)");

                pendingApkFile = apkFile;

                // Must show install prompt on UI thread
                Activity activity = getActivity();
                if (activity != null) {
                    activity.runOnUiThread(() -> {
                        // On Android 8+, check for install permission first
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                                Log.w(TAG, "No REQUEST_INSTALL_PACKAGES permission, requesting...");
                                requestInstallPermission();
                                return;
                            }
                        }
                        promptInstall();
                    });
                } else {
                    if (savedCall != null) {
                        savedCall.reject("Activity not available");
                        savedCall = null;
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Download failed", e);
                if (savedCall != null) {
                    savedCall.reject("Download failed: " + e.getMessage());
                    savedCall = null;
                }
            }
        }).start();
    }

    /**
     * Check if the app can install APK packages (Android 8+).
     * On Android < 8, always returns true.
     */
    @PluginMethod
    public void canInstallApk(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            result.put("canInstall", getContext().getPackageManager().canRequestPackageInstalls());
            result.put("needsPermission", true);
        } else {
            result.put("canInstall", true);
            result.put("needsPermission", false);
        }
        call.resolve(result);
    }

    /**
     * Request the REQUEST_INSTALL_PACKAGES permission (Android 8+).
     * This opens the system settings page for the user to grant permission.
     */
    @PluginMethod
    public void requestInstallPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            savedCall = call;
            requestInstallPermission();
        } else {
            call.resolve(new JSObject().put("granted", true));
        }
    }

    /**
     * Internal: Request install permission via system settings.
     */
    private void requestInstallPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(savedCall, intent, REQUEST_INSTALL_PERMISSION);
            } catch (Exception e) {
                Log.e(TAG, "Failed to open install permission settings", e);
                // Fallback: open app settings
                try {
                    Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                    startActivityForResult(savedCall, intent, REQUEST_INSTALL_PERMISSION);
                } catch (Exception e2) {
                    if (savedCall != null) {
                        savedCall.reject("Cannot open install permission settings");
                        savedCall = null;
                    }
                }
            }
        }
    }

    /**
     * Internal: Download APK file from URL to cache directory.
     */
    private File downloadApk(String downloadUrl) throws Exception {
        URL url = new URL(downloadUrl);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(30000);
        connection.setReadTimeout(120000);
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive, application/octet-stream, */*");

        int responseCode = connection.getResponseCode();
        Log.i(TAG, "Download response code: " + responseCode);

        if (responseCode != HttpURLConnection.HTTP_OK) {
            throw new Exception("HTTP " + responseCode);
        }

        // Determine file name from URL or Content-Disposition
        String fileName = "passvault_update.apk";
        String disposition = connection.getHeaderField("Content-Disposition");
        if (disposition != null && disposition.contains("filename=")) {
            int idx = disposition.indexOf("filename=");
            String extracted = disposition.substring(idx + 9).replace("\"", "").trim();
            if (!extracted.isEmpty()) {
                fileName = extracted;
            }
        }

        // Also check URL path for filename
        String urlPath = url.getPath();
        if (urlPath != null && urlPath.endsWith(".apk")) {
            int lastSlash = urlPath.lastIndexOf('/');
            if (lastSlash >= 0 && lastSlash < urlPath.length() - 1) {
                fileName = urlPath.substring(lastSlash + 1);
            }
        }

        // Clean up any previous update APK
        File cacheDir = getContext().getCacheDir();
        File oldApk = new File(cacheDir, "passvault_update.apk");
        if (oldApk.exists()) {
            oldApk.delete();
        }

        File apkFile = new File(cacheDir, fileName);

        // Download with progress
        int contentLength = connection.getContentLength();
        Log.i(TAG, "Content-Length: " + contentLength + " bytes");

        InputStream input = connection.getInputStream();
        FileOutputStream output = new FileOutputStream(apkFile);

        byte[] buffer = new byte[8192];
        int bytesRead;
        long totalRead = 0;
        int lastProgressPercent = -1;

        while ((bytesRead = input.read(buffer)) != -1) {
            output.write(buffer, 0, bytesRead);
            totalRead += bytesRead;

            if (contentLength > 0) {
                int progressPercent = (int) ((totalRead * 100) / contentLength);
                // Notify progress every 5%
                if (progressPercent != lastProgressPercent && progressPercent % 5 == 0) {
                    lastProgressPercent = progressPercent;
                    notifyProgress(progressPercent, totalRead, contentLength);
                }
            }
        }

        output.flush();
        output.close();
        input.close();
        connection.disconnect();

        Log.i(TAG, "Download complete: " + totalRead + " bytes");

        // Verify the file is a valid size (at least 1MB)
        if (apkFile.length() < 1024 * 1024) {
            Log.w(TAG, "Downloaded file is suspiciously small: " + apkFile.length() + " bytes");
        }

        return apkFile;
    }

    /**
     * Internal: Notify JS layer of download progress.
     */
    private void notifyProgress(int percent, long downloaded, long total) {
        try {
            JSObject data = new JSObject();
            data.put("percent", percent);
            data.put("downloaded", downloaded);
            data.put("total", total);
            notifyListeners("downloadProgress", data);
        } catch (Exception e) {
            // Ignore — JS layer might not be listening
        }
    }

    /**
     * Internal: Prompt the user to install the downloaded APK.
     */
    private void promptInstall() {
        if (pendingApkFile == null || !pendingApkFile.exists()) {
            if (savedCall != null) {
                savedCall.reject("APK file not found");
                savedCall = null;
            }
            return;
        }

        try {
            Activity activity = getActivity();
            if (activity == null) {
                if (savedCall != null) {
                    savedCall.reject("Activity not available");
                    savedCall = null;
                }
                return;
            }

            // Use FileProvider to create a content URI
            Uri apkUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                pendingApkFile
            );

            Log.i(TAG, "Installing APK from: " + apkUri);

            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);

            // Resolve activity to prevent crash
            if (installIntent.resolveActivity(activity.getPackageManager()) != null) {
                activity.startActivity(installIntent);

                if (savedCall != null) {
                    JSObject result = new JSObject();
                    result.put("success", true);
                    result.put("message", "Install prompt shown");
                    savedCall.resolve(result);
                    savedCall = null;
                }
            } else {
                Log.e(TAG, "No activity found to handle APK install intent");
                if (savedCall != null) {
                    savedCall.reject("No installer available on this device");
                    savedCall = null;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to prompt install", e);
            if (savedCall != null) {
                savedCall.reject("Install prompt failed: " + e.getMessage());
                savedCall = null;
            }
        }
    }

    /**
     * Handle activity results (install permission grant, etc.)
     */
    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_INSTALL_PERMISSION) {
            // User came back from install permission settings
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                boolean canInstall = getContext().getPackageManager().canRequestPackageInstalls();
                Log.i(TAG, "Install permission result: canInstall=" + canInstall);

                if (canInstall && pendingApkFile != null) {
                    // Permission granted, now prompt install
                    promptInstall();
                } else if (savedCall != null) {
                    JSObject result = new JSObject();
                    result.put("success", false);
                    result.put("error", "Install permission denied");
                    savedCall.resolve(result);
                    savedCall = null;
                }
            }
        }
    }
}
