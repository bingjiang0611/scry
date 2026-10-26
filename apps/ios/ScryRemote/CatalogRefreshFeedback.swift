import SwiftUI

// Details describe one request, not the next background refresh or pairing.
struct CatalogRefreshDetailsSnapshot: Identifiable {
  let id = UUID()
  let failure: RemoteRunStore.CatalogRefreshFailure
  let lastFullRefresh: Date?
  let address: String?
  let paired: Bool
  var issues: [ExecutionTargetCoordinator.RefreshIssue] = []
}

struct CatalogRefreshBanner: View {
  let failure: RemoteRunStore.CatalogRefreshFailure
  let lastFullRefresh: Date?
  let refreshing: Bool
  var summary: String? = nil
  let onRetry: () -> Void
  let onDetails: () -> Void

  private var title: String { summary ?? failure.summary }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "exclamationmark.circle").font(Typography.rowTitle.weight(.medium)).foregroundStyle(Palette.warn).padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(Typography.groupLabel)
          Text(ConnectionCopy.lastFullRefresh(lastFullRefresh)).font(Typography.meta)
        }
        Spacer(minLength: 4)
      }
      HStack(spacing: 16) {
        Button(failure.requiresPairing ? ConnectionCopy.pairAgain : ConnectionCopy.retry, action: onRetry)
          .font(Typography.meta.weight(.semibold)).frame(minWidth: 44, minHeight: 44).disabled(refreshing)
        Button(ConnectionCopy.details, action: onDetails).font(Typography.meta.weight(.medium))
          .frame(minWidth: 44, minHeight: 44)
      }
    }
    .foregroundStyle(Palette.warnText).padding(12)
    .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 16).padding(.vertical, 8)
  }
}

struct CatalogRefreshDetails: View {
  let failure: RemoteRunStore.CatalogRefreshFailure
  let lastFullRefresh: Date?
  let address: String?
  let paired: Bool
  var issues: [ExecutionTargetCoordinator.RefreshIssue] = []
  #if DEBUG
  @Environment(ExecutionTargetCoordinator.self) private var targets
  #endif
  @Environment(\.dismiss) private var dismiss
  @State private var technicalExpanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        Text(ConnectionCopy.detailsTitle).font(.title3.weight(.semibold))
        Spacer()
        Button(ConnectionCopy.done) { dismiss() }.frame(minWidth: 44, minHeight: 44)
      }
      LabeledContent(ConnectionCopy.pairing, value: paired ? ConnectionCopy.pairingSaved : ConnectionCopy.pairingAbsent)
      LabeledContent(ConnectionCopy.connectionAddress, value: address ?? ConnectionCopy.unavailableAddress)
      LabeledContent(ConnectionCopy.listRequest, value: failure.summary)
      Text(ConnectionCopy.lastFullRefresh(lastFullRefresh)).font(.caption).foregroundStyle(Palette.dim)
      DisclosureGroup(ConnectionCopy.technicalDetails, isExpanded: $technicalExpanded) {
        Text(issues.isEmpty ? failure.technicalDetail : issues.map(\.diagnostic).joined(separator: "\n\n"))
          .font(.caption.monospaced()).foregroundStyle(Palette.dim)
          .textSelection(.enabled).padding(.top, 8)
      }
      Spacer()
    }.padding(20)
    #if DEBUG
    .accessibilityIdentifier(targets.lastFullRefresh == lastFullRefresh
      ? "catalog-refresh-details" : "catalog-refresh-details-updated")
    #endif
  }

}
