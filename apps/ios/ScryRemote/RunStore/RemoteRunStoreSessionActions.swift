import Foundation
import RemoteTransport

extension RemoteRunStore {
  func loadToolPanel(kind: G0Transport.ToolPanelKind, rangeDays: Int? = nil, providerId: String? = nil) async {
    guard let client = makeClient() else {
      toolPanel = .failed(ConnectionCopy.notPaired)
      return
    }
    toolPanelRequest += 1
    let request = toolPanelRequest
    toolPanel = .loading
    do {
      let payload = try await client.toolPanel(kind: kind, rangeDays: rangeDays, providerId: providerId)
      guard request == toolPanelRequest else { return }
      toolPanel = .loaded(payload)
    } catch {
      guard request == toolPanelRequest else { return }
      if case G0Transport.RunError.host(code: "unknown_op") = error {
        toolPanel = .failed(ConnectionCopy.panelUnsupported)
      } else if case G0Transport.RunError.host(code: "tool_panel_unavailable") = error {
        toolPanel = .failed(ConnectionCopy.toolMissingCapability)
      } else {
        toolPanel = .failed(Self.describe(error))
      }
    }
  }

  // Archive is reversible and delete is not, so both return the host's verdict
  // as a message and re-read the catalog rather than projecting a local guess.
  @discardableResult func refreshArchived() async -> Bool {
    if let archivedTask { return await archivedTask.value }
    let read: (() async throws -> [G0Transport.RunSessionRef])?
    if let client = makeClient() {
      read = { try await client.sessions(includeArchived: true) }
    } else {
      #if DEBUG
      if mockMode && ProcessInfo.processInfo.arguments.contains("-uiArchiveReadFixture") {
        archiveFixtureReadCount += 1
        let firstRead = archiveFixtureReadCount == 1
        read = {
          if firstRead { throw NSError(domain: "archive-fixture", code: 1) }
          return []
        }
      } else {
        read = nil
      }
      #else
      read = nil
      #endif
    }
    guard let read else {
      archivedFailure = ConnectionCopy.notPaired
      if !archivedCatalog.hasVisibleValue { archivedCatalog = .failed(ConnectionCopy.notPaired) }
      return false
    }
    archivedLoading = true
    archivedFailure = nil
    let task = Task { [weak self] () -> Bool in
      do {
        let list = try await read()
        let archived = list.filter { ($0.archivedAt ?? 0) > 0 }
        await MainActor.run {
          guard let self else { return }
          self.archivedCatalog = archived.isEmpty ? .empty : .loaded(archived)
          self.archivedFetchedAt = Date()
        }
        return true
      } catch {
        await MainActor.run {
          guard let self else { return }
          self.archivedFailure = Self.describe(error)
          if !self.archivedCatalog.hasVisibleValue { self.archivedCatalog = .failed(Self.describe(error)) }
        }
        return false
      }
    }
    archivedTask = task
    let result = await task.value
    archivedTask = nil
    archivedLoading = false
    return result
  }

  func sessionContext(_ session: G0Transport.RunSessionRef) -> G0Transport.SessionActionContext? {
    guard let external = session.externalSessionId, !external.isEmpty else { return nil }
    return G0Transport.SessionActionContext(cwd: session.cwd, providerId: session.providerId,
                                            externalSessionId: external, agentProfileId: session.agentProfileId)
  }

  // nil means the host applied the action. Any other value is a message the
  // caller shows verbatim; the catalog is re-read so the row state stays the
  // host's, not the phone's.
  func applySessionAction(_ action: G0Transport.SessionCleanup, to session: G0Transport.RunSessionRef) async -> String? {
    guard let client = makeClient() else { return ConnectionCopy.notPaired }
    guard let context = sessionContext(session) else { return ConnectionCopy.noHostSession }
    do {
      guard try await client.sessionAction(context: context, action: action) else {
        return ConnectionCopy.sessionActionRejected
      }
      _ = await refreshSessions()
      if archivedCatalog.hasVisibleValue { _ = await refreshArchived() }
      return nil
    } catch { return Self.describe(error) }
  }

  func renameSession(_ session: G0Transport.RunSessionRef, title: String) async -> String? {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= 256 else { return ConnectionCopy.renameRejected }
    return await applySessionAction(.rename(title: trimmed), to: session)
  }

  func setPinned(_ session: G0Transport.RunSessionRef, pinned: Bool) async -> String? {
    await applySessionAction(.pin(pinned), to: session)
  }

  // Archiving a running session stops it first on the host, so the caller asks
  // for confirmation before calling this.
  func setArchived(_ session: G0Transport.RunSessionRef, archived: Bool) async -> String? {
    await applySessionAction(.archive(archived), to: session)
  }

  func deleteArchivedSession(_ session: G0Transport.RunSessionRef) async -> String? {
    guard let client = makeClient() else { return ConnectionCopy.notPaired }
    guard let external = session.externalSessionId, !external.isEmpty else { return ConnectionCopy.noHostSession }
    do {
      let outcome = try await client.deleteSession(providerId: session.providerId, cwd: session.cwd,
                                                   externalSessionId: external, agentProfileId: session.agentProfileId)
      guard outcome.ok else { return ConnectionCopy.sessionDeleteIncomplete(outcome.failed.count) }
      _ = await refreshArchived()
      return nil
    } catch { return Self.describe(error) }
  }
}
