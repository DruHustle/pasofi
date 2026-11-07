package com.onesa.pasofi;

import static org.junit.Assert.*;
import org.junit.Test;

public class StripeCheckoutOptionsTest {
    @Test
    public void acceptsMatchingKeyModesAndExplicitWalletChoice() {
        StripeCheckoutOptions test = StripeCheckoutOptions.parse("pk_test_fixture123", "GB", true, true);
        assertNotNull(test);
        assertTrue(test.testMode);
        assertTrue(test.googlePay);
        StripeCheckoutOptions live = StripeCheckoutOptions.parse("pk_live_fixture123", "GH", false, false);
        assertNotNull(live);
        assertFalse(live.testMode);
        assertFalse(live.googlePay);
    }

    @Test
    public void rejectsCrossedTestAndLiveModesBeforeSdkInitialization() {
        assertNull(StripeCheckoutOptions.parse("pk_test_fixture123", "GB", false, true));
        assertNull(StripeCheckoutOptions.parse("pk_live_fixture123", "GB", true, true));
        assertNull(StripeCheckoutOptions.parse("pk_test_fixture123", "GB", null, true));
    }

    @Test
    public void rejectsSecretKeysAndMalformedPublishableKeys() {
        for (String key : new String[]{"sk_test_fixture123", "pk_test_", "pk_test_fixture\n", "pk_test_fixture/abc", null}) {
            assertNull(StripeCheckoutOptions.parse(key, "GB", true, true));
        }
        assertNull(StripeCheckoutOptions.parse("pk_test_" + "a".repeat(505), "GB", true, true));
    }

    @Test
    public void rejectsMissingWalletChoiceAndMalformedMerchantCountry() {
        assertNull(StripeCheckoutOptions.parse("pk_test_fixture123", "GB", true, null));
        for (String country : new String[]{"gb", "GBP", "GB\n", "", null}) {
            assertNull(StripeCheckoutOptions.parse("pk_test_fixture123", country, true, true));
        }
    }

    @Test
    public void permitsOnlyPaymentIntentSecretsForPasoFi() {
        assertTrue(StripeCheckoutOptions.validPresentation("pi_fixture123_secret_fixture456", "PasoFi"));
        for (String secret : new String[]{"seti_fixture_secret_fixture", "pi_fixture", "pi_fixture_secret_fixture\n", null}) {
            assertFalse(StripeCheckoutOptions.validPresentation(secret, "PasoFi"));
        }
        assertFalse(StripeCheckoutOptions.validPresentation("pi_fixture_secret_fixture", "Another merchant"));
        assertFalse(StripeCheckoutOptions.validPresentation("pi_fixture_secret_" + "a".repeat(512), "PasoFi"));
    }
}
