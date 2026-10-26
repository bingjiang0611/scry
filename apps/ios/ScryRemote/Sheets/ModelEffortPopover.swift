import SwiftUI
import RemoteTransport

struct ModelEffortPopover: View {
  let modelOptions: [G0Transport.RunModelOption]
  let selectedModelId: String?
  let effortOptions: [G0Transport.RunControlOption]
  let selectedEffort: String?
  let onModel: ((String?) -> Void)?
  let onEffort: ((String?) -> Void)?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var colorScheme
  @Namespace private var selection
  @State private var appeared = false

  private var activeEfforts: [G0Transport.RunControlOption] {
    if let efforts = modelOptions.first(where: { $0.selectionId == selectedModelId })?.efforts,
       !efforts.isEmpty { return efforts }
    return effortOptions
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(SheetCopy.modelTitle).font(Typography.sheetTitle).foregroundStyle(Palette.fg)
        Text(SheetCopy.nextTurn).font(Typography.meta).foregroundStyle(Palette.dim2)
      }
      ScrollView {
        LazyVStack(spacing: 2) {
          Button { onModel?(nil) } label: {
            modelRow(ConnectionCopy.automaticModel, description: nil, isDefault: false, selected: selectedModelId == nil)
          }
          .accessibilityIdentifier("model-option-auto")
          .accessibilityAddTraits(selectedModelId == nil ? .isSelected : [])
          ForEach(modelOptions, id: \.selectionId) { option in
            Button { onModel?(option.selectionId) } label: {
              modelRow(option.label, description: option.description, isDefault: option.isDefault == true,
                       selected: selectedModelId == option.selectionId)
            }
            .accessibilityIdentifier("model-option-\(option.selectionId)")
            .accessibilityAddTraits(selectedModelId == option.selectionId ? .isSelected : [])
          }
        }
      }
      .frame(maxHeight: 280).fixedSize(horizontal: false, vertical: true)
      .scrollBounceBehavior(.basedOnSize)
      if !activeEfforts.isEmpty {
        Rectangle().fill(Palette.border3).frame(height: 1)
        Text(ConnectionCopy.reasoningEffort).font(Typography.meta).foregroundStyle(Palette.dim2)
        if activeEfforts.count + 1 <= 5 {
          HStack(spacing: 0) {
            effortSegment(ConnectionCopy.defaultEffort, id: nil)
            ForEach(activeEfforts, id: \.id) { option in effortSegment(option.label, id: option.id) }
          }
          .background(Palette.subtle, in: RoundedRectangle(cornerRadius: 10))
          .animation(Motion.animation(.tab, reduceMotion: reduceMotion), value: selectedEffort)
          .accessibilityElement(children: .contain).accessibilityIdentifier("effort-segments")
        } else {
          ScrollView {
            LazyVStack(spacing: 2) {
              effortRow(ConnectionCopy.defaultEffort, id: nil)
              ForEach(activeEfforts, id: \.id) { option in effortRow(option.label, id: option.id) }
            }
          }
          .frame(maxHeight: 220).fixedSize(horizontal: false, vertical: true)
          .scrollBounceBehavior(.basedOnSize)
          .accessibilityElement(children: .contain).accessibilityIdentifier("effort-list")
        }
      }
    }
    .padding(16).frame(width: 300)
    .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.border, lineWidth: 1))
    .shadow(color: .black.opacity(colorScheme == .dark ? 0.28 : 0.08), radius: 24, y: 8)
    .buttonStyle(.plain)
    .opacity(appeared ? 1 : 0)
    .onAppear { withAnimation(Motion.animation(.select, reduceMotion: reduceMotion)) { appeared = true } }
    .presentationBackground(Palette.panel2)
    .presentationCornerRadius(16)
    .presentationCompactAdaptation(.popover)
  }

  private func modelRow(_ label: String, description: String?, isDefault: Bool, selected: Bool) -> some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Text(label).font(Typography.rowTitle).foregroundStyle(Palette.fg)
          if isDefault {
            Text(SheetCopy.defaultModel).font(Typography.meta).foregroundStyle(Palette.dim2)
              .padding(.horizontal, 5).padding(.vertical, 2)
              .background(Palette.subtle, in: RoundedRectangle(cornerRadius: 6))
          }
        }
        if let description, !description.isEmpty {
          Text(description).font(Typography.meta).foregroundStyle(Palette.dim2)
        }
      }
      Spacer(minLength: 0)
      Image(systemName: Symbol.check).foregroundStyle(Palette.accent).opacity(selected ? 1 : 0)
        .accessibilityHidden(true)
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
    .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading).contentShape(Rectangle())
  }

  private func effortSegment(_ label: String, id: String?) -> some View {
    Button { onEffort?(id) } label: {
      Text(label).font(Typography.meta.weight(.medium))
        .foregroundStyle(selectedEffort == id ? Palette.fg : Palette.dim2)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background {
          if selectedEffort == id {
            if reduceMotion {
              RoundedRectangle(cornerRadius: 10).fill(Palette.panel3).transition(.opacity)
            } else {
              RoundedRectangle(cornerRadius: 10).fill(Palette.panel3)
                .matchedGeometryEffect(id: "effort", in: selection)
            }
          }
        }
        .contentShape(Rectangle())
    }
    .accessibilityIdentifier("effort-option-\(id ?? "default")")
    .accessibilityAddTraits(selectedEffort == id ? .isSelected : [])
  }

  private func effortRow(_ label: String, id: String?) -> some View {
    Button { onEffort?(id) } label: {
      HStack {
        Text(label).font(Typography.reply).foregroundStyle(Palette.fg)
        Spacer()
        Image(systemName: Symbol.check).foregroundStyle(Palette.accent).opacity(selectedEffort == id ? 1 : 0)
          .accessibilityHidden(true)
      }
      .padding(.horizontal, 8).frame(minHeight: 46).contentShape(Rectangle())
    }
    .accessibilityIdentifier("effort-option-\(id ?? "default")")
    .accessibilityAddTraits(selectedEffort == id ? .isSelected : [])
  }
}
