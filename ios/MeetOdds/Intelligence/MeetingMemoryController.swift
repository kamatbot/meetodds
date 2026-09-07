import Foundation
import Observation
import MeetOddsCore

@MainActor @Observable final class MeetingMemoryController {
    let library: MeetingLibrary
    var catalog = MemoryCatalog(meetings: [], unavailable: 0)
    var current: MemoryMeeting?
    var searchResult: MemorySearchResult?
    var answer: CitedMemoryAnswer?
    var progress: String?
    var error: String?
    var suspended = false
    var isBusy: Bool { progress != nil }
    @ObservationIgnored private let engine: MeetingMemoryEngine
    @ObservationIgnored private var job: Task<Void, Never>?
    @ObservationIgnored private var ticket = UUID()

    init(library: MeetingLibrary) { self.library = library; engine = MeetingMemoryEngine(library: library) }
    func cancel() { ticket = UUID(); job?.cancel(); job = nil; progress = nil }
    func suspend() { cancel(); suspended = true; searchResult = nil; answer = nil }
    func resume() { suspended = false }
    func invalidate() { cancel(); catalog = MemoryCatalog(meetings: [], unavailable: 0); current = nil; searchResult = nil; answer = nil }
    private func run(_ label: String, operation: @escaping @MainActor () async throws -> Void) {
        guard !suspended else { error = "Memory pauses while recording. Finish recording to continue."; return }
        cancel(); let token = ticket; progress = label; error = nil
        job = Task { [weak self] in
            guard let self else { return }
            defer { if self.ticket == token { self.progress = nil; self.job = nil } }
            do { try await operation() }
            catch is CancellationError { }
            catch { if self.ticket == token { self.error = error.localizedDescription } }
        }
    }
    func load(meetingID: UUID? = nil) {
        current = nil
        run("Reading local meetings…") { [self] in
            let result = try await engine.catalog()
            try Task.checkCancellation()
            catalog = result
            if let meetingID { current = result.meetings.first { $0.id == meetingID } }
        }
    }
    func search(_ query: String, scope: MemoryScope) {
        searchResult = nil; answer = nil
        run("Searching on this device…") { [self] in
            let result = try await engine.search(query, scope: scope)
            try Task.checkCancellation(); searchResult = result
        }
    }
    func clearSearch() { cancel(); searchResult = nil; answer = nil; error = nil }
    func generateAnswer(hits: [MemoryHit]) {
        guard let result = searchResult, !hits.isEmpty,
              hits.allSatisfy({ hit in result.hits.contains(where: { $0.id == hit.id }) }) else { return }
        answer = nil
        run("Answering from selected passages…") { [self] in
            try await checkSources(hits, scope: result.scope)
            let generated = try await LocalMeetingMemory().answer(question: result.query, hits: hits)
            try Task.checkCancellation()
            try await checkSources(hits, scope: result.scope)
            try Task.checkCancellation(); answer = generated
        }
    }
    private func checkSources(_ hits: [MemoryHit], scope: MemoryScope) async throws {
        for hit in hits {
            try Task.checkCancellation()
            let source = try await library.memoryMeeting(hit.passage.evidence.meetingID)
            guard scope.contains(id: source.id, context: source.memory.context), hit.passage.evidence.isCurrent(in: source.transcript) else {
                throw MeetingError.failed("A source changed or left this scope. Search again before generating an answer.")
            }
        }
    }
    func extract(meetingID: UUID) {
        run("Reading saved transcript…") { [self] in
            let source = try await library.memoryMeeting(meetingID)
            try Task.checkCancellation()
            let token = ticket
            let proposals = try await LocalMeetingMemory().extract(source) { [weak self] message in
                await MainActor.run { if self?.ticket == token { self?.progress = message } }
            }
            try Task.checkCancellation()
            _ = try await library.mergeMemoryCandidates(proposals, meetingID: meetingID, expectedTranscript: source.transcript)
            let result = try await engine.catalog()
            try Task.checkCancellation(); catalog = result; current = result.meetings.first { $0.id == meetingID }
        }
    }
    /// Used by review forms. Errors propagate so the form never closes on a failed write.
    func save(_ fact: MemoryFact, revision: Int) async throws {
        guard !isBusy, !suspended else { throw MeetingError.failed("Finish the current operation before saving.") }
        progress = "Saving reviewed item…"; let token = ticket
        defer { if ticket == token { progress = nil } }
        try Task.checkCancellation()
        _ = try await library.saveMemoryFact(fact, meetingID: fact.evidence.meetingID, expectedRevision: revision)
        let refreshed = try await library.memoryMeeting(fact.evidence.meetingID)
        guard ticket == token else { return }
        replaceInCatalog(refreshed)
    }
    func saveContext(_ context: MemoryContext, meetingID: UUID, revision: Int) async throws {
        guard !isBusy, !suspended else { throw MeetingError.failed("Finish the current operation before saving.") }
        progress = "Saving meeting scope…"; let token = ticket
        defer { if ticket == token { progress = nil } }
        _ = try await library.saveMemoryContext(context, meetingID: meetingID, expectedRevision: revision)
        let refreshed = try await library.memoryMeeting(meetingID)
        guard ticket == token else { return }
        replaceInCatalog(refreshed); searchResult = nil; answer = nil
    }
    private func replaceInCatalog(_ meeting: MemoryMeeting) {
        catalog.meetings.removeAll { $0.id == meeting.id }; catalog.meetings.append(meeting)
        catalog.meetings.sort { $0.createdAt > $1.createdAt }
        if current?.id == meeting.id { current = meeting }
    }
    func scopedMeetings(_ scope: MemoryScope) -> [MemoryMeeting] {
        catalog.meetings.filter { scope.contains(id: $0.id, context: $0.memory.context) }
    }
    func actions(_ scope: MemoryScope) -> [MemoryActionRow] {
        scopedMeetings(scope).flatMap { meeting in
            meeting.memory.facts.filter { $0.kind == .action }.map { MemoryActionRow(meeting: meeting, fact: $0) }
        }.sorted {
            let rank: [MemoryReview: Int] = [.pending: 0, .confirmed: 1, .dismissed: 2]
            if $0.fact.review != $1.fact.review { return rank[$0.fact.review, default: 3] < rank[$1.fact.review, default: 3] }
            if $0.fact.dueDate != $1.fact.dueDate { return ($0.fact.dueDate ?? "9999") < ($1.fact.dueDate ?? "9999") }
            return $0.fact.updatedAt > $1.fact.updatedAt
        }
    }
}
