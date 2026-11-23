import SwiftUI
import RemoteTransport

struct ModelEffortPopover: View {
  let modelOptions: [G0Transport.RunModelOption]
  let selectedModelId: String?
  let effortOptions: [G0Transport.RunControlOption]
  let selectedEffort: String?
  let onModel: ((String?) -> Void)?
  let onEffort: ((String?) -> Void)?
  @Environment(\.colorScheme) private var colorScheme

  private var activeEfforts: [G0Transport.RunControlOption] {
    if let efforts = modelOptions.first(where: { $0.selectionId == selectedModelId })?.efforts,
       !efforts.isEmpty { return efforts }
    return effortOptions
  }

  private var modelSelection: Binding<String> {
    Binding(get: { selectedModelId ?? "" }, set: { onModel?($0.isEmpty ? nil : $0) })
  }

  private var effortSelection: Binding<String> {
    Binding(get: { selectedEffort ?? "" }, set: { onEffort?($0.isEmpty ? nil : $0) })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(SheetCopy.modelTitle).font(Typography.sheetTitle).foregroundStyle(Palette.fg)
        Text(SheetCopy.nextTurn).font(Typography.meta).foregroundStyle(Palette.dim2)
      }

      Picker(ConnectionCopy.model, selection: modelSelection) {
        Text(ConnectionCopy.automaticModel).tag("")
        if let selectedModelId, !modelOptions.contains(where: { $0.selectionId == selectedModelId }) {
          Text(selectedModelId).tag(selectedModelId)
        }
        ForEach(modelOptions, id: \.selectionId) { option in
          Text(modelLabel(option)).tag(option.selectionId)
        }
      }
      .pickerStyle(.menu)
      .accessibilityIdentifier("model-picker")
      .accessibilityValue(modelDisplayLabel)
      .frame(maxWidth: .infinity, alignment: .leading)

      if !activeEfforts.isEmpty {
        Rectangle().fill(Palette.border3).frame(height: 1)
        Picker(ConnectionCopy.reasoningEffort, selection: effortSelection) {
          Text(ConnectionCopy.defaultEffort).tag("")
          if let selectedEffort, !activeEfforts.contains(where: { $0.id == selectedEffort }) {
            Text(selectedEffort).tag(selectedEffort)
          }
          ForEach(activeEfforts, id: \.id) { option in
            Text(effortLabel(option)).tag(option.id)
          }
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("effort-picker")
        .accessibilityValue(effortDisplayLabel)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(16).frame(width: 300)
    .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.border, lineWidth: 1))
    .shadow(color: .black.opacity(colorScheme == .dark ? 0.28 : 0.08), radius: 24, y: 8)
    .presentationBackground(Palette.panel2)
    .presentationCornerRadius(16)
    .presentationCompactAdaptation(.popover)
  }

  private var modelDisplayLabel: String {
    guard let selectedModelId else { return ConnectionCopy.automaticModel }
    return modelOptions.first(where: { $0.selectionId == selectedModelId })?.label ?? selectedModelId
  }

  private var effortDisplayLabel: String {
    guard let selectedEffort else { return ConnectionCopy.defaultEffort }
    return activeEfforts.first(where: { $0.id == selectedEffort })?.label ?? selectedEffort
  }

  private func modelLabel(_ option: G0Transport.RunModelOption) -> String {
    option.isDefault == true ? "\(option.label) · \(SheetCopy.defaultModel)" : option.label
  }

  private func effortLabel(_ option: G0Transport.RunControlOption) -> String {
    option.isDefault == true ? "\(option.label) · \(ConnectionCopy.defaultEffort)" : option.label
  }
}
