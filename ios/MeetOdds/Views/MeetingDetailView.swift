import AVFoundation
import SwiftUI
import MeetOddsCore

struct MeetingDetailView: View {
    @Bindable var model: MeetOddsModel
    let id: UUID
    @State private var tab = "Outcomes"
    @State private var showingMemory = false
    @State private var citation: MemoryCitationSelection?
    @State private var editingMemoryFact: MemoryFactSelection?
    @State private var review = false
    @State private var deletion = false
    @State private var player: AVQueuePlayer?
    @State private var playing = false
    @State private var version: UUID?
    private var summary: SummaryVersion? { model.meeting?.summaries.first { $0.id == version } ?? model.meeting?.summaries.last }
    var body: some View {
        ScrollViewReader { scroll in
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
                    if let progress = model.summaryProgress {
                        Surface { HStack { ProgressView(); Text(progress).font(.subheadline); Spacer(); Button("Cancel") { model.cancelSummary() } } }
                    }
                    if tab == "Outcomes", let controller = model.memory {
                        MeetingOutcomesView(controller: controller, meetingID: id, openMeeting: openEvidence)
                    } else if tab == "Summary" {
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
                        PrimaryButton(title: summary == nil ? "Create summary" : "Create another version", symbol: "sparkles", disabled: model.isBusy || model.memory?.isBusy == true || meeting.transcript.isEmpty) { review = true }
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
                                    if let controller = model.memory {
                                        HStack {
                                            Button("Play source", systemImage: "play.circle") {
                                                player?.pause(); player = nil; playing = false
                                                do { citation = MemoryCitationSelection(evidence: try MemoryEvidence(meetingID: id, turn: turn, quote: turn.text)) }
                                                catch { model.error = error.localizedDescription }
                                            }.disabled(model.isBusy)
                                            Menu("Save to Memory", systemImage: "bookmark") {
                                                ForEach(MemoryFactKind.allCases, id: \.self) { kind in
                                                    Button(kind.label) {
                                                        Task {
                                                            do {
                                                                let record = try await controller.library.memoryRecord(id)
                                                                let evidence = try MemoryEvidence(meetingID: id, turn: turn, quote: turn.text)
                                                                editingMemoryFact = MemoryFactSelection(fact: MemoryFact(kind: kind, text: turn.text, evidence: evidence), revision: record.revision)
                                                            } catch { model.error = error.localizedDescription }
                                                        }
                                                    }
                                                }
                                            }.disabled(model.isBusy || controller.isBusy)
                                        }.font(.caption)
                                    }
                                }
                                .padding(10)
                                .background(model.memoryFocus?.meetingID == id && model.memoryFocus?.turnID == turn.id ? Color.indigo.opacity(0.09) : Color.clear, in: RoundedRectangle(cornerRadius: 12))
                                .frame(maxWidth: .infinity, alignment: .leading).id(turn.id)
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
        .sheet(isPresented: $showingMemory) {
            if let controller = model.memory {
                MeetingMemoryView(controller: controller, meetingID: id) { evidence in showingMemory = false; openEvidence(evidence) }
            }
        }
        .sheet(item: $citation) { item in
            if let controller = model.memory { MemoryEvidenceView(evidence: item.evidence, controller: controller, openMeeting: openEvidence) }
        }
        .sheet(item: $editingMemoryFact) { item in
            if let controller = model.memory { MemoryFactEditor(controller: controller, revision: item.revision, draft: item.fact) }
        }
        .safeAreaInset(edge: .bottom) { actions }
        .task(id: id) {
            // Landing on Summary straight after recording shows an empty promise. Open on
            // the transcript instead, where the words either are or are not.
            if model.justRecorded == id { tab = "Transcript" }
            await model.open(id)
            if let focus = model.memoryFocus, focus.meetingID == id {
                tab = "Transcript"
                DispatchQueue.main.async { scroll.scrollTo(focus.turnID, anchor: .center) }
            }
        }
        .onChange(of: model.memoryFocus) { _, focus in
            guard let focus, focus.meetingID == id else { return }
            tab = "Transcript"
            DispatchQueue.main.async { scroll.scrollTo(focus.turnID, anchor: .center) }
        }
        // Deliberately not cleared here: navigation can build and discard a transient
        // instance, and clearing on its disappearance stole the flag from the real one.
        .onDisappear { player?.pause(); player = nil; playing = false; model.memory?.cancel(); Task { try? await model.flush() } }
        }
    }
    private func openEvidence(_ evidence: MemoryEvidence) {
        player?.pause(); player = nil; playing = false
        model.memoryFocus = evidence
        if evidence.meetingID == id { tab = "Transcript" } else { model.path = [evidence.meetingID] }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            Picker("Meeting section", selection: $tab) {
                Text("Outcomes").tag("Outcomes")
                Text("Summary").tag("Summary")
                Text("Transcript").tag("Transcript")
            }.pickerStyle(.segmented).accessibilityIdentifier("meeting-sections")
            Button("Ask this meeting", systemImage: "brain.head.profile") {
                player?.pause(); player = nil; playing = false; showingMemory = true
            }.disabled(model.isBusy || model.memory == nil)
        }
        .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 10)
        .frame(maxWidth: 720).background(.regularMaterial)
    }
}

struct SummaryReview: View {
    @Bindable var model: MeetOddsModel
    @Environment(\.dismiss) private var dismiss
    @State private var consent = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Intelligence") { ModelPicker(mode: $model.mode).listRowBackground(Color.clear).listRowInsets(EdgeInsets()) }
                Section("Structure") {
                    Picker("Template", selection: $model.templateID) { ForEach(model.templates) { Text(templateLabel($0.id)).tag($0.id) } }
                }
                Section {
                    DisclosureGroup("Review transcript input") {
                        Text(model.meeting?.summaryInput ?? "").font(.caption).textSelection(.enabled)
                    }
                } header: { Text("Input") } footer: { Text("Only the finalized transcript is used. Previous summary versions and legacy stored data are preserved.") }
                if model.mode == .chatGPT {
                    Section {
                        Text("The selected transcript will go to your paired Mac, then OpenAI using that Mac’s ChatGPT/Codex session. Audio and legacy personal notes are not sent.").font(.subheadline)
                        Text(model.pairing?.url.host ?? "No Mac paired. Open Settings to pair.").font(.caption).foregroundStyle(.secondary)
                        Toggle("I approve sending this text", isOn: $consent)
                    } header: { Text("Before anything leaves your \(Brand.device)") } footer: { Text("Your account’s Codex allowance and data policies apply. No API-key fallback.") }
                } else if let reason = model.localAvailability { Section { Notice(text: reason) } }
                Section {
                    Button(model.mode == .local ? "Generate on \(Brand.device)" : "Send selected text & summarize") {
                        model.summarize(includeNotes: false); dismiss()
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
