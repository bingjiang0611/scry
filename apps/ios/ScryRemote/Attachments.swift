import SwiftUI
import RemoteTransport
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Attachments and composer

struct DraftAttachment: Identifiable, Equatable {
  enum Kind { case image, text }
  let id = UUID()
  let kind: Kind
  let name: String
  let mimeType: String
  let data: Data

  var wireValue: RemoteRunClient.Attachment {
    .init(kind: kind == .image ? .image : .text, name: name, mimeType: mimeType,
          dataBase64: data.base64EncodedString(), size: data.count)
  }

  var detail: String {
    let value = ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
    return kind == .image ? "图片 · \(value)" : "文本文件 · \(value)"
  }

  // Mirrors the host limits in src/main/remote/host-controller.ts.
  static let maxCount = 4
  static let maxEachBytes = 512 * 1024
  static let maxTotalBytes = 700 * 1024

  // Each image gets an even share of the budget still free for the images
  // left in this batch. A fixed per-image target let the first two or three
  // photos consume the whole 700 KB and the rest were rejected.
  static func imageBudget(usedBytes: Int, remainingImages: Int) -> Int {
    min(maxEachBytes, max(0, maxTotalBytes - usedBytes) / max(1, remainingImages))
  }

  #if canImport(UIKit)
  // Lowers quality first, then resolution, until the JPEG fits `maxBytes`.
  // The renderer scale is pinned to 1: the default screen scale (3x) used to
  // triple the pixel dimensions and inflate every photo.
  static func compactJPEG(_ data: Data, maxBytes: Int) -> Data? {
    guard maxBytes > 0, let source = UIImage(data: data) else { return nil }
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    for maxSide: CGFloat in [1600, 1280, 1024, 768] {
      let scale = min(1, maxSide / max(source.size.width, source.size.height))
      let size = CGSize(width: max(1, (source.size.width * scale).rounded()),
                        height: max(1, (source.size.height * scale).rounded()))
      let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
        source.draw(in: CGRect(origin: .zero, size: size))
      }
      for quality in [0.72, 0.58, 0.44, 0.32] {
        if let out = image.jpegData(compressionQuality: quality), out.count <= maxBytes { return out }
      }
    }
    return nil
  }
  #else
  static func compactJPEG(_ data: Data, maxBytes: Int) -> Data? { nil }
  #endif
}

struct AttachmentPreviewItem: Identifiable {
  let id = UUID()
  let name: String
  let data: Data
}

#if canImport(UIKit)
struct AttachmentThumbnail: View {
  let data: Data
  let side: CGFloat
  // Decoded once per view identity instead of on every body evaluation.
  @State private var image: UIImage?

  var body: some View {
    ZStack {
      Palette.canvas
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: Symbol.photo).foregroundStyle(Palette.muted)
      }
    }
    .frame(width: side, height: side)
    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    .task(id: data) { image = UIImage(data: data)?.preparingThumbnail(of: CGSize(width: side * 3, height: side * 3)) }
  }
}

// Full-screen view of the exact bytes staged or sent; pinch to zoom, double-tap to reset.
struct AttachmentImagePreview: View {
  let item: AttachmentPreviewItem
  // Decoded once; the body re-evaluates on every pinch frame.
  private let image: UIImage?
  @Environment(\.dismiss) private var dismiss
  @State private var scale: CGFloat = 1
  @State private var baseScale: CGFloat = 1
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(item: AttachmentPreviewItem) {
    self.item = item
    image = UIImage(data: item.data)
  }

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Palette.main.ignoresSafeArea()
      if let image {
        Image(uiImage: image).resizable().scaledToFit()
          .scaleEffect(scale)
          .gesture(MagnifyGesture()
            .onChanged { scale = min(5, max(1, baseScale * $0.magnification)) }
            .onEnded { _ in baseScale = scale })
          .onTapGesture(count: 2) {
            withAnimation(reduceMotion ? nil : Motion.animation(.select, reduceMotion: false)) { scale = 1; baseScale = 1 }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityLabel(item.name)
      } else {
        Text("无法显示该图片").foregroundStyle(Palette.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      Button { dismiss() } label: {
        Image(systemName: "xmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.fg)
          .frame(width: 40, height: 40).background(.ultraThinMaterial, in: Circle())
      }
      .accessibilityLabel("关闭预览").padding(16)
    }
  }
}
#endif

// Attachments inside a sent user bubble: tappable image thumbnails plus
// file labels. Images without retained bytes (e.g. history) fall back to a label.
struct SentAttachmentList: View {
  let attachments: [RemoteRunStore.SentAttachment]
  @State private var previewing: AttachmentPreviewItem?

  var body: some View {
    let images = attachments.filter { $0.imageData != nil }
    let others = attachments.filter { $0.imageData == nil }
    VStack(alignment: .leading, spacing: 8) {
      #if canImport(UIKit)
      if !images.isEmpty {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 64, maximum: 96), spacing: 6)], alignment: .leading, spacing: 6) {
          ForEach(images) { item in
            if let data = item.imageData {
              Button { previewing = AttachmentPreviewItem(name: item.name, data: data) } label: {
                AttachmentThumbnail(data: data, side: 64)
              }
              .buttonStyle(.plain).accessibilityLabel("查看 \(item.name)")
            }
          }
        }
      }
      #endif
      ForEach(others) { item in
        Label(item.name, systemImage: item.kind == .image ? Symbol.photo : Symbol.file)
          .font(.system(size: 11, weight: .medium)).lineLimit(1)
      }
    }
    #if canImport(UIKit)
    .fullScreenCover(item: $previewing) { AttachmentImagePreview(item: $0) }
    #endif
  }
}
