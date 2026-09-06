import AVFoundation
import SwiftUI
import MeetOddsCore

struct MeetingDetailView: View {
    @Bindable var model: MeetOddsModel
    let id: UUID
    @State private var tab = "Summary"
    @State private var review = false
    @State private var deletion = false
    @State private var player: AVQueuePlayer?
    @State private var playing = false
    @State private var version: UUID?
    private var summary: SummaryVersion? { model.meeting?.summaries.first { $0.id == version } ?? model.meeting?.summaries.last }
    var body: some View {
        ScrollView {
            if let meeting = model.meeting, meeting.id == id {
                VStack(alignment: .leading, spacing: 22) {
                    TextField("Meeting title", text: Binding(get: { model.meeting?.title ?? "" }, set: model.editTitle), axis: .vertical)
                        .font(.largeTitle.weight(.semibold)).accessibilityIdentifier("meeting-title")
                    Text("\(meeting.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(Meeting.timestamp(meeting.duration)) · On-device transcript").font(.caption).foregroundStyle(.secondary)
                    if let error = model.error { Notice(text: error) }
                    ForEach(Array(meeting.notices.enumerated()), id: \.offset) { _, notice in Notice(text: notice) }
                    if meeting.status == .interrupted || !meeting.notices.isEmpty || meeting.transcript.isEmpty {
                        Button("Rebuild transcript from audio", systemImage: "arrow.clockwise") { model.rebuildTranscript() }.disabled(model.isBusy)
                    }
                    Picker("Meeting content", selection: $tab) { Text("Summary").tag("Summary"); Text("Notes").tag("Notes"); Text("Transcript").tag("Transcript") }.pickerStyle(.segmented)
                    if let progress = model.summaryProgress {
                        Surface { HStack { ProgressView(); Text(progress).font(.subheadline); Spacer(); Button("Cancel") { model.cancelSummary() } } }
                    }
                    if tab == "Summary" {
                        if let summary {
                            HStack {
                                Label(summary.mode == .local ? "On \(Brand.device)" : "ChatGPT", systemImage: "sparkles").font(.caption).foregroundStyle(.secondary)
                                Spacer()
                                Menu("Versions", systemImage: "clock.arrow.circlepath") {
                                    ForEach(meeting.summaries.reversed()) { item in Button(item.createdAt.formatted(date: .omitted, time: .shortened)) { version = item.id } }
                                }.font(.caption)
                            }
                            if summary.includesPersonalNotes { Notice(text: "This summary used selected personal notes. Review it before sharing.") }
                            Surface { MarkdownView(markdown: summary.markdown) }
                            ShareLink(item: summary.markdown, subject: Text(meeting.title)) { Label("Share summary", systemImage: "square.and.arrow.up") }
                            Text("AI summaries can miss context. Check important decisions against the transcript.").font(.caption).foregroundStyle(.secondary)
                        } else {
                            Surface {
                                VStack(alignment: .leading, spacing: 14) {
                                    Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(.indigo)
                                    Text("The useful part, without the noise.").font(.title2.weight(.semibold))
                                    Text("Turn this conversation into a clear recap, decisions and next steps.").foregroundStyle(.secondary)
                                }
                            }
                        }
                        PrimaryButton(title: summary == nil ? "Create summary" : "Create another version", symbol: "sparkles", disabled: model.isBusy || meeting.transcript.isEmpty) { review = true }
                    } else if tab == "Notes" {
                        Surface {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Only for you, unless you choose to include them.").font(.caption).foregroundStyle(.secondary)
                                TextEditor(text: Binding(get: { model.meeting?.notes ?? "" }, set: model.editNotes)).frame(minHeight: 260).scrollContentBackground(.hidden).accessibilityIdentifier("personal-notes")
                                HStack { Text(model.noteSaveState).font(.caption).foregroundStyle(.secondary); Spacer(); Button("Save") { Task { do { try await model.flush() } catch { model.error = error.localizedDescription } } } }
                            }
                        }
                    } else {
                        Button(playing ? "Stop playback" : "Play saved audio", systemImage: playing ? "stop.fill" : "play.fill") {
                            Task {
                                if playing { player?.pause(); playing = false; return }
                                do {
                                    let files = try await model.audioFiles()
                                    guard !files.isEmpty else { throw MeetingError.failed("No saved audio was found.") }
                                    try AVAudioSession.sharedInstance().setCategory(.playback)
                                    try AVAudioSession.sharedInstance().setActive(true)
                                    player = AVQueuePlayer(items: files.map { AVPlayerItem(url: $0) }); player?.play(); playing = true
                                } catch { model.error = error.localizedDescription }
                            }
                        }
                        // Silence needs saying out loud, otherwise an empty tab reads as a
                        // loading state and the recording looks lost.
                        if meeting.transcript.isEmpty {
                            Surface {
                                VStack(alignment: .leading, spacing: 8) {
                                    Label(model.summaryProgress == nil ? "No speech in this recording" : "Building the transcript…", systemImage: model.summaryProgress == nil ? "waveform.slash" : "waveform")
                                        .font(.headline)
                                    Text(model.summaryProgress == nil
                                         ? "The audio is saved. Rebuild the transcript above, or play it back to check what was captured."
                                         : "Reading the saved audio on this \(Brand.device). This can take a moment.")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        LazyVStack(alignment: .leading, spacing: 20) {
                            ForEach(meeting.transcript) { turn in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("\(Meeting.timestamp(turn.start)) · \(turn.id)").font(.caption.monospaced()).foregroundStyle(.secondary)
                                    Text(turn.text).font(.body).textSelection(.enabled)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        ShareLink(item: meeting.summaryInput) { Label("Share transcript", systemImage: "square.and.arrow.up") }.padding(.top, 10)
                    }
                }.padding(24).frame(maxWidth: 720)
            } else { ProgressView("Opening meeting…").padding(40) }
        }
        .frame(maxWidth: .infinity)
        .background(Color(.systemGroupedBackground)).navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(model.summaryProgress != nil)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Delete", systemImage: "trash", role: .destructive) { deletion = true }.disabled(model.isBusy) } }
        .confirmationDialog("Delete this meeting and its recordings?", isPresented: $deletion, titleVisibility: .visible) { Button("Delete permanently", role: .destructive) { Task { await model.remove(id) } } } message: { Text("Audio, transcripts, personal notes and summaries will be deleted from this device.") }
        .sheet(isPresented: $review) { SummaryReview(model: model) }
        .safeAreaInset(edge: .bottom) { if model.justRecorded == id { justRecordedActions } }
        .task(id: id) {
            // Landing on Summary straight after recording shows an empty promise. Open on
            // the transcript instead, where the words either are or are not.
            if model.justRecorded == id { tab = "Transcript" }
            await model.open(id)
        }
        .onDisappear {
            if model.justRecorded == id { model.justRecorded = nil }
            player?.pause(); player = nil; playing = false; Task { try? await model.flush() }
        }
    }

    /// Shown once, on the meeting that recording just produced: read the transcript, then
    /// pick what happens to it. Falls back to a stack when the two labels cannot share a row.
    private var justRecordedActions: some View {
        let notes = Button {
            tab = "Notes"; model.justRecorded = nil
        } label: {
            Label("Add notes", systemImage: "square.and.pencil").frame(maxWidth: .infinity).padding(.vertical, 14)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("finished-add-notes")

        let summarize = Button {
            model.justRecorded = nil; review = true
        } label: {
            Label("Generate summary", systemImage: "sparkles").frame(maxWidth: .infinity).padding(.vertical, 14)
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.isBusy || model.meeting?.transcript.isEmpty != false)
        .accessibilityIdentifier("finished-generate-summary")

        // lineLimit lets ViewThatFits judge honestly: without it a wrapped label counts as
        // fitting, and the row keeps two cramped two-line buttons instead of stacking.
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { notes; summarize }.lineLimit(1)
            VStack(spacing: 10) { summarize; notes }
        }
        .font(.headline)
        .buttonBorderShape(.roundedRectangle(radius: 18))
        .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 10)
        .frame(maxWidth: 720)
        .background(.regularMaterial)
    }
}

struct SummaryReview: View {
    @Bindable var model: MeetOddsModel
    @Environment(\.dismiss) private var dismiss
    @State private var includeNotes = false
    @State private var consent = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Intelligence") { ModelPicker(mode: $model.mode).listRowBackground(Color.clear).listRowInsets(EdgeInsets()) }
                Section("Structure") {
                    Picker("Template", selection: $model.templateID) { ForEach(model.templates) { Text(templateLabel($0.id)).tag($0.id) } }
                }
                Section {
                    Toggle("Include my personal notes", isOn: $includeNotes)
                    DisclosureGroup("Review selected input") {
                        Text(model.meeting?.summaryInput ?? "").font(.caption).textSelection(.enabled)
                        if includeNotes { Text("Personal observations (not recorded speech)").font(.caption.bold()); Text(model.meeting?.notes ?? "").font(.caption) }
                    }
                } header: { Text("Input") } footer: { Text("Original notes and previous summary versions are never replaced.") }
                if model.mode == .chatGPT {
                    Section {
                        Text("Selected transcript and notes will go to your paired Mac, then OpenAI using that Mac’s ChatGPT/Codex session. Audio is not sent.").font(.subheadline)
                        Text(model.pairing?.url.host ?? "No Mac paired. Open Settings to pair.").font(.caption).foregroundStyle(.secondary)
                        Toggle("I approve sending this text", isOn: $consent)
                    } header: { Text("Before anything leaves your \(Brand.device)") } footer: { Text("Your account’s Codex allowance and data policies apply. No API-key fallback.") }
                } else if let reason = model.localAvailability { Section { Notice(text: reason) } }
                Section {
                    Button(model.mode == .local ? "Generate on \(Brand.device)" : "Send selected text & summarize") {
                        model.summarize(includeNotes: includeNotes); dismiss()
                    }
                    .disabled(model.isBusy || (model.mode == .chatGPT && (!consent || model.pairing == nil)) || (model.mode == .local && model.localAvailability != nil))
                }
            }
            .navigationTitle("Make it useful").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onChange(of: model.mode) { _, _ in consent = false }
        }.presentationDetents([.large])
    }
}
