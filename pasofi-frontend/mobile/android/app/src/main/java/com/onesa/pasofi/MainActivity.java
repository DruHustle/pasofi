package com.onesa.pasofi;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PasoFiStripePlugin.class);
        registerPlugin(PasoFiCustomerApiPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
