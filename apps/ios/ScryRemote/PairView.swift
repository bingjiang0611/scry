import SwiftUI

// v5 pairing keeps one clear action and makes the trust boundary explicit. A
// fingerprint means proof succeeded but is never rendered as paired until the
// Mac issues a real grant.
struct PairView: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: "连接 Mac", backAction: { model.cancelPairing(); model.route = .home }) {
        Color.clear.frame(width: 44, height: 44)
      }
      ScrollView {
        VStack(spacing: 0) {
          pairMark.padding(.top, 34).padding(.bottom, 25)
          Text("让 iPhone 安全连接 Scry")
            .font(.system(size: 25, weight: .bold)).tracking(-0.6).multilineTextAlignment(.center)
          Text("在 Mac 的 Scry 中打开“连接 iPhone”，然后扫描一次性配对码。")
            .font(.system(size: 14)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
            .padding(.top, 9).padding(.horizontal, 22)

          VStack(spacing: 0) {
            step(1, "扫描 Mac 上显示的二维码")
            step(2, "核对两端显示的设备指纹")
            step(3, "在 Mac 上确认访问权限")
          }
          .padding(.top, 26)

          pairingStatus.padding(.top, 18)

          HStack(alignment: .top, spacing: 9) {
            Image(systemName: Symbol.shield).font(.system(size: 16)).foregroundStyle(Palette.positive)
            Text("中继只传输端到端加密字节。设备私钥、Provider 凭据与执行都留在你的设备上。")
              .font(.system(size: 11)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(13).background(Palette.noticeBg, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
          .padding(.top, 18)
        }
        .padding(.horizontal, 24).padding(.bottom, 20)
      }
      .scrollIndicators(.hidden)

      VStack(spacing: 8) {
        Button { model.pairing = .scanning } label: {
          Label("扫描配对码", systemImage: "qrcode.viewfinder")
            .font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(.white).background(Palette.blue, in: Capsule())
        }
        .buttonStyle(.plain)
        Button { model.cancelPairing(); model.route = .home } label: {
          Text("稍后连接").font(.system(size: 14, weight: .medium)).frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain).foregroundStyle(Palette.muted)
      }
      .padding(.horizontal, 20).padding(.bottom, 18)
    }
    .background(Color(hex: 0xFAFAF9))
    .fullScreenCover(isPresented: scanning) {
      ZStack(alignment: .topTrailing) {
        QRScanner { code in model.pairing = .idle; model.beginPair(scanned: code) }.ignoresSafeArea()
        Button("取消") { model.pairing = .idle }
          .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).padding(16)
      }
    }
  }

  private var pairMark: some View {
    ZStack(alignment: .bottomTrailing) {
      Image(systemName: Symbol.laptop).font(.system(size: 35, weight: .light)).foregroundStyle(Palette.ink)
        .frame(width: 88, height: 88).background(.white, in: RoundedRectangle(cornerRadius: 27, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 27, style: .continuous).stroke(Palette.line))
        .shadow(color: .black.opacity(0.07), radius: 18, y: 10)
      Image(systemName: "iphone").font(.system(size: 20, weight: .medium)).foregroundStyle(.white)
        .frame(width: 40, height: 40).background(Palette.blue, in: Circle()).offset(x: 8, y: 8)
    }
  }

  private var scanning: Binding<Bool> {
    Binding(get: { model.pairing == .scanning }, set: { if !$0 && model.pairing == .scanning { model.pairing = .idle } })
  }

  @ViewBuilder private var pairingStatus: some View {
    switch model.pairing {
    case .idle, .scanning:
      EmptyView()
    case .proving:
      statusCard("正在验证设备密钥…", tint: Palette.blue, progress: true)
    case let .awaitingConfirmation(fingerprint):
      statusCard("等待 Mac 确认\n指纹 \(fingerprint.prefix(16).uppercased())…", tint: Palette.amber)
    case let .paired(deviceId):
      statusCard("已配对 · 设备 \(deviceId.prefix(8))…", tint: Palette.green)
    case let .failed(message):
      statusCard(message, tint: Palette.negative)
    }
  }

  private func statusCard(_ text: String, tint: Color, progress: Bool = false) -> some View {
    HStack(alignment: .top, spacing: 10) {
      if progress { ProgressView().controlSize(.small) }
      else { Circle().fill(tint).frame(width: 8, height: 8).padding(.top, 5) }
      Text(text).font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
    }
    .foregroundStyle(Palette.ink).padding(13)
    .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
  }

  private func step(_ number: Int, _ text: String) -> some View {
    HStack(spacing: 12) {
      Text("\(number)").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.ink)
        .frame(width: 27, height: 27).background(Palette.canvas, in: Circle())
      Text(text).font(.system(size: 14.5)).foregroundStyle(Palette.ink)
      Spacer()
    }
    .frame(minHeight: 48)
  }
}
