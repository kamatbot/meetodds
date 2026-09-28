import AVFoundation
import CoreMedia
import Foundation
import Speech
import Darwin

// This is deliberately a small C ABI. Rust owns callback routing and must copy the
// JSON before returning from its callback; no Rust pointers are retained here.
public typealias SpeechCallback = @convention(c) (UInt64, UnsafePointer<CChar>?) -> Void

private func emit(_ callback: SpeechCallback?, _ id: UInt64, _ value: [String: Any]) {
    guard let callback,
          let data = try? JSONSerialization.data(withJSONObject: value),
          let json = String(data: data, encoding: .utf8) else { return }
    json.withCString { callback(id, $0) }
}

private func emitError(_ callback: SpeechCallback?, _ id: UInt64, _ message: String) {
    emit(callback, id, ["kind": "error", "message": message])
}

private func isAppleSilicon() -> Bool {
    var value: Int32 = 0
    var size = MemoryLayout.size(ofValue: value)
    return sysctlbyname("hw.optional.arm64", &value, &size, nil, 0) == 0 && value == 1
}

private func isSupportedRuntime() -> Bool {
    guard #available(macOS 26.0, *) else { return false }
    return isAppleSilicon() && SpeechTranscriber.isAvailable
}

private final class Session: @unchecked Sendable {
    struct Frame: Sendable {
        let samples: [Float]
        let sampleRate: Double
        let timestamp: Double
    }

    /// Input is bounded by queued audio time, not frame count, so any callback size
    /// gets the same headroom. Rust restarts the session when this fills.
    static let maxQueuedSeconds = 10.0

    let id: UInt64
    let callback: SpeechCallback?
    private let lock = NSLock()
    private let deliveryLock = NSLock()
    private var continuation: AsyncStream<Frame>.Continuation?
    private var task: Task<Void, Never>?
    private var terminal = false
    private var acceptedFrames = 0
    private var queuedSeconds = 0.0
    private var inputFinished = false
    // This state is touched by the one ordered stream-consumer task only.
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private var needsInputAnchor = true

    init(id: UInt64, callback: SpeechCallback?) {
        self.id = id
        self.callback = callback
    }

    func start(localeID: String) {
        lock.lock()
        guard !terminal, task == nil else { lock.unlock(); return }
        let (stream, continuation) = AsyncStream<Frame>.makeStream(bufferingPolicy: .unbounded)
        self.continuation = continuation
        task = Task { [weak self] in await self?.run(stream: stream, localeID: localeID) }
        lock.unlock()
    }

    // The C pointer is copied before this method returns. Returns 0 = accepted,
    // 1 = queue full (not accepted; the session keeps running), 2 = closed/invalid.
    func push(samples: UnsafePointer<Float>?, count: UInt32, sampleRate: UInt32, timestamp: Double) -> Int32 {
        guard let samples, count > 0, sampleRate > 0, timestamp.isFinite, timestamp >= 0 else { return 2 }
        let duration = Double(count) / Double(sampleRate)
        let copied = Array(UnsafeBufferPointer(start: samples, count: Int(count)))
        lock.lock()
        guard !terminal, let continuation else { lock.unlock(); return 2 }
        // An empty queue always accepts, so one long batch buffer still fits.
        if queuedSeconds > 0, queuedSeconds + duration > Session.maxQueuedSeconds { lock.unlock(); return 1 }
        guard case .enqueued = continuation.yield(Frame(samples: copied, sampleRate: Double(sampleRate), timestamp: timestamp)) else {
            lock.unlock(); return 2
        }
        acceptedFrames += 1; queuedSeconds += duration
        lock.unlock()
        return 0
    }

    func finish() {
        deliveryLock.lock()
        lock.lock(); guard !terminal else { lock.unlock(); deliveryLock.unlock(); return }
        inputFinished = true; continuation?.finish(); continuation = nil
        if acceptedFrames == 0 {
            terminal = true; let running = task; task = nil; lock.unlock()
            running?.cancel()
            emit(callback, id, ["kind": "finished"])
            SpeechSessions.shared.remove(id, matching: self)
        } else { lock.unlock() }
        deliveryLock.unlock()
    }

    func cancel() {
        deliveryLock.lock()
        lock.lock()
        guard !terminal else { lock.unlock(); deliveryLock.unlock(); return }
        terminal = true; continuation?.finish(); continuation = nil
        let running = task; task = nil
        lock.unlock()
        running?.cancel()
        SpeechSessions.shared.remove(id, matching: self)
        deliveryLock.unlock()
    }

