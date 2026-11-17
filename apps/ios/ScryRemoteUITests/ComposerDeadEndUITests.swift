import XCTest

// Regressions for three composer dead-ends found on a real device:
//   1. the folder sheet stayed on “读取文件夹…” because `.idle` never asked the host,
//   2. a blocked send showed a grey arrow with no reason and an unusable “retry”
//      (covered by Checks/composer-dead-ends.py: the fixture cannot reach that
//      state without a real host, so it is verified on a paired phone instead),
//   3. the model list was laid out at full content height and only clipped, so a
//      drag rubber-banded and rows above the fold could not be selected.
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
      app.staticTexts["无法读取文件夹"].waitForExistence(timeout: 10)
    XCTAssertTrue(listed, "folder sheet never left 读取文件夹…")
    XCTAssertFalse(app.staticTexts["读取文件夹…"].exists)
  }

  func testModelListScrollsAndAutomaticModelIsSelectable() {
    launch("transcript", extra: ["-uiMockManyModels"])
    app.buttons["model-effort-control"].tap()
    let auto = app.buttons["model-option-auto"]
    XCTAssertTrue(auto.waitForExistence(timeout: 10))
    // Drag the list itself, the way the device gesture did.
    let list = app.scrollViews.firstMatch
    if list.exists {
      list.swipeUp()
      list.swipeDown()
      list.swipeDown()
    }
    XCTAssertTrue(auto.isHittable, "自动模型 never became hittable")
    auto.tap()
    XCTAssertTrue(app.buttons["model-effort-control"].label.contains("自动模型"),
                  "selecting 自动模型 must stick; chip was \(app.buttons["model-effort-control"].label)")
  }
}
