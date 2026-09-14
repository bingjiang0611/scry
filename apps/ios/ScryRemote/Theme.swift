import SwiftUI

// v5 · Codex Refined. Neutral chrome keeps the conversation dominant; semantic
// colors are reserved for real connection/run evidence rather than decoration.
enum Palette {
  static let ink = Color(hex: 0x17181A)
  static let muted = Color(hex: 0x77787C)
  static let faint = Color(hex: 0xA6A7AA)
  static let line = Color(hex: 0xE8E8EB)
  static let blue = Color(hex: 0x2867E8)
  static let green = Color(hex: 0x3EAA72)
  static let amber = Color(hex: 0xB96F2D)
  static let canvas = Color(hex: 0xF4F4F5)
  static let surface = Color.white
  static let glass = Color(hex: 0xFBFBFC).opacity(0.96)
  static let noticeBg = Color(hex: 0xF5F5F6)
  static let noticeInk = Color(hex: 0x626367)
  static let warnBg = Color(hex: 0xFFF7ED)
  static let warnInk = Color(hex: 0x995B22)
  static let positive = Color(hex: 0x32825B)
  static let negative = Color(hex: 0xB84F55)
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

struct GlassBackground: ViewModifier {
  var cornerRadius: CGFloat
  func body(content: Content) -> some View {
    content
      .background(Palette.glass, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(Color(hex: 0xDEDFE3), lineWidth: 1)
      )
  }
}

extension View {
  func glass(cornerRadius: CGFloat) -> some View { modifier(GlassBackground(cornerRadius: cornerRadius)) }
}
