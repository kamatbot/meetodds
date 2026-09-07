import SwiftUI
import MeetOddsCore

struct MeetingMemoryView: View {
    let controller: MeetingMemoryController
    let meetingID: UUID?
    let openMeeting: (MemoryEvidence) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var section = "Ask"
    @State private var scope: MemoryScope = .all
    @State private var query = ""
    @State private var selected = Set<String>()
    @State private var citation: MemoryCitationSelection?
    @State private var editing: MemoryFactSelection?
    @State private var actionFilter = "Review"
    @State private var preparationDate = Date()
    init(controller: MeetingMemoryController, meetingID: UUID?, openMeeting: @escaping (MemoryEvidence) -> Void) {
        self.controller = controller; self.meetingID = meetingID; self.openMeeting = openMeeting
        _scope = State(initialValue: meetingID.map(MemoryScope.meeting) ?? .all)
    }
    private var scopes: [MemoryScope] {
        var values: [MemoryScope] = (meetingID.map { [.meeting($0)] } ?? []) + controller.catalog.scopes + [.all]
        if !values.contains(scope) { values.insert(scope, at: 0) }
        return values
    }
    private var prepMeetings: [MemoryMeeting] { controller.scopedMeetings(scope).filter { $0.createdAt < preparationDate && !$0.incomplete } }
    private var actions: [MemoryActionRow] {
        controller.actions(scope).filter { row in
            switch actionFilter {
            case "Open": return row.fact.review == .confirmed && !row.fact.completed
            case "Done": return row.fact.review == .confirmed && row.fact.completed
            case "Dismissed": return row.fact.review == .dismissed
            default: return row.fact.review == .pending || (row.stale && row.fact.review != .dismissed)
            }
        }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Picker("Memory section", selection: $section) { Text("Ask").tag("Ask"); Text("Actions").tag("Actions"); Text("Prepare").tag("Prepare") }
                        .pickerStyle(.segmented)
                    Picker("Search scope", selection: $scope) { ForEach(scopes) { item in Text(item.label).tag(item) } }
                        .pickerStyle(.menu).accessibilityIdentifier("memory-scope")
                    Label("On this device · transcript evidence only", systemImage: "lock.shield").font(.caption).foregroundStyle(.secondary)
                    if controller.suspended { Notice(text: "Recording has priority. Memory is paused until recording finishes.") }
                    if section == "Ask" { recall }
                    else if section == "Actions" { actionInbox }
                    else { preparation }
                    if let error = controller.error { Notice(text: error) }
                    if let progress = controller.progress {
                        HStack { ProgressView(); Text(progress).font(.subheadline); Spacer(); Button("Cancel") { controller.cancel() } }
                            .accessibilityElement(children: .combine)
                    }
                    if controller.catalog.unavailable > 0 {
                        Notice(text: "\(controller.catalog.unavailable) meeting files could not be read. Results may be incomplete. No files were replaced.")
                    }
                }.padding(24).frame(maxWidth: 760)
            }
            .frame(maxWidth: .infinity).background(Color(.systemGroupedBackground))
            .navigationTitle("Meeting Memory").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { controller.cancel(); dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { Button("Refresh", systemImage: "arrow.clockwise") { controller.clearSearch(); selected = []; controller.load(meetingID: meetingID) }.disabled(controller.isBusy || controller.suspended) }
            }
        }
        .task { controller.load(meetingID: meetingID) }
        .onChange(of: scope) { _, _ in controller.clearSearch(); selected = [] }
        .onChange(of: query) { _, _ in controller.clearSearch(); selected = [] }
        .sheet(item: $citation) { item in
            MemoryEvidenceView(evidence: item.evidence, controller: controller) { evidence in
                citation = nil; controller.cancel(); dismiss(); openMeeting(evidence)
            }
        }
        .sheet(item: $editing) { item in MemoryFactEditor(controller: controller, revision: item.revision, draft: item.fact) }
        .onDisappear { controller.cancel() }
    }
    private var recall: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What did we discuss?").font(.title2.bold())
            TextField("Ask about a decision, topic or commitment", text: $query, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(1...4).submitLabel(.search)
                .accessibilityIdentifier("memory-question")
                .onSubmit { search() }
            Button("Find evidence", systemImage: "magnifyingglass") { search() }
                .buttonStyle(.borderedProminent).disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || controller.isBusy || controller.suspended)
            if let result = controller.searchResult {
                Text("\(result.searchedMeetings) meetings · \(result.totalPassages) transcript passages searched").font(.caption).foregroundStyle(.secondary)
                Text(result.semanticPassages > 0 ? "Local semantic + lexical ranking (\(result.semanticPassages) passages eligible for embeddings)." : "Lexical search only. On-device sentence embeddings were unavailable for these sources or languages.")
                    .font(.caption).foregroundStyle(.secondary)
                if result.unavailableMeetings > 0 { Notice(text: "\(result.unavailableMeetings) unreadable meetings were excluded from this search.") }
                if result.hits.isEmpty {
                    Surface { Text("No matching evidence found in this scope. That does not prove the topic was never discussed.").foregroundStyle(.secondary) }
                } else {
                    Text("Select up to six passages for an optional on-device answer. Only those passages will be used.").font(.subheadline).foregroundStyle(.secondary)
                    ForEach(result.hits) { hit in
                        Surface {
                            VStack(alignment: .leading, spacing: 10) {
                                Toggle(isOn: Binding(get: { selected.contains(hit.id) }, set: { use in
                                    if use && selected.count < 6 { selected.insert(hit.id) } else { selected.remove(hit.id) }
                                    controller.answer = nil
                                })) { Text(hit.passage.title).font(.headline) }
                                    .disabled(controller.isBusy || (!selected.contains(hit.id) && selected.count >= 6))
                                Text(hit.passage.date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                                Text(hit.passage.evidence.originalText).lineLimit(6).textSelection(.enabled)
                                if hit.passage.incomplete { Text("Incomplete recording · this is only the saved transcript").font(.caption).foregroundStyle(.orange) }
                                Button("\(Meeting.timestamp(hit.passage.evidence.start)) · View source", systemImage: "text.quote") { citation = MemoryCitationSelection(evidence: hit.passage.evidence) }
                            }
                        }
                    }
                    if result.hits.count == 30 { Text("Showing the 30 highest-ranked passages. Narrow your query to find more specific evidence.").font(.caption).foregroundStyle(.secondary) }
                    Button("Answer from \(selected.count) selected sources", systemImage: "sparkles") {
                        controller.generateAnswer(hits: result.hits.filter { selected.contains($0.id) })
                    }.buttonStyle(.borderedProminent)
                        .disabled(selected.isEmpty || controller.isBusy || controller.suspended || LocalSummary.availabilityMessage != nil)
                    if let reason = LocalSummary.availabilityMessage { Text("\(reason) Evidence search remains available.").font(.caption).foregroundStyle(.secondary) }
                }
            }
            if let answer = controller.answer {
                Surface {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Answer · AI interpretation").font(.headline)
                        Text("Based on \(answer.selectedSources) selected passages. Source quotes are checked; meaning still needs your review.").font(.caption).foregroundStyle(.secondary)
                        if answer.notFound { Text("The selected passages do not provide enough evidence to answer.") }
                        ForEach(answer.claims) { claim in
                            Text(claim.text).textSelection(.enabled)
                            Button("\(Meeting.timestamp(claim.evidence.start)) · Supporting quote", systemImage: "text.quote") { citation = MemoryCitationSelection(evidence: claim.evidence) }
                        }
                    }
                }
            }
        }
    }
    private func search() { selected = []; controller.search(query, scope: scope) }
    private var actionInbox: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Meeting commitments").font(.title2.bold())
            Picker("Action status", selection: $actionFilter) {
                Text("Review").tag("Review"); Text("Open").tag("Open"); Text("Done").tag("Done"); Text("Dismissed").tag("Dismissed")
            }.pickerStyle(.segmented)
            Text("Candidates do not become agreed commitments until you confirm them. Unknown owners and dates stay empty.").font(.subheadline).foregroundStyle(.secondary)
            if actions.isEmpty && !controller.isBusy { Text("No actions in this view. Open a meeting’s Outcomes to find or review commitments.").foregroundStyle(.secondary) }
            ForEach(actions) { row in
                Surface {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(row.fact.text).font(.headline)
                        Text(row.title).font(.caption).foregroundStyle(.secondary)
                        Text("\(row.fact.owner.isEmpty ? "Unassigned" : row.fact.owner) · \(row.fact.dueDate ?? "No due date")").font(.subheadline)
                        Text(row.fact.review == .pending ? "Needs review" : row.fact.completed ? "Completed" : row.fact.commitment.rawValue.capitalized).font(.caption)
                        if let due = row.fact.dueDate, due < MemoryRules.calendarDate(Date()), !row.fact.completed, row.fact.review == .confirmed, row.fact.commitment == .agreed {
                            Label("Overdue", systemImage: "calendar.badge.exclamationmark").font(.caption).foregroundStyle(.orange)
                        }
                        if row.stale { Notice(text: "Source changed. This item is excluded from preparation.") }
                        HStack {
                            Button("Evidence", systemImage: "text.quote") { citation = MemoryCitationSelection(evidence: row.fact.evidence) }
                            Spacer()
                            Button("Review / edit") { editing = MemoryFactSelection(fact: row.fact, revision: row.recordRevision) }.disabled(controller.isBusy)
                        }
                    }
                }
            }
        }
    }
    private var preparation: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Go in prepared").font(.title2.bold())
            if scope == .all {
                Notice(text: "Choose a client, project, or meeting above. Preparation does not combine unrelated clients by default.")
            } else {
                DatePicker("Meeting starts", selection: $preparationDate)
                Text("Confirmed items from earlier, complete meetings in this scope. Pending, dismissed, resolved, completed and changed-source items are excluded.")
                    .font(.subheadline).foregroundStyle(.secondary)
                let total = prepMeetings.reduce(0) { $0 + preparationFacts($1).count }
                if total == 0 { Text("No current, reviewed decisions or commitments yet. Review a prior meeting’s Outcomes first.").foregroundStyle(.secondary) }
                ForEach(prepMeetings) { meeting in
                    let facts = preparationFacts(meeting)
                    if !facts.isEmpty {
                        Surface {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(meeting.title).font(.headline)
                                Text(meeting.createdAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                                ForEach(facts) { fact in
                                    Text("\(fact.kind.label): \(fact.text)")
                                    if fact.kind == .action { Text("\(fact.owner.isEmpty ? "Unassigned" : fact.owner) · \(fact.dueDate ?? "No due date")").font(.caption).foregroundStyle(.secondary) }
                                    Button("\(Meeting.timestamp(fact.evidence.start)) · Source", systemImage: "text.quote") { citation = MemoryCitationSelection(evidence: fact.evidence) }
                                }
                            }
                        }
                    }
                }
                Text("Prior decisions are shown chronologically; they are not automatically treated as current policy or as superseding one another.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private func preparationFacts(_ meeting: MemoryMeeting) -> [MemoryFact] {
        meeting.trustedFacts.filter { !$0.completed && ($0.kind != .action || $0.commitment == .agreed) }
    }
}
