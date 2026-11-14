package com.onesa.pasofi;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.regex.Pattern;

/** Pure protocol policy, shared by the real transport and ordinary JVM tests. */
final class CustomerApiPolicy {
    static final int REQUEST_LIMIT = 32 * 1024;
    static final int RESPONSE_LIMIT = 2 * 1024 * 1024;
    static final String COOKIE_NAME = "__Host-pamofi_session";
    static final String UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
    private static final Pattern UUID_PATTERN = Pattern.compile("^" + UUID + "$" );
    private static final Pattern TOKEN = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final Pattern KEY = Pattern.compile("^[A-Za-z0-9_-]{16,128}$");

    static final class Options {
        final String requestId, path, basePath, method, data, idempotencyKey, responseType;
        Options(String requestId, String path, String basePath, String method, String data, String idempotencyKey, String responseType) {
            this.requestId = requestId; this.path = path; this.basePath = basePath; this.method = method;
            this.data = data; this.idempotencyKey = idempotencyKey; this.responseType = responseType;
        }
        boolean creation() { return method.equals("POST") && basePath.equals("/api/session"); }
        boolean logout() { return method.equals("DELETE") && basePath.equals("/api/session"); }
        boolean sessionRead() { return method.equals("GET") && basePath.equals("/api/session"); }
        boolean recovery() { return method.equals("POST") && (basePath.equals("/api/recovery") || basePath.equals("/api/handoff/redeem") || basePath.equals("/api/onesa/native-session")); }
        boolean changesIdentity() { return creation() || logout() || recovery(); }
        boolean publicRead() { return method.equals("GET") && basePath.matches("^/api/(capabilities|bundles|sites|help|payments/methods)$"); }
    }

    static boolean validUuid(String value) { return value != null && UUID_PATTERN.matcher(value).matches(); }
    static boolean validToken(String value) { return value != null && TOKEN.matcher(value).matches(); }
    static String browserSignInUrl(String origin) { return validOrigin(origin) ? origin + "/#account" : null; }
    static boolean allowedStatus(Options options, int status) {
        if (status < 200 || status > 599 || (status >= 300 && status < 400)) return false;
        if (status >= 400) return true;
        if (options.creation()) return status == 200 || status == 201;
        if (options.recovery() || options.sessionRead()) return status == 200;
        if (options.logout()) return status == 204;
        return true;
    }

    static boolean validOrigin(String value) {
        if (value == null || value.length() > 253) return false;
        try {
            URI uri = new URI(value);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && host != null && value.equals("https://" + host) &&
                uri.getUserInfo() == null && uri.getPort() == -1 && uri.getQuery() == null && uri.getFragment() == null &&
                host.matches("^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$") &&
                !host.endsWith(".localhost") && !host.endsWith(".local");
        } catch (Exception ignored) { return false; }
    }

    static Options parse(String requestId, String path, String method, String data, String key, String responseType) {
        if (!validUuid(requestId) || path == null || path.length() > 4096 || Pattern.compile("[\\x00-\\x20\\x7f\\\\#]").matcher(path).find()) return null;
        if (!Arrays.asList("GET", "POST", "DELETE").contains(method) || !Arrays.asList("json", "pdf").contains(responseType)) return null;
        if (data != null && (!method.equals("POST") || data.getBytes(StandardCharsets.UTF_8).length > REQUEST_LIMIT)) return null;
        if (key != null && (!method.equals("POST") || !KEY.matcher(key).matches())) return null;
        try {
            URI uri = new URI(path);
            String base = uri.getRawPath();
            if (uri.isAbsolute() || uri.getRawAuthority() != null || uri.getRawFragment() != null || base == null || !base.matches("^/api/[A-Za-z0-9/-]+$")) return null;
            if (!allowedRoute(base, method) || !allowedQuery(base, method, uri.getRawQuery())) return null;
            boolean pdf = (method.equals("GET") && base.matches("^/api/customer/invoices/" + UUID + "/pdf$")) ||
                (method.equals("POST") && base.equals("/api/invoice-downloads"));
            if (pdf != responseType.equals("pdf") || (method.equals("POST") && base.equals("/api/session") && key != null)) return null;
            return new Options(requestId, path, base, method, data, key, responseType);
        } catch (Exception ignored) { return null; }
    }

    private static boolean allowedRoute(String path, String method) {
        if (path.equals("/api/session")) return true;
        if (method.equals("GET")) return path.equals("/api/onesa/availability") || path.matches("^/api/(bundles|capabilities|sites|access|usage|help|payments/methods|orders|recovery/status|network/sites|network/session)$") ||
            path.matches("^/api/orders/" + UUID + "/status$") || path.matches("^/api/customer/invoices(?:/" + UUID + "(?:/pdf)?)?$") ||
            path.matches("^/api/receipt-pairings/" + UUID + "$" );
        if (!method.equals("POST")) return false;
        return path.matches("^/api/(orders|onesa/native-session|recovery(?:/(setup|rotate))?|handoff(?:/redeem)?|invoice-downloads|receipt-pairings|vouchers/redeem|network/credentials|network/disconnect)$") ||
            path.matches("^/api/orders/" + UUID + "/(checkout|mock-payment|expire-unused)$") ||
            path.matches("^/api/receipt-pairings/" + UUID + "/cancel$");
    }

