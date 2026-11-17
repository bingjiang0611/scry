import XCTest

// Endpoint/interaction regressions on the isolated -uiPreview app. These do not
// prove intermediate frames; record those separately on the physical device.
final class ContinuityUITests: XCTestCase {
  private var app: XCUIApplication!

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
    app = XCUIApplication()
  }

  override func tearDown() {
    app.terminate()
    super.tearDown()
  }

  private func launch(_ route: String = "home", drawer: Bool = false, extra: [String] = []) {
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", route]
      + (drawer ? ["-drawerOpen"] : []) + extra
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 10))
  }

  func testShortDrawerDragReturnsToClosedAndCanImmediatelyOpen() {
    launch()
    let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.4))
    let short = app.coordinate(withNormalizedOffset: CGVector(dx: 0.20, dy: 0.4))
    edge.press(forDuration: 0.05, thenDragTo: short, withVelocity: .slow, thenHoldForDuration: 0.2)
    let toggle = app.buttons["sidebar-toggle"]
    XCTAssertTrue(toggle.isHittable)
    toggle.tap()
    XCTAssertTrue(app.buttons["drawer-new-session"].waitForExistence(timeout: 5))
    app.buttons["drawer-new-session"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].isHittable)
  }

  func testDrawerDragCancelsButtonPressWithoutCreatingTask() {
    launch(drawer: true)
    let newTask = app.buttons["在 scry 中新建任务"]
    XCTAssertTrue(newTask.waitForExistence(timeout: 5))
    let start = newTask.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    let end = start.withOffset(CGVector(dx: -80, dy: 0))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
    XCTAssertTrue(app.buttons["sidebar-close"].isHittable)
    XCTAssertEqual(app.keyboards.count, 0)
    newTask.tap()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].isHittable)
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
  }

  func testSessionTransitionKeepsDrawerClosedReturnAndDraft() {
    launch()
    let input = app.descendants(matching: .any)["message-input"]
    input.tap()
    input.typeText("continuity draft")
    app.buttons["sidebar-toggle"].tap()
    app.buttons["home-tab-projects"].tap()
    let project = app.buttons["home-project-scry"]
    XCTAssertTrue(project.waitForExistence(timeout: 5))
    if project.value as? String == "已收起" { project.tap() }
    let session = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "完成 iOS 工作目录选择器")).firstMatch
    XCTAssertTrue(session.waitForExistence(timeout: 5))
    session.tap()
    XCTAssertTrue(app.buttons["session-overview"].waitForExistence(timeout: 5))
    app.buttons["返回"].tap()
    XCTAssertTrue(app.buttons["sidebar-toggle"].waitForExistence(timeout: 5))
    XCTAssertTrue(input.isHittable)
    XCTAssertTrue((input.value as? String)?.contains("continuity draft") == true)
  }

  func testFirstSubmissionHasOneMessageAndClearsOnlySubmittedDraft() {
    launch("new")
    let input = app.descendants(matching: .any)["message-input"]
    input.tap()
    input.typeText("continuity first submission")
    XCTAssertEqual(input.value as? String, "continuity first submission")
    let send = app.buttons["发送"]
    XCTAssertTrue(send.isEnabled)
    send.tap()
    let message = app.staticTexts["continuity first submission"]
    XCTAssertTrue(message.waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts.matching(identifier: "continuity first submission").count, 1)
    XCTAssertFalse((input.value as? String)?.contains("continuity first submission") == true)
    input.tap()
    input.typeText("next draft")
    XCTAssertTrue((input.value as? String)?.contains("next draft") == true)
  }

  func testRemovingFirstAttachmentSubmitsOnlyTheRemainingAttachment() {
    launch("new", extra: ["-uiDraftAttachments"])
    app.buttons["移除 a.txt"].tap()
    XCTAssertFalse(app.buttons["移除 a.txt"].exists)
    XCTAssertTrue(app.buttons["移除 b.txt"].exists)
    let input = app.descendants(matching: .any)["message-input"]
    input.tap()
    input.typeText("attachment continuity")
    app.buttons["发送"].tap()
    XCTAssertTrue(app.staticTexts["attachment continuity"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["b.txt"].exists)
    XCTAssertFalse(app.staticTexts["a.txt"].exists)
    XCTAssertFalse(app.buttons["移除 b.txt"].exists)
  }

  func testImageCanReopenFromSameThumbnailAfterDismissal() {
    launch("chat")
    let thumbnail = app.buttons["查看 home-reference.png"]
    // The reader starts at the newest message; the older thumbnail may not
    // be mounted until its scroll container moves back toward the first turn.
    if !thumbnail.exists || !thumbnail.isHittable { app.scrollViews["conversation-scroll"].swipeDown() }
    XCTAssertTrue(thumbnail.waitForExistence(timeout: 5))
    XCTAssertTrue(thumbnail.isHittable)
    for _ in 0..<2 {
      thumbnail.tap()
      let close = app.buttons["关闭预览"]
      XCTAssertTrue(close.waitForExistence(timeout: 5))
      XCTAssertTrue(app.images["home-reference.png"].exists)
      close.tap()
      XCTAssertTrue(thumbnail.waitForExistence(timeout: 5))
      XCTAssertTrue(thumbnail.isHittable)
    }
  }
}
