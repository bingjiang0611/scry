import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

extension MessageComposer {
  func attachmentChip(_ item: DraftAttachment) -> some View {
    let sharedID = transitionSource ? attachments.firstIndex(where: { $0.id == item.id }).map(ConversationTransition.Element.submittedAttachment) : nil
    return HStack(spacing: 7) {
      Button {
        if item.kind == .image { previewing = AttachmentPreviewItem(id: item.id, name: item.name, data: item.data) }
      } label: {
        HStack(spacing: 7) {
          if item.kind == .image {
            AttachmentThumbnail(data: item.data, side: 30)
              .zoomSource(item.id, in: imageTransition)
              .conversationElement(sharedID)
          } else {
            Image(systemName: Symbol.file)
          }
          VStack(alignment: .leading, spacing: 1) {
            Text(item.name).font(Typography.meta.weight(.medium)).lineLimit(1)
              .conversationElement(item.kind == .image ? nil : sharedID)
            Text(item.detail).font(Typography.meta).foregroundStyle(Palette.dim)
          }
        }.frame(minHeight: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(item.kind != .image)
      .accessibilityLabel(item.kind == .image ? ConnectionCopy.viewAttachment(item.name) : item.name)
      .accessibilityFocused($previewSource, equals: item.id)
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

  @MainActor func importPhotos(_ items: [PhotosPickerItem]) async {
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

  @MainActor func importFiles(_ urls: [URL]) {
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
