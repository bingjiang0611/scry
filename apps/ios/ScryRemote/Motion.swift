import SwiftUI

// Shared timing contract. System navigation and sheets keep their native motion.
enum Motion {
  static let micro = 0.10
  static let fast = 0.16
  static let base = 0.22
  static let slow = 0.30

  enum Effect: CaseIterable {
    case press, select, tab, disclosureOpen, disclosureClose, rowIn, streamIn, sheet
  }

  static func easeOut(duration: Double) -> Animation {
    .timingCurve(0.23, 1, 0.32, 1, duration: duration)
  }

  static func easeStruct(duration: Double) -> Animation {
    .timingCurve(0.32, 0.72, 0, 1, duration: duration)
  }

  static func easeExit(duration: Double) -> Animation {
    .timingCurve(0.4, 0, 1, 1, duration: duration)
  }

  static func animation(_ effect: Effect, reduceMotion: Bool) -> Animation {
    if reduceMotion { return .linear(duration: 0.12) }
    switch effect {
    case .press: return .linear(duration: micro)
    case .select: return easeOut(duration: fast)
    case .tab: return easeStruct(duration: base)
    case .disclosureOpen: return easeStruct(duration: 0.24)
    case .disclosureClose: return easeExit(duration: fast)
    case .rowIn: return easeOut(duration: base)
    case .streamIn: return easeOut(duration: 0.18)
    case .sheet: return easeStruct(duration: slow)
    }
  }

  static func transition(_ effect: Effect, reduceMotion: Bool) -> AnyTransition {
    if reduceMotion { return .opacity }
    switch effect {
    case .rowIn, .streamIn: return .opacity.combined(with: .offset(y: 4))
    case .sheet: return .opacity.combined(with: .move(edge: .bottom))
    case .press: return .opacity.combined(with: .scale(scale: 0.98))
    case .select, .tab, .disclosureOpen, .disclosureClose: return .opacity
    }
  }

  static func rowDelay(index: Int) -> Double {
    Double(min(max(index, 0), 9)) * 0.016
  }
}

private struct ListRowEntrance: ViewModifier {
  let index: Int
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var appeared = false

  func body(content: Content) -> some View {
    content
      .opacity(appeared ? 1 : 0)
      .offset(y: appeared || reduceMotion ? 0 : 4)
      .onAppear {
        // Stable row identity preserves this state across refreshes/reappearances.
        guard !appeared else { return }
        withAnimation(Motion.animation(.rowIn, reduceMotion: reduceMotion)
          .delay(reduceMotion ? 0 : Motion.rowDelay(index: index))) {
          appeared = true
        }
      }
  }
}

extension View {
  func listRowEntrance(index: Int) -> some View { modifier(ListRowEntrance(index: index)) }
}
