import SwiftUI
import RemoteTransport

// v5 · Codex Refined: context is explicit and close to the composer. Project and
// Provider are full-width controls backed only by host-authorized data. The +
// control stages real, bounded image/text attachments for the encrypted request.
struct NewSessionView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  private var composer: Binding<AppModel.ComposerDraft> { model.composerDraft(for: .newTask) }
  private var draft: String { composer.wrappedValue.text }
  private var attachments: [DraftAttachment] { composer.wrappedValue.attachments }
  @State private var showProjects = false
  @State private var showProviders = false

  private var paired: Bool { run.hasConnection }
  private var canSend: Bool {
    paired && !run.isBusy && run.chosen != nil && run.controlsReady &&
      !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: "新任务", subtitle: displayHost,
                   link: model.link, backAction: { model.goBack() }) {
        Color.clear.frame(width: 44, height: 44)
      }
      if !paired { Notice(text: "尚未连接 Mac，无法创建会话。", warning: true) }
      if let error = run.submitError { Notice(text: error, warning: true) }

      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          VStack(spacing: 0) {
            contextRow(symbol: Symbol.laptop, eyebrow: "主机",
                       value: displayHost, enabled: false, connected: model.link.isConnected)
            contextRow(symbol: Symbol.folder, eyebrow: "工作目录",
                       value: run.chosen?.label ?? "选择文件夹", enabled: paired) {
              run.loadDirectories(path: run.chosen?.path); showProjects = true
            }
            contextRow(symbol: Symbol.gauge, eyebrow: "PROVIDER",
                       value: run.chosenProvider?.label ?? "选择 Provider", enabled: paired) { showProviders = true }
          }
        }
        .padding(.horizontal, 19).padding(.top, 12).padding(.bottom, 18)
      }
      .scrollIndicators(.hidden)
      .scrollDismissesKeyboard(.interactively)

      if run.chosen == nil || run.chosenProvider == nil {
        Text(run.chosen == nil ? "先选择工作目录，再选择 Provider" : "选择 Provider 后即可发送")
          .font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 20)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      MessageComposer(text: composer.text, attachments: composer.attachments,
                      placeholder: paired ? "描述任务，或粘贴错误信息…" : "连接后可输入",
                      disabled: !paired, sendDisabled: !canSend,
                      contextLabel: run.chosenProvider?.label, onContext: { showProviders = true },
                      modelOptions: run.modelOptions, selectedModelId: run.chosenModelId,
                      onModel: { run.chooseModel($0) },
                      effortOptions: run.effortOptions, selectedEffort: run.chosenEffort,
                      onEffort: { run.chooseEffort($0) },
                      permissionOptions: run.chosenProvider?.permissions ?? [], selectedPermission: run.permissionMode,
                      onPermission: { run.choosePermission($0) },
                      slashCommands: run.slashCommands, slashCommandsLoading: run.slashCommandsLoading,
                      slashCommandsReason: run.slashCommandsReason,
                      onRefreshSlashCommands: {
                        if let providerId = run.chosenProvider?.id, let cwd = run.chosen?.path {
                          run.loadCommands(providerId: providerId, cwd: cwd,
                                           agentProfileId: run.chosenProvider?.agentProfileId, force: true)
                        }
                      }) {
        guard let providerId = run.chosenProvider?.id else { return }
        let payload = attachments.map(\.wireValue)
        if run.submit(prompt: draft, providerId: providerId, attachments: payload) {
          composer.wrappedValue = .init()
          model.route = .chat
        }
      }
      .padding(.horizontal, 13).padding(.top, 8).padding(.bottom, 12)
      .background(Palette.surface)
    }
    .background(Palette.surface)
    .onAppear { if paired { run.loadProjects(); run.loadProviders() } }
    .sheet(isPresented: $showProjects) { projectPicker }
    .sheet(isPresented: $showProviders) { providerPicker }
  }

  private var displayHost: String { run.hasConnection ? "已配对的 Mac" : "未连接" }

  private func contextRow(symbol: String, eyebrow: String, value: String, enabled: Bool,
                          connected: Bool? = nil, action: @escaping () -> Void = {}) -> some View {
    Button(action: action) {
      HStack(spacing: 13) {
        Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(Palette.muted).frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(eyebrow).font(.system(size: 9, weight: .semibold)).tracking(0.8).foregroundStyle(Palette.muted)
          Text(value).font(.system(size: 15, weight: .medium)).foregroundStyle(enabled || connected != nil ? Palette.ink : Palette.muted).lineLimit(1)
        }
        Spacer()
        if let connected {
          Circle().fill(connected ? Palette.green : Palette.faint).frame(width: 7, height: 7)
        } else if enabled {
          Image(systemName: Symbol.chevron).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
        }
      }
      .frame(minHeight: 59).contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(!enabled)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
  }

  private var projectPicker: some View {
    SelectionSheet(title: "选择文件夹", subtitle: "可浏览 Mac 已授权项目内的任意文件夹", onRefresh: {
      if case let .loaded(listing) = run.directories { run.loadDirectories(path: listing.current?.path) }
      else { run.loadDirectories() }
    }) {
      switch run.directories {
      case .idle, .loading:
        ProgressView("读取文件夹…").frame(maxWidth: .infinity).padding(.top, 40)
      case let .loaded(listing):
        VStack(alignment: .leading, spacing: 0) {
          if let current = listing.current {
            Button {
              run.loadDirectories(path: listing.parent?.path)
            } label: {
              HStack(spacing: 9) {
                Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                Text(listing.parent?.label ?? "已授权项目").font(.system(size: 14, weight: .medium))
                Spacer()
              }
              .foregroundStyle(Palette.blue).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 4) {
              Text(current.label).font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.ink)
              Text(current.path).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(2)
              Button("选择此文件夹") {
                run.chooseProject(current); showProjects = false
              }
              .buttonStyle(.borderedProminent).tint(Palette.blue).padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)

            Text("子文件夹").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.muted).padding(.top, 8).padding(.bottom, 4)
            if listing.directories.isEmpty {
              Text("此文件夹没有子文件夹").font(.system(size: 14)).foregroundStyle(Palette.muted).padding(.vertical, 18)
            } else {
              ForEach(listing.directories, id: \.path) { ref in
                FolderBrowseRow(ref: ref, selected: run.chosen?.path == ref.path) {
                  run.loadDirectories(path: ref.path)
                }
              }
            }
          } else if listing.directories.isEmpty {
            EmptyState(title: "没有已授权的项目", detail: "先在 Mac 的 Scry 中授权目录；iPhone 不能自行扩大访问范围。", symbol: Symbol.folder)
          } else {
            ForEach(listing.directories, id: \.path) { ref in
              FolderBrowseRow(ref: ref, selected: run.chosen?.path == ref.path) {
                run.loadDirectories(path: ref.path)
              }
            }
          }
        }
      case let .failed(reason):
        EmptyState(title: "无法读取文件夹", detail: reason, symbol: "exclamationmark.triangle")
      }
    }
  }

  private var providerPicker: some View {
    SelectionSheet(title: "选择 Provider", subtitle: "仅显示主机当前可用的服务", onRefresh: { run.loadProviders(force: true) }) {
      switch run.providers {
      case .idle, .loading:
        ProgressView("读取主机可用的 Provider…").frame(maxWidth: .infinity).padding(.top, 40)
      case let .loaded(list):
        VStack(spacing: 0) {
          ForEach(list, id: \.selectionId) { ref in
            SelectionRow(title: ref.label, detail: [ref.id.uppercased(), ref.agentProfileId].compactMap { $0 }.joined(separator: " · "),
                         selected: run.chosenProvider?.id == ref.id && run.chosenProvider?.agentProfileId == ref.agentProfileId) {
              run.chooseProvider(ref); showProviders = false
            }
          }
        }
      case .empty:
        EmptyState(title: "没有可用的 Provider", detail: "先在 Mac 的 Scry 中登录或配置 Provider。", symbol: Symbol.agent)
      case let .failed(reason):
        EmptyState(title: "无法读取 Provider", detail: reason, symbol: "exclamationmark.triangle")
      }
    }
  }
}

