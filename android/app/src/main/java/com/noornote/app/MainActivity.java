package com.noornote.app;

import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.noornote.plugins.mediasave.MediaSavePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaSavePlugin.class);
        super.onCreate(savedInstanceState);

        // Consume system bar insets at the native level.
        // This ensures the WebView content area never extends behind
        // status bar or navigation bar — on ALL Android versions.
        // (API 35+ enforces edge-to-edge regardless of app code.)
        View contentView = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(contentView, (view, windowInsets) -> {
            Insets systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
            // Clear system bar insets so WebView doesn't double-pad via CSS env(safe-area-inset-*)
            // Preserve IME (keyboard) insets for proper keyboard handling
            return new WindowInsetsCompat.Builder(windowInsets)
                .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.of(0, 0, 0, 0))
                .build();
        });
    }
}
