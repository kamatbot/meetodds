import ActivityKit
import SwiftUI
import WidgetKit

@main struct MeetOddsWidgets: WidgetBundle {
    var body: some Widget { RecordingWidget() }
}
struct RecordingWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            HStack(spacing: 14) {
                Image(systemName: context.isStale ? "exclamationmark.circle" : "waveform")
                    .font(.title2).foregroundStyle(context.isStale ? .orange : .red)
                VStack(alignment: .leading, spacing: 4) {
                    Text("MeetOdds").font(.headline)
                    Text(context.isStale ? "Open app to check recording" : context.state.phase).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                ActivityTimer(state: context.state, stale: context.isStale).font(.title2.monospacedDigit())
            }
            .padding(20)
            .activityBackgroundTint(Color(.systemBackground))
            .activitySystemActionForegroundColor(.primary)
            .widgetURL(URL(string: "meetodds://recording/\(context.attributes.meetingID)"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Label("MeetOdds", systemImage: "waveform").font(.headline) }
                DynamicIslandExpandedRegion(.trailing) { ActivityTimer(state: context.state, stale: context.isStale).monospacedDigit() }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.isStale ? "Open MeetOdds to verify status" : "\(context.state.phase) · Tap to open controls")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } compactLeading: {
                Image(systemName: context.isStale ? "exclamationmark" : "waveform").foregroundStyle(.red)
            } compactTrailing: {
                ActivityTimer(state: context.state, stale: context.isStale).monospacedDigit().frame(width: 52)
            } minimal: {
                Image(systemName: context.isStale ? "exclamationmark" : "waveform").foregroundStyle(.red)
            }
            .widgetURL(URL(string: "meetodds://recording/\(context.attributes.meetingID)"))
            .keylineTint(.red)
        }
    }
}
private struct ActivityTimer: View {
    let state: RecordingActivityAttributes.ContentState
    let stale: Bool
    var body: some View {
        if state.phase == "Recording" && !stale {
            Text(timerInterval: state.anchor...Date.distantFuture, countsDown: false)
        } else {
            Text(String(format: "%02d:%02d", Int(state.elapsed) / 60, Int(state.elapsed) % 60))
        }
    }
}
