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

  func testQRPairingHasNoAccountGate() {
    app.launchArguments = ["-uiPreview", "-route", "pair"]
    app.launch()
    XCTAssertTrue(app.buttons["扫描配对码"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["粘贴配对码"].exists)
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Apple'")).firstMatch.exists)
    capture("qr-only-pairing")
  }

  func testSessionStatusAndReadOnlyWorkspaceBrowser() {
    launch("transcript", extra: ["-uiWorkspaceFixture"])
    XCTAssertTrue(app.buttons["session-runtime-status"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["session-runtime-status"].label.contains("正在运行"))
    app.buttons["项目文件与 Diff"].tap()
    XCTAssertTrue(app.buttons["README.md"].waitForExistence(timeout: 10))
    app.buttons["README.md"].tap()
    XCTAssertTrue(app.staticTexts["# Project fixture"].waitForExistence(timeout: 10))
    capture("workspace-file")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["未提交 Diff"].tap()
    XCTAssertTrue(app.staticTexts["+new"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["-old"].exists)
    capture("workspace-diff")
    app.buttons["完成"].tap()
    XCTAssertTrue(app.buttons["项目文件与 Diff"].exists)
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

  func testHistoryIsCompleteByScrollingWithoutDisclosure() {
    launch("transcript", extra: ["-uiMockContinuousHistory"])
    XCTAssertFalse(app.buttons["阅读全文"].exists)
    XCTAssertFalse(app.buttons["显示本轮较早内容"].exists)
    XCTAssertFalse(app.buttons["查看更早的消息"].exists)

    let markers = ["长回复末尾", "五百字之后的标题", "列表项目", "let answer = 42", "长回复开头",
                   "本轮第 1 段内容", "技能和mcp不用检测数量了 点击进入的时候再加载吧 这样可以节省性能",
                   "最早一轮的用户输入"]
    var seen = Set<String>()
    var promptLabel: String?
    let scroll = app.scrollViews.firstMatch
    for _ in 0..<24 {
      for marker in markers where app.staticTexts[marker].isHittable { seen.insert(marker) }
      let longPrompt = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "用户输入末尾")).firstMatch
      if longPrompt.isHittable { promptLabel = longPrompt.label }
      if seen.count == markers.count { break }
      scroll.swipeDown()
    }
    XCTAssertEqual(seen, Set(markers), "所有轮次和长回复应直接出现在连续滚动中")
    XCTAssertEqual(promptLabel, String(repeating: "完整用户输入。", count: 90) + "用户输入末尾")
    XCTAssertFalse(app.staticTexts["# 长回复开头"].exists)
    capture("history-continuous-scroll-oldest")
  }

  func testHistoryUpdatesWhenMacStartsAfterOpeningInactiveSession() {
    launch("transcript", extra: ["-uiMockContinuousHistory", "-uiMockMacStartsLater"])
    XCTAssertTrue(app.staticTexts["Mac 后来新增的用户输入"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Mac 后来新增的回复"].waitForExistence(timeout: 5))
    capture("history-mac-starts-after-opening")
  }

  func testMarkdownTableInLiveOutputAndHistory() {
    for route in ["chat", "transcript"] {
      launch(route, extra: ["-uiMockMarkdownTable"] + (route == "transcript" ? ["-uiMockMarkdownHistory"] : []))
      let table = app.scrollViews["markdown-table"]
      XCTAssertTrue(table.waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["问题"].isHittable)
      XCTAssertTrue(app.staticTexts["文件树扫描太慢"].isHittable, "单元格应解析粗体而不是显示星号")
      XCTAssertFalse(app.staticTexts["|---|:---:|---:|"].exists)
      XCTAssertTrue(app.staticTexts["表格之后的正文"].isHittable)
      let firstColumn = app.staticTexts["问题"].frame
      let longCell = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "reload_tree.bg.scan")).firstMatch
      XCTAssertGreaterThan(longCell.frame.height, 40, "长单元格应换行而不是截断")
      capture("markdown-\(route)-left")
      table.swipeLeft()
      XCTAssertTrue(app.staticTexts["判断"].isHittable, "宽表格必须能横向滑动到最后一列")
      XCTAssertTrue(app.staticTexts["两者争用磁盘 IO"].isHittable)
      XCTAssertLessThan(app.staticTexts["问题"].frame.minX, firstColumn.minX)
      capture("markdown-\(route)-right")
      table.swipeRight()
      XCTAssertTrue(app.staticTexts["问题"].isHittable)
    }
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

  func testSentImageAttachmentOpensPreview() {
    launch("chat")
    let thumbnail = app.buttons["查看 home-reference.png"]
    XCTAssertTrue(thumbnail.waitForExistence(timeout: 5))
    if !thumbnail.isHittable { app.swipeDown() }
    thumbnail.tap()
    let close = app.buttons["关闭预览"]
    XCTAssertTrue(close.waitForExistence(timeout: 5))
    XCTAssertTrue(app.images["home-reference.png"].exists)
    capture("sent-image-preview")
    close.tap()
    XCTAssertTrue(thumbnail.waitForExistence(timeout: 5))
  }
}
