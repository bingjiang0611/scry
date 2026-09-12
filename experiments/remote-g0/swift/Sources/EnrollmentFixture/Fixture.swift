import Foundation
import Darwin
import RemoteTransport

// Test harness only. Native app enrollment calls the shared generator from its
// credential actor and stores the key in Keychain, never through this executable.
@main
struct EnrollmentFixture {
  enum Failure: Error { case invalidDirectory, fileExists }
  static func main() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args.count == 1 else { throw Failure.invalidDirectory }
    let directory = URL(fileURLWithPath: args[0]).resolvingSymlinksInPath()
    let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path
    let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
    guard directory.path.hasPrefix(temporary + "/scry-g0-"), attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700 else { throw Failure.invalidDirectory }
    let material = try G0EnrollmentMaterial.generate()
    var owned: [URL] = []
    do {
      for (name, bytes) in [("swift-device.key", material.privateKeyPEM), ("swift-device.csr", material.csrPEM),
                            ("swift-device-bootstrap.pem", material.bootstrapPEM)] {
        let url = directory.appendingPathComponent(name)
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw Failure.fileExists }
        owned.append(url)
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try file.write(contentsOf: bytes)
        try file.synchronize()
        try file.close()
      }
      print(material.publicKeySHA256)
    } catch {
      for url in owned { try? FileManager.default.removeItem(at: url) }
      throw error
    }
  }
}
