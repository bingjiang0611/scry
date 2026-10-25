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
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", "home"] + extra
    app.launch()
    XCTAssertTrue(app.textFields["home-search"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["打开会话列表"].exists)
  }
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

  func testUnpairedConnectActionIsVisibleWithoutScrollingPastTools() {
    app.launchArguments = ["-uiPreview", "-route", "home"]
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
    XCTAssertTrue(app.buttons["项目文件与 Diff"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].exists)
  }

  func testActivityOpensLiveSessionWithoutInventingCompletedSection() {
    launchHome(extra: ["-uiMockMacRun"])
    tab("activity")
    XCTAssertTrue(app.staticTexts["进行中"].exists)
    XCTAssertFalse(app.staticTexts["已完成"].exists)
    row("重构远程会话列表").tap()
    XCTAssertTrue(app.buttons["项目文件与 Diff"].waitForExistence(timeout: 10))
  }

  func testNewTaskInProjectKeepsSelectedProjectAndClearsDraft() {
    launchHome()
    tab("projects")
    let input = app.descendants(matching: .any)["message-input"].firstMatch
    input.tap(); input.typeText("temporary draft")
    app.buttons["收起键盘"].tap()
    let newTask = app.buttons["在 scry 中新建任务"]
    XCTAssertTrue(newTask.waitForExistence(timeout: 5))
    newTask.tap()
    XCTAssertFalse((input.value as? String ?? "").contains("temporary draft"))
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
    app.launchArguments = ["-uiPreview", "-connected", "-uiMockData", "-route", "home"]
    app.launch()
    XCTAssertTrue(app.buttons["home-tab-projects"].waitForExistence(timeout: 10))
    tab("projects")
    let search = app.textFields["home-search"]
    search.tap()
    search.typeText("重构")
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "重构远程会话列表")).firstMatch.tap()
    XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 10))
    app.buttons["项目文件与 Diff"].tap()
    XCTAssertTrue(app.buttons["完成"].waitForExistence(timeout: 10))
    capture("search-keyboard-navigation-responsive")
  }

}
