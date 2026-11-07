import Foundation

enum CustomerApiFailure: String, Error {
    case unavailable = "mobile_api_not_configured"
    case request = "native_request_rejected"
    case response = "native_response_rejected"
    case storage = "native_session_storage_unavailable"
    case changed = "session_changed"
    case logout = "logout_pending"
    case network = "request_failed"
}

struct CustomerApiRequest {
    let id: String
    let path: String
    let method: String
    let responseType: String
    let body: Data?
    let idempotencyKey: String?
    var pathname: String { String(path.split(separator: "?", maxSplits: 1)[0]) }
    var changesIdentity: Bool {
        (path == "/api/session" && ["POST", "DELETE"].contains(method)) ||
            (method == "POST" && ["/api/recovery", "/api/handoff/redeem"].contains(path))
    }
    var isPublicRead: Bool {
        method == "GET" && ["/api/capabilities", "/api/bundles", "/api/sites", "/api/help"].contains(pathname)
    }
    func resumingLogout() -> CustomerApiRequest {
        CustomerApiRequest(id: id, path: "/api/session", method: "DELETE", responseType: "json", body: nil, idempotencyKey: nil)
    }
}

enum CustomerApiPolicy {
    static let uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    static let bodyLimit = 32 * 1024
    static let responseLimit = 2 * 1024 * 1024
    static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: "\\A(?:" + pattern + ")\\z", options: .regularExpression) != nil
    }
    static func origin(_ raw: String) -> String? {
        guard raw.utf8.count <= 253, let url = URLComponents(string: raw), url.scheme == "https",
              let host = url.host, url.user == nil, url.password == nil, url.port == nil,
              url.path.isEmpty, url.query == nil, url.fragment == nil, raw == "https://" + host,
              matches(host, "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}"),
              !host.hasSuffix(".local"), !host.hasSuffix(".localhost") else { return nil }
        return raw
    }

    static func request(id: String, path: String, method: String, responseType: String, data: String?, key: String?) throws -> CustomerApiRequest {
        guard matches(id, uuid), path.utf8.count <= 4096,
              path.range(of: "[\\x00-\\x20\\x7f\\\\#]", options: .regularExpression) == nil,
              path.range(of: "%(?![0-9a-fA-F]{2})", options: .regularExpression) == nil,
              ["GET", "POST", "DELETE"].contains(method), ["json", "pdf"].contains(responseType) else { throw CustomerApiFailure.request }
        let pieces = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let route = String(pieces[0])
        let getPatterns = ["/api/(bundles|capabilities|sites|access|usage|help|payments/methods)", "/api/orders", "/api/orders/" + uuid + "/status", "/api/session", "/api/recovery/status", "/api/customer/invoices(?:/" + uuid + "(?:/pdf)?)?", "/api/receipt-pairings/" + uuid, "/api/network/(sites|session)"]
        let postPatterns = ["/api/orders", "/api/orders/" + uuid + "/(checkout|mock-payment|expire-unused)", "/api/session", "/api/(recovery(?:/(setup|rotate))?|handoff(?:/redeem)?)", "/api/invoice-downloads", "/api/receipt-pairings", "/api/receipt-pairings/" + uuid + "/cancel", "/api/vouchers/redeem", "/api/network/(credentials|disconnect)"]
        let allowed = method == "GET" ? getPatterns.contains(where: { matches(route, $0) }) : method == "POST" ? postPatterns.contains(where: { matches(route, $0) }) : route == "/api/session"
        guard allowed else { throw CustomerApiFailure.request }
        let pdf = (method == "GET" && matches(route, "/api/customer/invoices/" + uuid + "/pdf")) || (method == "POST" && route == "/api/invoice-downloads")
        guard (responseType == "pdf") == pdf else { throw CustomerApiFailure.request }
        if let key {
            guard matches(key, "[A-Za-z0-9_-]{16,128}"), method == "POST", route != "/api/session" else { throw CustomerApiFailure.request }
        }
        if pieces.count > 1 {
            guard method == "GET", !pieces[1].isEmpty else { throw CustomerApiFailure.request }
            var seen = Set<String>()
            for pair in pieces[1].split(separator: "&", omittingEmptySubsequences: false) {
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard parts.count == 2,
                      let name = String(parts[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                      let value = String(parts[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                      seen.insert(name).inserted, validQuery(route: route, name: name, value: value) else { throw CustomerApiFailure.request }
            }
        }
        var body: Data?
        if let data {
            guard method == "POST", data.utf8.count <= bodyLimit, let bytes = data.data(using: .utf8),
                  (try? JSONSerialization.jsonObject(with: bytes)) is [String: Any] else { throw CustomerApiFailure.request }
            body = bytes
        }
        return CustomerApiRequest(id: id, path: path, method: method, responseType: responseType, body: body, idempotencyKey: key)
    }

    private static func validQuery(route: String, name: String, value: String) -> Bool {
        if ["/api/access", "/api/customer/invoices"].contains(route), ["limit", "offset"].contains(name) {
            guard matches(value, "0|[1-9][0-9]{0,6}"), let number = Int(value) else { return false }
            return name == "limit" ? (1...100).contains(number) : (0...1_000_000).contains(number)
        }
        if route == "/api/customer/invoices", ["saleId", "orderId"].contains(name) { return matches(value, uuid) }
        if route == "/api/orders", name == "requestKey" { return matches(value, "[A-Za-z0-9_-]{16,128}") }
        if route == "/api/payments/methods" {
            return name == "siteId" ? matches(value, uuid) : name == "bundleId" && matches(value, "[a-z][a-z0-9-]{0,39}")
        }
        if route == "/api/usage", name == "entitlementIds" {
            let ids = value.split(separator: ",", omittingEmptySubsequences: false)
            return (1...100).contains(ids.count) && ids.allSatisfy { matches(String($0), uuid) }
        }
        if route == "/api/help", name == "q" {
            return value.utf16.count <= 200 && value.range(of: "[\\x00-\\x1f\\x7f]", options: .regularExpression) == nil
        }
        return false
    }

    static func retryAfter(_ value: String?, now: Date = Date()) -> Int? {
        guard let value, value.utf8.count <= 100 else { return nil }
        let seconds: Double?
        if matches(value, "[0-9]{1,10}") { seconds = Double(value) }
        else { seconds = httpDate(value)?.timeIntervalSince(now) }
        guard let seconds, seconds > 0 else { return nil }
        return Int(min(seconds * 1000, 300_000))
    }
    static func httpDate(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        formatter.isLenient = false
        return formatter.date(from: value)
    }
}

struct CustomerSessionCookie {
    let token: String?
    let expiresAt: TimeInterval?
    static func parse(_ raw: String, clearing: Bool, now: Date) throws -> CustomerSessionCookie {
        guard raw.utf8.count <= 2048, raw.range(of: "[\\x00-\\x1f\\x7f]", options: .regularExpression) == nil else { throw CustomerApiFailure.response }
        let parts = raw.components(separatedBy: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let first = parts.first, first.hasPrefix("__Host-pamofi_session=") else { throw CustomerApiFailure.response }
        let token = String(first.dropFirst("__Host-pamofi_session=".count))
        var attributes: [String: String] = [:]
        for part in parts.dropFirst() {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let name = pair.first, !name.isEmpty else { throw CustomerApiFailure.response }
            let key = name.trimmingCharacters(in: .whitespaces).lowercased()
            guard attributes[key] == nil, ["path", "secure", "httponly", "samesite", "max-age", "expires"].contains(key) else { throw CustomerApiFailure.response }
            attributes[key] = pair.count == 2 ? String(pair[1]).trimmingCharacters(in: .whitespaces) : ""
        }
        guard attributes["path"] == "/", attributes["secure"] == "", attributes["httponly"] == "", attributes["samesite"]?.lowercased() == "lax" else { throw CustomerApiFailure.response }
        if let expiry = attributes["expires"], CustomerApiPolicy.httpDate(expiry) == nil { throw CustomerApiFailure.response }
        if clearing {
            guard token.isEmpty, attributes["max-age"] == "0" || (attributes["max-age"] == nil && attributes["expires"].flatMap(CustomerApiPolicy.httpDate).map { $0 <= now } == true) else { throw CustomerApiFailure.response }
            return CustomerSessionCookie(token: nil, expiresAt: nil)
        }
        guard CustomerApiPolicy.matches(token, "[A-Za-z0-9_-]{43}"), let age = attributes["max-age"], CustomerApiPolicy.matches(age, "[1-9][0-9]{0,6}"), let seconds = Double(age), seconds <= 2_592_000 else { throw CustomerApiFailure.response }
        return CustomerSessionCookie(token: token, expiresAt: now.timeIntervalSince1970 + seconds)
    }
}

// Persisted only in the native OS credential store. Never encode this for a bridge response.
struct CustomerSessionState: Codable, Equatable {
    var version = 1
    let origin: String
    var token: String?
    var expiresAt: TimeInterval?
    var creationRetry: String?
    var creationCustomerId: String?
    var logoutPending = false

    func validate(expectedOrigin: String) throws {
        guard version == 1, origin == expectedOrigin,
              (token == nil) == (expiresAt == nil),
              token.map({ CustomerApiPolicy.matches($0, "[A-Za-z0-9_-]{43}") }) ?? true,
              expiresAt.map({ $0.isFinite && $0 > 0 }) ?? true,
              creationRetry.map({ CustomerApiPolicy.matches($0, "[A-Za-z0-9_-]{43}") }) ?? true,
              creationCustomerId.map({ CustomerApiPolicy.matches($0, CustomerApiPolicy.uuid) && creationRetry != nil }) ?? true else { throw CustomerApiFailure.storage }
    }
    func cookieHeader(now: Date) -> String? {
        guard let token, let expiresAt, expiresAt > now.timeIntervalSince1970 else { return nil }
        return "__Host-pamofi_session=" + token
    }
    mutating func clear() { token = nil; expiresAt = nil; creationRetry = nil; creationCustomerId = nil; logoutPending = false }
    func shouldResumeLogout(_ request: CustomerApiRequest) -> Bool { logoutPending && request.path == "/api/session" && request.method == "GET" }

    mutating func accept(_ request: CustomerApiRequest, status: Int, body: Any?, cookie: String?, now: Date) throws {
        let create = request.method == "POST" && request.path == "/api/session" && [200, 201].contains(status)
        let recover = request.method == "POST" && ["/api/recovery", "/api/handoff/redeem"].contains(request.path) && status == 200
        let logout = request.method == "DELETE" && request.path == "/api/session" && status == 204
        guard cookie == nil || create || recover || logout else { throw CustomerApiFailure.response }
        if request.method == "POST" && request.path == "/api/session" && status == 409 && (body as? [String: Any])?["error"] as? String == "session_retry_expired" {
            creationRetry = nil; creationCustomerId = nil
            return // The next account-start attempt must be an explicit new request.
        }
        if logout {
            if let cookie { _ = try CustomerSessionCookie.parse(cookie, clearing: true, now: now) }
            clear(); return
        }
        if request.changesIdentity && (200...299).contains(status) && !create && !recover { throw CustomerApiFailure.response }
        if create || recover {
            guard let id = (body as? [String: Any])?["customerId"] as? String, CustomerApiPolicy.matches(id, CustomerApiPolicy.uuid) else { throw CustomerApiFailure.response }
            if let cookie {
                let parsed = try CustomerSessionCookie.parse(cookie, clearing: false, now: now)
                token = parsed.token; expiresAt = parsed.expiresAt
            } else if recover || cookieHeader(now: now) == nil { throw CustomerApiFailure.response }
            if create {
                guard creationRetry != nil else { throw CustomerApiFailure.storage }
                creationCustomerId = id
            } else { creationRetry = nil; creationCustomerId = nil; logoutPending = false }
        }
        if request.method == "GET" && request.path == "/api/session" && status == 200 {
            guard !logoutPending else { throw CustomerApiFailure.logout }
            guard let id = (body as? [String: Any])?["customerId"] as? String, CustomerApiPolicy.matches(id, CustomerApiPolicy.uuid), cookieHeader(now: now) != nil else { throw CustomerApiFailure.response }
            if let expected = creationCustomerId {
                guard id == expected else { throw CustomerApiFailure.changed }
                creationRetry = nil; creationCustomerId = nil
            }
        }
    }
}
