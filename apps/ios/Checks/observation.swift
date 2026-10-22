import Foundation
import Observation
import Combine
import RemoteTransport

// Appended to RemoteRunStore.swift by the native runner, so the fixture can
// drive private setters and the real append path without widening the app API.
@MainActor
private final class DependencyProbe {
  var invalidations = 0
  let read: () -> Void
  private var subscription: AnyCancellable?
  private var armed = false
  init<Object: ObservableObject>(_ object: Object, read: @escaping () -> Void) {
    self.read = read
    subscription = object.objectWillChange.sink { [weak self] _ in self?.invalidations += 1 }
  }
  init<Object>(_ object: Object, read: @escaping () -> Void) { self.read = read }

  func arm() {
    if subscription != nil { read(); return }
    guard !armed else { return }
    armed = true
    withObservationTracking { read() } onChange: { [weak self] in
      MainActor.assumeIsolated {
        self?.armed = false
        self?.invalidations += 1
      }
    }
  }
}

extension RemoteRunStore {
  fileprivate static func observationChecks(directory: URL) async throws -> Bool {
    let suite = "ScryObservationFixture.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(connections: RemoteConnectionStore(defaults: defaults),
      historyDisk: RemoteHistoryCache(directory: directory.appendingPathComponent("history")), stateDirectory: directory)
    let store = model.targetCoordinator.localStore
    store.mockMode = true
    let identity = SessionIdentity.opened(providerId: "pi", cwd: "/fixture", externalSessionId: "observation")
    store.activeSessionIdentity = identity
    store.lifecycle = .running
    let probes: [(String, DependencyProbe)] = [
      ("stream", DependencyProbe(store) { _ = store.output }),
      ("catalog", DependencyProbe(store) { _ = store.catalog }),
      ("projects", DependencyProbe(store) { _ = store.projects }),
      ("providers", DependencyProbe(store) { _ = store.providers; _ = store.modelOptions }),
      ("history", DependencyProbe(store) { _ = store.history }),
      ("lifecycle", DependencyProbe(store) { _ = store.lifecycle }),
      ("questions", DependencyProbe(store) { _ = store.pendingQuestions }),
      ("appLink", DependencyProbe(model) { _ = model.link }),
      ("homeSessions", DependencyProbe(model.targetCoordinator) { _ = model.targetCoordinator.homeSessions })
    ]
    // Drain the catalog rebuild scheduled during initialization.
    await Task { @MainActor in }.value
    for (_, probe) in probes { probe.invalidations = 0 }
    let fragments = 200
    for seq in 1...fragments {
      for (_, probe) in probes { probe.arm() }
      let chunk = try JSONDecoder().decode(G0Transport.RunOutputChunk.self,
        from: Data("{\"seq\":\(seq),\"at\":0,\"runId\":\"fixture\",\"kind\":\"output\",\"text\":\"x\"}".utf8))
      store.append(chunk: chunk, generation: store.generation, identity: identity)
      await Task { @MainActor in }.value
    }
    for (name, probe) in probes { print("COUNT stream200.\(name)=\(probe.invalidations)") }
    let intact = store.output.count == 1 && store.output.first?.text == String(repeating: "x", count: fragments)
    #if LEGACY_OBSERVATION && !REQUIRE_ISOLATION
    let isolated = probes.allSatisfy { $0.1.invalidations == ($0.0 == "appLink" ? 0 : fragments) }
    #else
    let isolated = probes.allSatisfy { $0.1.invalidations == ($0.0 == "stream" ? fragments : 0) }
    #endif
    print("\(intact ? "PASS" : "FAIL") observation.outputIntact")
    print("\(isolated ? "PASS" : "FAIL") observation.invalidationContract")

