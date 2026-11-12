package com.onesa.pasofi;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;

/** Immutable private state. No instance or field is returned to the JS bridge. */
final class CustomerSessionState {
    final String cookie, creationRetry, creationCustomerId;
    final long cookieExpiresAt;
    final boolean logoutPending;

    CustomerSessionState(String cookie, long cookieExpiresAt, String creationRetry, String creationCustomerId, boolean logoutPending) {
        if ((cookie == null ? cookieExpiresAt != 0 : !CustomerApiPolicy.validToken(cookie) || cookieExpiresAt <= 0) ||
            (creationRetry != null && !CustomerApiPolicy.validToken(creationRetry)) ||
            (creationCustomerId != null && (creationRetry == null || !CustomerApiPolicy.validUuid(creationCustomerId)))) throw new IllegalArgumentException("invalid_private_state");
        this.cookie = cookie; this.cookieExpiresAt = cookieExpiresAt; this.creationRetry = creationRetry;
        this.creationCustomerId = creationCustomerId; this.logoutPending = logoutPending;
    }

    static CustomerSessionState empty() { return new CustomerSessionState(null, 0, null, null, false); }
    String usableCookie(long now) { return cookie != null && cookieExpiresAt > now ? cookie : null; }
    CustomerSessionState withCreationRetry(String key) {
        if (logoutPending || !CustomerApiPolicy.validToken(key)) throw new IllegalStateException("logout_pending");
        return creationRetry == null ? new CustomerSessionState(cookie, cookieExpiresAt, key, null, false) : this;
    }
    CustomerSessionState beginLogout() { return new CustomerSessionState(cookie, cookieExpiresAt, creationRetry, creationCustomerId, true); }
    CustomerSessionState identityResult(CustomerApiPolicy.Options options, CustomerApiPolicy.CookieUpdate update, String customerId, long now) {
        if (!CustomerApiPolicy.validUuid(customerId) || logoutPending) throw new IllegalStateException("session_changed");
        if (options.creation()) {
            if (creationRetry == null) throw new IllegalStateException("invalid_private_state");
            String next = update == null ? usableCookie(now) : update.token;
            long expires = update == null ? cookieExpiresAt : update.expiresAt;
            if (next == null || expires <= now) throw new IllegalStateException("session_unconfirmed");
            return new CustomerSessionState(next, expires, creationRetry, customerId, false);
        }
        if (!options.recovery() || update == null || update.token == null || update.expiresAt <= now) throw new IllegalStateException("session_unconfirmed");
        return new CustomerSessionState(update.token, update.expiresAt, null, null, false);
    }
    CustomerSessionState confirmed(String customerId, long now) {
        if (logoutPending || usableCookie(now) == null) throw new IllegalStateException("session_unconfirmed");
        if (!CustomerApiPolicy.validUuid(customerId)) throw new IllegalStateException("invalid_response");
        if (creationCustomerId == null) return this;
        if (!creationCustomerId.equalsIgnoreCase(customerId)) throw new IllegalStateException("session_changed");
        return new CustomerSessionState(cookie, cookieExpiresAt, null, null, logoutPending);
    }
    CustomerSessionState unauthenticated() {
        // An authoritative session rejection retires the stored credential and
        // its creation custody. With no credential yet, an ambiguous creation
        // still needs its original retry key to avoid creating another account.
        return logoutPending || cookie != null ? empty() : new CustomerSessionState(null, 0, creationRetry, creationCustomerId, false);
    }
    CustomerSessionState retryExpired() { return new CustomerSessionState(cookie, cookieExpiresAt, null, null, logoutPending); }

    byte[] encode(String origin) throws IOException {
        if (!CustomerApiPolicy.validOrigin(origin)) throw new IOException("invalid_origin");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            out.writeInt(1); out.writeUTF(origin); out.writeUTF(cookie == null ? "" : cookie); out.writeLong(cookieExpiresAt);
            out.writeUTF(creationRetry == null ? "" : creationRetry); out.writeUTF(creationCustomerId == null ? "" : creationCustomerId); out.writeBoolean(logoutPending);
        }
        return bytes.toByteArray();
    }
    static CustomerSessionState decode(String expectedOrigin, byte[] bytes) throws IOException {
        if (!CustomerApiPolicy.validOrigin(expectedOrigin) || bytes.length > 4096) throw new IOException("invalid_private_state");
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (in.readInt() != 1 || !in.readUTF().equals(expectedOrigin)) throw new IOException("invalid_private_state");
            CustomerSessionState state = new CustomerSessionState(nullable(in.readUTF()), in.readLong(), nullable(in.readUTF()), nullable(in.readUTF()), in.readBoolean());
            if (in.available() != 0) throw new IOException("invalid_private_state");
            return state;
        } catch (IllegalArgumentException error) { throw new IOException("invalid_private_state"); }
    }
    private static String nullable(String value) { return value.isEmpty() ? null : value; }
}
