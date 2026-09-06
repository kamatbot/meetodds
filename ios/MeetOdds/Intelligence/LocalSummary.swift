import Foundation
import FoundationModels
import MeetOddsCore

actor LocalSummary {
    static var availabilityMessage: String? {
        switch SystemLanguageModel.default.availability {
        case .available: return nil
        case .unavailable(.deviceNotEligible): return "Local summaries require an Apple Intelligence-capable iPhone or iPad. Recording still works."
        case .unavailable(.appleIntelligenceNotEnabled): return "Turn on Apple Intelligence in Settings to generate local summaries."
        case .unavailable(.modelNotReady): return "Apple Intelligence is downloading or preparing its model. Recording still works."
        case .unavailable: return "The on-device summary model is currently unavailable."
        }
    }
    func generate(input: String, template: MeetingTemplate, progress: @escaping @Sendable (String) async -> Void) async throws -> String {
        if let reason = Self.availabilityMessage { throw MeetingError.failed(reason) }
        // Every chunk is processed. Conservative byte budgeting also works for non-Latin text.
        var evidence = input
        for round in 0..<8 {
            let parts = SummaryInput.chunks(evidence)
            if parts.count == 1 { break }
            var compressed: [String] = []
            for (index, part) in parts.enumerated() {
                try Task.checkCancellation()
                await progress("Reading part \(index + 1) of \(parts.count)\(round > 0 ? " · combining" : "")")
                compressed.append(try await respond("Extract decisions, explicit commitments, objections and unresolved questions from this evidence excerpt. Keep turn IDs. Under 90 words.\n\n\(part)", maximumResponseTokens: Self.responseTokensPerSection))
            }
            let reduced = compressed.joined(separator: "\n")
            guard reduced.utf8.count < evidence.utf8.count else { throw MeetingError.failed("The local model could not condense this meeting safely. Try ChatGPT or a shorter meeting; nothing was truncated.") }
            evidence = reduced
        }
        guard evidence.utf8.count <= 2400 else { throw MeetingError.tooLarge }
        // One request per section meant fourteen on-device generations for the longer
        // templates, so a two-line meeting took minutes. Sections are written in batches,
        // and every response is capped: an uncapped answer to a thin transcript rambles
        // until it overruns the window shared by instructions, evidence and output.
        var written: [String] = []
        let groups = stride(from: 0, to: template.sections.count, by: Self.sectionsPerRequest).map {
            Array(template.sections[$0..<min($0 + Self.sectionsPerRequest, template.sections.count)])
        }
        for (index, group) in groups.enumerated() {
            try Task.checkCancellation()
            await progress(groups.count == 1 ? "Writing the summary" : "Writing section \(index * Self.sectionsPerRequest + 1) of \(template.sections.count)")
            let wanted = group.map { "## \($0.title)\n\($0.instruction)" }.joined(separator: "\n\n")
            let text = try await respond(
                "Write each of these sections as Markdown. Keep every heading exactly as written and keep each section under 90 words.\n\n\(wanted)\n\nEvidence:\n\(evidence)",
                maximumResponseTokens: Self.responseTokensPerSection * group.count)
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MeetingError.failed("The local model returned an empty section. Your previous summary is unchanged.") }
            written.append(text.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return written.joined(separator: "\n\n")
    }
    private static let sectionsPerRequest = 4
    private static let responseTokensPerSection = 170
    private func respond(_ text: String, maximumResponseTokens: Int) async throws -> String {
        try Task.checkCancellation()
        let session = LanguageModelSession(instructions: SummaryInput.rules)
        do {
            return try await session.respond(
                to: text,
                options: GenerationOptions(temperature: 0.2, maximumResponseTokens: maximumResponseTokens)
            ).content
        } catch let error as LanguageModelSession.GenerationError {
            // Name the two things the user can change instead of reporting a token count.
            if case .exceededContextWindowSize = error {
                throw MeetingError.failed("This meeting is too long for the on-device model with this template. Choose a template with fewer sections, or summarize with ChatGPT.")
            }
            throw error
        }
    }
}
