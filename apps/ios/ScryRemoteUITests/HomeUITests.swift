import XCTest

// Real-device, isolated -uiPreview fixtures; no relay or Provider execution.
final class HomeUITests: XCTestCase {
  private var app: XCUIApplication!
  override func setUp() {
    super.setUp()
    continueAfterFailure = false
    app = XCUIApplication()
  }
  private func launchHome(extra: [String] = []) {
    // The list is a collapsed drawer now, so the home-entry fixtures open it.
    // While it is open the page behind it is hidden from accessibility, so a
    // fixture cannot also assert the composer here; collapse it first.
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", "home", "-drawerOpen"] + extra
    app.launch()
    XCTAssertTrue(app.textFields["home-search"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["sidebar-close"].exists)
    XCTAssertFalse(app.buttons["打开会话列表"].exists)
  }
  private func closeDrawer() { app.buttons["sidebar-close"].tap() }
  private func openDrawer() { app.buttons["sidebar-toggle"].tap() }
  private func tab(_ name: String) { app.buttons["home-tab-\(name)"].tap() }
  private func row(_ title: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
  }
  private func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  // L1b: launch is a new session with a collapsed drawer; the drawer's
  // new-session entry focuses the composer without discarding what was typed.
  // While the drawer is up it is the only touchable surface.
  func testLaunchShowsNewSessionWithCollapsedDrawerAndFocusesComposer() {
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", "home"]
    app.launch()
    let input = app.descendants(matching: .any)["message-input"].firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertFalse(app.textFields["home-search"].exists)
    input.tap(); input.typeText("keep this draft")
    app.buttons["收起键盘"].tap()
    openDrawer()
    XCTAssertTrue(app.textFields["home-search"].waitForExistence(timeout: 5))
    // The drawer is the only surface the user can touch; the page behind it is
    // accessibility-hidden, so this must not be reachable while it is up.
    XCTAssertFalse(input.isHittable)
    app.buttons["drawer-new-session"].tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    XCTAssertFalse(app.textFields["home-search"].exists)
    XCTAssertTrue(input.isHittable)
    XCTAssertEqual(input.value as? String, "keep this draft")
    capture("launch-new-session-focused")
  }

  func testUnpairedConnectActionIsVisibleWithoutScrollingPastTools() {
    app.launchArguments = ["-uiPreview", "-route", "home", "-drawerOpen"]
    app.launch()
    let connect = app.buttons["连接 Mac"].firstMatch
    XCTAssertTrue(connect.waitForExistence(timeout: 10))
    XCTAssertTrue(connect.isHittable)
    connect.tap()
    XCTAssertTrue(app.buttons["扫描配对码"].waitForExistence(timeout: 5))
  }

  func testTabsSearchBothSurfacesWithoutSwitchingAndRememberChoice() {
    launchHome(extra: ["-uiMockMacRun"])
    tab("activity")
    XCTAssertTrue(row("重构远程会话列表").exists)
    XCTAssertFalse(app.staticTexts["已完成"].exists)
    let search = app.textFields["home-search"]
    search.tap(); search.typeText("支付")
    XCTAssertTrue(app.buttons["home-tab-activity"].isSelected)
    XCTAssertFalse(row("重构远程会话列表").exists)
    XCTAssertTrue(app.staticTexts["暂无需要回复或进行中的任务，其他会话在「项目」里"].exists)
    tab("projects")
    XCTAssertTrue(row("排查支付页").exists)
    XCTAssertFalse(row("重构远程会话列表").exists)
    app.buttons["清除搜索"].tap()
    XCTAssertTrue(row("重构远程会话列表").exists)
    app.buttons["设置"].firstMatch.tap()
    app.buttons["返回"].firstMatch.tap()
    // Settings returns to the new-session page with the drawer collapsed by design.
    openDrawer()
    XCTAssertTrue(app.buttons["home-tab-projects"].isSelected)
  }

  func testProjectsExpandScopeAndOpenSession() {
    launchHome()
    tab("projects")
    let project = app.buttons["home-project-scry"]
    XCTAssertTrue(project.waitForExistence(timeout: 5))
    XCTAssertEqual(project.value as? String, "已收起")
    project.tap()
    XCTAssertEqual(project.value as? String, "已展开")
    let session = row("完成 iOS 工作目录选择器")
    XCTAssertTrue(session.exists)
    XCTAssertTrue(session.label.contains("Codex"))
    session.tap()
    XCTAssertTrue(app.buttons["session-overview"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].exists)
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "更多选项")).firstMatch.tap()
    XCTAssertTrue(app.buttons["项目文件与 Diff"].waitForExistence(timeout: 5))
  }

  func testActivityOpensLiveSessionWithoutInventingCompletedSection() {
    launchHome(extra: ["-uiMockMacRun"])
    tab("activity")
    XCTAssertTrue(app.staticTexts["进行中"].exists)
    XCTAssertFalse(app.staticTexts["已完成"].exists)
    row("重构远程会话列表").tap()
    XCTAssertTrue(app.buttons["session-overview"].waitForExistence(timeout: 10))
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "更多选项")).firstMatch.tap()
    XCTAssertTrue(app.buttons["项目文件与 Diff"].waitForExistence(timeout: 5))
  }

  // L1b: the same-scope new-session entry keeps the composer context and the
  // draft; only the project changes. (L1 cleared both, which lost user input.)
  func testNewTaskInProjectKeepsSelectedProjectAndDraft() {
    launchHome()
    tab("projects")
    // The composer sits on the new-session page, behind the collapsed drawer.
    closeDrawer()
    let input = app.descendants(matching: .any)["message-input"].firstMatch
    input.tap(); input.typeText("temporary draft")
    app.buttons["收起键盘"].tap()
    openDrawer()
    tab("projects")
    let newTask = app.buttons["在 scry 中新建任务"]
    XCTAssertTrue(newTask.waitForExistence(timeout: 5))
    newTask.tap()
    XCTAssertTrue((input.value as? String ?? "").contains("temporary draft"))
    XCTAssertTrue(app.buttons["scry"].exists)
  }

  func testProjectsToolsRemainAvailable() {
    launchHome()
    tab("projects")
    for title in ["用量分析", "LLM 性能", "MCP 信任"] {
      for _ in 0..<3 where !row(title).isHittable { app.swipeUp() }
      XCTAssertTrue(row(title).isHittable)
    }
  }

  func testHomeManualRefreshShowsShortSuccessFeedback() {
    launchHome(extra: ["-uiRefreshFeedback"])
    XCTAssertFalse(app.buttons["刷新会话"].exists)
    app.scrollViews.firstMatch.swipeDown()
    XCTAssertTrue(app.staticTexts["刷新成功"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["已连接 · 主机可达"].exists)
    capture("home-manual-refresh-success")
    let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["刷新成功"])
    XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 5), .completed)
  }

  func testHomeRefreshFailureKeepsCacheActionableAndTechnicalDetailsCollapsed() {
    launchHome(extra: ["-uiMockRefreshFailure"])
    XCTAssertTrue(app.staticTexts["Mac1 · 会话列表刷新失败"].waitForExistence(timeout: 5))
    // The failure already carries freshness; do not stack another status line.
    XCTAssertFalse(app.staticTexts["尚未核对 · 下拉刷新"].exists)
    XCTAssertEqual(app.staticTexts.matching(identifier: "Mac1 · 会话列表刷新失败").count, 1)
    tab("projects")
    app.buttons["home-project-scry"].tap()
    // This catalog fixture has no isActive evidence; do not invent a historical state.
    XCTAssertFalse(app.staticTexts["上次：运行中"].exists)
    XCTAssertTrue(app.buttons["重试"].exists)
    app.buttons["详情"].tap()
    XCTAssertTrue(app.staticTexts["技术详情"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "fixture transport failure")).firstMatch.exists)
    app.buttons["技术详情"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "fixture transport failure")).firstMatch.waitForExistence(timeout: 5))
    capture("home-refresh-failure-details")
  }

  func testRefreshDetailsSurviveBackgroundRecoveryWithoutChangingRequestMetadata() {
    launchHome(extra: ["-uiMockRefreshFailure", "-uiResolveRefreshDetails"])
    XCTAssertTrue(app.buttons["详情"].waitForExistence(timeout: 5))
    let timestamp = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "上次完整刷新：")).firstMatch.label
    XCTAssertFalse(timestamp.isEmpty)
    app.buttons["详情"].tap()
    // The identifier changes only after the real fixture refresh commits a new
    // full-refresh timestamp. Do not use a sleep to race the disappearing body.
    let updatedDone = app.buttons.matching(identifier: "catalog-refresh-details-updated")
      .matching(NSPredicate(format: "label == %@", "完成")).firstMatch
    XCTAssertTrue(updatedDone.waitForExistence(timeout: 5))
    XCTAssertTrue(updatedDone.isHittable)
    XCTAssertTrue(app.staticTexts[timestamp].exists)
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "fixture transport failure")).firstMatch.exists)
    app.buttons["技术详情"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "fixture transport failure")).firstMatch.waitForExistence(timeout: 5))
    capture("home-details-after-background-recovery")
    app.buttons["完成"].tap()
    XCTAssertTrue(app.buttons["home-tab-projects"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Mac1 · 会话列表刷新失败"].exists)
    XCTAssertFalse(app.staticTexts["刷新成功"].exists)
  }

  func testHomeFirstFailureHasOneActionableStateAndNoRawError() {
    launchHome(extra: ["-uiMockFirstRefreshFailure"])
    XCTAssertTrue(app.staticTexts["Mac1 · 会话列表刷新失败"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts.matching(identifier: "Mac1 · 会话列表刷新失败").count, 1)
    XCTAssertTrue(app.buttons["重试"].exists)
    XCTAssertTrue(app.buttons["详情"].exists)
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "fixture transport failure")).firstMatch.exists)
    XCTAssertFalse(app.staticTexts["无法读取会话"].exists)
  }

  func testHomePartialRefreshFailureIsDistinct() {
    launchHome(extra: ["-uiMockPartialRefreshFailure"])
    XCTAssertTrue(app.staticTexts["Mac1 · 列表未完整更新"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Mac1 · 会话列表刷新失败"].exists)
    capture("home-partial-refresh-failure")
  }

  func testOpeningSearchResultWithKeyboardVisibleStaysResponsive() {
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", "home", "-drawerOpen"]
    app.launch()
    XCTAssertTrue(app.buttons["home-tab-projects"].waitForExistence(timeout: 10))
    tab("projects")
    let search = app.textFields["home-search"]
    search.tap()
    search.typeText("重构")
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "重构远程会话列表")).firstMatch.tap()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 10))
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "更多选项")).firstMatch.tap()
    app.buttons["项目文件与 Diff"].tap()
    XCTAssertTrue(app.buttons["完成"].waitForExistence(timeout: 10))
    capture("search-keyboard-navigation-responsive")
  }

}

