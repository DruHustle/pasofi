import XCTest

final class ConfiguredAccessTests: XCTestCase {
    @MainActor func testConfiguredAccountEntry() throws {
        let app = XCUIApplication(bundleIdentifier: "com.onesa.pasofi")
        if app.state != .runningForeground { app.activate() }
        print("PASOFI_RELEASE_FOREGROUND")
        let openAccount = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "My PasoFi")).firstMatch
        guard openAccount.waitForExistence(timeout: 40) else {
            XCTFail("The configured home did not offer My PasoFi")
            return
        }
        // Target the actual actionable button, not a similarly labelled static text
        // descendant of the WebView. An apparent tap must not count as account entry.
        openAccount.tap()
        print("PASOFI_OPENED_ACCOUNT")
        // A configured service may offer the real Onesa sign-in entry, or an
        // explicit unavailable state. Neither is allowed to remain on a spinner.
        let expectedGate = app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@ OR label CONTAINS[c] %@ OR value CONTAINS[c] %@ OR label CONTAINS[c] %@ OR value CONTAINS[c] %@ OR label CONTAINS[c] %@ OR value CONTAINS[c] %@ OR label CONTAINS[c] %@ OR value CONTAINS[c] %@",
            "Sign in with Onesa", "Sign in with Onesa",
            "Continue to PasoFi account on the web", "Continue to PasoFi account on the web",
            "Mobile account access is not enabled", "Mobile account access is not enabled",
            "did not respond in time", "did not respond in time",
            "configured PasoFi service could not be reached", "configured PasoFi service could not be reached"
        )).firstMatch
        let matched = expectedGate.waitForExistence(timeout: 22)
        if matched {
            let status = expectedGate.label.lowercased() + " " + String(describing: expectedGate.value).lowercased()
            if status.contains("mobile account access is not enabled") {
                print("PASOFI_PUBLISHED_ACCOUNT_GATE_CONFIRMED")
            } else if status.contains("did not respond in time") {
                print("PASOFI_GATEWAY_TIMED_OUT")
            } else {
                print("PASOFI_GATEWAY_UNREACHABLE")
            }
        } else {
            // Preserve a screenshot without walking a stale accessibility tree.
            // The previous per-element snapshot could throw before reporting the
            // actual account-gate assertion.
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = "PasoFi guest account gate"
            attachment.lifetime = .keepAlways
            add(attachment)
            print("PASOFI_EXPECTED_GATE_MISSING foreground=" + String(app.state == .runningForeground) + " webview=" + String(app.webViews.firstMatch.exists))
            XCTFail("The installed account view did not display a disabled or unavailable account state")
        }
        let back = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Offline preview")).firstMatch
        guard back.exists else { XCTFail("Missing offline-preview return control"); return }
        back.tap()
        guard openAccount.waitForExistence(timeout: 15) else { XCTFail("Home did not resume"); return }
        print("PASOFI_RETURNED_HOME")
    }
}
