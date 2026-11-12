import SwiftUI
import RemoteTransport
#if canImport(UIKit)
import UIKit
#endif

// Launch lands here: the page is "new session" and the session list is a left
// drawer that is always collapsed when this page appears. `.home` and
// `.newSession` render the same shell, so `AppModel.Route` keeps meaning what it
// meant before; only `.newSession` raises the keyboard. Every session, project,
// Provider, run and freshness fact still comes from the paired host — the empty
// middle block is static copy, never invented data.
struct WorkspaceShell: View {
  /// `.newSession` asks the composer for the keyboard. `.home` (cold launch, or
  /// `goBack()` from a session/settings/tool panel) shows the page without it.
  let focusComposer: Bool

  @EnvironmentObject private var model: AppModel
  @Environment(ExecutionTargetCoordinator.self) private var targets
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var drawerOpen: Bool
  @State private var drawerProgress: CGFloat
  @State private var presentedProgress: CGFloat = 0
  @State private var dragOrigin: CGFloat?
  @GestureState private var dragging = false
  @State private var drawerRelease: Motion.DrawerRelease?
  @AccessibilityFocusState private var sidebarButtonFocused: Bool
  // A new-session request while the page is already shown must focus again; the
  // ticket changes so the composer cannot mistake a repeat request for no-op.
  @State private var focusTicket = 1
  @State private var showTargets = false
  @Namespace private var targetTransition

  init(focusComposer: Bool) {
    self.focusComposer = focusComposer
    #if DEBUG
    // Preview only: `-drawerOpen` starts with the drawer open for screenshots and
    // UI tests. It is not persisted and does not touch AppModel.
    let open = ProcessInfo.processInfo.arguments.contains("-drawerOpen")
    _drawerOpen = State(initialValue: open)
    _drawerProgress = State(initialValue: open ? 1 : 0)
    #else
    _drawerOpen = State(initialValue: false)
    _drawerProgress = State(initialValue: 0)
    #endif
  }

  // The page always shows the new-task run, independent of what the root injected
  // for `.home` (that stays the selected store for the waiting-decision banner).
  private var run: RemoteRunStore { targets.newTaskStore }
  private var paired: Bool {
    run.hasConnection && (targets.newTaskScope.isLocal || run.executionTargetAvailable)
  }
  // A persisted grant is a real pairing; reachability is only learned by an
  // exchange, so this label never claims more than "paired".
  private var displayHost: String {
    run.hasConnection ? targets.newTaskScope.label : ConnectionCopy.unconnected
  }

  var body: some View {
    GeometryReader { proxy in
      let width = min(proxy.size.width * 0.85, 340)
      ZStack(alignment: .leading) {
        page
        dimmer
        drawer(width: width)
      }
      .coordinateSpace(name: "workspace-drawer")
      .simultaneousGesture(drawerGesture(width: width))
    }
    .background(Palette.main)
    // The drawer's list is loaded on arrival, so the first look is complete
    // instead of empty-then-filling. Same calls the old home screen made.
    .task {
      targets.setHomeVisible(drawerOpen)
      if run.hasConnection {
        await targets.refreshHome()
        targets.newTaskStore.loadProjects()
        targets.newTaskStore.loadProviders()
        if !targets.homeSessions.isEmpty { await targets.localStore.refreshArchived() }
      }
    }
    .onChange(of: drawerOpen) { _, open in targets.setHomeVisible(open) }
    .onChange(of: dragging) { _, active in
      // GestureState also resets when a scroll view or the system cancels the drag.
      if !active, dragOrigin != nil { setDrawer(drawerOpen) }
    }
    .onDisappear { targets.setHomeVisible(false) }
    .sheet(isPresented: $showTargets) {
      targetPicker.zoomDestination("host", in: targetTransition)
    }
  }

  // MARK: - New session page (drawer collapsed)

  private var page: some View {
    VStack(spacing: 0) {
      topBar
      centerpiece
      NewSessionComposer(focusTicket: focusComposer ? focusTicket : nil)
    }
    .environment(run)
    // An open drawer is the only surface to read or touch: the page behind it
    // must not stay in the VoiceOver order.
    .accessibilityHidden(drawerOpen || dragOrigin != nil)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    // Without a hit test shape, the drag below only starts on the page's text and
    // controls: the empty middle of the page would ignore a left-edge swipe and
    // the drawer could not be opened from there (found on-device in L1b).
    .contentShape(Rectangle())

  }

