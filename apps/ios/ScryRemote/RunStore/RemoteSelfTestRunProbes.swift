import Foundation
import CryptoKit
import UIKit
import RemoteTransport

#if DEBUG
extension RemoteSelfTest {
  static func runLiveProviderProbeIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-liveProviderProbe") else { return }
    Task {
      guard let connection = RemoteConnectionStore().load() else {
        print("LIVEPROBE FAIL reason=no-persisted-connection")
        exit(1)
      }
      let client = RemoteRunClient(connection: connection)
      do {
        let projects = try await client.projects()
        let providers = try await client.providers()
        let preferred = ["codex", "qoder", "opencode"]
        let provider = preferred.compactMap { id in providers.first(where: { $0.id == id && $0.available }) }.first
          ?? providers.first(where: { $0.available })
        guard let project = projects.first, let provider else {
          print("LIVEPROBE FAIL reason=no-authorized-project-or-provider projects=\(projects.count) providers=\(providers.count)")
          exit(1)
        }
        let selected = try await client.providerControls(providerId: provider.id, cwd: project.path, agentProfileId: provider.agentProfileId)
        print("LIVEPROBE selected cwd=\(project.path) provider=\(selected.id)")
        let routing = RemoteRunClient.Routing(cwd: project.path, providerId: selected.id, agentProfileId: selected.agentProfileId,
          prompt: "只回复 SCRY_REMOTE_OK，不要调用工具，不要修改任何文件。")
        let submit = try await client.submit(routing: routing)
        print("LIVEPROBE submit runId=\(submit.runId) status=\(submit.status)")
        let terminal = try await awaitProbeTerminal(client: client, runId: submit.runId, seconds: 120)
        let ok = terminal == "run_settled"
        print("LIVEPROBE terminal=\(terminal ?? "none") expected=run_settled \(ok ? "PASS" : "FAIL")")
        print("LIVEPROBE DONE failures=\(ok ? 0 : 1)")
        exit(ok ? 0 : 1)
      } catch {
        print("LIVEPROBE FAIL error=\(error)")
        print("LIVEPROBE DONE failures=1")
        exit(1)
      }
    }
    RunLoop.current.run()
  }

  // Opt-in CONTRACT probe (`-historyContractProbe`): reports which history
  // contract the paired host actually answers, per request shape, so a device
  // Provider. This remains DEBUG-only and never selects full_access.
  static func runDirectoryAttachmentProbeIfRequested() {
    let args = ProcessInfo.processInfo.arguments
    let catalogOnly = args.contains("-directoryCatalogProbe")
    guard catalogOnly || args.contains("-directoryAttachmentProbe") else { return }
    Task {
      guard let connection = RemoteConnectionStore().load() else {
        print("DIRATTACH FAIL reason=no-persisted-connection")
        exit(1)
      }
      let client = RemoteRunClient(connection: connection)
      do {
        let roots = try await client.directories(path: nil).directories
        var selectedRoot: G0Transport.RunProjectRef?
        var selectedChild: G0Transport.RunProjectRef?
        for root in roots {
          let listing = try await client.directories(path: root.path)
          if let child = listing.directories.first {
            selectedRoot = root
            selectedChild = child
            break
          }
        }
        guard let root = selectedRoot, let child = selectedChild else {
          print("DIRATTACH FAIL reason=no-descendant roots=\(roots.count)")
          exit(1)
        }
        print("DIRATTACH descendant root=\(root.path) child=\(child.path)")

        if catalogOnly {
          let childListing = try await client.directories(path: child.path)
          guard childListing.current?.path == child.path, childListing.parent?.path == root.path else {
            print("DIRATTACH FAIL reason=hierarchy-mismatch root=\(root.path) child=\(child.path)")
            exit(1)
          }
          print("DIRATTACH hierarchy PASS parent=\(childListing.parent?.path ?? "none")")
          do {
            _ = try await client.directories(path: "/")
            print("DIRATTACH unauthorized FAIL path=/ unexpectedly-listed")
            exit(1)
          } catch G0Transport.RunError.host(let code) where code == "workspace_not_authorized" {
            print("DIRATTACH unauthorized PASS error=\(code)")
          }
        }

        let providers = try await client.providers()
        let provider = providers.first(where: { $0.id == "codex" && $0.available })
          ?? providers.first(where: { $0.available })
        guard let provider else {
          print("DIRATTACH FAIL reason=no-available-provider")
          exit(1)
        }
        let selected = try await client.providerControls(providerId: provider.id, cwd: child.path, agentProfileId: provider.agentProfileId)
        let effortCatalog = (selected.efforts ?? []).map { "\($0.id):\($0.isDefault == true ? "default" : "option")" }.joined(separator: ",")
        let permissionCatalog = (selected.permissions ?? []).map { "\($0.id):\($0.isDefault == true ? "default" : "option")" }.joined(separator: ",")
        print("DIRATTACH catalog provider=\(selected.id) model=\(selected.modelId ?? "native-default") efforts=[\(effortCatalog)] permissions=[\(permissionCatalog)]")
        if catalogOnly {
          print("DIRATTACH CATALOG DONE failures=0")
          exit(0)
        }

        let textData = Data("verification marker: SCRY_DESCENDANT_ATTACHMENT_OK\n".utf8)
        guard let imageData = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=") else {
          print("DIRATTACH FAIL reason=image-fixture")
          exit(1)
        }
        let attachments = [
          RemoteRunClient.Attachment(kind: .text, name: "scry-probe.txt", mimeType: "text/plain", dataBase64: textData.base64EncodedString(), size: textData.count),
          RemoteRunClient.Attachment(kind: .image, name: "scry-probe.png", mimeType: "image/png", dataBase64: imageData.base64EncodedString(), size: imageData.count)
        ]
        let effort = selected.efforts?.first(where: { $0.isDefault == true })?.id
        let permission = selected.permissions?.first(where: { $0.id == "default" })?.id
        let routing = RemoteRunClient.Routing(cwd: child.path, providerId: selected.id, agentProfileId: selected.agentProfileId,
          prompt: "读取随附文本，并只回复 SCRY_DESCENDANT_ATTACHMENT_OK；图片无需描述；不要调用工具，不要修改文件。",
          modelId: selected.modelId, effort: effort, permissionMode: permission, attachments: attachments)
        let submit = try await client.submit(routing: routing)
        print("DIRATTACH submit runId=\(submit.runId) status=\(submit.status) cwd=\(child.path) attachments=\(attachments.count) effort=\(effort ?? "native-default") permission=\(permission ?? "native-default")")
        let terminal = try await awaitProbeTerminal(client: client, runId: submit.runId, seconds: 180)
        let output = try await client.output(runId: submit.runId, cursor: 0)
        let reply = output.chunks.map(\.text).joined()
        let ok = terminal == "run_settled" && reply.contains("SCRY_DESCENDANT_ATTACHMENT_OK")
        print("DIRATTACH output=\(reply)")
        print("DIRATTACH terminal=\(terminal ?? "none") expected=run_settled replyMarker=\(reply.contains("SCRY_DESCENDANT_ATTACHMENT_OK")) \(ok ? "PASS" : "FAIL")")
        print("DIRATTACH DONE failures=\(ok ? 0 : 1)")
        exit(ok ? 0 : 1)
      } catch {
        print("DIRATTACH FAIL error=\(error)")
        print("DIRATTACH DONE failures=1")
        exit(1)
      }
    }
    // Return from App.init so iOS can finish launching; this probe spans several
    // real relay exchanges plus a Provider turn and must not trip the launch
    // watchdog. The unstructured task exits with a machine-checkable result.
  }

  static func runRunProbeIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-runProbe") else { return }
    Task {
      guard let connection = RemoteConnectionStore().load() else {
        print("RUNPROBE SKIP reason=no-persisted-connection (pair on this build first)")
        print("RUNPROBE DONE failures=0")
        exit(0)
      }
      let client = RemoteRunClient(connection: connection)
      do {
        let routing = RemoteRunClient.Routing(cwd: "/scry-run-probe-unauthorized", providerId: "claude", agentProfileId: nil, prompt: "probe")
        let submit = try await client.submit(routing: routing)
        print("RUNPROBE submit runId=\(submit.runId) status=\(submit.status)")
        let terminal = try await awaitProbeTerminal(client: client, runId: submit.runId, seconds: 10)
        let ok = terminal == "run_failed"
        print("RUNPROBE terminal=\(terminal ?? "none") expected=run_failed \(ok ? "PASS" : "FAIL")")
        print("RUNPROBE DONE failures=\(ok ? 0 : 1)")
        exit(ok ? 0 : 1)
      } catch {
        print("RUNPROBE FAIL error=\(error)")
        print("RUNPROBE DONE failures=1")
        exit(1)
      }
    }
    RunLoop.current.run()
  }

  private static func awaitProbeTerminal(client: RemoteRunClient, runId: String, seconds: Int) async throws -> String? {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(seconds))
    var cursor = 0
    var outputCursor = 0
    while clock.now < deadline {
      let remaining = deadline - clock.now
      let waitMs = max(1, min(15_000, Int(remaining.components.seconds) * 1_000))
      let update = try await client.watch(runId: runId, cursor: cursor, outputCursor: outputCursor, waitMs: waitMs)
      cursor = update.poll.cursor
      outputCursor = update.output.cursor
      switch update.state {
      case "settled": return "run_settled"
      case "failed", "interrupted": return "run_failed"
      case "cancelled": return "run_cancelled"
      default: break
      }
    }
    return nil
  }
}
#endif
