import SwiftUI
import RemoteTransport

struct RemoteQuestionSheet: View {
  let request: G0Transport.RunQuestionRequest
  let subtitle: String
  let submitting: Bool
  let error: String?
  let onAnswer: ([String: String]) -> Void
  let onCancel: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var answers: [String: String]
  @State private var selections: [String: Set<String>]

  init(request: G0Transport.RunQuestionRequest, subtitle: String, submitting: Bool, error: String?,
       onAnswer: @escaping ([String: String]) -> Void, onCancel: @escaping () -> Void) {
    self.request = request
    self.subtitle = subtitle
    self.submitting = submitting
    self.error = error
    self.onAnswer = onAnswer
    self.onCancel = onCancel
    _answers = State(initialValue: [:])
    _selections = State(initialValue: [:])
  }

  private var complete: Bool {
    request.questions.allSatisfy { question in
      if question.multiSelect { return !(selections[question.question] ?? []).isEmpty }
      return !(answers[question.question] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }

  private var resolvedAnswers: [String: String] {
    var resolved = answers
    for question in request.questions where question.multiSelect {
      let selected = selections[question.question] ?? []
      resolved[question.question] = question.options.map(\.label).filter(selected.contains).joined(separator: ", ")
    }
    return resolved
  }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: SheetCopy.questionTitle, subtitle: subtitle)
      Rectangle().fill(Palette.border3).frame(height: 1)
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text(request.questionKind == "permission" ? SheetCopy.permission : SheetCopy.input)
            .font(Typography.meta.weight(.medium)).foregroundStyle(Palette.warn)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(Palette.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
          ForEach(Array(request.questions.enumerated()), id: \.offset) { index, question in
            VStack(alignment: .leading, spacing: 10) {
              if !question.header.isEmpty && !question.question.contains(question.header) {
                Text(question.header).font(Typography.groupLabel).foregroundStyle(Palette.dim2)
              }
              Text(question.question).font(Typography.reply.weight(.medium)).foregroundStyle(Palette.fg)
              if question.inputMode != nil {
                Group {
                  if question.inputMode == "multiline" {
                    TextEditor(text: textBinding(question.question))
                      .scrollContentBackground(.hidden).frame(minHeight: 120)
                  } else {
                    TextField(SheetCopy.inputPlaceholder, text: textBinding(question.question))
                  }
                }
                .font(Typography.reply).foregroundStyle(Palette.fg).padding(12).frame(minHeight: 44)
                .background(Palette.main, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.border, lineWidth: 1))
                .accessibilityIdentifier("question-input-\(index)")
              } else if question.multiSelect {
                ForEach(question.options, id: \.label) { option in
                  Button {
                    var selected = selections[question.question] ?? []
                    if selected.contains(option.label) { selected.remove(option.label) } else { selected.insert(option.label) }
                    selections[question.question] = selected
                  } label: {
                    optionRow(option, selected: (selections[question.question] ?? []).contains(option.label),
                              multiple: true)
                  }
                  .buttonStyle(.plain)
                  .accessibilityAddTraits((selections[question.question] ?? []).contains(option.label) ? .isSelected : [])
                }
              } else {
                // Every option visible at once, one tap to choose (as on the Mac).
                ForEach(question.options, id: \.label) { option in
                  Button { answers[question.question] = option.label } label: {
                    optionRow(option, selected: answers[question.question] == option.label, multiple: false)
                  }
                  .buttonStyle(.plain)
                  .accessibilityAddTraits(answers[question.question] == option.label ? .isSelected : [])
                }
              }
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
      }
      VStack(spacing: 10) {
        if let error {
          Text(error).font(Typography.meta).foregroundStyle(Palette.bad)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        QuestionActionsLayout(stacked: dynamicTypeSize.isAccessibilitySize) {
            Button(action: onCancel) {
              Text(SheetCopy.cancelRequest).font(Typography.rowTitle.weight(.semibold)).foregroundStyle(Palette.fg)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Palette.panel, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border2, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: 14))
            }
            .disabled(submitting).accessibilityIdentifier("question-cancel")
            Button { onAnswer(resolvedAnswers) } label: {
              Text(submitting ? SheetCopy.submitting : SheetCopy.submit)
                .font(Typography.rowTitle.weight(.semibold)).foregroundStyle(Palette.onAccent)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Palette.accentFill, in: RoundedRectangle(cornerRadius: 14))
                .opacity(submitting || !complete ? 0.5 : 1)
                .contentShape(RoundedRectangle(cornerRadius: 14))
            }
            .disabled(submitting || !complete).accessibilityIdentifier("question-submit")
        }
        .buttonStyle(.plain)
      }
      .padding(16)
    }
    .background(Palette.panel2)
    .presentationBackground(Palette.panel2)
    .presentationDragIndicator(.visible)
  }

  private func textBinding(_ key: String) -> Binding<String> {
    Binding(get: { answers[key] ?? "" }, set: { answers[key] = $0 })
  }

  private func optionRow(_ option: G0Transport.RunQuestionOption, selected: Bool, multiple: Bool) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Group {
        if multiple {
          Image(systemName: selected ? "checkmark.square.fill" : "square")
        } else {
          ZStack {
            Circle().stroke(lineWidth: 1.5)
            Circle().padding(4).opacity(selected ? 1 : 0)
              .scaleEffect(reduceMotion || selected ? 1 : 0.5)
          }
        }
      }
      .frame(width: 18, height: 18).accessibilityHidden(true)
      .foregroundStyle(selected ? Palette.accent : Palette.dim2).padding(.top, 1)
      VStack(alignment: .leading, spacing: 4) {
        Text(option.label).font(Typography.reply.weight(.medium)).foregroundStyle(Palette.fg)
        if !option.description.isEmpty {
          Text(option.description).font(Typography.meta).foregroundStyle(Palette.dim2)
        }
        if let preview = option.preview {
          Text(preview).font(Typography.codeBlock).foregroundStyle(Palette.dim2)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
    .background(selected ? Palette.accentSoft : Palette.main, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12)
      .stroke(selected ? Palette.accent : Palette.border, lineWidth: selected ? 1.5 : 1))
    .contentShape(RoundedRectangle(cornerRadius: 12))
    .animation(Motion.animation(.select, reduceMotion: reduceMotion), value: selected)
  }
}

// Preserve the default 1:1.4 widths, but measure intrinsic text height at every text size.
private struct QuestionActionsLayout: Layout {
  let stacked: Bool

  private func sizes(width: CGFloat, subviews: Subviews) -> [CGSize] {
    subviews.enumerated().map { index, view in
      let proposedWidth = stacked ? width : (width - 10) * (index == 0 ? 1 : 1.4) / 2.4
      return view.sizeThatFits(.init(width: proposedWidth, height: nil))
    }
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? subviews.map { $0.sizeThatFits(.unspecified).width }.reduce(10, +)
    let measured = sizes(width: width, subviews: subviews)
    return CGSize(width: width, height: stacked ? measured.reduce(10) { $0 + $1.height } : measured.map(\.height).max() ?? 0)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let measured = sizes(width: bounds.width, subviews: subviews)
    var origin = bounds.origin
    for (index, view) in subviews.enumerated() {
      let size = measured[index]
      view.place(at: origin, anchor: .topLeading, proposal: .init(width: size.width, height: stacked ? size.height : bounds.height))
      if stacked { origin.y += size.height + 10 } else { origin.x += size.width + 10 }
    }
  }
}
