import AVFoundation
import Foundation
import Observation
import UIKit
import MeetOddsCore

@MainActor @Observable final class MeetOddsModel {
    enum Phase: Equatable { case idle, preparing, recording, paused, stopping }
    var phase: Phase = .idle
    var mode: IntelligenceMode = .local
    var templateID = "standard_meeting"
    var localeID = Locale.current.identifier
    var templates: [MeetingTemplate] = []
    var headers: [MeetingHeader] = []
    var meeting: Meeting?
    var preview = ""
    var level: Float = 0
    var duration = 0.0
    var error: String?
    var noteSaveState = "Saved on \(Brand.device)"
    var summaryProgress: String?
    var pairing: CompanionPairing?
    var companionStatus: CompanionStatus?
    var selectedRemoteModel: String?
    var path: [UUID] = []
    var showRecording = false
    var speechNotice: String?
    var localAvailability: String? { LocalSummary.availabilityMessage }
    var selectedTemplate: MeetingTemplate? { templates.first { $0.id == templateID } }
    var isCapturing: Bool { phase == .recording || phase == .paused }
    var isBusy: Bool { phase != .idle || summaryProgress != nil }
    @ObservationIgnored private var library: MeetingLibrary?
    @ObservationIgnored private var audio: AudioCapture?
    @ObservationIgnored private var speech: LocalTranscription?
    @ObservationIgnored private var speechTask: Task<Void, Never>?
    @ObservationIgnored private var summaryTask: Task<Void, Never>?
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var activity = RecordingActivity()
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var savedGeneration = 0
    @ObservationIgnored private var saving = false
    @ObservationIgnored private var needsRepair = false
    @ObservationIgnored private var launched = false
    @ObservationIgnored private var lastCheckpoint = 0.0