extension G0Transport.RunProviderRef {
  // Multiple profiles share a provider ID; SwiftUI row identity must not.
  var selectionId: String { id + "\u{1f}" + (agentProfileId ?? "") }
}

private struct SelectionSheet<Content: View>: View {
  let title: String
  let subtitle: String
  let onRefresh: () -> Void
  @ViewBuilder let content: () -> Content
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView { content().padding(.horizontal, 16).padding(.top, 8) }
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
          ToolbarItem(placement: .primaryAction) { Button("刷新", action: onRefresh) }
        }
        .safeAreaInset(edge: .top) {
          Text(subtitle).font(.system(size: 11)).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity).padding(.vertical, 8).background(Palette.noticeBg)
        }
    }
    .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
  }
}

private struct FolderBrowseRow: View {
  let ref: G0Transport.RunProjectRef
  let selected: Bool
  let onOpen: () -> Void

  var body: some View {
    Button(action: onOpen) {
      HStack(spacing: 12) {
        Image(systemName: Symbol.folder).font(.system(size: 16)).foregroundStyle(Palette.muted).frame(width: 22)
        VStack(alignment: .leading, spacing: 3) {
          Text(ref.label).font(.system(size: 16, weight: .medium)).foregroundStyle(Palette.ink).lineLimit(1)
          Text(ref.path).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(1)
        }
        Spacer()
        if selected { Image(systemName: Symbol.check).font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.blue) }
        Image(systemName: Symbol.chevron).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
      }
      .frame(minHeight: 58).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
  }
}

private struct SelectionRow: View {
  let title: String
  let detail: String
  let selected: Bool
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(.system(size: 16, weight: .medium)).foregroundStyle(Palette.ink)
          Text(detail).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(1)
        }
        Spacer()
        if selected { Image(systemName: Symbol.check).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.blue) }
      }
      .frame(minHeight: 56).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
  }
}
