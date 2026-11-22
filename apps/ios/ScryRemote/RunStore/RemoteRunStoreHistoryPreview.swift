import Foundation
import RemoteTransport

extension RemoteRunStore {
  // At most two small previews while browsing; never download full history.
  // An established readonly tunnel closes on cancellation, so foreground reads
  // take priority. Before channel establishment, NIO/upgrade deadlines still apply.
  func prefetchHistory(_ sessions: [G0Transport.RunSessionRef]) {
    guard prefetchEnabled, prefetchTask == nil, historyTask == nil, !historyCacheClearing, !hasUnresolvedRun,
          let connection = loadConnection() else { return }
    let recent = Array(sessions.filter { $0.externalSessionId?.isEmpty == false }
      .sorted { $0.ts > $1.ts }.prefix(2))
    let keys = Set(recent.compactMap { session -> String? in
      guard let external = session.externalSessionId else { return nil }
      return RemoteHistoryCache.key(connection: connection, target: targetScope, providerId: session.providerId, cwd: session.cwd, sessionId: external, agentProfileId: session.agentProfileId)
    })
    warmedScreens = warmedScreens.filter { keys.contains($0.key) }
    let requestDataGeneration = dataGeneration
    let warmingGeneration = prefetchGeneration
    let disk = historyDisk
    prefetchTask = Task { [weak self] in
      guard let self else { return }
      @MainActor func current() -> Bool {
        !Task.isCancelled && self.dataGeneration == requestDataGeneration &&
          self.prefetchGeneration == warmingGeneration && self.historyTask == nil &&
          self.loadConnection() == connection
      }
      var missing: [(G0Transport.RunSessionRef, String)] = []
      for session in recent {
        guard !Task.isCancelled, self.dataGeneration == requestDataGeneration,
              self.prefetchGeneration == warmingGeneration,
              self.loadConnection() == connection, let external = session.externalSessionId else { break }
        let key = RemoteHistoryCache.key(connection: connection, target: targetScope, providerId: session.providerId, cwd: session.cwd, sessionId: external, agentProfileId: session.agentProfileId)
        do {
          let cached = try await disk.readPreview(key)
          guard !Task.isCancelled, self.prefetchGeneration == warmingGeneration,
                self.dataGeneration == requestDataGeneration, self.loadConnection() == connection else { break }
          if let cached { self.warmScreen(cached, key: key) }
          else { missing.append((session, key)) }
        } catch {
          // Prefetch is an optional read, never a connectivity/business receipt.
          // Opening the session owns visible errors and its authoritative read.
          if Task.isCancelled { break }
        }
      }
      #if DEBUG
      if self.historyTestOffline {
        if self.prefetchGeneration == warmingGeneration { self.prefetchTask = nil }
        return
      }
      #endif
      if current(), !missing.isEmpty {
        let epoch = await disk.epoch
        do {
          try await RemoteRunClient(connection: connection, executionTarget: targetScope?.targetBinding).withHistoryConnection { [missing] reader in
            for (session, key) in missing {
              guard current(), let external = session.externalSessionId else { return }
              let preview = try await reader.preview(providerId: session.providerId, cwd: session.cwd, externalSessionId: external, agentProfileId: session.agentProfileId)
              guard current() else { return }
              if preview.available {
                self.warmScreen(preview, key: key)
                _ = try await disk.writePreview(preview, key: key, epoch: epoch)
              }
            }
          }
        } catch { /* Optional warming never claims connectivity or replaces foreground errors. */ }
      }
      if self.prefetchGeneration == warmingGeneration { self.prefetchTask = nil }
    }
  }

  func warmScreen(_ preview: G0Transport.RunHistoryPreview, key: String) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    guard preview.available, preview.turns.count <= 2,
          (try? encoder.encode(preview).count) ?? Int.max <= 16 * 1024 else { return }
    warmedScreens[key] = preview
  }
}
