package com.onesa.pasofi;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.junit.Test;

/** Real OkHttp wire behavior, including its interceptors and shared-cookie isolation. */
public class CustomerHttpTransportTest {
    private static final String ORIGIN = "https://api.pasofi.test";
    private static final String ID = "17c4d8af-3950-44e1-84a0-f8b4d38c0862";
    private static final String TOKEN = repeat('T', 43), KEY = repeat('R', 43);
    private static String repeat(char character, int count) { char[] value = new char[count]; Arrays.fill(value, character); return new String(value); }
    private static CustomerApiPolicy.Options options(String method, String path, String body) {
        return CustomerApiPolicy.parse(ID, path, method, body, null, "json");
    }
    private static void close(OkHttpClient client) { client.dispatcher().executorService().shutdownNow(); client.connectionPool().evictAll(); }

    private static final class WireRequest {
        final String line;
        final Map<String, String> headers;
        final byte[] body;
        WireRequest(String line, Map<String, String> headers, byte[] body) { this.line = line; this.headers = headers; this.body = body; }
    }
    private static final class WireServer implements AutoCloseable {
        final ServerSocket server;
        final ExecutorService thread = Executors.newSingleThreadExecutor();
        final Future<WireRequest> observed;
        WireServer(int status, String extraHeaders) throws IOException {
            server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
            server.setSoTimeout(4000);
            observed = thread.submit(() -> {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(4000);
                    InputStream input = socket.getInputStream();
                    String first = line(input); Map<String, String> headers = new LinkedHashMap<>(); String next;
                    while (!(next = line(input)).isEmpty()) {
                        int separator = next.indexOf(':');
                        if (separator < 1) throw new IOException("Invalid test HTTP header");
                        headers.put(next.substring(0, separator).toLowerCase(Locale.ROOT), next.substring(separator + 1).trim());
                    }
                    int length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
                    if (length > 32768) throw new IOException("Unexpected test request size");
                    byte[] body = new byte[length]; new DataInputStream(input).readFully(body);
                    byte[] response = ("HTTP/1.1 " + status + " Test\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n" + extraHeaders + "\r\n{}").getBytes(StandardCharsets.US_ASCII);
                    socket.getOutputStream().write(response); socket.getOutputStream().flush();
                    return new WireRequest(first, headers, body);
                }
            });
        }
        String url(String path) { return "http://127.0.0.1:" + server.getLocalPort() + path; }
        WireRequest result() throws Exception { return observed.get(5, TimeUnit.SECONDS); }
        @Override public void close() throws IOException { server.close(); thread.shutdownNow(); }
        private static String line(InputStream input) throws IOException {
            ByteArrayOutputStream out = new ByteArrayOutputStream(); int value;
            while ((value = input.read()) != -1) {
                if (value == '\n') return new String(out.toByteArray(), StandardCharsets.US_ASCII).replaceFirst("\\r$", "");
                if (out.size() >= 8192) throw new IOException("Test HTTP line too large");
                out.write(value);
            }
            throw new IOException("Incomplete test HTTP request");
        }
    }

    @Test public void emptyCreationAndLogoutReachTheWireWithoutAJsonContentType() throws Exception {
        OkHttpClient client = CustomerHttpTransport.client();
        try {
            for (String method : new String[]{"POST", "DELETE"}) try (WireServer server = new WireServer(200, "")) {
                Request production = CustomerHttpTransport.request(ORIGIN, options(method, "/api/session", null), TOKEN, method.equals("POST") ? KEY : null);
                // Only the socket destination is replaced for this local fixture.
                Request local = production.newBuilder().url(server.url("/api/session")).build();
                try (Response response = client.newCall(local).execute()) { assertEquals(200, response.code()); }
                WireRequest wire = server.result();
                assertTrue(wire.line.startsWith(method + " /api/session "));
                assertNull(wire.headers.get("content-type")); assertEquals("0", wire.headers.get("content-length")); assertEquals(0, wire.body.length);
                assertEquals(ORIGIN, wire.headers.get("origin")); assertEquals("1", wire.headers.get("x-pasofi-native-customer"));
            }
        } finally { close(client); }
    }

    @Test public void jsonMutationKeepsExactBytesAndOnlyItsExplicitPrivateHeaders() throws Exception {
        String body = "{\"bundleId\":\"flex\"}";
        OkHttpClient client = CustomerHttpTransport.client();
        try (WireServer server = new WireServer(200, "")) {
            Request production = CustomerHttpTransport.request(ORIGIN, options("POST", "/api/orders", body), TOKEN, KEY);
            try (Response response = client.newCall(production.newBuilder().url(server.url("/api/orders")).build()).execute()) { assertEquals(200, response.code()); }
            WireRequest wire = server.result();
            assertEquals("application/json; charset=utf-8", wire.headers.get("content-type"));
            assertEquals(body, new String(wire.body, StandardCharsets.UTF_8));
            assertEquals("__Host-pamofi_session=" + TOKEN, wire.headers.get("cookie")); assertEquals(KEY, wire.headers.get("idempotency-key"));
            for (String name : new String[]{"authorization", "x-pamofi-client-ip", "x-pamofi-proxy-token", "x-forwarded-for"}) assertNull(wire.headers.get(name));
        } finally { close(client); }
    }

    @Test public void nativeClientIgnoresProcessGlobalWebViewCookiesAndNeverFollowsRedirects() throws Exception {
        final AtomicInteger reads = new AtomicInteger(), writes = new AtomicInteger();
        CookieHandler previous = CookieHandler.getDefault();
        CookieHandler sharedWebView = new CookieHandler() {
            @Override public Map<String, List<String>> get(URI uri, Map<String, List<String>> headers) {
                reads.incrementAndGet(); return Collections.singletonMap("Cookie", Collections.singletonList("__Host-pamofi_staff_session=synthetic-shared"));
            }
            @Override public void put(URI uri, Map<String, List<String>> headers) { writes.incrementAndGet(); }
        };
        OkHttpClient client = null;
        CookieHandler.setDefault(sharedWebView);
        try {
            client = CustomerHttpTransport.client();
            for (int step = 0; step < 2; step++) try (WireServer server = new WireServer(step == 0 ? 200 : 307,
                "Set-Cookie: __Host-pamofi_session=" + TOKEN + "; Path=/; Secure; HttpOnly; SameSite=Lax\r\n" + (step == 1 ? "Location: /must-not-follow\r\n" : ""))) {
                Request production = CustomerHttpTransport.request(ORIGIN, options("GET", "/api/capabilities", null), TOKEN, null);
                try (Response response = client.newCall(production.newBuilder().url(server.url("/api/capabilities")).build()).execute()) {
                    assertEquals(step == 0 ? 200 : 307, response.code());
                }
                WireRequest wire = server.result(); assertNull(wire.headers.get("cookie"));
                assertTrue(wire.line.startsWith("GET /api/capabilities "));
                assertSame(sharedWebView, CookieHandler.getDefault());
            }
            assertEquals(0, reads.get()); assertEquals(0, writes.get());
        } finally { CookieHandler.setDefault(previous); if (client != null) close(client); }
    }

    @Test public void requestAfterServerIdleCloseSucceedsOnceWithoutMutationRetry() throws Exception {
        OkHttpClient client = CustomerHttpTransport.client();
        ExecutorService worker = Executors.newSingleThreadExecutor();
        AtomicInteger received = new AtomicInteger();
        try (ServerSocket server = new ServerSocket(0, 2, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(10000);
            Future<?> serving = worker.submit(() -> {
                try {
                    for (int index = 0; index < 2; index++) try (Socket socket = server.accept()) {
                        socket.setSoTimeout(4000);
                        readMutation(socket); received.incrementAndGet();
                        socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".getBytes(StandardCharsets.US_ASCII));
                        socket.getOutputStream().flush();
                        // The controlled Node TLS edge closes an idle socket at
                        // six seconds, before OkHttp's ten-second health probe.
                        if (index == 0) Thread.sleep(6000);
                    }
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            assertFalse(client.retryOnConnectionFailure());
            Request request = CustomerHttpTransport.request(ORIGIN, options("POST", "/api/handoff/redeem", "{}"), null, null)
                .newBuilder().url("http://127.0.0.1:" + server.getLocalPort() + "/api/handoff/redeem").build();
            try (Response response = client.newCall(request).execute()) { assertEquals(200, response.code()); assertEquals("{}", response.body().string()); }
            Thread.sleep(7000);
            try (Response response = client.newCall(request).execute()) { assertEquals(200, response.code()); assertEquals("{}", response.body().string()); }
            serving.get(3, TimeUnit.SECONDS);
            assertEquals("Exactly one wire request for each explicit operation", 2, received.get());
        } finally { worker.shutdownNow(); close(client); }
    }

    @Test public void lostMutationResponseIsNotAutomaticallyRetried() throws Exception {
        OkHttpClient client = CustomerHttpTransport.client();
        ExecutorService worker = Executors.newSingleThreadExecutor();
        AtomicInteger received = new AtomicInteger();
        try (ServerSocket server = new ServerSocket(0, 2, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(4000);
            Future<?> serving = worker.submit(() -> {
                try {
                    try (Socket socket = server.accept()) { socket.setSoTimeout(4000); readMutation(socket); received.incrementAndGet(); }
                    server.setSoTimeout(750);
                    try (Socket ignored = server.accept()) { received.incrementAndGet(); }
                    catch (SocketTimeoutException expected) { /* No automatic second request. */ }
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            Request request = CustomerHttpTransport.request(ORIGIN, options("POST", "/api/handoff/redeem", "{}"), null, null)
                .newBuilder().url("http://127.0.0.1:" + server.getLocalPort() + "/api/handoff/redeem").build();
            try (Response ignored = client.newCall(request).execute()) { fail("A lost response must remain unconfirmed"); }
            catch (IOException expected) { /* The caller must choose a safe explicit recovery. */ }
            serving.get(3, TimeUnit.SECONDS);
            assertEquals(1, received.get());
        } finally { worker.shutdownNow(); close(client); }
    }

    private static void readMutation(Socket socket) throws IOException {
        InputStream input = socket.getInputStream();
        assertEquals("POST /api/handoff/redeem HTTP/1.1", WireServer.line(input));
        int length = 0; String header;
        while (!(header = WireServer.line(input)).isEmpty()) {
            if (header.toLowerCase(Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(header.substring(header.indexOf(':') + 1).trim());
        }
        assertEquals(2, length);
        byte[] body = new byte[length]; new DataInputStream(input).readFully(body);
        assertEquals("{}", new String(body, StandardCharsets.UTF_8));
    }
}
