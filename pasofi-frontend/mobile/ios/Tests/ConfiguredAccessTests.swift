import XCTest

final class ConfiguredAccessTests: XCTestCase {
    @MainActor func testConfiguredAccountEntry() throws {
        let app = XCUIApplication(bundleIdentifier: "com.onesa.pasofi")
        if app.state != .runningForeground { app.activate() }
        print("PASOFI_RELEASE_FOREGROUND")
        let openAccount = app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] %@", "My PasoFi")).firstMatch
        XCTAssertTrue(openAccount.waitForExistence(timeout: 40), "The configured home did not offer My PasoFi")
        print("PASOFI_FOUND_ACCOUNT")
        openAccount.tap()
        let disabled = app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS[c] %@", "Mobile account access is not enabled by this deployment yet"
        )).firstMatch
        XCTAssertTrue(disabled.waitForExistence(timeout: 40), "The installed app did not confirm the currently disabled hosted account service")
        let back = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Offline preview")).firstMatch
        XCTAssertTrue(back.exists)
        back.tap()
        XCTAssertTrue(openAccount.waitForExistence(timeout: 15))
        print("Installed configured PasoFi opened My PasoFi, observed the live disabled-account gate, and returned to its home. No payment was attempted.")
    }
}
