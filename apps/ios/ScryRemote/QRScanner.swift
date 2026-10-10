import SwiftUI
import AVFoundation

// The scanner only returns bytes. PairingCode and the mTLS possession proof
// remain the trust boundary; camera denial must not strand the user on black.
struct QRScanner: UIViewControllerRepresentable {
  let onCode: (String) -> Void
  let onFailure: (String) -> Void

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
  var onFailure: ((String) -> Void)?
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
          else { self.fail("未允许相机访问。请在系统设置中允许 Scry 使用相机，再扫描配对码。") }
        }
      }
    default: fail("相机访问已关闭。请在系统设置中允许 Scry 使用相机，再扫描配对码。")
    }
  }

  private func configureCamera() {
    guard let device = AVCaptureDevice.default(for: .video) else {
      fail("此设备没有可用相机，无法扫码配对。"); return
    }
    do {
      let input = try AVCaptureDeviceInput(device: device)
      let output = AVCaptureMetadataOutput()
      guard session.canAddInput(input), session.canAddOutput(output) else {
        fail("无法启动相机，请关闭扫描页后重试。"); return
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
    } catch { fail("无法启动相机：\(error.localizedDescription)。请关闭扫描页后重试。") }
  }

  private func fail(_ message: String) {
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
