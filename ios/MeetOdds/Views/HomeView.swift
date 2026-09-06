import SwiftUI
import MeetOddsCore

struct HomeView: View {
    @Bindable var model: MeetOddsModel
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var settings = false
    @State private var templates = false
    @State private var consent = false
    @State private var search = ""
    @State private var columns = NavigationSplitViewVisibility.all
    private var filtered: [MeetingHeader] { model.headers.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) } }
    /// The split view selects by id; the compact stack pushes the same id, so both read `model.path`.
    private var selection: Binding<UUID?> { Binding(get: { model.path.last }, set: { model.path = $0.map { [$0] } ?? [] }) }

    var body: some View {
        if sizeClass == .regular { split } else { stack }
    }

    // MARK: Regular width (iPad, Stage Manager): library beside the selected meeting.

    private var split: some View {
        NavigationSplitView(columnVisibility: $columns) {
            List(selection: selection) {
                if model.headers.isEmpty { emptyCard.listRowBackground(Color.clear).listRowInsets(EdgeInsets()) }
                ForEach(filtered) { meeting in meetingRow(meeting, chevron: false).padding(.vertical, 6).tag(meeting.id) }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a meeting")
            .navigationTitle("MeetOdds")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { settingsButton } }
            .safeAreaInset(edge: .bottom) { recordFooter }
            .navigationSplitViewColumnWidth(min: 320, ideal: 380, max: 460)
        } detail: {
            if let id = model.path.last { MeetingDetailView(model: model, id: id).id(id) } else { hub }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $model.showRecording) { RecordingView(model: model).presentationSizing(.page) }
        .modifier(Presentations(model: model, settings: $settings, templates: $templates))
    }

    private var hub: some View {
        let content = VStack(alignment: .leading, spacing: 26) {
            headline
            modelSection
            templateButton
            if let error = model.error { Notice(text: error) }
        }.padding(40).frame(maxWidth: 640).frame(maxWidth: .infinity, maxHeight: .infinity)
        return ViewThatFits(in: .vertical) { content; ScrollView { content } }
            .background(Color(.systemGroupedBackground))
    }

    // MARK: Compact width (iPhone, Split View, Slide Over): one scrolling column.

    private var stack: some View {
        NavigationStack(path: $model.path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    headline
                    modelSection
                    templateButton
                    if let error = model.error { Notice(text: error) }
                    if !model.headers.isEmpty {
                        HStack { Text("Your meetings").font(.title2.bold()); Spacer(); Text("\(model.headers.count)").foregroundStyle(.secondary).monospacedDigit() }
                        TextField("Find a meeting", text: $search).textFieldStyle(.roundedBorder).accessibilityLabel("Find a meeting")
                        LazyVStack(spacing: 10) {
                            ForEach(filtered) { meeting in
                                NavigationLink(value: meeting.id) {
                                    meetingRow(meeting).padding(18).background(.background, in: RoundedRectangle(cornerRadius: 20))
                                }.buttonStyle(.plain)
                            }
                        }
                    } else { emptyCard }
                }.padding(24).frame(maxWidth: 720)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("MeetOdds").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { settingsButton } }
            .safeAreaInset(edge: .bottom) { recordFooter }
            .navigationDestination(for: UUID.self) { id in MeetingDetailView(model: model, id: id) }
            .modifier(Presentations(model: model, settings: $settings, templates: $templates))
        }
        .fullScreenCover(isPresented: $model.showRecording) { RecordingView(model: model) }
    }

    // MARK: Shared pieces

    /// The sidebar can start a recording while another meeting is selected; keep the detail column on the new one.
    /// The compact stack records from its root, where `path` is already empty, so it is left alone.
    private func start() async {
        await model.start()
        if sizeClass == .regular, let id = model.meeting?.id { model.path = [id] }
    }

    private var headline: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Be here.\nWe’ll take notes.").font(.system(size: 36, weight: .semibold, design: .rounded)).tracking(-1).accessibilityIdentifier("home-headline")
            Text("A little less typing. A lot more listening.").font(.body).foregroundStyle(.secondary)
        }.padding(.top, 18)
    }
    private var modelSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("YOUR SUMMARY MODEL").font(.caption.weight(.semibold)).tracking(1.2).foregroundStyle(.secondary)
            ModelPicker(mode: $model.mode)
            if model.mode == .chatGPT && model.pairing == nil {
                Button { settings = true } label: { Label("Pair your Mac for ChatGPT summaries", systemImage: "link") }.font(.subheadline)
            }
        }
    }
    private var templateButton: some View {
        Button { templates = true } label: {
            HStack(spacing: 12) {
                Image(systemName: "doc.text").font(.title3).foregroundStyle(.indigo)
                VStack(alignment: .leading, spacing: 3) { Text(templateLabel(model.templateID)).font(.headline); Text("Your meeting, your structure").font(.caption).foregroundStyle(.secondary) }
                Spacer(); Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }.padding(18).background(.background, in: RoundedRectangle(cornerRadius: 20))
        }.buttonStyle(.plain).accessibilityIdentifier("choose-template")
    }
    private func meetingRow(_ meeting: MeetingHeader, chevron: Bool = true) -> some View {
        HStack(spacing: 14) {
            Image(systemName: meeting.status == .interrupted ? "arrow.clockwise.circle" : meeting.hasSummary ? "doc.text" : "waveform").font(.title2).foregroundStyle(.indigo).frame(width: 36)
            VStack(alignment: .leading, spacing: 5) {
                Text(meeting.title).font(.headline).lineLimit(2)
                Text("\(meeting.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(Meeting.timestamp(meeting.duration))").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(); if chevron { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
        }
    }
    private var emptyCard: some View {
        Surface { VStack(alignment: .leading, spacing: 8) { Label("Just press record", systemImage: "waveform").font(.headline); Text("Your recordings, transcripts and summaries stay together here.").foregroundStyle(.secondary) } }
    }
    private var settingsButton: some View {
        Button("Settings", systemImage: "slider.horizontal.3") { settings = true }.accessibilityIdentifier("settings")
    }
    private var recordFooter: some View {
        VStack(spacing: 10) {
            PrimaryButton(title: model.phase == .preparing ? "Preparing…" : "Start recording", disabled: model.isBusy) { consent = true }.accessibilityIdentifier("start-recording")
                .confirmationDialog("Ready to record?", isPresented: $consent, titleVisibility: .visible) {
                    Button("Everyone is informed · Start") { Task { await start() } }
                    Button("Cancel", role: .cancel) {}
                } message: { Text("Record only with participants’ permission. MeetOdds captures the microphone, not another app’s call audio. Audio is kept on this device for recovery.") }
            Text("Microphone capture · Always transcribed on device").font(.caption).foregroundStyle(.secondary)
        }.padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 12).frame(maxWidth: 720).background(.regularMaterial)
    }
}

/// Sheets shared by both layouts.
private struct Presentations: ViewModifier {
    @Bindable var model: MeetOddsModel
    @Binding var settings: Bool
    @Binding var templates: Bool
    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $settings) { SettingsView(model: model) }
            .sheet(isPresented: $templates) { TemplatePicker(model: model) }
    }
}

struct TemplatePicker: View {
    @Bindable var model: MeetOddsModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List(model.templates) { template in
                Button {
                    model.templateID = template.id; dismiss()
                } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text(templateLabel(template.id)).font(.headline); Spacer(); if model.templateID == template.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(.indigo) } }
                        Text(template.description).font(.subheadline).foregroundStyle(.secondary)
                        Text(template.sections.map(\.title).joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 8)
                }.buttonStyle(.plain)
            }
            .navigationTitle("Choose a template").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}
