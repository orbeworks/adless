import SwiftUI

struct ContentView: View {
    @ObservedObject var viewModel: AppViewModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @State private var subscriptionSheetHeight: CGFloat?

    private var subscriptionDetent: PresentationDetent {
        guard let subscriptionSheetHeight else { return .medium }
        return .height(subscriptionSheetHeight)
    }

    private var appBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.059, green: 0.078, blue: 0.102)
            : Color(.systemBackground)
    }

    private var inactiveButtonForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.67, green: 0.69, blue: 0.74)
            : Color(red: 0.40, green: 0.43, blue: 0.49)
    }

    private var inactiveButtonBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.145, green: 0.165, blue: 0.20)
            : Color(red: 0.92, green: 0.93, blue: 0.95)
    }

    private var statsBackgroundStyle: AnyShapeStyle {
        colorScheme == .dark
            ? AnyShapeStyle(inactiveButtonBackground)
            : AnyShapeStyle(.thinMaterial)
    }

    private var inactiveButtonBorder: Color {
        colorScheme == .dark
            ? Color(red: 0.25, green: 0.27, blue: 0.31)
            : Color(red: 0.84, green: 0.86, blue: 0.89)
    }

    private var activeButtonBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.35, green: 0.60, blue: 0.91)
            : Color(red: 0.20, green: 0.45, blue: 0.82)
    }

    private var activeButtonBorder: Color {
        colorScheme == .dark
            ? Color(red: 0.58, green: 0.76, blue: 0.98)
            : Color(red: 0.52, green: 0.70, blue: 0.94)
    }

    private var premiumBadgeForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.33, green: 0.62, blue: 0.98)
            : Color(red: 0.12, green: 0.43, blue: 0.88)
    }

    private var premiumBadgeBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.098, green: 0.145, blue: 0.208)
            : AdlessTheme.selectedPlanBackground
    }

    var body: some View {
        ZStack {
            appBackground.ignoresSafeArea()
            VStack(spacing: 30) {
                Spacer()

                VStack(spacing: 16) {
                    AdlessLogoView(size: 92)

                    VStack(spacing: 10) {
                        Text(viewModel.protectionHeadline)
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(.primary)

                        Text(viewModel.protectionSummary)
                            .font(.subheadline)
                            .foregroundStyle(Color.primary.opacity(0.58))
                            .multilineTextAlignment(.center)
                            .lineLimit(2, reservesSpace: true)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                VStack(spacing: viewModel.hasSubscription ? 24 : 16) {
                Button {
                    if viewModel.hasSubscription {
                        Task { await viewModel.toggle() }
                    } else {
                        viewModel.isSubscriptionPresented = true
                    }
                } label: {
                    ZStack {
                        Image(systemName: "power")
                            .font(.system(size: 56, weight: .medium))
                            .foregroundStyle(viewModel.isProtectionActive
                                             ? Color.white
                                             : inactiveButtonForeground)

                        if viewModel.isProtectionTransitioning {
                            ProtectionProgressRing(
                                color: viewModel.isProtectionActive
                                    ? .white
                                    : activeButtonBackground
                            )
                            .padding(8)
                            .transition(.opacity)
                        }
                    }
                    .frame(width: 144, height: 144)
                    .background(viewModel.isProtectionActive
                                ? activeButtonBackground
                                : inactiveButtonBackground)
                    .overlay {
                        Circle()
                            .stroke(
                                viewModel.isProtectionActive
                                    ? activeButtonBorder
                                    : inactiveButtonBorder,
                                lineWidth: 1
                            )
                    }
                    .clipShape(Circle())
                    .shadow(
                        color: viewModel.isProtectionActive
                            ? Color.black.opacity(colorScheme == .dark ? 0.24 : 0.12)
                            : Color.black.opacity(colorScheme == .dark ? 0.30 : 0.14),
                        radius: viewModel.isProtectionActive && colorScheme == .dark ? 12 : 10,
                        x: 0,
                        y: viewModel.isProtectionActive && colorScheme == .dark ? 7 : 6
                    )
                }
                .disabled(viewModel.isProtectionTransitioning)
                .accessibilityLabel(viewModel.isProtectionTransitioning
                                    ? "Updating protection"
                                    : (viewModel.hasSubscription
                                       ? (viewModel.isProtectionActive ? "Turn off blocking" : "Turn on blocking")
                                       : "Subscribe to turn on blocking"))
                .accessibilityHint(viewModel.hasSubscription
                                   ? "Turns DNS blocking on or off"
                                   : "Opens subscription options")

                if !viewModel.hasSubscription {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.caption.weight(.medium))

                        Text("Premium access required")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(premiumBadgeForeground)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(premiumBadgeBackground)
                    .clipShape(Capsule())
                }
                }

                if viewModel.hasSubscription {
                    BlockingStatsView(
                        blockedTodayValue: viewModel.blockedTodayCount.formatted(.number),
                        allTimeValue: viewModel.allTimeBlockCount.formatted(.number)
                    )
                    .background(statsBackgroundStyle, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                }

                if viewModel.hasSubscription {
                    VStack(spacing: 4) {
                        Text(viewModel.isProtectionActive
                             ? "Browse cleaner. Stay private."
                             : "Turn Adless back on to keep blocking.")
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)

                        Text(viewModel.isProtectionActive
                             ? "Adless keeps working even after you close the app."
                             : "Your blocking history is saved while protection is paused.")
                            .font(.footnote)
                            .foregroundStyle(Color.primary.opacity(0.58))
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 2)
                } else {
                    Text("Choose a plan to turn on protection.")
                        .font(.subheadline)
                        .foregroundStyle(Color.primary.opacity(0.58))
                        .multilineTextAlignment(.center)
                        .padding(.top, 2)
                }

                if !viewModel.hasSubscription {
                    BlockingStatsView(
                        blockedTodayValue: viewModel.blockedTodayCount.formatted(.number),
                        allTimeValue: viewModel.allTimeBlockCount.formatted(.number)
                    )
                    .background(statsBackgroundStyle, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .opacity(0)
                    .accessibilityHidden(true)
                }

                Spacer()
            }
            .padding(.horizontal, 32)
            .padding(.vertical)

            if viewModel.isSubscriptionPresented {
                ZStack {
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .opacity(0.55)

                    Color.black.opacity(0.24)
                }
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }

            if viewModel.isPreparing {
                PreparationView(colorScheme: colorScheme)
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: viewModel.isProtectionActive)
        .animation(.easeInOut(duration: 0.18), value: viewModel.isProtectionTransitioning)
        .animation(.easeInOut(duration: 0.2), value: viewModel.isSubscriptionPresented)
        .animation(.easeInOut(duration: 0.2), value: viewModel.isPreparing)
        .contentShape(Rectangle())
        .onTapGesture {
            guard viewModel.isSubscriptionPresented else { return }
            viewModel.isSubscriptionPresented = false
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, !viewModel.isPreparing else { return }
            Task { await viewModel.applicationDidBecomeActive() }
        }
        .alert("Enable DNS protection in Settings", isPresented: $viewModel.isSystemApprovalAlertPresented) {
            Button("Open Settings") {
                viewModel.openSystemDNSSettings()
            }
            Button("OK", role: .cancel) { }
        } message: {
            Text("Apple does not provide a public shortcut to DNS. In Settings, return to the main screen and follow General → VPN & Device Management → DNS → Adless. Return here; protection will be checked automatically.")
        }
        .alert("Disable Adless in Settings", isPresented: $viewModel.isManualDisableAlertPresented) {
            Button("Open Settings") {
                viewModel.openSystemDNSSettings()
            }
            Button("OK", role: .cancel) { }
        } message: {
            Text("Your subscription has ended, but iOS did not confirm removal. Open Settings and disable Adless manually.")
        }
        .sheet(
            isPresented: Binding(
                get: { viewModel.isSubscriptionPresented && !viewModel.isPreparing },
                set: { viewModel.isSubscriptionPresented = $0 }
            )
        ) {
            SubscriptionView(
                manager: viewModel.subscriptionManager,
                onContentHeightChange: { contentHeight in
                    let proposedHeight = contentHeight + 2
                    guard proposedHeight.isFinite, proposedHeight > 0 else { return }

                    if subscriptionSheetHeight == nil || abs(subscriptionSheetHeight! - proposedHeight) > 1 {
                        subscriptionSheetHeight = proposedHeight
                    }
                }
            )
                .interactiveDismissDisabled(false)
                .presentationDetents([subscriptionDetent])
                .presentationDragIndicator(.hidden)
                .presentationBackground(AdlessTheme.subscriptionDrawerBackground)
                .presentationBackgroundInteraction(.enabled)
        }
    }
}

private struct ProtectionProgressRing: View {
    let color: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var rotation = 0.0

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(0.16), lineWidth: 3)

            Circle()
                .trim(from: 0.06, to: 0.32)
                .stroke(
                    color,
                    style: StrokeStyle(lineWidth: 3, lineCap: .round)
                )
                .rotationEffect(.degrees(rotation))
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                rotation = 360
            }
        }
        .accessibilityHidden(true)
    }
}

