import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  // Visual-only fixtures for `-uiPreview -uiMockData`. They deliberately never
  // touch Keychain, relay, Provider, ledger, or Release execution paths.
  func applyUIPreviewArguments() {
    guard ProcessInfo.processInfo.arguments.contains("-uiPreview"),
          ProcessInfo.processInfo.arguments.contains("-uiMockData") else { return }
    mockMode = true
    reachable = true

    let roots = [
      G0Transport.RunProjectRef(path: "/Users/demo/Projects/scry", label: "scry"),
      G0Transport.RunProjectRef(path: "/Users/demo/Projects/rate-native", label: "rate-native"),
      G0Transport.RunProjectRef(path: "/Users/demo/Work/atlas-web", label: "atlas-web")
    ]
    projects = .loaded(roots)
    chosen = G0Transport.RunProjectRef(path: "/Users/demo/Projects/scry/apps/ios", label: "ios")

    let efforts = [
      G0Transport.RunControlOption(id: "low", label: "低", description: "更快响应", isDefault: true),
      G0Transport.RunControlOption(id: "medium", label: "中", description: "平衡速度与推理"),
      G0Transport.RunControlOption(id: "high", label: "高", description: "更深入推理"),
      G0Transport.RunControlOption(id: "xhigh", label: "极高", description: "复杂任务")
    ]
    let permissions = [
      G0Transport.RunControlOption(id: "default", label: "默认审批", description: "危险操作前询问", isDefault: true),
      G0Transport.RunControlOption(id: "auto_review", label: "自动审查", description: "按策略自动处理"),
      G0Transport.RunControlOption(id: "full_access", label: "完全访问", description: "仅由设备所有者显式选择")
    ]
    let availableProviders = [
      G0Transport.RunProviderRef(id: "codex", label: "Codex", available: true, modelId: "example-model-a",
        models: [G0Transport.RunModelOption(id: "example-model-a", label: "示例模型 A", isDefault: true, efforts: efforts)],
        efforts: efforts, permissions: permissions),
      G0Transport.RunProviderRef(id: "pi", label: "Pi · Rotom", available: true, agentProfileId: "pi:rotom",
        modelId: "example-model-b", models: [
          G0Transport.RunModelOption(id: "example-model-b", providerId: "openai", label: "示例模型 B", isDefault: true, efforts: efforts),
          G0Transport.RunModelOption(id: "example-model-c", providerId: "anthropic", label: "示例模型 C", efforts: efforts)
        ], efforts: efforts, permissions: permissions),
      G0Transport.RunProviderRef(id: "qoder", label: "Qoder", available: true, modelId: "example-model-d",
        models: [G0Transport.RunModelOption(id: "example-model-d", label: "示例模型 D", isDefault: true)], permissions: permissions),
      G0Transport.RunProviderRef(id: "opencode", label: "OpenCode", available: true, modelId: nil,
        models: [], permissions: [permissions[0], permissions[2]])
    ]
    providers = .loaded(availableProviders)
    chooseProvider(availableProviders[0])
    providerControlsLoaded = true
    providerControlsCwd = chosen?.path
    // Fixture for the model popover: a list that overflows its viewport.
    if ProcessInfo.processInfo.arguments.contains("-uiMockManyModels") {
      var overflow: [G0Transport.RunModelOption] = []
      for index in 1...12 {
        overflow.append(G0Transport.RunModelOption(id: "overflow-\(index)", providerId: "openai",
                                                   label: "回归模型 \(index)", description: "用于验证列表可滚动", efforts: efforts))
      }
      let provider = G0Transport.RunProviderRef(id: "codex", label: "Codex", available: true, modelId: overflow[0].id,
                                               models: overflow, efforts: efforts, permissions: permissions)
      providers = .loaded([provider] + availableProviders.dropFirst())
      chooseProvider(provider)
      providerControlsLoaded = true
      providerControlsCwd = chosen?.path
    }

    commands = .loaded([
      .init(name: "review", description: "审查当前改动", argumentHint: "[范围]", source: "builtin"),
      .init(name: "compact", description: "压缩当前会话上下文", source: "builtin"),
      .init(name: "rate-workflow", description: "运行项目工作流", argumentHint: "<任务>", source: "custom")
    ])

    let now = Date().timeIntervalSince1970 * 1_000
    catalog = .loaded([
      G0Transport.RunSessionRef(sessionId: "mock-pinned-1", externalSessionId: "codex-pinned-1", providerId: "codex", cwd: roots[0].path,
        label: "重构远程会话列表并统一信息层级", ts: now - 8 * 60_000, pinnedAt: now - 60_000),
      G0Transport.RunSessionRef(sessionId: "mock-pinned-2", externalSessionId: "qoder-pinned-2", providerId: "qoder", cwd: roots[1].path,
        label: "排查支付页偶发白屏与恢复流程", ts: now - 36 * 60_000, pinnedAt: now - 120_000),
      G0Transport.RunSessionRef(sessionId: "mock-scry-1", externalSessionId: "codex-scry-1", providerId: "codex", cwd: roots[0].path,
        label: "完成 iOS 工作目录选择器和附件发送", ts: now - 2 * 3_600_000, lastRunOutcome: "completed"),
      G0Transport.RunSessionRef(sessionId: "mock-scry-2", externalSessionId: "qoder-scry-2", providerId: "qoder", cwd: roots[0].path,
        label: "修复手机续聊在 Mac 端不可见的问题", ts: now - 5 * 3_600_000, lastRunOutcome: "completed"),
      G0Transport.RunSessionRef(sessionId: "mock-scry-running", providerId: "codex", cwd: roots[0].path,
        label: "正在分析大规模测试失败…", ts: now - 4 * 60_000),
      G0Transport.RunSessionRef(sessionId: "mock-rate-1", externalSessionId: "codex-rate-1", providerId: "codex", cwd: roots[1].path,
        label: "优化首页滚动性能并补充回归测试", ts: now - 24 * 3_600_000, lastRunOutcome: "interrupted"),
      G0Transport.RunSessionRef(sessionId: "mock-atlas-1", externalSessionId: "opencode-atlas-1", providerId: "opencode", cwd: roots[2].path,
        label: "实现登录错误态与离线重试体验", ts: now - 3 * 86_400_000)
    ])
    if ProcessInfo.processInfo.arguments.contains("-uiMockFirstRefreshFailure") {
      catalog = .failed(ConnectionCopy.fixtureTransportFailure)
      catalogEvidence = .none
      catalogRefreshFailure = .transport(ConnectionCopy.fixtureTransportFailure)
    } else if ProcessInfo.processInfo.arguments.contains("-uiMockRefreshFailure") {
      catalogVerifiedAt = Date(timeIntervalSince1970: now / 1_000 - 900)
      catalogEvidence = .unverifiedCache(catalogVerifiedAt)
      catalogRefreshFailure = .transport(ConnectionCopy.fixtureTransportFailure)
    } else if ProcessInfo.processInfo.arguments.contains("-uiMockPartialRefreshFailure") {
      catalogEvidence = .verified(Date(timeIntervalSince1970: now / 1_000 - 900))
      catalogVerifiedAt = Date(timeIntervalSince1970: now / 1_000 - 900)
      catalogRefreshFailure = .partial(ConnectionCopy.fixturePartialFailure)
    } else {
      let verified = Date(timeIntervalSince1970: now / 1_000)
      catalogEvidence = .verified(verified)
      catalogVerifiedAt = verified
    }

    history = .loaded([
      G0Transport.RunHistoryTurn(userText: "请检查 iOS 远程首页的信息层级，并给出可以直接落地的修改。", items: [
        G0Transport.RunHistoryChunk(kind: "reasoning", text: "我会先检查会话分组、状态信息和底部操作区。"),
        G0Transport.RunHistoryChunk(kind: "tool", text: "读取 HomeView.swift"),
        G0Transport.RunHistoryChunk(kind: "tool_result", text: "1  # HomeView.swift\n2  会话列表与项目分组\n3  搜索、新建与运行状态\n4  Provider 元信息\n5  连接状态与时间语境\n6  底部 Composer 控制\n7  无文件修改\n8  共读取 281 行"),
        G0Transport.RunHistoryChunk(kind: "output", text: "发现 **三个主要问题**：项目与会话的视觉层级接近、运行状态缺少时间语境、底部搜索和新建操作抢占了过多空间。建议先压缩标题区，再把 `Provider` 与时间放入会话元信息。")
      ]),
      G0Transport.RunHistoryTurn(userText: "按 Codex Refined 的方向继续，先不要加入底栏。", items: [
        G0Transport.RunHistoryChunk(kind: "output", text: "已保留无底栏结构，并将导航、内容与证据层分开。下一步可以重点比较列表密度和 Composer 的控制层级。")
      ])
    ])

    runId = "mock-run-visual-only"
    prompt = "把首页改成更紧凑的项目分组，同时保留真实运行证据。"
    sentAttachments = [
      SentAttachment(name: "home-reference.png", kind: .image, size: 184_320, imageData: Self.mockImageData()),
      SentAttachment(name: "notes.md", kind: .text, size: 4_812)
    ]
    lifecycle = .settled
    terminalDrainCompleted = true
    output = [
      OutputLine(id: 1, kind: "reasoning", text: "先对齐信息架构，再调整视觉密度。"),
      OutputLine(id: 2, kind: "tool", text: "编辑 HomeView.swift"),
      OutputLine(id: 3, kind: "tool_result", text: "3 个区块已更新 · 0 个错误"),
      OutputLine(id: 4, kind: "output", text: "## 已完成\n\n首页已按 **置顶 + 项目** 重新组织，并保留 [运行证据](https://example.com/evidence)。\n\n- 会话标题成为主信息\n- `Provider`、更新时间和状态降为轻量元信息\n- 底部仅保留搜索与新建入口\n\n```swift\nLazyVStack(spacing: 12) {\n  sessionRows\n}\n```")
    ]
    resultSummary = "输入 18,420 · 输出 1,286 · $0.084"
    liveExternalSessionId = "codex-mock-session"
    loadMockDirectories(path: chosen?.path)
    // The folder sheet must issue the first read itself: without this fixture the
    // mock already holds a listing and the `.idle` path is never exercised.
    if ProcessInfo.processInfo.arguments.contains("-uiMockDirectoriesIdle") { directories = .idle }
    activeSessionIdentity = .opened(providerId: "codex", cwd: roots[0].path, externalSessionId: "codex-pinned-1")
    if ProcessInfo.processInfo.arguments.contains("-uiMockReconciledChat"), let identity = activeSessionIdentity {
      completedLiveTurns[identity] = [.init(id: "old-ledger", runId: "old-ledger", prompt: "恢复前的问题",
        attachments: [], lifecycle: .settled, output: [.init(id: 1, kind: "output", text: "恢复前的回答")],
        resultSummary: nil, externalSessionId: "codex-pinned-1", hostRunId: "old-host-run")]
      history = .loaded([.init(runId: "old-host-run", userText: "恢复前的问题", items: [.init(kind: "output", text: "恢复前的回答")])])
      prompt = "恢复后的下一轮"; output = [.init(id: 1, kind: "output", text: "下一轮回答")]
      sentAttachments = []; resultSummary = nil
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockFirstScreen") {
      let turns = (1...40).map { index in
        G0Transport.RunHistoryTurn(userText: "模拟历史消息 \(index)", items: [
          .init(kind: "output", text: index == 40 ? "# 历史 Markdown 标题\n\n- 列表项目\n\n```swift\nlet answer = 42\n```\n\n" + String(repeating: "长消息保留完整内容，可按需展开。\n\n", count: 600) + "## 完整内容末尾" : "模拟回复 \(index)")])
      }
      history = ProcessInfo.processInfo.arguments.contains("-uiMockPartialHistory") ? .partial(Array(turns.suffix(2))) : .loaded(turns)
      historyFromCache = true; historyFetchedAt = Date()
      prompt = nil; output = []; runId = nil; resultSummary = nil
      if ProcessInfo.processInfo.arguments.contains("-uiMockPartialHistory"), let identity = activeSessionIdentity {
        completedLiveTurns[identity] = [.init(id: "preview-completed", runId: "preview-completed", prompt: "模拟本机已完成续聊",
          attachments: [], lifecycle: .settled, output: [.init(id: 1, kind: "output", text: "模拟续聊结果必须保留")],
          resultSummary: nil, externalSessionId: "codex-pinned-1")]
      }
    }
    // Screenshot fixtures for history failure states; no relay or host grant.
    if ProcessInfo.processInfo.arguments.contains("-uiMockHistoryFailure"), let identity = activeSessionIdentity {
      prompt = nil; output = []; runId = nil; resultSummary = nil
      liveRunsStatus = .observed
      historyRefreshError = "中继连接已关闭（1009 message too big）"
      if ProcessInfo.processInfo.arguments.contains("-uiMockBaseUnavailable") {
        history = .baseUnavailable
        completedLiveTurns[identity] = [.init(id: "preview-completed", runId: "preview-completed", prompt: "什么进度了",
          attachments: [], lifecycle: .settled, output: [.init(id: 1, kind: "output", text: "代码已修复并提交。\n\n- 表格已按行列渲染\n- 编译通过")],
          resultSummary: "输入 815 · 输出 101 · $0.01077", externalSessionId: "codex-pinned-1")]
      } else {
        history = .partial([.init(userText: "ios端输出要支持markdown 这个表格展示有问题 修复", items: [
          .init(kind: "tool", text: "bash"), .init(kind: "tool_result", text: "ok")])])
      }
    }
    // Screenshot fixture for an unacknowledged message (focused and background);
    // nothing is sent because mockMode never starts delivery.
    if ProcessInfo.processInfo.arguments.contains("-uiMockSending"), let identity = activeSessionIdentity {
      let routing = RemoteRunClient.Routing(cwd: roots[0].path, providerId: "codex", agentProfileId: nil,
                                            prompt: "有办法不会收吗 不然每次回来看代码都要重新等待 jdtls 加载")
      let focused = PendingSubmission(intentId: "mock-sending", routing: routing, identity: identity)
      let other = RemoteRunClient.Routing(cwd: roots[1].path, providerId: "pi", agentProfileId: nil, prompt: "整理今天的测试结果")
      outbox = [focused, PendingSubmission(intentId: "mock-background", routing: other,
                                           identity: .new(providerId: "pi", cwd: roots[1].path))]
      pendingSubmission = focused
      prompt = routing.prompt; sentAttachments = []; output = []; runId = nil; resultSummary = nil
      lifecycle = .submitting; terminalDrainCompleted = false
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockContinuousHistory") {
      history = .loaded([
        .init(userText: "最早一轮的用户输入", items: [.init(kind: "output", text: "最早一轮的回复")]),
        .init(userText: "第二轮用户输入", items: [.init(kind: "output", text: "第二轮回复")]),
        .init(userText: "技能和mcp不用检测数量了 点击进入的时候再加载吧 这样可以节省性能", items:
          (1...20).map { .init(kind: "output", text: "本轮第 \($0) 段内容") }),
        .init(userText: String(repeating: "完整用户输入。", count: 90) + "用户输入末尾", items: [
          .init(kind: "output", text: "# 长回复开头\n\n" + String(repeating: "完整回复。", count: 100) +
            "\n\n## 五百字之后的标题\n\n- 列表项目\n\n```swift\nlet answer = 42\n```\n\n## 长回复末尾")
        ])
      ])
      historyFromCache = true; historyFetchedAt = Date()
      prompt = nil; output = []; runId = nil; resultSummary = nil
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockMacStartsLater"), case let .loaded(turns) = history {
      // A full cached base reproduces the production refresh gate, rather than
      // bypassing it with a direct append that would mask a stale-history bug.
      cachedHistory = ("mock-history", .init(turns: turns, fingerprint: "mock-old", fetchedAt: Date()), false)
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockLongOutput") {
      prompt = "检查长回复滚动定位"
      output = [.init(id: 1, kind: "output", text: "## 实时回复开头\n\n" +
        String(repeating: "完整实时回复保留全部内容。\n\n", count: 150) + "## 实时回复末尾")]
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockMarkdownTable") {
      let markdown = """
      ## 性能（日志实测）
      | 问题 | 证据 | 判断 |
      |---|:---:|---:|
      | **文件树扫描太慢** | `reload_tree.bg.scan` 共 141 次，7 万多个文件单次扫描 5–117 秒。 | 文件结构一变，增量更新就退回整树扫描。 |
      | 全文搜索慢 | `search.complete` 最长 32 秒 | 两者争用磁盘 IO |

      表格之后的正文
      """
      if ProcessInfo.processInfo.arguments.contains("-uiMockMarkdownHistory") {
        history = .loaded([.init(userText: "检查性能", items: [.init(kind: "output", text: markdown)])])
        prompt = nil; output = []; runId = nil; resultSummary = nil
      } else {
        prompt = "检查性能"
        output = [.init(id: 1, kind: "output", text: markdown)]
      }
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockLoading") {
      history = .loading; prompt = nil; output = []; runId = nil; resultSummary = nil
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockQuestion") {
      // Explicitly synthetic sheet fixture; it never reaches answerQuestion.
      let fixture = #"{"runId":"fixture-run","questionId":"fixture-question","questionKind":"input","questions":[{"header":"录屏验证 · 模拟请求","question":"输入一段多行说明","options":[],"multiSelect":false,"inputMode":"multiline"}]}"#
      pendingQuestions = [try! JSONDecoder().decode(G0Transport.RunQuestionRequest.self, from: Data(fixture.utf8))]
    }
    // Status-strip fixtures: this device's run in progress or failed, and a run
    // the Mac started in the same session. Nothing is sent; mockMode never delivers.
    if ProcessInfo.processInfo.arguments.contains("-uiMockRunning") || ProcessInfo.processInfo.arguments.contains("-uiMockFailed") {
      let failed = ProcessInfo.processInfo.arguments.contains("-uiMockFailed")
      prompt = "有办法不会收吗 不然每次回来看代码都要重新等待 jdtls 加载"
      sentAttachments = []; resultSummary = nil; runId = "mock-run-visual-only"
      output = [.init(id: 1, kind: "tool", text: "rg -n jdtls ~/.config"),
                .init(id: 2, kind: "output", text: "jdtls 的工作区默认放在临时目录，所以每次都要重新索引。")]
      lifecycle = failed ? .failed : .running
      terminalDrainCompleted = failed
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockMacRun") {
      prompt = nil; output = []; runId = nil; resultSummary = nil; lifecycle = .unknown
      let live = #"{"origin":"mac","runId":"mock-mac-run","providerId":"codex","cwd":"/Users/demo/Projects/scry","externalSessionId":"codex-pinned-1","prompt":"","state":"running","questions":[]}"#
      liveRuns = [try! JSONDecoder().decode(G0Transport.LiveRun.self, from: Data(live.utf8))]
      liveRunsStatus = .observed
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockDetachedRepeatedPrompt") {
      prompt = nil; output = []; runId = nil; resultSummary = nil; lifecycle = .unknown
      history = .loaded([.init(runId: "old-host-run", userText: "continue with previous work", items: [.init(kind: "output", text: "旧轮回答")])])
      let live = #"{"origin":"remote","runId":"new-ledger-run","providerId":"codex","cwd":"/Users/demo/Projects/scry","externalSessionId":"codex-pinned-1","prompt":"continue","state":"running","questions":[]}"#
      liveRuns = [try! JSONDecoder().decode(G0Transport.LiveRun.self, from: Data(live.utf8))]
      liveRunsStatus = .observed
      detachedRunId = "new-ledger-run"; detachedHostRunId = "new-host-run"
      detachedOutput = [.init(id: 1, kind: "output", text: "新轮实时输出")]
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockStopFailure") {
      if ProcessInfo.processInfo.arguments.contains("-uiMockMacRun") {
        liveActionError = "停止请求结果未知，可再次点击停止"
      } else { stopError = "停止请求结果未知，可再次点击停止" }
    }
  }
}
#endif
