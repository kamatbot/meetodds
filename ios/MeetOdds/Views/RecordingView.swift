import SwiftUI

struct RecordingView: View {
    @Bindable var model: MeetOddsModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(model.phase == .paused ? "PAUSED" : model.phase == .stopping ? "FINISHING" : "RECORDING", systemImage: "circle.fill")
                    .font(.caption.weight(.bold)).tracking(1.4).foregroundStyle(model.phase == .paused ? .orange : .red)
                Spacer(); Image(systemName: "lock.shield").foregroundStyle(.secondary).accessibilityLabel("Audio stays on this device")
            }.padding(26)
            ScrollView {
                VStack(spacing: 26) {
                    VStack(spacing: 10) {
                        Text(Duration.seconds(model.duration).formatted(.time(pattern: .minuteSecond))).font(.system(size: 64, weight: .light, design: .rounded)).monospacedDigit().contentTransition(.numericText())
                        Text(model.phase == .paused ? "Take your time." : "Stay in the conversation.").font(.title3).foregroundStyle(.secondary)
                    }.padding(.top, 28)
                    HStack(alignment: .center, spacing: 7) {
                        ForEach(0..<25, id: \.self) { index in
                            let shape = 0.25 + 0.75 * abs(sin(Double(index) * 0.7))
                            Capsule().fill(model.phase == .paused ? Color.secondary.opacity(0.25) : Color.indigo.opacity(0.4 + Double(model.level) * 0.6))
                                .frame(width: 5, height: 4 + 72 * Double(model.level) * shape)
                        }
                    }.frame(height: 88).animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: model.level)
                    .accessibilityLabel(model.level > 0.02 ? "Microphone signal received" : "Microphone is quiet")
                    if let notice = model.speechNotice { Notice(text: notice) }
                    if let error = model.error { Notice(text: error) }
                    Surface {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("LIVE TRANSCRIPT").font(.caption.weight(.semibold)).tracking(1.2).foregroundStyle(.secondary)
                            if let last = model.meeting?.transcript.last { Text(last.text).font(.body).textSelection(.enabled) }
                            Text(model.preview.isEmpty ? "Listening for the next thought…" : model.preview).foregroundStyle(.secondary)
                            Text("Live text may change. Only finalized text is used in summaries.").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    Text("After recording, use Meeting Memory to find decisions and commitments in the saved transcript.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(.horizontal, 24).frame(maxWidth: 720)
            }
            HStack(spacing: 16) {
                Button { Task { await model.togglePause() } } label: {
                    Label(model.phase == .paused ? "Resume" : "Pause", systemImage: model.phase == .paused ? "play.fill" : "pause.fill").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 18)
                }.buttonStyle(.bordered).buttonBorderShape(.roundedRectangle(radius: 22)).disabled(model.phase == .stopping)
                Button { Task { await model.stop() } } label: {
                    Label(model.phase == .stopping ? "Finishing…" : "Finish", systemImage: "stop.fill").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 18)
                }.buttonStyle(.borderedProminent).buttonBorderShape(.roundedRectangle(radius: 22)).disabled(model.phase == .stopping)
            }.padding(24).frame(maxWidth: 720)
        }
        .background(Color(.systemGroupedBackground)).interactiveDismissDisabled()
    }
}
