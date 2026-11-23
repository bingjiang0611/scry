import Foundation
import RemoteTransport

extension RemoteRunStore {
  // Load the host session catalog so the phone's session list shows the SAME
  // conversations the Mac has. Cached content is never promoted to verified;
  // only the frozen, complete host response receives a full-refresh timestamp.
  func loadSessions(force: Bool = false) {
    #if DEBUG
    if mockMode && catalogFixture == nil { return }
    let fixture = catalogFixture
    let requestedClient = fixture.map { RemoteRunClient(connection: $0.connection) } ?? makeClient()
    #else
    let requestedClient = makeClient()
    #endif
    let hasVisibleValue = catalog.hasVisibleValue
    if !force, hasVisibleValue, isFresh(catalogLoadedAt, within: Self.catalogFreshness) { return }
    guard catalogTask == nil else { return }
    guard let client = requestedClient else {
      if !hasVisibleValue { catalog = .failed(ConnectionCopy.notPaired) }
      return
    }
    if !hasVisibleValue { catalog = .loading }
    catalogRequestID += 1
    let requestID = catalogRequestID
    catalogRefreshInFlight = true
    catalogRefreshFailure = nil
    let requestDataGeneration = dataGeneration
    let disk = historyDisk
    let diskKey = RemoteHistoryCache.catalogKey(connection: client.connection, target: targetScope)
    let requestConnectionRevision = connectionSuccessRevision
    let progress = CatalogProgress()
    catalogTask = Task { [weak self] in
      let diskEpoch = await disk.epoch
      do {
        if !hasVisibleValue {
          do {
            if let cached = try await disk.readCatalogValue(diskKey) {
              await MainActor.run {
                guard let self, self.isCurrentCatalogRequest(requestID, dataGeneration: requestDataGeneration) else { return }
                self.catalogEvidence = .unverifiedCache(cached.fetchedAt)
                self.catalogVerifiedAt = cached.fetchedAt
                self.catalog = cached.sessions.isEmpty ? .empty : .loaded(cached.sessions)
              }
            }
          } catch {
            await MainActor.run {
              guard let self, self.isCurrentCatalogRequest(requestID, dataGeneration: requestDataGeneration) else { return }
              self.catalogRefreshFailure = .cacheRead(Self.describe(error))
            }
          }
        }
        let retainCompleteList = await MainActor.run { self?.catalog.hasVisibleValue ?? false }
        let onPage: @Sendable ([G0Transport.RunSessionRef]) async -> Void = { [weak self] page in
          await progress.markPage()
          await MainActor.run {
            guard let self, self.isCurrentCatalogRequest(requestID, dataGeneration: requestDataGeneration) else { return }
            self.recordSuccess()
            // Keep a complete old list during refresh. On a cold start, pages
            // can become readable but never acquire a full-refresh timestamp.
            if !retainCompleteList { self.catalog = page.isEmpty ? .empty : .loaded(page) }
          }
        }
        let list: [G0Transport.RunSessionRef]
        #if DEBUG
        if let fixture { list = try await fixture.fetch(onPage) }
        else { list = try await client.sessions(progress: onPage) }
        #else
        list = try await client.sessions(progress: onPage)
        #endif
        let verifiedAt = Date()
        let current = await MainActor.run { () -> Bool in
          guard let self, self.isCurrentCatalogRequest(requestID, dataGeneration: requestDataGeneration) else { return false }
          self.recordSuccess()
          self.catalogLoadedAt = verifiedAt
          self.catalogVerifiedAt = verifiedAt
          self.catalogEvidence = .verified(verifiedAt)
          self.catalogRefreshFailure = nil
          self.catalog = list.isEmpty ? .empty : .loaded(list)
          self.prefetchHistory(list)
          return true
        }
        guard current else { return }
        #if DEBUG
        if let fixture { await fixture.beforePersist() }
        #endif
        do {
          let saved = try await disk.writeCatalog(list, key: diskKey, epoch: diskEpoch, fetchedAt: verifiedAt)
          await MainActor.run {
            guard let self, self.isCurrentCatalogRequest(requestID, dataGeneration: requestDataGeneration) else { return }
            if saved { self.catalogRefreshRevision += 1 }
            else { self.catalogRefreshFailure = .cacheWriteRejected }
            self.finishCatalogRequest(requestID)
          }
        } catch {
          await MainActor.run {
            guard let self, self.isCurrentCatalogRequest(requestID, dataGeneration: requestDataGeneration) else { return }
            self.catalogRefreshFailure = .cacheWrite(Self.describe(error))
            self.finishCatalogRequest(requestID)
          }
        }
      } catch {
        let receivedPage = await progress.receivedPage
        await MainActor.run {
          guard let self, self.isCurrentCatalogRequest(requestID, dataGeneration: requestDataGeneration) else { return }
          self.recordFailure(error, since: requestConnectionRevision)
          let detail = Self.describe(error)
          if let scope = self.targetScope, !scope.isLocal, case let G0Transport.RunError.host(code) = error {
            // The error may be from either authenticated hop. It is not proof
            // that the phone must replace its Mac1 grant.
            self.catalogRefreshFailure = .target(label: scope.label, detail: detail,
              retryable: ["desktop_not_connected", "timeout", "disconnected"].contains(code))
          } else if case let G0Transport.RunError.host(code) = error,
             ["device_not_authorized", "grant_expired", "grant_revoked"].contains(code) {
            self.catalogRefreshFailure = .authorization(detail)
          } else if case let G0Transport.RunError.host(code) = error, ConnectionCopy.isProtocolFailure(code) {
            self.catalogRefreshFailure = .protocolMismatch(detail)
          } else {
            let retryable = RelayTransportError.permitsReadRecovery(error)
            self.catalogRefreshFailure = receivedPage ? .partial(detail, retryable: retryable) : .transport(detail, retryable: retryable)
          }
          if !self.catalog.hasVisibleValue { self.catalog = .failed(Self.describe(error)) }
          self.finishCatalogRequest(requestID)
        }
      }
    }
  }

