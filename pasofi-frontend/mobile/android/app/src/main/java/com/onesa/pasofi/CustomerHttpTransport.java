package com.onesa.pasofi;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import okhttp3.Authenticator;
import okhttp3.CookieJar;
import okhttp3.ConnectionPool;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;

/** The real transport factory, also exercised by JVM HTTP wire regressions. */
final class CustomerHttpTransport {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    static OkHttpClient client() {
        // No platform CookieHandler, shared WebView store, redirects, automatic
        // mutation retries, cache, logging interceptors or ambient authenticators.
        return new OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES)
            // A server can close an idle socket before OkHttp's pooled-socket
            // health check. Open a fresh connection instead of retrying an
            // unconfirmed account mutation; the extra TLS handshake is bounded
            // by the same call deadline.
            .connectionPool(new ConnectionPool(0, 1, TimeUnit.SECONDS))
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE).cache(null)
            .callTimeout(10, TimeUnit.SECONDS).connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS).writeTimeout(8, TimeUnit.SECONDS).build();
    }

    static Request request(String origin, CustomerApiPolicy.Options options, String cookie, String key) {
        if (!CustomerApiPolicy.validOrigin(origin) || (cookie != null && !CustomerApiPolicy.validToken(cookie)) ||
            (key != null && (!options.method.equals("POST") || !key.matches("^[A-Za-z0-9_-]{16,128}$")))) throw new IllegalArgumentException("invalid_request");
        byte[] bytes = options.data == null ? new byte[0] : options.data.getBytes(StandardCharsets.UTF_8);
        // Fastify rejects an empty body labelled application/json. POST needs
        // a RequestBody, but absent application data must have no media type.
        RequestBody body = options.method.equals("GET") ? null : RequestBody.create(bytes, options.data == null ? null : JSON);
        Request.Builder builder = new Request.Builder().url(origin + options.path).method(options.method, body)
            .header("Origin", origin).header("X-PasoFi-Native-Customer", "1")
            .header("Accept", options.responseType.equals("pdf") ? "application/pdf, application/json" : "application/json")
            .header("Accept-Encoding", "identity").header("Cache-Control", "no-store");
        if (cookie != null && !options.publicRead()) builder.header("Cookie", CustomerApiPolicy.COOKIE_NAME + "=" + cookie);
        if (key != null) builder.header("Idempotency-Key", key);
        return builder.build();
    }
}
