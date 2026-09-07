import Foundation
import XCTest
@testable import MeetOddsCore

final class MeetingMemoryTests: XCTestCase {
    private func fixture() -> Meeting {
        var meeting = Meeting(title: "Product review", mode: .local, templateID: "standard_meeting", localeID: "en_US")
        meeting.status = .ready
        meeting.notes = "PRIVATE_SENTINEL_NOT_FOR_MEMORY"
        meeting.transcript = [TranscriptTurn(id: "turn-1", start: 12, end: 18, text: "We agreed to launch the beta in Kenya.")]
        return meeting
    }
    private func fact(_ meeting: Meeting) throws -> MemoryFact {
        MemoryFact(kind: .decision, text: "Launch the beta in Kenya", evidence: try MemoryEvidence(meetingID: meeting.id, turn: meeting.transcript[0], quote: "launch the beta in Kenya"))
    }
    func testEvidenceRequiresExactSourceAndDetectsChangedTiming() throws {
        let meeting = fixture(); let evidence = try fact(meeting).evidence
        XCTAssertTrue(evidence.isCurrent(in: meeting.transcript))
        var turns = meeting.transcript; turns[0].text = "We rejected a beta launch."
        XCTAssertFalse(evidence.isCurrent(in: turns))
        turns = meeting.transcript; turns[0].start = 15
        XCTAssertFalse(evidence.isCurrent(in: turns))
        XCTAssertThrowsError(try MemoryEvidence(meetingID: meeting.id, turn: meeting.transcript[0], quote: "Launch in Nigeria"))
    }
    func testProjectsAreClientQualifiedAndEmptyScopesFailClosed() {
        let id = UUID(); let a = MemoryContext(client: "Client A", project: "Launch")
        let b = MemoryContext(client: "Client B", project: "Launch")
        let scope = MemoryScope.project(client: "Client A", name: "Launch")
        XCTAssertTrue(scope.contains(id: id, context: a))
        XCTAssertFalse(scope.contains(id: id, context: b))
        XCTAssertFalse(MemoryScope.client("").contains(id: id, context: MemoryContext()))
        XCTAssertFalse(MemoryScope.project(client: "", name: "").contains(id: id, context: MemoryContext()))
        XCTAssertFalse(MemoryScope.meeting(UUID()).contains(id: id, context: a))
    }
    func testRegenerationPreservesReviewedEditsAndDismissals() throws {
        let meeting = fixture(); var original = try fact(meeting)
        original.review = .confirmed; original.text = "My reviewed decision"
        var record = MeetingMemoryRecord(meetingID: meeting.id); record.facts = [original]
        record.mergeCandidates([try fact(meeting)])
        XCTAssertEqual(record.facts.count, 1)
        XCTAssertEqual(record.facts[0].id, original.id)
        XCTAssertEqual(record.facts[0].text, "My reviewed decision")
        record.facts[0].review = .dismissed
        record.mergeCandidates([try fact(meeting)])
        XCTAssertEqual(record.facts.count, 1)
        XCTAssertEqual(record.facts[0].review, .dismissed)
    }
    func testRegenerationKeepsDistinctClaimsAndAddsANewTimingRevision() throws {
        let meeting = fixture()
        var first = try fact(meeting); first.kind = .action; first.text = "Alice will send the report"; first.review = .confirmed
        var second = try fact(meeting); second.kind = .action; second.text = "Bob will book the room"
        var record = MeetingMemoryRecord(meetingID: meeting.id); record.facts = [first]
        record.mergeCandidates([first, second])
        XCTAssertEqual(record.facts.map(\.text).sorted(), ["Alice will send the report", "Bob will book the room"])

        var revised = meeting; revised.transcript[0].end = 19
        let timingRevision = try MemoryFact(kind: .action, text: first.text, evidence: MemoryEvidence(meetingID: revised.id, turn: revised.transcript[0], quote: "launch the beta in Kenya"))
        record.mergeCandidates([timingRevision])
        XCTAssertEqual(record.facts.count, 3)
        XCTAssertEqual(record.facts.filter { $0.evidence.end == 19 }.count, 1)
        XCTAssertEqual(record.facts.first(where: { $0.id == first.id })?.review, .confirmed)
    }
    func testTrustedMemoryExcludesPendingAndChangedSources() throws {
        let meeting = fixture(); var record = MeetingMemoryRecord(meetingID: meeting.id)
        record.facts = [try fact(meeting)]
        XCTAssertTrue(MemoryMeeting(meeting: meeting, memory: record).trustedFacts.isEmpty)
        record.facts[0].review = .confirmed
        XCTAssertEqual(MemoryMeeting(meeting: meeting, memory: record).trustedFacts.count, 1)
        var revised = meeting; revised.transcript[0].text = "The earlier decision was reversed."
        XCTAssertTrue(MemoryMeeting(meeting: revised, memory: record).trustedFacts.isEmpty)
    }
    func testNoCompletionWithoutReviewedAgreementOrValidDate() throws {
        let meeting = fixture(); var action = try fact(meeting); action.kind = .action; action.completed = true
        XCTAssertThrowsError(try MemoryRules.validate(action))
        action.review = .confirmed
        XCTAssertThrowsError(try MemoryRules.validate(action))
        action.commitment = .agreed
        XCTAssertNoThrow(try MemoryRules.validate(action))
        action.dueDate = "2026-02-31"
        XCTAssertThrowsError(try MemoryRules.validate(action))
        XCTAssertTrue(MemoryRules.validDate("2028-02-29"))
        XCTAssertFalse(MemoryRules.validDate("Friday"))
    }
    func testFollowUpExcludesNotesPendingProposalsAndStaleFacts() throws {
        let meeting = fixture(); var record = MeetingMemoryRecord(meetingID: meeting.id)
        var action = try fact(meeting); action.kind = .action; action.review = .confirmed
        record.facts = [action]
        let draft = MemoryRules.followUp(MemoryMeeting(meeting: meeting, memory: record))
        XCTAssertFalse(draft.contains(meeting.notes))
        XCTAssertFalse(draft.contains("Launch the beta in Kenya"))
        record.facts[0].commitment = .agreed
        let included = MemoryRules.followUp(MemoryMeeting(meeting: meeting, memory: record))
        XCTAssertTrue(included.contains("Launch the beta in Kenya"))
        XCTAssertTrue(included.contains("00:12"))
    }
    func testLexicalSearchRanksActualTranscriptEvidence() throws {
        let meeting = fixture(); let memory = MemoryMeeting(meeting: meeting, memory: MeetingMemoryRecord(meetingID: meeting.id))
        let passages = try [MemoryPassage(meeting: memory, turn: meeting.transcript[0]), MemoryPassage(meeting: memory, turn: TranscriptTurn(id: "turn-2", start: 20, end: 25, text: "The hiring budget is unchanged."))]
        let scores = MemoryLexicalRanker.scores(query: "What did we decide about Kenya?", passages: passages)
        XCTAssertGreaterThan(scores[0], scores[1])
        XCTAssertEqual(MemoryLexicalRanker.scores(query: meeting.notes, passages: passages), [0, 0])
    }
    func testMemorySidecarDoesNotRewriteLegacyMeetingAndDeletesWithIt() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try MeetingLibrary(root: root); let meeting = fixture()
        _ = try await library.create(meeting)
        let folder = await library.directory(for: meeting.id)
        let original = try Data(contentsOf: folder.appendingPathComponent("meeting.json"))
        let record = try await library.memoryRecord(meeting.id)
        XCTAssertEqual(record.revision, 0)
        _ = try await library.saveMemoryContext(MemoryContext(client: "Client A", project: "Launch"), meetingID: meeting.id, expectedRevision: 0)
        let after = try Data(contentsOf: folder.appendingPathComponent("meeting.json"))
        XCTAssertEqual(original, after)
        let loaded = try await library.load(meeting.id)
        XCTAssertEqual(loaded.notes, meeting.notes)
        try await library.remove(meeting.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }
    func testStaleSidecarWriterCannotOverwriteNewerReview() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try MeetingLibrary(root: root); let meeting = fixture()
        _ = try await library.create(meeting)
        let first = try await library.saveMemoryFact(try fact(meeting), meetingID: meeting.id, expectedRevision: 0)
        var reviewed = first.facts[0]; reviewed.review = .confirmed
        _ = try await library.saveMemoryFact(reviewed, meetingID: meeting.id, expectedRevision: first.revision)
        do {
            _ = try await library.saveMemoryFact(first.facts[0], meetingID: meeting.id, expectedRevision: first.revision)
            XCTFail("Expected revision conflict")
        } catch { XCTAssertEqual(error as? MeetingError, .conflict) }
        let latest = try await library.memoryRecord(meeting.id)
        XCTAssertEqual(latest.facts[0].review, .confirmed)
    }
    func testMalformedOrFutureSidecarIsNotOverwritten() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try MeetingLibrary(root: root); let meeting = fixture()
        _ = try await library.create(meeting)
        let folder = await library.directory(for: meeting.id)
        let path = folder.appendingPathComponent("memory-v1.json")
        let bytes = Data("{malformed".utf8); try bytes.write(to: path)
        do {
            _ = try await library.saveMemoryContext(MemoryContext(client: "Do not write"), meetingID: meeting.id, expectedRevision: 0)
            XCTFail("Malformed metadata must fail closed")
        } catch { }
        XCTAssertEqual(try Data(contentsOf: path), bytes)
    }
    func testForeignEvidenceInADecodableSidecarIsRejectedWithoutRewrite() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try MeetingLibrary(root: root); let meeting = fixture()
        _ = try await library.create(meeting)
        var foreign = try fact(meeting); foreign.evidence.meetingID = UUID()
        var record = MeetingMemoryRecord(meetingID: meeting.id); record.facts = [foreign]
        let path = await library.directory(for: meeting.id).appendingPathComponent("memory-v1.json")
        let bytes = try JSONEncoder().encode(record); try bytes.write(to: path)
        do {
            _ = try await library.memoryRecord(meeting.id)
            XCTFail("Foreign evidence must be rejected")
        } catch { }
        XCTAssertEqual(try Data(contentsOf: path), bytes)
    }
}
