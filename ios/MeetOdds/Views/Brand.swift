import SwiftUI

/// Brand vocabulary shared by the launch screen, splash and onboarding.
/// Geometry and colours mirror `Scripts/make_brand_assets.py`, so the first animated
/// frame of the splash is identical to the static launch image and the hand-off is invisible.
enum Brand {
    /// Copy names the device the user is holding; layout never branches on this.
    @MainActor static var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }
    @MainActor static var deviceSymbol: String { UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone" }
    static let background = Color("LaunchBackground")
    static let violet = Color(hex: 0x6B22D9)
    static let ink = Color(hex: 0x150F5C)
    static let barWidth: CGFloat = 12
    static let barGap: CGFloat = 10
    static let barHeights: [CGFloat] = [22, 42, 66, 92, 66, 42, 22]
    static let barColors: [Color] = [0x5FE9DC, 0x74E7C4, 0x7CC8FF, 0xB2A8FF, 0xD9A7FF, 0xFF9FD0, 0xFFA3A8].map { Color(hex: $0) }
    static var markSize: CGSize { .init(width: CGFloat(barHeights.count) * barWidth + CGFloat(barHeights.count - 1) * barGap, height: barHeights.max() ?? 0) }
}

extension Color {
    init(hex: UInt32) { self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255) }
}

/// The seven-bar waveform. While `listening`, each bar breathes with its own rhythm for
/// `duration` seconds; the envelope is zero at both ends so it starts and settles exactly on the static mark.
struct BrandMark: View {
    var listening = false
    var duration = 0.9
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var started: Date?
    private let rates: [Double] = [3.1, 2.6, 2.2, 1.9, 2.4, 2.8, 3.3]
    private let swing: [CGFloat] = [0.9, 0.55, 0.32, 0.18, 0.32, 0.55, 0.9]
    var body: some View {
        TimelineView(.animation(paused: started == nil)) { context in
            let t = started.map { context.date.timeIntervalSince($0) } ?? duration
            HStack(spacing: Brand.barGap) {
                ForEach(Brand.barHeights.indices, id: \.self) { index in
                    Capsule().fill(Brand.barColors[index]).frame(width: Brand.barWidth, height: height(index, at: t))
                }
            }
        }
        .frame(width: Brand.markSize.width, height: Brand.markSize.height)
        .accessibilityLabel("MeetOdds")
        .task(id: listening) {
            guard listening, !reduceMotion else { started = nil; return }
            started = .now
            try? await Task.sleep(for: .seconds(duration))
            started = nil
        }
    }
    private func height(_ index: Int, at t: Double) -> CGFloat {
        let base = Brand.barHeights[index]
        guard t > 0, t < duration else { return base }
        let envelope = sin(.pi * t / duration)
        let wave = sin(2 * .pi * rates[index] * t + Double(index) * 1.3)
        return base * (1 + swing[index] * CGFloat(envelope * max(wave, -0.35)))
    }
}

/// Deep indigo stage. The solid colour equals the launch screen; the gradient and glow bloom over it once `revealed`.
struct BrandStage: View {
    var revealed: Bool
    var body: some View {
        ZStack {
            Brand.background
            LinearGradient(colors: [Brand.violet, Brand.background, Brand.ink], startPoint: .topTrailing, endPoint: .bottomLeading)
            RadialGradient(colors: [Color.white.opacity(0.14), .clear], center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 520)
        }
        .opacity(revealed ? 1 : 0).background(Brand.background)
        .ignoresSafeArea()
    }
}

/// White capsule on the indigo stage. Presses squash slightly, like something physical.
struct HeroButtonStyle: ButtonStyle {
    var prominent = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 17)
            .foregroundStyle(prominent ? Brand.ink : .white)
            .background(prominent ? Color.white : Color.white.opacity(0.14), in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(.snappy(duration: 0.2), value: configuration.isPressed)
    }
}
