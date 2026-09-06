import SwiftUI
import MeetOddsCore

struct HomeView: View {
    @Bindable var model: MeetOddsModel
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// Consent is about the people in the room, not about this tap. Asking once and
    /// remembering it keeps the promise visible without gating every single meeting.
    @AppStorage("recordingConsentAcknowledged") private var consentAcknowledged = false
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
            .navigationTitle("Your meetings")
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

    /// Shown only when no meeting is selected, so it stays a quiet welcome rather than
    /// a second control panel competing with the sidebar.
    private var hub: some View {
        VStack(spacing: 14) {
            BrandMark()
            Text("Be here. We’ll take notes.")
                .font(.system(size: 26, weight: .semibold, design: .rounded))
                .accessibilityIdentifier("home-headline")
            Text(model.headers.isEmpty ? "Press record when your meeting starts." : "Pick a meeting, or record a new one.")
                .font(.body).foregroundStyle(.secondary)
            if let error = model.error { Notice(text: error).padding(.top, 8) }
        }
        .multilineTextAlignment(.center)
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    // MARK: Compact width (iPhone, Split View, Slide Over): the library, then the button.

    private var stack: some View {
        NavigationStack(path: $model.path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Your meetings")
                            .font(.system(size: 30, weight: .semibold, design: .rounded)).tracking(-0.5)
                            .accessibilityIdentifier("home-headline")
                        Spacer()
                        if !model.headers.isEmpty {
                            Text("\(model.headers.count)").font(.headline).foregroundStyle(.secondary).monospacedDigit()
                        }
                    }.padding(.top, 8)
                    if let error = model.error { Notice(text: error) }
                    if model.headers.isEmpty {
                        emptyCard.padding(.top, 4)
                    } else {
                        if model.headers.count > 4 {
                            TextField("Find a meeting", text: $search).textFieldStyle(.roundedBorder).accessibilityLabel("Find a meeting")
                        }
                        LazyVStack(spacing: 10) {
                            ForEach(filtered) { meeting in
                                NavigationLink(value: meeting.id) {
                                    meetingRow(meeting).padding(16).background(.background, in: RoundedRectangle(cornerRadius: 20))
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }.padding(.horizontal, 20).padding(.bottom, 8).frame(maxWidth: 720)
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

    /// The template sits above the button, in reading order: choose the shape of the
    /// meeting, then start it. The summary model is a standing preference and lives in
    /// Settings rather than in front of every recording.
    private var recordFooter: some View {
        VStack(spacing: 10) {
            Button { templates = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "doc.text").font(.body).foregroundStyle(.indigo)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(templateLabel(model.templateID)).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                        Text("Meeting template").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(.background, in: RoundedRectangle(cornerRadius: 16))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("choose-template")
            .accessibilityLabel("Meeting template: \(templateLabel(model.templateID))")
            .accessibilityHint("Choose how the next meeting is structured")

            PrimaryButton(title: model.phase == .preparing ? "Preparing…" : "Start recording", disabled: model.isBusy) {
                if consentAcknowledged { Task { await start() } } else { consent = true }
            }
            .accessibilityIdentifier("start-recording")
            .confirmationDialog("Ready to record?", isPresented: $consent, titleVisibility: .visible) {
                Button("Everyone is informed · Start") { consentAcknowledged = true; Task { await start() } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Record only with participants’ permission. MeetOdds captures the microphone, not another app’s call audio. Audio is kept on this device for recovery. You will not be asked again.") }
        }.padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 10).frame(maxWidth: 720).background(.regularMaterial)
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
            .fullScreenCover(isPresented: $templates) { TemplatePicker(model: model) }
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
                    // One name and one short line. The full prose description and the
                    // eight-item section list turned this into a wall of text.
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(templateLabel(template.id)).font(.headline)
                            Text("\(template.sections.count) sections · \(template.sections.prefix(3).map(\.title).joined(separator: ", "))")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if model.templateID == template.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(.indigo) }
                    }.padding(.vertical, 6)
                }.buttonStyle(.plain)
            }
            .navigationTitle("Choose a template").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
