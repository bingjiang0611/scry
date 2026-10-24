// macOS 14+ manual acceptance. Only the two owned windows enter the cropped compositor capture.
import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

@main struct CaptureTestWindow {
  @MainActor static func main() async throws {
    NSApplication.shared.setActivationPolicy(.prohibited)
    guard #available(macOS 14.0, *), CGPreflightScreenCaptureAccess() else {
      throw NSError(domain: "ScryMaterial", code: 1, userInfo: [NSLocalizedDescriptionKey: "Screen capture permission and macOS 14+ are required"])
    }
    print("{\"ready\":true}")
    fflush(stdout)
    for try await line in FileHandle.standardInput.bytes.lines {
      let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
      let id = UInt32(request["id"] as! String)!
      let points = request["points"] as! [[String: Double]]
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      guard let window = content.windows.first(where: { $0.windowID == id }) else {
        throw NSError(domain: "ScryMaterial", code: 2, userInfo: [NSLocalizedDescriptionKey: "The owned test window is not on screen"])
      }
      let backgroundID = UInt32(request["backgroundID"] as! String)!
      let background = content.windows.first(where: { $0.windowID == backgroundID })!
      let display = content.displays.first(where: { $0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY)) })!
      let filter = SCContentFilter(display: display, including: [window, background])
      let configuration = SCStreamConfiguration()
      configuration.sourceRect = window.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
      configuration.width = Int(window.frame.width * Double(filter.pointPixelScale))
      configuration.height = Int(window.frame.height * Double(filter.pointPixelScale))
      configuration.showsCursor = false
      configuration.ignoreShadowsSingleWindow = true
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
      let output = URL(fileURLWithPath: request["output"] as! String)
      let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
      CGImageDestinationAddImage(destination, image, nil)
      guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "ScryMaterial", code: 3) }
      let width = image.width, height = image.height
      var rgba = [UInt8](repeating: 0, count: width * height * 4)
      let samples = rgba.withUnsafeMutableBytes { bytes -> [[Int]] in
        let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return points.map { point in
          let x = min(width - 1, max(0, Int(point["x"]! * Double(width))))
          let y = min(height - 1, max(0, Int(point["y"]! * Double(height))))
          let index = (y * width + x) * 4
          return (0..<4).map { Int(bytes[index + $0]) }
        }
      }
      print(String(data: try JSONSerialization.data(withJSONObject: ["width": width, "height": height, "samples": samples]), encoding: .utf8)!)
      fflush(stdout)
    }
  }
}