  private var topBar: some View {
    HStack(spacing: 0) {
      Button { setDrawer(true) } label: {
        Image(systemName: Symbol.sidebar).font(.system(size: 22))
          .foregroundStyle(Palette.fg).frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(ConnectionCopy.openSidebar)
      .accessibilityIdentifier("sidebar-toggle")
      .accessibilityFocused($sidebarButtonFocused)
      Spacer(minLength: 4)
      hostChip
      Spacer(minLength: 4)
      Button { startNewSession(scope: targets.newTaskScope) } label: {
        Image(systemName: Symbol.compose).font(.system(size: 21))
          .foregroundStyle(Palette.fg).frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(ConnectionCopy.newSession)
    }
    .padding(.horizontal, 6)
    .frame(minHeight: 48)
  }

  // Same capsule as the drawer's host menu; here it picks the execution host the
  // composer will route to. Only host-authorized scopes are offered.
  private var hostChip: some View {
    Button { showTargets = true } label: {
      HStack(spacing: 7) {
        if targets.homeLoading {
          ProgressView().controlSize(.mini).accessibilityLabel(ConnectionCopy.refreshing)
        } else {
          Circle().fill(run.hasConnection ? Palette.ok : Palette.dim2).frame(width: 7, height: 7)
            .accessibilityHidden(true)
        }
        Text(displayHost).font(Typography.headerTitle).lineLimit(1)
        Image(systemName: Symbol.chevrons).font(Typography.meta).foregroundStyle(Palette.dim)
      }
      .foregroundStyle(Palette.fg)
      .padding(.horizontal, 14).frame(minHeight: 36)
      .background(Palette.panel2, in: Capsule())
      .zoomSource("host", in: targetTransition)
      .frame(minHeight: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(displayHost)
    .accessibilityHint(ConnectionCopy.selectExecutionHost)
  }

  private var centerpiece: some View {
    VStack(spacing: 10) {
      if paired {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(Palette.panel2)
          .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.border3) }
          .overlay { Image(systemName: Symbol.bubble).font(.system(size: 22)).foregroundStyle(Palette.dim) }
          .frame(width: 44, height: 44)
          .accessibilityHidden(true)
          .padding(.bottom, 6)
        Text(ConnectionCopy.newSession).font(.system(size: 22, weight: .semibold))
        Text(ConnectionCopy.newSessionHint).font(.system(size: 14)).foregroundStyle(Palette.dim)
      } else {
        // The reason the composer is disabled is the host's, not a generic
        // "offline": a forwarded target that never answered differs from no Mac.
        Notice(text: targets.newTaskScope.isLocal ? ConnectionCopy.noGatewayForNewTask : ConnectionCopy.targetUnavailable,
               warning: true)
      }
    }
    .multilineTextAlignment(.center)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(.horizontal, 40)
  }

  // MARK: - Drawer

  private var dimmer: some View {
    Color.black.opacity(0.28 * drawerProgress)
      .ignoresSafeArea()
      .contentShape(Rectangle())
      .onTapGesture { setDrawer(false) }
      .allowsHitTesting(drawerOpen || dragOrigin != nil)
      .accessibilityElement()
      .accessibilityAddTraits(.isButton)
      .accessibilityLabel(ConnectionCopy.closeSidebar)
      .accessibilityHidden(!drawerOpen)
      .animation(dragOrigin == nil ? Motion.drawerAnimation(open: drawerOpen, release: drawerRelease, reduceMotion: reduceMotion) : nil, value: drawerProgress)
  }

  private func drawer(width: CGFloat) -> some View {
    SidebarDrawer(onCollapse: { setDrawer(false) },
                  onNewSession: { scope, cwd in startNewSession(scope: scope, cwd: cwd) },
                  onOpenSettings: { setDrawer(false); model.route = .settings }, isPresented: drawerOpen)
      .environment(targets.localStore)
      // A horizontal drag moves the pressed button with the finger. Cancel its
      // press while dragging, otherwise releasing can also create/open a session.
      .disabled(dragOrigin != nil)
      .frame(width: width)
      // The panel edge and the page must not repaint the status bar or home
      // indicator area, so the surface extends through the vertical insets.
      .background {
        Palette.sidebar.ignoresSafeArea(edges: .vertical)
          .overlay(alignment: .trailing) { Rectangle().fill(Palette.border).frame(width: 0.5) }
      }
      .shadow(color: .black.opacity(0.10 * drawerProgress), radius: 30, x: 8)
      // Observe inside the offset: outside it SwiftUI reports the unchanged
      // layout box (minX == 0), which would make a closed drawer appear open.
      .onGeometryChange(for: CGFloat.self) { geometry in
        1 + geometry.frame(in: .named("workspace-drawer")).minX / width
      } action: { presentedProgress = $0 }
      .offset(x: reduceMotion ? 0 : (drawerProgress - 1) * width)
      // Normal motion moves an opaque panel; only Reduce Motion fades its surface.
      .opacity(reduceMotion ? drawerProgress : 1)
      .animation(dragOrigin == nil ? Motion.drawerAnimation(open: drawerOpen, release: drawerRelease, reduceMotion: reduceMotion) : nil, value: drawerProgress)
      .allowsHitTesting(drawerOpen || dragOrigin != nil)
      .accessibilityHidden(!drawerOpen)
  }

  private func drawerGesture(width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 10)
      .updating($dragging) { _, active, _ in active = true }
      .onChanged { value in
        if dragOrigin == nil {
          let visible = reduceMotion ? drawerProgress : presentedProgress
          guard (visible > 0 ? value.startLocation.x <= width * visible : value.startLocation.x <= 24),
                abs(value.translation.width) > abs(value.translation.height) * 1.35 else { return }
          // A closing panel can be grabbed anywhere it is still visible, not
          // only at the edge used to open a fully closed drawer.
          dragOrigin = reduceMotion ? drawerProgress : presentedProgress
          Self.resignKeyboard()
        }
        if let origin = dragOrigin {
          drawerProgress = DrawerPosition.progress(origin: origin, translation: value.translation.width, width: width)
        }
      }
      .onEnded { value in
        guard let origin = dragOrigin else { return }
        let open = DrawerPosition.opens(origin: origin, predictedTranslation: value.predictedEndTranslation.width, width: width)
        let remaining = (open ? 1.0 : 0.0) - drawerProgress
        setDrawer(open, release: .init(velocity: value.velocity.width / width, remaining: remaining))
      }
  }

  private var targetPicker: some View {
    SelectionSheet(title: ConnectionCopy.selectExecutionHost, subtitle: ConnectionCopy.targetPickerSubtitle, onRefresh: {
      Task { await targets.refreshTargets() }
    }) {
      VStack(spacing: 0) {
        SelectionRow(title: targets.localScope.label, detail: ConnectionCopy.localExecutionHost, selected: targets.newTaskScope.isLocal) {
          targets.selectNewTask(targets.localScope); showTargets = false
        }
        ForEach(targets.discoveredTargets) { target in
          SelectionRow(title: target.label, detail: ConnectionCopy.throughGateway,
                       selected: target.id == targets.newTaskScope.id) {
            targets.selectNewTask(target); showTargets = false
          }
        }
      }
    }
  }

  // MARK: - Actions

  private func setDrawer(_ open: Bool, release: Motion.DrawerRelease? = nil) {
    // The drawer owns the keyboard: opening it must not type into a field the
    // user can no longer see.
    if open { Self.resignKeyboard() }
    dragOrigin = nil
    drawerRelease = release
    drawerOpen = open
    drawerProgress = open ? 1 : 0
    if !open { sidebarButtonFocused = true }
  }

  // Every new-session entry names its target scope, so this never has to repeat
  // `beginNewTask`'s scope heuristic. Same scope means the user is already on the
  // page they asked for: keep the chosen project/Provider and the draft, and only
  // let a running task go in the background. A different scope resets that
  // scope's composer context (drafts are stored per scope, so the other scope's
  // own draft is what appears — the user's text is never thrown away).
  private func startNewSession(scope: ExecutionTargetScope, cwd: String? = nil) {
    if scope == targets.newTaskScope {
      guard targets.newTaskStore.detachFocusedRun() else { return }
    } else if !targets.beginNewTask(scope: scope) { return }
    if let cwd { targets.newTaskStore.chooseProject(.init(path: cwd, label: projectName(cwd))) }
    setDrawer(false)
    focusTicket += 1
    model.route = .newSession
  }

  private func projectName(_ cwd: String) -> String { cwd.split(separator: "/").last.map(String.init) ?? cwd }

  private static func resignKeyboard() {
    #if canImport(UIKit)
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    #endif
  }
}
