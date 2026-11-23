import SwiftUI
import RemoteTransport

struct HostNoticeBanner: View {
  @State private var notices: [G0Transport.HostAdminNotice] = []

  var body: some View {
    Group {
      if let notice = notices.first {
        HStack(alignment: .top, spacing: 10) {
          VStack(alignment: .leading, spacing: 4) {
            Label("执行端通知", systemImage: "lock.shield")
              .font(Typography.groupLabel)
              .foregroundStyle(Palette.warnText)
            Text(message(notice))
              .font(Typography.reply)
              .foregroundStyle(Palette.fg)
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 0)
          Button { notices.removeFirst() } label: {
            Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("关闭通知")
        }
        .padding(12)
        .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.border, lineWidth: 1))
        .padding(.horizontal, 12)
        .accessibilityIdentifier("host-admin-notice")
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: G0Transport.HostAdminNotice.received).receive(on: RunLoop.main)) { event in
      guard let notice = event.object as? G0Transport.HostAdminNotice,
            !notices.contains(where: { $0.id == notice.id }) else { return }
      if notices.count >= 32 { notices.removeFirst() }
      notices.append(notice)
    }
  }

  private func message(_ notice: G0Transport.HostAdminNotice) -> String {
    let device = notice.deviceLabel ?? "未知设备"
    let fingerprint = notice.fingerprintPrefix.map { "（指纹前缀 \($0.uppercased())）" } ?? ""
    switch notice.kind {
    case "device_approved_via_cli":
      return "执行端用命令行批准了设备「\(device)」\(fingerprint)。如非本人操作，请在执行端 Scry 的「设置 → 远程访问」撤销。"
    case "device_revoked_via_cli":
      return "执行端用命令行撤销了设备「\(device)」。"
    case "cli_approval_enabled":
      return "执行端已允许命令行批准。可以在执行端 Scry 的「设置 → 后台服务」关闭。"
    case "pairing_cancelled_via_cli":
      return "执行端用命令行取消了待确认配对。"
    default:
      return "执行端用命令行关闭了桌面远程访问。"
    }
  }
}
