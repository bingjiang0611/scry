import Foundation
import Darwin

public enum RemoteDeviceModel {
  public static var currentLabel: String {
    #if targetEnvironment(simulator)
    return label(identifier: ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], isSimulator: true)
    #else
    var info = utsname()
    guard uname(&info) == 0 else { return label(identifier: nil) }
    let identifier = withUnsafeBytes(of: &info.machine) { bytes in
      String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
    }
    return label(identifier: identifier)
    #endif
  }

  public static func label(identifier: String?, isSimulator: Bool = false) -> String {
    let model = identifier.map { models[$0] ?? $0 } ?? "型号未知"
    return isSimulator ? "\(model)（模拟器）" : model
  }

  // iOS 17-compatible phones through iPhone 17e. Identifiers are corroborated by
  // https://api.ipsw.me/v4/devices and DeviceKit's Device.generated.swift;
  // marketing names by https://support.apple.com/en-us/108044 (2026-10-11).
  // Unknown hardware stays an explicit identifier until its model is verified.
  private static let models: [String: String] = [
    "iPhone11,2": "iPhone XS",
    "iPhone11,4": "iPhone XS Max",
    "iPhone11,6": "iPhone XS Max",
    "iPhone11,8": "iPhone XR",
    "iPhone12,1": "iPhone 11",
    "iPhone12,3": "iPhone 11 Pro",
    "iPhone12,5": "iPhone 11 Pro Max",
    "iPhone12,8": "iPhone SE (2nd generation)",
    "iPhone13,1": "iPhone 12 mini",
    "iPhone13,2": "iPhone 12",
    "iPhone13,3": "iPhone 12 Pro",
    "iPhone13,4": "iPhone 12 Pro Max",
    "iPhone14,2": "iPhone 13 Pro",
    "iPhone14,3": "iPhone 13 Pro Max",
    "iPhone14,4": "iPhone 13 mini",
    "iPhone14,5": "iPhone 13",
    "iPhone14,6": "iPhone SE (3rd generation)",
    "iPhone14,7": "iPhone 14",
    "iPhone14,8": "iPhone 14 Plus",
    "iPhone15,2": "iPhone 14 Pro",
    "iPhone15,3": "iPhone 14 Pro Max",
    "iPhone15,4": "iPhone 15",
    "iPhone15,5": "iPhone 15 Plus",
    "iPhone16,1": "iPhone 15 Pro",
    "iPhone16,2": "iPhone 15 Pro Max",
    "iPhone17,1": "iPhone 16 Pro",
    "iPhone17,2": "iPhone 16 Pro Max",
    "iPhone17,3": "iPhone 16",
    "iPhone17,4": "iPhone 16 Plus",
    "iPhone17,5": "iPhone 16e",
    "iPhone18,1": "iPhone 17 Pro",
    "iPhone18,2": "iPhone 17 Pro Max",
    "iPhone18,3": "iPhone 17",
    "iPhone18,4": "iPhone Air",
    "iPhone18,5": "iPhone 17e"
  ]
}
