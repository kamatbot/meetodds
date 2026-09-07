import Foundation

/// Memory is a separate, versioned sidecar. Existing meeting.json files are not migrated.
/// No personal notes, generated summaries or live previews are part of its source contract.
public struct MemoryContext: Codable, Hashable, Sendable {
    public var client: String
    public var project: String
    public init(client: String = "", project: String = "") {
        self.client = client.trimmingCharacters(in: .whitespacesAndNewlines)
        self.project = project.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    public static func key(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

public enum MemoryScope: Hashable, Sendable, Identifiable {
    case meeting(UUID)
    case client(String)
    // A project is qualified by its client. Identically named client projects never mix.
    case project(client: String, name: String)
    case all
    public var id: String {
        switch self {
        case .meeting(let id): return "meeting:\(id.uuidString)"
        case .client(let name): return "client:\(name)"
        case .project(let client, let name): return "project:\(client.utf8.count):\(client):\(name)"
        case .all: return "all"
        }
    }
    public var label: String {
        switch self {
        case .meeting: return "This meeting"
        case .client(let name): return "Client · \(name)"
        case .project(let client, let name): return client.isEmpty ? "Project · \(name)" : "\(client) / \(name)"
        case .all: return "All meetings on this device"
        }
    }
    public func contains(id: UUID, context: MemoryContext) -> Bool {
        switch self {
        case .meeting(let wanted): return id == wanted
        case .client(let client): return !MemoryContext.key(client).isEmpty && MemoryContext.key(client) == MemoryContext.key(context.client)
        case .project(let client, let name):
            return !MemoryContext.key(name).isEmpty && MemoryContext.key(name) == MemoryContext.key(context.project)
                && MemoryContext.key(client) == MemoryContext.key(context.client)
        case .all: return true
        }
    }
}

public enum MemoryFactKind: String, Codable, CaseIterable, Hashable, Sendable {
    case outcome, decision, action, question
    public var label: String {
        switch self {
        case .outcome: return "Outcome"
        case .decision: return "Decision"
        case .action: return "Action"
        case .question: return "Open question"
        }
    }
}
public enum MemoryReview: String, Codable, Hashable, Sendable { case pending, confirmed, dismissed }
public enum MemoryCommitment: String, Codable, CaseIterable, Hashable, Sendable { case proposed, agreed }

public struct MemoryEvidence: Codable, Hashable, Sendable {
    public var meetingID: UUID
    public var turnID: String
    public var start: Double
    public var end: Double
    public var originalText: String
    public var quote: String
    public init(meetingID: UUID, turn: TranscriptTurn, quote: String) throws {
        let quote = quote.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !quote.isEmpty, turn.text.contains(quote), turn.start.isFinite, turn.end.isFinite,
              turn.start >= 0, turn.end >= turn.start else {
            throw MeetingError.failed("The source quote or its timing could not be verified.")
        }
        self.meetingID = meetingID; turnID = turn.id; start = turn.start; end = turn.end
        originalText = turn.text; self.quote = quote
    }
    public var isWellFormed: Bool {
        !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && originalText.contains(quote)
            && start.isFinite && end.isFinite && start >= 0 && end >= start
    }
    /// A source revision deliberately excludes quote boundaries: two excerpts from the
    /// same retained turn do not create duplicate claims, while changed timing does.
    public var sourceKey: String {
        "\(turnID.utf8.count):\(turnID)|\(originalText.utf8.count):\(originalText)|\(start.bitPattern)|\(end.bitPattern)"
    }
    /// Matching an ID alone is insufficient: recognition can reuse it for changed words.
    public func isCurrent(in turns: [TranscriptTurn]) -> Bool {
        guard isWellFormed else { return false }
        return turns.contains { $0.id == turnID && $0.text == originalText && $0.start == start && $0.end == end }
    }
}

public struct MemoryFact: Codable, Identifiable, Sendable, Equatable {
    public var id: UUID
    public var kind: MemoryFactKind
    public var text: String
    public var evidence: MemoryEvidence
    public var review: MemoryReview = .pending
    public var commitment: MemoryCommitment = .proposed
    public var owner: String = ""
    /// ISO calendar date entered by the user. Relative dates are deliberately not guessed.
    public var dueDate: String?
    public var completed: Bool = false
    public var updatedAt: Date = Date()
    public init(id: UUID = UUID(), kind: MemoryFactKind, text: String, evidence: MemoryEvidence) {
        self.id = id; self.kind = kind; self.text = text; self.evidence = evidence
    }
    /// An assertion can be distinct even when another commitment uses the same quote.
    public var assertionKey: String {
        "\(kind.rawValue)|\(text.utf8.count):\(text)|\(evidence.sourceKey)"
    }
    public var reconciliationKey: String {
        assertionKey
    }
}

public struct MeetingMemoryRecord: Codable, Sendable {
    public var schemaVersion: Int = 1
    public var revision: Int = 0
    public var meetingID: UUID
    public var context = MemoryContext()
    public var facts: [MemoryFact] = []
    public init(meetingID: UUID) { self.meetingID = meetingID }
    public func validate() throws {
        guard schemaVersion == 1, revision >= 0,
              context.client.utf8.count <= 200, context.project.utf8.count <= 200 else {
            throw MeetingError.failed("This meeting’s Memory file uses an unsupported format. It has not been replaced.")
        }
        var identifiers = Set<UUID>()
        var assertions = Set<String>()
        for fact in facts {
            guard identifiers.insert(fact.id).inserted,
                  assertions.insert(fact.reconciliationKey).inserted,
                  fact.evidence.meetingID == meetingID,
                  fact.evidence.isWellFormed else {
                throw MeetingError.failed("This meeting’s Memory file is invalid. It has not been replaced.")
            }
            try MemoryRules.validate(fact)
        }
    }
    /// Extraction is additive. Never delete, re-open, or rephrase a reviewed item on refresh.
    /// Pending candidates also retain their ID when the same evidence is found again.
    public mutating func mergeCandidates(_ incoming: [MemoryFact]) {
        var seen = Set(facts.map(\.reconciliationKey))
        let sourceCounts = Dictionary(incoming.map { ($0.evidence.sourceKey, 1) }, uniquingKeysWith: +)
        for candidate in incoming where candidate.evidence.meetingID == meetingID {
            guard seen.insert(candidate.reconciliationKey).inserted else { continue }
            let reviewedSourceExists = facts.contains {
                $0.evidence.sourceKey == candidate.evidence.sourceKey && $0.review != .pending
            }
            // A single regenerated claim against an already reviewed source is ambiguous:
            // retain the user's review instead of silently recreating it with new wording.
            guard sourceCounts[candidate.evidence.sourceKey] != 1 || !reviewedSourceExists else { continue }
            facts.append(candidate)
        }
    }
}

/// A projection, not Meeting: consumers cannot accidentally index private notes/AI prose.
public struct MemoryMeeting: Sendable, Identifiable {
    public var id: UUID
    public var title: String
    public var createdAt: Date
    public var localeID: String
    public var status: MeetingStatus
    public var incomplete: Bool
    public var transcript: [TranscriptTurn]
    public var memory: MeetingMemoryRecord
    public init(meeting: Meeting, memory: MeetingMemoryRecord) {
        id = meeting.id; title = meeting.title; createdAt = meeting.createdAt
        localeID = meeting.localeID; status = meeting.status
        incomplete = meeting.status != .ready || !meeting.notices.isEmpty
        transcript = meeting.transcript; self.memory = memory
    }
    public var trustedFacts: [MemoryFact] {
        memory.facts.filter { $0.review == .confirmed && $0.evidence.meetingID == id && $0.evidence.isCurrent(in: transcript) }
    }
}

public struct MemoryPassage: Sendable, Identifiable, Equatable {
    public var id: String { "\(evidence.meetingID.uuidString)/\(evidence.turnID)" }
    public let title: String
    public let date: Date
    public let localeID: String
    public let context: MemoryContext
    public let incomplete: Bool
    public let evidence: MemoryEvidence
    public init(meeting: MemoryMeeting, turn: TranscriptTurn) throws {
        title = meeting.title; date = meeting.createdAt; localeID = meeting.localeID
        context = meeting.memory.context; incomplete = meeting.incomplete
        evidence = try MemoryEvidence(meetingID: meeting.id, turn: turn, quote: turn.text)
    }
}
public struct MemoryHit: Sendable, Identifiable {
    public var id: String { passage.id }
    public let passage: MemoryPassage
    public let score: Double
    public let semantic: Bool
    public init(passage: MemoryPassage, score: Double, semantic: Bool) {
        self.passage = passage; self.score = score; self.semantic = semantic
    }
}
public struct MemorySearchResult: Sendable {
    public let query: String
    public let scope: MemoryScope
    public let hits: [MemoryHit]
    public let searchedMeetings: Int
    public let unavailableMeetings: Int
    public let semanticPassages: Int
    public let totalPassages: Int
    public init(query: String, scope: MemoryScope, hits: [MemoryHit], searchedMeetings: Int, unavailableMeetings: Int, semanticPassages: Int, totalPassages: Int) {
        self.query = query; self.scope = scope; self.hits = hits; self.searchedMeetings = searchedMeetings
        self.unavailableMeetings = unavailableMeetings; self.semanticPassages = semanticPassages; self.totalPassages = totalPassages
    }
}
public struct MemoryActionRow: Identifiable, Sendable {
    public var id: UUID { fact.id }
    public let title: String
    public let meetingID: UUID
    public let recordRevision: Int
    public let fact: MemoryFact
    public let stale: Bool
    public init(meeting: MemoryMeeting, fact: MemoryFact) {
        title = meeting.title; meetingID = meeting.id; recordRevision = meeting.memory.revision
        self.fact = fact; stale = !fact.evidence.isCurrent(in: meeting.transcript)
    }
}

public enum MemoryRules {
    public static func validate(_ fact: MemoryFact) throws {
        guard !fact.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              fact.text.utf8.count <= 4000, fact.owner.utf8.count <= 200 else {
            throw MeetingError.failed("Enter a short description and owner.")
        }
        if let due = fact.dueDate, !validDate(due) { throw MeetingError.failed("Choose a valid due date.") }
        if fact.completed && (fact.review != .confirmed || (fact.kind == .action && fact.commitment != .agreed)) {
            throw MeetingError.failed("Confirm the commitment before marking it complete.")
        }
    }
    public static func validDate(_ value: String) -> Bool {
        let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX")
        parser.calendar = Calendar(identifier: .gregorian); parser.timeZone = TimeZone(secondsFromGMT: 0)
        parser.dateFormat = "yyyy-MM-dd"; parser.isLenient = false
        guard let date = parser.date(from: value) else { return false }
        return parser.string(from: date) == value
    }
    public static func calendarDate(_ value: Date) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: value)
    }
    /// Source-linked, local draft. Opening it does not send, share, or use a cloud provider.
    public static func followUp(_ meeting: MemoryMeeting) -> String {
        let trusted = meeting.trustedFacts.filter { !$0.completed && ($0.kind != .action || $0.commitment == .agreed) }
        var lines = ["Follow-up: \(meeting.title)", "", "Draft for review — nothing has been sent."]
        for kind in MemoryFactKind.allCases {
            let facts = trusted.filter { $0.kind == kind && (kind != .action || $0.commitment == .agreed) }
            guard !facts.isEmpty else { continue }
            lines += ["", "## \(kind.label)"]
            for fact in facts {
                var text = "- \(fact.text)"
                if kind == .action {
                    text += " — \(fact.owner.isEmpty ? "Owner not assigned" : fact.owner)"
                    text += " · \(fact.dueDate ?? "No due date")"
                }
                text += " [\(Meeting.timestamp(fact.evidence.start)) · \(fact.evidence.turnID)]"
                lines.append(text)
            }
        }
        if trusted.isEmpty { lines += ["", "No current, confirmed outcomes or commitments yet."] }
        return lines.joined(separator: "\n")
    }
}

/// Portable lexical ranking; no generated summary prose or cross-scope candidates.
public enum MemoryLexicalRanker {
    public static func tokens(_ text: String) -> [String] {
        text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }
    public static func scores(query: String, passages: [MemoryPassage]) -> [Double] {
        let stopWords: Set<String> = ["what", "when", "where", "who", "how", "did", "do", "does", "the", "a", "an", "is", "are", "was", "were", "we", "i", "to", "of", "and", "about", "in", "on", "for", "our"]
        let words = Set(tokens(query)).subtracting(stopWords); guard !words.isEmpty, !passages.isEmpty else { return Array(repeating: 0, count: passages.count) }
        let documents = passages.map { tokens($0.evidence.originalText) }
        let average = max(1, Double(documents.reduce(0) { $0 + $1.count }) / Double(documents.count))
        var frequency: [String: Int] = [:]
        for document in documents { for word in Set(document) where words.contains(word) { frequency[word, default: 0] += 1 } }
        return documents.enumerated().map { index, document in
            let counts = Dictionary(document.map { ($0, 1) }, uniquingKeysWith: +)
            var score = words.reduce(0.0) { sum, word in
                let tf = Double(counts[word, default: 0]); guard tf > 0 else { return sum }
                let df = Double(frequency[word, default: 0]); let n = Double(documents.count)
                let idf = log(1 + (n - df + 0.5) / (df + 0.5))
                return sum + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * Double(document.count) / average))
            }
            // Preserve exact-phrase matching for scripts without whitespace token boundaries.
            if passages[index].evidence.originalText.localizedCaseInsensitiveContains(query) { score += 2 }
            return score
        }
    }
}
