import ActivityKit
import Foundation

@MainActor final class RecordingActivity {
    private var activity: Activity<RecordingActivityAttributes>?
    private var lastUpdate = Date.distantPast
    func begin(id: UUID) throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = RecordingActivityAttributes.ContentState(phase: "Recording", anchor: Date(), elapsed: 0)
        activity = try Activity.request(attributes: RecordingActivityAttributes(meetingID: id.uuidString), content: ActivityContent(state: state, staleDate: Date().addingTimeInterval(60)), pushType: nil)
        lastUpdate = Date()
    }
    func update(phase: String, duration: Double, force: Bool = false) async {
        guard let activity, force || Date().timeIntervalSince(lastUpdate) >= 20 else { return }
        lastUpdate = Date()
        let state = RecordingActivityAttributes.ContentState(phase: phase, anchor: Date().addingTimeInterval(-duration), elapsed: duration)
        await activity.update(ActivityContent(state: state, staleDate: Date().addingTimeInterval(60)))
    }
    func end(duration: Double) async {
        guard let activity else { return }
        await activity.end(ActivityContent(state: .init(phase: "Saved", anchor: Date(), elapsed: duration), staleDate: nil), dismissalPolicy: .immediate)
        self.activity = nil
    }
    func clearOrphans() async {
        for activity in Activity<RecordingActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}
