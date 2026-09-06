import AVFoundation
import SwiftUI

/// Home appears only once the splash and first-run flow have finished, so nothing flips colour scheme underneath.
struct RootView: View {
    @Bindable var model: MeetOddsModel
    @AppStorage("onboardingCompleted") private var onboardingCompleted = false
    @State private var showingOnboarding = !AutomationFixture.enabled
    @State private var replay = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack {
            if showingOnboarding {
                OnboardingView(replay: replay, completed: onboardingCompleted) {
                    onboardingCompleted = true
                    withAnimation(.smooth(duration: 0.7)) { showingOnboarding = false }
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 1.04)))
                .zIndex(1)
            } else {
                HomeView(model: model).transition(.opacity)
            }
        }
        .preferredColorScheme(showingOnboarding ? .dark : nil)
        .onChange(of: onboardingCompleted) { _, done in
            // Settings resets the flag to show the welcome again; wait for its sheet to dismiss first.
            guard !done, !showingOnboarding else { return }
            replay = true
            Task { try? await Task.sleep(for: .seconds(0.45)); withAnimation(.smooth(duration: 0.5)) { showingOnboarding = true } }
        }
    }
}

/// Splash → welcome → microphone → ready. One permission per screen, explained before iOS asks.
struct OnboardingView: View {
    enum Step: Int, Comparable { case splash, welcome, microphone, ready; static func < (a: Step, b: Step) -> Bool { a.rawValue < b.rawValue } }
    enum Microphone { case undetermined, granted, denied }
    var replay = false
    var completed = false
    let finish: () -> Void
    @State private var step: Step
    @State private var revealed = false
    @State private var microphone: Microphone = .undetermined
    @State private var asking = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @AccessibilityFocusState private var focus: Step?