    private static boolean allowedQuery(String path, String method, String raw) throws Exception {
        if (raw == null) return true;
        if (raw.isEmpty()) return false;
        if (!method.equals("GET")) return false;
        Map<String, String> fields = new HashMap<>();
        String limit = "(?:[1-9][0-9]?|100)", offset = "(?:0|[1-9][0-9]{0,5}|1000000)";
        if (path.equals("/api/access") || path.equals("/api/customer/invoices")) { fields.put("limit", limit); fields.put("offset", offset); }
        if (path.equals("/api/customer/invoices")) { fields.put("saleId", UUID); fields.put("orderId", UUID); }
        if (path.equals("/api/usage")) fields.put("entitlementIds", UUID + "(?:," + UUID + "){0,99}");
        if (path.equals("/api/orders")) fields.put("requestKey", "[A-Za-z0-9_-]{16,128}");
        if (path.equals("/api/payments/methods")) { fields.put("siteId", UUID); fields.put("bundleId", "[a-z][a-z0-9-]{0,39}"); }
        if (path.equals("/api/help")) fields.put("q", "[^\\x00-\\x1f\\x7f\\ufffd]{0,200}");
        Set<String> seen = new HashSet<>();
        for (String pair : raw.split("&", -1)) {
            int separator = pair.indexOf('=');
            String key = URLDecoder.decode(separator < 0 ? pair : pair.substring(0, separator), "UTF-8");
            String value = URLDecoder.decode(separator < 0 ? "" : pair.substring(separator + 1), "UTF-8");
            String pattern = fields.get(key);
            if (!seen.add(key) || pattern == null || !value.matches("^" + pattern + "$")) return false;
        }
        return true;
    }

    static final class CookieUpdate {
        final String token;
        final long expiresAt;
        CookieUpdate(String token, long expiresAt) { this.token = token; this.expiresAt = expiresAt; }
    }

    static CookieUpdate cookieUpdate(List<String> headers, Options options, int status, long now) {
        if (headers.isEmpty()) return null;
        if (headers.size() != 1) throw new IllegalArgumentException("invalid_cookie");
        String cookie = headers.get(0);
        if (cookie == null || cookie.length() > 8192 || Pattern.compile("[\\x00-\\x1f\\x7f]").matcher(cookie).find()) throw new IllegalArgumentException("invalid_cookie");
        String[] parts = cookie.split(";", -1);
        String pair = parts[0].trim(), prefix = COOKIE_NAME + "=";
        if (!pair.startsWith(prefix)) throw new IllegalArgumentException("invalid_cookie");
        String value = pair.substring(prefix.length());
        Map<String, String> attrs = new HashMap<>();
        for (int i = 1; i < parts.length; i++) {
            String attr = parts[i].trim(); int equals = attr.indexOf('=');
            String key = (equals < 0 ? attr : attr.substring(0, equals)).toLowerCase(Locale.ROOT);
            String data = equals < 0 ? "" : attr.substring(equals + 1);
            if (!Arrays.asList("secure", "httponly", "path", "samesite", "max-age", "expires").contains(key) || attrs.containsKey(key)) throw new IllegalArgumentException("invalid_cookie");
            attrs.put(key, data);
        }
        if (!"".equals(attrs.get("secure")) || !"".equals(attrs.get("httponly")) || !"/".equals(attrs.get("path")) ||
            !"lax".equalsIgnoreCase(attrs.get("samesite"))) throw new IllegalArgumentException("invalid_cookie");
        String age = attrs.get("max-age"), expiry = attrs.get("expires");
        long expires = expiry == null ? -1 : httpDate(expiry);
        if (expiry != null && expires < 0) throw new IllegalArgumentException("invalid_cookie");
        if (options.logout() && status == 204 && value.isEmpty() && (age == null || age.equals("0")) &&
            ("0".equals(age) || (expiry != null && expires <= now))) return new CookieUpdate(null, 0);
        boolean creating = (options.creation() && (status == 200 || status == 201)) || (options.recovery() && status == 200);
        if (!creating || !validToken(value) || age == null || !age.matches("[1-9][0-9]{0,6}")) throw new IllegalArgumentException("invalid_cookie");
        long seconds = Long.parseLong(age);
        if (seconds > 30L * 86400 || (expiry != null && expires <= now)) throw new IllegalArgumentException("invalid_cookie");
        return new CookieUpdate(value, now + seconds * 1000);
    }

    static long retryAfter(String value, long now) {
        if (value == null || value.length() > 64) return 0;
        try {
            long millis = value.matches("[0-9]{1,9}") ? Long.parseLong(value) * 1000 : httpDate(value) - now;
            return millis > 0 ? Math.min(millis, 300_000) : 0;
        } catch (RuntimeException ignored) { return 0; }
    }

    private static long httpDate(String value) {
        SimpleDateFormat format = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("GMT")); format.setLenient(false);
        ParsePosition position = new ParsePosition(0); Date date = format.parse(value, position);
        return date != null && position.getIndex() == value.length() ? date.getTime() : -1;
    }
}
