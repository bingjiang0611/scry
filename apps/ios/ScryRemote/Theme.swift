import SwiftUI

// Design tokens transcribed from designs/scry-ios-remote/Scry iOS Remote v2.html.
// Kept in one place so the native UI matches the accepted Codex-aligned v2 and
// does not drift into ad-hoc colors. This is presentation only; it carries no
// state or evidence semantics.
enum Palette {
  static let ink = Color(hex: 0x101112)
  static let muted = Color(hex: 0x929395)
  static let line = Color(hex: 0xE5E5E7)
  static let blue = Color(hex: 0x3884F4)
  static let green = Color(hex: 0x54B583)
  static let amber = Color(hex: 0xB76D30)
  static let canvas = Color(hex: 0xEDEDEE)
  static let surface = Color.white
  static let glass = Color(hex: 0xFAFAFA).opacity(0.92)
  static let noticeBg = Color(hex: 0xF5F5F5)
  static let noticeInk = Color(hex: 0x626264)
  static let warnBg = Color(hex: 0xFCF6ED)
  static let warnInk = Color(hex: 0x996126)
  static let positive = Color(hex: 0x527F3C)
  static let negative = Color(hex: 0xB95D60)
}

extension Color {
  init(hex: UInt32) {
    self.init(.sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1)
  }
}

// The glassy capsule/card look from v2 (.circle/.capsule/.search-bar/.composer).
struct GlassBackground: ViewModifier {
  var cornerRadius: CGFloat
  func body(content: Content) -> some View {
    content
      .background(Palette.glass, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(Color(hex: 0xE1E1E3), lineWidth: 1)
      )
  }
}

extension View {
  func glass(cornerRadius: CGFloat) -> some View { modifier(GlassBackground(cornerRadius: cornerRadius)) }
}
