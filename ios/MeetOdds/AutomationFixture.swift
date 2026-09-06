import Foundation
import MeetOddsCore

/// Simulator test content uses a new isolated directory and never reads a user's meeting library.
enum AutomationFixture {
    static var enabled: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--ui-testing")
        #else
        false
        #endif
    }
    /// Presents the recording screen without capturing audio, so its layout can be checked on simulators that have no microphone.
    static var showsRecording: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--show-recording") }
    /// Opens the fixture meeting as though recording had just finished. Reaching that state
    /// for real requires a microphone, which the simulators on this host do not have.
    static var showsJustRecorded: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--just-recorded") }
    static let storageRoot: URL? = {
        guard enabled else { return nil }
        return FileManager.default.temporaryDirectory.appendingPathComponent("MeetOdds-UI-\(UUID().uuidString)", isDirectory: true)
    }()
    static func install(into library: MeetingLibrary) async throws {
        guard enabled else { return }
        var meeting = Meeting(title: "Product weekly", mode: .local, templateID: "mayur_product_review", localeID: "en-US", createdAt: Date(timeIntervalSince1970: 1_788_588_000))
        meeting.status = .ready; meeting.duration = 1248; meeting.notes = "Private: ask about the research sample."
        meeting.acceptFinal(.init(id: "T1000", start: 1, end: 6, text: "Let's test the revised onboarding with ten customers before deciding."))
        meeting.acceptFinal(.init(id: "T7000", start: 7, end: 14, text: "I will bring the research findings to our next review. We have not set a deadline."))
        meeting.summaries = [.init(mode: .local, templateID: "mayur_product_review", markdown: "## What changed\n\nThe team proposed testing revised onboarding with ten customers. [T1000]\n\n## Next steps\n\nBring research findings to the next review. Owner and date need confirmation. [T7000]", includesPersonalNotes: false)]
        _ = try await library.create(meeting)
    }
}
