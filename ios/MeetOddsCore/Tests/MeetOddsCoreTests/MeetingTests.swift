import Foundation
import XCTest
@testable import MeetOddsCore

final class MeetingTests: XCTestCase {
    func sample() -> Meeting { Meeting(title: "Review", mode: .local, templateID: "standard_meeting", localeID: "en-US") }
    func testFinalTurnsAreOrderedAndRevisionsReplaceRatherThanDuplicate() {
        var m = sample()
        m.acceptFinal(.init(id: "b", start: 3, end: 5, text: "Later"))
        m.acceptFinal(.init(id: "a", start: 0, end: 2, text: "First"))
        m.acceptFinal(.init(id: "a", start: 0, end: 2, text: "Corrected"))
        XCTAssertEqual(m.transcript.map(\.text), ["Corrected", "Later"])
    }
    func testInvalidTimingIsNotAccepted() {
        var m = sample(); m.acceptFinal(.init(id: "bad", start: .nan, end: 4, text: "No"))
        m.acceptFinal(.init(id: "bad", start: 5, end: 4, text: "No")); XCTAssertTrue(m.transcript.isEmpty)
    }
    func testEmptyFinalRevokesSameTurn() {
        var m = sample(); m.acceptFinal(.init(id: "a", start: 0, end: 2, text: "maybe"))
        m.acceptFinal(.init(id: "a", start: 0, end: 2, text: "")); XCTAssertTrue(m.transcript.isEmpty)
    }
    func testNotesExcludedUnlessExplicitlySelected() throws {
        var m = sample(); m.notes = "PRIVATE"; m.acceptFinal(.init(id: "t1", start: 3, end: 4, text: "Confirmed"))
        XCTAssertFalse(try SummaryInput.build(meeting: m, includeNotes: false).contains("PRIVATE"))
        XCTAssertTrue(try SummaryInput.build(meeting: m, includeNotes: true).contains("PRIVATE"))
    }
    func testEmptyTranscriptCannotBeSummarized() { XCTAssertThrowsError(try SummaryInput.build(meeting: sample(), includeNotes: false)) }
    func testUnicodeChunkingPreservesEveryByte() {
        let text = String(repeating: "สวัสดี 👩🏽‍💻 hello\n", count: 400)
        let chunks = SummaryInput.chunks(text, byteLimit: 97)
        XCTAssertEqual(chunks.joined(), text); XCTAssertTrue(chunks.allSatisfy { $0.utf8.count <= 97 })
    }
    func testPairingRejectsInsecureAndCredentialBearingURLs() {
        for value in ["http://localhost:9417", "https://user:secret@host", "https://host?token=x", "https://host/path", "file:///tmp"] {
            XCTAssertThrowsError(try CompanionPairing(url: URL(string: value)!, token: String(repeating: "x", count: 32), fingerprint: String(repeating: "a", count: 64)))
        }
    }
    func testPairingNormalizesFingerprintAndAcceptsTLS() throws {
        let pair = try CompanionPairing.parse("{\"url\":\"https://mac.local:9417\",\"token\":\"\(String(repeating: "x", count: 32))\",\"fingerprint\":\"\(String(repeating: "AB", count: 32))\"}")
        XCTAssertEqual(pair.fingerprint, String(repeating: "ab", count: 32))
    }
    func testTemplatesDecodeDesktopSchema() throws {
        let template = try JSONDecoder().decode(MeetingTemplate.self, from: Data("{\"name\":\"Daily\",\"description\":\"Standup\",\"sections\":[{\"title\":\"Actions\",\"instruction\":\"Only commitments\",\"format\":\"list\"}]}".utf8))
        XCTAssertTrue(template.instructions.contains("Only commitments"))
    }
    func testLibraryRejectsStaleWritesAndRecoversInterruptedMeeting() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try MeetingLibrary(root: root)
        let first = try await library.create(sample())
        var edit = first; edit.notes = "Saved"
        let saved = try await library.save(edit)
        XCTAssertEqual(saved.revision, 1)
        do { _ = try await library.save(first); XCTFail("stale save allowed") } catch { XCTAssertEqual(error as? MeetingError, .conflict) }
        let recovered = try await library.recoverInterrupted()
        XCTAssertEqual(recovered.first?.status, .interrupted)
        let loaded = try await library.load(first.id)
        XCTAssertEqual(loaded.notes, "Saved")
        try await library.remove(first.id)
        let empty = try await library.list(); XCTAssertTrue(empty.isEmpty)
    }
    func testDuplicateCreateNeverTruncatesExistingMeeting() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try MeetingLibrary(root: root); let meeting = sample()
        _ = try await library.create(meeting)
        do { _ = try await library.create(meeting); XCTFail("duplicate") } catch { XCTAssertEqual(error as? MeetingError, .conflict) }
    }
}