    private func complete() {
        deliveryLock.lock()
        lock.lock(); guard !terminal else { lock.unlock(); deliveryLock.unlock(); return }
        terminal = true; continuation = nil; task = nil; lock.unlock()
        emit(callback, id, ["kind": "finished"])
        SpeechSessions.shared.remove(id, matching: self)
        deliveryLock.unlock()
    }

    private func fail(_ message: String) {
        deliveryLock.lock()
        lock.lock(); guard !terminal else { lock.unlock(); deliveryLock.unlock(); return }
        terminal = true; continuation?.finish(); continuation = nil; let running = task; task = nil; lock.unlock()
        emitError(callback, id, message)
        emit(callback, id, ["kind": "finished"])
        SpeechSessions.shared.remove(id, matching: self)
        deliveryLock.unlock()
        running?.cancel()
    }

    @available(macOS 26.0, *)
    private func emitResult(_ result: SpeechTranscriber.Result) {
        deliveryLock.lock()
        lock.lock(); let open = !terminal; lock.unlock()
        guard open else { deliveryLock.unlock(); return }
        let start = result.range.start.seconds, end = result.range.end.seconds
        if start.isFinite, end.isFinite, start >= 0, end >= start {
            emit(callback, id, ["kind": "result", "text": String(result.text.characters), "start": start, "end": end, "isFinal": result.isFinal])
        }
        deliveryLock.unlock()
    }

    private func emitReady(_ locale: String) {
        deliveryLock.lock()
        lock.lock(); let open = !terminal; lock.unlock()
        if open { emit(callback, id, ["kind": "ready", "locale": locale]) }
        deliveryLock.unlock()
    }

    @available(macOS 26.0, *)
    private func runAvailable(stream: AsyncStream<Frame>, localeID: String) async throws {
        guard isSupportedRuntime() else { throw BridgeError.unsupported }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeID)) else {
            throw BridgeError.localeUnavailable
        }
        guard await SpeechTranscriber.installedLocales.contains(where: { $0.identifier == locale.identifier }) else {
            throw BridgeError.localeUnavailable
        }
        let transcriber = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
        guard let outputFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw BridgeError.notReady
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let reader = Task { [weak self] () throws in
            for try await result in transcriber.results {
                self?.emitResult(result)
            }
        }
        defer { reader.cancel() }
        try await withTaskCancellationHandler(operation: {
            try await analyzer.start(inputSequence: stream.map { frame in
                try self.makeInput(frame, outputFormat: outputFormat)
            })
            emitReady(locale.identifier)
            if finishedWithoutFrames {
                await analyzer.cancelAndFinishNow()
                return
            }
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            try await reader.value
        }, onCancel: {
            Task { await analyzer.cancelAndFinishNow() }
        })
    }

    private var isTerminal: Bool { lock.lock(); defer { lock.unlock() }; return terminal }
    private var finishedWithoutFrames: Bool { lock.lock(); defer { lock.unlock() }; return inputFinished && acceptedFrames == 0 }

    @available(macOS 26.0, *)
    private func makeInput(_ frame: Frame, outputFormat: AVAudioFormat) throws -> AnalyzerInput {
        lock.lock(); queuedSeconds -= Double(frame.samples.count) / frame.sampleRate; lock.unlock()
        guard let inputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: frame.sampleRate, channels: 1, interleaved: false),
              let source = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(frame.samples.count)) else { throw BridgeError.conversion }
        source.frameLength = source.frameCapacity
        frame.samples.withUnsafeBufferPointer { input in source.floatChannelData![0].update(from: input.baseAddress!, count: input.count) }
        let buffer: AVAudioPCMBuffer
        if inputFormat == outputFormat { buffer = source } else {
            if converter == nil || converterInputFormat != inputFormat {
                converter = AVAudioConverter(from: inputFormat, to: outputFormat)
                converterInputFormat = inputFormat
                converter?.primeMethod = .none
            }
            guard let converter,
                  let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(ceil(Double(source.frameLength) * outputFormat.sampleRate / inputFormat.sampleRate))) else { throw BridgeError.conversion }
            var supplied = false; var conversionError: NSError?
            let status = converter.convert(to: converted, error: &conversionError) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true; status.pointee = .haveData; return source
            }
            if conversionError != nil || status == .error { throw BridgeError.conversion }
            buffer = converted
        }
        // The analyzer advances ordinary contiguous buffers by their exact decoded
        // frame length. Supplying independently rounded timestamps for every
        // converted chunk can create overlaps; retain an explicit source anchor
        // only for the first chunk of a continuous session. Rust splices skipped audio out
        // of this timeline (the analyzer mis-hears speech after a jump) and maps back.
        let timestamp: CMTime? = needsInputAnchor ? CMTime(seconds: frame.timestamp, preferredTimescale: 48_000) : nil
        needsInputAnchor = false
        return AnalyzerInput(buffer: buffer, bufferStartTime: timestamp)
    }

    private func run(stream: AsyncStream<Frame>, localeID: String) async {
        do {
            guard #available(macOS 26.0, *) else { throw BridgeError.unsupported }
            try await runAvailable(stream: stream, localeID: localeID)
            complete()
        } catch is CancellationError {
            // cancel() has already made the session terminal and intentionally emits nothing.
        } catch { fail((error as? BridgeError)?.message ?? "Apple local speech transcription failed: \(error.localizedDescription)") }
    }
}

