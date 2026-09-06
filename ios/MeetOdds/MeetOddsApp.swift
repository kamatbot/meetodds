import SwiftUI

@main struct MeetOddsApp: App {
    @State private var model = MeetOddsModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .tint(.indigo)
                .task {
                    await model.launch()
                    if AutomationFixture.showsRecording { model.showRecording = true }
                    if AutomationFixture.showsJustRecorded, let id = model.headers.first?.id { model.justRecorded = id; model.path = [id] }
                }
                .onOpenURL { url in
                    // Deep links only reveal existing controls; never start/stop or transmit audio.
                    if url.scheme == "meetodds", url.host == "recording", model.isCapturing { model.showRecording = true }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase != .active { Task { try? await model.flush() } }
                }
        }
    }
}