    // Rearm before each mutation, as SwiftUI does on its next evaluation.
    let lifecycle = probes.first { $0.0 == "lifecycle" }!.1
    let questions = probes.first { $0.0 == "questions" }!.1
    let beforeLifecycle = lifecycle.invalidations
    let beforeQuestions = questions.invalidations
    lifecycle.arm(); questions.arm()
    store.lifecycle = .cancelled
    let question = try JSONDecoder().decode(G0Transport.RunQuestionRequest.self,
      from: Data(#"{"runId":"00000000-0000-4000-8000-000000000001","questionId":"fixture","questions":[]}"#.utf8))
    store.pendingQuestions = [question]
    let controlsVisible = lifecycle.invalidations > beforeLifecycle && questions.invalidations > beforeQuestions
      && store.lifecycle == .cancelled && store.pendingQuestions.first?.questionId == "fixture"
    print("\(controlsVisible ? "PASS" : "FAIL") observation.lifecycleAndQuestionNotLost")

    // Exercise the coordinator's catalog observation twice, separated by a
    // main-actor turn. A one-shot observer that is not rearmed must fail here.
    store.catalog = .loaded([.init(sessionId: "one", providerId: "pi", cwd: "/fixture", label: "one", ts: 1)])
    await Task { @MainActor in }.value
    // Rebuild is deliberately scheduled/coalesced by the production coordinator.
    await Task { @MainActor in }.value
    let firstCatalog = model.targetCoordinator.homeSessions.first?.session.sessionId == "one"
    store.catalog = .loaded([.init(sessionId: "two", providerId: "pi", cwd: "/fixture", label: "two", ts: 2)])
    await Task { @MainActor in }.value
    await Task { @MainActor in }.value
    let rearmed = firstCatalog && model.targetCoordinator.homeSessions.first?.session.sessionId == "two"
    print("\(rearmed ? "PASS" : "FAIL") observation.catalogRearms")

    let pending = DependencyProbe(model.targetCoordinator) { _ = model.targetCoordinator.hasPendingWork }
    pending.arm()
    store.runId = "fixture"
    let nestedPending = pending.invalidations > 0 && model.targetCoordinator.hasPendingWork
    print("\(nestedPending ? "PASS" : "FAIL") observation.nestedPendingWork")
    store.lifecycle = .running
    let stop = DependencyProbe(store) { _ = store.canStop }
    stop.arm()
    store.lifecycle = .cancelled
    let stopUpdates = stop.invalidations > 0 && !store.canStop
    print("\(stopUpdates ? "PASS" : "FAIL") observation.stopProjection")

    let history = probes.first { $0.0 == "history" }!.1
    let historyBefore = history.invalidations
    history.arm()
    store.history = .loaded([.init(userText: "fixture", items: [.init(kind: "output", text: "reply")])])
    let historyUpdates = history.invalidations > historyBefore
    print("\(historyUpdates ? "PASS" : "FAIL") observation.historyUpdates")

    store.chosen = .init(path: "/fixture", label: "fixture")
    store.chosenProvider = .init(id: "pi", label: "Pi", available: true)
    store.providerControlsCwd = "/fixture"
    store.providerControlsLoaded = false
    let readiness = DependencyProbe(store) { _ = store.controlsReady }
    readiness.arm()
    store.providerControlsLoaded = true
    let readinessUpdates = readiness.invalidations > 0 && store.controlsReady
    print("\(readinessUpdates ? "PASS" : "FAIL") observation.privateReadinessDependency")
    return intact && isolated && controlsVisible && rearmed && nestedPending && stopUpdates && historyUpdates && readinessUpdates
  }
}

@main
struct ObservationChecks {
  @MainActor static func main() async {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("scry-observation-" + UUID().uuidString)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let passed = try await RemoteRunStore.observationChecks(directory: directory)
      try FileManager.default.removeItem(at: directory)
      exit(passed ? 0 : 1)
    } catch {
      print("FAIL observation.unexpected: \(error)")
      try? FileManager.default.removeItem(at: directory)
      exit(1)
    }
  }
}

// The native runner does not compile the unrelated UIKit attachment views.
struct DraftAttachment: Equatable {}
