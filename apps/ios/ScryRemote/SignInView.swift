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

      #if DEBUG
      // Sign in with Apple needs a paid Developer entitlement the tester does not
      // have, so on a free Personal Team the button above fails at runtime. This
      // DEBUG-only bypass unlocks the LOCAL UI exactly like a successful sign-in
      // would (same semantics as the copy above) so pairing/run can be tested. It
      // fabricates no host grant and no session; real access still comes only
      // from a Mac-issued device grant after scanning the QR.
      Button {
        model.auth = .signedIn(name: "本地调试")
        model.link = .notPaired
        model.route = .pair
      } label: {
        Text("本地调试：跳过登录，去扫码配对")
          .font(.system(size: 14, weight: .medium))
          .frame(maxWidth: .infinity, minHeight: 44)
          .foregroundStyle(Color.white)
          .background(Palette.ink, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 24)
      #endif
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Palette.surface)
  }
}
