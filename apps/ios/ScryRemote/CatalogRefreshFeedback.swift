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
        Image(systemName: "exclamationmark.circle").font(.system(size: 14, weight: .medium)).padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(.system(size: 13, weight: .semibold))
          Text(ConnectionCopy.lastFullRefresh(lastFullRefresh)).font(.system(size: 11))
        }
        Spacer(minLength: 4)
      }
      HStack(spacing: 16) {
        Button(failure.requiresPairing ? ConnectionCopy.pairAgain : ConnectionCopy.retry, action: onRetry)
          .font(.system(size: 12, weight: .semibold)).frame(minWidth: 44, minHeight: 44).disabled(refreshing)
        Button(ConnectionCopy.details, action: onDetails).font(.system(size: 12, weight: .medium))
          .frame(minWidth: 44, minHeight: 44)
      }
    }
    .foregroundStyle(Palette.warnInk).padding(12)
    .background(Palette.warnBg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
      Text(ConnectionCopy.lastFullRefresh(lastFullRefresh)).font(.caption).foregroundStyle(Palette.muted)
      DisclosureGroup(ConnectionCopy.technicalDetails, isExpanded: $technicalExpanded) {
        Text(issues.isEmpty ? failure.technicalDetail : issues.map(\.diagnostic).joined(separator: "\n\n"))
          .font(.caption.monospaced()).foregroundStyle(Palette.muted)
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
