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
  var projectLabel: String?
  var onProject: (() -> Void)?
  var providerId: String?
  var submissionError: String?
  var hostLabel: String?
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

  @State private var showModelEffort = false
  @State private var showPhotos = false
  @State private var showFiles = false
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var attachmentError: String?
  @State private var previewing: AttachmentPreviewItem?
  @FocusState private var inputFocused: Bool
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
      if projectLabel != nil || contextLabel != nil {
        HStack(spacing: 6) {
          if let projectLabel {
            Button { onProject?() } label: { controlCapsule(projectLabel, symbol: Symbol.folder) }
              .buttonStyle(.plain).disabled(disabled)
          }
          if let contextLabel { contextControl(contextLabel) }
          Spacer(minLength: 0)
          if let hostLabel { Text(hostLabel).font(Typography.meta).foregroundStyle(Palette.dim2).lineLimit(1) }
        }
        .padding(.horizontal, 10)
        Rectangle().fill(Palette.border3).frame(height: 0.5)
      }
      VStack(alignment: .leading, spacing: 0) {
        if let submissionError {
          Text(submissionError).font(Typography.meta).foregroundStyle(Palette.warn).padding(.top, 8)
        }
        if slashToken != nil && !disabled { slashMenu.padding(.bottom, 8) }
        if !attachments.isEmpty {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) { ForEach(attachments) { attachmentChip($0) } }
          }.padding(.top, 8)
        }
        TextField(placeholder, text: $text, axis: .vertical)
          .font(Typography.reply).lineLimit(1...6).disabled(disabled)
          .focused($inputFocused)
          .accessibilityIdentifier("message-input")
          .padding(.horizontal, 4).padding(.top, 12).padding(.bottom, 6)
        if dynamicTypeSize.isAccessibilitySize {
          HStack(spacing: 2) {
            attachmentPermissionMenu
            permissionControl
            Spacer(minLength: 0)
            keyboardControl
          }
          HStack(spacing: 2) {
            if hasModelControl { modelEffortControl }
            Spacer(minLength: 0)
            sendControl
          }
        } else {
          HStack(spacing: 2) {
            attachmentPermissionMenu
            permissionControl
            Spacer(minLength: 0)
            if hasModelControl { modelEffortControl }
            keyboardControl
            sendControl
          }
        }
        if let modelSelectionIssue { Text(modelSelectionIssue).font(Typography.meta).foregroundStyle(Palette.bad) }
        if let attachmentError { Text(attachmentError).font(Typography.meta).foregroundStyle(Palette.bad) }
      }.padding(.horizontal, 10).padding(.bottom, 6)
    }
    .background(Palette.panel, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(inputFocused ? Palette.border2 : Palette.border))
    .overlay {
      if inputFocused {
        RoundedRectangle(cornerRadius: 21, style: .continuous).strokeBorder(Palette.accentSoft, lineWidth: 1).padding(-1)
      }
    }
    .shadow(color: .black.opacity(colorScheme == .dark ? 0.28 : 0.08), radius: 30, y: 10)
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
        Text(ConnectionCopy.slashCommands).font(Typography.meta.weight(.semibold)).foregroundStyle(Palette.dim)
        Spacer()
        if slashCommandsLoading { ProgressView().controlSize(.mini) }
        if let onRefreshSlashCommands {
          Button(action: onRefreshSlashCommands) {
            Image(systemName: "arrow.clockwise").font(Typography.meta.weight(.semibold))
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
                .font(Typography.mono.weight(.semibold))
                .foregroundStyle(Palette.accent)
              VStack(alignment: .leading, spacing: 2) {
                if !command.description.isEmpty {
                  Text(command.description).font(Typography.meta).foregroundStyle(Palette.fg).lineLimit(2)
                }
                if let hint = command.argumentHint, !hint.isEmpty {
                  Text(hint).font(Typography.mono).foregroundStyle(Palette.dim)
                }
              }
              Spacer(minLength: 0)
            }
            .padding(.horizontal, 11).padding(.vertical, 8)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          if command.id != slashMatches.last?.id { Rectangle().fill(Palette.border3.opacity(0.7)).frame(height: 0.5) }
        }
      } else if !slashCommandsLoading {
        Text(slashCommandsReason ?? (slashCommands.isEmpty ? ConnectionCopy.noProviderCommands : ConnectionCopy.noMatchingCommands))
          .font(Typography.meta).foregroundStyle(Palette.dim)
          .padding(.horizontal, 11).padding(.bottom, 10)
      }
    }
    .background(Palette.main, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).strokeBorder(Palette.border3))
  }

  private var attachmentPermissionMenu: some View {
    Menu {
      Section(ConnectionCopy.attachmentMenu) {
        Button { showPhotos = true } label: { Label(ConnectionCopy.photoLibrary, systemImage: Symbol.photo) }
        Button { showFiles = true } label: { Label(ConnectionCopy.textOrCodeFile, systemImage: Symbol.file) }
      }
      if !permissionOptions.isEmpty { permissionItems }
    } label: {
      Image(systemName: Symbol.plus)
        .font(Typography.rowTitle)
        .foregroundStyle(Palette.dim)
        .frame(width: 38, height: 38)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(disabled)
    .accessibilityLabel(ConnectionCopy.attachmentAndPermission(permissionLabel))
  }

  @ViewBuilder private var permissionItems: some View {
    Section(ConnectionCopy.permissionMenu(permissionLabel)) {
      if permissionOptions.count == 1 {
        Button {} label: { Label(ConnectionCopy.permissionLocked(permissionLabel), systemImage: "lock.fill") }
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

  @ViewBuilder private func contextControl(_ label: String) -> some View {
    if let onContext, !contextLocked {
      Button(action: onContext) { controlCapsule(label, symbol: ProviderSymbol.name(providerId ?? "")) }
        .buttonStyle(.plain).disabled(disabled)
        .accessibilityLabel(ConnectionCopy.composerAgent(label))
    } else {
      controlCapsule(label, symbol: contextLocked ? "lock.fill" : ProviderSymbol.name(providerId ?? ""))
        .accessibilityLabel(ConnectionCopy.lockedComposerAgent(label))
    }
  }

  private var permissionControl: some View {
    Menu { permissionItems } label: {
      Text(permissionLabel).font(Typography.meta.weight(.medium)).foregroundStyle(Palette.dim)
        .lineLimit(1).frame(minHeight: 44)
    }.disabled(disabled || permissionOptions.isEmpty)
  }

  @ViewBuilder private var keyboardControl: some View {
    if inputFocused {
      Button { inputFocused = false } label: {
        Image(systemName: "keyboard.chevron.compact.down").font(Typography.rowTitle)
          .foregroundStyle(Palette.dim).frame(width: 44, height: 44).contentShape(Rectangle())
      }.buttonStyle(.plain).accessibilityLabel(ConnectionCopy.hideKeyboard)
    }
  }

  private var sendControl: some View {
    // Stop lives in the session status strip, so send never changes meaning.
    Button(action: onSend) {
      Image(systemName: Symbol.send).font(Typography.rowTitle.weight(.semibold))
        .foregroundStyle(disabled || sendDisabled ? Palette.dim2 : Palette.main)
        .frame(width: 34, height: 34)
        .background(disabled || sendDisabled ? Palette.panel3 : Palette.fg, in: Circle())
        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(disabled || sendDisabled)
    .accessibilityLabel(ConnectionCopy.sendMessage)
  }

  private var hasModelControl: Bool {
    !modelOptions.isEmpty || !effortOptions.isEmpty || selectedModelId != nil || selectedEffort != nil
  }

  private var modelEffortControl: some View {
    Button { showModelEffort = true } label: {
      HStack(spacing: 4) {
        Text(modelLabel).lineLimit(1)
        if !effortOptions.isEmpty || selectedEffort != nil { Text(effortLabel).foregroundStyle(Palette.dim2) }
        Image(systemName: "chevron.down").font(Typography.meta.weight(.semibold))
      }
      .font(Typography.meta).foregroundStyle(Palette.fg)
      .frame(minHeight: 44).contentShape(Rectangle())
      .background(showModelEffort ? Palette.hover : .clear, in: RoundedRectangle(cornerRadius: 10))
      .animation(Motion.animation(.select, reduceMotion: reduceMotion), value: showModelEffort)
    }
    .buttonStyle(.plain).disabled(disabled)
    .accessibilityLabel(ConnectionCopy.modelAndEffort(modelLabel, effortLabel))
    .accessibilityIdentifier("model-effort-control")
    .popover(isPresented: $showModelEffort) {
      ModelEffortPopover(modelOptions: modelOptions, selectedModelId: selectedModelId,
                         effortOptions: effortOptions, selectedEffort: selectedEffort,
                         onModel: onModel, onEffort: onEffort)
    }
  }

  private func controlCapsule(_ label: String, symbol: String) -> some View {
    HStack(spacing: 6) {
      Image(systemName: symbol).foregroundStyle(symbol == Symbol.folder ? Palette.dim : Palette.provider(providerId ?? ""))
      Text(label).foregroundStyle(Palette.fg).lineLimit(1)
    }
    .font(Typography.rowTitle.weight(.medium)).padding(.horizontal, 10).frame(minHeight: 36)
    .background(Palette.subtle, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Palette.border3))
    .frame(minHeight: 44).contentShape(Rectangle())
  }

  private var permissionLabel: String {
    permissionOptions.first(where: { $0.id == selectedPermission })?.label ?? ConnectionCopy.defaultApproval
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
            Text(item.name).font(Typography.meta.weight(.medium)).lineLimit(1)
            Text(item.detail).font(Typography.meta).foregroundStyle(Palette.dim)
          }
        }.frame(minHeight: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(item.kind != .image)
      .accessibilityLabel(item.kind == .image ? ConnectionCopy.viewAttachment(item.name) : item.name)
      Button { attachments.removeAll { $0.id == item.id } } label: {
        Image(systemName: "xmark").font(Typography.meta.weight(.semibold))
          .frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain).accessibilityLabel(ConnectionCopy.removeAttachment(item.name))
    }
    .padding(.leading, 9).padding(.trailing, 4).frame(minHeight: 44)
    .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
  }

  // Errors are only set, never cleared, by an individual item, so a later
  // successful item in the same batch cannot hide an earlier rejection.
  @MainActor private func append(_ item: DraftAttachment) {
    guard attachments.count < maxCount else { attachmentError = ConnectionCopy.attachmentCountLimit; return }
    guard !item.name.isEmpty && item.name.count <= 160 else { attachmentError = ConnectionCopy.attachmentNameLimit; return }
    guard item.data.count <= maxEachBytes else { attachmentError = ConnectionCopy.attachmentSizeLimit(item.name); return }
    guard usedBytes + item.data.count <= maxTotalBytes else {
      attachmentError = ConnectionCopy.attachmentTotalLimit; return
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
    if selected.count < items.count { attachmentError = ConnectionCopy.ignoredExtraImages }
    var loaded: [Data] = []
    for item in selected {
      do {
        guard let data = try await item.loadTransferable(type: Data.self) else { attachmentError = ConnectionCopy.unreadableImage; continue }
        loaded.append(data)
      } catch { attachmentError = ConnectionCopy.imageReadFailed(error.localizedDescription) }
    }
    for (index, data) in loaded.enumerated() {
      guard let jpeg = DraftAttachment.compactJPEG(data, maxBytes: imageBudget(remainingImages: loaded.count - index)) else {
        attachmentError = ConnectionCopy.imageBudgetFailed; continue
      }
      append(.init(kind: .image, name: "photo-\(attachments.count + 1).jpg", mimeType: "image/jpeg", data: jpeg))
    }
  }

  @MainActor private func importFiles(_ urls: [URL]) {
    attachmentError = nil
    let selected = Array(urls.prefix(maxCount - attachments.count))
    if selected.count < urls.count { attachmentError = ConnectionCopy.ignoredExtraFiles }
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
          attachmentError = ConnectionCopy.sourceFileLimit(url.lastPathComponent); continue
        }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        if type?.conforms(to: .image) == true {
          let budget = imageBudget(remainingImages: remainingImages)
          remainingImages -= 1
          guard let jpeg = DraftAttachment.compactJPEG(data, maxBytes: budget) else {
            attachmentError = ConnectionCopy.fileImageBudgetFailed(url.lastPathComponent); continue
          }
          append(.init(kind: .image, name: url.deletingPathExtension().lastPathComponent + ".jpg", mimeType: "image/jpeg", data: jpeg))
        } else {
          guard String(data: data, encoding: .utf8) != nil else {
            attachmentError = ConnectionCopy.nonUTF8File(url.lastPathComponent); continue
          }
          append(.init(kind: .text, name: url.lastPathComponent, mimeType: "text/plain", data: data))
        }
      } catch { attachmentError = ConnectionCopy.fileReadFailed(error.localizedDescription) }
    }
  }
}
