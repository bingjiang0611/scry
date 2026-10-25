import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import RemoteTransport
#if canImport(UIKit)
import UIKit
#endif

struct MessageComposer: View {
  @Binding var text: String
  @Binding var attachments: [DraftAttachment]
  let placeholder: String
  var disabled = false
  var sendDisabled = false
  var contextLabel: String?
  var onContext: (() -> Void)?
  var contextLocked = false
  var modelOptions: [G0Transport.RunModelOption] = []
  var selectedModelId: String?
  var modelSelectionIssue: String?
  var onModel: ((String?) -> Void)?
  var effortOptions: [G0Transport.RunControlOption] = []
  var selectedEffort: String?
  var onEffort: ((String?) -> Void)?
  var permissionOptions: [G0Transport.RunControlOption] = []
  var selectedPermission = "default"
  var onPermission: ((String) -> Void)?
  var slashCommands: [G0Transport.RunCommandRef] = []
  var slashCommandsLoading = false
  var slashCommandsReason: String?
  var onRefreshSlashCommands: (() -> Void)?
  let onSend: () -> Void

  @State private var showPhotos = false
  @State private var showFiles = false
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var attachmentError: String?
  @State private var previewing: AttachmentPreviewItem?
  @FocusState private var inputFocused: Bool

  private let maxCount = DraftAttachment.maxCount
  private let maxEachBytes = DraftAttachment.maxEachBytes
  private let maxTotalBytes = DraftAttachment.maxTotalBytes

  private var slashToken: String? {
    guard text.hasPrefix("/") else { return nil }
    let value = String(text.dropFirst())
    guard !value.contains(where: { $0.isWhitespace }) else { return nil }
    return value.lowercased()
  }

