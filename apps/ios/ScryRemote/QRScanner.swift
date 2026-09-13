import SwiftUI
import AVFoundation

// Minimal QR scanner. It reads exactly one code and hands the raw string up; it
// makes NO trust decision itself - PairingCode.parse validates the `scry1:`
// payload and RemotePairingClient runs the real inner-mTLS possession proof.
struct QRScanner: UIViewControllerRepresentable {
  let onCode: (String) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }
  func makeUIViewController(context: Context) -> ScannerViewController {
    let vc = ScannerViewController()
    vc.onCode = { context.coordinator.deliver($0) }
    return vc
  }
  func updateUIViewController(_ vc: ScannerViewController, context: Context) {}

  final class Coordinator {
    private let onCode: (String) -> Void
    private var delivered = false
    init(onCode: @escaping (String) -> Void) { self.onCode = onCode }
    // Fire once: a QR stays in frame for many sample callbacks.
    func deliver(_ code: String) {
      guard !delivered else { return }
      delivered = true
      onCode(code)
    }
  }
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var onCode: ((String) -> Void)?
  private let session = AVCaptureSession()
  private var preview: AVCaptureVideoPreviewLayer?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    guard let device = AVCaptureDevice.default(for: .video),
          let input = try? AVCaptureDeviceInput(device: device),
          session.canAddInput(input) else { return }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else { return }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    layer.frame = view.layer.bounds
    view.layer.addSublayer(layer)
    preview = layer
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.session.startRunning() }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.layer.bounds
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if session.isRunning { session.stopRunning() }
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
    guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
          let value = object.stringValue else { return }
    if session.isRunning { session.stopRunning() }
    onCode?(value)
  }
}
