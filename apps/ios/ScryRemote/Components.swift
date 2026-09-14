import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import RemoteTransport
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Symbols

enum Symbol {
  static let menu = "line.3.horizontal"
  static let more = "ellipsis"
  static let laptop = "laptopcomputer"
  static let folder = "folder"
  static let branch = "arrow.triangle.branch"
  static let compose = "square.and.pencil"
  static let search = "magnifyingglass"
  static let plus = "plus"
  static let shield = "checkmark.shield"
  static let gauge = "gauge.with.dots.needle.33percent"
  static let send = "arrow.up"
  static let back = "chevron.left"
  static let agent = "cpu"
  static let file = "doc.text"
  static let photo = "photo"
  static let bell = "bell"
  static let chevrons = "chevron.up.chevron.down"
  static let chevron = "chevron.right"
  static let check = "checkmark"
  static let gear = "gearshape"
  static let link = "link"
}

// MARK: - Core controls

struct CircleButton: View {
  let symbol: String
  let label: String
  var filled = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: filled ? 18 : 17, weight: .medium))
        .frame(width: filled ? 46 : 44, height: filled ? 46 : 44)
        .foregroundStyle(filled ? Color.white : Palette.ink)
        .background(filled ? AnyShapeStyle(Palette.blue) : AnyShapeStyle(Color.clear), in: Circle())
        .shadow(color: filled ? Palette.blue.opacity(0.22) : .clear, radius: 9, y: 5)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.34 : 1)
    .accessibilityLabel(label)
  }
}

struct PlainIcon: View {
  let symbol: String
  let label: String
  var tint: Color = Palette.ink
  var disabled = false
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 17, weight: .medium))
        .frame(minWidth: 44, minHeight: 44)
        .foregroundStyle(tint)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.34 : 1)
    .accessibilityLabel(label)
  }
}

struct Notice: View {
  let text: String
  var warning = false
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: warning ? "exclamationmark.circle" : "info.circle")
        .font(.system(size: 13, weight: .medium)).padding(.top, 1)
      Text(text).font(.system(size: 12)).frame(maxWidth: .infinity, alignment: .leading)
    }
    .foregroundStyle(warning ? Palette.warnInk : Palette.noticeInk)
    .padding(.vertical, 10).padding(.horizontal, 12)
    .background(warning ? Palette.warnBg : Palette.noticeBg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 16).padding(.bottom, 9)
  }
}

struct EmptyState: View {
  let title: String
  let detail: String
  var symbol: String = "bubble.left.and.bubble.right"
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: symbol).font(.system(size: 27, weight: .light)).foregroundStyle(Palette.faint)
      Text(title).font(.system(size: 16, weight: .semibold)).multilineTextAlignment(.center)
      Text(detail).font(.system(size: 13)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 54).padding(.horizontal, 26)
  }
}

struct StatusDot: View {
  let link: HostLink
  var body: some View { Circle().fill(color).frame(width: 7, height: 7) }
  private var color: Color {
    switch link {
    case .connected: return Palette.green
    case .pairing: return Palette.amber
    case .notPaired, .offline: return Palette.faint
    }
  }
}

struct EvidenceChip: View {
  let symbol: String?
  let text: String
  var body: some View {
    HStack(spacing: 7) {
      if let symbol { Image(systemName: symbol).font(.system(size: 12)) }
      Text(text).font(.system(size: 12))
    }
    .foregroundStyle(Color(hex: 0x67676A))
    .padding(.vertical, 6).padding(.horizontal, 11)
    .background(Palette.canvas, in: Capsule())
  }
}

struct RemoteHeader<Right: View>: View {
  let title: String
  var subtitle: String?
  var link: HostLink?
  var backAction: (() -> Void)?
  var menuAction: (() -> Void)?
  @ViewBuilder let right: () -> Right

  var body: some View {
    HStack(spacing: 10) {
      CircleButton(symbol: backAction == nil ? Symbol.menu : Symbol.back,
                   label: backAction == nil ? "打开菜单" : "返回") {
        if let backAction { backAction() } else { menuAction?() }
      }
      VStack(spacing: 2) {
        Text(title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
        if let subtitle {
          HStack(spacing: 5) {
            if let link { StatusDot(link: link) }
            Text(subtitle).lineLimit(1)
          }
          .font(.system(size: 11.5)).foregroundStyle(Palette.muted)
        }
      }
      .frame(maxWidth: .infinity)
      right()
        .frame(minWidth: 44, minHeight: 44)
    }
    .padding(.horizontal, 14).padding(.vertical, 6)
    .frame(minHeight: 62)
    .background(Palette.surface.opacity(0.97))
  }
}

extension RemoteHeader where Right == EmptyView {
  init(title: String, subtitle: String? = nil, link: HostLink? = nil,
       backAction: (() -> Void)? = nil, menuAction: (() -> Void)? = nil) {
    self.title = title; self.subtitle = subtitle; self.link = link
    self.backAction = backAction; self.menuAction = menuAction
    self.right = { EmptyView() }
  }
}

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
}

