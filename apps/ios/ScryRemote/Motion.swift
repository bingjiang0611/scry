import SwiftUI

// Shared timing contract. System navigation and sheets keep their native motion.
enum Motion {
  static let hover = 0.12
  static let small = 0.20
  static let medium = 0.25
  static let large = 0.40
  static let exitSmall = 0.15
  static let exitMedium = 0.20
  static let reducedDuration = 0.15
  static let overshoot = 0.30
  static let fade: AnyTransition = .opacity
  static let none: AnyTransition = .identity

  enum Effect: CaseIterable {
    case press, select, confirm, enter, exit, tab, reorder
    case disclosureOpen, disclosureClose, chevron, rowIn, streamIn
    case drawerOpen, drawerClose, drawerRelease, reset, scroll, page, sheet
  }

  static func easeOut(duration: Double) -> Animation {
    .timingCurve(0, 0, 0.58, 1, duration: duration)
  }

  static func easeOutStrong(duration: Double) -> Animation {
    .timingCurve(0.22, 1, 0.36, 1, duration: duration)
  }

  static func easeIn(duration: Double) -> Animation {
    .timingCurve(0.42, 0, 1, 1, duration: duration)
  }

  static func easeInOut(duration: Double) -> Animation {
    .timingCurve(0.42, 0, 0.58, 1, duration: duration)
  }

  static func easeOvershoot(duration: Double) -> Animation {
    .timingCurve(0.34, 1.56, 0.64, 1, duration: duration)
  }

  static func animation(_ effect: Effect, reduceMotion: Bool) -> Animation {
    if reduceMotion { return easeOut(duration: reducedDuration) }
    switch effect {
    case .press: return easeOut(duration: hover)
    case .select, .chevron: return easeOutStrong(duration: small)
    case .confirm: return easeOvershoot(duration: overshoot)
    case .enter, .rowIn, .streamIn: return easeOut(duration: small)
    case .exit: return easeIn(duration: exitSmall)
    case .tab: return easeInOut(duration: small)
    case .reorder, .reset, .scroll: return easeInOut(duration: medium)
    case .disclosureOpen: return easeOut(duration: small)
    case .disclosureClose: return easeIn(duration: exitSmall)
    case .drawerOpen: return easeOut(duration: medium)
    case .drawerClose: return easeIn(duration: exitMedium)
    // SwiftUI owns the spring; this call path has no release-velocity input.
    case .drawerRelease: return .spring(duration: 0.38, bounce: 0.12)
    case .page, .sheet: return easeOut(duration: large)
    }
  }

  static func transition(_ effect: Effect, reduceMotion: Bool) -> AnyTransition {
    if reduceMotion { return .opacity }
    switch effect {
    case .rowIn, .streamIn: return .opacity.combined(with: .offset(y: 4))
    case .sheet: return .opacity.combined(with: .move(edge: .bottom))
    case .press: return .opacity.combined(with: .scale(scale: 0.98))
    default: return .opacity
    }
  }

  static func rowDelay(index: Int) -> Double {
    Double(min(max(index, 0), 9)) * 0.016
  }
}

private struct ListRowEntrance: ViewModifier {
  let index: Int
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var appeared: Bool

  init(index: Int, enabled: Bool) {
    self.index = index
    _appeared = State(initialValue: !enabled)
  }

  func body(content: Content) -> some View {
    content
      .opacity(appeared ? 1 : 0)
      .offset(y: appeared || reduceMotion ? 0 : 4)
      .onAppear {
        // The owner disables entrance for previously seen IDs after lazy-row recycling.
        guard !appeared else { return }
        withAnimation(Motion.animation(.rowIn, reduceMotion: reduceMotion)
          .delay(reduceMotion ? 0 : Motion.rowDelay(index: index))) {
          appeared = true
        }
      }
  }
}

extension View {
  func listRowEntrance(index: Int, enabled: Bool = true) -> some View {
    modifier(ListRowEntrance(index: index, enabled: enabled))
  }
}
