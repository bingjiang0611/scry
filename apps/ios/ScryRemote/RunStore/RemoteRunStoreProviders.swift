import Foundation
import RemoteTransport

extension RemoteRunStore {
  // Load the Providers the host offers. Only available ones are selectable (an
  // unavailable Provider cannot run). We deliberately do NOT auto-select a
  // default: describe() reports a Provider as available from CLI presence/auth,
  // which does not guarantee a run succeeds (e.g. a Provider whose CLI crashes on
  // launch). Auto-picking the first would silently send the first turn to a
  // Provider the user never chose - exactly the failure the owner hit. Requiring
  // an explicit pick (canSend gates on chosenProvider) keeps the choice honest.
  // If a previously-chosen Provider is no longer available, clear it.
  func loadProviders(preferredId: String? = nil, preferredAgentProfileId: String? = nil, force: Bool = false) {
    // This is updated before any cache/single-flight decision. A late response
    // therefore applies the latest screen preference, never its stale closure.
    latestProviderPreference = (preferredId, preferredAgentProfileId)
    #if DEBUG
    if mockMode {
      applyPreferredProvider(preferredId, agentProfileId: preferredAgentProfileId)
      _ = restoreActiveContext()
      return
    }
    #endif
    let hasCachedValue: Bool
    switch providers { case .loaded, .empty: hasCachedValue = true; default: hasCachedValue = false }
    applyPreferredProvider(preferredId, agentProfileId: preferredAgentProfileId)
    _ = restoreActiveContext()
    if !force, hasCachedValue, isFresh(providersLoadedAt, within: Self.metadataFreshness) { return }
    guard providersTask == nil else { return }
    guard let client = makeClient() else {
      if !hasCachedValue { providers = .failed("尚未配对") }
      return
    }
    if !hasCachedValue { providers = .loading }
    let requestDataGeneration = dataGeneration
    let requestConnectionRevision = connectionSuccessRevision
    providersTask = Task { [weak self] in
      do {
        let discovery = try await client.providersWithCapability()
        let list = discovery.providers
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.providersTask = nil
          self.recordSuccess()
          self.providerDiscoverySupported = discovery.capability == 2
          self.providersLoadedAt = Date()
          self.applyProviderCatalog(list)
          let usable = list.filter { $0.available }
          if let chosen = self.chosenProvider {
            if let refreshed = usable.first(where: { Self.sameProviderContext($0, chosen) }) {
              // Metadata has no controls. Keep the observed catalog and user
              // choices until a selected-context reply can validate them.
              if discovery.capability != 2 { self.chosenProvider = refreshed }
            } else {
              self.providerControlsRequestID += 1
              self.providerControlsTask?.cancel(); self.providerControlsTask = nil
              self.providerControlsLoaded = false
              self.providerControlsCwd = nil
              self.providerControlsLoading = false
              self.chosenProvider = nil
              self.chosenModelId = nil
              self.chosenEffort = nil
              self.permissionMode = "default"
            }
          }
          self.applyPreferredProvider(self.latestProviderPreference.id,
                                      agentProfileId: self.latestProviderPreference.agentProfileId)
          self.restoreActiveContext()
          if let provider = self.chosenProvider, let cwd = self.chosen?.path {
            self.loadProviderControls(providerId: provider.id, cwd: cwd, agentProfileId: provider.agentProfileId)
          }
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.providersTask = nil
          self.recordFailure(error, since: requestConnectionRevision)
          if !hasCachedValue { self.providers = .failed(Self.describe(error)) }
        }
      }
    }
  }

  func applyProviderCatalog(_ list: [G0Transport.RunProviderRef]) {
    let usable = list.filter { $0.available }
    providers = usable.isEmpty ? .empty : .loaded(usable)
    if let selected = chosenProvider {
      if let refreshed = usable.first(where: { Self.sameProviderContext($0, selected) }) {
        chosenProvider = refreshed
        // Keep unavailable model/effort choices visible and block sending,
        // rather than silently replacing a conversation's selection with auto.
        if !(refreshed.permissions ?? []).contains(where: { $0.id == permissionMode }) {
          permissionMode = refreshed.permissions?.first(where: { $0.id == "default" })?.id ?? refreshed.permissions?.first?.id ?? "default"
        }
      } else {
        chosenProvider = nil
        chosenModelId = nil
        chosenEffort = nil
        permissionMode = "default"
      }
    }
    applyPreferredProvider(latestProviderPreference.id, agentProfileId: latestProviderPreference.agentProfileId)
    restoreActiveContext()
  }

  static func sameProviderContext(_ lhs: G0Transport.RunProviderRef, _ rhs: G0Transport.RunProviderRef) -> Bool {
    lhs.id == rhs.id && lhs.agentProfileId == rhs.agentProfileId
  }

  func applyPreferredProvider(_ preferredId: String?, agentProfileId: String?) {
    guard let preferredId, case let .loaded(items) = providers else { return }
    let preferred = items.first(where: { $0.id == preferredId && $0.agentProfileId == agentProfileId })
    guard let preferred else {
      // Never resume under another Provider or profile when the preferred
      // identity is unavailable.
      chosenProvider = nil
      chosenModelId = nil
      chosenEffort = nil
      restoredControlErrors = [:]
      permissionMode = "default"
      return
    }
    guard chosenProvider.map({ !Self.sameProviderContext($0, preferred) }) ?? true else { return }
    chooseProvider(preferred)
  }

  // Rehydrate a recovered run's original routing without selecting a nearby
  // provider/profile or silently changing its controls. Metadata loaders call
  // this after their authoritative lists arrive; unavailable values stay
  // visibly unavailable and keep submission gated.
  @discardableResult
  func restoreActiveContext() -> Bool {
    guard contextNeedsRestore, let routing = activeRouting else { return false }
    // The host still authorizes the canonical path at submit. This only restores
    // a previously granted descendant for presentation, not a new grant.
    if case let .loaded(projects) = projects {
      chosen = projects.contains(where: { routing.cwd == $0.path || routing.cwd.hasPrefix($0.path + "/") })
        ? .init(path: routing.cwd, label: URL(fileURLWithPath: routing.cwd).lastPathComponent) : nil
    } else if case .empty = projects { chosen = nil }
    if case let .loaded(providers) = providers {
      let metadata = providers.first(where: {
        $0.id == routing.providerId && $0.agentProfileId == routing.agentProfileId
      })
      if metadata == nil || chosenProvider?.id != routing.providerId || chosenProvider?.agentProfileId != routing.agentProfileId {
        chosenProvider = metadata
        providerControlsLoaded = false
        providerControlsCwd = nil
      }
      guard let provider = chosenProvider else {
        chosenModelId = nil
        chosenEffort = nil
        permissionMode = "default"
        return false
      }
      let remembered = modelSelectionKey().flatMap { key in storedModelSelections().first { $0.key == key } }
      guard providerControlsLoaded, providerControlsCwd == routing.cwd else {
        if chosen?.path == routing.cwd, !providerControlsLoading {
          loadProviderControls(providerId: routing.providerId, cwd: routing.cwd, agentProfileId: routing.agentProfileId)
        }
        return !contextNeedsRestore && restoredControlsError == nil && chosen?.path == routing.cwd
      }
      restoredControlErrors = [:]
      providerControlsNeedDefaults = false
      if let remembered {
        chosenModelId = remembered.modelId
      } else if let modelId = routing.modelId {        if let model = (provider.models ?? []).first(where: { $0.id == modelId && $0.providerId == routing.modelProviderId }) {
          chosenModelId = model.selectionId
        } else {
          chosenModelId = nil
          restoredControlErrors[.model] = ConnectionCopy.restoredModelUnavailable
        }
      } else {
        chosenModelId = nil
      }
      if let remembered {
        chosenEffort = remembered.effort
      } else if let effort = routing.effort {
        if (provider.models?.first(where: { $0.selectionId == chosenModelId })?.efforts ?? provider.efforts ?? []).contains(where: { $0.id == effort }) {
          chosenEffort = effort
        } else {
          chosenEffort = nil
          restoredControlErrors[.effort] = ConnectionCopy.restoredEffortUnavailable
        }
      } else {
        chosenEffort = nil
      }
      if let permission = routing.permissionMode {
        if provider.permissions?.contains(where: { $0.id == permission }) == true || (provider.permissions == nil && permission == "default") {
          permissionMode = permission
        } else {
          permissionMode = permission
          restoredControlErrors[.permission] = ConnectionCopy.restoredPermissionUnavailable
        }
      } else {
        permissionMode = "default"
      }
      if chosen != nil, commands == .idle {
        loadCommands(providerId: routing.providerId, cwd: routing.cwd,
                     agentProfileId: routing.agentProfileId)
      }
      if chosen != nil && controlsReady {
        modelSelectionSession = activeSessionIdentity
        rememberModelSelection()
        contextNeedsRestore = false
        return true
      }
      return false
    }
    chosenProvider = nil
    chosenModelId = nil
    chosenEffort = nil
    return false
  }

  func loadActiveContext() {
    guard contextNeedsRestore, let routing = activeRouting else { return }
    loadProjects()
    loadProviders(preferredId: routing.providerId, preferredAgentProfileId: routing.agentProfileId)
    restoreActiveContext()
  }
}
