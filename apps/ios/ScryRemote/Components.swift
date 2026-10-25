import SwiftUI

// MARK: - Symbols

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
  static let photo = "photo"
  static let bell = "bell"
  static let chevrons = "chevron.up.chevron.down"
  static let chevron = "chevron.right"
  static let check = "checkmark"
  static let gear = "gearshape"
  static let link = "link"
  static let pin = "pin"
  static let archive = "archivebox"
  static let tray = "tray.full"
  static let chart = "chart.bar"
  static let gaugeSpeed = "speedometer"
  static let plug = "powerplug"
  static let hand = "hand.raised"
}

// MARK: - Core controls

struct CircleButton: View {
  let symbol: String
  let label: String
  var filled = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: filled ? 18 : 17, weight: .medium))
        .frame(width: filled ? 46 : 44, height: filled ? 46 : 44)
        .foregroundStyle(filled ? Palette.surface : Palette.ink)
        .background(filled ? AnyShapeStyle(Palette.blue) : AnyShapeStyle(Color.clear), in: Circle())
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.34 : 1)
    .accessibilityLabel(label)
  }
}

/// Header overflow actions keep their native menu behavior and 44pt label area.
struct MoreMenu<Content: View>: View {
  var label = ConnectionCopy.more
  @ViewBuilder var content: () -> Content

  var body: some View {
    Menu(content: content) {
      Image(systemName: Symbol.more)
        .font(.system(size: 17, weight: .medium))
        .frame(width: 44, height: 44)
    }
    .accessibilityLabel(label)
  }
}

struct PlainIcon: View {
  let symbol: String
  let label: String
  var tint: Color = Palette.ink
  var disabled = false
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 17, weight: .medium))
        .frame(minWidth: 44, minHeight: 44)
        .foregroundStyle(tint)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.34 : 1)
    .accessibilityLabel(label)
  }
}

struct Notice: View {
  let text: String
  var warning = false
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: warning ? "exclamationmark.circle" : "info.circle")
        .font(.system(size: 13, weight: .medium)).padding(.top, 1)
      Text(text).font(.system(size: 12)).frame(maxWidth: .infinity, alignment: .leading)
    }
    .foregroundStyle(warning ? Palette.warnInk : Palette.noticeInk)
    .padding(.vertical, 10).padding(.horizontal, 12)
    .background(warning ? Palette.warnBg : Palette.noticeBg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 16).padding(.bottom, 9)
  }
}

struct EmptyState: View {
  let title: String
  let detail: String
  var symbol: String = "bubble.left.and.bubble.right"
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: symbol).font(.system(size: 27, weight: .light)).foregroundStyle(Palette.faint)
      Text(title).font(.system(size: 16, weight: .semibold)).multilineTextAlignment(.center)
      Text(detail).font(.system(size: 13)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 54).padding(.horizontal, 26)
  }
}

struct StatusDot: View {
  let link: HostLink
  var body: some View { Circle().fill(color).frame(width: 7, height: 7) }
  private var color: Color {
    switch link {
    case .connected: return Palette.green
    case .pairing: return Palette.amber
    case .notPaired, .offline: return Palette.faint
    }
  }
}

struct RemoteHeader<Right: View>: View {
  let title: String
  var subtitle: String?
  var link: HostLink?
  var titleLineLimit = 1
  var backAction: (() -> Void)?
  var menuAction: (() -> Void)?
  @ViewBuilder let right: () -> Right

  var body: some View {
    HStack(spacing: 10) {
      CircleButton(symbol: backAction == nil ? Symbol.menu : Symbol.back,
                   label: backAction == nil ? ConnectionCopy.openMenu : ConnectionCopy.back) {
        if let backAction { backAction() } else { menuAction?() }
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.system(size: 17, weight: .semibold)).lineLimit(titleLineLimit)
          .fixedSize(horizontal: false, vertical: true)
        if let subtitle {
          HStack(spacing: 5) {
            if let link { StatusDot(link: link) }
            Text(subtitle).lineLimit(titleLineLimit == 1 ? 1 : 2)
          }
          .font(.system(size: 11.5)).foregroundStyle(Palette.muted)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      right()
        .frame(minWidth: 44, minHeight: 44)
    }
    .padding(.horizontal, 10).padding(.vertical, 6)
    .frame(minHeight: 56)
    .background(Palette.surface)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 0.5) }
    .zIndex(2)
  }
}

extension RemoteHeader where Right == EmptyView {
  init(title: String, subtitle: String? = nil, link: HostLink? = nil, titleLineLimit: Int = 1,
       backAction: (() -> Void)? = nil, menuAction: (() -> Void)? = nil) {
    self.title = title; self.subtitle = subtitle; self.link = link; self.titleLineLimit = titleLineLimit
    self.backAction = backAction; self.menuAction = menuAction
    self.right = { EmptyView() }
  }
}
