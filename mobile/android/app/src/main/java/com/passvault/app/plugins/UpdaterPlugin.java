package com.passvault.app.plugins;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

/**
 * UpdaterPlugin — Capacitor plugin for downloading and installing APK updates.
 *
 * SECURITY: Verifies APK signing certificate before installation.
 * The downloaded APK must be signed with the same certificate as the currently
 * running app, preventing malicious APK injection attacks.
 *
 * Flow:
 * 1. Download APK from URL
 * 2. Verify the APK's signing certificate matches the installed app's certificate
 * 3. If verified, trigger Android's package installer
 * 4. If verification fails, reject the update and delete the downloaded file
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
     * Verifies the APK signing certificate matches the current app before installing.
     */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String downloadUrl = call.getString("url");
        if (downloadUrl == null || downloadUrl.isEmpty()) {
            call.reject("Download URL is required");
            return;
        }

        // Validate URL must be from GitHub (prevent arbitrary URL downloads)
        if (!downloadUrl.startsWith("https://github.com/") && !downloadUrl.startsWith("https://objects.githubusercontent.com/")) {
            call.reject("Invalid download URL: must be from GitHub");
            return;
        }

        savedCall = call;

        Log.i(TAG, "Starting APK download: " + downloadUrl);

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

                // SECURITY: Verify APK signing certificate before installing
                try {
                    String installedCertHash = getInstalledAppCertHash();
                    String downloadedCertHash = getApkCertHash(apkFile);

                    if (installedCertHash == null || downloadedCertHash == null) {
                        Log.e(TAG, "SECURITY: Cannot verify APK certificate - aborting install");
                        apkFile.delete();
                        if (savedCall != null) {
                            savedCall.reject("Security verification failed: cannot verify APK signature");
                            savedCall = null;
                        }
                        return;
                    }

                    if (!installedCertHash.equals(downloadedCertHash)) {
                        Log.e(TAG, "SECURITY: APK certificate mismatch! Installed=" +
                              installedCertHash + " Downloaded=" + downloadedCertHash);
                        apkFile.delete();
                        if (savedCall != null) {
                            savedCall.reject("Security verification failed: APK signing certificate does not match. Possible tampering detected.");
                            savedCall = null;
                        }
                        return;
                    }

                    Log.i(TAG, "SECURITY: APK certificate verified successfully (" + downloadedCertHash + ")");
                } catch (Exception e) {
                    Log.e(TAG, "SECURITY: Certificate verification error", e);
                    apkFile.delete();
                    if (savedCall != null) {
                        savedCall.reject("Security verification failed: " + e.getMessage());
                        savedCall = null;
                    }
                    return;
                }

                pendingApkFile = apkFile;

                Activity activity = getActivity();
                if (activity != null) {
                    activity.runOnUiThread(() -> {
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
     * Get the SHA-256 hash of the currently installed app's signing certificate.
     * This is used as the "ground truth" for verifying update APKs.
     */
    private String getInstalledAppCertHash() {
        try {
            PackageManager pm = getContext().getPackageManager();
            String packageName = getContext().getPackageName();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                // Android 9+: Use GET_SIGNING_CERTIFICATES for proper signing info
                PackageInfo info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES);
                if (info.signingInfo != null) {
                    Signature[] signatures = info.signingInfo.getApkContentsSigners();
                    if (signatures != null && signatures.length > 0) {
                        return computeCertHash(signatures[0]);
                    }
                }
            }

            // Legacy: GET_SIGNATURES (deprecated but still works)
            PackageInfo info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES);
            if (info.signatures != null && info.signatures.length > 0) {
                return computeCertHash(info.signatures[0]);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to get installed app cert hash", e);
        }
        return null;
    }

    /**
     * Get the SHA-256 hash of the signing certificate from a downloaded APK file.
     */
    private String getApkCertHash(File apkFile) {
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo info = pm.getPackageArchiveInfo(
                apkFile.getAbsolutePath(),
                PackageManager.GET_SIGNATURES
            );

            if (info != null && info.signatures != null && info.signatures.length > 0) {
                return computeCertHash(info.signatures[0]);
            }

            // Fallback: Parse the APK's certificate directly using CertificateFactory
            // This works even when getPackageArchiveInfo fails
            return extractCertHashFromApk(apkFile);
        } catch (Exception e) {
            Log.e(TAG, "Failed to get APK cert hash", e);
        }
        return null;
    }

    /**
     * Compute SHA-256 hash of a signing certificate.
     */
    private String computeCertHash(Signature signature) {
        try {
            byte[] rawCert = signature.toByteArray();
            CertificateFactory certFactory = CertificateFactory.getInstance("X.509");
            X509Certificate cert = (X509Certificate) certFactory.generateCertificate(
                new ByteArrayInputStream(rawCert)
            );
            byte[] certEncoded = cert.getEncoded();
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(certEncoded);

            // Convert to hex string
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            Log.e(TAG, "Failed to compute cert hash", e);
            return null;
        }
    }

    /**
     * Fallback: Extract signing certificate hash directly from APK ZIP entries.
     * This method parses the APK's META-INF/*.RSA/DSA/EC file directly.
     */
    private String extractCertHashFromApk(File apkFile) {
        try {
            java.util.zip.ZipFile zipFile = new java.util.zip.ZipFile(apkFile);
            java.util.Enumeration<? extends java.util.zip.ZipEntry> entries = zipFile.entries();

            while (entries.hasMoreElements()) {
                java.util.zip.ZipEntry entry = entries.nextElement();
                String name = entry.getName().toUpperCase();

                // Look for signing certificate in META-INF/
                if (name.startsWith("META-INF/") &&
                    (name.endsWith(".RSA") || name.endsWith(".DSA") || name.endsWith(".EC"))) {

                    InputStream is = zipFile.getInputStream(entry);
                    CertificateFactory certFactory = CertificateFactory.getInstance("X.509");
                    // PKCS#7 signed data - extract certificates
                    java.util.Collection<? extends java.security.cert.Certificate> certs =
                        certFactory.generateCertificates(is);

                    for (java.security.cert.Certificate cert : certs) {
                        if (cert instanceof X509Certificate) {
                            byte[] certEncoded = cert.getEncoded();
                            MessageDigest md = MessageDigest.getInstance("SHA-256");
                            byte[] digest = md.digest(certEncoded);

                            StringBuilder sb = new StringBuilder();
                            for (byte b : digest) {
                                sb.append(String.format("%02x", b));
                            }
                            is.close();
                            zipFile.close();
                            return sb.toString();
                        }
                    }
                    is.close();
                }
            }
            zipFile.close();
        } catch (Exception e) {
            Log.e(TAG, "Failed to extract cert from APK", e);
        }
        return null;
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

        String fileName = "passvault_update.apk";
        String disposition = connection.getHeaderField("Content-Disposition");
        if (disposition != null && disposition.contains("filename=")) {
            int idx = disposition.indexOf("filename=");
            String extracted = disposition.substring(idx + 9).replace("\"", "").trim();
            if (!extracted.isEmpty()) {
                fileName = extracted;
            }
        }

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
            Log.w(TAG, "SECURITY: Downloaded file is suspiciously small: " + apkFile.length() + " bytes");
            apkFile.delete();
            throw new Exception("Downloaded file is too small - possible tampering");
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
            // Ignore
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
     * Handle activity results.
     */
    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_INSTALL_PERMISSION) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                boolean canInstall = getContext().getPackageManager().canRequestPackageInstalls();
                Log.i(TAG, "Install permission result: canInstall=" + canInstall);

                if (canInstall && pendingApkFile != null) {
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
