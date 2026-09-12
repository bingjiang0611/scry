import Foundation
import Combine

@MainActor
final class G0Model: ObservableObject {
  enum Phase: Equatable {
    case noIdentity, ready, loading, importing, connecting, verified, failed
    var label: String {
      switch self {
      case .noIdentity: "未导入测试身份"
      case .ready: "准备验证"
      case .loading: "正在读取测试身份"
      case .importing: "正在保存测试身份"
      case .connecting: "正在验证加密通道"
      case .verified: "加密回声验证通过"
      case .failed: "验证失败 · 未发送业务命令"
      }
    }
    var busy: Bool { self == .loading || self == .importing || self == .connecting }
  }
  @Published private(set) var phase: Phase = .noIdentity
  @Published private(set) var port: Int?
  @Published private(set) var anchorDigest: String?
  @Published var explanation = "专用 G0 测试端，不代表已配对或具备远程控制权限。"
  private let service: G0Service

  init(service: G0Service = G0Service()) { self.service = service }

  private func apply(_ summary: G0Service.Summary?) {
    port = summary?.port
    anchorDigest = summary?.anchorDigest
    phase = summary == nil ? .noIdentity : .ready
  }

  func reload() async {
    guard !phase.busy else { return }
    phase = .loading
    do { apply(try await service.summary()) }
    catch { phase = .failed; explanation = "无法读取测试身份。不会使用明文存储回退。" }
  }

  func importFile(_ url: URL) async {
    guard !phase.busy else { return }
    phase = .importing
    do {
      apply(try await service.importFile(url))
      explanation = "测试材料已写入本机 Keychain，不进行 iCloud 同步。尚未建立连接。"
    } catch {
      phase = .failed
      explanation = "导入失败：文件格式、大小或 Keychain 写入不符合要求。原身份没有被删除。"
    }
  }

  func run() async {
    guard !phase.busy else { return }
    phase = .connecting
    explanation = "等待内层 TLS 1.3 双向认证；不会自动重试。"
    do {
      try await service.verify()
      phase = .verified
      explanation = "已收到经内层 TLS 认证且匹配本次请求的回声。只证明本次传输，不代表主机任务、配对或通知功能可用。"
    } catch {
      phase = .failed
      explanation = "证书、连接或协议验证失败。没有自动重发；请检查验证端，再明确发起一次新测试。"
    }
  }

  func remove() async {
    guard !phase.busy else { return }
    phase = .importing
    do {
      try await service.remove()
      apply(nil)
      explanation = "仅清除了此测试 App 的身份材料，不影响 Mac 任务或任何其他账号。"
    } catch { phase = .failed; explanation = "Keychain 删除失败，没有显示为已清除。" }
  }
}
