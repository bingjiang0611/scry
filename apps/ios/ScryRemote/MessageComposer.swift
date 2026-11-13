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
  var selectionTransition: Namespace.ID?
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
  // Non-nil asks for the keyboard. The new-session page passes a ticket, so a
  // repeat "new session" request focuses again instead of being a silent no-op.
  var focusTicket: Int?
  var transitionSource = false
  let onSend: () -> Void

  @State private var showModelEffort = false
  @State private var showPhotos = false
  @State private var showFiles = false
  @State private var photoItems: [PhotosPickerItem] = []
  @State var attachmentError: String?
  @State var previewing: AttachmentPreviewItem?
  @Namespace var imageTransition
  @AccessibilityFocusState var previewSource: UUID?
  @FocusState private var inputFocused: Bool
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  let maxCount = DraftAttachment.maxCount
  let maxEachBytes = DraftAttachment.maxEachBytes
  let maxTotalBytes = DraftAttachment.maxTotalBytes

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
            Button { onProject?() } label: {
              controlCapsule(projectLabel, symbol: Symbol.folder).zoomSource("project", in: selectionTransition)
            }
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
          Text(submissionError).font(Typography.meta).foregroundStyle(Palette.warnText).padding(.top, 8)
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
          .conversationElement(transitionSource ? .submittedText : nil, captures: !text.isEmpty)
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
    .conversationArrival()
    .background {
      composerSurface
        .conversationElement(.composerSurface, source: transitionSource, revision: inputFocused ? "focused" : "blurred", snapshot: AnyView(composerSurface))
    }
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
    .onAppear { if focusTicket != nil { inputFocused = true } }
    .onChange(of: focusTicket) { _, ticket in if ticket != nil { inputFocused = true } }
    .fullScreenCover(item: $previewing) { item in
      AttachmentImagePreview(item: item).zoomDestination(item.id, in: imageTransition)
    }
    .onChange(of: previewing?.id) { previous, current in
      if current == nil { previewSource = previous }
    }
  }

  private var composerSurface: some View {
    RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Palette.panel)
      .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(inputFocused ? Palette.border2 : Palette.border))
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
                .foregroundStyle(Palette.accentText)
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
      Button(action: onContext) {
        controlCapsule(label, symbol: ProviderSymbol.name(providerId ?? "")).zoomSource("provider", in: selectionTransition)
      }
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


}
