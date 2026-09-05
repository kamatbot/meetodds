import ActivityKit
import Foundation

struct RecordingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: String
        var anchor: Date
        var elapsed: Double
    }
    var meetingID: String
    // No transcript, personal notes, meeting title or account details on the lock screen.
}
