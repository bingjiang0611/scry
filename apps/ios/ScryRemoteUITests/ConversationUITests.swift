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

  private func launchHome(extra: [String] = []) {
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", "home"] + extra
    app.launch()
    XCTAssertTrue(app.textFields["搜索会话"].waitForExistence(timeout: 10))
  }

  func testGroupedSessionOmitsRepeatedProjectContext() {
    launchHome()
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "完成 iOS 工作目录选择器和附件发送")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    XCTAssertTrue(row.label.contains("CODEX"))
    XCTAssertFalse(row.label.contains("scry"))
  }

  func testHomeRemainsOperableAtAccessibilityTextSize() {
    app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXL",
                           "-uiPreview", "-connected", "-uiMockData", "-route", "home"]
    app.launch()
    XCTAssertTrue(app.textFields["搜索会话"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["新任务"].isHittable)
    XCTAssertTrue(app.staticTexts["项目"].exists)
  }

  func testPairingParseFailureIsActionableWithCollapsedTechnicalDetail() {
    app.launchArguments = ["-uiPreview", "-route", "pair", "-pairCode", "not-a-scry-code"]
    app.launch()
    XCTAssertTrue(app.staticTexts["这不是 Scry 配对码。请在 Mac 的 Scry 中重新打开“连接 iPhone”并扫描二维码。"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["badPrefix"].exists)
    XCTAssertTrue(app.buttons["技术详情"].exists)
    app.buttons["技术详情"].tap()
    XCTAssertTrue(app.staticTexts["badPrefix"].waitForExistence(timeout: 5))
  }

  func testHistoryFailureExposesEvidenceDetailsFromStatusStrip() {
    launch("transcript", extra: ["-uiMockHistoryFailure"])
    XCTAssertTrue(app.staticTexts["历史同步失败，显示上次内容，正在重试"].waitForExistence(timeout: 5))
    app.buttons["详情"].tap()
    XCTAssertTrue(app.navigationBars["历史证据"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["中继连接已关闭（1009 message too big）"].exists)
  }

  func testSettingsGroupsConnectionLocalDataAndSecurity() {
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", "settings"]
    app.launch()
    XCTAssertTrue(app.staticTexts["连接"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["本地数据"].exists)
    XCTAssertTrue(app.staticTexts["安全"].exists)
    XCTAssertTrue(app.buttons["清除本机会话缓存"].exists)
    XCTAssertTrue(app.buttons["清除本机配对"].exists)
  }

  func testHomeManualRefreshShowsShortSuccessFeedback() {
    launchHome(extra: ["-uiRefreshFeedback"])
    XCTAssertTrue(app.buttons["刷新会话"].waitForExistence(timeout: 5))
    app.buttons["刷新会话"].tap()
    XCTAssertTrue(app.staticTexts["刷新成功"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["已连接 · 主机可达"].exists)
    capture("home-manual-refresh-success")
    let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["刷新成功"])
    XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 5), .completed)
  }

  func testHomeRefreshFailureKeepsCacheActionableAndTechnicalDetailsCollapsed() {
    launchHome(extra: ["-uiMockRefreshFailure"])
    XCTAssertTrue(app.staticTexts["会话列表刷新失败"].waitForExistence(timeout: 5))
    // The failure already carries freshness; do not stack another status line.
    XCTAssertFalse(app.staticTexts["尚未核对 · 下拉刷新"].exists)
    XCTAssertEqual(app.staticTexts.matching(identifier: "会话列表刷新失败").count, 1)
    XCTAssertTrue(app.staticTexts["上次：运行中"].exists)
    XCTAssertTrue(app.buttons["重试"].exists)
    app.buttons["详情"].tap()
    XCTAssertTrue(app.staticTexts["技术详情"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["fixture transport failure"].exists)
    app.buttons["技术详情"].tap()
    XCTAssertTrue(app.staticTexts["fixture transport failure"].waitForExistence(timeout: 5))
    capture("home-refresh-failure-details")
  }

  func testRefreshDetailsSurviveBackgroundRecoveryWithoutChangingRequestMetadata() {
    launchHome(extra: ["-uiMockRefreshFailure", "-uiResolveRefreshDetails"])
    XCTAssertTrue(app.buttons["详情"].waitForExistence(timeout: 5))
    let timestamp = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "上次完整刷新：")).firstMatch.label
    XCTAssertFalse(timestamp.isEmpty)
    app.buttons["详情"].tap()
    // The identifier changes only after the real fixture refresh commits a new
    // full-refresh timestamp. Do not use a sleep to race the disappearing body.
    let updatedDone = app.buttons.matching(identifier: "catalog-refresh-details-updated")
      .matching(NSPredicate(format: "label == %@", "完成")).firstMatch
    XCTAssertTrue(updatedDone.waitForExistence(timeout: 5))
    XCTAssertTrue(updatedDone.isHittable)
    XCTAssertTrue(app.staticTexts[timestamp].exists)
    XCTAssertFalse(app.staticTexts["fixture transport failure"].exists)
    app.buttons["技术详情"].tap()
    XCTAssertTrue(app.staticTexts["fixture transport failure"].waitForExistence(timeout: 5))
    capture("home-details-after-background-recovery")
    app.buttons["完成"].tap()
    XCTAssertTrue(app.buttons["新任务"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["会话列表刷新失败"].exists)
    XCTAssertFalse(app.staticTexts["刷新成功"].exists)
  }

  func testHomeFirstFailureHasOneActionableStateAndNoRawError() {
    launchHome(extra: ["-uiMockFirstRefreshFailure"])
    XCTAssertTrue(app.staticTexts["会话列表刷新失败"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts.matching(identifier: "会话列表刷新失败").count, 1)
    XCTAssertTrue(app.buttons["重试"].exists)
    XCTAssertTrue(app.buttons["详情"].exists)
    XCTAssertFalse(app.staticTexts["fixture transport failure"].exists)
    XCTAssertFalse(app.staticTexts["无法读取会话"].exists)
  }

  func testHomePartialRefreshFailureIsDistinct() {
    launchHome(extra: ["-uiMockPartialRefreshFailure"])
    XCTAssertTrue(app.staticTexts["列表未完整更新"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["会话列表刷新失败"].exists)
    capture("home-partial-refresh-failure")
  }

  func testOpeningSearchResultWithKeyboardVisibleStaysResponsive() {
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", "home"]
    app.launch()
    let search = app.textFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 10))
    search.tap()
    search.typeText("重构")
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "重构远程会话列表")).firstMatch.tap()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 10))
    app.buttons["项目文件与 Diff"].tap()
    XCTAssertTrue(app.buttons["完成"].waitForExistence(timeout: 10))
    capture("search-keyboard-navigation-responsive")
  }

  func testSettingsDoesNotOfferANoopPermissionButton() {
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", "settings"]
    app.launch()
    XCTAssertTrue(app.buttons["重新配对, 替换此设备的远程授权"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "默认权限")).firstMatch.exists)
    capture("settings-no-dead-permission-entry")
  }

  func testRepeatedPromptDoesNotHideDetachedOutput() {
    launch("transcript", extra: ["-uiMockDetachedRepeatedPrompt"])
    XCTAssertTrue(app.staticTexts["旧轮回答"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["新轮实时输出"].exists)
    capture("detached-repeated-prompt-keeps-live-output")
  }

  func testRecoveredChatKeepsReconciledEarlierTurns() {
    launch("chat", extra: ["-uiMockReconciledChat"])
    XCTAssertTrue(app.staticTexts["恢复前的问题"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts.matching(identifier: "恢复前的回答").count, 1)
    XCTAssertTrue(app.staticTexts["下一轮回答"].exists)
    capture("recovered-chat-keeps-previous-turn")
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
    // Design A: the run state is one strip above the composer, not a button row.
    let strip = app.descendants(matching: .any)["session-runtime-status"]
    XCTAssertTrue(strip.waitForExistence(timeout: 10))
    XCTAssertTrue(strip.staticTexts["运行中"].exists)
    app.buttons["项目文件与 Diff"].tap()
    XCTAssertTrue(app.buttons["README.md"].waitForExistence(timeout: 10))
    app.buttons["README.md"].tap()
    XCTAssertTrue(app.staticTexts["# Project fixture"].waitForExistence(timeout: 10))
    XCTAssertLessThan(app.staticTexts["# Project fixture"].frame.minY, app.navigationBars.firstMatch.frame.maxY + 40)
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
    XCTAssertTrue(app.descendants(matching: .any)["session-runtime-status"].staticTexts["未连接 Mac，暂时无法发送"].exists)
    capture("offline-chat")
  }

  // Design A: a run reads the same whether this phone or the Mac started it,
  // and the state lives in one strip, not in the turn or the composer.
  func testRunStatusIsTheSameForPhoneAndMacRuns() {
    for origin in ["-uiMockRunning", "-uiMockMacRun"] {
      launch("transcript", extra: [origin])
      let strip = app.descendants(matching: .any)["session-runtime-status"]
      XCTAssertTrue(strip.waitForExistence(timeout: 10), origin)
      XCTAssertTrue(strip.staticTexts["运行中"].exists, origin)
      XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "session-runtime-status").count, 1, origin)
      XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Mac 上正在")).firstMatch.exists, origin)
      // Stop still needs a second confirmation, with one wording for both.
      app.buttons["session-status-action"].tap()
      XCTAssertTrue(app.staticTexts["停止这次运行？"].waitForExistence(timeout: 5), origin)
      capture("stop-confirm\(origin)")
      app.terminate()
    }
  }

  func testFailedStopStillOffersConfirmationBackedRetry() {
    for origin in ["-uiMockRunning", "-uiMockMacRun"] {
      launch("transcript", extra: [origin, "-uiMockStopFailure"])
      XCTAssertTrue(app.staticTexts["停止请求结果未知，可再次点击停止"].waitForExistence(timeout: 5))
      app.buttons["session-status-action"].tap()
      XCTAssertTrue(app.staticTexts["停止这次运行？"].waitForExistence(timeout: 5))
      app.terminate()
    }
  }

  func testTurnDetailsDoNotInventMissingUsage() {
    launch("transcript", extra: ["-uiMockFailed"])
    app.staticTexts["有办法不会收吗 不然每次回来看代码都要重新等待 jdtls 加载"].press(forDuration: 1)
    XCTAssertTrue(app.staticTexts["用量 · Mac 未提供"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["复制"].exists)
    capture("turn-details")
  }

  func testQuestionStripReopensTheSheet() {
    launch("transcript", extra: ["-uiMockRunning", "-uiMockQuestion"])
    let sheetTitle = app.staticTexts["需要你的决定"]
    XCTAssertTrue(sheetTitle.waitForExistence(timeout: 10))
    app.swipeDown(velocity: .fast)
    let strip = app.descendants(matching: .any)["session-runtime-status"]
    XCTAssertTrue(strip.waitForExistence(timeout: 5))
    XCTAssertTrue(strip.staticTexts["需要你决定"].exists)
    // The global question banner stays hidden while this strip shows the question.
    XCTAssertFalse(app.buttons["任务正在等待你的决定 · 查看"].exists)
    capture("question-strip")
    app.buttons["session-status-action"].tap()
    XCTAssertTrue(sheetTitle.waitForExistence(timeout: 5))
  }

  func testFailedTurnKeepsItsOutcomeInTheTurn() {
    launch("transcript", extra: ["-uiMockFailed"])
    let outcome = app.descendants(matching: .any)["turn-outcome"]
    XCTAssertTrue(outcome.waitForExistence(timeout: 10))
    XCTAssertTrue(outcome.staticTexts["运行失败"].exists)
    capture("failed-turn")
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

  func testReadingOlderMessagesStaysPutWhenReasoningExpands() {
    launch("transcript")
    let scroll = app.scrollViews["conversation-scroll"]
    let marker = app.staticTexts["请检查 iOS 远程首页的信息层级，并给出可以直接落地的修改。"]
    for _ in 0..<6 {
      if marker.isHittable && app.buttons["回到最新"].exists { break }
      scroll.swipeDown()
    }
    XCTAssertTrue(marker.isHittable)
    XCTAssertTrue(app.buttons["回到最新"].exists)
    let before = marker.frame.minY
    let reasoning = app.buttons["reasoning-toggle"].firstMatch
    reasoning.tap()
    XCTAssertEqual(reasoning.value as? String, "已展开")
    XCTAssertEqual(marker.frame.minY, before, accuracy: 2, "展开旧回复不能被底部锚点拉回最新消息")
    XCTAssertTrue(app.buttons["回到最新"].exists)
    capture("older-reading-position-after-expansion")
  }

  func testOpeningAndSendingFromOlderMessagesGoToLatest() {
    for route in ["chat", "transcript"] {
      launch(route, extra: route == "chat" ? ["-uiMockLongOutput"] : ["-uiMockFirstScreen"])
      let tail = app.staticTexts[route == "chat" ? "实时回复末尾" : "完整内容末尾"]
      let tailVisible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in tail.exists && tail.isHittable }, object: tail)
      XCTAssertEqual(XCTWaiter.wait(for: [tailVisible], timeout: 15), .completed,
                     "进入会话后应直接看到末尾，包括异步解析的长 Markdown")
      let scroll = app.scrollViews["conversation-scroll"]
      scroll.swipeDown()
      XCTAssertTrue(app.buttons["回到最新"].waitForExistence(timeout: 5))
      let input = app.descendants(matching: .any)["message-input"]
      input.tap()
      input.typeText("滚动定位回归")
      app.buttons["发送"].tap()
      let reply = app.staticTexts["这是 DEBUG 视觉预览回复；没有连接 Provider，也没有写入真实 ledger。"]
      let replyVisible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in reply.exists && reply.isHittable }, object: reply)
      XCTAssertEqual(XCTWaiter.wait(for: [replyVisible], timeout: 5), .completed,
                     "从旧消息处发送，也必须恢复跟随最新消息")
      XCTAssertFalse(app.buttons["回到最新"].exists)
      capture("\(route)-send-returns-to-latest")
    }
  }

  func testHistoryUpdatesWhenMacStartsAfterOpeningInactiveSession() {
    launch("transcript", extra: ["-uiMockContinuousHistory", "-uiMockMacStartsLater"])
    XCTAssertTrue(app.staticTexts["Mac 后来新增的用户输入"].waitForExistence(timeout: 8))
    let reply = app.staticTexts["Mac 后来新增的回复"]
    let replyVisible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in reply.exists && reply.isHittable }, object: reply)
    XCTAssertEqual(XCTWaiter.wait(for: [replyVisible], timeout: 5), .completed)
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
