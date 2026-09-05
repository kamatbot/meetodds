import AVFoundation
import CoreMedia
import Speech
import MeetOddsCore

/// Apple SpeechAnalyzer does continuous on-device ASR, not a server-backed dictation request.
actor LocalTranscription {
    private var analyzer: SpeechAnalyzer?
    private var converter: AVAudioConverter?
    private var converterFormat: AVAudioFormat?
    private var cancelled = false

    static func prepare(localeID: String) async throws -> SpeechTranscriber {
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeID)) else {
            throw MeetingError.failed("On-device transcription is unavailable for this device or language. The audio is still retained.")
        }
        let module = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
        if let download = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await download.downloadAndInstall()
        }
        try Task.checkCancellation()
        return module
    }
    func cancel() async {
        cancelled = true
        await analyzer?.cancelAndFinishNow()
    }
    func transcribe(frames: AsyncStream<PCMFrame>, localeID: String,
                    result: @escaping @Sendable (TranscriptTurn, Bool) async -> Void) async throws {
        let module = try await Self.prepare(localeID: localeID)
        guard !cancelled else { throw CancellationError() }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw MeetingError.failed("The local speech model is not ready. Retry transcription from the saved audio.")
        }
        let analyzer = SpeechAnalyzer(modules: [module]); self.analyzer = analyzer
        let (inputs, producer) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(48))
        let reader = Task {
            for try await output in module.results {
                let start = output.range.start.seconds; let end = output.range.end.seconds
                guard start.isFinite, end.isFinite, start >= 0, end >= start, end < 315_360_000 else { continue }
                await result(TranscriptTurn(id: "T\(Int64(start * 1000))", start: start, end: end, text: String(output.text.characters)), output.isFinal)
            }
        }
        do {
            try await analyzer.start(inputSequence: inputs)
            for await frame in frames {
                try Task.checkCancellation()
                if cancelled { throw CancellationError() }
                let converted = try convert(frame.buffer, to: format)
                let input = AnalyzerInput(buffer: converted, bufferStartTime: CMTime(seconds: frame.start, preferredTimescale: 48_000))
                if case .dropped = producer.yield(input) { throw MeetingError.failed("Transcription fell behind. Rebuild it from saved audio after recording.") }
            }
            producer.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            try await reader.value
        } catch {
            producer.finish(); await analyzer.cancelAndFinishNow(); reader.cancel(); throw error
        }
        self.analyzer = nil
    }
    private func convert(_ input: AVAudioPCMBuffer, to output: AVAudioFormat) throws -> AVAudioPCMBuffer {
        if input.format == output { return input }
        if converter == nil || converterFormat != input.format {
            converter = AVAudioConverter(from: input.format, to: output)
            converter?.primeMethod = .none; converterFormat = input.format
        }
        guard let converter,
              let buffer = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: AVAudioFrameCount(ceil(Double(input.frameLength) * output.sampleRate / input.format.sampleRate)) + 32) else {
            throw MeetingError.failed("Unable to convert microphone audio for local transcription.")
        }
        var supplied = false; var error: NSError?
        let status = converter.convert(to: buffer, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return input
        }
        if let error { throw error }
        guard status != .error else { throw MeetingError.failed("Speech audio conversion failed.") }
        return buffer
    }
    /// Rebuild from retained CAF segments. No volatile or missing text is invented.
    func rebuild(folder: URL, localeID: String) async throws -> (turns: [TranscriptTurn], duration: Double) {
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("audio-") && $0.pathExtension == "caf" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        var all: [TranscriptTurn] = []; var offset = 0.0
        for url in files {
            try Task.checkCancellation()
            if cancelled { throw CancellationError() }
            let module = try await Self.prepare(localeID: localeID)
            let analyzer = SpeechAnalyzer(modules: [module]); self.analyzer = analyzer
            let base = offset
            let reader = Task { () throws -> [TranscriptTurn] in
                var turns: [TranscriptTurn] = []
                for try await output in module.results where output.isFinal {
                    let start = base + output.range.start.seconds; let end = base + output.range.end.seconds
                    guard start.isFinite, end.isFinite, start >= 0, end >= start, end < 315_360_000 else { continue }
                    turns.append(.init(id: "T\(Int64(start * 1000))", start: start, end: end, text: String(output.text.characters)))
                }
                return turns
            }
            do {
                let file = try AVAudioFile(forReading: url)
                offset += Double(file.length) / file.processingFormat.sampleRate
                try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
                all += try await reader.value
            } catch { await analyzer.cancelAndFinishNow(); reader.cancel(); throw error }
        }
        self.analyzer = nil
        return (all, offset)
    }
}
