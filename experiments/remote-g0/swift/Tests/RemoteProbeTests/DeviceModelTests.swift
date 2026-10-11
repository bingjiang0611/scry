import XCTest
@testable import RemoteTransport

final class DeviceModelTests: XCTestCase {
  func testMarketingNamesComeFromHardwareNotTheGenericDeviceName() {
    let examples = [
      "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max",
      "iPhone14,6": "iPhone SE (3rd generation)",
      "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
      "iPhone17,5": "iPhone 16e", "iPhone18,1": "iPhone 17 Pro",
      "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17",
      "iPhone18,4": "iPhone Air", "iPhone18,5": "iPhone 17e"
    ]
    for (identifier, name) in examples {
      XCTAssertEqual(RemoteDeviceModel.label(identifier: identifier), name)
    }
  }

  func testUnknownHardwareIsNotAssignedAnInventedModel() {
    XCTAssertEqual(RemoteDeviceModel.label(identifier: "iPhone99,1"), "iPhone99,1")
    XCTAssertEqual(RemoteDeviceModel.label(identifier: "iPad16,3"), "iPad16,3")
    XCTAssertEqual(RemoteDeviceModel.label(identifier: nil), "型号未知")
  }

  func testSimulatorIsAlwaysDistinguishedFromAPhysicalPhone() {
    XCTAssertEqual(RemoteDeviceModel.label(identifier: "iPhone18,1", isSimulator: true), "iPhone 17 Pro（模拟器）")
    XCTAssertEqual(RemoteDeviceModel.label(identifier: "iPhone99,1", isSimulator: true), "iPhone99,1（模拟器）")
    XCTAssertEqual(RemoteDeviceModel.label(identifier: nil, isSimulator: true), "型号未知（模拟器）")
  }
}
