package com.passvault.app;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;
import com.passvault.app.plugins.AutofillPlugin;
import com.passvault.app.plugins.BiometricPlugin;
import com.passvault.app.plugins.FilePickerPlugin;
import com.passvault.app.plugins.UpdaterPlugin;

/**
 * MainActivity — Main entry point for the PassVault app.
 *
 * SECURITY FEATURES:
 * 1. FLAG_SECURE: Prevents screenshots and screen recording
 * 2. Secure flag on window: Prevents content from appearing in screenshots
 * 3. All custom plugins are registered before WebView initialization
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom Capacitor plugins BEFORE super.onCreate()
        // so they are available when the WebView loads
        registerPlugin(AutofillPlugin.class);
        registerPlugin(BiometricPlugin.class);
        registerPlugin(FilePickerPlugin.class);
        registerPlugin(UpdaterPlugin.class);

        super.onCreate(savedInstanceState);

        // SECURITY: Prevent screenshots and screen recording
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
    }

    @Override
    public void onResume() {
        super.onResume();
        // Re-apply FLAG_SECURE on resume (some Android versions may clear it)
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
    }
}
