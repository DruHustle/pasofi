package com.onesa.pasofi;

import android.util.Base64;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Customer-only HTTP. Cookies and creation retry keys never cross this bridge. */
@CapacitorPlugin(name = "PasoFiCustomerApi")
public final class PasoFiCustomerApiPlugin extends Plugin {
    private static final Object ACTIVE_LOCK = new Object();
    private static PasoFiCustomerApiPlugin active;
    private final Object gate = new Object();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
    private final CustomerRequestFence fence = new CustomerRequestFence();
    private final Map<String, Pending> tasks = new HashMap<>();
    private String origin;
    private OkHttpClient client;
    private CustomerSessionStore store;
    private CustomerSessionState state;
    private boolean initialized, storageFailed, destroyed;
    private long pageGeneration;
    private final WebViewListener pageListener = new WebViewListener() {
        @Override public void onPageStarted(WebView view) {
            synchronized (gate) {
                pageGeneration++; fence.reset();
                for (Pending pending : new ArrayList<>(tasks.values())) {
                    // Callback IDs belong to the old page. Never send its result
                    // (even a rejection) into the new JavaScript callback table.
                    pending.finished.set(true); fence.cancel(pending.ticket);
                    if (pending.timeout != null) pending.timeout.cancel(false);
                    if (pending.http != null) pending.http.cancel();
                }
                tasks.clear();
            }
        }
    };

    private static final class Pending {
        final PluginCall bridgeCall;
        final CustomerApiPolicy.Options original, options;
        final CustomerRequestFence.Ticket ticket;
        final boolean logoutRecovery;
        final long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        final AtomicBoolean finished = new AtomicBoolean();
        Call http;
        ScheduledFuture<?> timeout;
        Pending(PluginCall bridgeCall, CustomerApiPolicy.Options original, CustomerApiPolicy.Options options, CustomerRequestFence.Ticket ticket, boolean logoutRecovery) {
            this.bridgeCall = bridgeCall; this.original = original; this.options = options;
            this.ticket = ticket; this.logoutRecovery = logoutRecovery;
        }
    }

