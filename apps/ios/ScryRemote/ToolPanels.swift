import SwiftUI
import RemoteTransport

// The three tool panels are read-only projections of what the Mac already
// computed. Missing evidence stays "unavailable" with its reason; nothing here
// scans, retries, or fills a gap with a zero.
struct ToolPanelView: View {
  let kind: ToolKind
  @EnvironmentObject var model: AppModel
  @Environment(RemoteRunStore.self) var run
  @Environment(ExecutionTargetCoordinator.self) var targets
  @State private var rangeDays = 7
  @State private var retrying = false

  private var panel: G0Transport.ToolPanelPayload? {
    if case let .loaded(payload) = run.toolPanel { return payload }
    return nil
  }

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: kind.title, backAction: { model.goBack() }) {
        if case .loading = run.toolPanel {
          // The body's placeholder rows are this wait's one indicator; keep the slot.
          Color.clear.frame(width: 44, height: 44)
        } else {
          PlainIcon(symbol: "arrow.clockwise", label: ConnectionCopy.toolRefresh) {
            Task { await load() }
          }
        }
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          provenance
          if kind == .analytics { analyticsRange }
          if kind == .mcpTrust && defaultProviderId == nil {
            providerDiscoveryState
          } else if retrying {
            failedState
          } else {
            switch run.toolPanel {
            case .idle, .loading:
              PlaceholderRows(label: ConnectionCopy.readingToolPanel, count: 5, rowHeight: 52, detail: true, horizontalPadding: 0)
            case let .failed(reason):
              if reason == ConnectionCopy.panelUnsupported || reason == ConnectionCopy.toolMissingCapability {
                EmptyState(title: reason, symbol: nil, size: .card)
              } else {
                failedState
              }
            case let .loaded(payload):
              if payload.unavailable != nil {
                EmptyState(title: missingPanelEvidence, symbol: nil, size: .card)
              } else {
                switch kind {
                case .analytics: analyticsBody(payload)
                case .llmPerformance: llmBody(payload)
                case .mcpTrust: mcpBody(payload)
                }
              }
            }
          }
          Text(ConnectionCopy.toolsNote).font(.system(size: 11)).foregroundStyle(Palette.dim2)
        }
        .padding(.horizontal, 19).padding(.top, 10).padding(.bottom, 24)
      }
      .scrollIndicators(.hidden)
      .refreshable { await load() }
    }
    .background(Palette.main)
    .task(id: refreshKey) { await load() }
  }

  private var failedState: some View {
    let title: String = switch kind {
    case .analytics: ConnectionCopy.analyticsReadFailed
    case .llmPerformance: ConnectionCopy.performanceReadFailed
    case .mcpTrust: ConnectionCopy.mcpReadFailed
    }
    return EmptyState(title: title, detail: ConnectionCopy.toolReadFailedDetail(panelHost), symbol: "exclamationmark.triangle",
                      action: .init(label: ConnectionCopy.readAgain, refresh: true, busy: retrying, perform: {
      retrying = true
      Task { await load(); retrying = false }
    })).frame(minHeight: 260)
  }

  @ViewBuilder private var providerDiscoveryState: some View {
    switch run.providers {
    case .idle, .loading:
      PlaceholderRows(label: ConnectionCopy.readingToolPanel, count: 5, rowHeight: 52, detail: true, horizontalPadding: 0)
    case .failed:
      EmptyState(title: ConnectionCopy.providersUnreadable, detail: ConnectionCopy.providersUnreadableDetail,
                 symbol: "exclamationmark.triangle", action: .init(label: ConnectionCopy.refreshProviders, refresh: true, perform: {
        run.loadProviders(force: true)
      })).frame(minHeight: 260)
    case .empty, .loaded:
      EmptyState(title: ConnectionCopy.toolNoProvider, detail: ConnectionCopy.noProvidersDetail, symbol: Symbol.agent,
                 action: .init(label: ConnectionCopy.refreshProviders, refresh: true, perform: {
        run.loadProviders(force: true)
      })).frame(minHeight: 260)
    }
  }

  private var refreshKey: String { "\(kind.rawValue)-\(rangeDays)-\(kind == .mcpTrust ? defaultProviderId ?? "" : "")" }

  private func load() async {
    switch kind {
    case .analytics:
      await run.loadToolPanel(kind: .analytics, rangeDays: rangeDays)
    case .llmPerformance:
      await run.loadToolPanel(kind: .llmPerformance)
    case .mcpTrust:
      guard let providerId = defaultProviderId else {
        if case .idle = run.providers { run.loadProviders() }
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
        .font(.system(size: 11)).foregroundStyle(Palette.dim2)
      Spacer(minLength: 0)
      if let panel, isStale(panel) {
        Text(ConnectionCopy.panelStale).font(.system(size: 10)).foregroundStyle(Palette.warnText)
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

  private var missingPanelEvidence: String {
    switch kind {
    case .analytics: return ConnectionCopy.hostEvidenceMissing(ConnectionCopy.analyticsTitle + "数据")
    case .llmPerformance: return ConnectionCopy.hostEvidenceMissing("性能样本")
    case .mcpTrust: return ConnectionCopy.mcpConfigurationUnavailable
    }
  }

  // MARK: - Analytics

  private var analyticsRange: some View {
    Picker(ConnectionCopy.analyticsTitle, selection: $rangeDays) {
      Text(ConnectionCopy.toolRange7).tag(7)
      Text(ConnectionCopy.toolRange30).tag(30)
      Text(ConnectionCopy.toolRange90).tag(90)
    }
    .pickerStyle(.segmented)
  }

  @ViewBuilder private func analyticsBody(_ payload: G0Transport.ToolPanelPayload) -> some View {
    if let analytics = payload.analytics, analytics.status == "ready" {
      costHero(analytics)
      tokenGrid(analytics.totals)
      breakdown(analytics)
      byProvider(analytics)
      dailyChart(analytics)
      modelTable(analytics)
    } else {
      EmptyState(title: missingPanelEvidence, symbol: Symbol.chart, size: .card)
    }
  }

  private func costHero(_ analytics: G0Transport.ToolPanelPayload.Analytics) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(ConnectionCopy.analyticsCost).font(.system(size: 11, weight: .bold)).tracking(0.6)
        .foregroundStyle(Palette.dim)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        if let cost = analytics.totals.costUsd {
          Text(Self.usd(cost)).font(.system(size: 30, weight: .semibold))
        } else {
          Text(ConnectionCopy.hostEvidenceMissing(ConnectionCopy.analyticsCost))
            .font(.system(size: 13)).foregroundStyle(Palette.dim)
        }
        if analytics.totals.costUsd != nil, analytics.totals.costKnownRows < analytics.totals.turns {
          Text(ConnectionCopy.analyticsLowerBound).font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Palette.warnText).padding(.horizontal, 6).frame(minHeight: 18)
            .background(Palette.warn.opacity(0.12), in: Capsule())
        }
      }
      Text(ConnectionCopy.analyticsCostNote).font(.system(size: 11)).foregroundStyle(Palette.dim2)
      Text("\(analytics.fromDay) – \(analytics.toDay) · \(analytics.totals.turns) 轮")
        .font(.system(size: 11)).foregroundStyle(Palette.dim2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14).background(Palette.panel2, in: RoundedRectangle(cornerRadius: 12))
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
        .foregroundStyle(Palette.dim)
      ForEach(Array(values.enumerated()), id: \.offset) { _, item in
        HStack {
          Text(item.0).font(.system(size: 13)).foregroundStyle(Palette.fg)
          Spacer()
          if let value = item.1 {
            Text(compact(value)).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.fg)
          } else {
            Text(ConnectionCopy.hostEvidenceMissing(item.0 + " Token"))
              .font(.system(size: 12)).foregroundStyle(Palette.dim2)
          }
          Text("\(totals.tokenKnownRows)/\(totals.turns)")
            .font(.system(size: 10)).foregroundStyle(Palette.dim2)
            .lineLimit(1).minimumScaleFactor(0.8).frame(width: 64, alignment: .trailing)
        }
      }
    }
  }

  @ViewBuilder private func breakdown(_ analytics: G0Transport.ToolPanelPayload.Analytics) -> some View {
    if !analytics.byModel.isEmpty, let maxCost = analytics.byModel.compactMap(\.costUsd).max(), maxCost > 0 {
      VStack(alignment: .leading, spacing: 8) {
        Text(ConnectionCopy.analyticsBreakdown).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.dim)
        ForEach(Array(analytics.byModel.enumerated()), id: \.offset) { _, row in
          HStack(spacing: 8) {
            Text(modelLabel(row)).font(.system(size: 12)).foregroundStyle(Palette.fg).lineLimit(1)
              .frame(width: 110, alignment: .leading)
            GeometryReader { geo in
              if let cost = row.costUsd, cost > 0 {
                RoundedRectangle(cornerRadius: 3)
                  .fill(Palette.accent.opacity(0.7))
                  .frame(width: max(2, geo.size.width * (cost / maxCost)))
              }
            }.frame(height: 8).accessibilityHidden(true)
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
          .foregroundStyle(Palette.dim)
        ForEach(analytics.byProvider, id: \.provider) { row in
          HStack {
            Text(ConnectionCopy.providerLabel(row.provider)).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.fg)
            Spacer()
            Text("\(row.turns) 轮").font(.system(size: 11)).foregroundStyle(Palette.dim2)
            costText(row.costUsd)
          }
        }
      }
    }
  }

  @ViewBuilder private func dailyChart(_ analytics: G0Transport.ToolPanelPayload.Analytics) -> some View {
    if analytics.byDay.count > 1 {
      let values = analytics.byDay.map { $0.costUsd }
      let maxValue = values.compactMap { $0 }.max()
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.analyticsDailyCost).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.dim)
        if let maxValue, maxValue > 0 {
          HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(analytics.byDay.enumerated()), id: \.offset) { _, day in
              Group {
                if let cost = day.costUsd {
                  RoundedRectangle(cornerRadius: 2)
                    .fill(Palette.accent.opacity(0.7))
                    .frame(height: max(2, 64 * (cost / maxValue)))
                } else {
                  Color.clear.frame(height: 2)
                }
              }
              .accessibilityElement(children: .ignore)
              .accessibilityLabel(Text(day.day))
              .accessibilityValue(Text(day.costUsd.map(Self.usd) ?? ConnectionCopy.analyticsNoDailyRecord))
            }
          }.frame(height: 64, alignment: .bottom)
        } else {
          Text(maxValue == nil ? ConnectionCopy.hostEvidenceMissing(ConnectionCopy.analyticsDailyCost) : ConnectionCopy.analyticsZeroDailyCost)
            .font(.system(size: 12)).foregroundStyle(Palette.dim2)
          Text("\(analytics.byDay.first?.day ?? "") – \(analytics.byDay.last?.day ?? "")")
            .font(.system(size: 10)).foregroundStyle(Palette.dim2)
        }
      }
    }
  }

  @ViewBuilder private func modelTable(_ analytics: G0Transport.ToolPanelPayload.Analytics) -> some View {
    if !analytics.byModel.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.analyticsByModel).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.dim)
        ForEach(Array(analytics.byModel.enumerated()), id: \.offset) { _, row in
          HStack(spacing: 6) {
            Text(modelLabel(row)).font(.system(size: 12)).foregroundStyle(Palette.fg)
              .lineLimit(1)
            if row.approximate == true {
              Text(ConnectionCopy.analyticsApprox).font(.system(size: 10)).foregroundStyle(Palette.dim2)
            }
            Spacer(minLength: 4)
            Text("\(row.turns) 轮").font(.system(size: 10)).foregroundStyle(Palette.dim2)
            costText(row.costUsd)
          }
        }
        if analytics.byModelTruncated {
          Text(ConnectionCopy.rowsLimited(analytics.byModel.count)).font(.system(size: 10)).foregroundStyle(Palette.dim2)
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
      Text(ConnectionCopy.llmFirstOutputBasis).font(.system(size: 11)).foregroundStyle(Palette.dim2)
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.llmRunning).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.dim)
        if llm.running.models.isEmpty {
          EmptyState(title: ConnectionCopy.noRunningPerformanceModels, symbol: Symbol.chart, size: .card)
        } else {
          ForEach(llm.running.models, id: \.key) { group in
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                  Text(group.model ?? ConnectionCopy.hostEvidenceMissing("模型名称")).font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Palette.fg).lineLimit(1)
                  Text(([group.providerId.map(ConnectionCopy.providerLabel)].compactMap { $0 } + group.states).joined(separator: " · "))
                    .font(.system(size: 10.5)).foregroundStyle(Palette.dim)
                }
                Spacer(minLength: 4)
                Text("\(group.sessions)").font(.system(size: 11)).foregroundStyle(Palette.dim2)
              }
              llmMeasurements(speed: group.tokensPerSecond, firstTokenMs: group.firstTokenMs, firstOutputWaitMs: group.firstOutputWaitMs)
            }
          }
        }
      }
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.llmHistory).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.dim)
        if llm.history.rows.isEmpty {
          EmptyState(title: llm.history.invalidLines > 0 ? ConnectionCopy.noReadablePerformanceSamples : ConnectionCopy.noPerformanceSamples,
                     symbol: nil, size: .card)
        } else {
          ForEach(Array(llm.history.rows.enumerated()), id: \.offset) { _, row in
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 2) {
                  Text(row.model).font(.system(size: 12.5)).foregroundStyle(Palette.fg).lineLimit(1)
                  Text("\(ConnectionCopy.providerLabel(row.providerId)) · \(shortTime(row.ts))")
                    .font(.system(size: 10.5)).foregroundStyle(Palette.dim2)
                }
                Spacer(minLength: 4)
                if row.failed {
                  Text(ConnectionCopy.llmUnsuccessful).font(.system(size: 11)).foregroundStyle(Palette.dim2)
                }
              }
              if !row.failed {
                llmMeasurements(speed: row.speed, firstTokenMs: row.firstTokenMs, firstOutputWaitMs: row.firstOutputWaitMs)
              }
            }
          }
        }
        if llm.history.truncated {
          Text(ConnectionCopy.rowsLimited(llm.history.cappedAt)).font(.system(size: 10)).foregroundStyle(Palette.dim2)
        }
        if llm.history.invalidLines > 0 {
          Text("跳过 \(llm.history.invalidLines) 行无法解析的记录").font(.system(size: 10)).foregroundStyle(Palette.dim2)
        }
      }
    } else {
      EmptyState(title: missingPanelEvidence, symbol: Symbol.chart, size: .card)
    }
  }

  private func llmMeasurements(speed: Double?, firstTokenMs: Double?, firstOutputWaitMs: Double?) -> some View {
    HStack(alignment: .top, spacing: 8) {
      llmMeasurement(ConnectionCopy.llmSpeed, speed.map { String(format: "%.1f tok/s", $0) })
      llmMeasurement(ConnectionCopy.llmFirstToken, firstTokenMs.map { String(format: "%.1f s", $0 / 1000) })
      llmMeasurement(ConnectionCopy.llmFirstOutput, firstOutputWaitMs.map { String(format: "%.1f s", $0 / 1000) })
    }
  }

  private func llmMeasurement(_ label: String, _ value: String?) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).foregroundStyle(Palette.dim2)
      Text(value ?? ConnectionCopy.hostEvidenceMissing(label)).monospacedDigit()
        .foregroundStyle(value == nil ? Palette.dim2 : Palette.fg)
    }
    .font(.system(size: 11))
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
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
    Text(costUsd.map(Self.usd) ?? ConnectionCopy.hostEvidenceMissing(ConnectionCopy.analyticsCost))
      .font(.system(size: 11))
      .foregroundStyle(costUsd == nil ? Palette.dim2 : Palette.dim)
      .multilineTextAlignment(.trailing)
      .frame(minWidth: 84, alignment: .trailing)
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

}
