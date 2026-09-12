import SwiftUI
import AuthenticationServices

// Sign in with Apple entry (chosen by the owner). Uses the first-party SwiftUI
// button so there is no custom crypto or invented auth.
//
// Honesty gate: the `com.apple.developer.applesignin` entitlement requires a
// paid Apple Developer Program membership. With only a free Personal Team this
// flow will fail at runtime, so a failure is surfaced truthfully instead of
// pretending the user is signed in. Identity here only unlocks the local UI; it
// is not yet bound to a real owner-device pairing grant on the Mac.
struct SignInView: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      Spacer()
      VStack(spacing: 14) {
        Image(systemName: Symbol.laptop)
          .font(.system(size: 42, weight: .regular))
          .foregroundStyle(Palette.ink)
        Text("Scry Remote")
          .font(.system(size: 24, weight: .semibold))
        Text("控制你自己的 Mac 上的 AI 编码会话。\niPhone 是控制端，凭据与执行仍留在 Mac。")
          .font(.system(size: 14))
          .foregroundStyle(Palette.muted)
          .multilineTextAlignment(.center)
      }
      Spacer()

      if case let .failed(message) = model.auth {
        Notice(text: message, warning: true)
      }

      SignInWithAppleButton(.signIn) { request in
        request.requestedScopes = [.fullName]
      } onCompletion: { result in
        switch result {
        case let .success(auth):
          if let credential = auth.credential as? ASAuthorizationAppleIDCredential {
            let name = credential.fullName?.givenName ?? "Apple 用户"
            model.auth = .signedIn(name: name)
            model.link = .notPaired
          } else {
            model.auth = .failed("登录返回了意外的凭据类型")
          }
        case let .failure(error):
          // Most commonly: entitlement missing on a free Personal Team.
          model.auth = .failed("登录未完成：\(error.localizedDescription)。Sign in with Apple 需要付费 Apple Developer 账号的 entitlement。")
        }
      }
      .signInWithAppleButtonStyle(.black)
      .frame(height: 50)
      .padding(.horizontal, 22)
      .padding(.bottom, 10)
      .onTapGesture { model.auth = .signingIn }

      Text("登录仅解锁本机界面，尚未绑定到 Mac 上的设备授权。")
        .font(.system(size: 12))
        .foregroundStyle(Color(hex: 0x919194))
        .multilineTextAlignment(.center)
        .padding(.horizontal, 22)
        .padding(.bottom, 24)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Palette.surface)
  }
}
