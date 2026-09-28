import Foundation
import Translation

// Same small C ABI style as the Apple Speech bridge: numeric request ids, JSON payloads,
// Rust copies each payload before its callback returns. No Rust pointers are retained here.
// Nothing here downloads language assets: sessions are created with `installedSource`.
public typealias TranslationCallback = @convention(c) (UInt64, UnsafePointer<CChar>?) -> Void

private let maxTextBytes = 32_768
private let maxCachedPairs = 4

private func send(_ callback: TranslationCallback?, _ id: UInt64, _ value: [String: Any]) {
    guard let callback,
          let data = try? JSONSerialization.data(withJSONObject: value),
          let json = String(data: data, encoding: .utf8) else { return }
    json.withCString { callback(id, $0) }
}

private func sendError(_ callback: TranslationCallback?, _ id: UInt64, _ code: String, _ message: String) {
    send(callback, id, ["kind": "error", "code": code, "message": message])
}

private func copyString(_ pointer: UnsafePointer<CChar>?) -> String { pointer.map(String.init(cString:)) ?? "" }

@available(macOS 26.0, *)
private func statusName(_ status: LanguageAvailability.Status) -> String {
    switch status {
    case .installed: return "installed"
    case .supported: return "supported"
    case .unsupported: return "unsupported"
    @unknown default: return "unsupported"
    }
}

// One reusable session per language pair: the first request loads the model, later ones reuse it.
@available(macOS 26.0, *)
private final class PairSessions: @unchecked Sendable {
    static let shared = PairSessions()
    private let lock = NSLock()
    private var sessions: [String: TranslationSession] = [:]

    private func key(_ source: Locale.Language, _ target: Locale.Language) -> String {
        "\(source.minimalIdentifier)>\(target.minimalIdentifier)"
    }

    func session(_ source: Locale.Language, _ target: Locale.Language) -> TranslationSession {
        lock.lock(); defer { lock.unlock() }
        if let existing = sessions[key(source, target)] { return existing }
        // ponytail: whole-cache reset when a 5th pair appears; per-pair LRU if users switch pairs often.
        if sessions.count >= maxCachedPairs { sessions.removeAll() }
        // Default strategy on purpose: `.lowLatency` needs its own assets, which
        // Translation Languages settings install separately (measured on macOS 27).
        let created = TranslationSession(installedSource: source, target: target)
        sessions[key(source, target)] = created
        return created
    }

    // A failed session (for example assets removed) is rebuilt on the next request.
    func discard(_ source: Locale.Language, _ target: Locale.Language) {
        lock.lock(); sessions[key(source, target)] = nil; lock.unlock()
    }

    func reset() { lock.lock(); sessions.removeAll(); lock.unlock() }
}

private final class Requests: @unchecked Sendable {
    static let shared = Requests()
    private let lock = NSLock()
    private var tasks: [UInt64: Task<Void, Never>] = [:]

    // Registration happens under the lock, so the task's own removal cannot run first.
    func start(_ id: UInt64, _ body: @escaping @Sendable () async -> Void) {
        lock.lock(); defer { lock.unlock() }
        tasks[id] = Task {
            await body()
            Requests.shared.remove(id)
        }
    }

    func remove(_ id: UInt64) { lock.lock(); tasks[id] = nil; lock.unlock() }

    func cancel(_ id: UInt64) {
        lock.lock(); let task = tasks.removeValue(forKey: id); lock.unlock()
        task?.cancel()
    }
}

@available(macOS 26.0, *)
private func errorCode(_ error: Error) -> String {
    if TranslationError.notInstalled ~= error { return "notInstalled" }
    if TranslationError.unsupportedLanguagePairing ~= error
        || TranslationError.unsupportedSourceLanguage ~= error
        || TranslationError.unsupportedTargetLanguage ~= error { return "unsupported" }
    if error is CancellationError || TranslationError.alreadyCancelled ~= error { return "cancelled" }
    return "failed"
}

/// Availability of a language pair; with `warm`, an installed pair also gets its session
/// created and loaded by translating a fixed word, so the first caption is not served cold.
@_cdecl("md_translation_prepare")
public func md_translation_prepare(_ id: UInt64, _ sourceCString: UnsafePointer<CChar>?, _ targetCString: UnsafePointer<CChar>?, _ warm: Bool, _ callback: TranslationCallback?) {
    let sourceID = copyString(sourceCString), targetID = copyString(targetCString)
    Requests.shared.start(id) {
        guard #available(macOS 26.0, *) else {
            sendError(callback, id, "unavailable", "Apple Translation requires macOS 26 or later."); return
        }
        let source = Locale.Language(identifier: sourceID), target = Locale.Language(identifier: targetID)
        let status = await LanguageAvailability().status(from: source, to: target)
        var warmed = false
        if warm, status == .installed {
            do { _ = try await PairSessions.shared.session(source, target).translate("Hello"); warmed = true }
            catch { PairSessions.shared.discard(source, target) }
        }
        guard !Task.isCancelled else { return }
        send(callback, id, ["kind": "status", "status": statusName(status), "warmed": warmed])
    }
}

@_cdecl("md_translation_translate")
public func md_translation_translate(_ id: UInt64, _ sourceCString: UnsafePointer<CChar>?, _ targetCString: UnsafePointer<CChar>?, _ textCString: UnsafePointer<CChar>?, _ callback: TranslationCallback?) {
    let sourceID = copyString(sourceCString), targetID = copyString(targetCString), text = copyString(textCString)
    guard text.utf8.count <= maxTextBytes else {
        sendError(callback, id, "failed", "Text is too long for one live translation."); return
    }
    Requests.shared.start(id) {
        guard #available(macOS 26.0, *) else {
            sendError(callback, id, "unavailable", "Apple Translation requires macOS 26 or later."); return
        }
        let source = Locale.Language(identifier: sourceID), target = Locale.Language(identifier: targetID)
        do {
            let response = try await PairSessions.shared.session(source, target).translate(text)
            guard !Task.isCancelled else { return }
            send(callback, id, ["kind": "translated", "text": response.targetText])
        } catch {
            guard !Task.isCancelled else { return }
            PairSessions.shared.discard(source, target)
            // The system description names the failure, never the source text.
            sendError(callback, id, errorCode(error), error.localizedDescription)
        }
    }
}

@_cdecl("md_translation_cancel")
public func md_translation_cancel(_ id: UInt64) { Requests.shared.cancel(id) }

/// Drops every cached session; the next request per pair creates a fresh one.
@_cdecl("md_translation_reset")
public func md_translation_reset() {
    guard #available(macOS 26.0, *) else { return }
    PairSessions.shared.reset()
}
