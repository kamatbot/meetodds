import Foundation
import NaturalLanguage
import MeetOddsCore

struct MemoryCatalog: Sendable {
    var meetings: [MemoryMeeting]
    var unavailable: Int
    var scopes: [MemoryScope] {
        var found = Set<MemoryScope>()
        for meeting in meetings {
            let context = meeting.memory.context
            if !context.client.isEmpty { found.insert(.client(context.client)) }
            if !context.project.isEmpty { found.insert(.project(client: context.client, name: context.project)) }
        }
        return found.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }
}

/// Runs away from the main actor. Embeddings are supplied by the OS, never downloaded here.
/// No transcript, query, or vector is sent to the Mac companion or any cloud provider.
actor MeetingMemoryEngine {
    private let library: MeetingLibrary
    private var embeddings: [String: NLEmbedding] = [:]
    private var unavailableLanguages = Set<String>()
    init(library: MeetingLibrary) { self.library = library }

    func catalog() async throws -> MemoryCatalog {
        var meetings: [MemoryMeeting] = []; var unavailable = 0
        for id in try await library.memoryMeetingIDs() {
            try Task.checkCancellation()
            do {
                let meeting = try await library.memoryMeeting(id)
                if meeting.status != .recording && meeting.status != .paused { meetings.append(meeting) }
            } catch is CancellationError { throw CancellationError() }
            catch { unavailable += 1 }
            // Each meeting is a separate actor hop, allowing capture checkpoints between reads.
            await Task.yield()
        }
        return MemoryCatalog(meetings: meetings.sorted { $0.createdAt > $1.createdAt }, unavailable: unavailable)
    }

    func search(_ question: String, scope: MemoryScope) async throws -> MemorySearchResult {
        let query = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, query.utf8.count <= 1000 else { throw MeetingError.failed("Enter a question under 1,000 bytes.") }
        let catalog = try await catalog()
        // Scope is applied BEFORE token statistics, embeddings, ranking, or model input.
        let meetings = catalog.meetings.filter { scope.contains(id: $0.id, context: $0.memory.context) }
        let passages = meetings.flatMap { meeting in meeting.transcript.compactMap { try? MemoryPassage(meeting: meeting, turn: $0) } }
        try Task.checkCancellation()
        let lexical = MemoryLexicalRanker.scores(query: query, passages: passages)
        let maxLexical = max(1, lexical.max() ?? 0)
        let queryLanguage = NLLanguageRecognizer.dominantLanguage(for: query)
        let embedding = queryLanguage.flatMap { sentenceEmbedding($0) }
        let queryVector = embedding?.vector(for: query)
        var hits: [MemoryHit] = []; var semanticCount = 0
        for (index, passage) in passages.enumerated() {
            try Task.checkCancellation()
            var similarity = 0.0
            var usedSemantic = false
            // Do not compare vectors from unrelated language spaces. Long turns use lexical
            // search rather than silently embedding just their opening words.
            if let queryLanguage, let embedding, let queryVector,
               passage.evidence.originalText.utf8.count <= 2000,
               NLLanguageRecognizer.dominantLanguage(for: passage.evidence.originalText) == queryLanguage,
               let vector = embedding.vector(for: passage.evidence.originalText), vector.count == queryVector.count {
                similarity = Self.cosine(queryVector, vector)
                usedSemantic = true; semanticCount += 1
            }
            let lexicalScore = lexical[index]
            guard lexicalScore > 0 || (usedSemantic && similarity >= 0.55) else { continue }
            // Ranking scores are heuristic, not confidence/probability of factual support.
            let score = lexicalScore / maxLexical + (usedSemantic ? 0.35 * max(0, similarity) : 0)
            hits.append(MemoryHit(passage: passage, score: score, semantic: usedSemantic))
            if index % 32 == 0 { await Task.yield() }
        }
        hits.sort {
            if $0.score != $1.score { return $0.score > $1.score }
            if $0.passage.date != $1.passage.date { return $0.passage.date > $1.passage.date }
            return $0.id < $1.id
        }
        return MemorySearchResult(query: query, scope: scope, hits: Array(hits.prefix(30)), searchedMeetings: meetings.count,
                                  unavailableMeetings: catalog.unavailable, semanticPassages: semanticCount, totalPassages: passages.count)
    }
    private func sentenceEmbedding(_ language: NLLanguage) -> NLEmbedding? {
        let key = language.rawValue
        if let cached = embeddings[key] { return cached }
        if unavailableLanguages.contains(key) { return nil }
        guard let embedding = NLEmbedding.sentenceEmbedding(for: language) else { unavailableLanguages.insert(key); return nil }
        embeddings[key] = embedding; return embedding
    }
    private static func cosine(_ a: [Double], _ b: [Double]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot = 0.0; var aa = 0.0; var bb = 0.0
        for (x, y) in zip(a, b) { dot += x * y; aa += x * x; bb += y * y }
        guard aa > 0, bb > 0 else { return 0 }
        let result = dot / sqrt(aa * bb)
        return result.isFinite ? max(-1, min(1, result)) : 0
    }
}
