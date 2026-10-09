import XCTest

// DEBUG fixtures never connect to a relay or run a Provider. These tests use
// native coordinate hit-testing/typing, not programmatic SwiftUI actions.
final class ConversationUITests: XCTestCase {
  private var app: XCUIApplication!

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
    app = XCUIApplication()
  }

  private func launch(_ route: String, mock: Bool = true, extra: [String] = []) {
    app.launchArguments = ["-uiPreview", "-connected", "-route", route] +
      (mock ? ["-uiMockData"] : []) + extra
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 15))
    if route == "new" { XCTAssertTrue(app.staticTexts["新任务"].exists) }
    if route == "transcript" { XCTAssertTrue(app.staticTexts["重构远程会话列表并统一信息层级"].exists) }
  }

  private func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testToolAndReasoningDisclosure() {
    launch("transcript")
    let tool = app.buttons.matching(identifier: "tool-detail-toggle").matching(NSPredicate(format: "label CONTAINS %@", "编辑 HomeView.swift")).firstMatch
    XCTAssertTrue(tool.waitForExistence(timeout: 5))
    XCTAssertEqual(tool.value as? String, "已折叠")
    capture("transcript-collapsed")
    tool.tap()
    XCTAssertEqual(tool.value as? String, "已展开")
    XCTAssertTrue(app.staticTexts["编辑 HomeView.swift"].exists)
    tool.tap()
    XCTAssertEqual(tool.value as? String, "已折叠")

    let reasoning = app.buttons["reasoning-toggle"].firstMatch
    reasoning.tap()
    XCTAssertEqual(reasoning.value as? String, "已展开")
    reasoning.tap()
    XCTAssertEqual(reasoning.value as? String, "已折叠")
  }

  func testKeyboardAndModelControlsPreserveDraft() {
    launch("new")
    let input = app.descendants(matching: .any)["message-input"]
    XCTAssertFalse(app.buttons["发送"].isEnabled)
    input.tap()
    input.typeText("Review the current changes\nKeep evidence visible")
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["发送"].isEnabled)
    XCTAssertTrue(app.buttons["发送"].isHittable)
    XCTAssertLessThan(app.buttons["发送"].frame.maxY, app.keyboards.firstMatch.frame.minY)
    capture("composer-keyboard")
    app.buttons["收起键盘"].tap()
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "模型 ")).firstMatch
    XCTAssertGreaterThanOrEqual(model.frame.height, 44)
    model.tap()
    app.buttons["GPT-5.6"].tap()
    XCTAssertTrue((input.value as? String)?.contains("Keep evidence visible") == true)
    capture("composer-model-selected")
  }

  func testOfflineComposerCannotSend() {
    launch("chat", mock: false)
    let input = app.descendants(matching: .any)["message-input"]
    XCTAssertFalse(input.isEnabled)
    XCTAssertFalse(app.buttons["发送"].isEnabled)
    XCTAssertTrue(app.staticTexts["尚未连接 Mac · 发送已停用。"].exists)
    capture("offline-chat")
  }

  func testSlashCommandInsertion() {
    launch("chat", extra: ["-uiMockSlash"])
    let command = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "/review")).firstMatch
    XCTAssertTrue(command.waitForExistence(timeout: 5))
    command.tap()
    let input = app.descendants(matching: .any)["message-input"]
    XCTAssertEqual(input.value as? String, "/review ")
    capture("slash-command-inserted")
  }
}