  private var slashMatches: [G0Transport.RunCommandRef] {
    guard let token = slashToken else { return [] }
    let matches = slashCommands.filter {
      token.isEmpty || $0.name.lowercased().hasPrefix(token) || $0.description.localizedCaseInsensitiveContains(token)
    }
    return Array(matches.prefix(8))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if slashToken != nil && !disabled { slashMenu.padding(.bottom, 8) }
      if !attachments.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 7) { ForEach(attachments) { attachmentChip($0) } }
        }
      }
      TextField(placeholder, text: $text, axis: .vertical)
        .font(.body).lineLimit(1...6).disabled(disabled)
        .focused($inputFocused)
        .accessibilityIdentifier("message-input")
        .padding(.horizontal, 4).padding(.top, 12).padding(.bottom, 4)
      HStack(spacing: 6) {
        attachmentPermissionMenu
        Spacer(minLength: 0)
        if inputFocused {
          PlainIcon(symbol: "keyboard.chevron.compact.down", label: "收起键盘") { inputFocused = false }
        }
        // Stop lives in the session status strip, so send never changes meaning.
        Button(action: onSend) {
          Image(systemName: Symbol.send)
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(disabled || sendDisabled ? Palette.muted : Palette.surface)
            .frame(width: 32, height: 32)
            .background(disabled || sendDisabled ? Palette.muted.opacity(0.35) : Palette.ink, in: Circle())
            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled || sendDisabled)
        .accessibilityLabel("发送")
      }
      if contextLabel != nil || !modelOptions.isEmpty || !effortOptions.isEmpty || selectedModelId != nil || selectedEffort != nil {
        Rectangle().fill(Palette.line).frame(height: 0.5)
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 12) {
            if let contextLabel { contextControl(contextLabel) }
            if !modelOptions.isEmpty || !effortOptions.isEmpty || selectedModelId != nil || selectedEffort != nil { modelEffortControl }
          }
        }
      }
      if let modelSelectionIssue {
        Text(modelSelectionIssue).font(.footnote).foregroundStyle(Palette.negative)
      }
      if let attachmentError {
        Text(attachmentError).font(.system(size: 11)).foregroundStyle(Palette.negative)
      }
    }
    .padding(.horizontal, 4)
    .background(Palette.surface)
    .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: max(1, maxCount - attachments.count), matching: .images)
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
    .fullScreenCover(item: $previewing) { AttachmentImagePreview(item: $0) }
  }

  private var slashMenu: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(ConnectionCopy.slashCommands).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.muted)
        Spacer()
        if slashCommandsLoading { ProgressView().controlSize(.mini) }
        if let onRefreshSlashCommands {
          Button(action: onRefreshSlashCommands) {
            Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold))
          }
          .buttonStyle(.plain).accessibilityLabel(ConnectionCopy.refreshSlashCommands)
        }
      }
      .padding(.horizontal, 11).padding(.vertical, 8)

      if !slashMatches.isEmpty {
        ForEach(slashMatches) { command in
          Button {
            text = "/\(command.name) "
          } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
              Text("/\(command.name)")
                .font(.system(size: 13.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(Palette.blue)
              VStack(alignment: .leading, spacing: 2) {
                if !command.description.isEmpty {
                  Text(command.description).font(.system(size: 12.5)).foregroundStyle(Palette.ink).lineLimit(2)
                }
                if let hint = command.argumentHint, !hint.isEmpty {
                  Text(hint).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Palette.muted)
                }
              }
              Spacer(minLength: 0)
            }
            .padding(.horizontal, 11).padding(.vertical, 8)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          if command.id != slashMatches.last?.id { Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 0.5) }
        }
      } else if !slashCommandsLoading {
        Text(slashCommandsReason ?? (slashCommands.isEmpty ? ConnectionCopy.noProviderCommands : ConnectionCopy.noMatchingCommands))
          .font(.system(size: 12)).foregroundStyle(Palette.muted)
          .padding(.horizontal, 11).padding(.bottom, 10)
      }
    }
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).strokeBorder(Palette.line))
  }

  private var attachmentPermissionMenu: some View {
    Menu {
      Section("附件") {
        Button { showPhotos = true } label: { Label("照片图库", systemImage: Symbol.photo) }
        Button { showFiles = true } label: { Label("文本或代码文件", systemImage: Symbol.file) }
      }
      if !permissionOptions.isEmpty {
        Section("权限 · \(permissionLabel)") {
          if permissionOptions.count == 1 {
            Button {} label: { Label("已由 Mac 锁定为\(permissionLabel)", systemImage: "lock.fill") }
              .disabled(true)
          } else {
            ForEach(permissionOptions, id: \.id) { option in
              Button { onPermission?(option.id) } label: {
                Label(option.label, systemImage: selectedPermission == option.id ? Symbol.check : Symbol.shield)
              }
            }
          }
        }
      }
    } label: {
      Image(systemName: Symbol.plus)
        .font(.system(size: 21, weight: .regular))
        .foregroundStyle(Palette.ink)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(disabled)
    .accessibilityLabel("添加附件与权限，当前\(permissionLabel)")
  }

  @ViewBuilder private func contextControl(_ label: String) -> some View {
    if let onContext, !contextLocked {
      Button(action: onContext) { controlCapsule(label, symbol: "cpu") }
        .buttonStyle(.plain).disabled(disabled)
        .accessibilityLabel("Agent：\(label)")
    } else {
      controlCapsule(label, symbol: contextLocked ? "lock.fill" : "cpu")
        .accessibilityLabel("已锁定 Agent：\(label)")
    }
  }

  private var modelEffortControl: some View {
    Menu {
      if !modelOptions.isEmpty || selectedModelId != nil {
        Section(ConnectionCopy.model) {
          Button { onModel?(nil) } label: {
            Label(ConnectionCopy.automaticModel, systemImage: selectedModelId == nil ? Symbol.check : "wand.and.stars")
          }
          ForEach(modelOptions, id: \.selectionId) { option in
            Button { onModel?(option.selectionId) } label: {
              Label(option.label, systemImage: selectedModelId == option.selectionId ? Symbol.check : "cpu")
            }
          }
        }
      }
      if !effortOptions.isEmpty || selectedEffort != nil {
        Section(ConnectionCopy.reasoningEffort) {
          Button { onEffort?(nil) } label: {
            Label(ConnectionCopy.defaultEffort, systemImage: selectedEffort == nil ? Symbol.check : "brain")
          }
          ForEach(effortOptions, id: \.id) { option in
            Button { onEffort?(option.id) } label: {
              Label(option.label, systemImage: selectedEffort == option.id ? Symbol.check : "brain")
            }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text(modelLabel).lineLimit(1)
        if !effortOptions.isEmpty || selectedEffort != nil { Text(effortLabel).foregroundStyle(Palette.faint) }
        Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
      }
      .font(.system(size: 12)).foregroundStyle(Palette.muted)
      .frame(minHeight: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(disabled)
    .accessibilityLabel(ConnectionCopy.modelAndEffort(modelLabel, effortLabel))
  }

  private func controlCapsule(_ label: String, symbol: String) -> some View {
    Label(label, systemImage: symbol).font(.system(size: 12))
      .foregroundStyle(Palette.muted).lineLimit(1)
      .frame(minHeight: 44)
  }

  private var permissionLabel: String {
    permissionOptions.first(where: { $0.id == selectedPermission })?.label ?? "默认审批"
  }

  private var modelLabel: String {
    guard let selectedModelId else { return ConnectionCopy.automaticModel }
    return modelOptions.first(where: { $0.selectionId == selectedModelId })?.label ?? selectedModelId
  }

  private var effortLabel: String {
    guard let selectedEffort else { return ConnectionCopy.defaultEffort }
    return effortOptions.first(where: { $0.id == selectedEffort })?.label ?? selectedEffort
  }

  private func attachmentChip(_ item: DraftAttachment) -> some View {
    HStack(spacing: 7) {
      Button {
        if item.kind == .image { previewing = AttachmentPreviewItem(name: item.name, data: item.data) }
      } label: {
        HStack(spacing: 7) {
          if item.kind == .image {
            AttachmentThumbnail(data: item.data, side: 30)
          } else {
            Image(systemName: Symbol.file)
          }
          VStack(alignment: .leading, spacing: 1) {
            Text(item.name).font(.system(size: 11, weight: .medium)).lineLimit(1)
            Text(item.detail).font(.system(size: 9)).foregroundStyle(Palette.muted)
          }
        }
      }
      .buttonStyle(.plain).disabled(item.kind != .image)
      .accessibilityLabel(item.kind == .image ? ConnectionCopy.viewAttachment(item.name) : item.name)
      Button { attachments.removeAll { $0.id == item.id } } label: {
        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).frame(width: 22, height: 22)
      }
      .buttonStyle(.plain).accessibilityLabel(ConnectionCopy.removeAttachment(item.name))
    }
    .padding(.leading, 9).padding(.trailing, 4).frame(minHeight: 39)
    .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
  }

  // Errors are only set, never cleared, by an individual item, so a later
  // successful item in the same batch cannot hide an earlier rejection.
  @MainActor private func append(_ item: DraftAttachment) {
    guard attachments.count < maxCount else { attachmentError = "附件最多 4 项"; return }
    guard !item.name.isEmpty && item.name.count <= 160 else { attachmentError = "附件名称过长"; return }
    guard item.data.count <= maxEachBytes else { attachmentError = "\(item.name) 超过 512 KB；请压缩后重试"; return }
    guard usedBytes + item.data.count <= maxTotalBytes else {
      attachmentError = "附件总大小不能超过 700 KB"; return
    }
    attachments.append(item)
  }

  private var usedBytes: Int { attachments.reduce(0) { $0 + $1.data.count } }

  private func imageBudget(remainingImages: Int) -> Int {
    DraftAttachment.imageBudget(usedBytes: usedBytes, remainingImages: remainingImages)
  }

  @MainActor private func importPhotos(_ items: [PhotosPickerItem]) async {
    attachmentError = nil
    let selected = Array(items.prefix(maxCount - attachments.count))
    if selected.count < items.count { attachmentError = "附件最多 4 项，已忽略多余图片" }
    var loaded: [Data] = []
    for item in selected {
      do {
        guard let data = try await item.loadTransferable(type: Data.self) else { attachmentError = "无法读取所选图片"; continue }
        loaded.append(data)
      } catch { attachmentError = "图片读取失败：\(error.localizedDescription)" }
    }
    for (index, data) in loaded.enumerated() {
      guard let jpeg = DraftAttachment.compactJPEG(data, maxBytes: imageBudget(remainingImages: loaded.count - index)) else {
        attachmentError = "无法把所选图片压缩到剩余附件额度内"; continue
      }
      append(.init(kind: .image, name: "photo-\(attachments.count + 1).jpg", mimeType: "image/jpeg", data: jpeg))
    }
  }

  @MainActor private func importFiles(_ urls: [URL]) {
    attachmentError = nil
    let selected = Array(urls.prefix(maxCount - attachments.count))
    if selected.count < urls.count { attachmentError = "附件最多 4 项，已忽略多余文件" }
    // Only used to split the size budget; the scoped read below stays authoritative.
    var remainingImages = selected.filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .image) == true }.count
    for url in selected {
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
          let budget = imageBudget(remainingImages: remainingImages)
          remainingImages -= 1
          guard let jpeg = DraftAttachment.compactJPEG(data, maxBytes: budget) else {
            attachmentError = "无法把 \(url.lastPathComponent) 压缩到剩余附件额度内"; continue
          }
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
}
