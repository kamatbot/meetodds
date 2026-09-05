import Foundation

/// Local, serial, versioned storage. Audio is stored separately and never loaded by list().
public actor MeetingLibrary {
    public let root: URL
    public init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
        var privateRoot = root; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try privateRoot.setResourceValues(values)
        #endif
    }
    public func directory(for id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }
    public func create(_ meeting: Meeting) throws -> Meeting {
        let directory = directory(for: meeting.id)
        guard !FileManager.default.fileExists(atPath: directory.path) else { throw MeetingError.conflict }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try persist(meeting)
        return meeting
    }
    public func load(_ id: UUID) throws -> Meeting {
        let url = directory(for: id).appendingPathComponent("meeting.json")
        guard FileManager.default.fileExists(atPath: url.path) else { throw MeetingError.missing }
        return try JSONDecoder().decode(Meeting.self, from: Data(contentsOf: url))
    }
    @discardableResult public func save(_ meeting: Meeting) throws -> Meeting {
        let previous = try load(meeting.id)
        guard previous.revision == meeting.revision else { throw MeetingError.conflict }
        var next = meeting; next.revision += 1
        try persist(next)
        return next
    }
    private func persist(_ meeting: Meeting) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try AtomicFile.write(try encoder.encode(meeting), to: directory(for: meeting.id).appendingPathComponent("meeting.json"))
        // A header is an optimization, not the authority for recovery or save success.
        try? AtomicFile.write(try encoder.encode(MeetingHeader(meeting)), to: directory(for: meeting.id).appendingPathComponent("header.json"))
    }
    public func list() throws -> [MeetingHeader] {
        var headers: [MeetingHeader] = []
        for folder in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            guard let id = UUID(uuidString: folder.lastPathComponent) else { continue }
            if let data = try? Data(contentsOf: folder.appendingPathComponent("header.json")), let header = try? JSONDecoder().decode(MeetingHeader.self, from: data) {
                headers.append(header)
            } else { headers.append(MeetingHeader(try load(id))) }
        }
        return headers.sorted { $0.createdAt > $1.createdAt }
    }
    public func remove(_ id: UUID) throws { try FileManager.default.removeItem(at: directory(for: id)) }
    public func recoverInterrupted() throws -> [MeetingHeader] {
        // Always inspect authoritative files at launch, including an interruption before header write.
        for folder in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            guard let id = UUID(uuidString: folder.lastPathComponent) else { continue }
            var meeting = try load(id)
            if meeting.status == .recording || meeting.status == .paused {
                meeting.status = .interrupted
                meeting.notices.append("Recording was interrupted. Saved audio remains available; the last unfinished buffer may be missing.")
                _ = try save(meeting)
            }
        }
        return try list()
    }
}
public enum AtomicFile {
    public static func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }
}