  func isCurrentCatalogRequest(_ requestID: Int, dataGeneration requestDataGeneration: Int) -> Bool {
    requestID == catalogRequestID && requestDataGeneration == dataGeneration
  }

  func finishCatalogRequest(_ requestID: Int) {
    guard requestID == catalogRequestID else { return }
    catalogRefreshInFlight = false
    catalogTask = nil
  }

  #if DEBUG
  // Replace only the network reader, and only in an existing isolated mock.
  // The Details regression then runs the real refresh/cache completion path.
  func prepareRefreshDetailsFixture() -> Bool {
    guard mockMode else { return false }
    let connection = RemoteConnection(relayHost: "fixture.invalid", relayPort: 443, relayTLS: "system",
      hostId: "details-fixture", anchorPEM: "fixture-anchor", deviceId: "fixture-grant")
    catalogFixture = CatalogFixture(connection: connection, fetch: { _ in [] })
    return true
  }

  // A bounded DEBUG-only projection fixture exercises the feedback state's
  // page-to-complete sequence. It does not execute loadSessions or disk I/O,
  // and is not evidence for transport, partial, or cache failure behavior.
  func applyCatalogRefreshFixture() {
    guard catalogTask == nil else { return }
    catalogRequestID += 1
    let requestID = catalogRequestID
    catalogRefreshInFlight = true
    catalogRefreshFailure = nil
    let list: [G0Transport.RunSessionRef]
    switch catalog {
    case let .loaded(current): list = current
    default: list = []
    }
    // Exercise a bounded page receipt before the complete snapshot is
    // committed; this is not a pre-seeded final-state fixture.
    let page = Array(list.prefix(max(1, list.count / 2)))
    catalog = page.isEmpty ? .empty : .loaded(page)
    catalog = list.isEmpty ? .empty : .loaded(list)
    let verifiedAt = Date()
    catalogLoadedAt = verifiedAt
    catalogVerifiedAt = verifiedAt
    catalogEvidence = .verified(verifiedAt)
    catalogRefreshRevision += 1
    finishCatalogRequest(requestID)
  }
  #endif
}
