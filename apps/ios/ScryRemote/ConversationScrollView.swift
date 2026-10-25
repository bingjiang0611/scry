import SwiftUI

// A shared reader policy: streamed output follows the bottom until the reader
// scrolls up. New chunks must not steal their reading position.
struct ConversationScrollView<Content: View>: View {
  let revision: String
  var stopFollowingRequest: Int = 0
  var followLatestRequest: Int = 0
  var onFollowingChange: (Bool) -> Void = { _ in }
  @ViewBuilder let content: () -> Content
  @State private var following = true
  @State private var browsingOlder = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { viewport in
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 18) {
            content()
            Color.clear.frame(height: 1).id("bottom")
              .background(GeometryReader { geometry in
                Color.clear.preference(key: ConversationBottom.self,
                  value: geometry.frame(in: .named("conversation-scroll")).maxY)
              })
          }
          .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 10)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { _ in
            // Read the committed lazy-layout height, not a background reader's
            // placeholder size, then scroll after the new layout is installed.
            DispatchQueue.main.async {
              if following { proxy.scrollTo("bottom", anchor: .bottom) }
            }
          }
        }
        .coordinateSpace(name: "conversation-scroll")
        .defaultScrollAnchor(following ? .bottom : nil)
        .accessibilityIdentifier("conversation-scroll")
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .simultaneousGesture(DragGesture().onChanged { value in
          if value.translation.height > 8 { following = false }
          if value.translation.height < -8 { browsingOlder = false }
        })
        .onPreferenceChange(ConversationBottom.self) { bottom in
          if !browsingOlder && bottom > 0 && bottom <= viewport.size.height + 30 { following = true }
        }
        .onAppear {
          browsingOlder = false
          following = true
          DispatchQueue.main.async { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .onChange(of: following, initial: true) { _, value in onFollowingChange(value) }
        .onChange(of: stopFollowingRequest) { browsingOlder = true; following = false }
        .onChange(of: followLatestRequest) {
          browsingOlder = false
          following = true
          proxy.scrollTo("bottom", anchor: .bottom)
        }
        .onChange(of: revision) {
          if following { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .onChange(of: viewport.size.height) {
          if following { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .overlay(alignment: .bottomTrailing) {
          if !following {
            Button {
              browsingOlder = false
              following = true
              withAnimation(reduceMotion ? nil : Motion.animation(.select, reduceMotion: false)) { proxy.scrollTo("bottom", anchor: .bottom) }
            } label: {
              Label(ConnectionCopy.returnToLatest, systemImage: "arrow.down")
                .font(.system(size: 13, weight: .semibold)).padding(.horizontal, 14).frame(minHeight: 44)
                .background(Palette.surface, in: Capsule())
                .overlay(Capsule().stroke(Palette.line))
            }
            .buttonStyle(.plain).padding(12)
          }
        }
      }
    }
  }
}

private struct ConversationBottom: PreferenceKey {
  static var defaultValue: CGFloat = .infinity
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
