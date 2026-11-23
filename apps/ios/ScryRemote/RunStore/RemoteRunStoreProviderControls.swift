import CryptoKit
import Foundation
import RemoteTransport

extension RemoteRunStore {
  var modelOptions: [G0Transport.RunModelOption] { chosenProvider?.models ?? [] }
  var providerControlsNotice: String? {
    if providerControlsLoading { return ConnectionCopy.providerControlsLoading }
    if let providerControlsError { return providerControlsError }
    if let restoredControlsError { return restoredControlsError }
    if providerDiscoverySupported == false { return ConnectionCopy.legacyProviderControls }
    return controlsReady ? ConnectionCopy.providerControlsObserved(chosenProvider?.observedAt) : nil
  }
  var effortOptions: [G0Transport.RunControlOption] {
    if let chosenModelId, let model = modelOptions.first(where: { $0.selectionId == chosenModelId }) {
      return model.efforts ?? []
    }
    return chosenProvider?.efforts ?? []
  }
  var chosenModel: G0Transport.RunModelOption? {
    guard let chosenModelId else { return nil }
    return modelOptions.first(where: { $0.selectionId == chosenModelId })
  }
  var modelSelectionIssue: String? {
    // Nothing is known until the Provider's options arrive.
    if providerControlsLoading { return nil }
    if let error = restoredControlErrors[.model] ?? restoredControlErrors[.effort] { return error }
    if let chosenModelId, !modelOptions.contains(where: { $0.selectionId == chosenModelId }) {
      return ConnectionCopy.selectedModelUnavailable
    }
    if let chosenEffort, !effortOptions.contains(where: { $0.id == chosenEffort }) {
      return ConnectionCopy.selectedEffortUnavailable
    }
    return nil
  }
  // True when the only thing keeping controls unready is a restored choice the
  // Provider no longer offers, which re-reading cannot resolve.
  var restoredControlsBlockSend: Bool { !restoredControlErrors.isEmpty }
  var controlsReady: Bool {
    guard restoredControlsError == nil, providerControlsError == nil, !providerControlsLoading,
          providerControlsLoaded, let provider = chosenProvider, provider.available,
          let cwd = chosen?.path, providerControlsCwd == cwd else { return false }
    if let permissions = provider.permissions {
      guard permissions.contains(where: { $0.id == permissionMode }) else { return false }
    } else if permissionMode != "default" {
      return false
    }
    if let chosenModelId, !(provider.models ?? []).contains(where: { $0.selectionId == chosenModelId }) { return false }
    if let chosenEffort, !effortOptions.contains(where: { $0.id == chosenEffort }) { return false }
    return true
  }

  var restoredControlErrors: [RestoredControl: String] {
    get {
      #if DEBUG
      if forcedStalePermission { return [.permission: ConnectionCopy.permissionUnavailable] }
      #endif
      return storedRestoredControlErrors
    }
    set { storedRestoredControlErrors = newValue }
  }
  var restoredControlsError: String? { restoredControlErrors.values.first }
  func resetNewTaskContext() {
    // Only composer choices change. Existing runs/outbox already carry frozen
    // routing and must keep observing their original target and Provider.
    modelSelectionSession = nil
    chosen = nil; chosenProvider = nil; chosenModelId = nil; chosenEffort = nil
    permissionMode = "default"; latestProviderPreference = (nil, nil)
    restoredControlErrors = [:]; contextNeedsRestore = false
    commandsRequestGeneration += 1
    providerControlsRequestID += 1
    providerControlsTask?.cancel(); providerControlsTask = nil; providerControlsLoaded = false
    commandsTask?.cancel(); commandsTask = nil; commands = .idle
  }

  func chooseProject(_ ref: G0Transport.RunProjectRef) {
    chosen = ref
    if let provider = chosenProvider {
      loadProviderControls(providerId: provider.id, cwd: ref.path, agentProfileId: provider.agentProfileId)
      loadCommands(providerId: provider.id, cwd: ref.path, agentProfileId: provider.agentProfileId)
    }
  }
  func chooseProvider(_ ref: G0Transport.RunProviderRef) {
    restoredControlErrors = [:]
    providerControlsError = nil
    providerControlsLoaded = false
    providerControlsCwd = nil
    providerControlsNeedDefaults = true
    providerControlsLoading = false
    providerControlsRequestID += 1
    providerControlsTask?.cancel(); providerControlsTask = nil
    chosenProvider = ref
    chosenModelId = nil
    chosenEffort = nil
    permissionMode = ref.permissions?.first(where: { $0.id == "default" })?.id ?? ref.permissions?.first?.id ?? "default"
    restoreModelSelection()
    if let cwd = chosen?.path {
      loadProviderControls(providerId: ref.id, cwd: cwd, agentProfileId: ref.agentProfileId)
      loadCommands(providerId: ref.id, cwd: cwd, agentProfileId: ref.agentProfileId)
    }
  }

