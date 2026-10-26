import SwiftUI

struct SheetHeader: View {
  let title: String
  let subtitle: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(Typography.sheetTitle).foregroundStyle(Palette.fg)
        Text(subtitle).font(Typography.meta).foregroundStyle(Palette.dim2).lineLimit(1)
      }
      Spacer(minLength: 0)
      Button { dismiss() } label: {
        Image(systemName: "xmark").font(.body)
          .foregroundStyle(Palette.dim).frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain).accessibilityLabel(SheetCopy.close).accessibilityIdentifier("sheet-close")
    }
    .frame(minHeight: 60).padding(.horizontal, 16)
  }
}