    init() {
        do {
            let root = try AutomationFixture.storageRoot ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("MeetOdds", isDirectory: true)
            library = try MeetingLibrary(root: root)
            let ids = ["standard_meeting", "daily_standup", "mayur_product_review", "mayur_decision_review", "mayur_pm_one_on_one"]
            templates = try ids.map { id in
                guard let url = Bundle.main.url(forResource: id, withExtension: "json", subdirectory: "templates") else { throw MeetingError.failed("Bundled meeting templates are missing.") }
                var template = try JSONDecoder().decode(MeetingTemplate.self, from: Data(contentsOf: url)); template.id = id; return template
            }
        } catch { self.error = error.localizedDescription }
        if !AutomationFixture.enabled { pairing = PairingKeychain.load() }
        observeAudio()
    }
    func launch() async {
        guard !launched else { return }; launched = true
        await activity.clearOrphans()
        do {
            if let library, AutomationFixture.enabled { try await AutomationFixture.install(into: library) }
            headers = try await library?.recoverInterrupted() ?? []
        } catch { self.error = "Some saved meetings could not be read. Their files have not been deleted. \(error.localizedDescription)" }
    }
    func refresh() async { do { headers = try await library?.list() ?? [] } catch { self.error = error.localizedDescription } }
    func open(_ id: UUID) async {
        guard phase == .idle, summaryProgress == nil else { return }
        do {
            try await flush()
            meeting = try await library?.load(id)
            templateID = meeting?.templateID ?? "standard_meeting"; mode = meeting?.mode ?? .local
            generation = 0; savedGeneration = 0; noteSaveState = "Saved on \(Brand.device)"
        } catch { self.error = error.localizedDescription }
    }
    func start() async {
        guard phase == .idle, summaryProgress == nil, let library, selectedTemplate != nil else { return }
        phase = .preparing; error = nil; speechNotice = nil; preview = ""; duration = 0; needsRepair = false; lastCheckpoint = 0
        do {
            try await flush()
            let granted = await AVAudioApplication.requestRecordPermission()
            guard granted else { throw MeetingError.failed("Microphone access is off. Enable it in Settings to record.") }
            let fresh = Meeting(title: Date().formatted(date: .abbreviated, time: .shortened), mode: mode, templateID: templateID, localeID: localeID)
            meeting = try await library.create(fresh); generation = 0; savedGeneration = 0
            let folder = await library.directory(for: fresh.id)
            let capture = AudioCapture { [weak self] event in Task { @MainActor in self?.receive(event) } }
            let frames = try capture.start(folder: folder)
            audio = capture; phase = .recording; showRecording = true
            do { try activity.begin(id: fresh.id) } catch { speechNotice = "Recording is active. Live Activity could not start." }
            let transcriber = LocalTranscription(); speech = transcriber
            speechTask = Task { [weak self] in
                do {
                    try await transcriber.transcribe(frames: frames, localeID: fresh.localeID) { turn, final in
                        await self?.receiveTranscript(turn, final: final, meetingID: fresh.id)
                    }
                } catch {
                    guard let self, self.meeting?.id == fresh.id else { return }
                    self.needsRepair = true; self.speechNotice = "Audio is retained. Live transcription is unavailable; retry from saved audio after recording."
                }
            }
        } catch {
            if let audio { _ = try? await audio.stop() }
            audio = nil; phase = .idle; self.error = error.localizedDescription
            if meeting?.status == .recording { meeting?.status = .interrupted; changed(); try? await flush() }
            await refresh()
        }
    }
    private func receive(_ event: CaptureEvent) {
        switch event {
        case .level(let level, let elapsed):
            guard isCapturing else { return }
            self.level = level; duration = elapsed; meeting?.duration = elapsed
            if elapsed - lastCheckpoint >= 2 { lastCheckpoint = elapsed; changed() }
            Task { await activity.update(phase: phase == .paused ? "Paused" : "Recording", duration: elapsed) }
        case .transcriptLagged:
            needsRepair = true; speechNotice = "Audio capture is continuing. Live transcription fell behind; rebuild it after the meeting."
        case .failed(let message):
            error = message
            Task { await stop(interrupted: true) }
        }
    }
    private func receiveTranscript(_ turn: TranscriptTurn, final: Bool, meetingID: UUID) {
        guard meeting?.id == meetingID else { return }
        if final { meeting?.acceptFinal(turn); preview = ""; changed() } else { preview = turn.text }
    }
    func togglePause() async {
        guard let audio else { return }
        if phase == .recording {
            audio.pause(); phase = .paused; meeting?.status = .paused; level = 0
        } else if phase == .paused {
            do { try audio.resume(); phase = .recording; meeting?.status = .recording }
            catch { self.error = error.localizedDescription; return }
        } else { return }
        changed(); try? await flush()
        await activity.update(phase: phase == .paused ? "Paused" : "Recording", duration: duration, force: true)
    }
    func stop(interrupted: Bool = false) async {
        guard isCapturing, let audio else { return }
        phase = .stopping; level = 0
        var interrupted = interrupted
        do { duration = try await audio.stop() }
        catch { interrupted = true; self.error = "The last audio write failed. Keep this meeting for recovery." }
        self.audio = nil
        await activity.end(duration: duration)
        let transcriber = speech
        let currentSpeechTask = speechTask
        let watchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }
            self?.needsRepair = true; currentSpeechTask?.cancel(); await transcriber?.cancel()
        }
        await currentSpeechTask?.value; watchdog.cancel(); speechTask = nil; speech = nil
        meeting?.duration = duration; meeting?.status = interrupted ? .interrupted : .ready
        if needsRepair { meeting?.notices.append("Live transcription was incomplete. Rebuilding the transcript from the retained audio.") }
        changed()
        do { try await flush() } catch { self.error = error.localizedDescription }
        phase = .idle; showRecording = false; preview = ""
        if let id = meeting?.id { path = [id] }
        await refresh()
        // A transcript the user has to remember to request is a transcript they will not
        // have. When the live pass fell behind, or produced nothing while audio was
        // captured, rebuild from the retained segments now instead of leaving a chore.
        if needsRepair || (meeting?.transcript.isEmpty == true && duration >= 1) { rebuildTranscript() }
    }
    func editNotes(_ notes: String) { meeting?.notes = notes; changed() }
    func editTitle(_ title: String) { meeting?.title = title; changed() }
    private func changed() {
        generation += 1; noteSaveState = "Saving…"
        guard saveTask == nil else { return }
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(650))
            guard let self else { return }
            self.saveTask = nil
            do { try await self.flush() } catch { self.error = error.localizedDescription }
        }
    }
    func flush() async throws {
        while saving { try await Task.sleep(for: .milliseconds(20)) }
        guard let library else { throw MeetingError.failed("Local storage is unavailable.") }
        saving = true; defer { saving = false }
        do {
            while savedGeneration < generation, let snapshot = meeting {
                let target = generation
                let saved = try await library.save(snapshot)
                guard meeting?.id == saved.id else { throw MeetingError.conflict }
                meeting?.revision = saved.revision; savedGeneration = target
            }
            noteSaveState = "Saved on \(Brand.device)"
        } catch { noteSaveState = "Save failed · retry"; throw error }
    }
    func rebuildTranscript() {
        guard !isBusy, let snapshot = meeting, let library else { return }
        summaryProgress = "Rebuilding transcript on \(Brand.device)…"
        summaryTask = Task { [weak self] in
            guard let self else { return }
            let transcriber = LocalTranscription()
            do {
                let folder = await library.directory(for: snapshot.id)
                let result = try await withTaskCancellationHandler {
                    try await transcriber.rebuild(folder: folder, localeID: snapshot.localeID)
                } onCancel: { Task { await transcriber.cancel() } }
                try Task.checkCancellation()
                guard !result.turns.isEmpty else { throw MeetingError.failed("No speech could be recovered. Your previous transcript and audio are unchanged.") }
                self.meeting?.transcript = result.turns; self.meeting?.duration = result.duration
                self.meeting?.status = .ready; self.meeting?.notices = []
                self.needsRepair = false; self.speechNotice = nil
                self.changed(); try await self.flush(); await self.refresh()
            } catch is CancellationError { } catch { self.error = error.localizedDescription }
            await transcriber.cancel()
            self.summaryProgress = nil; self.summaryTask = nil
        }
    }
    func summarize(includeNotes: Bool) {
        guard !isBusy, let template = selectedTemplate else { return }
        let requestedMode = mode; let requestedPairing = pairing; let requestedModel = selectedRemoteModel
        summaryProgress = "Preparing summary…"
        summaryTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.flush()
                guard let snapshot = self.meeting else { throw MeetingError.missing }
                guard snapshot.status == .ready && snapshot.notices.isEmpty else { throw MeetingError.failed("Rebuild the incomplete transcript from saved audio before summarizing. Your prior summaries remain available.") }
                let input = try SummaryInput.build(meeting: snapshot, includeNotes: includeNotes)
                let markdown: String
                if requestedMode == .local {
                    markdown = try await LocalSummary().generate(input: input, template: template) { message in await MainActor.run { self.summaryProgress = message } }
                } else {
                    guard let pairing = requestedPairing else { throw MeetingError.failed("Pair your Mac to use your ChatGPT subscription, or choose On \(Brand.device).") }
                    self.summaryProgress = "Summarizing with ChatGPT…"
                    markdown = try await CompanionClient(pairing: pairing).summarize(input: input, templateID: template.id, model: requestedModel).markdown
                }
                try Task.checkCancellation()
                guard self.meeting?.id == snapshot.id else { throw MeetingError.conflict }
                guard !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MeetingError.failed("An empty summary was returned. Your previous version is unchanged.") }
                self.meeting?.summaries.append(SummaryVersion(mode: requestedMode, templateID: template.id, markdown: markdown, includesPersonalNotes: includeNotes))
                self.meeting?.mode = requestedMode; self.meeting?.templateID = template.id
                self.changed(); try await self.flush(); await self.refresh()
            } catch is CancellationError { } catch { self.error = error.localizedDescription }
            self.summaryProgress = nil; self.summaryTask = nil
        }
    }
    func cancelSummary() { summaryTask?.cancel() }
    func pair(_ text: String) async throws {
        let next = try CompanionPairing.parse(text)
        let status = try await CompanionClient(pairing: next).status()
        guard status.connected else { throw MeetingError.failed("Sign in to ChatGPT in the MeetOdds companion on your Mac first.") }
        try PairingKeychain.save(next); pairing = next; companionStatus = status
    }
    func refreshCompanion() async throws {
        guard let pairing else { throw MeetingError.invalidPairing }
        companionStatus = try await CompanionClient(pairing: pairing).status()
    }
    func disconnect() { do { try PairingKeychain.remove(); pairing = nil; companionStatus = nil; selectedRemoteModel = nil } catch { self.error = error.localizedDescription } }
    func remove(_ id: UUID) async {
        guard !isBusy else { return }
        do { try await library?.remove(id); if meeting?.id == id { meeting = nil; path = [] }; await refresh() }
        catch { self.error = error.localizedDescription }
    }
    func audioFiles() async throws -> [URL] {
        guard let meeting, let library else { return [] }
        let folder = await library.directory(for: meeting.id)
        return try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).filter { $0.pathExtension == "caf" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
    private func observeAudio() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, type == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in
                guard let self, self.phase == .recording else { return }
                self.speechNotice = "An audio interruption paused recording. Resume when you are ready."
                await self.togglePause()
            }
        })
        for name in [AVAudioSession.routeChangeNotification, AVAudioSession.mediaServicesWereResetNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                if name == AVAudioSession.routeChangeNotification && reason != AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue && reason != AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue { return }
                Task { @MainActor in
                    guard let self, self.isCapturing else { return }
                    self.error = "The audio device changed. This recording was stopped and retained; start a new one with the new microphone."
                    await self.stop(interrupted: true)
                }
            })
        }
    }
}
