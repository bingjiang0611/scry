import XCTest

final class ReaderPositionUITests: XCTestCase {
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
  }

  private func launch(_ route: String, flags: [String] = [], ax3: Bool = false) {
    app.launchArguments = ["-uiPreview", "-connected", "-route", route, "-uiMockData"] + flags
    app.launchArguments += ["-UIPreferredContentSizeCategoryName",
      ax3 ? "UICTContentSizeCategoryAccessibilityXL" : "UICTContentSizeCategoryL"]
    app.launch()
    XCTAssertTrue(app.scrollViews["conversation-scroll"].waitForExistence(timeout: 5))
    if ax3 {
      // Reject a silently ignored content-size override rather than testing the default size twice.
      XCTAssertGreaterThan(app.textFields["message-input"].frame.height, 40)
    }
  }

  private func assertVisibleInReader(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
    let reader = app.scrollViews["conversation-scroll"]
    let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      element.exists && element.isHittable && element.frame.intersects(reader.frame)
    }, object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 5), .completed, file: file, line: line)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testAContinuationAfterBrowsingLongReplyReturnsToLatest() {
    launch("chat", flags: ["-uiMockLongOutput"])
    assertVisibleInReader(app.staticTexts["实时回复末尾"])
    let reader = app.scrollViews["conversation-scroll"]
    reader.swipeDown()
    XCTAssertTrue(app.buttons["回到最新"].waitForExistence(timeout: 5))
    let input = app.textFields["message-input"]
    input.tap()
    input.typeText("Continue the mock conversation")
    app.buttons["arrow.up"].tap()
    let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      (input.value as? String ?? "").isEmpty
    }, object: input)
    XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 5), .completed)
    assertVisibleInReader(app.staticTexts["这是 DEBUG 视觉预览回复；没有连接 Provider，也没有写入真实 ledger。"])
    XCTAssertFalse(app.buttons["回到最新"].exists)
  }

  func testBLongHistoryInitiallyShowsItsCompleteTail() {
    for ax3 in [false, true] {
      launch("transcript", flags: ["-uiMockFirstScreen"], ax3: ax3)
      assertVisibleInReader(app.staticTexts["完整内容末尾"])
      app.terminate()
    }
  }

  func testCAX3CompletedChatAndTranscriptShowLatestEvidence() {
    for route in ["chat", "transcript"] {
      launch(route, ax3: true)
      assertVisibleInReader(app.staticTexts["输入 18,420 · 输出 1,286 · $0.084"])
      app.terminate()
    }
  }
}
