import Foundation

extension G0Transport {
  struct SubscriptionStatus: Sendable {
    var cursor: SubscriptionCursor
    var sessions: [String: SubscriptionSessionRow]
    var runs: [String: SubscriptionRunRow]

    mutating func apply(_ reply: SubscriptionReply, cursor next: SubscriptionCursor) throws {
      for event in reply.events ?? [] {
        if let key = event.sessionKey {
          if let row = event.sessionRow {
            guard row.sessionKey == key else { throw ProbeError.unexpectedReply }
            if row.revSeq > (sessions[key]?.revSeq ?? -1) { sessions[key] = row }
          } else if ["session.deleted", "session.withdrawn"].contains(event.type),
                    (sessions[key]?.revSeq ?? -1) <= event.seq {
            sessions.removeValue(forKey: key)
          }
        }
        if let row = event.runRow {
          guard row.runId == event.runId, row.state != nil else { throw ProbeError.unexpectedReply }
          if row.revSeq >= (runs[row.runId]?.revSeq ?? -1) { runs[row.runId] = row }
        }
      }
      applyHints(reply.hints ?? [])
      guard sessions.count <= 100_000, runs.count <= 100_000 else { throw ProbeError.unexpectedReply }
      cursor = next
    }

    mutating func applyHints(_ hints: [SubscriptionHint]) {
      for hint in hints where hint.kind == "run" {
        guard let runId = hint.runId, var run = runs[runId], let outputSeq = hint.outputSeq, outputSeq >= 0 else { continue }
        run.outputSeq = max(run.outputSeq ?? 0, outputSeq)
        run.traceRunId = hint.traceRunId ?? run.traceRunId
        runs[runId] = run
      }
    }

    func session(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String?) -> SubscriptionSession? {
      sessions.values.lazy.map(\.reference).first(where: {
        $0.providerId == providerId && $0.cwd == cwd && $0.externalSessionId == externalSessionId &&
        $0.agentProfileId == agentProfileId
      }).map {
        SubscriptionSession(sessionKey: $0.sessionId, providerId: providerId, cwd: cwd,
                            externalSessionId: externalSessionId, agentProfileId: agentProfileId)
      }
    }
  }

