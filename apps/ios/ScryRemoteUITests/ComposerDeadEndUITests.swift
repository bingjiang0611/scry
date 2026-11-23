import XCTest

// Fixtures never touch a relay or a Provider.
final class ComposerDeadEndUITests: XCTestCase {
  private var app: XCUIApplication!

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
    app = XCUIApplication()
  }

  private func launch(_ route: String, extra: [String] = []) {
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", route] + extra
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 20))
  }

  func testFolderSheetAsksTheHostInsteadOfSpinningForever() {
    launch("new", extra: ["-uiMockDirectoriesIdle"])
    let folder = app.buttons["project-control"]
    XCTAssertTrue(folder.waitForExistence(timeout: 10), "no folder control on the new-session composer")
    folder.tap()
    // The listing must replace the reading state; the regression was an endless
    // spinner because the sheet never issued a request.
    let listed = app.buttons["scry"].waitForExistence(timeout: 10) ||
      app.staticTexts["没能读取文件夹"].waitForExistence(timeout: 10)
    XCTAssertTrue(listed, "folder sheet never left 读取文件夹…")
    XCTAssertFalse(app.staticTexts["读取文件夹…"].exists)
  }

  func testBlockedSendExplainsItselfAndRecovers() {
    // `-uiForceStalePermission` injects the state at its source: the host offers no
    // permission matching the restored choice. Re-reading cannot resolve it.
    launch("transcript", extra: ["-uiForceStalePermission"])
    let reason = app.staticTexts["send-blocked-reason"]
    XCTAssertTrue(reason.waitForExistence(timeout: 15), "a blocked send still shows no reason")
    XCTAssertTrue(reason.label.hasPrefix("现在无法发送："), "reason was not framed: \(reason.label)")
    let recover = app.buttons["使用默认设置"]
    XCTAssertTrue(recover.waitForExistence(timeout: 10), "the block offers no recovery that can succeed")
    recover.tap()
    XCTAssertTrue(reason.waitForNonExistence(timeout: 15), "恢复默认设置 left the send blocked")
  }

  func testNativeModelPickerExposesAutomaticModel() {
    launch("transcript", extra: ["-uiMockManyModels"])
    app.buttons["model-effort-control"].tap()
    let picker = app.buttons["model-picker"]
    XCTAssertTrue(picker.waitForExistence(timeout: 10))
    picker.tap()
    let auto = app.buttons["自动模型"]
    XCTAssertTrue(auto.waitForExistence(timeout: 10))
    auto.tap()
    XCTAssertTrue(picker.label.contains("自动模型"),
                  "selecting 自动模型 must stick; picker was \(picker.label)")
  }
}
