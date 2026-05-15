package com.passvault.app;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;
import com.passvault.app.plugins.BiometricPlugin;
import com.passvault.app.plugins.FilePickerPlugin;
import com.passvault.app.plugins.UpdaterPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom Capacitor plugins BEFORE super.onCreate()
        // so they are available when the WebView loads
        registerPlugin(BiometricPlugin.class);
        registerPlugin(FilePickerPlugin.class);
        registerPlugin(UpdaterPlugin.class);

        super.onCreate(savedInstanceState);

        // FLAG_SECURE: Prevent screenshots and screen recording
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
    }
}
