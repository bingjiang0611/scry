import Foundation
import RemoteTransport

extension RemoteRunStore {
  func loadCommands(providerId: String, cwd: String, agentProfileId: String? = nil, force: Bool = false) {
    #if DEBUG
    if mockMode { return }
    #endif
    let key = providerId + "\u{1f}" + (agentProfileId ?? "") + "\u{1f}" + cwd
    commandsRequestGeneration += 1
    let requestGeneration = commandsRequestGeneration
    commandsTask?.cancel()
    commandsTask = nil
    if !force, let cached = commandCache[key] {
      commands = cached.commands.isEmpty ? .empty(cached.reason) : .loaded(cached.commands)
      return
    }
    guard let client = makeClient() else { commands = .failed("尚未配对"); return }
    commands = .loading
    let requestDataGeneration = dataGeneration
    commandsTask = Task { [weak self] in
      do {
        let catalog = try await client.commands(providerId: providerId, cwd: cwd, agentProfileId: agentProfileId)
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration,
                self.commandsRequestGeneration == requestGeneration else { return }
          self.commandsTask = nil
          self.recordSuccess()
          self.commandCache[key] = catalog
          self.commands = catalog.commands.isEmpty ? .empty(catalog.reason) : .loaded(catalog.commands)
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration,
                self.commandsRequestGeneration == requestGeneration else { return }
          self.commandsTask = nil
          self.commands = .failed(Self.describe(error))
        }
      }
    }
  }

  var slashCommands: [G0Transport.RunCommandRef] {
    if case let .loaded(items) = commands { return items }
    return []
  }

  var slashCommandsLoading: Bool {
    if case .loading = commands { return true }
    return false
  }

  var slashCommandsReason: String? {
    switch commands {
    case let .empty(reason): return reason
    case let .failed(reason): return reason
    default: return nil
    }
  }

  // Load the host-authorized project directories. The phone can never authorize
  // a new one; it only chooses among these, and the host re-checks on submit.
  func loadProjects(force: Bool = false) {
    #if DEBUG
    if mockMode { return }
    #endif
    let hasCachedValue: Bool
    switch projects { case .loaded, .empty: hasCachedValue = true; default: hasCachedValue = false }
    if !force, hasCachedValue, isFresh(projectsLoadedAt, within: Self.metadataFreshness) { return }
    guard projectsTask == nil else { return }
    guard let client = makeClient() else {
      if !hasCachedValue { projects = .failed("尚未配对，无法读取项目") }
      return
    }
    if !hasCachedValue { projects = .loading }
    let requestDataGeneration = dataGeneration
    let requestConnectionRevision = connectionSuccessRevision
    projectsTask = Task { [weak self] in
      do {
        let list = try await client.projects()
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.projectsTask = nil
          self.recordSuccess()
          self.projectsLoadedAt = Date()
          self.projects = list.isEmpty ? .empty : .loaded(list)
          _ = self.restoreActiveContext()
          if let provider = self.chosenProvider, let cwd = self.chosen?.path {
            self.loadProviderControls(providerId: provider.id, cwd: cwd, agentProfileId: provider.agentProfileId)
          }
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.projectsTask = nil
          self.recordFailure(error, since: requestConnectionRevision)
          if !hasCachedValue { self.projects = .failed(Self.describe(error)) }
        }
      }
    }
  }

  // Browse exactly one hierarchy level. A nil path requests authorized roots;
  // the host rejects every path outside those roots before reading the folder.
  func loadDirectories(path: String? = nil) {
    #if DEBUG
    if mockMode { loadMockDirectories(path: path); return }
    #endif
    guard let client = makeClient() else { directories = .failed("尚未配对，无法读取文件夹"); return }
    directoriesRequestGeneration += 1
    let directoriesRequest = directoriesRequestGeneration
    directoriesTask?.cancel()
    directories = .loading
    let requestGeneration = generation
    let requestConnectionRevision = connectionSuccessRevision
    directoriesTask = Task { [weak self] in
      do {
        let listing = try await client.directories(path: path)
        await MainActor.run {
          guard let self, self.generation == requestGeneration,
                self.directoriesRequestGeneration == directoriesRequest else { return }
          self.directoriesTask = nil
          self.recordSuccess(); self.directories = .loaded(listing)
        }
      } catch {
        await MainActor.run {
          guard let self, self.generation == requestGeneration,
                self.directoriesRequestGeneration == directoriesRequest else { return }
          self.directoriesTask = nil
          self.recordFailure(error, since: requestConnectionRevision); self.directories = .failed(Self.describe(error))
        }
      }
    }
  }
}
