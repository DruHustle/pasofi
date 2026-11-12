package com.onesa.pasofi;

import static org.junit.Assert.*;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class CustomerSessionStateTest {
    private static final String ORIGIN = "https://api.pasofi.test";
    private static final String CUSTOMER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final String TOKEN = repeat('T', 43), RETRY = repeat('R', 43);
    private static final long NOW = 1_700_000_000_000L;
    private static String repeat(char character, int count) { char[] value = new char[count]; Arrays.fill(value, character); return new String(value); }
    private static CustomerApiPolicy.Options options(String method, String path) { return CustomerApiPolicy.parse(CUSTOMER, path, method, null, null, "json"); }
    private static CustomerApiPolicy.CookieUpdate cookie() {
        return CustomerApiPolicy.cookieUpdate(Collections.singletonList("__Host-pamofi_session=" + TOKEN + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000"), options("POST", "/api/session"), 201, NOW);
    }
    private interface Checked { void run() throws Exception; }
    private static void rejects(Checked work) { try { work.run(); fail("Expected invalid private state rejection"); } catch (IOException | IllegalArgumentException | IllegalStateException expected) {} catch (Exception unexpected) { throw new AssertionError(unexpected); } }

    @Test public void creationRetrySurvivesAmbiguityRestartAndOnlyMatchingConfirmationClearsIt() throws Exception {
        CustomerSessionState pending = CustomerSessionState.empty().withCreationRetry(RETRY);
        assertSame(pending, pending.withCreationRetry(repeat('N', 43)));
        CustomerSessionState restarted = CustomerSessionState.decode(ORIGIN, pending.encode(ORIGIN));
        assertEquals(RETRY, restarted.creationRetry); assertNull(restarted.cookie);
        CustomerSessionState created = restarted.identityResult(options("POST", "/api/session"), cookie(), CUSTOMER, NOW);
        assertEquals(RETRY, created.creationRetry); assertEquals(CUSTOMER, created.creationCustomerId); assertEquals(TOKEN, created.usableCookie(NOW));
        CustomerSessionState confirmed = CustomerSessionState.decode(ORIGIN, created.encode(ORIGIN)).confirmed(CUSTOMER, NOW);
        assertNull(confirmed.creationRetry); assertNull(confirmed.creationCustomerId); assertEquals(TOKEN, confirmed.cookie);
        assertEquals(RETRY, created.creationRetry); // Immutable candidate never changed its predecessor.
    }

    @Test public void differentCustomerCannotConfirmThePendingCreationOrReplaceItsCookie() {
        CustomerSessionState created = CustomerSessionState.empty().withCreationRetry(RETRY).identityResult(options("POST", "/api/session"), cookie(), CUSTOMER, NOW);
        rejects(() -> created.confirmed(OTHER, NOW));
        rejects(() -> CustomerSessionState.empty().confirmed(CUSTOMER, NOW));
        assertEquals(RETRY, created.creationRetry); assertEquals(CUSTOMER, created.creationCustomerId); assertEquals(TOKEN, created.cookie);
        rejects(() -> CustomerSessionState.empty().identityResult(options("POST", "/api/session"), cookie(), CUSTOMER, NOW));
        rejects(() -> CustomerSessionState.empty().withCreationRetry(RETRY).identityResult(options("POST", "/api/session"), null, CUSTOMER, NOW));
    }

    @Test public void onlySuccessfulRecoveryReplacesIdentityAndClearsOldRetryCustody() {
        CustomerSessionState previous = CustomerSessionState.empty().withCreationRetry(RETRY);
        CustomerSessionState recovered = previous.identityResult(options("POST", "/api/recovery"), cookie(), OTHER, NOW);
        assertEquals(TOKEN, recovered.cookie); assertNull(recovered.creationRetry); assertNull(recovered.creationCustomerId);
        assertEquals(RETRY, previous.creationRetry);
        rejects(() -> previous.identityResult(options("POST", "/api/recovery"), null, OTHER, NOW));
        rejects(() -> previous.identityResult(options("POST", "/api/handoff"), cookie(), OTHER, NOW));
    }

    @Test public void pendingLogoutSurvivesRestartAndCannotCreateOrAdoptAnotherAccount() throws Exception {
        CustomerSessionState prior = new CustomerSessionState(TOKEN, NOW + 60_000, RETRY, CUSTOMER, false);
        CustomerSessionState pending = CustomerSessionState.decode(ORIGIN, prior.beginLogout().encode(ORIGIN));
        assertTrue(pending.logoutPending); assertEquals(TOKEN, pending.cookie); assertEquals(RETRY, pending.creationRetry);
        rejects(() -> pending.withCreationRetry(repeat('N', 43)));
        rejects(() -> pending.identityResult(options("POST", "/api/recovery"), cookie(), OTHER, NOW));
        rejects(() -> pending.identityResult(options("POST", "/api/session"), cookie(), OTHER, NOW));
        assertFalse(prior.logoutPending); assertTrue(pending.logoutPending);
    }

    @Test public void expiredCookieIsUnusableAndTerminalRetryExpiryDoesNotReplaceAnAccount() {
        CustomerSessionState prior = new CustomerSessionState(TOKEN, NOW - 1, RETRY, CUSTOMER, false);
        assertNull(prior.usableCookie(NOW));
        rejects(() -> prior.confirmed(CUSTOMER, NOW));
        CustomerSessionState terminal = prior.retryExpired();
        assertNull(terminal.creationRetry); assertNull(terminal.creationCustomerId); assertEquals(TOKEN, terminal.cookie); assertEquals(prior.cookieExpiresAt, terminal.cookieExpiresAt);
    }

    @Test public void rejectedStoredCookieRetiresItsCreationCustodyAcrossRestart() throws Exception {
        for (boolean pendingLogout : new boolean[]{false, true}) {
            CustomerSessionState prior = new CustomerSessionState(TOKEN, NOW + 60_000, RETRY, CUSTOMER, pendingLogout);
            CustomerSessionState retired = CustomerSessionState.decode(ORIGIN, prior.unauthenticated().encode(ORIGIN));
            assertNull(retired.cookie); assertEquals(0, retired.cookieExpiresAt);
            assertNull(retired.creationRetry); assertNull(retired.creationCustomerId); assertFalse(retired.logoutPending);
            rejects(() -> retired.confirmed(CUSTOMER, NOW));
            CustomerSessionState freshlyRecovered = retired.identityResult(options("POST", "/api/handoff/redeem"), cookie(), CUSTOMER, NOW);
            assertEquals(TOKEN, freshlyRecovered.usableCookie(NOW));
            assertEquals(TOKEN, prior.cookie); // The prior immutable state was not mutated.
        }
    }

    @Test public void unauthenticatedNoCookieCreationRetainsItsUnconfirmedRetryAcrossRestart() throws Exception {
        CustomerSessionState pending = CustomerSessionState.empty().withCreationRetry(RETRY);
        CustomerSessionState resumed = CustomerSessionState.decode(ORIGIN, pending.unauthenticated().encode(ORIGIN));
        assertNull(resumed.cookie); assertEquals(0, resumed.cookieExpiresAt);
        assertEquals(RETRY, resumed.creationRetry); assertNull(resumed.creationCustomerId); assertFalse(resumed.logoutPending);
        CustomerSessionState created = resumed.identityResult(options("POST", "/api/session"), cookie(), CUSTOMER, NOW);
        assertEquals(RETRY, created.creationRetry);
        assertNull(created.confirmed(CUSTOMER, NOW).creationRetry);
    }

    @Test public void privateSerializationBindsTheExactOriginAndRejectsCorruptionOrInvalidVersion() throws Exception {
        CustomerSessionState pending = new CustomerSessionState(TOKEN, NOW + 60_000, RETRY, CUSTOMER, true);
        byte[] encoded = pending.encode(ORIGIN);
        rejects(() -> CustomerSessionState.decode("https://other.pasofi.test", encoded));
        rejects(() -> CustomerSessionState.decode(ORIGIN, Arrays.copyOf(encoded, encoded.length - 1)));
        rejects(() -> CustomerSessionState.decode(ORIGIN, Arrays.copyOf(encoded, encoded.length + 1)));
        byte[] version = encoded.clone(); version[3] = 2;
        rejects(() -> CustomerSessionState.decode(ORIGIN, version));
        rejects(() -> CustomerSessionState.decode(ORIGIN, new byte[4097]));
        rejects(() -> new CustomerSessionState("invalid", NOW, null, null, false));
        rejects(() -> new CustomerSessionState(null, NOW, null, null, false));
        rejects(() -> new CustomerSessionState(null, 0, null, CUSTOMER, false));
    }
}
