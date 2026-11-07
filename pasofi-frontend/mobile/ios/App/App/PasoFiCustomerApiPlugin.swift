import Capacitor
import Foundation
import Security
import WebKit

/// Customer-only HTTP. Session authority is never placed in a WebView cookie
/// store, shared URLSession, bridge result, native preference or diagnostic log.
@objc(PasoFiCustomerApiPlugin)
public final class PasoFiCustomerApiPlugin: CAPPlugin, CAPBridgedPlugin, @unchecked Sendable {
    public let identifier = "PasoFiCustomerApiPlugin"
    public let jsName = "PasoFiCustomerApi"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private static let ownerQueue = DispatchQueue(label: "com.onesa.pasofi.customer-api")
    private static weak var owner: PasoFiCustomerApiPlugin?
    private let stateQueue = PasoFiCustomerApiPlugin.ownerQueue
    private var configuredOrigin: String?
    private var state: CustomerSessionState?
    private var generation: UInt64 = 0
    private var identityChangeInProgress = false
    private var requests: [Int: ActiveRequest] = [:]
    private var networkSession: URLSession?
    private func session() -> URLSession {
        if let networkSession { return networkSession }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.waitsForConnectivity = false
        let delegates = OperationQueue()
        delegates.maxConcurrentOperationCount = 1
        let value = URLSession(configuration: configuration, delegate: CustomerHttpDelegate(owner: self), delegateQueue: delegates)
        networkSession = value
        return value
    }

    deinit { networkSession?.invalidateAndCancel() }

    public override func load() {
        let origin = CustomerApiPolicy.origin(getConfig().getString("origin") ?? "")
        stateQueue.sync {
            // A recreated view controller cannot race its predecessor's private
            // state commit. Admission and persistence use this same process queue.
            Self.owner?.abandonDocument()
            Self.owner = self
            configuredOrigin = origin
        }
    }

