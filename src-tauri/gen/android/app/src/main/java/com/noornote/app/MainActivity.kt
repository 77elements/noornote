package com.noornote.app

import android.os.Bundle
import android.graphics.Color
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Consume system bar insets at the native level.
        // This ensures the WebView content area never extends behind
        // status bar or navigation bar — on ALL Android versions.
        // (API 35+ enforces edge-to-edge regardless of app code.)
        val contentView: View = findViewById(android.R.id.content)
        contentView.setBackgroundColor(Color.parseColor("#0f0d23"))

        ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, windowInsets ->
            val systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            // Clear system bar insets so WebView doesn't double-pad via CSS env(safe-area-inset-*)
            // Preserve IME (keyboard) insets for proper keyboard handling
            WindowInsetsCompat.Builder(windowInsets)
                .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.of(0, 0, 0, 0))
                .build()
        }
    }
}
