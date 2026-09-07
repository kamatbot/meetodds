import AVFoundation
import Foundation
import Observation
import MeetOddsCore

/// Cumulative durations come from the actual CAF assets, not a guessed 30-second split.
@MainActor @Observable final class MeetingEvidencePlayer {
    var playing = false
    var loading = false
    var error: String?
    @ObservationIgnored private var player: AVQueuePlayer?
    @ObservationIgnored private var completionObserver: NSObjectProtocol?
    @ObservationIgnored private var request = UUID()
    @ObservationIgnored private var ownsAudioSession = false
    func stop(deactivateSession: Bool = true) {
        request = UUID(); player?.pause(); player?.removeAllItems(); player = nil
        if let completionObserver { NotificationCenter.default.removeObserver(completionObserver) }
        completionObserver = nil; playing = false; loading = false
        if ownsAudioSession && deactivateSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        ownsAudioSession = false
    }
    func play(_ evidence: MemoryEvidence, library: MeetingLibrary) async {
        stop(); let token = request; loading = true; error = nil
        defer { if request == token { loading = false } }
        do {
            let source = try await library.memoryMeeting(evidence.meetingID)
            guard evidence.isCurrent(in: source.transcript) else { throw MeetingError.failed("This citation refers to an older transcript. Playback is disabled until it is reviewed.") }
            let files = try await library.memoryAudioFiles(evidence.meetingID)
            guard !files.isEmpty else { throw MeetingError.failed("No saved audio is available for this meeting.") }
            var durations: [Double] = []
            for file in files {
                try Task.checkCancellation(); guard request == token else { return }
                let duration = try await AVURLAsset(url: file).load(.duration).seconds
                guard duration.isFinite, duration > 0 else { throw MeetingError.failed("Audio timing is unavailable. No approximate seek was attempted.") }
                durations.append(duration)
            }
            try Task.checkCancellation(); guard request == token else { return }
            let total = durations.reduce(0, +)
            guard evidence.start < total, evidence.end <= total + 0.25 else { throw MeetingError.failed("The citation is outside the retained audio timeline.") }
            let start = max(0, evidence.start - 1.5)
            let end = min(total, evidence.end + 1.5)
            var offset = 0.0; var firstStart = 0.0; var items: [AVPlayerItem] = []
            for (index, duration) in durations.enumerated() {
                let segmentEnd = offset + duration
                if segmentEnd > start && offset < end {
                    let item = AVPlayerItem(url: files[index])
                    if items.isEmpty { firstStart = max(0, start - offset) }
                    item.forwardPlaybackEndTime = CMTime(seconds: min(duration, end - offset), preferredTimescale: 600)
                    items.append(item)
                }
                offset = segmentEnd
            }
            guard !items.isEmpty, let last = items.last else { throw MeetingError.failed("The cited audio could not be located.") }
            try AVAudioSession.sharedInstance().setCategory(.playback)
            try AVAudioSession.sharedInstance().setActive(true)
            ownsAudioSession = true
            let queue = AVQueuePlayer(items: items); player = queue
            completionObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: last, queue: .main) { [weak self] _ in
                Task { @MainActor in if self?.request == token { self?.stop() } }
            }
            let sought = await queue.seek(to: CMTime(seconds: firstStart, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            guard request == token else { return }
            guard sought else { throw MeetingError.failed("Audio seeking failed. Retry playback.") }
            queue.play(); playing = true
        } catch is CancellationError { if request == token { stop() } }
        catch { if request == token { stop(); self.error = error.localizedDescription } }
    }
}
