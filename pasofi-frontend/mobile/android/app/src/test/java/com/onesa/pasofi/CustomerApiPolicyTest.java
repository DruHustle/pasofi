package com.onesa.pasofi;

import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class CustomerApiPolicyTest {
    private static final String ID = "17c4d8af-3950-44e1-84a0-f8b4d38c0862";
    private static final String TOKEN = repeat('T', 43);
    private static final long NOW = 1_700_000_000_000L;
    private static final String COOKIE = "__Host-pamofi_session=" + TOKEN + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000";
    private static String repeat(char character, int count) { char[] value = new char[count]; Arrays.fill(value, character); return new String(value); }
    private static CustomerApiPolicy.Options request(String method, String path) {
        String kind = path.endsWith("/pdf") || path.equals("/api/invoice-downloads") ? "pdf" : "json";
        return CustomerApiPolicy.parse(ID, path, method, null, null, kind);
    }
    private static void rejectsCookie(String cookie, CustomerApiPolicy.Options options, int status) {
        try { CustomerApiPolicy.cookieUpdate(Collections.singletonList(cookie), options, status, NOW); fail("Expected cookie rejection"); }
        catch (IllegalArgumentException expected) { assertEquals("invalid_cookie", expected.getMessage()); }
    }

    @Test public void pinsOneCanonicalHttpsDnsOriginWithoutPathsOrCredentials() {
        assertTrue(CustomerApiPolicy.validOrigin("https://api.pasofi.test"));
        for (String value : new String[]{null, "", "http://api.pasofi.test", "https://api.pasofi.test/", "https://API.pasofi.test",
            "https://api.pasofi.test:443", "https://user:password@api.pasofi.test", "https://api.pasofi.test/api", "https://api.pasofi.test?q=1",
            "https://api.pasofi.test#fragment", "https://127.0.0.1", "https://[::1]", "https://api.local", "https://api.localhost", "https://api.pasofi.test\n"}) {
            assertFalse(String.valueOf(value), CustomerApiPolicy.validOrigin(value));
        }
    }

    @Test public void acceptsOnlyTheCustomerWorkflowMethodsIncludingInvoices() {
        String[][] routes = {{"GET", "/api/capabilities"}, {"GET", "/api/bundles"}, {"GET", "/api/sites"}, {"GET", "/api/session"},
            {"POST", "/api/session"}, {"DELETE", "/api/session"}, {"GET", "/api/recovery/status"}, {"POST", "/api/recovery"},
            {"POST", "/api/recovery/setup"}, {"POST", "/api/recovery/rotate"}, {"POST", "/api/handoff"}, {"POST", "/api/handoff/redeem"},
            {"GET", "/api/orders"}, {"POST", "/api/orders"}, {"GET", "/api/orders/" + ID + "/status"}, {"POST", "/api/orders/" + ID + "/checkout"},
            {"POST", "/api/orders/" + ID + "/expire-unused"}, {"POST", "/api/vouchers/redeem"}, {"POST", "/api/receipt-pairings"},
            {"GET", "/api/receipt-pairings/" + ID}, {"POST", "/api/receipt-pairings/" + ID + "/cancel"}, {"GET", "/api/network/sites"},
            {"GET", "/api/network/session"}, {"POST", "/api/network/credentials"}, {"POST", "/api/network/disconnect"},
            {"GET", "/api/customer/invoices"}, {"GET", "/api/customer/invoices/" + ID}, {"GET", "/api/customer/invoices/" + ID + "/pdf"},
            {"POST", "/api/invoice-downloads"}};
        for (String[] route : routes) assertNotNull(route[0] + " " + route[1], request(route[0], route[1]));
        for (String[] route : new String[][]{{"HEAD", "/api/session"}, {"PUT", "/api/session"}, {"POST", "/api/bundles"},
            {"DELETE", "/api/orders"}, {"GET", "/api/recovery"}, {"GET", "/api/invoice-downloads"}}) assertNull(request(route[0], route[1]));
    }

    @Test public void rejectsStaffInternalRedirectAndTraversalTargetsBeforeNetworking() {
        for (String path : new String[]{"/api/staff/session", "/api/staff/invoices/" + ID + "/pdf", "/api/admin/routers", "/api/internal/v1/session",
            "/api/callbacks/stripe", "https://elsewhere.test/api/session", "//elsewhere.test/api/session", "/api/../api/session", "/api/%2e%2e/session",
            "/api/%73ession", "/api/session#fragment", "/api/session\\extra", "/api//session", "/api/session\n", "/api/session?__pamofi_path=session",
            "/api/session?path=session", "/api/gateway?__pamofi_path=session"}) assertNull(path, request("GET", path));
        assertNull(request("GET", "/api/session?"));
        assertNull(request("POST", "/api/orders/" + ID + "/demo-confirm"));
        assertNull(request("POST", "/api/staff/login"));
        assertNull(request("POST", "/api/admin/routers/" + ID + "/changes"));
    }

    @Test public void boundsQueriesAndRefusesDuplicatesUnknownKeysAndMutationQueries() {
        for (String path : new String[]{"/api/access?limit=100&offset=1000000", "/api/usage?entitlementIds=" + ID + "%2C" + ID,
            "/api/orders?requestKey=" + repeat('R', 43), "/api/payments/methods?siteId=" + ID + "&bundleId=flex",
            "/api/customer/invoices?limit=25&offset=0&orderId=" + ID, "/api/help?q=How+do+I+connect%3F"}) assertNotNull(path, request("GET", path));
        for (String path : new String[]{"/api/access?limit=0", "/api/access?limit=101", "/api/access?offset=-1", "/api/access?offset=1000001",
            "/api/access?limit=1&limit=2", "/api/access?limit=1&%6cimit=2", "/api/access?customerId=" + ID, "/api/session?customerId=" + ID,
            "/api/orders?requestKey=short", "/api/usage?entitlementIds=wrong", "/api/help?q=bad%00value", "/api/help?q=%FF",
            "/api/help?q=" + repeat('x', 201), "/api/help?q=%q1"}) assertNull(path, request("GET", path));
        assertNull(request("POST", "/api/orders?requestKey=" + repeat('R', 43)));
    }

    @Test public void boundsRequestBodiesAndKeepsCreationRetryKeysOutOfJavascript() {
        assertNotNull(CustomerApiPolicy.parse(ID, "/api/orders", "POST", "{}", repeat('K', 43), "json"));
        assertNull(CustomerApiPolicy.parse(ID, "/api/session", "POST", null, repeat('K', 43), "json"));
        assertNull(CustomerApiPolicy.parse(ID, "/api/orders", "POST", "{}", "short", "json"));
        assertNull(CustomerApiPolicy.parse(ID, "/api/orders", "POST", "{}", repeat('K', 129), "json"));
        assertNull(CustomerApiPolicy.parse(ID, "/api/orders", "POST", repeat('x', 32769), null, "json"));
        assertNull(CustomerApiPolicy.parse(ID, "/api/orders", "POST", repeat('\u00e9', 16385), null, "json"));
        assertNull(CustomerApiPolicy.parse(ID, "/api/session", "GET", "{}", null, "json"));
        assertNull(CustomerApiPolicy.parse(ID, "/api/session", "DELETE", "{}", null, "json"));
        assertNull(CustomerApiPolicy.parse("not-a-uuid", "/api/session", "GET", null, null, "json"));
        assertNull(CustomerApiPolicy.parse(ID, "/api/customer/invoices/" + ID + "/pdf", "GET", null, null, "json"));
        assertNull(CustomerApiPolicy.parse(ID, "/api/session", "GET", null, null, "pdf"));
    }

    @Test public void customerCookieCanOnlyBeAcceptedAtTheMatchingSuccessfulIdentityTransition() {
        for (String path : new String[]{"/api/session", "/api/recovery", "/api/handoff/redeem"}) {
            CustomerApiPolicy.CookieUpdate value = CustomerApiPolicy.cookieUpdate(Collections.singletonList(COOKIE), request("POST", path), path.equals("/api/session") ? 201 : 200, NOW);
            assertEquals(TOKEN, value.token); assertEquals(NOW + 2_592_000_000L, value.expiresAt);
        }
        rejectsCookie(COOKIE, request("GET", "/api/session"), 200);
        rejectsCookie(COOKIE, request("GET", "/api/capabilities"), 200);
        rejectsCookie(COOKIE, request("POST", "/api/recovery"), 401);
        rejectsCookie(COOKIE, request("POST", "/api/handoff"), 200);
        rejectsCookie(COOKIE, request("DELETE", "/api/session"), 204);
        assertNull(CustomerApiPolicy.cookieUpdate(Collections.<String>emptyList(), request("GET", "/api/session"), 200, NOW));
    }

    @Test public void rejectsForeignDuplicateCrossDomainInsecureAndOverscopedCookies() {
        CustomerApiPolicy.Options create = request("POST", "/api/session");
        for (String cookie : new String[]{COOKIE.replace("__Host-pamofi_session", "__Host-pamofi_staff_session"), COOKIE + "; Domain=api.pasofi.test",
            COOKIE.replace("Secure; ", ""), COOKIE.replace("HttpOnly; ", ""), COOKIE.replace("Path=/", "Path=/api"), COOKIE.replace("SameSite=Lax", "SameSite=None"),
            COOKIE + "; Path=/", COOKIE + "; Priority=High", COOKIE.replace(TOKEN, "invalid"), COOKIE.replace("2592000", "2592001"),
            COOKIE.replace("; Max-Age=2592000", ""), COOKIE.replace("2592000", "0"), COOKIE + "; Expires=not-a-date", COOKIE + "\r\n"}) rejectsCookie(cookie, create, 201);
        try { CustomerApiPolicy.cookieUpdate(Arrays.asList(COOKIE, COOKIE), create, 201, NOW); fail("Expected duplicate-cookie refusal"); }
        catch (IllegalArgumentException expected) { assertEquals("invalid_cookie", expected.getMessage()); }
    }

    @Test public void onlyConfirmedLogoutCanClearTheHostCookie() {
        String clear = "__Host-pamofi_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
        CustomerApiPolicy.Options logout = request("DELETE", "/api/session");
        CustomerApiPolicy.CookieUpdate value = CustomerApiPolicy.cookieUpdate(Collections.singletonList(clear), logout, 204, NOW);
        assertNull(value.token); assertEquals(0, value.expiresAt);
        String expiry = clear.replace("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        assertNull(CustomerApiPolicy.cookieUpdate(Collections.singletonList(expiry), logout, 204, NOW).token);
        rejectsCookie(clear, logout, 401); rejectsCookie(clear, request("POST", "/api/session"), 201);
        rejectsCookie(clear.replace("session=", "session"), logout, 204);
        rejectsCookie(clear.replace("Max-Age=0", "Max-Age=3600"), logout, 204);
        rejectsCookie(clear.replace("Max-Age=0", "Expires=Thu, 01 Jan 2099 00:00:00 GMT"), logout, 204);
    }

    @Test public void retryAfterIsBoundedAndNeverAcceptsUntrustedHeaderContent() {
        assertEquals(20_000, CustomerApiPolicy.retryAfter("20", NOW));
        assertEquals(300_000, CustomerApiPolicy.retryAfter("999999999", NOW));
        for (String value : new String[]{null, "", "-1", "0", "not-a-date", "20\r\nSet-Cookie: synthetic", repeat('9', 65)}) assertEquals(0, CustomerApiPolicy.retryAfter(value, NOW));
    }

    @Test public void identityOperationsRequireTheirExactSuccessfulStatusBeforeChangingPrivateState() {
        assertTrue(CustomerApiPolicy.allowedStatus(request("POST", "/api/session"), 200));
        assertTrue(CustomerApiPolicy.allowedStatus(request("POST", "/api/session"), 201));
        assertFalse(CustomerApiPolicy.allowedStatus(request("POST", "/api/session"), 202));
        assertFalse(CustomerApiPolicy.allowedStatus(request("POST", "/api/recovery"), 201));
        assertFalse(CustomerApiPolicy.allowedStatus(request("POST", "/api/handoff/redeem"), 204));
        assertFalse(CustomerApiPolicy.allowedStatus(request("GET", "/api/session"), 204));
        assertTrue(CustomerApiPolicy.allowedStatus(request("DELETE", "/api/session"), 204));
        assertFalse(CustomerApiPolicy.allowedStatus(request("DELETE", "/api/session"), 200));
        assertFalse(CustomerApiPolicy.allowedStatus(request("GET", "/api/session"), 307));
        assertTrue(CustomerApiPolicy.allowedStatus(request("GET", "/api/session"), 401));
    }
}
