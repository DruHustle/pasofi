import Capacitor
import Foundation
import StripePaymentSheet
import StripePayments

/// Payment details stay in Stripe's UI. The web layer receives only availability or a status.
@objc(PasoFiStripePlugin)
public final class PasoFiStripePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PasoFiStripePlugin"
    public let jsName = "PasoFiStripe"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
    ]

    private static let returnURL = "com.onesa.pasofi://stripe-return"
    private static let applePayQueue = DispatchQueue(label: "com.onesa.pasofi.apple-pay", qos: .userInitiated)
    private var paymentInProgress = false
    private var paymentSheet: PaymentSheet?

    private struct Options {
        let publishableKey: String
        let country: String
        let appleMerchant: String?

        init?(_ call: CAPPluginCall) {
            guard let key = call.getString("publishableKey"), key.count <= 512,
                  key.range(of: "^pk_(test|live)_[A-Za-z0-9]+\\z", options: .regularExpression) != nil,
                  let testMode = call.getBool("testMode"),
                  key.hasPrefix(testMode ? "pk_test_" : "pk_live_"),
                  let country = call.getString("merchantCountryCode"),
                  country.range(of: "^[A-Z]{2}\\z", options: .regularExpression) != nil,
                  call.getBool("googlePay") != nil else { return nil }
            publishableKey = key
            self.country = country

            // A backend value cannot invent an Apple entitlement for this installed build.
            let requested = call.getString("applePayMerchantId")
            let bundled = Bundle.main.object(forInfoDictionaryKey: "PasoFiApplePayMerchantIdentifier") as? String
            let entitlements = Bundle.main.object(forInfoDictionaryKey: "PasoFiApplePayEntitlements") as? String
            if let requested, requested.count <= 255,
               requested.range(of: "^merchant\\.[A-Za-z0-9.-]+\\z", options: .regularExpression) != nil,
               requested == bundled, entitlements == "App/PasoFiStripe.entitlements" {
                appleMerchant = requested
            } else {
                appleMerchant = nil
            }
        }
    }

    @objc public func availability(_ call: CAPPluginCall) {
        guard let options = Options(call) else {
            call.reject("Payment configuration is unavailable.", "invalid_configuration")
            return
        }
        DispatchQueue.main.async {
            self.applePayAvailable(options) { available in
                call.resolve(["applePay": available, "googlePay": false])
            }
        }
    }

    @objc public func present(_ call: CAPPluginCall) {
        guard let options = Options(call),
              call.getString("merchantDisplayName") == "PasoFi",
              let secret = call.getString("clientSecret"), secret.count <= 512,
              secret.range(of: "^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+\\z", options: .regularExpression) != nil else {
            call.reject("Payment configuration is unavailable.", "invalid_configuration")
            return
        }
        DispatchQueue.main.async {
            guard !self.paymentInProgress else {
                call.reject("A payment is already open.", "payment_in_progress")
                return
            }
            self.paymentInProgress = true
            self.applePayAvailable(options) { applePay in
                guard let presenter = self.bridge?.viewController,
                      presenter.viewIfLoaded?.window != nil,
                      presenter.presentedViewController == nil else {
                    self.paymentInProgress = false
                    call.resolve(["status": "failed"])
                    return
                }

                // Use a per-presentation API client, not mutable shared key state.
                var configuration = PaymentSheet.Configuration()
                configuration.apiClient = STPAPIClient(publishableKey: options.publishableKey)
                configuration.merchantDisplayName = "Pasofi"
                configuration.returnURL = Self.returnURL
                configuration.allowsDelayedPaymentMethods = false
                configuration.link = .init(display: .never)
                if applePay, let merchant = options.appleMerchant {
                    configuration.applePay = .init(merchantId: merchant, merchantCountryCode: options.country)
                }
                PaymentSheet.resetCustomer()
                let sheet = PaymentSheet(paymentIntentClientSecret: secret, configuration: configuration)
                self.paymentSheet = sheet
                sheet.present(from: presenter) { result in
                    self.paymentSheet = nil
                    self.paymentInProgress = false
                    // The backend's verified payment event remains the fulfillment authority.
                    switch result {
                    case .completed: call.resolve(["status": "completed"])
                    case .canceled: call.resolve(["status": "cancelled"])
                    case .failed: call.resolve(["status": "failed"])
                    }
                }
            }
        }
    }

    /// Stripe 26.15.1 documents that PassKit readiness may stall. Never wait on the UI thread.
    /// A five-second readiness timeout keeps card checkout usable; late results are ignored.
    private func applePayAvailable(_ options: Options, completion: @escaping (Bool) -> Void) {
        guard options.appleMerchant != nil else { completion(false); return }
        var finished = false // Accessed only on the main queue.
        let finish: (Bool) -> Void = { available in
            guard !finished else { return }
            finished = true
            completion(available)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { finish(false) }
        Self.applePayQueue.async {
            let available = StripeAPI.deviceSupportsApplePay()
            DispatchQueue.main.async { finish(available) }
        }
    }

    /// Consume owned callbacks even after process recreation; never forward their query to JS.
    static func consumeReturnURL(_ url: URL) -> Bool {
        guard url.scheme == "com.onesa.pasofi", url.host == "stripe-return" else { return false }
        StripeAPI.handleURLCallback(with: url)
        return true
    }
}

final class PasoFiBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PasoFiCustomerApiPlugin())
        bridge?.registerPluginInstance(PasoFiStripePlugin())
    }
}
