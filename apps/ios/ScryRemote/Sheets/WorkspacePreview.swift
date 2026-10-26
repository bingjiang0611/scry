import SwiftUI
import WebKit
import QuickLook
import UniformTypeIdentifiers
import RemoteTransport

// MARK: - HTML preview

struct WorkspaceFileView: View {
  let cwd: String
  let path: String
  // Browser entries are file paths, even when their names resemble URL schemes.
  var body: some View { RemoteFilePreview(cwd: cwd, target: path.hasPrefix("/") ? path : "./" + path) }
}

private struct RemoteFilePreview: View {
  @Environment(RemoteRunStore.self) var run
  let cwd: String
  let target: String
  @State private var url: URL?
  @State private var rules: WKContentRuleList?
  @State private var html: String?
  @State private var error: String?
  @State private var received = 0
  @State private var total: Int?
  @State private var revision = 0
  @State private var showSource = false

  private var isHTML: Bool { url.map { MacLocalLink.isHTML($0.path) } ?? false }
  var body: some View {
    VStack(spacing: 8) {
      if let url {
        HStack {
          Text(url.lastPathComponent).font(.caption).lineLimit(1)
          Spacer()
          ShareLink(item: url) { Label(ConnectionCopy.FileOpen.saveOrShare, systemImage: "square.and.arrow.up") }
            .accessibilityIdentifier("remote-file-export")
        }.padding(.horizontal, 16)
        if isHTML, let rules {
          Picker(ConnectionCopy.FileOpen.displayMode, selection: $showSource) {
            Text(ConnectionCopy.FileOpen.preview).tag(false)
            Text(ConnectionCopy.FileOpen.source).tag(true)
          }.pickerStyle(.segmented).padding(.horizontal, 16)
          if showSource { DownloadedSourceView(url: url) }
          else {
            Text(ConnectionCopy.FileOpen.offlineHTML).font(.caption).foregroundStyle(Palette.dim).padding(.horizontal, 16)
            SandboxedHTMLView(url: url, html: html, rules: rules)
          }
        } else if UTType(filenameExtension: url.pathExtension)?.conforms(to: .text) == true {
          DownloadedSourceView(url: url)
        } else if QLPreviewController.canPreview(url as NSURL) {
          DownloadedQuickLook(url: url)
        } else {
          DownloadedSourceView(url: url)
        }
      } else if error == nil {
        ProgressView(ConnectionCopy.FileOpen.downloading).frame(maxHeight: .infinity)
        if received > 0 { Text(ConnectionCopy.FileOpen.progress(received, total)).font(.caption).foregroundStyle(Palette.dim) }
      }
      if let error {
        Notice(text: error, warning: true).padding(.horizontal, 16)
        Button(ConnectionCopy.FileOpen.retry) { revision += 1 }.frame(minHeight: 44)
        Spacer()
      }
    }
    .task(id: revision) {
      let previous = url
      url = nil; rules = nil; html = nil; error = nil; received = 0; total = nil
      if let previous { await Self.remove(previous) }
      var downloaded: URL?
      do {
        let file = try await download { received = $0; total = $1 }
        downloaded = file
        if MacLocalLink.isHTML(file.path) {
          rules = try await SandboxedHTMLView.networkBlock()
          // Keep UTF-8 text previews readable even without a charset tag. Large
          // and non-UTF-8 documents use the file loader, without a whole-file String.
          html = try await Task.detached {
            let info = try file.resourceValues(forKeys: [.fileSizeKey])
            guard let size = info.fileSize, size <= 4 * 1024 * 1024 else { return nil as String? }
            return String(data: try Data(contentsOf: file), encoding: .utf8)
          }.value
        }
        try Task.checkCancellation()
        url = file
      } catch is CancellationError {
        if let downloaded { await Self.remove(downloaded) }
      } catch {
        if let downloaded { await Self.remove(downloaded) }
        self.error = ConnectionCopy.FileOpen.failure(error)
      }
    }
    .onDisappear {
      if let url { Task { await Self.remove(url) } }
    }
  }
  @MainActor private func download(progress: @escaping @MainActor (Int, Int?) -> Void) async throws -> URL {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("-uiWorkspaceFixture") {
      let path = target.hasPrefix("./") ? String(target.dropFirst(2)) : target
      guard case let .file(page) = try await readProject(.init(action: .file, cwd: cwd, path: path), run: run)
      else { throw WorkspaceViewError.unexpectedResponse }
      let sink = RemoteFileDownloadSink()
      do {
        try await sink.start(name: (target as NSString).lastPathComponent)
        try await sink.write(Data(page.content.utf8))
        return try await sink.finish()
      } catch { await sink.remove(); throw error }
    }
    #endif
    return try await run.downloadFile(cwd: cwd, target: target, progress: progress)
  }
  private static func remove(_ url: URL) async {
    await Task.detached { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }.value
  }
}

private struct DownloadedSourceView: View {
  let url: URL
  @State private var page: TextPage?
  @State private var offset = 0
  @State private var error = false