private enum BridgeError: Error { case unsupported, localeUnavailable, notReady, conversion
    var message: String { switch self {
    case .unsupported: return "Apple local speech requires macOS 26 or later on Apple Silicon."
    case .localeUnavailable: return "This locale is unsupported or its local speech assets are not installed."
    case .notReady: return "The local speech model is not ready. Install it with prepare before starting."
    case .conversion: return "Unable to convert audio for Apple local speech transcription."
    }}
}

private final class SpeechSessions: @unchecked Sendable {
    static let shared = SpeechSessions()
    private let lock = NSLock()
    private var sessions: [UInt64: Session] = [:]
    func install(_ session: Session) { lock.lock(); sessions[session.id] = session; lock.unlock() }
    func session(_ id: UInt64) -> Session? { lock.lock(); defer { lock.unlock() }; return sessions[id] }
    func remove(_ id: UInt64, matching session: Session) { lock.lock(); if sessions[id] === session { sessions[id] = nil }; lock.unlock() }
}

@_cdecl("md_speech_capabilities")
public func md_speech_capabilities(_ id: UInt64, _ callback: SpeechCallback?) {
    Task {
        guard #available(macOS 26.0, *) else { emit(callback, id, ["kind": "capabilities", "available": false, "reason": "Apple local speech requires macOS 26 or later.", "locales": []]); return }
        guard isAppleSilicon(), SpeechTranscriber.isAvailable else { emit(callback, id, ["kind": "capabilities", "available": false, "reason": "Apple local speech is unavailable on this Mac.", "locales": []]); return }
        let installed = Set((await SpeechTranscriber.installedLocales).map(\.identifier))
        let locales: [[String: Any]] = await SpeechTranscriber.supportedLocales.map { locale in
            ["id": locale.identifier, "name": Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier, "installed": installed.contains(locale.identifier)]
        }
        emit(callback, id, ["kind": "capabilities", "available": true, "reason": NSNull(), "locales": locales])
    }
}

@_cdecl("md_speech_prepare")
public func md_speech_prepare(_ id: UInt64, _ localeCString: UnsafePointer<CChar>?, _ download: Bool, _ callback: SpeechCallback?) {
    let localeID = localeCString.map(String.init(cString:)) ?? ""
    Task {
        guard #available(macOS 26.0, *), isSupportedRuntime(), let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeID)) else { emitError(callback, id, "This locale is unsupported or Apple local speech is unavailable."); return }
        let transcriber = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
        do {
            if download, let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() }
            guard await SpeechTranscriber.installedLocales.contains(where: { $0.identifier == locale.identifier }) else { throw BridgeError.localeUnavailable }
            guard await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) != nil else { throw BridgeError.notReady }
            emit(callback, id, ["kind": "ready", "locale": locale.identifier])
        } catch { emitError(callback, id, (error as? BridgeError)?.message ?? "Unable to prepare Apple local speech assets.") }
    }
}

@_cdecl("md_speech_start")
public func md_speech_start(_ id: UInt64, _ localeCString: UnsafePointer<CChar>?, _ callback: SpeechCallback?) {
    let localeID = localeCString.map(String.init(cString:)) ?? ""
    guard isSupportedRuntime() else { emitError(callback, id, "Apple local speech requires macOS 26 or later on Apple Silicon."); emit(callback, id, ["kind": "finished"]); return }
    let session = Session(id: id, callback: callback)
    SpeechSessions.shared.install(session)
    session.start(localeID: localeID)
}

@_cdecl("md_speech_push")
public func md_speech_push(_ id: UInt64, _ samples: UnsafePointer<Float>?, _ count: UInt32, _ sampleRate: UInt32, _ timestamp: Double) -> Int32 {
    return SpeechSessions.shared.session(id)?.push(samples: samples, count: count, sampleRate: sampleRate, timestamp: timestamp) ?? 2
}

@_cdecl("md_speech_finish") public func md_speech_finish(_ id: UInt64) { SpeechSessions.shared.session(id)?.finish() }
@_cdecl("md_speech_cancel") public func md_speech_cancel(_ id: UInt64) { SpeechSessions.shared.session(id)?.cancel() }
