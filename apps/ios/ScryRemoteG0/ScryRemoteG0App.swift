import SwiftUI
import UniformTypeIdentifiers

@main
struct ScryRemoteG0App: App {
  var body: some Scene { WindowGroup { G0View() } }
}

struct G0View: View {
  @StateObject private var model = G0Model()
  @State private var importing = false
  @State private var showingDetails = false
  @State private var confirmingRemoval = false

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        circle("line.3.horizontal", label: "测试说明") { showingDetails = true }
        Spacer()
        VStack(spacing: 3) {
          Text("远程").font(.system(size: 17, weight: .semibold))
          Label("G0 验证端 · 未配对", systemImage: "laptopcomputer")
            .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        Spacer()
        circle("ellipsis", label: "身份管理") { showingDetails = true }
      }.padding(.horizontal, 16).padding(.top, 8)

      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          Text("连接验证").font(.system(size: 24, weight: .semibold))
          Text("只验证加密通道，\n不执行项目任务。")
            .font(.system(size: 28, weight: .medium)).lineSpacing(5)
          Text(model.explanation).font(.system(size: 15)).foregroundStyle(.secondary).lineSpacing(5)
          Divider()
          Label(model.phase.label, systemImage: model.phase == .verified ? "checkmark.shield" : "network")
            .font(.system(size: 15)).accessibilityIdentifier("probe-status")
          if let port = model.port {
            Label("127.0.0.1:\(port)", systemImage: "laptopcomputer")
              .foregroundStyle(.secondary).font(.system(size: 15))
            Text("当前仅支持 Simulator → Mac loopback。此地址在真机上指向 iPhone 自己，不会被当作已连接 Mac。")
              .font(.system(size: 12)).foregroundStyle(.secondary)
          }
          if model.phase.busy { ProgressView().accessibilityLabel(model.phase.label) }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 24).padding(.top, 74)
      }

      HStack(spacing: 12) {
        Button { importing = true } label: {
          Label("导入测试配置", systemImage: "plus").font(.system(size: 17))
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().stroke(.quaternary, lineWidth: 0.5))
        }.tint(.primary).disabled(model.phase.busy).accessibilityIdentifier("import-fixture")
        Button { Task { await model.run() } } label: {
          Image(systemName: "arrow.up").font(.system(size: 23, weight: .medium))
            .frame(width: 48, height: 48).background(Color.accentColor, in: Circle()).foregroundStyle(.white)
        }.disabled(model.port == nil || model.phase.busy)
          .accessibilityLabel("开始一次加密验证").accessibilityIdentifier("run-probe")
      }.padding(.horizontal, 22).padding(.bottom, 20).padding(.top, 14)
    }
    .background(Color(uiColor: .systemBackground))
    .task { await model.reload() }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
      switch result {
      case .success(let url): Task { await model.importFile(url) }
      case .failure: model.explanation = "未导入文件，未改变测试身份。"
      }
    }
    .sheet(isPresented: $showingDetails) {
      NavigationStack {
        List {
          Section("测试边界") {
            Text("SwiftNIO SSL ↔ Node TLS\n外层 WSS ＋ 内层 TLS 1.3 mTLS")
            Text("这不是用户配对流程。当前使用预签发的短期测试证书，不提供 run.start、文件写入或终端。")
          }
          if let digest = model.anchorDigest {
            Section("测试信任锚材料 SHA-256") { Text(digest).font(.footnote.monospaced()).textSelection(.enabled) }
          }
          Section {
            Button("清除测试身份", role: .destructive) { confirmingRemoval = true }
              .disabled(model.phase.busy || model.port == nil)
          }
        }
        .navigationTitle("G0 测试说明").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showingDetails = false } } }
        .confirmationDialog("仅删除此 App 的测试材料？", isPresented: $confirmingRemoval) {
          Button("清除测试身份", role: .destructive) { Task { await model.remove() } }
        }
      }.presentationDetents([.medium, .large])
    }
  }

  private func circle(_ image: String, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: image).font(.system(size: 21))
        .frame(width: 44, height: 44).background(.regularMaterial, in: Circle())
        .overlay(Circle().stroke(.quaternary, lineWidth: 0.5))
    }.tint(.primary).accessibilityLabel(label)
  }
}
