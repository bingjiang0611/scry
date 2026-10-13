import SwiftUI
import WebKit
import RemoteTransport

// This page never writes files or stages/reverts changes. Every read retains
// device-grant + canonical-project authorization on the Mac.
struct WorkspaceBrowserView: View {
  let cwd: String
  @Environment(\.dismiss) private var dismiss
  @State private var showDiff = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 12) {
        Text(cwd).font(.caption).foregroundStyle(Palette.muted).lineLimit(2).textSelection(.enabled)
        Picker("项目内容", selection: $showDiff) {
          Text("文件").tag(false)
          Text("未提交 Diff").tag(true)
        }.pickerStyle(.segmented)
        if showDiff { WorkspaceContentView(cwd: cwd, path: nil) }
        else { WorkspaceDirectoryView(cwd: cwd, path: "") }
      }
      .padding(.horizontal, 16)
      .navigationTitle("项目文件").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
    }
  }
}

private struct WorkspaceDirectoryView: View {
  let cwd: String
  let path: String
  @State private var page: G0Transport.WorkspaceListing?
  @State private var cursors: [String?] = [nil]
  @State private var revision = 0
  @State private var error: String?

  var body: some View {
    VStack(spacing: 12) {
      if let page {
        List {
          if page.entries.isEmpty { Text("此目录为空").foregroundStyle(Palette.muted) }
          ForEach(page.entries) { entry in
            NavigationLink {
              if entry.kind == .directory {
                WorkspaceDirectoryView(cwd: cwd, path: entry.path).navigationTitle(entry.name)
              } else {
                WorkspaceFileView(cwd: cwd, path: entry.path).navigationTitle(entry.name)
              }
            } label: {
              Label(entry.name, systemImage: entry.kind == .directory ? "folder" : "doc.text")
                .font(.system(size: 15)).padding(.vertical, 5)
            }
          }
        }.listStyle(.plain)
        HStack {
          Button("上一页") { cursors.removeLast() }.disabled(cursors.count == 1)
          Spacer()
          Text("第 \(cursors.count) 页").font(.caption).monospacedDigit().foregroundStyle(Palette.muted)
          Spacer()
          Button("下一页") { if let next = page.nextCursor { cursors.append(next) } }
            .disabled(page.nextCursor == nil)
        }.frame(minHeight: 44)
      } else if error == nil { ProgressView("正在读取目录…").frame(maxHeight: .infinity) }
      if let error { Notice(text: error, warning: true) }
      Button("重新读取目录") { cursors = [nil]; revision += 1 }.frame(minHeight: 44)
    }
    .task(id: "\(path):\(cursors.last.flatMap { $0 } ?? ""): \(revision)") {
      page = nil; error = nil
      do {
        let result = try await readProject(.init(action: .list, cwd: cwd, path: path,
          cursor: cursors.last.flatMap { $0 }))
        guard case let .list(value) = result else { throw WorkspaceViewError.unexpectedResponse }
        page = value
      } catch is CancellationError {} catch { self.error = "目录读取失败：\(error)" }
    }
  }
}

private struct WorkspaceContentView: View {
  let cwd: String
  let path: String? // nil = current workspace vs HEAD, not this session's edits
  @State private var file: G0Transport.WorkspaceFile?
  @State private var diff: G0Transport.WorkspaceDiff?
  @State private var offset = 0
  @State private var snapshot: String?
  @State private var revision = 0
  @State private var error: String?

