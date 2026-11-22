import SwiftUI
import AVFoundation
import OSLog

enum CameraScanFailure {
  case denied, restricted, unavailable, setup

  var detail: String {
    switch self {
    case .denied: ConnectionCopy.cameraDenied
    case .restricted: ConnectionCopy.cameraRestricted
    case .unavailable: ConnectionCopy.cameraUnavailable
    case .setup: ConnectionCopy.cameraFailed
    }
  }
}

// The scanner only returns bytes. PairingCode and the mTLS possession proof
// remain the trust boundary; camera denial must not strand the user on black.
struct QRScanner: UIViewControllerRepresentable {
  let onCode: (String) -> Void
  let onFailure: (CameraScanFailure) -> Void

  func makeUIViewController(context: Context) -> ScannerViewController {
    let controller = ScannerViewController()
    controller.onCode = onCode
    controller.onFailure = onFailure
    return controller
  }
  func updateUIViewController(_ controller: ScannerViewController, context: Context) {}
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var onCode: ((String) -> Void)?
  var onFailure: ((CameraScanFailure) -> Void)?
  private let session = AVCaptureSession()
  private let captureQueue = DispatchQueue(label: "com.scry.remote.camera")
  private var preview: AVCaptureVideoPreviewLayer?
  private var finished = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: configureCamera()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
        DispatchQueue.main.async {
          guard let self, !self.finished else { return }
          if allowed { self.configureCamera() }
          else { self.fail(.denied) }
        }
      }
    case .denied: fail(.denied)
    case .restricted: fail(.restricted)
    @unknown default: fail(.setup)
    }
  }

  private func configureCamera() {
    guard let device = AVCaptureDevice.default(for: .video) else {
      fail(.unavailable); return
    }
    do {
      let input = try AVCaptureDeviceInput(device: device)
      let output = AVCaptureMetadataOutput()
      guard session.canAddInput(input), session.canAddOutput(output) else {
        fail(.setup); return
      }
      session.addInput(input)
      session.addOutput(output)
      output.setMetadataObjectsDelegate(self, queue: .main)
      output.metadataObjectTypes = [.qr]
      let layer = AVCaptureVideoPreviewLayer(session: session)
      layer.videoGravity = .resizeAspectFill
      // Permission can arrive after the view's initial layout has finished.
      layer.frame = view.bounds
      view.layer.addSublayer(layer)
      preview = layer
      captureQueue.async { [session] in session.startRunning() }
    } catch {
      Logger(subsystem: "com.scry.remote", category: "camera").error("Scanner setup failed: \(String(describing: error), privacy: .private)")
      fail(.setup)
    }
  }

  private func fail(_ message: CameraScanFailure) {
    guard !finished else { return }
    finished = true
    // Presenting SwiftUI state must happen after the representable update.
    DispatchQueue.main.async { [weak self] in self?.onFailure?(message) }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    finished = true
    captureQueue.async { [session] in session.stopRunning() }
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
    guard !finished, let object = objects.first as? AVMetadataMachineReadableCodeObject,
          let value = object.stringValue else { return }
    finished = true
    captureQueue.async { [session] in session.stopRunning() }
    onCode?(value)
  }
}