    init(replay: Bool = false, completed: Bool = false, finish: @escaping () -> Void) {
        self.replay = replay; self.completed = completed; self.finish = finish
        _step = State(initialValue: replay ? .welcome : .splash)
        _revealed = State(initialValue: replay)
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                BrandStage(revealed: revealed)
                switch step {
                case .splash, .welcome: welcome(proxy)
                case .microphone: microphonePage.transition(pageTransition)
                case .ready: readyPage.transition(pageTransition)
                }
            }
            .safeAreaInset(edge: .top) { if step > .splash { dots.padding(.top, 12).transition(.opacity) } }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .foregroundStyle(.white)
        .sensoryFeedback(.impact(weight: .light), trigger: step)
        .sensoryFeedback(.success, trigger: microphone == .granted)
        .task {
            microphone = Self.currentMicrophone
            guard step == .splash else { return }
            try? await Task.sleep(for: .seconds(0.15))
            withAnimation(.easeOut(duration: reduceMotion ? 0.3 : 1.0)) { revealed = true }
            try? await Task.sleep(for: .seconds(reduceMotion ? 0.3 : 1.0))
            if completed { finish(); return }
            withAnimation(reduceMotion ? .easeInOut(duration: 0.4) : .spring(duration: 0.8, bounce: 0.18)) { step = .welcome }
            focus = .welcome
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { microphone = Self.currentMicrophone } }
    }

    private static var currentMicrophone: Microphone {
        switch AVAudioApplication.shared.recordPermission { case .granted: .granted; case .denied: .denied; default: .undetermined }
    }
    private var pageTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity))
    }
    private func go(_ next: Step) {
        withAnimation(reduceMotion ? .easeInOut(duration: 0.35) : .spring(duration: 0.6, bounce: 0.12)) { step = next }
        focus = next
    }
    /// Staggered entrance: each block rises a little later than the one above it.
    private func rise(_ order: Double) -> AnyTransition {
        reduceMotion ? .opacity.animation(.easeInOut(duration: 0.4).delay(0.05 * order))
        : .asymmetric(insertion: .opacity.combined(with: .offset(y: 22)).animation(.spring(duration: 0.75, bounce: 0.15).delay(0.12 * order)), removal: .opacity)
    }
    /// Centres content when it fits; scrolls at large Dynamic Type sizes.
    private func fitting<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        ViewThatFits(in: .vertical) { content(); ScrollView { content() }.scrollBounceBehavior(.basedOnSize) }
    }

    // MARK: Pages

    private var dots: some View {
        HStack(spacing: 6) {
            ForEach([Step.welcome, .microphone, .ready], id: \.rawValue) { s in
                Capsule().fill(.white.opacity(s == step ? 0.95 : 0.35)).frame(width: s == step ? 22 : 7, height: 7)
            }
        }
        .animation(.spring(duration: 0.5, bounce: 0.2), value: step)
        .accessibilityElement(children: .ignore).accessibilityLabel("Step \(step.rawValue) of 3")
    }

    private func welcome(_ proxy: GeometryProxy) -> some View {
        fitting {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                BrandMark(listening: step == .splash)
                    .accessibilityAddTraits(.isImage)
                    .padding(.bottom, step == .welcome ? 36 : 0)
                if step == .welcome {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("MeetOdds").font(.system(.title3, design: .rounded, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
                            .transition(rise(0))
                        Text("Every meeting,\nremembered.").font(.system(.largeTitle, design: .rounded, weight: .bold)).tracking(-0.5)
                            .accessibilityAddTraits(.isHeader).accessibilityFocused($focus, equals: .welcome)
                            .transition(rise(1))
                        Text("Record, read it back, get the gist.\nNothing leaves your iPhone.").font(.title3).foregroundStyle(.white.opacity(0.78))
                            .transition(rise(2))
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 28).frame(maxWidth: 560).frame(maxWidth: .infinity)
        }
        // The launch image is centred on the full screen; centre the mark there too until the reveal.
        .offset(y: step == .splash ? (proxy.safeAreaInsets.bottom - proxy.safeAreaInsets.top) / 2 : 0)
        .safeAreaInset(edge: .bottom) {
            if step == .welcome {
                bottomBar { Button("Let’s set up") { go(.microphone) }.buttonStyle(HeroButtonStyle()).accessibilityIdentifier("onboarding-continue") }
                    .transition(rise(3))
            }
        }
    }

    private var microphonePage: some View {
        let symbol = switch microphone { case .undetermined: "mic.fill"; case .granted: "checkmark"; case .denied: "mic.slash.fill" }
        let title = switch microphone { case .undetermined: "First, your microphone."; case .granted: "Microphone is on."; case .denied: "Microphone is off." }
        let text = switch microphone {
        case .undetermined: "MeetOdds listens only while you’re recording, and only to this phone’s mic — never another app’s call. Audio stays here, on your iPhone."
        case .granted: "You can record whenever you’re ready. Audio never leaves this iPhone."
        case .denied: "That’s okay. Earlier meetings, transcripts and summaries still work. To record, turn the microphone on in Settings."
        }
        let tint = switch microphone { case .undetermined: Color.white; case .granted: Brand.barColors[1]; case .denied: Brand.barColors[6] }
        return page(symbol: symbol, tint: tint, title: title, text: text, step: .microphone) { EmptyView() } buttons: {
            switch microphone {
            case .undetermined:
                Text("iOS will ask you next.").font(.footnote).foregroundStyle(.white.opacity(0.6)).padding(.bottom, 4)
                Button(asking ? "Asking…" : "Allow microphone") { ask() }.buttonStyle(HeroButtonStyle()).disabled(asking)
                    .accessibilityIdentifier("onboarding-allow-microphone")
                Button("Not now") { go(.ready) }.buttonStyle(HeroButtonStyle(prominent: false))
            case .granted:
                Button("Continue") { go(.ready) }.buttonStyle(HeroButtonStyle())
            case .denied:
                Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }.buttonStyle(HeroButtonStyle())
                Button("Continue without recording") { go(.ready) }.buttonStyle(HeroButtonStyle(prominent: false))
            }
        }
    }

    private func ask() {
        asking = true
        Task {
            let granted = await AVAudioApplication.requestRecordPermission()
            withAnimation(.spring(duration: 0.5, bounce: 0.2)) { microphone = granted ? .granted : .denied; asking = false }
            if granted {
                try? await Task.sleep(for: .seconds(0.9))
                if step == .microphone { go(.ready) }
            }
        }
    }

    private var readyPage: some View {
        page(symbol: "waveform", tint: .white, title: "All set.", text: "Press record when the meeting starts. We’ll write it up while you listen.", step: .ready) {
            VStack(alignment: .leading, spacing: 18) {
                row("mic.fill", "Recorded here", "Only this phone’s microphone.", 3)
                row("text.quote", "Transcribed on device", "Nothing is uploaded.", 4)
                row("sparkles", "Summarized your way", "On device, or via your paired Mac.", 5)
            }.padding(.top, 30)
        } buttons: {
            Button("Let’s go") { finish() }.buttonStyle(HeroButtonStyle()).accessibilityIdentifier("onboarding-finish")
        }
    }

    private func row(_ symbol: String, _ title: String, _ detail: String, _ order: Double) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Image(systemName: symbol).font(.body.weight(.semibold)).frame(width: 26).foregroundStyle(Brand.barColors[2])
            VStack(alignment: .leading, spacing: 2) { Text(title).font(.headline); Text(detail).font(.subheadline).foregroundStyle(.white.opacity(0.7)) }
        }
        .accessibilityElement(children: .combine)
        .transition(rise(order))
    }

    /// Shared page chrome: glyph in a glass disc, headline, body, optional extra content, pinned buttons.
    private func page<Extra: View, Buttons: View>(symbol: String, tint: Color, title: String, text: String, step: Step,
                                                  @ViewBuilder extra: () -> Extra, @ViewBuilder buttons: () -> Buttons) -> some View {
        fitting {
            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 24)
                ZStack {
                    Circle().fill(.white.opacity(0.12)).frame(width: 96, height: 96)
                        .overlay(Circle().strokeBorder(.white.opacity(0.18), lineWidth: 1))
                    Image(systemName: symbol).font(.system(size: 40, weight: .medium)).foregroundStyle(tint)
                        .contentTransition(.symbolEffect(.replace.downUp))
                        .symbolEffect(.breathe, options: .repeat(.continuous), isActive: symbol == "mic.fill" && !reduceMotion)
                }
                .accessibilityHidden(true)
                .padding(.bottom, 30).transition(rise(0))
                Text(title).font(.system(.largeTitle, design: .rounded, weight: .bold)).tracking(-0.5)
                    .accessibilityAddTraits(.isHeader).accessibilityFocused($focus, equals: step)
                    .contentTransition(.opacity)
                    .padding(.bottom, 14).transition(rise(1))
                Text(text).font(.title3).foregroundStyle(.white.opacity(0.78))
                    .contentTransition(.opacity)
                    .transition(rise(2))
                extra()
                Spacer(minLength: 24)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 28).frame(maxWidth: 560, alignment: .leading).frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.smooth(duration: 0.45), value: title)
        .safeAreaInset(edge: .bottom) { bottomBar(buttons).transition(rise(3)) }
    }
    /// Pinned actions with a fade behind them, so text scrolling underneath at large type sizes stays legible.
    private func bottomBar<B: View>(@ViewBuilder _ content: () -> B) -> some View {
        VStack(spacing: 8) { content() }
            .padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 8).frame(maxWidth: 560).frame(maxWidth: .infinity)
            .background(LinearGradient(colors: [Brand.ink.opacity(0), Brand.ink.opacity(0.9)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
    }
}
