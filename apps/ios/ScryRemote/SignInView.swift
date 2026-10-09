import SwiftUI
import AuthenticationServices

// Identity unlocks the local UI; Mac access still requires a separate owner-
// confirmed device grant. The DEBUG bypass remains compile-time isolated.
struct SignInView: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 52)
      VStack(spacing: 18) {
        ZStack {
          RoundedRectangle(cornerRadius: 25, style: .continuous).fill(Palette.ink)
            .frame(width: 82, height: 82)
          Image(systemName: "sparkles").font(.system(size: 31, weight: .medium)).foregroundStyle(Palette.surface)
        }
        Text("Scry").font(.system(size: 32, weight: .bold)).tracking(-1)
        Text("从 iPhone 继续你 Mac 上的\nAI 编码会话")
          .font(.system(size: 17, weight: .medium)).multilineTextAlignment(.center).lineSpacing(3)
        Text("执行、代码与凭据始终留在 Mac。")
          .font(.system(size: 13)).foregroundStyle(Palette.muted)
      }
      Spacer()

      if case let .failed(message) = model.auth { Notice(text: message, warning: true) }

      SignInWithAppleButton(.signIn) { request in
        request.requestedScopes = [.fullName]
      } onCompletion: { result in
        switch result {
        case let .success(auth):
          if let credential = auth.credential as? ASAuthorizationAppleIDCredential {
            model.auth = .signedIn(name: credential.fullName?.givenName ?? "Apple 用户")
            if let host = model.connectionHost { model.link = .offline(host: host) }
            else { model.link = .notPaired }
          } else { model.auth = .failed("登录返回了意外的凭据类型") }
        case let .failure(error):
          model.auth = .failed("登录未完成：\(error.localizedDescription)。Sign in with Apple 需要有效 entitlement。")
        }
      }
      .signInWithAppleButtonStyle(.white).frame(height: 50)
      .padding(.horizontal, 22).onTapGesture { model.auth = .signingIn }

      HStack(alignment: .top, spacing: 7) {
        Image(systemName: Symbol.shield).font(.system(size: 12)).padding(.top, 1)
        Text("登录只验证此 iPhone 的本地身份；连接 Mac 仍需扫描配对码并在 Mac 上确认。")
      }
      .font(.system(size: 11)).foregroundStyle(Palette.muted)
      .padding(.horizontal, 26).padding(.top, 12).padding(.bottom, 22)

      #if DEBUG
      Button {
        model.auth = .signedIn(name: "本地调试")
        if model.hasConnection {
          if let host = model.connectionHost { model.link = .offline(host: host) }
          model.route = .home
        } else {
          model.link = .notPaired; model.route = .pair
        }
      } label: {
        Text(model.hasConnection ? "本地调试：进入（已配对）" : "本地调试：跳过登录，去扫码配对")
          .font(.system(size: 13, weight: .medium)).frame(maxWidth: .infinity, minHeight: 44)
          .foregroundStyle(Palette.ink).background(Palette.canvas, in: Capsule())
      }
      .buttonStyle(.plain).padding(.horizontal, 22).padding(.bottom, 20)
      #endif
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.surface)
  }
}