  private struct TextPage: Sendable {
    let text: String
    let nextOffset: Int
    let total: Int
  }
  var body: some View {
    VStack(spacing: 8) {
      if let page {
        ScrollView([.vertical, .horizontal]) {
          Text(page.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            .fixedSize(horizontal: true, vertical: false).frame(maxWidth: .infinity, alignment: .leading).padding(16)
        }.defaultScrollAnchor(.topLeading)
        Text(ConnectionCopy.FileOpen.page(offset, page.nextOffset, page.total)).font(.caption).monospacedDigit()
        HStack {
          if offset > 0 { Button(ConnectionCopy.FileOpen.fromStart) { offset = 0 } }
          if page.nextOffset < page.total { Button(ConnectionCopy.FileOpen.nextPage) { offset = page.nextOffset } }
        }.frame(minHeight: 44)
      } else if error { Notice(text: ConnectionCopy.FileOpen.noPreview, warning: false).padding(16); Spacer() }
      else { ProgressView() }
    }
    .task(id: offset) {
      page = nil; error = false
      do {
        let position = offset
        let value = try await Task.detached {
          let file = try FileHandle(forReadingFrom: url)
          defer { try? file.close() }
          let total = Int(try file.seekToEnd())
          try file.seek(toOffset: UInt64(position))
          let data = try file.read(upToCount: 64 * 1024) ?? Data()
          guard !data.contains(0) else { throw CocoaError(.fileReadInapplicableStringEncoding) }
          // Do not split a UTF-8 scalar at the page boundary. An invalid scalar
          // elsewhere remains an unsupported text format, not replacement text.
          for trim in 0...min(3, data.count) {
            let bytes = data.prefix(data.count - trim)
            if let text = String(data: bytes, encoding: .utf8), trim == 0 || position + data.count < total {
              return TextPage(text: text, nextOffset: position + bytes.count, total: total)
            }
          }
          throw CocoaError(.fileReadInapplicableStringEncoding)
        }.value
        try Task.checkCancellation()
        page = value
      } catch is CancellationError {} catch { self.error = true }
    }
  }
}

private struct DownloadedQuickLook: UIViewControllerRepresentable {
  let url: URL
  func makeCoordinator() -> Coordinator { Coordinator(url: url) }
  func makeUIViewController(context: Context) -> QLPreviewController {
    let view = QLPreviewController()
    view.dataSource = context.coordinator
    return view
  }
  func updateUIViewController(_ view: QLPreviewController, context: Context) {}
  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    let url: URL
    init(url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
  }
}

// The page is untrusted content from the workspace. It runs in a WebKit content
// process with a non-persistent store, no script message handlers, and a rule
// list that blocks network loads. Read access is confined to this download's
// private directory, containing only the selected file.
// Limit: content rules do not cover WebRTC.
private struct SandboxedHTMLView: UIViewRepresentable {
  let url: URL
  let html: String?
  let rules: WKContentRuleList

  @MainActor static func networkBlock() async throws -> WKContentRuleList {
    let json = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^file:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]
    """
    guard let store = WKContentRuleListStore.default() else { throw WorkspaceViewError.sandboxUnavailable }
    guard let list = try await store.compileContentRuleList(forIdentifier: "scry-html-download-offline", encodedContentRuleList: json)
    else { throw WorkspaceViewError.sandboxUnavailable }
    return list
  }

  func makeCoordinator() -> Coordinator { Coordinator(url: url, inMemory: html != nil) }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(rules)
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = context.coordinator
    if let html { view.loadHTMLString(html, baseURL: nil) }
    else { view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKNavigationDelegate {
    let url: URL
    let inMemory: Bool
    init(url: URL, inMemory: Bool) { self.url = url; self.inMemory = inMemory }
    // Only the selected document and its in-page anchors.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
      guard let requested = action.request.url else { decisionHandler(.cancel); return }
      let sameDocument = inMemory ? requested.scheme == "about"
        : requested.isFileURL && requested.standardizedFileURL.path == url.standardizedFileURL.path
      decisionHandler(sameDocument ? .allow : .cancel)
    }
  }
}

// MARK: - Mac-local links

// HTTP URLs retain their real server path/query. Explicit file links are
// resolved by the Mac to one canonical read-only target, never a directory grant.
enum MacLocalLink {
  static func isLoopback(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = url.host(percentEncoded: false)?.lowercased() else { return false }
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    let ipv4 = parts.count == 4 && parts.allSatisfy { UInt8($0) != nil }
    return host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "[::1]" ||
      (ipv4 && parts.first == "127")
  }

  static func downloadTarget(for url: URL) -> String {
    url.scheme == nil ? url.path(percentEncoded: false) : url.absoluteString
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
  // Explicit file and Mac-loopback links use the owner-only download surface.
  func macLocalLinks(cwd: String?) -> some View { modifier(MacLocalLinkHandler(cwd: cwd)) }
}

private struct MacLocalLinkHandler: ViewModifier {
  let cwd: String?
  @State private var target: MacLocalLinkTarget?

  func body(content: Content) -> some View {
    content
      .environment(\.openURL, OpenURLAction { url in
        guard MacLocalLink.isLoopback(url) || url.isFileURL || url.scheme == nil else { return .systemAction }
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
        if let cwd {
          RemoteFilePreview(cwd: cwd, target: MacLocalLink.downloadTarget(for: url))
        } else {
          Notice(text: ConnectionCopy.FileOpen.noProject, warning: true).padding(16)
          Spacer()
        }
      }
      .navigationTitle(MacLocalLink.isLoopback(url) ? ConnectionCopy.FileOpen.localLinkTitle : ConnectionCopy.FileOpen.fileTitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button(ConnectionCopy.done) { dismiss() } } }
    }
  }
}
