import AVFoundation
import Foundation
import MeetOddsCore

struct PCMFrame: @unchecked Sendable { let buffer: AVAudioPCMBuffer; let start: Double }
enum CaptureEvent: Sendable {
    case level(Float, Double)
    case failed(String)
    case transcriptLagged
}

/// The audio callback only copies into a bounded queue. File writes and analysis never run on it.
final class AudioCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let writer = DispatchQueue(label: "com.meetodds.audio-writer", qos: .userInitiated)
    private let capacity = DispatchSemaphore(value: 12)
    private let lock = NSLock()
    private var accepting = false
    private var paused = false
    private var failed = false
    private var file: AVAudioFile?
    private var fileURL: URL?
    private var segment = 0
    private var segmentStart = 0.0
    private var duration = 0.0
    private var lastSync = 0.0
    private var lastMeter = 0.0
    private var sendingSpeech = true
    private var continuation: AsyncStream<PCMFrame>.Continuation?
    private var folder: URL?
    private let event: @Sendable (CaptureEvent) -> Void
    init(event: @escaping @Sendable (CaptureEvent) -> Void) { self.event = event }

    @MainActor func start(folder: URL) throws -> AsyncStream<PCMFrame> {
        let free = try folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
        if let free, free < 100_000_000 { throw MeetingError.failed("Free at least 100 MB before recording. Nothing has started.") }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)
        self.folder = folder
        let stream = AsyncStream<PCMFrame>(bufferingPolicy: .bufferingOldest(48)) { self.continuation = $0 }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw MeetingError.failed("No microphone is available.") }
        lock.withLock { accepting = true; paused = false; failed = false }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in self?.enqueue(buffer) }
        do { engine.prepare(); try engine.start() }
        catch { input.removeTap(onBus: 0); lock.withLock { accepting = false }; continuation?.finish(); throw error }
        return stream
    }
    private func enqueue(_ buffer: AVAudioPCMBuffer) {
        guard lock.withLock({ accepting && !paused && !failed }) else { return }
        guard capacity.wait(timeout: .now()) == .success else { fail("Storage cannot keep up. Recording stopped; existing audio is retained."); return }
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
            capacity.signal(); fail("Not enough memory to keep recording safely."); return
        }
        copy.frameLength = buffer.frameLength
        let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
        let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in 0..<min(source.count, destination.count) {
            if let from = source[index].mData, let to = destination[index].mData {
                memcpy(to, from, Int(source[index].mDataByteSize))
            }
        }
        writer.async { [self] in
            defer { capacity.signal() }
            guard !lock.withLock({ failed }) else { return }
            do { try write(copy) }
            catch { fail("Audio could not be saved. Check free storage. Earlier segments are retained.") }
        }
    }
    private func write(_ buffer: AVAudioPCMBuffer) throws {
        guard let folder else { throw MeetingError.missing }
        if file == nil || duration - segmentStart >= 30 || file?.processingFormat != buffer.format {
            try closeSegment()
            fileURL = folder.appendingPathComponent(String(format: "audio-%06d.caf", segment))
            segment += 1; segmentStart = duration
            guard let fileURL, !FileManager.default.fileExists(atPath: fileURL.path) else { throw MeetingError.conflict }
            file = try AVAudioFile(forWriting: fileURL, settings: buffer.format.settings, commonFormat: buffer.format.commonFormat, interleaved: buffer.format.isInterleaved)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: fileURL.path)
        }
        let start = duration
        try file?.write(from: buffer)
        duration += Double(buffer.frameLength) / buffer.format.sampleRate
        if duration - lastSync >= 2 { try sync(); lastSync = duration }
        // Optional transcription can fail or fall behind without blocking durable capture.
        if sendingSpeech, let continuation {
            if case .dropped = continuation.yield(PCMFrame(buffer: buffer, start: start)) {
                sendingSpeech = false; continuation.finish(); event(.transcriptLagged)
            }
        }
        if duration - lastMeter >= 0.12 {
            lastMeter = duration
            var sum: Float = 0
            if let samples = buffer.floatChannelData?[0] {
                for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
            }
            let rms = sqrt(sum / Float(max(1, buffer.frameLength)))
            event(.level(min(1, max(0, rms * 8)), duration))
        }
    }
    private func sync() throws {
        guard let fileURL else { return }
        let handle = try FileHandle(forWritingTo: fileURL)
        defer { try? handle.close() }; try handle.synchronize()
    }
    private func closeSegment() throws { file = nil; try sync() }
    private func fail(_ message: String) {
        let first = lock.withLock { () -> Bool in if failed { return false }; failed = true; accepting = false; return true }
        if first { event(.failed(message)) }
    }
    @MainActor func pause() { lock.withLock { paused = true }; engine.pause() }
    @MainActor func resume() throws {
        guard !lock.withLock({ failed }) else { throw MeetingError.failed("This recording needs recovery before it can continue.") }
        // Route changes require a new tap/format. The owner ends the session rather than guessing.
        try AVAudioSession.sharedInstance().setActive(true)
        try engine.start(); lock.withLock { paused = false }
    }
    @MainActor func stop() async throws -> Double {
        lock.withLock { accepting = false }
        engine.stop(); engine.inputNode.removeTap(onBus: 0)
        let result: Double = try await withCheckedThrowingContinuation { reply in
            writer.async { [self] in
                continuation?.finish(); continuation = nil
                do { try closeSegment(); reply.resume(returning: duration) }
                catch { reply.resume(throwing: error) }
            }
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return result
    }
}
