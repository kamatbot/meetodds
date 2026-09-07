import SwiftUI
import MeetOddsCore

struct MemoryFactSelection: Identifiable {
    var id: UUID { fact.id }
    let fact: MemoryFact
    let revision: Int
}

struct MeetingOutcomesView: View {
    let controller: MeetingMemoryController
    let meetingID: UUID
    let openMeeting: (MemoryEvidence) -> Void
    @State private var selectedFact: MemoryFactSelection?
    @State private var citation: MemoryCitationSelection?
    @State private var context = false
    @State private var draft: String?
    private var source: MemoryMeeting? { controller.catalog.meetings.first { $0.id == meetingID } }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("What changed?").font(.title2.bold())
                Spacer()
                if source != nil { Button("Context", systemImage: "folder") { context = true }.disabled(controller.isBusy || controller.suspended) }
            }
            Text("Review outcomes, decisions, commitments and open questions. Original summaries and transcript are unchanged.").foregroundStyle(.secondary)
            if let source {
                if !source.memory.context.client.isEmpty || !source.memory.context.project.isEmpty {
                    Label([source.memory.context.client, source.memory.context.project].filter { !$0.isEmpty }.joined(separator: " / "), systemImage: "folder").font(.caption)
                }
                Button("Find outcomes on this device", systemImage: "sparkles") { controller.extract(meetingID: meetingID) }
                    .buttonStyle(.borderedProminent).disabled(controller.isBusy || controller.suspended || source.incomplete || source.transcript.isEmpty || LocalSummary.availabilityMessage != nil)
                if let reason = LocalSummary.availabilityMessage { Text("\(reason) You can still save a transcript turn as a decision, action or question.").font(.caption).foregroundStyle(.secondary) }
                if source.incomplete { Notice(text: "This transcript is incomplete. Repair it before extracting outcomes.") }
                ForEach(MemoryFactKind.allCases, id: \.self) { kind in
                    let facts = source.memory.facts.filter { $0.kind == kind && $0.review != .dismissed }
                    VStack(alignment: .leading, spacing: 12) {
                        Text(kind.label).font(.headline)
                        if facts.isEmpty { Text("No \(kind.label.lowercased()) reviewed yet.").font(.subheadline).foregroundStyle(.secondary) }
                        ForEach(facts) { fact in
                            Surface {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(fact.text).textSelection(.enabled)
                                    Text(fact.review == .confirmed ? "Confirmed by you" : "Candidate · needs your review").font(.caption).foregroundStyle(.secondary)
                                    if !fact.evidence.isCurrent(in: source.transcript) { Notice(text: "Source changed · excluded from preparation until reviewed with current evidence.") }
                                    if kind == .action {
                                        Text("\(fact.owner.isEmpty ? "Unassigned" : fact.owner) · \(fact.dueDate ?? "No due date") · \(fact.completed ? "Completed" : fact.commitment.rawValue)").font(.caption)
                                    }
                                    HStack {
                                        Button("\(Meeting.timestamp(fact.evidence.start)) · Evidence", systemImage: "text.quote") { citation = MemoryCitationSelection(evidence: fact.evidence) }
                                        Spacer()
                                        Button("Review") { selectedFact = MemoryFactSelection(fact: fact, revision: source.memory.revision) }
                                    }.font(.subheadline)
                                }
                            }
                        }
                    }
                }
                let dismissed = source.memory.facts.filter { $0.review == .dismissed }
                if !dismissed.isEmpty {
                    DisclosureGroup("Dismissed items (\(dismissed.count))") {
                        ForEach(dismissed) { fact in Button(fact.text) { selectedFact = MemoryFactSelection(fact: fact, revision: source.memory.revision) }.padding(.vertical, 6) }
                    }
                }
                Button("Create follow-up draft", systemImage: "doc.text") { draft = MemoryRules.followUp(source) }
                if let draft {
                    Surface { VStack(alignment: .leading, spacing: 12) { Text(draft).textSelection(.enabled); ShareLink(item: draft) { Label("Share reviewed draft…", systemImage: "square.and.arrow.up") } } }
                }
            } else if !controller.isBusy {
                Text("Memory could not be loaded for this meeting.").foregroundStyle(.secondary)
                Button("Reload") { controller.load(meetingID: meetingID) }
            }
            if let progress = controller.progress { HStack { ProgressView(); Text(progress).font(.subheadline); Button("Cancel") { controller.cancel() } } }
            if let error = controller.error { Notice(text: error) }
        }
        .task(id: meetingID) { controller.load(meetingID: meetingID) }
        .sheet(item: $selectedFact) { item in MemoryFactEditor(controller: controller, revision: item.revision, draft: item.fact) }
        .sheet(item: $citation) { item in MemoryEvidenceView(evidence: item.evidence, controller: controller, openMeeting: openMeeting) }
        .sheet(isPresented: $context) { if let source { MemoryContextEditor(controller: controller, meeting: source) } }
        .onChange(of: source?.memory.revision) { _, _ in draft = nil }
    }
}
