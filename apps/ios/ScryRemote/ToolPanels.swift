import SwiftUI
import RemoteTransport

// The three tool panels are read-only projections of what the Mac already
// computed. Missing evidence stays "unavailable" with its reason; nothing here
// scans, retries, or fills a gap with a zero.
struct ToolPanelView: View {
  let kind: ToolKind
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @EnvironmentObject var targets: ExecutionTargetCoordinator
  @State private var rangeDays = 7
  @State private var providerId: String?

  private var panel: G0Transport.ToolPanelPayload? {
    if case let .loaded(payload) = run.toolPanel { return payload }
    return nil
  }

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: kind.title, backAction: { model.goBack() }) {
        if case .loading = run.toolPanel {
          ProgressView().frame(width: 44, height: 44)
        } else {
          PlainIcon(symbol: "arrow.clockwise", label: ConnectionCopy.toolRefresh) {
            Task { await load() }
          }
        }
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          provenance
          switch run.toolPanel {
          case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
          case let .failed(reason):
            Notice(text: "\(ConnectionCopy.panelLoadFailed)：\(reason)", warning: true)
          case let .loaded(payload):
            if let reason = payload.unavailable {
              Notice(text: ConnectionCopy.toolUnavailable(reason), warning: true)
            } else {
              switch kind {
              case .analytics: analyticsBody(payload)
              case .llmPerformance: llmBody(payload)
              case .mcpTrust: mcpBody(payload)
              }
            }
          }
          Text(ConnectionCopy.toolsNote).font(.system(size: 11)).foregroundStyle(Palette.faint)
        }
        .padding(.horizontal, 19).padding(.top, 10).padding(.bottom, 24)
      }
      .scrollIndicators(.hidden)
      .refreshable { await load() }
    }
    .background(Palette.surface)
    .task(id: refreshKey) { await load() }
  }

  private var refreshKey: String { "\(kind.rawValue)-\(rangeDays)-\(providerId ?? "")" }

  private func load() async {
    switch kind {
    case .analytics:
      await run.loadToolPanel(kind: .analytics, rangeDays: rangeDays)
    case .llmPerformance:
      await run.loadToolPanel(kind: .llmPerformance)
    case .mcpTrust:
      if providerId == nil { providerId = defaultProviderId }
      guard let providerId else {
        return
      }
      await run.loadToolPanel(kind: .mcpTrust, providerId: providerId)
    }
  }

  private var defaultProviderId: String? {
    run.chosenProvider?.id ?? {
      if case let .loaded(list) = run.providers { return list.first?.id }
      return nil
    }()
  }

  private var provenance: some View {
    HStack(spacing: 8) {
      Text(ConnectionCopy.panelProvenance(panelHost, readAt: readStamp))
        .font(.system(size: 11)).foregroundStyle(Palette.faint)
      Spacer(minLength: 0)
      if let panel, isStale(panel) {
        Text(ConnectionCopy.panelStale).font(.system(size: 10)).foregroundStyle(Palette.warnInk)
      }
    }
  }

  // The host chip the drawer shows is the label a reader recognises; the relay
  // hostname is transport detail, not provenance the user can act on.
  private var panelHost: String {
    targets.aggregatesHosts ? targets.filterLabel : (targets.targetScopes.first?.label ?? ConnectionCopy.unconnected)
  }

  private var readStamp: String? {
    guard let panel else { return nil }
    return Date(timeIntervalSince1970: panel.readAt / 1000).formatted(date: .omitted, time: .shortened)
  }

  private func isStale(_ panel: G0Transport.ToolPanelPayload) -> Bool {
    Date().timeIntervalSince1970 - panel.readAt / 1000 > 300
  }

  // MARK: - Analytics

  @ViewBuilder private func analyticsBody(_ payload: G0Transport.ToolPanelPayload) -> some View {
    if let analytics = payload.analytics {
      Picker(ConnectionCopy.analyticsTitle, selection: $rangeDays) {
        Text(ConnectionCopy.toolRange7).tag(7)
        Text(ConnectionCopy.toolRange30).tag(30)
        Text(ConnectionCopy.toolRange90).tag(90)
      }
      .pickerStyle(.segmented)

      if analytics.status != "ready" {
        Notice(text: "\(ConnectionCopy.unavailable)：\(ConnectionCopy.unavailableDetail)", warning: true)
      }
      costHero(analytics)
      tokenGrid(analytics.totals)
      breakdown(analytics)
      byProvider(analytics)
      dailyChart(analytics)
      modelTable(analytics)
    } else {
      Notice(text: ConnectionCopy.unavailable, warning: true)
    }
  }

  private func costHero(_ analytics: G0Transport.ToolPanelPayload.Analytics) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(ConnectionCopy.analyticsCost).font(.system(size: 11, weight: .bold)).tracking(0.6)
        .foregroundStyle(Palette.muted)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        if let cost = analytics.totals.costUsd {
          Text(Self.usd(cost)).font(.system(size: 30, weight: .semibold))
        } else {
          Text(ConnectionCopy.unavailable).font(.system(size: 20, weight: .semibold)).foregroundStyle(Palette.muted)
        }
        if analytics.totals.costKnownRows < analytics.totals.turns {
          Text(ConnectionCopy.analyticsLowerBound).font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Palette.warnInk).padding(.horizontal, 6).frame(minHeight: 18)
            .background(Palette.warnBg, in: Capsule())
        }
      }
      Text(ConnectionCopy.analyticsCostNote).font(.system(size: 11)).foregroundStyle(Palette.faint)
      Text("\(analytics.fromDay) – \(analytics.toDay) · \(analytics.totals.turns) 轮")
        .font(.system(size: 11)).foregroundStyle(Palette.faint)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14).background(Palette.message, in: RoundedRectangle(cornerRadius: 12))
  }

  private func tokenGrid(_ totals: G0Transport.ToolPanelPayload.Totals) -> some View {
    let values: [(String, Double?, Int)] = [
      ("输入", totals.inputTokens, totals.tokenKnownRows),
      ("输出", totals.outputTokens, totals.tokenKnownRows),
      ("缓存读", totals.cacheReadTokens, totals.tokenKnownRows),
      ("缓存写", totals.cacheWriteTokens, totals.tokenKnownRows),
      ("推理", totals.reasoningTokens, totals.tokenKnownRows)
    ]
    return VStack(alignment: .leading, spacing: 8) {
      Text(ConnectionCopy.analyticsTokenCoverage).font(.system(size: 11, weight: .bold)).tracking(0.6)
        .foregroundStyle(Palette.muted)
      ForEach(Array(values.enumerated()), id: \.offset) { _, item in
        HStack {
          Text(item.0).font(.system(size: 13)).foregroundStyle(Palette.ink)
          Spacer()
          if let value = item.1 {
            Text(compact(value)).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.ink)
          } else {
            Text(ConnectionCopy.unavailable).font(.system(size: 12)).foregroundStyle(Palette.faint)
          }
          Text("\(totals.tokenKnownRows)/\(totals.turns)")
            .font(.system(size: 10)).foregroundStyle(Palette.faint)
            .lineLimit(1).minimumScaleFactor(0.8).frame(width: 64, alignment: .trailing)
        }
      }
    }
  }

  @ViewBuilder private func breakdown(_ analytics: G0Transport.ToolPanelPayload.Analytics) -> some View {
    if !analytics.byModel.isEmpty, let maxCost = analytics.byModel.compactMap(\.costUsd).max(), maxCost > 0 {
      VStack(alignment: .leading, spacing: 8) {
        Text(ConnectionCopy.analyticsBreakdown).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.muted)
        ForEach(Array(analytics.byModel.enumerated()), id: \.offset) { _, row in
          HStack(spacing: 8) {
            Text(modelLabel(row)).font(.system(size: 12)).foregroundStyle(Palette.ink).lineLimit(1)
              .frame(width: 110, alignment: .leading)
            GeometryReader { geo in
              RoundedRectangle(cornerRadius: 3)
                .fill(Palette.blue.opacity(0.7))
                .frame(width: max(2, geo.size.width * ((row.costUsd ?? 0) / maxCost)))
            }.frame(height: 8)
            costText(row.costUsd)
          }
        }
      }
    }
  }

  @ViewBuilder private func byProvider(_ analytics: G0Transport.ToolPanelPayload.Analytics) -> some View {
    if !analytics.byProvider.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.analyticsByProvider).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.muted)
        ForEach(analytics.byProvider, id: \.provider) { row in
          HStack {
            Text(ConnectionCopy.providerLabel(row.provider)).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.ink)
            Spacer()
            Text("\(row.turns) 轮").font(.system(size: 11)).foregroundStyle(Palette.faint)
            Text(row.costUsd.map { String(format: "$%.2f", $0) } ?? ConnectionCopy.unavailable)
              .font(.system(size: 12)).foregroundStyle(row.costUsd == nil ? Palette.faint : Palette.ink)
              .frame(width: 64, alignment: .trailing)
          }
        }
      }
    }
  }

  @ViewBuilder private func dailyChart(_ analytics: G0Transport.ToolPanelPayload.Analytics) -> some View {
    if analytics.byDay.count > 1 {
      let values = analytics.byDay.map { $0.costUsd }
      let maxValue = values.compactMap { $0 }.max() ?? 0
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.analyticsDailyCost).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.muted)
        if maxValue <= 0 {
          Text(ConnectionCopy.unavailable).font(.system(size: 12)).foregroundStyle(Palette.faint)
        } else {
          HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(analytics.byDay.enumerated()), id: \.offset) { _, day in
              RoundedRectangle(cornerRadius: 2)
                .fill(day.costUsd == nil ? Palette.line : Palette.blue.opacity(0.7))
                .frame(height: max(2, 64 * ((day.costUsd ?? 0) / maxValue)))
            }
          }.frame(height: 64, alignment: .bottom)
          Text("\(analytics.byDay.first?.day ?? "") – \(analytics.byDay.last?.day ?? "")")
            .font(.system(size: 10)).foregroundStyle(Palette.faint)
        }
      }
    }
  }

  @ViewBuilder private func modelTable(_ analytics: G0Transport.ToolPanelPayload.Analytics) -> some View {
    if !analytics.byModel.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.analyticsByModel).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.muted)
        ForEach(Array(analytics.byModel.enumerated()), id: \.offset) { _, row in
          HStack(spacing: 6) {
            Text(modelLabel(row)).font(.system(size: 12)).foregroundStyle(Palette.ink)
              .lineLimit(1)
            if row.approximate == true {
              Text(ConnectionCopy.analyticsApprox).font(.system(size: 10)).foregroundStyle(Palette.faint)
            }
            Spacer(minLength: 4)
            Text("\(row.turns) 轮").font(.system(size: 10)).foregroundStyle(Palette.faint)
            costText(row.costUsd)
          }
        }
        if analytics.byModelTruncated {
          Text(ConnectionCopy.rowsLimited(analytics.byModel.count)).font(.system(size: 10)).foregroundStyle(Palette.faint)
        }
      }
    }
  }

  private func compact(_ value: Double) -> String {
    if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
    if value >= 1_000 { return String(format: "%.1fk", value / 1_000) }
    return String(format: "%.0f", value)
  }

  // MARK: - LLM performance

  @ViewBuilder private func llmBody(_ payload: G0Transport.ToolPanelPayload) -> some View {
    if let llm = payload.llm {
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.llmRunning).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.muted)
        if llm.running.models.isEmpty {
          Text(ConnectionCopy.unavailable).font(.system(size: 12)).foregroundStyle(Palette.faint)
        } else {
          ForEach(llm.running.models, id: \.key) { group in
            HStack(spacing: 8) {
              VStack(alignment: .leading, spacing: 2) {
                Text(group.model ?? ConnectionCopy.unavailable).font(.system(size: 13, weight: .medium))
                  .foregroundStyle(Palette.ink).lineLimit(1)
                Text(group.states.joined(separator: " · ")).font(.system(size: 10.5)).foregroundStyle(Palette.muted)
              }
              Spacer(minLength: 4)
              Text("\(group.sessions)").font(.system(size: 11)).foregroundStyle(Palette.faint)
              Text(group.tokensPerSecond.map { String(format: "%.1f tok/s", $0) } ?? ConnectionCopy.unavailable)
                .font(.system(size: 11)).foregroundStyle(group.tokensPerSecond == nil ? Palette.faint : Palette.ink)
                .frame(width: 88, alignment: .trailing)
              Text(group.firstTokenMs.map { String(format: "%.0f ms", $0) } ?? ConnectionCopy.unavailable)
                .font(.system(size: 11)).foregroundStyle(group.firstTokenMs == nil ? Palette.faint : Palette.muted)
                .frame(width: 68, alignment: .trailing)
            }
          }
        }
      }
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.llmHistory).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.muted)
        if llm.history.rows.isEmpty {
          Text(ConnectionCopy.llmEmpty).font(.system(size: 12)).foregroundStyle(Palette.faint)
        } else {
          ForEach(Array(llm.history.rows.enumerated()), id: \.offset) { _, row in
            HStack(spacing: 6) {
              VStack(alignment: .leading, spacing: 2) {
                Text(row.model).font(.system(size: 12.5)).foregroundStyle(Palette.ink).lineLimit(1)
                Text("\(ConnectionCopy.providerLabel(row.providerId)) · \(shortTime(row.ts))")
                  .font(.system(size: 10.5)).foregroundStyle(Palette.faint)
              }
              Spacer(minLength: 4)
              Text(row.speed.map { String(format: "%.1f tok/s", $0) } ?? ConnectionCopy.unavailable)
                .font(.system(size: 11)).foregroundStyle(row.speed == nil ? Palette.faint : Palette.ink)
                .frame(width: 88, alignment: .trailing)
              Text(row.firstTokenMs.map { String(format: "%.0f ms", $0) } ?? ConnectionCopy.unavailable)
                .font(.system(size: 11)).foregroundStyle(row.firstTokenMs == nil ? Palette.faint : Palette.muted)
                .frame(width: 68, alignment: .trailing)
            }
          }
        }
        if llm.history.truncated {
          Text(ConnectionCopy.rowsLimited(llm.history.cappedAt)).font(.system(size: 10)).foregroundStyle(Palette.faint)
        }
        if llm.history.invalidLines > 0 {
          Text("跳过 \(llm.history.invalidLines) 行无法解析的记录").font(.system(size: 10)).foregroundStyle(Palette.faint)
        }
      }
    } else {
      Notice(text: ConnectionCopy.unavailable, warning: true)
    }
  }

  // Mac rows are `provider ＋ model`; qoder's credits belong to the provider.
  private func modelLabel(_ row: G0Transport.ToolPanelPayload.ModelRow) -> String {
    row.provider == "qoder" ? ConnectionCopy.providerLabel("qoder") : (row.model ?? ConnectionCopy.unattributed)
  }

  // A positive cost below a cent is not zero; the Mac prints `<$0.01` and so do we.
  private static func usd(_ value: Double) -> String {
    if value > 0 && value < 0.01 { return "<$0.01" }
    return usdFormatter.string(from: NSNumber(value: value)) ?? ""
  }

  private func costText(_ costUsd: Double?) -> some View {
    Text(costUsd.map(Self.usd) ?? ConnectionCopy.unavailable)
      .font(.system(size: 11))
      .foregroundStyle(costUsd == nil ? Palette.faint : Palette.muted)
      .lineLimit(1)
      .minimumScaleFactor(0.8)
      .frame(width: 84, alignment: .trailing)
  }

  private static let usdFormatter: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    formatter.locale = Locale(identifier: "en_US")
    formatter.minimumFractionDigits = 2
    formatter.maximumFractionDigits = 2
    return formatter
  }()

  private func shortTime(_ iso: String) -> String {
    // Provider timestamps carry fractional seconds; the default options fail on
    // them and would leak the raw ISO string into the row.
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: iso) {
      return date.formatted(date: .omitted, time: .shortened)
    }
    formatter.formatOptions = [.withInternetDateTime]
    guard let date = formatter.date(from: iso) else { return iso }
    return date.formatted(date: .omitted, time: .shortened)
  }

  // MARK: - MCP

  @ViewBuilder private func mcpBody(_ payload: G0Transport.ToolPanelPayload) -> some View {
    if let mcp = payload.mcp {
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.mcpLive).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.muted)
        HStack(spacing: 8) {
          Text(ConnectionCopy.providerLabel(mcp.providerId)).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.ink)
          Spacer()
          if let runtime = mcp.runtime {
            Text("\(runtime.count)").font(.system(size: 11)).foregroundStyle(Palette.faint)
          } else {
            Text(ConnectionCopy.unavailable).font(.system(size: 11)).foregroundStyle(Palette.faint)
          }
        }
        if let runtime = mcp.runtime, !runtime.isEmpty {
          ForEach(runtime, id: \.name) { entry in
            HStack {
              Text(entry.name).font(.system(size: 12.5)).foregroundStyle(Palette.ink).lineLimit(1)
              Spacer(minLength: 6)
              Text(entry.tools.map { "\($0) tools" } ?? "").font(.system(size: 10.5)).foregroundStyle(Palette.faint)
              Text(entry.status).font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(entry.status == "connected" ? Palette.green : Palette.muted)
            }
          }
        }
      }
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.mcpPolicy).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.muted)
        if mcp.configured.isEmpty {
          Text(ConnectionCopy.unavailable).font(.system(size: 12)).foregroundStyle(Palette.faint)
        } else {
          ForEach(mcp.configured, id: \.name) { entry in
            HStack(spacing: 6) {
              VStack(alignment: .leading, spacing: 2) {
                Text(entry.name).font(.system(size: 12.5)).foregroundStyle(Palette.ink).lineLimit(1)
                Text("\(entry.scope) · \(entry.transport)").font(.system(size: 10.5)).foregroundStyle(Palette.faint)
              }
              Spacer(minLength: 6)
              Text(entry.enabled ? "启用" : "停用").font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(entry.enabled ? Palette.green : Palette.muted)
            }
          }
        }
      }
      findings(mcp)
      Text(ConnectionCopy.mcpScanNote).font(.system(size: 11)).foregroundStyle(Palette.faint)
      Text(ConnectionCopy.mcpReadOnly).font(.system(size: 11)).foregroundStyle(Palette.faint)
      if mcp.configuredTruncated || mcp.runtimeTruncated {
        Text(ConnectionCopy.rowsLimited(mcp.configured.count)).font(.system(size: 10)).foregroundStyle(Palette.faint)
      }
    } else {
      Notice(text: ConnectionCopy.unavailable, warning: true)
    }
  }

  @ViewBuilder private func findings(_ mcp: G0Transport.ToolPanelPayload.Mcp) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(ConnectionCopy.mcpFindings).font(.system(size: 11, weight: .bold)).tracking(0.6)
        .foregroundStyle(Palette.muted)
      if let scan = mcp.scan {
        if let summary = scan.summary {
          HStack(spacing: 6) {
            severityChip("critical", count: summary.critical)
            severityChip("high", count: summary.high)
            severityChip("medium", count: summary.medium)
            severityChip("low", count: summary.low)
            severityChip("info", count: summary.info)
          }
        }
        if scan.findings.isEmpty {
          Text(ConnectionCopy.mcpNoFindings).font(.system(size: 12)).foregroundStyle(Palette.faint)
        } else {
          ForEach(scan.findings, id: \.id) { finding in
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(ConnectionCopy.mcpSeverity(finding.severity))
                  .font(.system(size: 10, weight: .bold)).foregroundStyle(Palette.surface)
                  .padding(.horizontal, 6).frame(minHeight: 18)
                  .background(severityColor(finding.severity), in: Capsule())
                Text(finding.title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Palette.ink)
                  .lineLimit(2)
                Spacer(minLength: 0)
              }
              Text("\(finding.ruleId) · \(ConnectionCopy.mcpDecision(finding.decision))")
                .font(.system(size: 10.5)).foregroundStyle(Palette.muted)
              if !finding.targets.isEmpty {
                Text(finding.targets.joined(separator: " · ")).font(.system(size: 10.5))
                  .foregroundStyle(Palette.faint).lineLimit(1)
              }
              if !finding.recommendation.isEmpty {
                Text(finding.recommendation).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(3)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
          }
          if scan.findingsTruncated {
            Text(ConnectionCopy.rowsLimited(scan.findings.count)).font(.system(size: 10)).foregroundStyle(Palette.faint)
          }
        }
      } else {
        Text(mcp.scanUnavailable ?? ConnectionCopy.mcpScanUnavailable)
          .font(.system(size: 12)).foregroundStyle(Palette.faint)
      }
    }
  }

  private func severityChip(_ severity: String, count: Int) -> some View {
    HStack(spacing: 3) {
      Text(ConnectionCopy.mcpSeverity(severity)).font(.system(size: 10, weight: .semibold))
        .foregroundStyle(count > 0 ? Palette.ink : Palette.faint)
      Text("\(count)").font(.system(size: 10, weight: .bold))
        .foregroundStyle(count > 0 ? severityColor(severity) : Palette.faint)
    }
    .padding(.horizontal, 6).frame(minHeight: 20)
    .background(Palette.message, in: Capsule())
  }

  private func severityColor(_ severity: String) -> Color {
    switch severity {
    case "critical": return Palette.negative
    case "high": return Palette.amber
    case "medium": return Palette.warnInk
    default: return Palette.muted
    }
  }
}
