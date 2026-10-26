#if DEBUG
import SwiftUI
import RemoteTransport

// Isolated UI fixture: the production sheet and its real answer collector are
// exercised without sending an answer/cancellation to a paired host.
struct SheetPreview: View {
  enum Mode: String { case single, multi, text, permission, submitting, error, effortsMany, historyCapacity, historyRetry }
  static var requestedMode: Mode? {
    let arguments = ProcessInfo.processInfo.arguments
    guard arguments.contains("-uiPreview"), let index = arguments.firstIndex(of: "-uiSheetFixture"),
          arguments.indices.contains(index + 1) else { return nil }
    return Mode(rawValue: arguments[index + 1])
  }

  let mode: Mode
  @State private var presented = true
  @State private var answersSent = 0
  @State private var cancellations = 0
  @State private var result = Copy.ready

  var body: some View {
    if mode == .effortsMany { ModelEffortPreview() }
    else if mode == .historyCapacity || mode == .historyRetry {
      VStack(spacing: 24) {
        Text(Copy.historyTitle).font(Typography.sheetTitle)
        HistoryRetryButton(title: mode == .historyCapacity ? ConversationCopy.loadHistory : ConversationCopy.retryHistory, action: {})
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .foregroundStyle(Palette.fg).background(Palette.main)
    } else { questionBody }
  }

  private var questionBody: some View {
    VStack(spacing: 20) {
      Text(Copy.title).font(Typography.sheetTitle)
      Text(Copy.counts(answers: answersSent, cancellations: cancellations))
        .accessibilityIdentifier("fixture-counts")
      Text(result).accessibilityIdentifier("fixture-result")
      Button(Copy.reopen) { presented = true }.accessibilityIdentifier("fixture-reopen")
    }
    .font(Typography.reply).padding(16).frame(maxWidth: .infinity, maxHeight: .infinity)
    .foregroundStyle(Palette.fg).background(Palette.main)
    .sheet(isPresented: $presented) {
      RemoteQuestionSheet(request: request, subtitle: SheetCopy.context(title: Copy.session, provider: "Codex"),
        submitting: mode == .submitting, error: mode == .error ? Copy.error : nil,
        onAnswer: { answers in
          let encoder = JSONEncoder()
          encoder.outputFormatting = [.sortedKeys]
          result = String(data: try! encoder.encode(answers), encoding: .utf8)!
          answersSent += 1
          presented = false
        }, onCancel: {
          cancellations += 1
          result = Copy.cancelled
          presented = false
        })
    }
  }

  private var request: G0Transport.RunQuestionRequest {
    let question: String
    switch mode {
    case .text:
      question = #"{"header":"处理边界","question":"请说明这次改动需要保留的行为。","options":[],"multiSelect":false,"inputMode":"multiline"}"#
    case .permission:
      question = #"{"header":"执行检查","question":"允许在当前工作区执行本地检查吗？","options":[{"label":"允许这次","description":"只授权这次请求","preview":"npm run test:unit"},{"label":"拒绝","description":"不执行本次检查"}],"multiSelect":false}"#
    default:
      question = """
      {"header":"改动范围","question":"这次改动需要包含哪些工作？","options":[
      {"label":"补充测试","description":"为关键行为留下回归检查","preview":"新增一个 focused 检查"},
      {"label":"更新文档","description":"记录变更与已知限制"},
      {"label":"检查兼容性","description":"确认相邻入口仍然可用"}],"multiSelect":\(mode == .multi ? "true" : "false")}
      """
    }
    let json = """
    {"runId":"r4-fixture","questionId":"r4-question","providerId":"codex",
     "questionKind":"\(mode == .permission ? "permission" : "input")","questions":[\(question)]}
    """
    return try! JSONDecoder().decode(G0Transport.RunQuestionRequest.self, from: Data(json.utf8))
  }

  private enum Copy {
    static let title = "问题 Sheet 检查（Mock）"
    static let historyTitle = "历史按钮外观检查（Mock）"
    static let session = "核对界面改动"
    static let ready = "尚未调用回调"
    static let cancelled = "取消回调已调用"
    static let reopen = "再次打开问题"
    static let error = "提交未确认，请检查连接后重试。"
    static func counts(answers: Int, cancellations: Int) -> String {
      "回答：\(answers) · 取消：\(cancellations)"
    }
  }
}

private struct ModelEffortPreview: View {
  @State private var text = ""
  @State private var attachments: [DraftAttachment] = []
  @State private var model: String?
  @State private var effort: String?
  private static let options = ["最少", "低", "中", "高", "更高", "最大"].map {
    G0Transport.RunControlOption(id: $0, label: $0)
  }
  private enum Copy {
    static let title = "模型控件检查（Mock）"
    static let placeholder = "此预览不发送任务"
    static let model = "目录模型"
    static let description = "主机目录提供的模型说明"
  }
  var body: some View {
    VStack(spacing: 20) {
      Text(Copy.title).font(Typography.sheetTitle)
      Text(effort ?? ConnectionCopy.defaultEffort).accessibilityIdentifier("fixture-effort")
      Spacer()
      MessageComposer(text: $text, attachments: $attachments, placeholder: Copy.placeholder, sendDisabled: true,
        modelOptions: [.init(id: "fixture-model", label: Copy.model, description: Copy.description,
                             isDefault: true, efforts: Self.options)],
        selectedModelId: model, onModel: { model = $0 }, effortOptions: Self.options,
        selectedEffort: effort, onEffort: { effort = $0 }, onSend: {})
    }
    .padding(16).foregroundStyle(Palette.fg).background(Palette.main)
  }
}
#endif
