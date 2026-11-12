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
    case drawerOpen, drawerClose, reset, scroll, page, sheet
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

  static func arrival(reduceMotion: Bool) -> Animation {
    animation(.enter, reduceMotion: reduceMotion).delay(reduceMotion ? 0 : large * 0.5)
  }

  struct DrawerRelease {
    let velocity: CGFloat
    let remaining: CGFloat
  }

  static func drawerAnimation(open: Bool, release: DrawerRelease?, reduceMotion: Bool) -> Animation {
    if let release { return drawerRelease(velocity: release.velocity, remaining: release.remaining, reduceMotion: reduceMotion) }
    return animation(open ? .drawerOpen : .drawerClose, reduceMotion: reduceMotion)
  }

  static func drawerRelease(velocity: CGFloat, remaining: CGFloat, reduceMotion: Bool) -> Animation {
    if reduceMotion { return easeOut(duration: reducedDuration) }
    let initialVelocity = abs(remaining) > 0.001 ? velocity / remaining : 0
    return .interpolatingSpring(duration: 0.38, bounce: 0.12, initialVelocity: initialVelocity)
  }

  static func rowDelay(index: Int) -> Double {
    Double(min(max(index, 0), 9)) * 0.016
  }
}

// Pure gesture geometry, also exercised by the offline motion check.
enum DrawerPosition {
  static func progress(origin: CGFloat, translation: CGFloat, width: CGFloat) -> CGFloat {
    min(1, max(0, origin + translation / width))
  }

  static func opens(origin: CGFloat, predictedTranslation: CGFloat, width: CGFloat) -> Bool {
    progress(origin: origin, translation: predictedTranslation, width: width) >= 0.5
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

#if os(iOS)
// Keep the system presenter, detents, interactive dismissal and accessibility.
// iOS 17 deliberately retains its existing presentation, as agreed for this feature.
private struct SourceZoom: ViewModifier {
  let id: AnyHashable
  let namespace: Namespace.ID
  let destination: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOS 18.0, *), !reduceMotion {
      if destination {
        content.navigationTransition(.zoom(sourceID: id, in: namespace))
      } else {
        content.matchedTransitionSource(id: id, in: namespace)
      }
    } else {
      content
    }
  }
}

extension View {
  @ViewBuilder func zoomSource(_ id: some Hashable, in namespace: Namespace.ID?) -> some View {
    if let namespace { modifier(SourceZoom(id: AnyHashable(id), namespace: namespace, destination: false)) }
    else { self }
  }

  func zoomDestination(_ id: some Hashable, in namespace: Namespace.ID) -> some View {
    modifier(SourceZoom(id: AnyHashable(id), namespace: namespace, destination: true))
  }
}
#endif

extension View {
  func listRowEntrance(index: Int, enabled: Bool = true) -> some View {
    modifier(ListRowEntrance(index: index, enabled: enabled))
  }
}
