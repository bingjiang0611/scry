import SwiftUI

// Pairing entry. The pairing authority and its human confirmation live on the
// Mac (src/main/remote/pairing.ts); this phone screen explains the real steps
// and never claims a connection was created. It stays truthful: scanning and
// live bootstrap transport are not wired into this build yet.
struct PairView: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("连接你的 Mac").font(.system(size: 20, weight: .semibold))
        Spacer()
      }
      .padding(.horizontal, 22)
      .padding(.top, 18)
      .padding(.bottom, 8)

      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          step(1, "在 Mac 上打开 Scry，选择「连接 iPhone」。")
          step(2, "用此 iPhone 扫描 Mac 显示的短时配对码。")
          step(3, "在 Mac 上核对设备与「最大功能权限」，确认后才会授予访问。")

          Text("此 iPhone 将能管理任务、授权文件、受管理终端与审批；这不等于 root，也不绕过仓库指纹授权。凭据与执行始终留在 Mac。")
            .font(.system(size: 13))
            .foregroundStyle(Palette.muted)
            .padding(.top, 4)

          pairingStatus
        }
        .padding(.horizontal, 22)
        .padding(.top, 8)
      }
      .scrollIndicators(.hidden)

      VStack(spacing: 10) {
        Button {
          model.pairing = .scanning
        } label: {
          Text("扫描配对码")
            .font(.system(size: 15, weight: .semibold))
            .frame(maxWidth: .infinity, minHeight: 46)
            .foregroundStyle(Color.white)
            .background(Palette.blue, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        Button {
          model.cancelPairing()
          model.route = .home
        } label: {
          Text("稍后连接")
            .font(.system(size: 15, weight: .medium))
            .frame(maxWidth: .infinity, minHeight: 46)
            .foregroundStyle(Color.white)
            .background(Palette.ink, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 24)
    }
    .background(Palette.surface)
    .fullScreenCover(isPresented: scanning) {
      ZStack(alignment: .topTrailing) {
        QRScanner { code in
          model.pairing = .idle
          model.beginPair(scanned: code)
        }
        .ignoresSafeArea()
        Button("取消") { model.pairing = .idle }
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Color.white)
          .padding(12)
      }
    }
  }

  private var scanning: Binding<Bool> {
    Binding(get: { model.pairing == .scanning }, set: { if !$0 && model.pairing == .scanning { model.pairing = .idle } })
  }

  // Honest live status. A fingerprint = proved possession, NOT paired; the user
  // compares it against the Mac before the operator confirms. Only a grant reads
  // as paired; failures are shown verbatim.
  @ViewBuilder private var pairingStatus: some View {
    switch model.pairing {
    case .idle, .scanning:
      Notice(text: "扫描 Mac 上显示的配对码开始连接；在 Mac 确认前不会授予访问。", warning: false)
        .padding(.horizontal, -16)
    case .proving:
      statusCard("正在向 Mac 证明密钥…", Palette.muted)
    case let .awaitingConfirmation(fingerprint):
      statusCard("已证明，等待 Mac 确认。请核对指纹与 Mac 上一致：\n\(fingerprint.prefix(16).uppercased())…", Palette.blue)
    case let .paired(deviceId):
      statusCard("已配对。设备 \(deviceId.prefix(8))… 已获授权，正在进入新建会话…", Palette.blue)
    case let .failed(message):
      statusCard(message, Palette.ink)
    }
  }

  private func statusCard(_ text: String, _ tint: Color) -> some View {
    Text(text)
      .font(.system(size: 14))
      .foregroundStyle(Palette.ink)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(14)
      .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private func step(_ n: Int, _ text: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Text("\(n)")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(Color.white)
        .frame(width: 26, height: 26)
        .background(Palette.blue, in: Circle())
      Text(text).font(.system(size: 15)).foregroundStyle(Palette.ink)
      Spacer(minLength: 0)
    }
  }
}