  func controlsMatch(providerId: String, agentProfileId: String?, cwd: String) -> Bool {
    controlsReady && chosenProvider?.id == providerId && chosenProvider?.agentProfileId == agentProfileId && providerControlsCwd == cwd
  }

  func retryProviderControls() {
    guard let provider = chosenProvider, let cwd = chosen?.path else { return }
    if providerDiscoverySupported == false {
      loadProviders(preferredId: provider.id, preferredAgentProfileId: provider.agentProfileId, force: true)
    } else {
      loadProviderControls(providerId: provider.id, cwd: cwd, agentProfileId: provider.agentProfileId)
    }
  }

  // A restored choice (permission/model/effort) can be invalid for the Provider
  // the host just resolved. Re-reading the same snapshot cannot fix that, so this
  // explicit action drops ONLY the invalid restored choices back to the Provider's
  // reported defaults. A valid user choice is never touched.
  @discardableResult
  func useProviderDefaultsForRestoredControls() -> Bool {
    guard !restoredControlErrors.isEmpty else { return false }
    #if DEBUG
    forcedStalePermission = false
    #endif
    if restoredControlErrors[.permission] != nil, let provider = chosenProvider {
      let preferred = provider.permissions?.first(where: { $0.isDefault == true })?.id
        ?? provider.permissions?.first(where: { $0.id == "default" })?.id
        ?? provider.permissions?.first?.id ?? "default"
      choosePermission(preferred)
    }
    if restoredControlErrors[.model] != nil || restoredControlErrors[.effort] != nil {
      chooseModel(nil)
    }
    return true
  }

  func loadSessionProviderControls(providerId: String, agentProfileId: String?, cwd: String, force: Bool = false) {
    // Session identity is presentation context, never a workspace grant. The
    // selected lookup and subsequent submit both revalidate it on the host.
    chosen = .init(path: cwd, label: URL(fileURLWithPath: cwd).lastPathComponent)
    loadProviders(preferredId: providerId, preferredAgentProfileId: agentProfileId, force: force)
    if let provider = chosenProvider, provider.id == providerId, provider.agentProfileId == agentProfileId,
       !force, !providerControlsLoading, !controlsMatch(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd) {
      loadProviderControls(providerId: providerId, cwd: cwd, agentProfileId: agentProfileId)
    }
  }

  func applyProviderControls(_ controls: G0Transport.RunProviderRef, cwd: String) {
    providerControlsLoading = false
    providerControlsError = controls.available ? nil : ConnectionCopy.providerControlsUnavailable
    providerControlsLoaded = controls.available
    providerControlsCwd = controls.available ? cwd : nil
    chosenProvider = controls
    guard controls.available else { return }
    if contextNeedsRestore { _ = restoreActiveContext(); return }
    if providerControlsNeedDefaults {
      permissionMode = controls.permissions?.first(where: { $0.isDefault == true })?.id ?? controls.permissions?.first(where: { $0.id == "default" })?.id ?? controls.permissions?.first?.id ?? "default"
      providerControlsNeedDefaults = false
    }
    restoredControlErrors[.model] = chosenModelId.map { id in
      modelOptions.contains(where: { $0.selectionId == id }) ? nil : ConnectionCopy.modelUnavailable
    } ?? nil
    restoredControlErrors[.effort] = chosenEffort.map { id in
      effortOptions.contains(where: { $0.id == id }) ? nil : ConnectionCopy.effortUnavailable
    } ?? nil
    restoredControlErrors[.permission] = controls.permissions.map { permissions in
      permissions.contains(where: { $0.id == permissionMode }) ? nil : ConnectionCopy.permissionUnavailable
    } ?? (permissionMode == "default" ? nil : ConnectionCopy.permissionUnavailable)
  }

