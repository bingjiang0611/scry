import Foundation
import RemoteTransport

// AppModel stores attachment drafts, but this command-line check does not build
// UIKit views or exercise attachment behavior. All refresh/cache code is real.
struct DraftAttachment: Equatable {}

@main
struct CatalogRefreshChecks {
  @MainActor static func main() async {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("scry-catalog-check-" + UUID().uuidString)
    var failures = 0
    do {
      let originalFailure = RemoteRunStore.CatalogRefreshFailure.transport("original request failure")
      var failure: RemoteRunStore.CatalogRefreshFailure? = originalFailure
      var refreshedAt: Date? = Date(timeIntervalSince1970: 123)
      var address: String? = "original.invalid"
      var paired = true
      let snapshot = CatalogRefreshDetailsSnapshot(failure: originalFailure,
        lastFullRefresh: refreshedAt, address: address, paired: paired)
      let originalID = snapshot.id
      // Model the successful background refresh and a subsequent pairing change.
      failure = nil
      refreshedAt = Date(timeIntervalSince1970: 456)
      address = nil
      paired = false
      let next = CatalogRefreshDetailsSnapshot(failure: .transport("next failure"),
        lastFullRefresh: nil, address: nil, paired: false)
      let snapshotChecks = [
        ("details.failureSurvivesBackgroundRecovery",
          failure == nil && snapshot.failure == originalFailure),
        ("details.metadataStaysWithOriginalRequest",
          snapshot.lastFullRefresh == Date(timeIntervalSince1970: 123) &&
          snapshot.address == "original.invalid" && snapshot.paired &&
          refreshedAt != snapshot.lastFullRefresh && address != snapshot.address && paired != snapshot.paired),
        ("details.presentationIdentityIsStable", snapshot.id == originalID && snapshot.id != next.id)
      ]
      let tlsChecks = [
        ("tls.outerLayerVisible", RemoteRunStore.describe(RelayTransportError.tlsHandshake(layer: .relay, detail: "fixture EOF")) == ConnectionCopy.relayTLSHandshakeFailure("fixture EOF")),
        ("tls.innerLayerVisible", RemoteRunStore.describe(RelayTransportError.tlsHandshake(layer: .host, detail: "fixture EOF")) == ConnectionCopy.hostTLSHandshakeFailure("fixture EOF"))
      ]
      let checks = try await RemoteRunStore.selfTestCatalogRefreshFlow(directory: directory)
        + RemoteRunStore.selfTestExecutionTargets(directory: directory.appendingPathComponent("targets"))
        + RemoteRunStore.selfTestInteractionState()
        + RemoteRunStore.selfTestModelSelection()
        + snapshotChecks + tlsChecks
      for (name, passed) in checks {
        print("\(passed ? "PASS" : "FAIL") catalog.\(name)")
        if !passed { failures += 1 }
      }
      print("Catalog checks: \(checks.count), failures: \(failures)")
    } catch {
      print("FAIL catalog.unexpected: \(error)")
      failures += 1
    }
    do { try FileManager.default.removeItem(at: directory) }
    catch { print("FAIL cleanup: \(error)"); failures += 1 }
    exit(failures == 0 ? 0 : 1)
  }
}