struct MessageComposer: View {
  @Binding var text: String
  @Binding var attachments: [DraftAttachment]
  let placeholder: String
  var disabled = false
  var sendDisabled = false
  var contextLabel: String?
  var onContext: (() -> Void)?
  var effortOptions: [G0Transport.RunControlOption] = []
  var selectedEffort: String?
  var onEffort: ((String) -> Void)?
  var permissionOptions: [G0Transport.RunControlOption] = []
  var selectedPermission = "default"
  var onPermission: ((String) -> Void)?
  let onSend: () -> Void

  @State private var showAttachmentSource = false
  @State private var showPhotos = false
  @State private var showFiles = false
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var attachmentError: String?

  private let maxCount = 4
  private let maxEachBytes = 512 * 1024
  private let maxTotalBytes = 700 * 1024

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !attachments.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 7) { ForEach(attachments) { attachmentChip($0) } }
        }
      }
      TextField(placeholder, text: $text, axis: .vertical)
        .font(.system(size: 16)).lineLimit(1...6).disabled(disabled)
      HStack(spacing: 2) {
        PlainIcon(symbol: Symbol.plus, label: "添加图片或文件", disabled: disabled) { showAttachmentSource = true }
        Menu {
          ForEach(permissionOptions, id: \.id) { option in
            Button { onPermission?(option.id) } label: {
              Label(option.label, systemImage: selectedPermission == option.id ? Symbol.check : Symbol.shield)
            }
          }
        } label: {
          Label(permissionLabel, systemImage: Symbol.shield)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(selectedPermission == "full_access" ? Palette.amber : Palette.muted)
            .frame(minHeight: 40)
        }
        .buttonStyle(.plain).disabled(disabled || permissionOptions.isEmpty)
        Spacer(minLength: 4)
        if !effortOptions.isEmpty {
          Menu {
            ForEach(effortOptions, id: \.id) { option in
              Button { onEffort?(option.id) } label: {
                Label(option.label, systemImage: selectedEffort == option.id ? Symbol.check : "brain")
              }
            }
          } label: {
            HStack(spacing: 4) {
              Image(systemName: "brain").font(.system(size: 11))
              Text(effortLabel).font(.system(size: 11))
            }
            .foregroundStyle(Palette.muted).padding(.horizontal, 8).frame(height: 28)
            .background(Palette.canvas, in: Capsule())
          }
          .buttonStyle(.plain).disabled(disabled)
        }
        if let contextLabel {
          Button { onContext?() } label: {
            Text(contextLabel).font(.system(size: 11)).foregroundStyle(Palette.muted)
              .lineLimit(1).padding(.horizontal, 9).frame(height: 28)
              .background(Palette.canvas, in: Capsule())
          }
          .buttonStyle(.plain)
        }
        CircleButton(symbol: Symbol.send, label: "发送", filled: true,
                     disabled: disabled || sendDisabled, action: onSend)
      }
      if let attachmentError {
        Text(attachmentError).font(.system(size: 11)).foregroundStyle(Palette.negative)
      }
    }
    .padding(.horizontal, 12).padding(.top, 11).padding(.bottom, 7)
    .glass(cornerRadius: 25)
    .confirmationDialog("添加附件", isPresented: $showAttachmentSource, titleVisibility: .visible) {
      Button("照片图库") { showPhotos = true }
      Button("选择文本或代码文件") { showFiles = true }
      Button("取消", role: .cancel) {}
    } message: {
      Text("附件经端到端加密发送；最多 4 项，总计不超过 700 KB。")
    }
    .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: maxCount, matching: .images)
    .fileImporter(isPresented: $showFiles,
                  allowedContentTypes: [.image, .text, .sourceCode, .json, .xml],
                  allowsMultipleSelection: true) { result in
      if case let .success(urls) = result { importFiles(urls) }
      else if case let .failure(error) = result { attachmentError = error.localizedDescription }
    }
    .onChange(of: photoItems) { _, items in
      guard !items.isEmpty else { return }
      Task { await importPhotos(items); photoItems = [] }
    }
  }

  private var permissionLabel: String {
    permissionOptions.first(where: { $0.id == selectedPermission })?.label ?? "默认审批"
  }

  private var effortLabel: String {
    effortOptions.first(where: { $0.id == selectedEffort })?.label ?? "默认"
  }

  private func attachmentChip(_ item: DraftAttachment) -> some View {
    HStack(spacing: 7) {
      Image(systemName: item.kind == .image ? Symbol.photo : Symbol.file)
      VStack(alignment: .leading, spacing: 1) {
        Text(item.name).font(.system(size: 11, weight: .medium)).lineLimit(1)
        Text(item.detail).font(.system(size: 9)).foregroundStyle(Palette.muted)
      }
      Button { attachments.removeAll { $0.id == item.id } } label: {
        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).frame(width: 22, height: 22)
      }
      .buttonStyle(.plain).accessibilityLabel("移除 \(item.name)")
    }
    .padding(.leading, 9).padding(.trailing, 4).frame(height: 39)
    .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
  }

  @MainActor private func append(_ item: DraftAttachment) {
    guard attachments.count < maxCount else { attachmentError = "附件最多 4 项"; return }
    guard !item.name.isEmpty && item.name.count <= 160 else { attachmentError = "附件名称过长"; return }
    guard item.data.count <= maxEachBytes else { attachmentError = "\(item.name) 超过 512 KB；请压缩后重试"; return }
    guard attachments.reduce(0, { $0 + $1.data.count }) + item.data.count <= maxTotalBytes else {
      attachmentError = "附件总大小不能超过 700 KB"; return
    }
    attachments.append(item); attachmentError = nil
  }

  @MainActor private func importPhotos(_ items: [PhotosPickerItem]) async {
    for (index, item) in items.prefix(maxCount).enumerated() {
      do {
        guard let data = try await item.loadTransferable(type: Data.self), let jpeg = compactJPEG(data) else {
          attachmentError = "无法读取所选图片"; continue
        }
        append(.init(kind: .image, name: "photo-\(index + 1).jpg", mimeType: "image/jpeg", data: jpeg))
      } catch { attachmentError = "图片读取失败：\(error.localizedDescription)" }
    }
  }

  @MainActor private func importFiles(_ urls: [URL]) {
    for url in urls.prefix(maxCount) {
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      do {
        let values = try url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey])
        let type = values.contentType
        let sourceLimit = type?.conforms(to: .image) == true ? 24 * 1024 * 1024 : maxEachBytes
        if let size = values.fileSize, size > sourceLimit {
          attachmentError = "\(url.lastPathComponent) 过大；图片原文件需小于 24 MB，文本需小于 512 KB"; continue
        }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        if type?.conforms(to: .image) == true {
          guard let jpeg = compactJPEG(data) else { attachmentError = "无法压缩 \(url.lastPathComponent) 到 512 KB 内"; continue }
          append(.init(kind: .image, name: url.deletingPathExtension().lastPathComponent + ".jpg", mimeType: "image/jpeg", data: jpeg))
        } else {
          guard String(data: data, encoding: .utf8) != nil else {
            attachmentError = "\(url.lastPathComponent) 不是可读取的 UTF-8 文本文件"; continue
          }
          append(.init(kind: .text, name: url.lastPathComponent, mimeType: "text/plain", data: data))
        }
      } catch { attachmentError = "文件读取失败：\(error.localizedDescription)" }
    }
  }

  #if canImport(UIKit)
  @MainActor private func compactJPEG(_ data: Data) -> Data? {
    guard let source = UIImage(data: data) else { return nil }
    let maxSide: CGFloat = 1280
    let scale = min(1, maxSide / max(source.size.width, source.size.height))
    let size = CGSize(width: max(1, source.size.width * scale), height: max(1, source.size.height * scale))
    let image = UIGraphicsImageRenderer(size: size).image { _ in source.draw(in: CGRect(origin: .zero, size: size)) }
    for quality in [0.72, 0.58, 0.44, 0.32, 0.22] {
      if let out = image.jpegData(compressionQuality: quality), out.count <= maxEachBytes { return out }
    }
    return nil
  }
  #else
  private func compactJPEG(_ data: Data) -> Data? { nil }
  #endif
}