  func loadProviderControls(providerId: String, cwd: String, agentProfileId: String?) {
    providerControlsRequestID += 1
    let requestID = providerControlsRequestID
    providerControlsTask?.cancel(); providerControlsTask = nil
    providerControlsLoaded = false
    providerControlsCwd = nil
    providerControlsError = nil
    providerControlsLoading = true
    #if DEBUG
    if mockMode, let provider = chosenProvider { applyProviderControls(provider, cwd: cwd); return }
    #endif
    if providerDiscoverySupported == false, let provider = chosenProvider {
      // Preserve the negotiated legacy snapshot contract; it is not advertised
      // as a fresh cwd-scoped catalog. Submission remains host-authorized.
      applyProviderControls(provider, cwd: cwd)
      return
    }
    guard let client = makeClient() else {
      providerControlsLoading = false
      providerControlsError = ConnectionCopy.providerControlsUnavailable
      return
    }
    providerControlsTask = Task { [weak self] in
      do {
        let controls = try await client.providerControls(providerId: providerId, cwd: cwd, agentProfileId: agentProfileId)
        await MainActor.run {
          guard let self, self.providerControlsRequestID == requestID,
                self.chosen?.path == cwd, self.chosenProvider.map({ Self.sameProviderContext($0, controls) }) == true else { return }
          self.providerControlsTask = nil
          self.applyProviderControls(controls, cwd: cwd)
        }
      } catch {
        await MainActor.run {
          guard let self, self.providerControlsRequestID == requestID else { return }
          self.providerControlsTask = nil
          self.providerControlsLoading = false
          self.providerControlsError = ConnectionCopy.providerControlsUnavailable
        }
      }
    }
  }
  func chooseModel(_ id: String?) {
    guard id == nil || modelOptions.contains(where: { $0.selectionId == id }) else { return }
    restoredControlErrors[.model] = nil
    restoredControlErrors[.effort] = nil
    contextNeedsRestore = false
    chosenModelId = id
    chosenEffort = nil
    rememberModelSelection()
  }
  func chooseEffort(_ id: String?) {
    guard id == nil || effortOptions.contains(where: { $0.id == id }) else { return }
    restoredControlErrors[.effort] = nil
    contextNeedsRestore = false
    chosenEffort = id
    rememberModelSelection()
  }

  func modelSelectionKey() -> String? {
    guard let provider = chosenProvider else { return nil }
    if let session = modelSelectionSession,
       session.providerId != provider.id || session.agentProfileId != provider.agentProfileId { return nil }
    let gateway = loadConnection().map { RemoteHistoryCache.catalogKey(connection: $0, target: targetScope) } ?? "preview"
    let fields = [gateway, provider.id, provider.agentProfileId ?? "",
                  modelSelectionSession == nil ? "new" : "session",
                  modelSelectionSession?.cwd ?? "", modelSelectionSession?.externalSessionId ?? "",
                  modelSelectionSession?.localId ?? ""]
    return SHA256.hash(data: try! JSONEncoder().encode(fields)).map { String(format: "%02x", $0) }.joined()
  }

  func storedModelSelections() -> [ModelSelection] {
    // Preview/offline fixtures must never read or alter a real pairing's preferences.
    guard loadConnection() != nil, !historyOnly,
          let data = connections.defaults.data(forKey: Self.modelSelectionsKey) else { return modelSelections }
    return (try? JSONDecoder().decode([ModelSelection].self, from: data)) ?? []
  }

  func rememberModelSelection() {
    guard let key = modelSelectionKey(), !historyOnly else { return }
    var entries = storedModelSelections().filter { $0.key != key }
    entries.append(ModelSelection(key: key, modelId: chosenModelId, effort: chosenEffort))
    // Preferences, not an audit log: retain the most recent 128 contexts.
    modelSelections = Array(entries.suffix(128))
    if loadConnection() != nil {
      connections.defaults.set(try! JSONEncoder().encode(modelSelections), forKey: Self.modelSelectionsKey)
    }
  }

  func restoreModelSelection() {
    let selection = modelSelectionKey().flatMap { key in storedModelSelections().first { $0.key == key } }
    chosenModelId = selection?.modelId
    chosenEffort = selection?.effort
    restoredControlErrors[.model] = nil
    restoredControlErrors[.effort] = nil
  }

  func activateModelSelection(for identity: SessionIdentity) {
    guard modelSelectionSession != identity else { return }
    modelSelectionSession = identity
    restoreModelSelection()
  }

  func choosePermission(_ id: String) {
    guard chosenProvider?.permissions?.contains(where: { $0.id == id }) == true else { return }
    restoredControlErrors[.permission] = nil
    contextNeedsRestore = false
    providerControlsNeedDefaults = false
    permissionMode = id
  }

  actor CatalogProgress {
    var receivedPage = false
    func markPage() { receivedPage = true }
  }
}
