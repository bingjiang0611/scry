import Foundation
import RemoteTransport

// DEBUG-only, launch-argument driven (`-selfTest`) runtime verification of the
// device-side protocol/crypto/storage that needs NO network: real P-256 CSR
// generation + restore, pairing-code parsing (valid + tampered), and a Keychain
// round-trip. It is NOT a substitute for on-device pairing against a live relay
// and host, and it never claims a paired state. It prints machine-checkable
// lines and exits non-zero on the first failure so a simulator run can assert.
#if DEBUG
enum RemoteSelfTest {
  static func runIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-selfTest") else { return }
    var failures = 0
    func check(_ name: String, _ ok: Bool) {
      print("SELFTEST \(name) \(ok ? "PASS" : "FAIL")")
      if !ok { failures += 1 }
    }

    // 1. Enrollment: a real CSR + self-signed bootstrap cert, and a byte-exact
    //    restore of the same key material.
    do {
      let material = try G0EnrollmentMaterial.generate()
      let csr = String(decoding: material.csrPEM, as: UTF8.self)
      let bootstrap = String(decoding: material.bootstrapPEM, as: UTF8.self)
      check("enrollment.csr", csr.contains("BEGIN CERTIFICATE REQUEST"))
      check("enrollment.bootstrap", bootstrap.contains("BEGIN CERTIFICATE"))
      check("enrollment.fingerprint", material.publicKeySHA256.count == 64)
      let restored = try G0EnrollmentMaterial.restore(privateKeyPEM: material.privateKeyPEM)
      check("enrollment.restore", restored.publicKeySHA256 == material.publicKeySHA256)
    } catch { check("enrollment", false); print("  error: \(error)") }

    // 2. Pairing code: a well-formed code parses to the exact fields; tampered
    //    variants are rejected field-by-field (fail closed).
    do {
      let anchor = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
      let json: [String: Any] = ["relayHost": "relay.example.com", "relayPort": 443,
        "hostId": "c110921f-ba1f-45dd-9774-db10d5f3848f", "pairingId": "5afb2a38-425a-46a3-b004-ef62ce44bb9a",
        "secret": "SLb_kXYTlqzucIe3pQTo6FFtPE0JW4OWR1tP2CqT6eI", "anchorPEM": anchor]
      let data = try JSONSerialization.data(withJSONObject: json)
      let code = "scry1:" + PairingCode.base64urlEncode(data)
      let parsed = try PairingCode.parse(code)
      check("code.parse", parsed.relayHost == "relay.example.com" && parsed.relayPort == 443 && parsed.anchorPEM.contains("BEGIN CERTIFICATE"))
      // Absent relayTLS defaults to the secure public-wss mode (fail-safe).
      check("code.tlsDefaultSystem", parsed.relayTLS == .system)
      check("code.badPrefix", (try? PairingCode.parse("nope:" + PairingCode.base64urlEncode(data))) == nil)
      check("code.badBase64", (try? PairingCode.parse("scry1:!!!not-base64!!!")) == nil)
      var bad = json; bad["secret"] = "too-short"
      let badData = try JSONSerialization.data(withJSONObject: bad)
      check("code.badSecret", (try? PairingCode.parse("scry1:" + PairingCode.base64urlEncode(badData))) == nil)
      // A local dev relay must explicitly opt into plaintext ws.
      var plain = json; plain["relayTLS"] = "plaintext"
      let plainData = try JSONSerialization.data(withJSONObject: plain)
      check("code.tlsPlaintext", (try PairingCode.parse("scry1:" + PairingCode.base64urlEncode(plainData))).relayTLS == .plaintext)
      // An unknown relayTLS value is rejected, never silently downgraded.
      var badTLS = json; badTLS["relayTLS"] = "weird"
      let badTLSData = try JSONSerialization.data(withJSONObject: badTLS)
      check("code.badTLS", (try? PairingCode.parse("scry1:" + PairingCode.base64urlEncode(badTLSData))) == nil)
    } catch { check("code", false); print("  error: \(error)") }

    // 3. Keychain: insert-only device key + upsertable grant round-trip in an
    //    isolated test service, then cleaned up. An UNSIGNED simulator build has
    //    no keychain-access-group entitlement (errSecMissingEntitlement -34018),
    //    so this is honestly SKIPPED there rather than faked; it is exercised on
    //    a signed device build.
    do {
      let keychain = RemoteKeychain(service: "com.scry.remote.selftest")
      try? keychain.remove(.deviceKey); try? keychain.remove(.grantedCert)
      let key = Data("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n".utf8)
      do { try keychain.insertDeviceKey(key) }
      catch let f as RemoteKeychain.Failure where f.status == -34018 {
        print("SELFTEST keychain SKIP env=unsigned-simulator-missing-entitlement")
        print("SELFTEST DONE failures=\(failures)")
        exit(failures == 0 ? 0 : 1)
      }
      let loaded = try keychain.load(.deviceKey)
      check("keychain.deviceKey", loaded == key)
      var duplicated = false
      do { try keychain.insertDeviceKey(Data("other".utf8)) } catch let f as RemoteKeychain.Failure where f.isDuplicate { duplicated = true } catch {}
      let afterDup = try keychain.load(.deviceKey)
      check("keychain.insertOnly", duplicated && afterDup == key)
      let cert = Data("cert-v1".utf8)
      try keychain.upsertGrantedCert(cert)
      let grant1 = try keychain.load(.grantedCert)
      check("keychain.grant", grant1 == cert)
      try keychain.upsertGrantedCert(Data("cert-v2".utf8))
      let grant2 = try keychain.load(.grantedCert)
      check("keychain.grantRenew", grant2 == Data("cert-v2".utf8))
      try keychain.remove(.deviceKey); try keychain.remove(.grantedCert)
    } catch { check("keychain", false); print("  error: \(error)") }

    print("SELFTEST DONE failures=\(failures)")
    exit(failures == 0 ? 0 : 1)
  }

  // Opt-in NETWORK probe (`-relayTLSProbe <host>`): verifies that this device's
  // system trust store validates the relay's PUBLIC certificate via the `.system`
  // outer-TLS mode. Kept separate from the offline self-test because it needs
  // real internet and only exercises the outer hop (no host leg, no pairing).
  static func runRelayTLSProbeIfRequested() {
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-relayTLSProbe"), i + 1 < args.count else { return }
    let host = args[i + 1]
    Task {
      do {
        let negotiated = try await G0Transport.probeSystemTLS(host: host)
        print("SELFTEST relayTLS.systemTrust PASS host=\(host) negotiated=\(negotiated)")
        print("SELFTEST DONE failures=0")
        exit(0)
      } catch {
        print("SELFTEST relayTLS.systemTrust FAIL host=\(host) error=\(error)")
        print("SELFTEST DONE failures=1")
        exit(1)
      }
    }
    // Dedicated probe launch: keep the process alive until the Task exits.
    RunLoop.current.run()
  }
}
#endif
