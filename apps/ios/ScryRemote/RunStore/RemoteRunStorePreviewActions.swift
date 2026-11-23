import Foundation
import RemoteTransport
#if canImport(UIKit)
import UIKit
#endif

#if DEBUG
extension RemoteRunStore {
  func loadMockDirectories(path: String?) {
    let scry = G0Transport.RunProjectRef(path: "/Users/demo/Projects/scry", label: "scry")
    let ios = G0Transport.RunProjectRef(path: "\(scry.path)/apps/ios", label: "ios")
    switch path {
    case nil:
      directories = .loaded(G0Transport.RunDirectoryListing(directories: [scry,
        G0Transport.RunProjectRef(path: "/Users/demo/Projects/rate-native", label: "rate-native"),
        G0Transport.RunProjectRef(path: "/Users/demo/Work/atlas-web", label: "atlas-web")]))
    case scry.path:
      directories = .loaded(G0Transport.RunDirectoryListing(current: scry, directories: [
        G0Transport.RunProjectRef(path: "\(scry.path)/apps", label: "apps"),
        G0Transport.RunProjectRef(path: "\(scry.path)/docs", label: "docs"),
        G0Transport.RunProjectRef(path: "\(scry.path)/src", label: "src")
      ]))
    case "\(scry.path)/apps":
      directories = .loaded(G0Transport.RunDirectoryListing(
        current: G0Transport.RunProjectRef(path: "\(scry.path)/apps", label: "apps"), parent: scry,
        directories: [ios, G0Transport.RunProjectRef(path: "\(scry.path)/apps/desktop", label: "desktop")]))
    case ios.path:
      directories = .loaded(G0Transport.RunDirectoryListing(current: ios,
        parent: G0Transport.RunProjectRef(path: "\(scry.path)/apps", label: "apps"), directories: [
          G0Transport.RunProjectRef(path: "\(ios.path)/ScryRemote", label: "ScryRemote")
        ]))
    default:
      let current = G0Transport.RunProjectRef(path: path ?? scry.path, label: (path ?? scry.path).split(separator: "/").last.map(String.init) ?? "文件夹")
      directories = .loaded(G0Transport.RunDirectoryListing(current: current, parent: scry, directories: []))
    }
  }

  // Visual-only bytes so the DEBUG chat fixture exercises thumbnail + preview.
  static func mockImageData() -> Data? {
    #if canImport(UIKit)
    UIGraphicsImageRenderer(size: CGSize(width: 390, height: 844)).image { context in
      UIColor(red: 0.12, green: 0.2, blue: 0.35, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 390, height: 844))
      UIColor(red: 0.45, green: 0.7, blue: 1, alpha: 1).setFill(); context.fill(CGRect(x: 24, y: 120, width: 342, height: 180))
    }.jpegData(compressionQuality: 0.8)
    #else
    nil
    #endif
  }

  func applyMockRun(prompt: String, attachments: [RemoteRunClient.Attachment]) {
    resetRun()
    self.prompt = prompt
    sentAttachments = attachments.map(SentAttachment.init)
    runId = "mock-run-visual-only"
    lifecycle = .settled
    terminalDrainCompleted = true
    output = [OutputLine(id: 1, kind: "output", text: "这是 DEBUG 视觉预览回复；没有连接 Provider，也没有写入真实 ledger。")]
    resultSummary = "Mock 数据 · 不代表真实用量"
  }
}
#endif