private struct PreparationView: View {
    let colorScheme: ColorScheme

    private var background: Color {
        colorScheme == .dark
            ? Color(red: 0.059, green: 0.078, blue: 0.102)
            : Color(.systemBackground)
    }

    private var titleColor: Color {
        colorScheme == .dark ? .white : .black
    }

    private var detailColor: Color {
        colorScheme == .dark
            ? Color.white.opacity(0.54)
            : Color.black.opacity(0.48)
    }

    var body: some View {
        ZStack {
            background.ignoresSafeArea()

            VStack(spacing: 12) {
                AdlessLogoView(size: 104)

                Text("Adless")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(titleColor)
            }

            VStack {
                Spacer()

                Text("Preparing your protection...")
                    .font(.subheadline)
                    .foregroundStyle(detailColor)
                    .padding(.bottom, 30)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Adless. Preparing your protection.")
    }
}

private struct BlockingStatsView: View {
    let blockedTodayValue: String
    let allTimeValue: String

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 2) {
                Text(blockedTodayValue)
                    .font(.system(size: 38, weight: .semibold, design: .rounded))
                    .monospacedDigit()

                Text("ad & tracker requests blocked today")
                    .font(.footnote)
                    .foregroundStyle(Color.primary.opacity(0.58))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)

            Divider()
                .padding(.horizontal, 20)

            HStack(spacing: 4) {
                Text(allTimeValue)
                    .monospacedDigit()

                Text("all-time blocks")
            }
            .font(.footnote)
            .foregroundStyle(Color.primary.opacity(0.58))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
        }
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView(viewModel: AppViewModel())
    }
}
