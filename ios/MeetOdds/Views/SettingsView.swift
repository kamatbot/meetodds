import Speech
import SwiftUI
import MeetOddsCore

struct SettingsView: View {
    @Bindable var model: MeetOddsModel
    @Environment(\.dismiss) private var dismiss
    @State private var pairingText = ""
    @State private var pairing = false
    @State private var preparingSpeech = false
    @State private var message: String?
    @State private var locales: [Locale] = []
    var body: some View {
        NavigationStack {
            Form {
                Section("On iPhone") {
                    Label("SpeechAnalyzer transcription", systemImage: "waveform")
                    Label("Apple Intelligence summaries", systemImage: "iphone")
                    Text(model.localAvailability ?? "The local summary model is ready.").font(.caption).foregroundStyle(.secondary)
                    if !locales.isEmpty {
                        Picker("Spoken language", selection: $model.localeID) {
                            if !locales.contains(where: { $0.identifier == model.localeID }) { Text(Locale.current.localizedString(forIdentifier: model.localeID) ?? model.localeID).tag(model.localeID) }
                            ForEach(locales, id: \.identifier) { locale in Text(Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier).tag(locale.identifier) }
                        }
                    }
                    Button(preparingSpeech ? "Preparing offline transcription…" : "Prepare transcription for offline use") {
                        preparingSpeech = true
                        Task {
                            do { _ = try await LocalTranscription.prepare(localeID: model.localeID); message = "The transcription model is ready for this language." }
                            catch { message = error.localizedDescription }
                            preparingSpeech = false
                        }
                    }.disabled(preparingSpeech)
                    Text("Speech models may download on first use. Preparing them here avoids setup during an important meeting. Meeting audio is never sent for transcription.").font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    if let configured = model.pairing {
                        Label(configured.url.host ?? "Paired Mac", systemImage: "checkmark.shield")
                        Text("The Mac must be awake and reachable. Your ChatGPT credentials remain on that Mac; this iPhone stores only its pairing key.").font(.caption).foregroundStyle(.secondary)
                        Button("Check connection") { Task { do { try await model.refreshCompanion(); message = "Connected" } catch { message = error.localizedDescription } } }
                        if let status = model.companionStatus {
                            if let plan = status.plan { Text("ChatGPT plan: \(plan)").font(.caption) }
                            Picker("Model", selection: $model.selectedRemoteModel) {
                                Text("Account default").tag(String?.none)
                                ForEach(status.models) { Text($0.name).tag(Optional($0.id)) }
                            }
                        }
                        Button("Forget this Mac", role: .destructive) { model.disconnect() }
                    } else {
                        Text("Run the MeetOdds companion on your Mac, sign in with ChatGPT there, then paste its pairing text below.").font(.subheadline)
                        TextEditor(text: $pairingText).font(.caption.monospaced()).frame(height: 100).autocorrectionDisabled().textInputAutocapitalization(.never).privacySensitive().accessibilityLabel("Companion pairing text")
                        PasteButton(payloadType: String.self) { values in pairingText = values.first ?? "" }
                        Button(pairing ? "Connecting…" : "Pair Mac") {
                            pairing = true
                            Task {
                                do { try await model.pair(pairingText); pairingText = ""; message = "Paired securely" }
                                catch { message = error.localizedDescription }
                                pairing = false
                            }
                        }.disabled(pairing || pairingText.isEmpty)
                    }
                } header: { Text("ChatGPT subscription") } footer: { Text("Uses Codex account access, not OpenAI API credits. No password scraping, shared API key or unapproved fallback.") }
                if let message { Section { Text(message).font(.subheadline).accessibilityAddTraits(.updatesFrequently) } }
                Section("Recording & privacy") {
                    Text("Microphone only. iOS does not give this app access to another app’s call audio. Use it for in-person conversations or permitted speakerphone capture.")
                    Text("Recordings stay in protected, backup-excluded local storage. Deleting a meeting removes its audio, transcript, notes and summaries. Uninstalling the app deletes its local library.")
                    Text("Live Activities show recording state and duration only. They do not keep a terminated app recording; stale activity asks you to reopen the app.")
                }.font(.subheadline)
            }
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { locales = await SpeechTranscriber.supportedLocales.sorted { $0.identifier < $1.identifier } }
        }
    }
}
