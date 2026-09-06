import SwiftUI
import MeetOddsCore

struct Surface<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View { content.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24, style: .continuous)) }
}
struct PrimaryButton: View {
    let title: String
    var symbol = "mic.fill"
    var disabled = false
    let action: () -> Void
    var body: some View {
        Button(action: action) { Label(title, systemImage: symbol).font(.headline).frame(maxWidth: .infinity).padding(.vertical, 18) }
            .buttonStyle(.borderedProminent).buttonBorderShape(.roundedRectangle(radius: 22)).disabled(disabled)
    }
}
struct ModelPicker: View {
    @Binding var mode: IntelligenceMode
    var body: some View {
        HStack(spacing: 12) {
            choice(.local, title: "On \(Brand.device)", subtitle: "Private · offline", icon: Brand.deviceSymbol)
            choice(.chatGPT, title: "ChatGPT", subtitle: "Via your paired Mac", icon: "sparkles")
        }.sensoryFeedback(.selection, trigger: mode)
    }
    private func choice(_ item: IntelligenceMode, title: String, subtitle: String, icon: String) -> some View {
        Button { mode = item } label: {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Image(systemName: icon).font(.title3); Spacer(); Image(systemName: mode == item ? "checkmark.circle.fill" : "circle").foregroundStyle(mode == item ? Color.indigo : Color.secondary) }
                VStack(alignment: .leading, spacing: 4) { Text(title).font(.headline); Text(subtitle).font(.caption).foregroundStyle(.secondary) }
            }
            .padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(mode == item ? Color.indigo.opacity(0.09) : Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(mode == item ? Color.indigo : Color.clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain).accessibilityLabel("\(title). \(subtitle)").accessibilityAddTraits(mode == item ? .isSelected : [])
        .accessibilityIdentifier(item == .local ? "model-local" : "model-chatgpt")
    }
}
struct Notice: View {
    let text: String
    var body: some View { Label(text, systemImage: "info.circle").font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
}
struct MarkdownView: View {
    let markdown: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(markdown.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                if line.hasPrefix("## ") { Text(String(line.dropFirst(3))).font(.title3.weight(.semibold)).padding(.top, 14) }
                else if line.hasPrefix("# ") { Text(String(line.dropFirst(2))).font(.title2.bold()).padding(.top, 12) }
                else if !line.isEmpty { Text(.init(line)).font(.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            }
        }
    }
}
func templateLabel(_ id: String) -> String {
    ["standard_meeting": "Meeting notes", "daily_standup": "Daily standup", "mayur_product_review": "Product review", "mayur_decision_review": "Decision review", "mayur_pm_one_on_one": "PM one-to-one"][id] ?? "Meeting notes"
}
