import SwiftUI

#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// Shared Mac/iOS semantics; accents describe evidence, not inferred status.
enum Palette {
  static let bg = adaptive(dark: 0x151515, light: 0xF7F7F5)
  static let sidebar = adaptive(dark: 0x181818, light: 0xF7F7F5)
  static let main = adaptive(dark: 0x1C1C1C, light: 0xFFFFFF)
  static let panel = adaptive(dark: 0x1C1C1C, light: 0xFFFFFF)
  static let panel2 = adaptive(dark: 0x232323, light: 0xF6F6F3)
  static let panel3 = adaptive(dark: 0x2B2B2B, light: 0xEEEEEB)
  static let border = adaptive(dark: 0x333331, light: 0xE4E4DF)
  static let border2 = adaptive(dark: 0x454541, light: 0xD3D3CD)
  static let border3 = adaptive(dark: 0x292927, light: 0xEEEEEA)
  static let fg = adaptive(dark: 0xF1F1EF, light: 0x222220)
  static let dim = adaptive(dark: 0xB5B5AF, light: 0x62625E)
  static let dim2 = adaptive(dark: 0x8D8D87, light: 0x62625E)
  static let accent = adaptive(dark: 0x5B9CFF, light: 0x3F7EE8)
  static let accentText = adaptive(dark: 0x5B9CFF, light: 0x2C64CC)
  static let warnText = adaptive(dark: 0xEFB958, light: 0x7F5409)
  static let accentFill = adaptive(dark: 0x2F6AD8, light: 0x2F6AD8)
  static let onAccent = adaptive(dark: 0xFFFFFF, light: 0xFFFFFF)
  static let accentSoft = adaptive(dark: 0x5B9CFF, light: 0x3F7EE8, darkAlpha: 0.12, lightAlpha: 0.09)
  static let ok = adaptive(dark: 0x69CC93, light: 0x18794E)
  static let warn = adaptive(dark: 0xEFB958, light: 0x94620B)
  static let bad = adaptive(dark: 0xF36C67, light: 0xBF3F3A)
  static let hover = adaptive(dark: 0xFFFFFF, light: 0x222220, darkAlpha: 0.06, lightAlpha: 0.05)
  static let subtle = adaptive(dark: 0xFFFFFF, light: 0x222220, darkAlpha: 0.04, lightAlpha: 0.038)
  static let providerClaude = adaptive(dark: 0xD37EC8, light: 0xA15397)
  static let providerCodex = adaptive(dark: 0x6AA8FF, light: 0x3F72B7)
  static let providerQoder = adaptive(dark: 0xEFA84F, light: 0x9B6206)
  static let providerOpenCode = adaptive(dark: 0x70CA93, light: 0x28744A)
  static let providerPi = adaptive(dark: 0xAB9CF2, light: 0x6A5FAE)

  static func provider(_ id: String) -> Color {
    switch id {
    case "claude": return providerClaude
    case "codex": return providerCodex
    case "qoder": return providerQoder
    case "opencode": return providerOpenCode
    case "pi": return providerPi
    default: return dim2
    }
  }

  private static func adaptive(dark: UInt32, light: UInt32, darkAlpha: CGFloat = 1, lightAlpha: CGFloat = 1) -> Color {
    #if canImport(UIKit)
    return Color(uiColor: UIColor { traits in
      let isDark = traits.userInterfaceStyle == .dark
      let hex = isDark ? dark : light
      return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255,
                     green: CGFloat((hex >> 8) & 0xFF) / 255,
                     blue: CGFloat(hex & 0xFF) / 255, alpha: isDark ? darkAlpha : lightAlpha)
    })
    #else
    // The existing offline checks compile this shared file on macOS.
    return Color(nsColor: NSColor(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      let hex = isDark ? dark : light
      return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                     green: CGFloat((hex >> 8) & 0xFF) / 255,
                     blue: CGFloat(hex & 0xFF) / 255, alpha: isDark ? darkAlpha : lightAlpha)
    })
    #endif
  }
}

// Semantic text styles keep Dynamic Type.
enum Typography {
  static let reply: Font = .callout
  static let replyLineSpacing: CGFloat = 5
  static let bubble: Font = .callout
  static let rowTitle: Font = .subheadline
  static let headerTitle: Font = .subheadline.weight(.semibold)
  static let groupLabel: Font = .footnote.weight(.semibold)
  static let meta: Font = .caption
  static let mono: Font = .system(.footnote, design: .monospaced)
  static let codeBlock: Font = .system(.caption, design: .monospaced)
  static let sheetTitle: Font = .headline
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
      .background(Palette.panel, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(Palette.border, lineWidth: 1)
      )
  }
}

extension View {
  func glass(cornerRadius: CGFloat) -> some View { modifier(GlassBackground(cornerRadius: cornerRadius)) }
}