  private static let codeFont = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)

  private static func width(of lines: [String]) -> CGFloat {
    let widest = lines.map { ($0 as NSString).size(withAttributes: [.font: codeFont]).width }.max() ?? 0
    return ceil(widest) + 1
  }

  var body: some View {
    VStack(spacing: 10) {
      if path == nil {
        Text("当前工作区相对 HEAD · 包含未跟踪文件；不是本会话专属改动")
          .font(.caption).foregroundStyle(Palette.muted)
      }
      if let diff, diff.status != .captured {
        Notice(text: "Diff 不可用：\(diff.reason ?? diff.status.rawValue)", warning: true)
      } else if let text = file?.content ?? diff?.patch {
        if text.isEmpty { Text(path == nil ? "当前没有未提交改动" : "空文件").foregroundStyle(Palette.muted) }
        let lines = text.components(separatedBy: "\n")
        ScrollView([.vertical, .horizontal]) {
          LazyVStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
              Text(line.isEmpty ? " " : line).font(Font(Self.codeFont))
                .foregroundStyle(path == nil && line.hasPrefix("+") ? Palette.positive
                  : path == nil && line.hasPrefix("-") ? Palette.negative : Palette.ink)
                .textSelection(.enabled).fixedSize(horizontal: true, vertical: false)
            }
          }
          // A lazy stack is only as wide as its loaded rows, while the scroll
          // content is as wide as the longest row measured so far, so the stack
          // was centred and long lines pushed text to the right. Pin the width.
          .frame(width: Self.width(of: lines), alignment: .leading)
          .padding(12)
        }
        .defaultScrollAnchor(.topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        if let file {
          Text("字节 \(file.offset)–\(file.nextOffset) / \(file.totalBytes)").font(.caption).monospacedDigit()
          if file.hasMore { Button("读取下一页") { snapshot = file.snapshot; offset = file.nextOffset }.frame(minHeight: 44) }
        }
        if diff?.truncated == true {
          Notice(text: "仅显示前 64 KiB；Diff 未完整展示，请在 Mac 查看其余内容。", warning: true)
        }
      } else if error == nil { ProgressView("正在读取…").frame(maxHeight: .infinity) }
      if let error { Notice(text: error, warning: true) }
      Button("从头重新读取") { offset = 0; snapshot = nil; revision += 1 }.frame(minHeight: 44)
    }
    .padding(.horizontal, path == nil ? 0 : 16)
    .task(id: "\(path ?? "diff"):\(offset):\(revision)") {
      file = nil; diff = nil; error = nil
      do {
        let query = path.map { G0Transport.WorkspaceQuery(action: .file, cwd: cwd, path: $0, offset: offset, snapshot: snapshot) }
          ?? .init(action: .diff, cwd: cwd)
        switch try await readProject(query) {
        case let .file(value): file = value
        case let .diff(value): diff = value
        default: throw WorkspaceViewError.unexpectedResponse
        }
      } catch is CancellationError {} catch { self.error = "读取失败：\(error)。文件变化时请从头读取；仅支持 UTF-8 文本预览。" }
    }
  }
}

struct SessionRunStatusView: View {
  let session: OpenedSession
  @Environment(\.scenePhase) private var scenePhase
  @State private var status: G0Transport.SessionStatus?
  @State private var error: String?
  @State private var showDetails = false

  // Only states worth a line: no run observed stays silent, like the long-poll path.
  private var line: SessionStatusLine? {
    let details = SessionStatusLine.Action(title: "详情", perform: { showDetails = true })
    if error != nil { return .init(text: "无法确认 Mac 上的运行状态", action: details) }
    switch status?.state {
    case .running: return .init(text: "运行中", tone: .running, busy: true, action: details)
    case .waiting: return .init(text: "需要你决定", tone: .attention, action: details)
    case .not_observed, nil: return nil
    }
  }
  var body: some View {
    // The container stays mounted while silent so the status poll keeps running.
    VStack(spacing: 0) {
      if let line { SessionStatusStrip(status: line) }
    }
    .alert(line?.text ?? "运行状态", isPresented: $showDetails) { Button("知道了", role: .cancel) {} } message: {
      Text(error ?? "仅反映 Mac Scry 当前可见的运行，不代表其他终端中的 Agent。未检测到运行不等于任务已完成。\n核对时间：\(status?.observedAt ?? "尚未取得")")
    }
    .task(id: [session.providerId, session.agentProfileId, session.cwd, session.externalSessionId, String(describing: scenePhase)]) {
      status = nil; error = nil
      guard scenePhase == .active else { return }
      while !Task.isCancelled {
        do {
          let result = try await readProject(.init(action: .status, cwd: session.cwd, providerId: session.providerId,
            externalSessionId: session.externalSessionId, agentProfileId: session.agentProfileId))
          guard case let .status(value) = result else { throw WorkspaceViewError.unexpectedResponse }
          status = value; error = nil
        } catch is CancellationError { return }
        catch { status = nil; self.error = "无法核对 Mac 运行状态：\(error)" }
        do { try await Task.sleep(for: .seconds(10)) } catch { return }
      }
    }
  }
}

// MARK: - HTML preview

// HTML files open as a rendered page by default; the source stays one tap away.
struct WorkspaceFileView: View {
  let cwd: String
  let path: String
  @State private var showSource = false

  var body: some View {
    if MacLocalLink.isHTML(path) {
      VStack(spacing: 8) {
        Picker("显示方式", selection: $showSource) {
          Text("预览").tag(false)
          Text("源码").tag(true)
        }.pickerStyle(.segmented).padding(.horizontal, 16)
        if showSource { WorkspaceContentView(cwd: cwd, path: path) }
        else { WorkspaceHTMLPreview(cwd: cwd, path: path) }
      }
    } else {
      WorkspaceContentView(cwd: cwd, path: path)
    }
  }
}