    private func abandonDocument() {
        generation &+= 1
        identityChangeInProgress = false
        let old = Array(requests.values)
        requests.removeAll()
        old.forEach { $0.task.cancel() }
    }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        if navigationAction.targetFrame?.isMainFrame == true {
            stateQueue.sync {
                // The previous JavaScript document is going away. Do not resolve
                // or reject its retained callbacks into the replacement page.
                abandonDocument()
            }
        }
        return nil // Preserve Capacitor's existing navigation policy.
    }

    private final class ActiveRequest {
        let call: CAPPluginCall
        let request: CustomerApiRequest
        let generation: UInt64
        let resumesLogout: Bool
        let task: URLSessionDataTask
        var response: HTTPURLResponse?
        var data = Data()
        init(call: CAPPluginCall, request: CustomerApiRequest, generation: UInt64, resumesLogout: Bool, task: URLSessionDataTask) {
            self.call = call; self.request = request; self.generation = generation; self.resumesLogout = resumesLogout; self.task = task
        }
    }

    @objc public func availability(_ call: CAPPluginCall) {
        guard Set(call.jsObjectRepresentation.keys) == ["requestId"], let id = call.getString("requestId"), CustomerApiPolicy.matches(id, CustomerApiPolicy.uuid) else { reject(call, .request); return }
        if let origin = configuredOrigin {
            call.resolve(["requestId": id, "configured": true, "origin": origin, "protocol": 1])
        } else { call.resolve(["requestId": id, "configured": false, "protocol": 1]) }
    }

    @objc public func request(_ call: CAPPluginCall) {
        do {
            let names = Set(call.jsObjectRepresentation.keys)
            guard names.isSubset(of: ["requestId", "path", "method", "data", "idempotencyKey", "responseType"]),
                  let id = call.getString("requestId"), let path = call.getString("path"),
                  let method = call.getString("method"), let type = call.getString("responseType"),
                  (!names.contains("data") || call.getString("data") != nil),
                  (!names.contains("idempotencyKey") || call.getString("idempotencyKey") != nil) else { throw CustomerApiFailure.request }
            let value = try CustomerApiPolicy.request(id: id, path: path, method: method, responseType: type, data: call.getString("data"), key: call.getString("idempotencyKey"))
            // This serial admission boundary captures the generation before a
            // network task is queued. Later auth changes cancel older tasks.
            stateQueue.async {
                guard Self.owner === self else { return }
                do { try self.begin(value, call: call) }
                catch { self.reject(call, error as? CustomerApiFailure ?? .storage) }
            }
        } catch { reject(call, error as? CustomerApiFailure ?? .request) }
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("requestId"), CustomerApiPolicy.matches(id, CustomerApiPolicy.uuid) else { reject(call, .request); return }
        stateQueue.async {
            guard Self.owner === self else { return }
            if let active = self.requests.values.first(where: { $0.request.id == id }) { self.fail(active, .network) }
            call.resolve(["requestId": id])
        }
    }

    private func begin(_ original: CustomerApiRequest, call: CAPPluginCall) throws {
        guard let origin = configuredOrigin else { throw CustomerApiFailure.unavailable }
        if state == nil { state = try CustomerKeychain.read(origin: origin) }
        guard var next = state else { throw CustomerApiFailure.storage }
        let resumesLogout = next.shouldResumeLogout(original)
        let request = resumesLogout ? original.resumingLogout() : original
        guard !requests.values.contains(where: { $0.request.id == request.id }), requests.count < 16 else { throw CustomerApiFailure.request }
        if identityChangeInProgress { throw CustomerApiFailure.changed }
        if next.logoutPending && !request.isPublicRead && !(request.path == "/api/session" && request.method == "DELETE") { throw CustomerApiFailure.logout }
        if request.changesIdentity {
            generation &+= 1
            for old in Array(requests.values) { fail(old, .changed) }
        }
        if request.path == "/api/session" && request.method == "POST" && next.creationRetry == nil {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw CustomerApiFailure.storage }
            next.creationRetry = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        if request.path == "/api/session" && request.method == "DELETE" { next.logoutPending = true }
        try commit(next)
        guard let url = URL(string: origin + request.path) else { throw CustomerApiFailure.request }
        var http = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        http.httpMethod = request.method
        http.httpShouldHandleCookies = false
        http.httpBody = request.body
        http.setValue(origin, forHTTPHeaderField: "Origin")
        http.setValue("1", forHTTPHeaderField: "X-PasoFi-Native-Customer")
        http.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        http.setValue(request.responseType == "pdf" ? "application/pdf, application/json" : "application/json", forHTTPHeaderField: "Accept")
        if request.body != nil { http.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if !request.isPublicRead, let cookie = next.cookieHeader(now: Date()) { http.setValue(cookie, forHTTPHeaderField: "Cookie") }
        let retry = request.path == "/api/session" && request.method == "POST" ? next.creationRetry : request.idempotencyKey
        if let retry { http.setValue(retry, forHTTPHeaderField: "Idempotency-Key") }
        let task = session().dataTask(with: http)
        let active = ActiveRequest(call: call, request: request, generation: generation, resumesLogout: resumesLogout, task: task)
        requests[task.taskIdentifier] = active
        if request.changesIdentity { identityChangeInProgress = true }
        task.resume()
    }

    private func commit(_ candidate: CustomerSessionState) throws {
        guard Self.owner === self, let origin = configuredOrigin else { throw CustomerApiFailure.unavailable }
        try candidate.validate(expectedOrigin: origin)
        if candidate != state { try CustomerKeychain.write(candidate); state = candidate }
    }
    private func current(_ task: URLSessionTask) -> ActiveRequest? {
        guard Self.owner === self, let active = requests[task.taskIdentifier], active.generation == generation else { return nil }
        return active
    }
    private func remove(_ active: ActiveRequest) {
        requests.removeValue(forKey: active.task.taskIdentifier)
        if active.request.changesIdentity { identityChangeInProgress = false }
    }
    private func reject(_ call: CAPPluginCall, _ reason: CustomerApiFailure) { call.reject("The customer request could not be completed.", reason.rawValue) }
    private func fail(_ active: ActiveRequest, _ reason: CustomerApiFailure) {
        remove(active); active.task.cancel(); reject(active.call, reason)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        stateQueue.async {
            guard let active = self.current(dataTask) else { completionHandler(.cancel); return }
            guard let response = response as? HTTPURLResponse, response.url == dataTask.originalRequest?.url,
                  (200...599).contains(response.statusCode), !(300...399).contains(response.statusCode),
                  response.expectedContentLength <= Int64(CustomerApiPolicy.responseLimit),
                  response.value(forHTTPHeaderField: "Set-Cookie2") == nil else {
                self.fail(active, active.resumesLogout ? .logout : .response); completionHandler(.cancel); return
            }
            active.response = response
            completionHandler(.allow)
        }
    }
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        // Backpressure the serial delegate queue: never retain an unbounded
        // backlog of chunks while native credential persistence is busy.
        stateQueue.sync {
            guard let active = self.current(dataTask) else { return }
            guard active.data.count + data.count <= CustomerApiPolicy.responseLimit else { self.fail(active, active.resumesLogout ? .logout : .response); return }
            active.data.append(data)
        }
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        stateQueue.async {
            guard let active = self.current(task) else { return }
            do {
                guard error == nil, let response = active.response, var next = self.state else { throw CustomerApiFailure.network }
                let status = response.statusCode
                let contentType = response.value(forHTTPHeaderField: "Content-Type")?.components(separatedBy: ";")[0].trimmingCharacters(in: .whitespaces).lowercased() ?? ""
                var data: Any = NSNull()
                if status != 204 {
                    if active.request.responseType == "pdf" && (200...299).contains(status) {
                        guard contentType == "application/pdf", active.data.starts(with: Data("%PDF-".utf8)) else { throw CustomerApiFailure.response }
                        data = active.data.base64EncodedString()
                    } else {
                        guard contentType == "application/json", let parsed = try? JSONSerialization.jsonObject(with: active.data, options: [.fragmentsAllowed]), parsed is [String: Any] || parsed is [Any] else { throw CustomerApiFailure.response }
                        data = parsed
                    }
                } else if !active.data.isEmpty { throw CustomerApiFailure.response }
                if active.resumesLogout && status != 204 { throw CustomerApiFailure.logout }
                // Work on a copy; response validation and OS persistence must both
                // succeed before any in-memory session update or bridge result.
                try next.accept(active.request, status: status, body: data, cookie: response.value(forHTTPHeaderField: "Set-Cookie"), now: Date())
                try self.commit(next)
                self.remove(active)
                if active.resumesLogout {
                    active.call.resolve(["requestId": active.request.id, "status": 401, "data": ["error": "not_authenticated"], "contentType": "application/json"])
                } else {
                    var result: [String: Any] = ["requestId": active.request.id, "status": status, "data": data, "contentType": status == 204 ? "application/json" : contentType]
                    if let delay = CustomerApiPolicy.retryAfter(response.value(forHTTPHeaderField: "Retry-After")) { result["retryAfterMs"] = delay }
                    active.call.resolve(result)
                }
            } catch {
                self.fail(active, active.resumesLogout ? .logout : (error as? CustomerApiFailure ?? .response))
            }
        }
    }
}

