package com.onesa.pasofi;

import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.wallet.IsReadyToPayRequest;
import com.google.android.gms.wallet.PaymentsClient;
import com.google.android.gms.wallet.Wallet;
import com.google.android.gms.wallet.WalletConstants;
import com.stripe.android.GooglePayConfig;
import com.stripe.android.GooglePayJsonFactory;
import com.stripe.android.PaymentConfiguration;
import com.stripe.android.paymentsheet.PaymentSheet;
import com.stripe.android.paymentsheet.PaymentSheetResult;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;

/** Native card data stays in Stripe's UI. Only fixed statuses cross back to JavaScript. */
@CapacitorPlugin(name = "PasoFiStripe")
public final class PasoFiStripePlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private PaymentSheet paymentSheet;
    private PluginCall pendingPayment;

    @Override
    public void load() {
        // Registration happens inside BridgeActivity.onCreate, before STARTED. Constructing
        // an ActivityResult launcher in a later JavaScript call would fail lifecycle checks.
        paymentSheet = new PaymentSheet.Builder(this::onPaymentSheetResult).build(getActivity());
    }

    @PluginMethod
    public void availability(PluginCall call) {
        StripeCheckoutOptions options = parseOptions(call);
        if (options == null) {
            call.reject("Payment configuration is unavailable.", "invalid_configuration");
            return;
        }
        if (!options.googlePay) {
            resolveAvailability(call, false);
            return;
        }
        main.post(() -> {
            AtomicBoolean finished = new AtomicBoolean();
            Runnable timeout = () -> {
                if (finished.compareAndSet(false, true)) resolveAvailability(call, false);
            };
            main.postDelayed(timeout, 5000);
            try {
                // Match Stripe's card-network readiness request without mutating its global key.
                GooglePayJsonFactory factory = new GooglePayJsonFactory(
                    new GooglePayConfig(options.publishableKey),
                    "JP".equals(options.country), Collections.emptyList()
                );
                IsReadyToPayRequest request = IsReadyToPayRequest.fromJson(
                    factory.createIsReadyToPayRequest(null, true, true).toString()
                );
                if (request == null) throw new IllegalStateException();
                PaymentsClient client = Wallet.getPaymentsClient(getContext(),
                    new Wallet.WalletOptions.Builder().setEnvironment(options.testMode
                        ? WalletConstants.ENVIRONMENT_TEST : WalletConstants.ENVIRONMENT_PRODUCTION).build());
                client.isReadyToPay(request).addOnCompleteListener(task -> {
                    if (finished.compareAndSet(false, true)) {
                        main.removeCallbacks(timeout);
                        resolveAvailability(call, task.isSuccessful() && Boolean.TRUE.equals(task.getResult()));
                    }
                });
            } catch (RuntimeException ignored) {
                if (finished.compareAndSet(false, true)) {
                    main.removeCallbacks(timeout);
                    resolveAvailability(call, false);
                }
            }
        });
    }

    @PluginMethod
    public void present(PluginCall call) {
        StripeCheckoutOptions options = parseOptions(call);
        String secret = call.getString("clientSecret");
        if (options == null || !StripeCheckoutOptions.validPresentation(secret, call.getString("merchantDisplayName"))) {
            call.reject("Payment configuration is unavailable.", "invalid_configuration");
            return;
        }
        main.post(() -> {
            if (pendingPayment != null) {
                call.reject("A payment is already open.", "payment_in_progress");
                return;
            }
            if (paymentSheet == null || getActivity().isFinishing() || getActivity().isDestroyed()) {
                resolveStatus(call, "failed");
                return;
            }
            pendingPayment = call;
            try {
                PaymentConfiguration.init(getContext(), options.publishableKey);
                PaymentSheet.Companion.resetCustomer(getContext());
                PaymentSheet.Configuration.Builder builder = new PaymentSheet.Configuration.Builder("Pasofi")
                    .allowsDelayedPaymentMethods(false)
                    .link(new PaymentSheet.LinkConfiguration(PaymentSheet.LinkConfiguration.Display.Never));
                if (options.googlePay) {
                    builder.googlePay(new PaymentSheet.GooglePayConfiguration(options.testMode
                        ? PaymentSheet.GooglePayConfiguration.Environment.Test
                        : PaymentSheet.GooglePayConfiguration.Environment.Production, options.country));
                }
                // Android's SDK owns its SCA return activity and merged intent filter.
                paymentSheet.presentWithPaymentIntent(secret, builder.build());
            } catch (RuntimeException ignored) {
                pendingPayment = null;
                resolveStatus(call, "failed");
            }
        });
    }

    private void onPaymentSheetResult(PaymentSheetResult result) {
        PluginCall call = pendingPayment;
        pendingPayment = null;
        if (call == null) return; // A recreated app recovers its saved order from the backend.
        if (result instanceof PaymentSheetResult.Completed) resolveStatus(call, "completed");
        else if (result instanceof PaymentSheetResult.Canceled) resolveStatus(call, "cancelled");
        else resolveStatus(call, "failed");
    }

    @Override
    protected void handleOnDestroy() {
        PluginCall call = pendingPayment;
        pendingPayment = null;
        paymentSheet = null;
        if (call != null) resolveStatus(call, "failed");
    }

    private static void resolveAvailability(PluginCall call, boolean googlePay) {
        JSObject result = new JSObject();
        result.put("applePay", false);
        result.put("googlePay", googlePay);
        call.resolve(result);
    }

    private static void resolveStatus(PluginCall call, String status) {
        JSObject result = new JSObject();
        result.put("status", status);
        call.resolve(result);
    }

    private static StripeCheckoutOptions parseOptions(PluginCall call) {
        return StripeCheckoutOptions.parse(call.getString("publishableKey"), call.getString("merchantCountryCode"),
            call.getBoolean("testMode"), call.getBoolean("googlePay"));
    }
}
