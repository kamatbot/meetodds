import Foundation

extension MeetingLibrary {
    /// Reads authoritative folders, not the optional, potentially stale header cache.
    public func memoryMeetingIDs() throws -> [UUID] {
        try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .compactMap { UUID(uuidString: $0.lastPathComponent) }
            .sorted { $0.uuidString < $1.uuidString }
    }
    public func memoryRecord(_ id: UUID) throws -> MeetingMemoryRecord {
        _ = try load(id) // An orphaned sidecar is not a meeting.
        let url = directory(for: id).appendingPathComponent("memory-v1.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return MeetingMemoryRecord(meetingID: id) }
        let record = try JSONDecoder().decode(MeetingMemoryRecord.self, from: Data(contentsOf: url))
        guard record.schemaVersion == 1, record.meetingID == id else {
            throw MeetingError.failed("This meeting’s Memory file uses an unsupported format. It has not been replaced.")
        }
        try record.validate()
        return record
    }
    public func memoryMeeting(_ id: UUID) throws -> MemoryMeeting {
        MemoryMeeting(meeting: try load(id), memory: try memoryRecord(id))
    }
    private func persistMemory(_ proposed: MeetingMemoryRecord, expectedRevision: Int) throws -> MeetingMemoryRecord {
        try Task.checkCancellation()
        let previous = try memoryRecord(proposed.meetingID)
        guard previous.revision == expectedRevision else { throw MeetingError.conflict }
        var next = proposed; next.revision = previous.revision + 1
        try next.validate()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try AtomicFile.write(try encoder.encode(next), to: directory(for: next.meetingID).appendingPathComponent("memory-v1.json"))
        return next
    }
    public func saveMemoryContext(_ context: MemoryContext, meetingID: UUID, expectedRevision: Int) throws -> MeetingMemoryRecord {
        var record = try memoryRecord(meetingID); record.context = MemoryContext(client: context.client, project: context.project)
        return try persistMemory(record, expectedRevision: expectedRevision)
    }
    public func saveMemoryFact(_ fact: MemoryFact, meetingID: UUID, expectedRevision: Int) throws -> MeetingMemoryRecord {
        var record = try memoryRecord(meetingID)
        let meeting = try load(meetingID)
        guard meeting.status != .recording && meeting.status != .paused,
              fact.evidence.meetingID == meetingID else { throw MeetingError.failed("Finish recording before reviewing Memory.") }
        try MemoryRules.validate(fact)
        if fact.review == .confirmed && !fact.evidence.isCurrent(in: meeting.transcript) {
            throw MeetingError.failed("The transcript has changed. Select current evidence before confirming this item.")
        }
        var changed = fact; changed.updatedAt = Date()
        if let index = record.facts.firstIndex(where: { $0.id == fact.id }) {
            guard record.facts[index].evidence == fact.evidence, record.facts[index].kind == fact.kind else {
                throw MeetingError.failed("Evidence cannot be silently replaced. Save a new item against the current transcript.")
            }
            record.facts[index] = changed
        } else {
            guard fact.evidence.isCurrent(in: meeting.transcript), !record.facts.contains(where: { $0.reconciliationKey == fact.reconciliationKey }) else {
                throw MeetingError.conflict
            }
            record.facts.append(changed)
        }
        return try persistMemory(record, expectedRevision: expectedRevision)
    }
    public func mergeMemoryCandidates(_ candidates: [MemoryFact], meetingID: UUID, expectedTranscript: [TranscriptTurn]) throws -> MeetingMemoryRecord {
        let meeting = try load(meetingID)
        guard meeting.transcript == expectedTranscript, meeting.status == .ready, meeting.notices.isEmpty else {
            throw MeetingError.failed("The transcript changed or is incomplete. Your reviewed items remain unchanged.")
        }
        var record = try memoryRecord(meetingID)
        let revision = record.revision
        // Validation precedes persistence. A single invalid proposal cannot create a partial update.
        for fact in candidates {
            try MemoryRules.validate(fact)
            guard fact.evidence.meetingID == meetingID, fact.review == .pending,
                  fact.evidence.isCurrent(in: meeting.transcript) else { throw MeetingError.failed("Generated evidence could not be verified.") }
        }
        record.mergeCandidates(candidates)
        return try persistMemory(record, expectedRevision: revision)
    }
    public func memoryAudioFiles(_ id: UUID) throws -> [URL] {
        _ = try load(id)
        let files = try FileManager.default.contentsOfDirectory(at: directory(for: id), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "caf" && $0.lastPathComponent.hasPrefix("audio-") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        // Missing earlier segments make cumulative timestamp seeking unsafe.
        for (index, file) in files.enumerated() {
            guard file.lastPathComponent == String(format: "audio-%06d.caf", index) else {
                throw MeetingError.failed("An audio segment is missing. Timestamp playback is unavailable; the transcript is retained.")
            }
        }
        return files
    }
}
