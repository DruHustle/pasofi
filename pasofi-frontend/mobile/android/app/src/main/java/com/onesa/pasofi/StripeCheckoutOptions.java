package com.onesa.pasofi;

/** Validates bridge inputs before SDK state or native payment UI is touched. */
final class StripeCheckoutOptions {
    final String publishableKey;
    final String country;
    final boolean testMode;
    final boolean googlePay;

    private StripeCheckoutOptions(String key, String country, boolean testMode, boolean googlePay) {
        this.publishableKey = key;
        this.country = country;
        this.testMode = testMode;
        this.googlePay = googlePay;
    }

    static StripeCheckoutOptions parse(String key, String country, Boolean testMode, Boolean googlePay) {
        if (key == null || key.length() > 512 || !key.matches("^pk_(test|live)_[A-Za-z0-9]+$")
                || testMode == null || !key.startsWith(testMode ? "pk_test_" : "pk_live_")
                || country == null || !country.matches("^[A-Z]{2}$") || googlePay == null) return null;
        return new StripeCheckoutOptions(key, country, testMode, googlePay);
    }

    static boolean validPresentation(String secret, String merchantDisplayName) {
        return "PasoFi".equals(merchantDisplayName) && secret != null && secret.length() <= 512
            && secret.matches("^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$");
    }
}
