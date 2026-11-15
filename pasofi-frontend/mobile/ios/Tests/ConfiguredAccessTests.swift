import XCTest

final class ConfiguredAccessTests: XCTestCase {
    @MainActor func testConfiguredAccountEntry() throws {
        let app = XCUIApplication(bundleIdentifier: "com.onesa.pasofi")
        if app.state != .runningForeground { app.activate() }
        print("PASOFI_RELEASE_FOREGROUND")
        let openAccount = app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] %@", "My PasoFi")).firstMatch
        guard openAccount.waitForExistence(timeout: 40) else {
            XCTFail("The configured home did not offer My PasoFi")
            return
        }
        openAccount.tap()
        print("PASOFI_OPENED_ACCOUNT")
        let expected = "Mobile account access is not enabled by this deployment yet"
        let expectedGate = app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", expected, expected
        )).firstMatch
        let matched = expectedGate.waitForExistence(timeout: 22)
        if matched {
            print("PASOFI_EXPECTED_GATE_CONFIRMED")
        } else {
            // Preserve a screenshot without walking a stale accessibility tree.
            // The previous per-element snapshot could throw before reporting the
            // actual account-gate assertion.
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = "PasoFi guest account gate"
            attachment.lifetime = .keepAlways
            add(attachment)
            print("PASOFI_EXPECTED_GATE_MISSING foreground=" + String(app.state == .runningForeground) + " webview=" + String(app.webViews.firstMatch.exists))
            XCTFail("The installed account view did not display the expected disabled-account message")
        }
        let back = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Offline preview")).firstMatch
        guard back.exists else { XCTFail("Missing offline-preview return control"); return }
        back.tap()
        guard openAccount.waitForExistence(timeout: 15) else { XCTFail("Home did not resume"); return }
        print("PASOFI_RETURNED_HOME")
    }
}
