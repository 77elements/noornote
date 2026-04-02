package com.noornote.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.noornote.plugins.amber.AmberPlugin;
import com.noornote.plugins.mediasave.MediaSavePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AmberPlugin.class);
        registerPlugin(MediaSavePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