    private static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }

    @Override
    public void load() {
        // An Activity recreation cannot leave a previous plugin writing this store.
        synchronized (ACTIVE_LOCK) {
            if (active != null && active != this) active.closeTransport();
            active = this;
        }
        String configured = getConfig().getString("origin");
        origin = CustomerApiPolicy.validOrigin(configured) ? configured : null;
        bridge.addWebViewListener(pageListener);
        // Capacitor installs a process-global CookieHandler even when its fetch
        // patch is off. This client never reads or writes that shared cookie jar.
        client = CustomerHttpTransport.client();
        worker.execute(() -> {
            CustomerSessionStore loadedStore = null; CustomerSessionState loadedState = null; boolean failed = false;
            if (origin != null) {
                try { loadedStore = new CustomerSessionStore(getContext(), origin); loadedState = loadedStore.load(); }
                catch (Exception ignored) { failed = true; }
            }
            synchronized (gate) {
                if (destroyed) return;
                store = loadedStore; state = loadedState; storageFailed = failed; initialized = true;
            }
        });
    }

    @PluginMethod
    public void availability(PluginCall call) {
        final String requestId = call.getString("requestId");
        if (call.getData().length() != 1 || !CustomerApiPolicy.validUuid(requestId)) { reject(call, "native_request_rejected"); return; }
        synchronized (gate) {
            if (destroyed) return;
            final long page = pageGeneration;
            worker.execute(() -> {
                synchronized (gate) {
                    if (destroyed || page != pageGeneration) return;
                    JSObject result = new JSObject(); result.put("requestId", requestId); result.put("configured", origin != null); result.put("protocol", 1);
                    if (origin != null) result.put("origin", origin);
                    call.resolve(result);
                }
            });
        }
    }

    @PluginMethod
    public void openSignIn(PluginCall call) {
        final String requestId = call.getString("requestId");
        if (call.getData().length() != 1 || !CustomerApiPolicy.validUuid(requestId)) { reject(call, "native_request_rejected"); return; }
        final long page;
        final String destination;
        synchronized (gate) {
            if (destroyed) return;
            page = pageGeneration;
            destination = CustomerApiPolicy.browserSignInUrl(origin);
        }
        if (destination == null || getActivity() == null) { reject(call, "mobile_api_not_configured"); return; }
        getActivity().runOnUiThread(() -> {
            synchronized (gate) {
                if (destroyed || page != pageGeneration) return;
                try {
                    // Only the compiled HTTPS origin; no cookie, code or return token.
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(destination));
                    intent.addCategory(Intent.CATEGORY_BROWSABLE);
                    getActivity().startActivity(intent);
                    JSObject result = new JSObject(); result.put("requestId", requestId); result.put("opened", true);
                    call.resolve(result);
                } catch (Exception ignored) { reject(call, "request_failed"); }
            }
        });
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (!validArguments(call)) { reject(call, "native_request_rejected"); return; }
        CustomerApiPolicy.Options options = CustomerApiPolicy.parse(call.getString("requestId"), call.getString("path"), call.getString("method"),
            call.getString("data"), call.getString("idempotencyKey"), call.getString("responseType"));
        if (options == null) { reject(call, "native_request_rejected"); return; }
        if (options.data != null) {
            try { if (!(parseJson(options.data) instanceof JSONObject)) throw new Failure("native_request_rejected"); }
            catch (Exception ignored) { reject(call, "native_request_rejected"); return; }
        }
        synchronized (gate) {
            if (destroyed) return;
            if (origin == null || !initialized) { reject(call, "mobile_api_not_configured"); return; }
            if (storageFailed || state == null) { reject(call, "native_session_storage_unavailable"); return; }
            if (tasks.containsKey(options.requestId)) { reject(call, "native_request_rejected"); return; }
            boolean logoutRecovery = state.logoutPending && options.sessionRead();
            if (state.logoutPending && !logoutRecovery && !options.logout() && !options.publicRead()) { reject(call, "logout_pending"); return; }
            CustomerRequestFence.Ticket ticket;
            try { ticket = fence.accept(options.requestId, options.changesIdentity() || logoutRecovery); }
            catch (IllegalStateException ignored) { reject(call, "session_change_in_progress"); return; }
            if (ticket.changesIdentity) for (Pending old : new ArrayList<>(tasks.values())) cancelLocked(old, "session_changed");
            CustomerApiPolicy.Options outgoing = logoutRecovery
                ? CustomerApiPolicy.parse(options.requestId, "/api/session", "DELETE", null, null, "json") : options;
            Pending pending = new Pending(call, options, outgoing, ticket, logoutRecovery);
            tasks.put(options.requestId, pending);
            pending.timeout = deadlines.schedule(() -> {
                synchronized (gate) { cancelLocked(pending, pending.logoutRecovery ? "logout_pending" : "request_timeout"); }
            }, 10, TimeUnit.SECONDS);
            worker.execute(() -> perform(pending));
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("requestId");
        if (call.getData().length() != 1 || !CustomerApiPolicy.validUuid(id)) { reject(call, "native_request_rejected"); return; }
        synchronized (gate) { Pending pending = tasks.get(id); if (pending != null) cancelLocked(pending, "request_cancelled"); }
        JSObject result = new JSObject(); result.put("requestId", id); call.resolve(result);
    }

    private void perform(Pending pending) {
        try {
            String cookie, key;
            synchronized (gate) {
                requireCurrent(pending);
                if (storageFailed) throw new Failure("native_session_storage_unavailable");
                if (pending.options.logout() && !state.logoutPending) commit(state.beginLogout());
                if (pending.options.creation() && state.creationRetry == null) {
                    byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
                    String retry = Base64.encodeToString(random, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
                    Arrays.fill(random, (byte) 0); commit(state.withCreationRetry(retry));
                }
                requireCurrent(pending);
                cookie = pending.options.publicRead() ? null : state.usableCookie(System.currentTimeMillis());
                key = pending.options.creation() ? state.creationRetry : pending.options.idempotencyKey;
            }
            Call outgoing = client.newCall(CustomerHttpTransport.request(origin, pending.options, cookie, key));
            synchronized (gate) {
                requireCurrent(pending); pending.http = outgoing;
                outgoing.timeout().timeout(Math.max(1, pending.deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            }
            try (Response response = outgoing.execute()) { receive(pending, response); }
        } catch (Failure failure) { fail(pending, failure.code); }
        catch (IllegalStateException error) {
            String code = Arrays.asList("session_changed", "session_unconfirmed", "logout_pending").contains(error.getMessage()) ? error.getMessage() : "request_failed";
            fail(pending, code);
        } catch (Exception ignored) { fail(pending, pending.logoutRecovery ? "logout_pending" : "request_failed"); }
        finally {
            synchronized (gate) { completedLocked(pending); }
        }
    }

    private void receive(Pending pending, Response response) throws Exception {
        int status = response.code();
        if (!CustomerApiPolicy.allowedStatus(pending.options, status)) throw new Failure("invalid_response");
        List<String> types = response.headers("Content-Type"), encodings = response.headers("Content-Encoding");
        if (types.size() > 1 || encodings.size() > 1 || (!encodings.isEmpty() && !encodings.get(0).equalsIgnoreCase("identity"))) throw new Failure("invalid_response");
        String type = types.isEmpty() ? "" : types.get(0);
        boolean pdf = status == 200 && pending.options.responseType.equals("pdf") && type.equalsIgnoreCase("application/pdf");
        if (status != 204 && !pdf && !type.matches("(?i)^application/json(?:\\s*;\\s*charset=utf-8)?$")) throw new Failure("invalid_response");
        CustomerApiPolicy.CookieUpdate update = CustomerApiPolicy.cookieUpdate(response.headers("Set-Cookie"), pending.options, status, System.currentTimeMillis());
        byte[] bytes = readBody(response.body(), pending);
        Object data;
        if (status == 204) { if (bytes.length != 0) throw new Failure("invalid_response"); data = JSONObject.NULL; }
        else if (pdf) {
            if (bytes.length < 5 || bytes[0] != '%' || bytes[1] != 'P' || bytes[2] != 'D' || bytes[3] != 'F' || bytes[4] != '-') throw new Failure("invalid_response");
            data = Base64.encodeToString(bytes, Base64.NO_WRAP);
        } else {
            String json = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            data = parseJson(json);
            if (status >= 200 && status < 300 && pending.options.responseType.equals("pdf")) throw new Failure("invalid_response");
        }
        List<String> retry = response.headers("Retry-After");
        long delay = retry.size() == 1 ? CustomerApiPolicy.retryAfter(retry.get(0), System.currentTimeMillis()) : 0;
        synchronized (gate) {
            requireCurrent(pending);
            boolean identitySuccess = (pending.options.creation() && (status == 200 || status == 201)) || (pending.options.recovery() && status == 200);
            if (identitySuccess) commit(state.identityResult(pending.options, update, customerId(data), System.currentTimeMillis()));
            else if (pending.options.logout() && status == 204) commit(CustomerSessionState.empty());
            else if (pending.options.sessionRead() && status == 200) commit(state.confirmed(customerId(data), System.currentTimeMillis()));
            else if (pending.options.sessionRead() && status == 401) commit(state.unauthenticated());
            else if (pending.options.creation() && status == 409 && data instanceof JSONObject && "session_retry_expired".equals(((JSONObject) data).optString("error"))) commit(state.retryExpired());
            if (pending.logoutRecovery) {
                if (status != 204) throw new Failure("logout_pending");
                status = 401; data = new JSONObject().put("error", "not_authenticated"); type = "application/json";
            }
            requireCurrent(pending);
            JSObject result = new JSObject(); result.put("requestId", pending.original.requestId); result.put("status", status); result.put("data", data);
            result.put("contentType", pdf ? "application/pdf" : "application/json");
            if (delay > 0) result.put("retryAfterMs", delay);
            if (pending.finished.compareAndSet(false, true)) {
                // Release admission before the JS promise can request its required
                // confirming session read. Old finally cannot release a new ticket.
                completedLocked(pending); pending.bridgeCall.resolve(result);
            }
        }
    }

    private byte[] readBody(ResponseBody body, Pending pending) throws Exception {
        if (body == null) return new byte[0];
        if (body.contentLength() > CustomerApiPolicy.RESPONSE_LIMIT) throw new Failure("invalid_response");
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] chunk = new byte[8192];
        try (InputStream input = body.byteStream()) {
            int count;
            while ((count = input.read(chunk)) != -1) {
                synchronized (gate) { requireCurrent(pending); }
                if (output.size() + count > CustomerApiPolicy.RESPONSE_LIMIT) throw new Failure("invalid_response");
                output.write(chunk, 0, count);
            }
        }
        return output.toByteArray();
    }

    private void requireCurrent(Pending pending) throws Failure {
        if (pending.finished.get() || !fence.current(pending.ticket) || destroyed) throw new Failure("request_cancelled");
        if (System.nanoTime() >= pending.deadline) throw new Failure(pending.logoutRecovery ? "logout_pending" : "request_timeout");
    }

    private void commit(CustomerSessionState next) throws Failure {
        if (next == state) return;
        try { store.save(next); state = next; }
        catch (Exception ignored) { storageFailed = true; throw new Failure("native_session_storage_unavailable"); }
    }

    private void completedLocked(Pending pending) {
        if (pending.timeout != null) pending.timeout.cancel(false);
        if (tasks.get(pending.original.requestId) == pending) tasks.remove(pending.original.requestId);
        fence.finish(pending.ticket);
    }

    private void cancelLocked(Pending pending, String code) {
        if (pending.finished.get()) return;
        fence.cancel(pending.ticket);
        if (pending.http != null) pending.http.cancel();
        if (pending.finished.compareAndSet(false, true)) reject(pending.bridgeCall, code);
    }

    private void fail(Pending pending, String code) {
        synchronized (gate) { if (pending.finished.compareAndSet(false, true)) reject(pending.bridgeCall, code); }
    }

    private static Object parseJson(String text) throws Exception {
        JSONTokener parser = new JSONTokener(text); Object value = parser.nextValue();
        if (parser.nextClean() != 0) throw new Failure("invalid_response");
        return value;
    }

    private static String customerId(Object data) throws Failure {
        String id = data instanceof JSONObject ? ((JSONObject) data).optString("customerId", null) : null;
        if (!CustomerApiPolicy.validUuid(id)) throw new Failure("invalid_response");
        return id;
    }

    private static boolean validArguments(PluginCall call) {
        List<String> names = Arrays.asList("requestId", "path", "method", "data", "idempotencyKey", "responseType");
        Iterator<String> keys = call.getData().keys();
        while (keys.hasNext()) { String key = keys.next(); if (!names.contains(key) || !(call.getData().opt(key) instanceof String)) return false; }
        return true;
    }

    private static void reject(PluginCall call, String code) {
        // Do not attach exceptions, request data, HTTP headers or provider errors.
        String publicCode;
        switch (code) {
            case "invalid_request": case "native_request_rejected": publicCode = "native_request_rejected"; break;
            case "invalid_response": case "native_response_rejected": publicCode = "native_response_rejected"; break;
            case "native_api_unavailable": case "mobile_api_not_configured": publicCode = "mobile_api_not_configured"; break;
            case "private_state_unavailable": case "native_session_storage_unavailable": publicCode = "native_session_storage_unavailable"; break;
            case "session_change_in_progress": case "session_changed": publicCode = "session_changed"; break;
            case "logout_pending": publicCode = "logout_pending"; break;
            default: publicCode = "request_failed";
        }
        call.reject("Customer connection could not complete.", publicCode);
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (ACTIVE_LOCK) { if (active == this) active = null; closeTransport(); }
    }

    private void closeTransport() {
        synchronized (gate) {
            if (destroyed) return;
            destroyed = true; fence.close();
            bridge.removeWebViewListener(pageListener);
            for (Pending pending : new ArrayList<>(tasks.values())) {
                pending.finished.set(true); if (pending.http != null) pending.http.cancel();
            }
            tasks.clear(); worker.shutdownNow(); deadlines.shutdownNow();
            if (client != null) { client.dispatcher().cancelAll(); client.connectionPool().evictAll(); }
        }
    }
}
