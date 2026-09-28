import Foundation
import FoundationModels

// Small C ABI for Apple's on-device Foundation Models, following the Apple Speech
// bridge rules: numeric request IDs, one JSON reply per request, and Rust copies the
// JSON before its callback returns. No Rust pointers are retained here.
public typealias IntelligenceCallback = @convention(c) (UInt64, UnsafePointer<CChar>?) -> Void

private func reply(_ callback: IntelligenceCallback?, _ id: UInt64, _ value: [String: Any]) {
    guard let callback,
          let data = try? JSONSerialization.data(withJSONObject: value),
          let json = String(data: data, encoding: .utf8) else { return }
    json.withCString { callback(id, $0) }
}

private func replyError(_ callback: IntelligenceCallback?, _ id: UInt64, _ code: String, _ message: String) {
    reply(callback, id, ["kind": "error", "code": code, "message": message])
}

private func decodeJSON(_ cString: UnsafePointer<CChar>?) -> Any? {
    guard let cString, let data = String(cString: cString).data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data)
}

// Running generations by request ID so Rust can cancel them.
private final class Requests: @unchecked Sendable {
    static let shared = Requests()
    private let lock = NSLock()
    private var tasks: [UInt64: Task<Void, Never>] = [:]
    func install(_ id: UInt64, _ task: Task<Void, Never>) { lock.lock(); tasks[id] = task; lock.unlock() }
    func remove(_ id: UInt64) { lock.lock(); tasks[id] = nil; lock.unlock() }
    func cancel(_ id: UInt64) { lock.lock(); let task = tasks.removeValue(forKey: id); lock.unlock(); task?.cancel() }
}

@available(macOS 26.0, *)
private func unavailableReason(_ availability: SystemLanguageModel.Availability) -> String? {
    switch availability {
    case .available: return nil
    case .unavailable(.deviceNotEligible): return "This Mac doesn't support Apple Intelligence."
    case .unavailable(.appleIntelligenceNotEnabled): return "Apple Intelligence is turned off. Turn it on in System Settings → Apple Intelligence & Siri."
    case .unavailable(.modelNotReady): return "Apple Intelligence is still downloading or preparing its model. Try again later."
    default: return "Apple Intelligence is unavailable on this Mac."
    }
}

@available(macOS 26.0, *)
private func model() -> SystemLanguageModel {
    // Meeting text is summarized/transformed, not free-form chat; the permissive
    // content-transformation guardrails avoid false refusals on ordinary meetings.
    SystemLanguageModel(guardrails: .permissiveContentTransformations)
}

@available(macOS 26.0, *)
private func errorReply(_ error: Error) -> (String, String) {
    if error is CancellationError { return ("cancelled", "Apple Intelligence request was cancelled.") }
    let language = ("language", "Apple Intelligence doesn't support this meeting's language. Choose ChatGPT in Settings → Summary.")
    let refused = ("refused", "Apple Intelligence declined to process this text. Choose ChatGPT in Settings → Summary for this meeting.")
    let busy = ("busy", "Apple Intelligence is rate limited right now (keep MeetOdds in the foreground and try again).")
    let context = ("context", "The text is too long for Apple Intelligence's context window.")
    // macOS 27 reports LanguageModelError; macOS 26 reports GenerationError.
    if #available(macOS 27.0, *), let error = error as? LanguageModelError {
        switch error {
        case .contextSizeExceeded: return context
        case .unsupportedLanguageOrLocale: return language
        case .guardrailViolation, .refusal: return refused
        case .rateLimited: return busy
        default: break
        }
    }
    if let error = error as? LanguageModelSession.GenerationError {
        switch error {
        case .exceededContextWindowSize: return context
        case .unsupportedLanguageOrLocale: return language
        case .guardrailViolation, .refusal: return refused
        case .rateLimited: return busy
        case .assetsUnavailable: return ("unavailable", "Apple Intelligence's model isn't ready. Try again later.")
        default: break
        }
    }
    return ("failed", "Apple Intelligence could not complete this request.")
}

@_cdecl("md_ai_status")
public func md_ai_status(_ id: UInt64, _ callback: IntelligenceCallback?) {
    guard #available(macOS 26.0, *) else {
        reply(callback, id, ["kind": "status", "available": false, "reason": "Apple Intelligence requires macOS 26 or later.", "contextSize": 0, "languages": []])
        return
    }
    let system = model()
    let reason = unavailableReason(system.availability)
    let languages = Set(system.supportedLanguages.compactMap { $0.languageCode?.identifier }).sorted()
    reply(callback, id, ["kind": "status", "available": reason == nil, "reason": reason ?? NSNull(), "contextSize": system.contextSize, "languages": languages])
}

/// Input: JSON array of strings. Reply: counts in the same order.
@_cdecl("md_ai_token_counts")
public func md_ai_token_counts(_ id: UInt64, _ json: UnsafePointer<CChar>?, _ callback: IntelligenceCallback?) {
    guard let texts = decodeJSON(json) as? [String] else { replyError(callback, id, "invalid", "Invalid token count request."); return }
    let task = Task {
        defer { Requests.shared.remove(id) }
        var counts: [Int] = []
        counts.reserveCapacity(texts.count)
        for text in texts {
            if Task.isCancelled { return }
            if #available(macOS 26.4, *) {
                do { counts.append(try await model().tokenCount(for: text)) } catch {
                    let (code, message) = errorReply(error); replyError(callback, id, code, message); return
                }
            } else {
                // ponytail: macOS 26.0-26.3 lack tokenCount; 2 UTF-8 bytes per token
                // over-counts English and CJK, so chunks stay inside the context.
                counts.append(text.utf8.count / 2 + 1)
            }
        }
        reply(callback, id, ["kind": "tokens", "counts": counts])
    }
    Requests.shared.install(id, task)
}

/// Input: {"instructions", "prompt", "maxTokens"?, "temperature"?}. Reply: {"kind":"text"}.
@_cdecl("md_ai_generate")
public func md_ai_generate(_ id: UInt64, _ json: UnsafePointer<CChar>?, _ callback: IntelligenceCallback?) {
    guard let request = decodeJSON(json) as? [String: Any],
          let instructions = request["instructions"] as? String,
          let prompt = request["prompt"] as? String else { replyError(callback, id, "invalid", "Invalid Apple Intelligence request."); return }
    let maxTokens = request["maxTokens"] as? Int
    let temperature = request["temperature"] as? Double
    let task = Task {
        defer { Requests.shared.remove(id) }
        guard #available(macOS 26.0, *) else { replyError(callback, id, "unavailable", "Apple Intelligence requires macOS 26 or later."); return }
        let system = model()
        if let reason = unavailableReason(system.availability) { replyError(callback, id, "unavailable", reason); return }
        do {
            let session = LanguageModelSession(model: system, instructions: instructions.isEmpty ? nil : instructions)
            let options = GenerationOptions(temperature: temperature, maximumResponseTokens: maxTokens)
            let response = try await session.respond(to: prompt, options: options)
            if Task.isCancelled { return }
            reply(callback, id, ["kind": "text", "text": response.content])
        } catch {
            if Task.isCancelled { return }
            let (code, message) = errorReply(error)
            replyError(callback, id, code, message)
        }
    }
    Requests.shared.install(id, task)
}

@_cdecl("md_ai_cancel") public func md_ai_cancel(_ id: UInt64) { Requests.shared.cancel(id) }