// Sheet flows share the same isolated app fixture as the home entry points.
final class SheetUITests: XCTestCase {
  private var app: XCUIApplication!
  override func setUp() {
    super.setUp()
    continueAfterFailure = false
    app = XCUIApplication()
  }
  private func question(_ mode: String) {
    app.launchArguments = ["-uiPreview", "-uiSheetFixture", mode]
    app.launch()
    XCTAssertTrue(app.buttons["question-submit"].waitForExistence(timeout: 10))
  }
  private func option(_ label: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
  }
  private func launch(_ route: String, extra: [String] = []) {
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", route] + extra
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 10))
  }
  private func openModel() {
    app.buttons["model-effort-control"].tap()
    XCTAssertTrue(app.staticTexts["用于下一轮"].waitForExistence(timeout: 5))
  }

  func testSingleQuestionCollectsOnlyTheSelectedLabel() {
    question("single")
    XCTAssertFalse(app.buttons["question-submit"].isEnabled)
    option("补充测试").tap()
    XCTAssertTrue(option("补充测试").isSelected)
    XCTAssertTrue(app.buttons["question-submit"].isEnabled)
    XCTAssertGreaterThanOrEqual(app.buttons["question-submit"].frame.height, 48)
    XCTAssertEqual(app.textViews.count, 0)
    app.buttons["question-submit"].tap()
    XCTAssertTrue(app.staticTexts["fixture-result"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["fixture-result"].label, "{\"这次改动需要包含哪些工作？\":\"补充测试\"}")
    XCTAssertEqual(app.staticTexts["fixture-counts"].label, "回答：1 · 取消：0")
  }

  func testMultipleQuestionPreservesOptionOrderAndDeselection() {
    question("multi")
    option("检查兼容性").tap()
    option("补充测试").tap()
    option("更新文档").tap()
    option("更新文档").tap()
    XCTAssertTrue(option("检查兼容性").isSelected)
    XCTAssertFalse(option("更新文档").isSelected)
    app.buttons["question-submit"].tap()
    XCTAssertTrue(app.staticTexts["fixture-result"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["fixture-result"].label, "{\"这次改动需要包含哪些工作？\":\"补充测试, 检查兼容性\"}")
  }

  func testTextQuestionKeepsWhitespaceValidationAndActualText() {
    question("text")
    let input = app.textViews["question-input-0"]
    XCTAssertTrue(input.exists)
    input.tap(); input.typeText(" \n ")
    XCTAssertFalse(app.buttons["question-submit"].isEnabled)
    input.typeText("保留现有行为")
    XCTAssertTrue(app.buttons["question-submit"].isEnabled)
    app.buttons["question-submit"].tap()
    XCTAssertTrue(app.staticTexts["fixture-result"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["fixture-result"].label.contains("保留现有行为"))
    XCTAssertEqual(app.staticTexts["fixture-counts"].label, "回答：1 · 取消：0")
  }

  func testCloseOnlyFoldsWhileCancelInvokesTheCancelCallback() {
    question("single")
    app.buttons["sheet-close"].tap()
    XCTAssertTrue(app.staticTexts["fixture-counts"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["fixture-counts"].label, "回答：0 · 取消：0")
    app.buttons["fixture-reopen"].tap()
    app.buttons["question-cancel"].tap()
    XCTAssertTrue(app.staticTexts["fixture-counts"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["fixture-counts"].label, "回答：0 · 取消：1")
  }

  func testPermissionHasNoExtraFreeTextAndSubmitsTheRealChoice() {
    question("permission")
    XCTAssertTrue(app.staticTexts["Provider 请求授权"].exists)
    XCTAssertEqual(app.textViews.count, 0)
    XCTAssertEqual(app.textFields.count, 0)
    option("允许这次").tap()
    app.buttons["question-submit"].tap()
    XCTAssertTrue(app.staticTexts["fixture-result"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["fixture-result"].label, "{\"允许在当前工作区执行本地检查吗？\":\"允许这次\"}")
  }

  func testSubmittingDisablesBothActionsButCanStillFold() {
    question("submitting")
    XCTAssertEqual(app.buttons["question-submit"].label, "提交中…")
    XCTAssertFalse(app.buttons["question-submit"].isEnabled)
    XCTAssertFalse(app.buttons["question-cancel"].isEnabled)
    app.buttons["sheet-close"].tap()
    XCTAssertTrue(app.staticTexts["fixture-counts"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["fixture-counts"].label, "回答：0 · 取消：0")
  }

  func testBothConversationRoutesOpenOverviewAndTheExistingFiles() {
    for route in ["chat", "transcript"] {
      launch(route, extra: ["-uiWorkspaceFixture"])
      app.buttons["session-overview"].tap()
      XCTAssertTrue(app.staticTexts["总览"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.staticTexts["上下文占用与累计用量：Mac 未提供"].exists)
      XCTAssertFalse(app.staticTexts["累计 Token"].exists)
      XCTAssertFalse(app.staticTexts["会话时长"].exists)
      app.buttons["overview-files"].tap()
      XCTAssertTrue(app.buttons["README.md"].waitForExistence(timeout: 10))
      app.buttons["README.md"].tap()
      let source = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "# Project fixture")).firstMatch
      XCTAssertTrue(source.waitForExistence(timeout: 5))
      XCTAssertTrue(source.label.contains("Read-only preview"))
    }
  }

  func testOverviewCopiesTheActualSessionIDToTheSystemClipboard() {
    launch("chat")
    app.buttons["session-overview"].tap()
    let id = app.staticTexts["overview-session-id"]
    XCTAssertTrue(id.waitForExistence(timeout: 5))
    let expected = id.label
    XCTAssertNotEqual(expected, "未建立会话")
    app.buttons["overview-copy-id"].tap()
    XCTAssertEqual(app.buttons["overview-copy-id"].label, "已复制")
    app.buttons["sheet-close"].tap()
    let input = app.descendants(matching: .any)["message-input"].firstMatch
    input.tap(); input.press(forDuration: 1)
    let paste = app.descendants(matching: .any).matching(NSPredicate(
      format: "(elementType == %d OR elementType == %d) AND (label == %@ OR label == %@)",
      XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.menuItem.rawValue, "Paste", "粘贴")).firstMatch
    XCTAssertTrue(paste.waitForExistence(timeout: 5))
    paste.tap()
    XCTAssertEqual(input.value as? String, expected)
    input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: expected.count))
  }

  func testPopoverSelectsModelEffortAndAutomaticWithoutReplacingTheDraft() {
    launch("chat")
    let input = app.descendants(matching: .any)["message-input"].firstMatch
    input.tap(); input.typeText("Keep the draft")
    app.buttons["收起键盘"].tap()
    openModel()
    let model = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "model-option-", "GPT-5.6")).firstMatch
    XCTAssertTrue(model.waitForExistence(timeout: 5))
    model.tap()
    XCTAssertTrue(model.isSelected)
    let high = app.buttons["effort-option-high"]
    XCTAssertGreaterThanOrEqual(high.frame.width, 44)
    XCTAssertGreaterThanOrEqual(high.frame.height, 44)
    high.tap()
    XCTAssertTrue(high.isSelected)
    app.buttons["model-option-auto"].tap()
    XCTAssertTrue(app.buttons["model-option-auto"].isSelected)
    app.otherElements["PopoverDismissRegion"].tap()
    XCTAssertTrue((input.value as? String)?.contains("Keep the draft") == true)
  }

  func testManyEffortsUseAScrollableListAndPassTheOriginalID() {
    app.launchArguments = ["-uiPreview", "-uiSheetFixture", "effortsMany"]
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 10))
    openModel()
    XCTAssertFalse(app.otherElements["effort-segments"].exists)
    let list = app.descendants(matching: .any)["effort-list"].firstMatch
    XCTAssertTrue(list.exists)
    list.swipeUp()
    let last = app.buttons["effort-option-最大"]
    XCTAssertTrue(last.isHittable)
    XCTAssertGreaterThanOrEqual(last.frame.height, 44)
    last.tap()
    XCTAssertTrue(last.isSelected)
    // The tall popover covers the dismissal region's center; use its exposed top-left area.
    app.otherElements["PopoverDismissRegion"].coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.2)).tap()
    XCTAssertEqual(app.staticTexts["fixture-effort"].label, "最大")
  }

  func testProviderWithoutEffortsDoesNotInventASegment() {
    launch("home", extra: ["-uiRefreshFeedback"])
    option("Agent：").tap()
    option("Qoder").tap()
    openModel()
    XCTAssertTrue(option("Ultimate").exists)
    XCTAssertFalse(app.staticTexts["推理强度"].exists)
    XCTAssertFalse(app.buttons["effort-option-default"].exists)
  }
}