private let htmlPreviewLimit = 4 * 1024 * 1024

private struct WorkspaceHTMLPreview: View {
  let cwd: String
  let path: String
  @State private var page: (html: String, rules: WKContentRuleList)?
  @State private var revision = 0
  @State private var error: String?

  var body: some View {
    VStack(spacing: 8) {
      Text("Mac 工作区文件的只读快照。已阻止网络请求，引用的其他文件（样式、脚本、图片）不会加载。")
        .font(.caption).foregroundStyle(Palette.muted).padding(.horizontal, 16)
      if let page { SandboxedHTMLView(html: page.html, rules: page.rules) }
      else if error == nil { ProgressView("正在读取…").frame(maxHeight: .infinity) }
      if let error {
        Notice(text: error, warning: true).padding(.horizontal, 16)
        Button("重新读取") { revision += 1 }.frame(minHeight: 44)
      }
    }
    .task(id: revision) {
      page = nil; error = nil
      do {
        // Fail closed: without the network block the page is not shown.
        let rules = try await SandboxedHTMLView.networkBlock()
        page = (try await readWholeFile(cwd: cwd, path: path), rules)
      } catch is CancellationError {
      } catch WorkspaceViewError.tooLarge(let bytes) {
        self.error = "文件 \(bytes / 1024) KB，超过 \(htmlPreviewLimit / 1024 / 1024) MB 预览上限；可切换到源码分页查看。"
      } catch { self.error = "读取失败：\(error)" }
    }
  }
}

// Pages share one snapshot, so a file changed mid-read fails instead of mixing versions.
@MainActor
private func readWholeFile(cwd: String, path: String) async throws -> String {
  var text = ""
  var offset = 0
  var snapshot: String?
  while true {
    guard case let .file(page) = try await readProject(.init(action: .file, cwd: cwd, path: path, offset: offset, snapshot: snapshot))
    else { throw WorkspaceViewError.unexpectedResponse }
    guard page.totalBytes <= htmlPreviewLimit else { throw WorkspaceViewError.tooLarge(page.totalBytes) }
    text += page.content
    guard page.hasMore else { return text }
    guard page.nextOffset > offset else { throw WorkspaceViewError.unexpectedResponse }
    offset = page.nextOffset
    snapshot = page.snapshot
  }
}

// The page is untrusted content from the workspace. It runs in a WebKit content
// process with a non-persistent store, no script message handlers, and a rule
// list that blocks every load except the in-memory document itself.
// Limit: content rules do not cover WebRTC.
private struct SandboxedHTMLView: UIViewRepresentable {
  let html: String
  let rules: WKContentRuleList

