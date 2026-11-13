import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// Presentation only: routes, drafts and transport still change exactly once.
@Observable final class ConversationTransition {
  enum Destination: Equatable {
    case session(RemoteRunStore.SessionIdentity)
    case submission(RemoteRunStore.SessionIdentity)
  }

  enum Element: Hashable {
    case sessionTitle(RemoteRunStore.SessionIdentity)
    case sessionProvider(RemoteRunStore.SessionIdentity)
    case submittedText, submittedAttachment(Int), composerSurface
  }

  private(set) var destination: Destination?
  private(set) var ticket: UUID?
  // Navigation focus survives reduced motion and visual-flight cleanup.
  private(set) var focusDestination: Destination?

  func begin(_ destination: Destination, reduceMotion: Bool) {
    cancel()
    focusDestination = destination
    guard !reduceMotion else { return }
    #if canImport(UIKit)
    captureSources(for: destination)
    #endif
    self.destination = destination
    ticket = UUID()
  }

  func cancel() {
    destination = nil
    ticket = nil
    #if canImport(UIKit)
    flights.removeAll()
    #endif
  }

  func contains(_ element: Element, route: Route) -> Bool {
    switch (destination, element, route) {
    case let (.session(expected), .sessionTitle(actual), .transcript),
         let (.session(expected), .sessionProvider(actual), .transcript):
      return expected == actual
    case (.submission, .submittedText, .chat), (.submission, .submittedAttachment, .chat),
         (.submission, .composerSurface, .chat): return true
    default: return false
    }
  }

  func accepts(_ identity: RemoteRunStore.SessionIdentity?) -> Bool {
    guard case let .submission(expected) = destination else { return false }
    return expected == identity
  }

  #if canImport(UIKit)
  struct Flight: Identifiable {
    let id: Element
    let image: UIImage
    let from: CGRect
    var to: CGRect?
    var revealed = false
  }

  private struct Source {
    let owner: UUID
    let frame: CGRect
    let render: () -> UIImage?
  }

  // Mounted, on-screen elements only; disappearance removes their registration.
  @ObservationIgnored private var sources: [Element: Source] = [:]
  private(set) var flights: [Element: Flight] = [:]

  private static var window: UIWindow? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows).first(where: \.isKeyWindow)
  }

  func register(_ element: Element, owner: UUID, frame: CGRect, render: @escaping () -> UIImage?) {
    guard let window = Self.window, frame.width > 0, frame.height > 0,
          window.bounds.contains(frame) else {
      removeSource(element, owner: owner)
      return
    }
    sources[element] = Source(owner: owner, frame: frame, render: render)
  }

  func removeSource(_ element: Element, owner: UUID) {
    if sources[element]?.owner == owner { sources.removeValue(forKey: element) }
  }

  private func captureSources(for destination: Destination) {
    guard let window = Self.window else { return }
    let candidates = sources.filter { element, _ in
      switch (destination, element) {
      case let (.session(expected), .sessionTitle(actual)), let (.session(expected), .sessionProvider(actual)):
        return expected == actual
      case (.submission, .submittedText), (.submission, .submittedAttachment), (.submission, .composerSurface): return true
      default: return false
      }
    }
    // Capture actual visible editor/thumbnail pixels once. No duplicate binding,
    // second attachment decoder, disk write or second screen lifecycle is used.
    var screen: UIImage?
    if !candidates.isEmpty {
      var drawn = false
      let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
        drawn = window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
      }
      if drawn { screen = image }
    }
    for (element, source) in candidates {
      let image: UIImage?
      switch element {
      case .composerSurface: image = source.render()
      default:
        if let screen, let cgImage = screen.cgImage {
          let pixels = source.frame.applying(CGAffineTransform(scaleX: screen.scale, y: screen.scale))
          image = cgImage.cropping(to: pixels).map { UIImage(cgImage: $0, scale: screen.scale, orientation: .up) }
        } else { image = nil }
      }
      if let image { flights[element] = Flight(id: element, image: image, from: source.frame) }
    }
  }

  func measureDestination(_ element: Element, frame: CGRect) {
    guard frame.width > 0, frame.height > 0, flights[element]?.to != frame else { return }
    flights[element]?.to = frame
  }

  func reveal(_ element: Element, ticket: UUID) {
    guard self.ticket == ticket else { return }
    flights[element]?.revealed = true
  }

  func finish(_ element: Element, ticket: UUID) {
    guard self.ticket == ticket else { return }
    flights.removeValue(forKey: element)
    if flights.isEmpty { cancel() }
  }
  #endif
}

struct ConversationTransitionContext {
  let state: ConversationTransition
  let route: Route
}

private struct ConversationTransitionKey: EnvironmentKey {
  static let defaultValue: ConversationTransitionContext? = nil
}

private struct SubmittedTurnKey: EnvironmentKey {
  static let defaultValue: RemoteRunStore.SessionIdentity? = nil
}

extension EnvironmentValues {
  var conversationTransition: ConversationTransitionContext? {
    get { self[ConversationTransitionKey.self] }
    set { self[ConversationTransitionKey.self] = newValue }
  }

  // Set on the focused turn only, never on all messages in the reader.
  var submittedTurn: RemoteRunStore.SessionIdentity? {
    get { self[SubmittedTurnKey.self] }
    set { self[SubmittedTurnKey.self] = newValue }
  }
}

#if canImport(UIKit)
struct ConversationTransitionOverlay: View {
  let state: ConversationTransition

