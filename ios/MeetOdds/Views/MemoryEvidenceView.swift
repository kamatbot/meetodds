import SwiftUI
import MeetOddsCore

struct MemoryCitationSelection: Identifiable {
    let id = UUID()
    let evidence: MemoryEvidence
}

struct MemoryEvidenceView: View {
    let evidence: MemoryEvidence
    let controller: MeetingMemoryController
    let openMeeting: (MemoryEvidence) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var source: MemoryMeeting?
    @State private var error: String?
    @State private var player = MeetingEvidencePlayer()
    private var current: Bool { source.map { evidence.isCurrent(in: $0.transcript) } ?? false }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(source?.title ?? "Meeting source").font(.title2.bold())
                    Label("\(Meeting.timestamp(evidence.start))–\(Meeting.timestamp(evidence.end))", systemImage: "waveform").font(.caption.monospaced())
                    if let error { Notice(text: error) }
                    if source != nil && !current { Notice(text: "The transcript changed. This is the original evidence snapshot, not the current transcript. Timestamp playback is disabled.") }
                    Text(evidence.quote).font(.title3).textSelection(.enabled)
                    DisclosureGroup("Full original turn") { Text(evidence.originalText).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    if source != nil {
                        Button(player.playing ? "Stop excerpt" : "Play cited audio", systemImage: player.playing ? "stop.fill" : "play.fill") {
                            if player.playing { player.stop() }
                            else { Task { await player.play(evidence, library: controller.library) } }
                        }.buttonStyle(.borderedProminent).disabled(!current || player.loading || controller.suspended)
                        if player.loading { ProgressView("Locating audio…") }
                        if let error = player.error { Notice(text: error) }
                        Button("Open meeting transcript", systemImage: "text.alignleft") { player.stop(); dismiss(); openMeeting(evidence) }
                            .disabled(controller.suspended || !current)
                    }
                    Text("A matching quote verifies the source location—not that an AI interpretation is correct.").font(.caption).foregroundStyle(.secondary)
                }.padding(24)
            }
            .navigationTitle("Evidence").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { player.stop(); dismiss() } } }
        }
        .task(id: evidence) {
            do { let loaded = try await controller.library.memoryMeeting(evidence.meetingID); try Task.checkCancellation(); source = loaded }
            catch is CancellationError { }
            catch { self.error = "This meeting is unavailable. It may have been deleted. No source was substituted." }
        }
        .onChange(of: controller.suspended) { _, suspended in if suspended { player.stop(deactivateSession: false) } }
        .onDisappear { player.stop(deactivateSession: !controller.suspended) }
    }
}

struct MemoryFactEditor: View {
    let controller: MeetingMemoryController
    let revision: Int
    @State var draft: MemoryFact
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("\(draft.kind.label) · review against the source") {
                    TextField("Description", text: $draft.text, axis: .vertical).lineLimit(2...8)
                    Picker("Review", selection: $draft.review) {
                        Text("Needs review").tag(MemoryReview.pending)
                        Text("Confirmed by me").tag(MemoryReview.confirmed)
                        Text("Dismissed").tag(MemoryReview.dismissed)
                    }
                }
                if draft.kind == .action {
                    Section("Commitment") {
                        Picker("What was said", selection: $draft.commitment) {
                            Text("Proposed").tag(MemoryCommitment.proposed)
                            Text("Agreed").tag(MemoryCommitment.agreed)
                        }
                        TextField("Owner · leave empty if unknown", text: $draft.owner)
                        TextField("Due date · YYYY-MM-DD or empty", text: Binding(get: { draft.dueDate ?? "" }, set: { draft.dueDate = $0.isEmpty ? nil : $0 }))
                            .keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Text("Choose an explicit calendar date. Relative phrases such as ‘Friday’ are not automatically resolved.").font(.caption).foregroundStyle(.secondary)
                        Toggle("Completed", isOn: $draft.completed).disabled(draft.review != .confirmed || draft.commitment != .agreed)
                    }
                } else if draft.kind == .question {
                    Section { Toggle("Resolved", isOn: $draft.completed).disabled(draft.review != .confirmed) }
                }
                Section("Original evidence · \(Meeting.timestamp(draft.evidence.start))") {
                    Text(draft.evidence.quote).textSelection(.enabled)
                    Text("Confirm only what the source supports. Editing this item does not change the transcript.").font(.caption).foregroundStyle(.secondary)
                }
                if let error { Section { Notice(text: error) } }
            }
            .disabled(saving)
            .navigationTitle(draft.kind == .action ? "Review action" : "Review \(draft.kind.label.lowercased())")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") {
                        saving = true; error = nil
                        Task {
                            do {
                                draft.owner = draft.owner.trimmingCharacters(in: .whitespacesAndNewlines)
                                if draft.review != .confirmed || (draft.kind == .action && draft.commitment != .agreed) { draft.completed = false }
                                try await controller.save(draft, revision: revision); dismiss()
                            } catch { self.error = error.localizedDescription }
                            saving = false
                        }
                    }.disabled(saving || controller.isBusy || controller.suspended)
                }
            }
        }.interactiveDismissDisabled(saving)
    }
}

struct MemoryContextEditor: View {
    let controller: MeetingMemoryController
    let meeting: MemoryMeeting
    @State private var context = MemoryContext()
    @State private var saving = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("Recall boundaries") {
                    TextField("Client · optional", text: $context.client)
                    TextField("Project · optional", text: $context.project)
                    Text("A project belongs to its client. Changing these labels changes which scoped searches include this meeting. Nothing is uploaded.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error { Notice(text: error) }
            }.disabled(saving)
            .navigationTitle("Meeting context").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        Task {
                            do { try await controller.saveContext(context, meetingID: meeting.id, revision: meeting.memory.revision); dismiss() }
                            catch { self.error = error.localizedDescription }
                            saving = false
                        }
                    }.disabled(saving || controller.isBusy || controller.suspended)
                }
            }
        }.task { context = meeting.memory.context }.interactiveDismissDisabled(saving)
    }
}
