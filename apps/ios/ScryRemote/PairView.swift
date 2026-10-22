import SwiftUI

// v5 pairing keeps one clear action and makes the trust boundary explicit. A
// fingerprint means proof succeeded but is never rendered as paired until the
// Mac issues a real grant.
struct PairView: View {
  @EnvironmentObject var model: AppModel
  @Environment(RemoteRunStore.self) var run
  @State private var technicalExpanded = false

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: ConnectionCopy.connectMac, backAction: model.canGoBack ? { model.goBack() } : nil) {
        Color.clear.frame(width: 44, height: 44)
      }
      ScrollView {
        VStack(spacing: 0) {
          pairMark.padding(.top, 34).padding(.bottom, 25)
          Text(ConnectionCopy.pairHeading)
            .font(.system(size: 25, weight: .bold)).tracking(-0.6).multilineTextAlignment(.center)
          Text(ConnectionCopy.pairLead)
            .font(.system(size: 14)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
            .padding(.top, 9).padding(.horizontal, 22)

          VStack(spacing: 0) {
            step(1, ConnectionCopy.pairStepScan)
            step(2, ConnectionCopy.pairStepVerify)
            step(3, ConnectionCopy.pairStepApprove)
          }
          .padding(.top, 26)

          pairingStatus.padding(.top, 18)

          HStack(alignment: .top, spacing: 9) {
            Image(systemName: Symbol.shield).font(.system(size: 16)).foregroundStyle(Palette.positive)
            Text(ConnectionCopy.pairTrust)
              .font(.system(size: 11)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(13).background(Palette.noticeBg, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
          .padding(.top, 18)
        }
        .padding(.horizontal, 24).padding(.bottom, 20)
      }
      .scrollIndicators(.hidden)

      VStack(spacing: 8) {
        Button { model.pairing = .scanning } label: {
          Label(ConnectionCopy.scanPairingCode, systemImage: "qrcode.viewfinder")
            .font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(Palette.surface).background(Palette.blue, in: Capsule())
        }
        .buttonStyle(.plain)
      }
      .padding(.horizontal, 20).padding(.bottom, 18)
    }
    .background(Palette.surface)
    .fullScreenCover(isPresented: scanning) {
      ZStack(alignment: .topTrailing) {
        QRScanner(onCode: { code in model.pairing = .idle; model.beginPair(scanned: code, runStore: run) },
                  onFailure: { message in model.pairing = .failed(.init(message: message)) }).ignoresSafeArea()
        Button(ConnectionCopy.cancel) { model.pairing = .idle }
          .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).padding(16)
      }
    }
    .onChange(of: model.pairing) { technicalExpanded = false }
  }

  private var pairMark: some View {
    ZStack(alignment: .bottomTrailing) {
      Image(systemName: Symbol.laptop).font(.system(size: 35, weight: .light)).foregroundStyle(Palette.ink)
        .frame(width: 88, height: 88).background(Palette.canvas, in: RoundedRectangle(cornerRadius: 27, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 27, style: .continuous).stroke(Palette.line))
        .shadow(color: .black.opacity(0.07), radius: 18, y: 10)
      Image(systemName: "iphone").font(.system(size: 20, weight: .medium)).foregroundStyle(Palette.surface)
        .frame(width: 40, height: 40).background(Palette.blue, in: Circle()).offset(x: 8, y: 8)
    }
  }

  private var scanning: Binding<Bool> {
    Binding(get: { model.pairing == .scanning }, set: { if !$0 && model.pairing == .scanning { model.pairing = .idle } })
  }

  @ViewBuilder private var pairingStatus: some View {
    switch model.pairing {
    case .idle, .scanning:
      EmptyView()
    case .proving:
      statusCard(ConnectionCopy.pairingProving, tint: Palette.blue, progress: true)
    case let .awaitingConfirmation(fingerprint):
      statusCard(ConnectionCopy.pairingAwaiting(fingerprint), tint: Palette.amber)
    case let .paired(deviceId):
      statusCard(ConnectionCopy.pairingPaired(deviceId), tint: Palette.green)
    case let .failed(failure):
      failureCard(failure)
    }
  }

  private func statusCard(_ text: String, tint: Color, progress: Bool = false) -> some View {
    HStack(alignment: .top, spacing: 10) {
      if progress { ProgressView().controlSize(.small) }
      else { Circle().fill(tint).frame(width: 8, height: 8).padding(.top, 5) }
      Text(text).font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
    }
    .foregroundStyle(Palette.ink).padding(13)
    .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
  }

  private func failureCard(_ failure: PairingFailure) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        Circle().fill(Palette.negative).frame(width: 8, height: 8).padding(.top, 5)
        Text(failure.message).font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
      }
      if let detail = failure.technicalDetail {
        DisclosureGroup(ConnectionCopy.technicalDetails, isExpanded: $technicalExpanded) {
          Text(detail).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.muted)
            .textSelection(.enabled).padding(.top, 6)
        }
        .font(.system(size: 13))
      }
    }
    .foregroundStyle(Palette.ink).padding(13)
    .background(Palette.negative.opacity(0.09), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    .accessibilityIdentifier("pairing-failure")
  }

  private func step(_ number: Int, _ text: String) -> some View {
    HStack(spacing: 12) {
      Text("\(number)").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.ink)
        .padding(7).frame(minWidth: 27, minHeight: 27).background(Palette.canvas, in: Circle())
      Text(text).font(.system(size: 14.5)).foregroundStyle(Palette.ink)
      Spacer()
    }
    .frame(minHeight: 48)
  }
}
