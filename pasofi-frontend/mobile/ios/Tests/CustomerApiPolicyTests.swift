import Foundation

@main
struct CustomerApiPolicyTests {
    static let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    static let other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    static let origin = "https://pasofi.example.test"
    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static let token = String(repeating: "A", count: 43)
    static let retry = String(repeating: "B", count: 43)
    static let cookie = "__Host-pamofi_session=" + token + "; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax"
    static var checks = 0

    static func check(_ condition: Bool, _ description: String) {
        precondition(condition, description); checks += 1
    }
    static func rejects(_ description: String, _ operation: () throws -> Void) {
        do { try operation(); preconditionFailure(description) } catch { checks += 1 }
    }
    static func request(_ path: String = "/api/session", _ method: String = "GET", type: String = "json", data: String? = nil, key: String? = nil) throws -> CustomerApiRequest {
        try CustomerApiPolicy.request(id: id, path: path, method: method, responseType: type, data: data, key: key)
    }
    static func main() throws {
        check(CustomerApiPolicy.origin(origin) == origin, "Public HTTPS origin accepted")
        for invalid in ["http://pasofi.example.test", "https://user@pasofi.example.test", "https://pasofi.example.test/", "https://pasofi.example.test/api", "https://pasofi.example.test:8443", "https://127.0.0.1", "https://pasofi.local", "https://sub.localhost", "https://pasofi.example.test?route=evil"] {
            check(CustomerApiPolicy.origin(invalid) == nil, "Unexpected origin rejected")
        }
        for path in ["/api/capabilities", "/api/session", "/api/access?offset=0&limit=100", "/api/orders?requestKey=" + retry, "/api/payments/methods?siteId=" + id + "&bundleId=flex", "/api/usage?entitlementIds=" + id + "%2C" + other, "/api/customer/invoices?orderId=" + id + "&limit=1"] {
            _ = try request(path); checks += 1
        }
        for path in ["https://evil.example/api/session", "//evil.example/api/session", "/api/staff/session", "/api/admin/routers", "/api/customer/invoices/../staff", "/api/%73ession", "/api/session#fragment", "/api/session?path=staff/session", "/api/session?__pamofi_path=staff/session", "/api/access?offset=0&offset=1", "/api/access?limit=101", "/api/access?offset=1000001", "/api/usage?entitlementIds=" + id + ",", "/api/orders?requestKey=short", "/api/help?q=%00", "/api/help?q=%zz", "/api/session\n"] {
            rejects("Host/path/query escape rejected") { _ = try request(path) }
        }
        rejects("Staff mutation rejected") { _ = try request("/api/staff/login", "POST", data: "{}") }
        rejects("Query on mutation rejected") { _ = try request("/api/session?x=y", "POST") }
        rejects("Native session key cannot enter from JavaScript") { _ = try request("/api/session", "POST", key: retry) }
        rejects("Method mismatch rejected") { _ = try request("/api/bundles", "DELETE") }
        rejects("JSON object required") { _ = try request("/api/orders", "POST", data: "[]") }
        rejects("JSON byte limit enforced") { _ = try request("/api/orders", "POST", data: "{\"v\":\"" + String(repeating: "x", count: CustomerApiPolicy.bodyLimit) + "\"}") }
        _ = try request("/api/orders", "POST", data: "{}", key: id); checks += 1
        _ = try request("/api/customer/invoices/" + id + "/pdf", type: "pdf"); checks += 1
        _ = try request("/api/invoice-downloads", "POST", type: "pdf", data: "{\"token\":\"synthetic\"}"); checks += 1
        rejects("PDF requested on JSON route rejected") { _ = try request("/api/session", type: "pdf") }
        rejects("Invoice PDF cannot be read as JSON") { _ = try request("/api/customer/invoices/" + id + "/pdf") }

        let parsed = try CustomerSessionCookie.parse(cookie, clearing: false, now: now)
        check(parsed.token == token && parsed.expiresAt == now.timeIntervalSince1970 + 2_592_000, "Cookie attributes and lifetime preserved")
        for invalid in [cookie + "; Domain=pasofi.example.test", cookie + "; Path=/", cookie.replacingOccurrences(of: "; HttpOnly", with: ""), cookie.replacingOccurrences(of: "Secure", with: "Secure=true"), cookie.replacingOccurrences(of: "Lax", with: "None"), cookie.replacingOccurrences(of: "2592000", with: "2592001"), cookie + ", __Host-pamofi_session=" + token] {
            rejects("Malformed or widened cookie rejected") { _ = try CustomerSessionCookie.parse(invalid, clearing: false, now: now) }
        }
        let clearCookie = "__Host-pamofi_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        check(try CustomerSessionCookie.parse(clearCookie, clearing: true, now: now).token == nil, "Only a clearing cookie clears session")
        rejects("Session token on logout rejected") { _ = try CustomerSessionCookie.parse(cookie, clearing: true, now: now) }

        let create = try request("/api/session", "POST")
        var pending = CustomerSessionState(origin: origin)
        pending.creationRetry = retry
        let restoredPending = try JSONDecoder().decode(CustomerSessionState.self, from: JSONEncoder().encode(pending))
        check(restoredPending.creationRetry == retry && restoredPending.token == nil, "Ambiguous create survives native state round-trip")
        try pending.accept(create, status: 201, body: ["customerId": id], cookie: cookie, now: now)
        check(pending.creationRetry == retry && pending.creationCustomerId == id, "Create response does not prematurely clear retry authority")
        var restored = try JSONDecoder().decode(CustomerSessionState.self, from: JSONEncoder().encode(pending))
        try restored.validate(expectedOrigin: origin)
        rejects("Origin partition cannot be changed") { try restored.validate(expectedOrigin: "https://other.example.test") }
        var wrongOwner = restored
        rejects("Confirmation from another customer is rejected") { try wrongOwner.accept(request(), status: 200, body: ["customerId": other], cookie: nil, now: now) }
        try restored.accept(request(), status: 200, body: ["customerId": id], cookie: nil, now: now)
        check(restored.creationRetry == nil && restored.creationCustomerId == nil && restored.token == token, "Confirmed GET clears only creation retry")
        var incomplete = CustomerSessionState(origin: origin)
        incomplete.creationRetry = retry
        rejects("Invalid body cannot adopt new cookie") { try incomplete.accept(create, status: 201, body: ["customerId": "invalid"], cookie: cookie, now: now) }
        check(incomplete.token == nil, "Invalid response leaves original candidate token absent")
        rejects("Commerce route cannot rotate cookie") { try restored.accept(request("/api/orders", "POST", data: "{}"), status: 201, body: [:], cookie: cookie, now: now) }
        rejects("Failed auth cannot rotate cookie") { try restored.accept(create, status: 409, body: ["error": "conflict"], cookie: cookie, now: now) }

        var expiredRetry = pending
        try expiredRetry.accept(create, status: 409, body: ["error": "other_conflict"], cookie: nil, now: now)
        check(expiredRetry.creationRetry == retry, "Unrelated409 keeps ambiguous retry")
        try expiredRetry.accept(create, status: 409, body: ["error": "session_retry_expired"], cookie: nil, now: now)
        check(expiredRetry.creationRetry == nil && expiredRetry.creationCustomerId == nil && expiredRetry.token == token, "Authoritative terminal retry clears key without creating an account")
        var recovery = pending
        rejects("Recovery success requires a new cookie") { try recovery.accept(request("/api/recovery", "POST", data: "{}"), status: 200, body: ["customerId": other], cookie: nil, now: now) }
        try recovery.accept(request("/api/recovery", "POST", data: "{}"), status: 200, body: ["customerId": other], cookie: cookie, now: now)
        check(recovery.creationRetry == nil && recovery.creationCustomerId == nil, "Explicit recovery clears abandoned creation state")

        var logout = pending
        logout.logoutPending = true
        let restart = try JSONDecoder().decode(CustomerSessionState.self, from: JSONEncoder().encode(logout))
        check(restart.shouldResumeLogout(try request()), "Restarted session read resumes prior logout")
        check(!restart.shouldResumeLogout(try request("/api/orders", "POST", data: "{}")), "Queued mutation cannot resume or bypass logout")
        let oneRetry = try request().resumingLogout()
        check(oneRetry.method == "DELETE" && oneRetry.path == "/api/session" && !restart.shouldResumeLogout(oneRetry), "Exactly one DELETE per session read, no recursive retry")
        try logout.accept(oneRetry, status: 503, body: ["error": "unavailable"], cookie: nil, now: now)
        check(logout.logoutPending && logout.creationRetry == retry && logout.token == token, "Ambiguous logout retains private revocation material")
        try logout.accept(oneRetry, status: 204, body: nil, cookie: clearCookie, now: now)
        check(!logout.logoutPending && logout.token == nil && logout.creationRetry == nil, "Confirmed logout clears all private authority")
        var noCookie = CustomerSessionState(origin: origin)
        noCookie.creationRetry = retry; noCookie.logoutPending = true
        try noCookie.accept(oneRetry, status: 204, body: nil, cookie: nil, now: now)
        check(noCookie.creationRetry == nil && !noCookie.logoutPending, "Confirmed204 clears even absent or revoked cookie state")
        check(CustomerApiPolicy.retryAfter("999999") == 300_000, "Retry delay remains bounded")
        check(CustomerApiPolicy.retryAfter("not a date") == nil, "Malformed retry metadata is ignored")
        print("PasoFi native customer policy: \(checks) checks passed (no device/storage/network qualification).")
    }
}
