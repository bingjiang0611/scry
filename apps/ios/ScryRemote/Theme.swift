import SwiftUI

// Reference-led dark workbench. Semantic accents describe real evidence;
// neutral surfaces keep the transcript, not the chrome, dominant.
enum Palette {
  static let ink = Color(hex: 0xE8E7E4)
  static let muted = Color(hex: 0xA6A5A0)
  static let faint = Color(hex: 0x858580)
  static let line = Color(hex: 0x2B2B29)
  static let blue = Color(hex: 0x86ACF4)
  static let green = Color(hex: 0x75C79A)
  static let amber = Color(hex: 0xD5AA72)
  static let canvas = Color(hex: 0x1C1C1A)
  static let surface = Color(hex: 0x121210)
  static let message = Color(hex: 0x252422)
  static let glass = Color(hex: 0x1C1C1A).opacity(0.96)
  static let noticeBg = canvas
  static let noticeInk = muted
  static let warnBg = Color(hex: 0x30271C)
  static let warnInk = Color(hex: 0xE8BA80)
  static let positive = green
  static let negative = Color(hex: 0xE68C90)
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
          .strokeBorder(Palette.line, lineWidth: 1)
      )
  }
}

extension View {
  func glass(cornerRadius: CGFloat) -> some View { modifier(GlassBackground(cornerRadius: cornerRadius)) }
}
