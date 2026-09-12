import SwiftUI

// SF Symbols chosen to match the v2 line-icon set. Presentation only.
enum Symbol {
  static let menu = "line.3.horizontal"
  static let more = "ellipsis"
  static let laptop = "laptopcomputer"
  static let folder = "folder"
  static let branch = "arrow.triangle.branch"
  static let compose = "square.and.pencil"
  static let search = "magnifyingglass"
  static let plus = "plus"
  static let shield = "checkmark.shield"
  static let gauge = "gauge.with.dots.needle.33percent"
  static let send = "arrow.up"
  static let back = "chevron.left"
  static let agent = "cpu"
  static let file = "doc.text"
  static let bell = "bell"
  static let chevrons = "chevron.up.chevron.down"
}

// Round 44pt glass icon button (v2 .circle).
struct CircleButton: View {
  let symbol: String
  let label: String
  var filled = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 19, weight: .medium))
        .frame(width: filled ? 48 : 44, height: filled ? 48 : 44)
        .foregroundStyle(filled ? Color.white : Palette.ink)
        .background {
          if filled {
            Circle().fill(Palette.blue)
          } else {
            Circle().fill(Palette.glass).overlay(Circle().strokeBorder(Color(hex: 0xE1E1E3), lineWidth: 1))
          }
        }
    }
    .disabled(disabled)
    .opacity(disabled ? 0.36 : 1)
    .accessibilityLabel(label)
  }
}

// Flat toolbar icon (v2 .plain-icon).
struct PlainIcon: View {
  let symbol: String
  let label: String
  var tint: Color = Palette.ink
  var disabled = false
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 18, weight: .medium))
        .frame(minWidth: 44, minHeight: 44)
        .foregroundStyle(tint)
    }
    .disabled(disabled)
    .opacity(disabled ? 0.36 : 1)
    .accessibilityLabel(label)
  }
}

// v2 .notice / .notice.warning — always truthful, never a fake success banner.
struct Notice: View {
  let text: String
  var warning = false
  var body: some View {
    Text(text)
      .font(.system(size: 12))
      .foregroundStyle(warning ? Palette.warnInk : Palette.noticeInk)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 9)
      .padding(.horizontal, 11)
      .background(warning ? Palette.warnBg : Palette.noticeBg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .padding(.horizontal, 16)
      .padding(.bottom, 9)
  }
}

// v2 .empty
struct EmptyState: View {
  let title: String
  let detail: String
  var body: some View {
    VStack(spacing: 8) {
      Text(title).font(.system(size: 15)).multilineTextAlignment(.center)
      Text(detail).font(.system(size: 12)).foregroundStyle(Color(hex: 0x919194)).multilineTextAlignment(.center)
    }
    .foregroundStyle(Color(hex: 0x919194))
    .frame(maxWidth: .infinity)
    .padding(.vertical, 60)
    .padding(.horizontal, 20)
  }
}

// v2 host-caption status dot.
struct StatusDot: View {
  let link: HostLink
  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 6, height: 6)
  }
  private var color: Color {
    switch link {
    case .connected: return Palette.green
    case .pairing, .notPaired: return Color(hex: 0xAAAAAA)
    case .offline: return Color(hex: 0xAAAAAA)
    }
  }
}

// v2 .evidence-chip
struct EvidenceChip: View {
  let symbol: String?
  let text: String
  var body: some View {
    HStack(spacing: 7) {
      if let symbol { Image(systemName: symbol).font(.system(size: 12)) }
      Text(text).font(.system(size: 12))
    }
    .foregroundStyle(Color(hex: 0x67676A))
    .padding(.vertical, 4)
    .padding(.horizontal, 12)
    .frame(minHeight: 32)
    .glass(cornerRadius: 22)
  }
}