  @MainActor static func networkBlock() async throws -> WKContentRuleList {
    let json = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]
    """
    guard let store = WKContentRuleListStore.default() else { throw WorkspaceViewError.sandboxUnavailable }
    guard let list = try await store.compileContentRuleList(forIdentifier: "scry-html-preview-offline", encodedContentRuleList: json)
    else { throw WorkspaceViewError.sandboxUnavailable }
    return list
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(rules)
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = context.coordinator
    view.loadHTMLString(html, baseURL: nil)
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKNavigationDelegate {
    // Only the document itself and its in-page anchors (about:blank#…).
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
      decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel)
    }
  }
}

// MARK: - Mac-local links

// A loopback URL in Agent output names the Mac, not this phone. When a static
// server is rooted at the project (as `python -m http.server --directory` is),
// its path is also a workspace path. That mapping is an inference: it is shown
// as such, and a dynamic server cannot be reached this way.
enum MacLocalLink {
  static func isLoopback(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = url.host(percentEncoded: false)?.lowercased() else { return false }
    return host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "[::1]" ||
      host == "0.0.0.0" || host.hasPrefix("127.")
  }

  // `/a/` and `/a` map to `a/index.html`, like a static file server.
  static func workspacePath(for url: URL) -> String? {
    let raw = url.path(percentEncoded: false)
    var parts = raw.split(separator: "/").map(String.init)
    guard !parts.contains(".."), !parts.contains(".") else { return nil }
    if raw.hasSuffix("/") || parts.last?.contains(".") != true { parts.append("index.html") }
    return parts.joined(separator: "/")
  }

  static func isHTML(_ path: String) -> Bool {
    let ext = (path as NSString).pathExtension.lowercased()
    return ext == "html" || ext == "htm"
  }
}

private struct MacLocalLinkTarget: Identifiable {
  let url: URL
  var id: String { url.absoluteString }
}

extension View {
  // Loopback links open the matching workspace file; other links keep the system action.
  func macLocalLinks(cwd: String?) -> some View { modifier(MacLocalLinkHandler(cwd: cwd)) }
}

private struct MacLocalLinkHandler: ViewModifier {
  let cwd: String?
  @State private var target: MacLocalLinkTarget?

  func body(content: Content) -> some View {
    content
      .environment(\.openURL, OpenURLAction { url in
        guard MacLocalLink.isLoopback(url) else { return .systemAction }
        target = .init(url: url)
        return .handled
      })
      .sheet(item: $target) { target in MacLocalLinkSheet(url: target.url, cwd: cwd) }
  }
}

private struct MacLocalLinkSheet: View {
  let url: URL
  let cwd: String?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 8) {
        Notice(text: "\(url.absoluteString) 是 Mac 本机地址，手机无法直接访问。", warning: true)
          .padding(.horizontal, 16)
        if let cwd, let path = MacLocalLink.workspacePath(for: url) {
          Text("按项目路径推断为 \(path)。仅适用于直接提供项目目录的静态服务；动态服务需在 Mac 上查看。")
            .font(.caption).foregroundStyle(Palette.muted).padding(.horizontal, 16)
          WorkspaceFileView(cwd: cwd, path: path)
        } else {
          Text("这个地址无法对应到项目文件，请在 Mac 上查看。")
            .font(.callout).foregroundStyle(Palette.muted).padding(.horizontal, 16)
          Spacer()
        }
      }
      .navigationTitle("Mac 本机链接").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
    }
  }
}

private enum WorkspaceViewError: Error { case notPaired, unexpectedResponse, tooLarge(Int), sandboxUnavailable }

@MainActor
private func readProject(_ query: G0Transport.WorkspaceQuery) async throws -> G0Transport.WorkspaceResult {
  #if DEBUG
  if ProcessInfo.processInfo.arguments.contains("-uiWorkspaceFixture") {
    let json: String
    switch query.action {
    case .list: json = #"{"action":"list","listing":{"entries":[{"name":"README.md","path":"README.md","kind":"file"},{"name":"probe.html","path":"probe.html","kind":"file"}],"truncated":false}}"#
    case .file where query.path == "probe.html":
      // Every load here targets a local probe server; the preview must block all of them.
      let probe = """
      <!doctype html><meta name=viewport content="width=device-width"><body style="font:18px -apple-system;padding:16px">
      <h2 id=t>HTML fixture</h2><p id=js>JS not run</p><p id=f>fetch pending</p><p id=i>img pending</p>
      <img src="http://127.0.0.1:47811/img" onload="i.textContent='img loaded'" onerror="i.textContent='img blocked'">
      <p><a href="#t">anchor</a> · <a href="http://127.0.0.1:47811/nav">external</a></p>
      <script>js.textContent='JS ran';fetch('http://127.0.0.1:47811/fetch').then(()=>f.textContent='fetch ok').catch(()=>f.textContent='fetch blocked')</script>
      """
      let file: [String: Any] = ["path": "probe.html", "content": probe, "offset": 0, "nextOffset": probe.utf8.count,
                                 "totalBytes": probe.utf8.count, "hasMore": false, "snapshot": "fixture"]
      return try JSONDecoder().decode(G0Transport.WorkspaceResult.self,
        from: JSONSerialization.data(withJSONObject: ["action": "file", "file": file]))
    case .file: json = ##"{"action":"file","file":{"path":"README.md","content":"# Project fixture\nRead-only preview","offset":0,"nextOffset":35,"totalBytes":35,"hasMore":false,"snapshot":"fixture"}}"##
    case .diff: json = #"{"action":"diff","diff":{"status":"captured","patch":"diff --git a/README.md b/README.md\n-old\n+new","truncated":false}}"#
    case .status: json = #"{"action":"status","state":"running","observedAt":"DEBUG UI fixture"}"#
    }
    return try JSONDecoder().decode(G0Transport.WorkspaceResult.self, from: Data(json.utf8))
  }
  // Existing visual fixtures never open a real transport.
  if ProcessInfo.processInfo.arguments.contains("-uiPreview") { throw WorkspaceViewError.notPaired }
  #endif
  guard let connection = RemoteConnectionStore().load() else { throw WorkspaceViewError.notPaired }
  let result = try await RemoteRunClient(connection: connection).workspace(query)
  try Task.checkCancellation()
  guard connection == RemoteConnectionStore().load() else { throw CancellationError() }
  return result
}