/// URLSession retains its delegate. The weak owner avoids retaining an abandoned
/// plugin/bridge after view-controller recreation; orphaned tasks are cancelled.
private final class CustomerHttpDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    weak var owner: PasoFiCustomerApiPlugin?
    init(owner: PasoFiCustomerApiPlugin) { self.owner = owner; super.init() }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let owner else { completionHandler(.cancel); return }
        owner.urlSession(session, dataTask: dataTask, didReceive: response, completionHandler: completionHandler)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let owner else { dataTask.cancel(); return }
        owner.urlSession(session, dataTask: dataTask, didReceive: data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        owner?.urlSession(session, task: task, didCompleteWithError: error)
    }
}

private enum CustomerKeychain {
    private static let service = "com.onesa.pasofi.customer-api.v1"
    private static func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: origin, kSecAttrSynchronizable as String: false]
    }
    static func read(origin: String) throws -> CustomerSessionState {
        var request = query(origin)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return CustomerSessionState(origin: origin) }
        guard status == errSecSuccess, let bytes = result as? Data, bytes.count <= 8192,
              let state = try? JSONDecoder().decode(CustomerSessionState.self, from: bytes) else { throw CustomerApiFailure.storage }
        try state.validate(expectedOrigin: origin)
        return state
    }
    static func write(_ state: CustomerSessionState) throws {
        guard let bytes = try? JSONEncoder().encode(state), bytes.count <= 8192 else { throw CustomerApiFailure.storage }
        let attributes: [String: Any] = [kSecValueData as String: bytes, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query(state.origin) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query(state.origin)
            attributes.forEach { item[$0.key] = $0.value }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw CustomerApiFailure.storage }
        } else if status != errSecSuccess { throw CustomerApiFailure.storage }
    }
}
