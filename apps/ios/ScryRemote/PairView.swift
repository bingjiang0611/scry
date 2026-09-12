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

          Notice(text: "扫码与实时配对通道尚未接入此版本；此处不会创建连接或授予访问。", warning: false)
            .padding(.horizontal, -16)
        }
        .padding(.horizontal, 22)
        .padding(.top, 8)
      }
      .scrollIndicators(.hidden)

      Button {
        model.route = .home
      } label: {
        Text("稍后连接")
          .font(.system(size: 15, weight: .medium))
          .frame(maxWidth: .infinity, minHeight: 46)
          .foregroundStyle(Color.white)
          .background(Palette.ink, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 24)
    }
    .background(Palette.surface)
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
