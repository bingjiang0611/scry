import SwiftUI
import QuartzCore
import os

// Injected only into a generated device fixture, never an App target in source.
// UI modes require preview. Self-test keeps its normal admission contract, but
// a private preferences/state namespace prevents either mode from adopting a
// daily bundle's grant or recovery records.
@MainActor
final class BatchFDevice: NSObject {
  static let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
  static let stateDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("BatchF-" + UUID().uuidString)
  static let defaults = UserDefaults(suiteName: "BatchF-" + UUID().uuidString)!
  static let arguments: [String] = {
    let actual = ProcessInfo.processInfo.arguments
    if actual.contains("-uiPreview") || actual.contains("-selfTest") { return actual }
    let file = directory.appendingPathComponent("batch-f-preview.json")
    let selected = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([String].self, from: $0) }
      ?? ["-uiMockData", "-route", "home"]
    if selected.contains("-selfTest") { return selected }
    return ["-uiPreview", "-connected"] + selected
  }()
  static var model: AppModel?
  static var bodies: [String: Int] = [:]
  static var running = false
  private static var consumed = false
  private static let streamTitle = "F: stream 600"
  static var monitor: BatchFDevice?
  private var displayLink: CADisplayLink?
  private var previousTimestamp: CFTimeInterval?
  private var intervals: [Double] = []
  private var nominalIntervals: [Double] = []
  private var missedCallbacks = 0
  private var gapOver50ms = 0
  private static let log = OSLog(subsystem: "com.scry.batch-f", category: .pointsOfInterest)

  static func prepareSelfTestLog() {
    guard arguments.contains("-selfTest") else { return }
    let path = directory.appendingPathComponent("batch-f-selftest.log").path
    freopen(path, "w", stdout)
    setbuf(stdout, nil)
  }

  static func count(_ name: String) {
    guard running else { return }
    bodies[name, default: 0] += 1
  }

  @ViewBuilder static var controls: some View {
    if arguments.contains("-batchFStream") {
      Button(streamTitle) { Task { await stream() } }
        .accessibilityIdentifier("batch-f-stream")
        .padding(8).background(.ultraThinMaterial)
    }
  }

  @objc private func frame(_ link: CADisplayLink) {
    let nominal = link.targetTimestamp - link.timestamp
    guard nominal > 0 else { return }
    nominalIntervals.append(nominal * 1000)
    if let previousTimestamp {
      let delta = link.timestamp - previousTimestamp
      intervals.append(delta * 1000)
      nominalIntervals.append(nominal * 1000)
      missedCallbacks += max(0, Int((delta / nominal).rounded()) - 1)
      if delta > 0.05 { gapOver50ms += 1 }
    }
    previousTimestamp = link.timestamp
  }

  static func stream() async {
    guard !running, !consumed, let model else { return }
    consumed = true
    let store = model.targetCoordinator.selectedStore
    guard store.prepareBatchFStream() else { return }
    let current = BatchFDevice()
    monitor = current
    bodies = [:]
    running = true
    current.displayLink = CADisplayLink(target: current, selector: #selector(frame(_:)))
    current.displayLink?.add(to: .main, forMode: .common)
    let clock = ContinuousClock()
    let start = clock.now
    let startUptime = ProcessInfo.processInfo.systemUptime
    let startThermal = ProcessInfo.processInfo.thermalState.rawValue
    let signpost = OSSignpostID(log: log)
    os_signpost(.begin, log: log, name: "Stream600", signpostID: signpost)
    do {
      // Fixed arrival schedule, not a retry/sleep added to make tests pass.
      // Missed deadlines catch up. Both revisions receive the identical 600
      // paragraphs at 30 Hz, through the real append/coalescing path.
      for sequence in 1...600 {
        try await clock.sleep(until: start + .milliseconds(sequence * 33))
        let appendSignpost = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "Append600", signpostID: appendSignpost, "sequence=%{public}d", sequence)
        try store.appendBatchFLine(sequence)
        os_signpost(.end, log: log, name: "Append600", signpostID: appendSignpost)
      }
      // Fixed tail window includes the final committed SwiftUI layout.
      try await clock.sleep(for: .milliseconds(500))
      os_signpost(.end, log: log, name: "Stream600", signpostID: signpost)
      current.displayLink?.invalidate()
      current.displayLink = nil
      running = false
      let sorted = current.intervals.sorted()
      let report: [String: Any] = [
        "schema": 1,
        "revision": batchFRevision,
        "workload": "stream600-paragraphs-30hz-tail500-v2",
        "requestedLines": 600,
        "actualLines": store.output.map(\.text).joined().split(separator: "\n").count,
        "outputRows": store.output.count,
        "outputSHA256": SHA256.hash(data: Data(store.output.map(\.text).joined().utf8)).map { String(format: "%02x", $0) }.joined(),
        "elapsedMs": (ProcessInfo.processInfo.systemUptime - startUptime) * 1000,
        "callbackSamples": sorted.count,
        "callbackIntervalP50Ms": sorted.isEmpty ? NSNull() : sorted[sorted.count / 2] as Any,
        "callbackIntervalP95Ms": sorted.isEmpty ? NSNull() : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))] as Any,
        "callbackIntervalMaxMs": sorted.last as Any? ?? NSNull(),
        "missedDisplayLinkCallbacks": current.missedCallbacks,
        "callbackGapsOver50Ms": current.gapOver50ms,
        "nominalIntervalMs": current.nominalIntervals.first as Any? ?? NSNull(),
        "thermalStart": startThermal,
        "thermalEnd": ProcessInfo.processInfo.thermalState.rawValue,
        "bodies": bodies
      ]
      let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      try data.write(to: directory.appendingPathComponent("batch-f-stream.json"), options: .atomic)
    } catch {
      current.displayLink?.invalidate()
      current.displayLink = nil
      running = false
      let report = ["error": String(describing: error), "revision": batchFRevision]
      if let data = try? JSONEncoder().encode(report) {
        try? data.write(to: directory.appendingPathComponent("batch-f-stream.json"), options: .atomic)
      }
    }
    monitor = nil
  }
}

extension RemoteRunStore {
  fileprivate func prepareBatchFStream() -> Bool {
    guard mockMode, activeSessionIdentity != nil else { return false }
    output = []
    lifecycle = .running
    terminalDrainCompleted = false
    return true
  }

  fileprivate func appendBatchFLine(_ sequence: Int) throws {
    let line = String(format: "Line %04d: fixed streamed paragraph for batch F observation.\n\n", sequence)
    let wire: [String: Any] = ["seq": 10000 + sequence, "at": sequence, "runId": "batch-f", "kind": "output", "text": line]
    let chunk = try JSONDecoder().decode(G0Transport.RunOutputChunk.self, from: JSONSerialization.data(withJSONObject: wire))
    append(chunk: chunk, generation: generation, identity: activeSessionIdentity!)
  }
}
