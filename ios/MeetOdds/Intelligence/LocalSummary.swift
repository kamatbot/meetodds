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
                compressed.append(try await respond("Extract decisions, explicit commitments, objections and unresolved questions from this evidence excerpt. Keep turn IDs. Under 90 words.\n\n\(part)"))
            }
            let reduced = compressed.joined(separator: "\n")
            guard reduced.utf8.count < evidence.utf8.count else { throw MeetingError.failed("The local model could not condense this meeting safely. Try ChatGPT or a shorter meeting; nothing was truncated.") }
            evidence = reduced
        }
        guard evidence.utf8.count <= 2400 else { throw MeetingError.tooLarge }
        var sections: [String] = []
        for section in template.sections {
            try Task.checkCancellation()
            await progress(section.title)
            let text = try await respond("Write only the \(section.title) section, under 150 words. \(section.instruction)\n\nEvidence:\n\(evidence)")
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MeetingError.failed("The local model returned an empty section. Your previous summary is unchanged.") }
            sections.append("## \(section.title)\n\n\(text)")
        }
        return sections.joined(separator: "\n\n")
    }
    private func respond(_ text: String) async throws -> String {
        try Task.checkCancellation()
        let session = LanguageModelSession(instructions: SummaryInput.rules)
        // No artificial response-token cutoff: a context failure is visible, not silent truncation.
        return try await session.respond(to: text, options: GenerationOptions(temperature: 0.2)).content
    }
}
