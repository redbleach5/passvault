# ===== PassVault ProGuard Rules =====

# Keep Capacitor plugin classes (accessed via reflection)
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.annotation.CapacitorPlugin <methods>;
    @com.getcapacitor.annotation.PluginMethod <methods>;
}

# Keep Autofill service (referenced in AndroidManifest.xml)
-keep class com.passvault.app.autofill.** { *; }
-keep class com.passvault.app.plugins.** { *; }
-keep class com.passvault.app.MainActivity { *; }

# Keep EncryptedSharedPreferences and security crypto
-keep class androidx.security.crypto.** { *; }
-keep class androidx.biometric.** { *; }

# Keep Android Keystore-related classes
-keep class java.security.KeyStore { *; }
-keep class javax.crypto.** { *; }

# Keep Serializable/Parcelable classes
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    !static !transient <fields>;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}

# Preserve line numbers for crash logs
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Remove logging in release builds
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}

# Keep WebView JavaScript interface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep JSON serialization (used in AutofillHelper)
-keep class org.json.** { *; }
