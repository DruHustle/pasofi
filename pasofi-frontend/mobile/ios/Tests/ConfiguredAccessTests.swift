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
            // This simulator is a first-install guest. It has never received an account,
            // payment input, voucher or credential. Only the initial public screen is read.
            let nodes = app.webViews.firstMatch.descendants(matching: .any).allElementsBoundByIndex
            var observed: [String] = []
            for item in nodes.prefix(60) {
                for value in [item.label, item.value as? String ?? ""] where !value.isEmpty {
                    let label = String(value.prefix(250))
                    if !observed.contains(label) { observed.append(label) }
                }
            }
            print("PASOFI_OBSERVED_GUEST_SCREEN " + observed.joined(separator: " | "))
            XCTFail("The installed account view did not display the expected disabled-account message")
        }
        let back = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Offline preview")).firstMatch
        guard back.exists else { XCTFail("Missing offline-preview return control"); return }
        back.tap()
        guard openAccount.waitForExistence(timeout: 15) else { XCTFail("Home did not resume"); return }
        print("PASOFI_RETURNED_HOME")
    }
}
