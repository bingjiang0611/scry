import SwiftUI
import RemoteTransport

extension ToolPanelView {
  // MARK: - MCP

  @ViewBuilder func mcpBody(_ payload: G0Transport.ToolPanelPayload) -> some View {
    if let mcp = payload.mcp {
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.mcpLive).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.dim)
        HStack(spacing: 8) {
          Text(ConnectionCopy.providerLabel(mcp.providerId)).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.fg)
          Spacer()
          if let runtime = mcp.runtime {
            Text("\(runtime.count)").font(.system(size: 11)).foregroundStyle(Palette.dim2)
          } else {
            Text(ConnectionCopy.unavailable).font(.system(size: 11)).foregroundStyle(Palette.dim2)
          }
        }
        if let runtime = mcp.runtime, !runtime.isEmpty {
          ForEach(runtime, id: \.name) { entry in
            HStack {
              Text(entry.name).font(.system(size: 12.5)).foregroundStyle(Palette.fg).lineLimit(1)
              Spacer(minLength: 6)
              Text(entry.tools.map { "\($0) tools" } ?? "").font(.system(size: 10.5)).foregroundStyle(Palette.dim2)
              Text(entry.status).font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(entry.status == "connected" ? Palette.ok : Palette.dim)
            }
          }
        }
      }
      VStack(alignment: .leading, spacing: 6) {
        Text(ConnectionCopy.mcpPolicy).font(.system(size: 11, weight: .bold)).tracking(0.6)
          .foregroundStyle(Palette.dim)
        if mcp.configured.isEmpty {
          Text(ConnectionCopy.unavailable).font(.system(size: 12)).foregroundStyle(Palette.dim2)
        } else {
          ForEach(mcp.configured, id: \.name) { entry in
            HStack(spacing: 6) {
              VStack(alignment: .leading, spacing: 2) {
                Text(entry.name).font(.system(size: 12.5)).foregroundStyle(Palette.fg).lineLimit(1)
                Text("\(entry.scope) · \(entry.transport)").font(.system(size: 10.5)).foregroundStyle(Palette.dim2)
              }
              Spacer(minLength: 6)
              Text(entry.enabled ? "启用" : "停用").font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(entry.enabled ? Palette.ok : Palette.dim)
            }
          }
        }
      }
      findings(mcp)
      Text(ConnectionCopy.mcpScanNote).font(.system(size: 11)).foregroundStyle(Palette.dim2)
      Text(ConnectionCopy.mcpReadOnly).font(.system(size: 11)).foregroundStyle(Palette.dim2)
      if mcp.configuredTruncated || mcp.runtimeTruncated {
        Text(ConnectionCopy.rowsLimited(mcp.configured.count)).font(.system(size: 10)).foregroundStyle(Palette.dim2)
      }
    } else {
      Notice(text: ConnectionCopy.unavailable, warning: true)
    }
  }

  @ViewBuilder private func findings(_ mcp: G0Transport.ToolPanelPayload.Mcp) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(ConnectionCopy.mcpFindings).font(.system(size: 11, weight: .bold)).tracking(0.6)
        .foregroundStyle(Palette.dim)
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
          Text(ConnectionCopy.mcpNoFindings).font(.system(size: 12)).foregroundStyle(Palette.dim2)
        } else {
          ForEach(scan.findings, id: \.id) { finding in
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(ConnectionCopy.mcpSeverity(finding.severity))
                  .font(.system(size: 10, weight: .bold)).foregroundStyle(Palette.main)
                  .padding(.horizontal, 6).frame(minHeight: 18)
                  .background(severityColor(finding.severity), in: Capsule())
                Text(finding.title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Palette.fg)
                  .lineLimit(2)
                Spacer(minLength: 0)
              }
              Text("\(finding.ruleId) · \(ConnectionCopy.mcpDecision(finding.decision))")
                .font(.system(size: 10.5)).foregroundStyle(Palette.dim)
              if !finding.targets.isEmpty {
                Text(finding.targets.joined(separator: " · ")).font(.system(size: 10.5))
                  .foregroundStyle(Palette.dim2).lineLimit(1)
              }
              if !finding.recommendation.isEmpty {
                Text(finding.recommendation).font(.system(size: 11)).foregroundStyle(Palette.dim).lineLimit(3)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
          }
          if scan.findingsTruncated {
            Text(ConnectionCopy.rowsLimited(scan.findings.count)).font(.system(size: 10)).foregroundStyle(Palette.dim2)
          }
        }
      } else {
        Text(mcp.scanUnavailable ?? ConnectionCopy.mcpScanUnavailable)
          .font(.system(size: 12)).foregroundStyle(Palette.dim2)
      }
    }
  }

  private func severityChip(_ severity: String, count: Int) -> some View {
    HStack(spacing: 3) {
      Text(ConnectionCopy.mcpSeverity(severity)).font(.system(size: 10, weight: .semibold))
        .foregroundStyle(count > 0 ? Palette.fg : Palette.dim2)
      Text("\(count)").font(.system(size: 10, weight: .bold))
        .foregroundStyle(count > 0 ? severityColor(severity) : Palette.dim2)
    }
    .padding(.horizontal, 6).frame(minHeight: 20)
    .background(Palette.panel2, in: Capsule())
  }

  private func severityColor(_ severity: String) -> Color {
    switch severity {
    case "critical": return Palette.bad
    case "high": return Palette.warn
    case "medium": return Palette.warn
    default: return Palette.dim
    }
  }
}