  actor DeviceSubscriptionState {
    private var offered = false
    private var hostId: String?
    private var capabilityRead: Task<String?, Error>?
    private var statusRead: Task<SubscriptionStatus, Error>?
    private var current: SubscriptionStatus?
    private var catalogOpened = false
    private var outputByRun: [String: (logId: String, seq: Int, delivered: Int)] = [:]
    private var watchedRuns: [String: (cursor: SubscriptionCursor, row: SubscriptionRunRow)] = [:]
    private var lastDetail: (session: SubscriptionSession, cursor: SubscriptionCursor, page: RunHistoryTurnsPage?)?
    private var observedNoticeIds: Set<String> = []

    func renegotiate() {
      offered = false
      capabilityRead?.cancel()
      statusRead?.cancel()
    }

    func offer(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> String? {
      if let capabilityRead { return try await capabilityRead.value }
      if offered { return hostId }
      let task = Task { try await G0Transport.probeSubscription(endpoint: endpoint, identity: identity) }
      capabilityRead = task
      defer { capabilityRead = nil }
      let result = try await task.value
      if hostId != result {
        current = nil
        lastDetail = nil
        watchedRuns.removeAll()
        outputByRun.removeAll()
      }
      hostId = result
      offered = true
      return result
    }

    func observe(endpoint: RelayEndpoint, identity: G0ProbeIdentity, hostId: String,
                 revision: String? = nil, waitMs: Int = 0) async throws -> SubscriptionStatus {
      try Task.checkCancellation()
      if let current, revision != current.cursor.revision { return current }
      if let statusRead { return try await statusRead.value }
      let task = Task { try await self.readStatus(endpoint: endpoint, identity: identity, hostId: hostId, waitMs: waitMs) }
      statusRead = task
      defer { statusRead = nil }
      let status = try await task.value
      try Task.checkCancellation()
      return status
    }

    private func readStatus(endpoint: RelayEndpoint, identity: G0ProbeIdentity, hostId: String,
                            waitMs: Int) async throws -> SubscriptionStatus {
      while true {
        let known = current?.cursor
        let request = SubscriptionRequest(views: ["sessions", "activeRuns"], waitMs: known == nil ? 0 : min(max(waitMs, 0), 20_000), known: known)
        let reply = try await G0Transport.readSubscription(request, endpoint: endpoint, identity: identity, lane: .status)
        let next = try reply.cursor(for: hostId)
        if reply.mode == "snapshot" {
          guard let page = reply.snapshot?.sessions, let rows = reply.snapshot?.activeRuns?.rows,
                rows.count <= 100_000, rows.allSatisfy({ $0.state != nil }) else { throw ProbeError.unexpectedReply }
          var runs: [String: SubscriptionRunRow] = [:]
          for row in rows { runs[row.runId] = row }
          let sessions = try await readSessions(page, cursor: next, endpoint: endpoint, identity: identity, lane: .status)
          var status = SubscriptionStatus(cursor: next, sessions: sessions, runs: runs)
          status.applyHints(reply.hints ?? [])
          let replaced = current?.cursor.logId != next.logId || current?.sessions.mapValues(\.revSeq) != status.sessions.mapValues(\.revSeq)
          current = status
          if replaced && catalogOpened { reportCatalogChange(endpoint) }
          catalogOpened = true
          reportNotices(reply.hints ?? [])
          return status
        }
        guard var status = current, let known, reply.knownEvents(since: known, next: next) else {
          if current == nil { throw ProbeError.unexpectedReply }
          current = nil
          lastDetail = nil
          continue
        }
        let catalogChanged = reply.events?.contains { event in
          guard let key = event.sessionKey else { return false }
          if let row = event.sessionRow { return row.revSeq > (status.sessions[key]?.revSeq ?? -1) }
          return ["session.deleted", "session.withdrawn"].contains(event.type) && status.sessions[key] != nil
        } == true
        try status.apply(reply, cursor: next)
        current = status
        if catalogChanged { reportCatalogChange(endpoint) }
        reportNotices(reply.hints ?? [])
        return status
      }
    }

    private func readSessions(_ page: SubscriptionSnapshot.Sessions, cursor: SubscriptionCursor,
                              endpoint: RelayEndpoint, identity: G0ProbeIdentity,
                              lane: RelaySession.Lane) async throws -> [String: SubscriptionSessionRow] {
      var sessions: [String: SubscriptionSessionRow] = [:]
      var window = page
      var seen: Set<String> = []
      while true {
        for row in window.rows {
          if row.revSeq > (sessions[row.sessionKey]?.revSeq ?? -1) { sessions[row.sessionKey] = row }
        }
        guard sessions.count <= 100_000 else { throw ProbeError.unexpectedReply }
        guard let token = window.nextCursor else { return sessions }
        guard token.utf16.count <= 512, seen.count < 1_000, seen.insert(token).inserted else { throw ProbeError.unexpectedReply }
        let pageRequest = SubscriptionRequest(views: ["sessions"], waitMs: 0, known: cursor, sessionsCursor: token)
        let continuation = try await G0Transport.readSubscription(pageRequest, endpoint: endpoint, identity: identity, lane: lane)
        let pageCursor = try continuation.cursor(for: cursor.hostId)
        guard continuation.mode == "snapshot", pageCursor.logId == cursor.logId, pageCursor.seq >= cursor.seq,
              let page = continuation.snapshot?.sessions else { throw ProbeError.unexpectedReply }
        window = page
      }
    }

    func verifiedCatalog(endpoint: RelayEndpoint, identity: G0ProbeIdentity, hostId: String) async throws -> [RunSessionRef] {
      guard var baseline = current else {
        return try await observe(endpoint: endpoint, identity: identity, hostId: hostId).sessions.values.map(\.reference)
      }
      var known: SubscriptionCursor? = baseline.cursor
      while true {
        let request = SubscriptionRequest(views: ["sessions"], waitMs: 0, known: known)
        let reply = try await G0Transport.readSubscription(request, endpoint: endpoint, identity: identity, lane: .bulk)
        let next = try reply.cursor(for: hostId)
        if reply.mode == "snapshot", let page = reply.snapshot?.sessions {
          let sessions = try await readSessions(page, cursor: next, endpoint: endpoint, identity: identity, lane: .bulk)
          reportNotices(reply.hints ?? [])
          return sessions.values.map(\.reference)
        }
        if let known, reply.knownEvents(since: known, next: next) {
          try baseline.apply(reply, cursor: next)
          reportNotices(reply.hints ?? [])
          return baseline.sessions.values.map(\.reference)
        }
        if known == nil { throw ProbeError.unexpectedReply }
        known = nil
      }
    }

    private func reportCatalogChange(_ endpoint: RelayEndpoint) {
      let change = SubscriptionCatalogChange(gatewayHostId: endpoint.hostId, target: endpoint.executionTarget)
      NotificationCenter.default.post(name: SubscriptionCatalogChange.received, object: change)
    }

    private func reportNotices(_ hints: [SubscriptionHint]) {
      for hint in hints where hint.kind == "hostNotice" {
        guard let notice = hint.notice, notice.isDisplayable, observedNoticeIds.insert(notice.id).inserted else { continue }
        NotificationCenter.default.post(name: HostAdminNotice.received, object: notice)
      }
      if observedNoticeIds.count > 512 { observedNoticeIds.removeAll(keepingCapacity: true) }
    }

    func detail(endpoint: RelayEndpoint, identity: G0ProbeIdentity, hostId: String, session: SubscriptionSession,
                waitMs: Int, latest: Bool) async throws -> RunHistoryTurnsPage? {
      let known = lastDetail.flatMap { $0.session == session && (!latest || $0.page != nil) ? $0.cursor : nil }
      let input = SubscriptionRequest(views: ["detail"], waitMs: known == nil ? 0 : min(max(waitMs, 0), 20_000),
                                      known: known, session: session, historyFormat: "turns", historyOnly: true)
      let reply = try await G0Transport.readSubscription(input, endpoint: endpoint, identity: identity, lane: .watch)
      let next = try reply.cursor(for: hostId)
      if reply.mode == "snapshot", let detail = reply.snapshot?.detail {
        let page = detail.firstPage?.kind == "mobileHistory" ? try detail.firstPage?.page?.validated(before: nil, limit: 3, expectedSnapshot: nil) : nil
        lastDetail = (session, next, page)
        return page
      }
      guard let known, reply.knownEvents(since: known, next: next) else {
        lastDetail = nil
        return nil
      }
      let invalidated = reply.events?.contains {
        ["turn.delivery", "run.settled", "run.failed", "run.cancelled", "run.interrupted", "session.deleted", "session.withdrawn"].contains($0.type)
      } == true
      lastDetail = (session, next, invalidated ? nil : lastDetail?.page)
      if latest && invalidated {
        return try await detail(endpoint: endpoint, identity: identity, hostId: hostId, session: session, waitMs: 0, latest: true)
      }
      return lastDetail?.page
    }

    func mergingWatchedRun(_ runId: String, into status: SubscriptionStatus) -> SubscriptionStatus {
      guard let retained = watchedRuns[runId], retained.cursor.logId == status.cursor.logId,
            retained.row.revSeq >= (status.runs[runId]?.revSeq ?? -1) else { return status }
      var merged = status
      var row = retained.row
      row.outputSeq = max(row.outputSeq ?? 0, status.runs[runId]?.outputSeq ?? 0)
      row.traceRunId = row.traceRunId ?? status.runs[runId]?.traceRunId
      merged.runs[runId] = row
      if retained.cursor.seq > status.cursor.seq { merged.cursor = retained.cursor }
      return merged
    }

    func watchRun(endpoint: RelayEndpoint, identity: G0ProbeIdentity, hostId: String, run: SubscriptionRunRow,
                  status: SubscriptionStatus, waitMs: Int) async throws -> SubscriptionStatus {
      guard let key = run.sessionKey, let provider = run.provider, let externalSessionId = run.externalSessionId else {
        return try await observe(endpoint: endpoint, identity: identity, hostId: hostId,
                                 revision: status.cursor.revision, waitMs: waitMs)
      }
      let session = SubscriptionSession(sessionKey: key, providerId: provider, cwd: run.cwd,
                                        externalSessionId: externalSessionId, agentProfileId: run.profile)
      let prior = watchedRuns[run.runId]?.cursor
      let known: SubscriptionCursor
      if let prior, prior.logId == status.cursor.logId, prior.seq > status.cursor.seq { known = prior }
      else { known = status.cursor }
      let request = SubscriptionRequest(views: ["detail"], waitMs: min(max(waitMs, 0), 20_000),
                                        known: known, session: session, historyFormat: "turns")
      let reply = try await G0Transport.readSubscription(request, endpoint: endpoint, identity: identity, lane: .watch)
      let next = try reply.cursor(for: hostId)
      if reply.mode == "snapshot" || !reply.knownEvents(since: known, next: next) {
        watchedRuns.removeValue(forKey: run.runId)
        return try await observe(endpoint: endpoint, identity: identity, hostId: hostId, revision: status.cursor.revision)
      }
      var scoped = status
      try scoped.apply(reply, cursor: next)
      if watchedRuns.count >= 512 && prior == nil { watchedRuns.removeAll(keepingCapacity: true) }
      if let row = scoped.runs[run.runId] { watchedRuns[run.runId] = (next, row) }
      return scoped
    }

    func shouldReadOutput(run: SubscriptionRunRow, cursor: SubscriptionCursor, delivered: Int) -> Bool {
      if let prior = outputByRun[run.runId] {
        return prior.logId != cursor.logId || (run.outputSeq ?? 0) > prior.seq || delivered < prior.delivered
      }
      return delivered > 0 || (run.outputSeq ?? 0) > 0 || ["settled", "failed", "cancelled"].contains(run.state ?? "")
    }

    func didReadOutput(run: SubscriptionRunRow, cursor: SubscriptionCursor, delivered: Int) {
      if outputByRun.count >= 512 && outputByRun[run.runId] == nil { outputByRun.removeAll(keepingCapacity: true) }
      outputByRun[run.runId] = (cursor.logId, run.outputSeq ?? 0, delivered)
    }

  }
}