  var body: some View {
    GeometryReader { geometry in
      if let ticket = state.ticket {
        ForEach(Array(state.flights.values)) { flight in
          ConversationFlight(state: state, flight: flight, ticket: ticket,
                             origin: geometry.frame(in: .global).origin)
            .id("\(ticket)-\(flight.id)")
            .zIndex(flight.id == .composerSurface ? 0 : 1)
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

private struct ConversationFlight: View {
  let state: ConversationTransition
  let flight: ConversationTransition.Flight
  let ticket: UUID
  let origin: CGPoint
  @State private var presented: CGRect?
  @State private var hidden = false

  @ViewBuilder private var pixels: some View {
    switch flight.id {
    case .composerSurface: Image(uiImage: flight.image).resizable()
    case .sessionTitle, .submittedText:
      // Keep glyph size while the container changes; do not squash one editor
      // line into a narrower multiline message. Real text takes over at arrival.
      Image(uiImage: flight.image)
    default: Image(uiImage: flight.image).resizable().scaledToFit()
    }
  }

  var body: some View {
    let rect = presented ?? flight.from
    pixels
      .frame(width: rect.width, height: rect.height, alignment: .topLeading)
      .clipped()
      .position(x: rect.midX - origin.x, y: rect.midY - origin.y)
      .opacity(hidden ? 0 : 1)
      .task(id: flight.to) {
        guard let target = flight.to, !flight.revealed else { return }
        // Only this persistent inert layer animates, never the replaced route,
        // keyboard or TextField layout (root animation loops on iOS 26.5).
        withAnimation(Motion.animation(.page, reduceMotion: false)) { presented = target } completion: {
          // Streaming/layout can move the real destination during the flight.
          // Only the latest target may hand pixels back to the actual element.
          guard state.ticket == ticket, state.flights[flight.id]?.to == target else { return }
          state.reveal(flight.id, ticket: ticket)
          withAnimation(Motion.animation(.exit, reduceMotion: false)) { hidden = true } completion: {
            state.finish(flight.id, ticket: ticket)
          }
        }
      }
  }
}

private struct ConversationSharedElement: ViewModifier {
  let element: ConversationTransition.Element?
  let submissionDestination: Bool
  let source: Bool
  let captures: Bool
  let revision: String
  let snapshot: AnyView?
  @State private var frame = CGRect.zero
  @State private var sourceOwner = UUID()
  @Environment(\.conversationTransition) private var context
  @Environment(\.submittedTurn) private var submittedTurn
  @Environment(\.colorScheme) private var colorScheme

  @ViewBuilder func body(content: Content) -> some View {
    if let context, let element {
      let eligible = !submissionDestination || context.state.accepts(submittedTurn)
      let active = !source && eligible && context.state.contains(element, route: context.route)
      let hidden = active && context.state.flights[element]?.revealed == false
      content
        .opacity(hidden ? 0 : 1)
        .animation(Motion.animation(.exit, reduceMotion: false), value: hidden)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { value in
          frame = value
          if source { register(context: context, element: element, frame: value) }
          else if active { context.state.measureDestination(element, frame: value) }
        }
        .onChange(of: active) { _, active in
          if active { context.state.measureDestination(element, frame: frame) }
        }
        .onChange(of: element) { previous, current in
          // Removing an earlier attachment reuses this view with a new index.
          // Its old registration must not survive as a second, stale source.
          if source {
            context.state.removeSource(previous, owner: sourceOwner)
            register(context: context, element: current, frame: frame)
          } else if active { context.state.measureDestination(current, frame: frame) }
        }
        .onChange(of: captures) { _, _ in
          if source { register(context: context, element: element, frame: frame) }
        }
        .onChange(of: revision) { _, _ in
          if source { register(context: context, element: element, frame: frame) }
        }
        .onChange(of: colorScheme) { _, _ in
          if source { register(context: context, element: element, frame: frame) }
        }
        .onDisappear { if source { context.state.removeSource(element, owner: sourceOwner) } }
    } else { content }
  }

  private func register(context: ConversationTransitionContext, element: ConversationTransition.Element, frame: CGRect) {
    guard captures else { context.state.removeSource(element, owner: sourceOwner); return }
    guard context.route == .home || context.route == .newSession else { return }
    let snapshot = snapshot
    let colorScheme = colorScheme
    context.state.register(element, owner: sourceOwner, frame: frame) {
      // The caller may supply an inert surface, never a ViewModifier.Content
      // proxy (which cannot render outside its original SwiftUI graph).
      guard let snapshot else { return nil }
      let renderer = ImageRenderer(content: snapshot.environment(\.colorScheme, colorScheme)
        .frame(width: frame.width, height: frame.height))
      renderer.scale = UIScreen.main.scale
      return renderer.uiImage
    }
  }
}

private struct ConversationArrival: ViewModifier {
  @Environment(\.conversationTransition) private var context
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var revealed = false

  private var arriving: Bool {
    switch (context?.state.destination, context?.route) {
    case (.session, .transcript), (.submission, .chat): return true
    default: return false
    }
  }

  func body(content: Content) -> some View {
    content.opacity(arriving && !revealed ? 0 : 1)
      .task {
        withAnimation(Motion.arrival(reduceMotion: reduceMotion)) { revealed = true }
      }
  }
}

extension View {
  func conversationArrival() -> some View { modifier(ConversationArrival()) }

  func conversationElement(_ element: ConversationTransition.Element?, source: Bool = true,
                           captures: Bool = true, revision: String = "", snapshot: AnyView? = nil) -> some View {
    modifier(ConversationSharedElement(element: element, submissionDestination: false, source: source,
      captures: captures, revision: revision, snapshot: snapshot))
  }

  func submittedElement(_ element: ConversationTransition.Element) -> some View {
    modifier(ConversationSharedElement(element: element, submissionDestination: true, source: false,
      captures: false, revision: "", snapshot: nil))
  }
}
#endif
