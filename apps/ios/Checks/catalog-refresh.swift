import Foundation

// AppModel stores attachment drafts, but this command-line check does not build
// UIKit views or exercise attachment behavior. All refresh/cache code is real.
struct DraftAttachment: Equatable {}

@main
struct CatalogRefreshChecks {
  @MainActor static func main() async {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("scry-catalog-check-" + UUID().uuidString)
    var failures = 0
    do {
      let checks = try await RemoteRunStore.selfTestCatalogRefreshFlow(directory: directory)
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
