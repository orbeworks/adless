import SwiftUI
import Combine
import Foundation
import UIKit
import Sentry

private enum SubscriptionActivationError: LocalizedError {
    case verifiedTransactionUnavailable

    var errorDescription: String? {
        "A verified subscription transaction is unavailable"
    }
}

@main
struct AdlessApp: App {
    @StateObject private var viewModel = AppViewModel()

    init() {
        AdlessSentry.start()
    }

    var body: some Scene {
        WindowGroup {
            ContentView(viewModel: viewModel)
        }
    }
}

@MainActor
final class AppViewModel: ObservableObject {
    static func authorizationIsRequired(
        hasAccess: Bool,
        hasCredentials: Bool,
        source: SubscriptionAuthorizationSource? = nil
    ) -> Bool {
        guard hasAccess else { return false }
        guard hasCredentials else { return true }
        return source != nil
    }

    static func protectionIsConfirmed(
        hasAccess: Bool,
        hasCredentials: Bool,
        authorizationRequired: Bool,
        remoteBlockingState: RemoteBlockingState,
        dnsState: DNSSettingsState
    ) -> Bool {
        hasAccess
            && hasCredentials
            && !authorizationRequired
            && remoteBlockingState == .enabled
            && dnsState == .enabled
    }

    static func shouldActivateAfterAuthorization(
        explicitlyRequested: Bool,
        previousDNSState: DNSSettingsState
    ) -> Bool {
        explicitlyRequested || previousDNSState.isSystemEnabled
    }

    @Published var isOn = false
    @Published private(set) var isProtectionActive = false
    @Published var statusText: String = String(localized: "Off")
    @Published private(set) var isPreparing = true
    @Published private(set) var hasSubscription = false
    @Published private(set) var remoteBlockingState: RemoteBlockingState = .unknown
    @Published private(set) var isProtectionStateChecking = false
    @Published private(set) var isProtectionTransitioning = false
    @Published var isSubscriptionPresented = false
    @Published var isSystemApprovalAlertPresented = false
    @Published var isManualDisableAlertPresented = false
    @Published private(set) var blockedTodayCount = 0
    @Published private(set) var allTimeBlockCount = 0

    var protectionHeadline: String {
        if isProtectionActive { return String(localized: "Protection Active") }
        guard hasSubscription, isOn, remoteBlockingState == .unknown else {
            return String(localized: "Protection Off")
        }
        return isProtectionStateChecking
            ? String(localized: "Checking protection")
            : String(localized: "Protection unavailable")
    }

    var protectionSummary: String {
        if !hasSubscription {
            return String(localized: "Block ads and trackers across your iPhone.")
        }
        if isProtectionActive {
            return String(localized: "Adless is working quietly in the background.")
        }
        guard isOn, remoteBlockingState == .unknown else {
            return String(localized: "Your protection is paused.")
        }
        return isProtectionStateChecking
            ? String(localized: "Confirming DNS and Worker status.")
            : String(localized: "Adless could not confirm the Worker status.")
    }

    let subscriptionManager = SubscriptionManager()

    private let dnsSettingsManager = DNSSettingsManager()
    private let blockingStatsStore = BlockingStatsStore()
    private let statsAPIClient = DNSStatsAPIClient()
    private let blockingAPIClient = DNSBlockingAPIClient()
    private let authorizationAPIClient = DNSAuthorizationAPIClient()
    private let protectionStateReconciler = ProtectionStateReconciler()
    private var dnsSettingsObserver: NSObjectProtocol?
    private var isAuthorizing = false
    private var authorizationRequired = false
    private var needsStartupAuthorizationReconciliation = true

    init() {
        subscriptionManager.onEntitlementChanged = { [weak self] hasAccess in
            guard let self else { return }
            self.hasSubscription = hasAccess
            self.authorizationRequired = Self.authorizationIsRequired(
                hasAccess: hasAccess,
                hasCredentials: InstallationTokenStore.shared.hasAuthorizedCredentials()
            )
            if self.authorizationRequired || !hasAccess {
                self.isProtectionActive = false
            }
            // The initial foreground pass performs this reconciliation itself.
            // Avoid racing it with the entitlement callback while startup state
            // is still being established.
            guard !self.needsStartupAuthorizationReconciliation else { return }
            if hasAccess {
                Task { @MainActor [weak self] in
                    await self?.ensureAuthorizationIfNeeded()
                }
                return
            }
            Task { @MainActor [weak self] in
                await self?.disableIfSubscriptionExpired()
            }
        }
        subscriptionManager.onPurchaseCompleted = { [weak self] authorization, source in
            guard let self, self.subscriptionManager.hasActiveEntitlement else { return }
            self.hasSubscription = true
            let hasCredentials = InstallationTokenStore.shared.hasAuthorizedCredentials()
            self.authorizationRequired = Self.authorizationIsRequired(
                hasAccess: true,
                hasCredentials: hasCredentials,
                source: source
            )
            if self.authorizationRequired {
                self.isProtectionActive = false
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.authorizationRequired {
                    await self.authorizeAndActivate(
                        authorization,
                        shouldActivateAfterAuthorization: true,
                        enableBlockingAfterAuthorization: true
                    )
                } else {
                    await self.activateProtection()
                }
            }
        }

        dnsSettingsObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("NEDNSSettingsConfigurationDidChangeNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.reconcileProtectionState()
            }
        }
        beginPreparation()

#if DEBUG && os(iOS) && targetEnvironment(simulator)
        if !ProcessInfo.processInfo.arguments.contains("-useStoreKitProducts") {
            Task { @MainActor [weak self] in
                await Task.yield()
                self?.isSubscriptionPresented = true
            }
        }
#endif
    }

    deinit {
        if let dnsSettingsObserver {
            NotificationCenter.default.removeObserver(dnsSettingsObserver)
        }
    }

    @MainActor
    func toggle() async {
        guard !isPreparing, !isProtectionTransitioning else { return }
        guard hasSubscription else {
            isSubscriptionPresented = true
            return
        }

        isProtectionTransitioning = true
        defer { isProtectionTransitioning = false }

        if isProtectionActive {
            let transaction = AdlessSentry.startTransaction(name: "protection.deactivate", operation: "blocking-preference")
            defer { transaction?.finish() }
            _ = await updateBlockingPreference(false)
            await reconcileProtectionState()
            return
        }

        await activateProtection()
    }

    @MainActor
    func activateProtection() async {
        await activateProtection(allowDuringPreparation: false)
    }

    @MainActor
    private func activateProtection(allowDuringPreparation: Bool) async {
        await activateProtection(
            allowDuringPreparation: allowDuringPreparation,
            enableBlocking: true
        )
    }

    @MainActor
    private func activateProtection(
        allowDuringPreparation: Bool,
        enableBlocking: Bool
    ) async {
        guard allowDuringPreparation || !isPreparing else { return }
        guard hasSubscription else {
            isSubscriptionPresented = true
            return
        }
        invalidateProtectionStateForReconciliation()

        if authorizationRequired || !InstallationTokenStore.shared.hasAuthorizedCredentials() {
            guard let authorization = await subscriptionManager.currentEntitlementAuthorization() else {
                AdlessSentry.capture(
                    SubscriptionActivationError.verifiedTransactionUnavailable,
                    operation: "subscription.authorization.current_entitlement"
                )
                return
            }
            await authorizeAndActivate(
                authorization,
                shouldActivateAfterAuthorization: true,
                allowActivationDuringPreparation: allowDuringPreparation,
                enableBlockingAfterAuthorization: enableBlocking
            )
            return
        }

        // A paused profile that is still enabled only needs its server-side
        // blocking preference changed. Reinstall only when the system profile
        // is missing, disabled, or points to stale credentials.
        statusText = String(localized: "Connecting")
        let transaction = AdlessSentry.startTransaction(name: "protection.activate", operation: "dns-settings")
        defer { transaction?.finish() }

        if enableBlocking {
            guard await updateBlockingPreference(true) else {
                await reconcileProtectionState()
                return
            }
        }

        let currentState = await dnsSettingsManager.currentState()
        if currentState == .enabled {
            await reconcileProtectionState()
            await refreshCloudStats()
            return
        }

        do {
            let state = try await dnsSettingsManager.install()
            await reconcileProtectionState()
            await refreshCloudStats()
            if state == .disabled {
                isSystemApprovalAlertPresented = true
            }
        } catch {
            AdlessSentry.capture(error, operation: "dns.settings.save")
            let state = await reconcileProtectionState()
            if state == .disabled {
                isSystemApprovalAlertPresented = true
            }
        }
    }

    /// Opens the root of the Settings app after the app has saved the profile.
    /// iOS has no public URL for the DNS screen, so this is a best-effort use
    /// of the undocumented root Settings URL. The user must still enable
    /// Adless in Settings.
    @MainActor
    func openSystemDNSSettings() {
        let settingsURLs = [
            "App-Prefs:",
            "prefs:"
        ].compactMap(URL.init(string:))

        openNextSettingsURL(settingsURLs, at: 0)
    }

    @MainActor
    private func openNextSettingsURL(_ urls: [URL], at index: Int) {
        guard urls.indices.contains(index) else { return }

        UIApplication.shared.open(urls[index], options: [:]) { [weak self] didOpen in
            guard !didOpen else { return }
            Task { @MainActor [weak self] in
                self?.openNextSettingsURL(urls, at: index + 1)
            }
        }
    }

    @MainActor
    @discardableResult
    func reconcileProtectionState() async -> DNSSettingsState {
        let requirements = protectionReconciliationRequirements
        let dnsSettingsManager = self.dnsSettingsManager
        let blockingAPIClient = self.blockingAPIClient
        let state = await protectionStateReconciler.reconcile(
            requirements: requirements,
            loadDNSState: {
                await dnsSettingsManager.currentState()
            },
            loadRemoteState: {
                do {
                    return try await blockingAPIClient.blockingIsEnabled()
                } catch {
                    AdlessSentry.capture(error, operation: "blocking.preference.read")
                    throw error
                }
            },
            onSnapshot: { [weak self] snapshot in
                self?.applyProtectionSnapshot(snapshot)
            }
        )
        return state ?? .invalid
    }

    private var protectionReconciliationRequirements: ProtectionReconciliationRequirements {
        ProtectionReconciliationRequirements(
            hasAccess: hasSubscription,
            hasCredentials: InstallationTokenStore.shared.hasAuthorizedCredentials(),
            authorizationRequired: authorizationRequired
        )
    }

    private func invalidateProtectionStateForReconciliation() {
        protectionStateReconciler.invalidate(
            requirements: protectionReconciliationRequirements,
            onSnapshot: { [weak self] snapshot in
                self?.applyProtectionSnapshot(snapshot)
            }
        )
    }

    private func applyProtectionSnapshot(_ snapshot: ProtectionReconciliationSnapshot) {
        remoteBlockingState = snapshot.remoteBlockingState
        isProtectionStateChecking = snapshot.isChecking
        guard let state = snapshot.dnsState else {
            isProtectionActive = false
            statusText = String(localized: "Checking protection")
            return
        }

        isOn = state.isSystemEnabled
        isProtectionActive = Self.protectionIsConfirmed(
            hasAccess: hasSubscription,
            hasCredentials: InstallationTokenStore.shared.hasAuthorizedCredentials(),
            authorizationRequired: authorizationRequired,
            remoteBlockingState: snapshot.remoteBlockingState,
            dnsState: state
        )
        if isOn {
            isSystemApprovalAlertPresented = false
        }
        AdlessSentry.event("dns.settings.status_change", state: state.rawValue)

        if !hasSubscription {
            statusText = String(localized: "Premium access required")
            return
        }

        switch state {
        case .notConfigured, .disabled:
            statusText = String(localized: "Off")
        case .enabled:
            switch snapshot.remoteBlockingState {
            case .enabled:
                statusText = String(localized: "On")
            case .paused:
                statusText = String(localized: "Off")
            case .unknown:
                statusText = snapshot.isChecking
                    ? String(localized: "Checking protection")
                    : String(localized: "Protection unavailable")
            }
        case .staleEnabled:
            statusText = String(localized: "Reconnect to update DNS protection")
        case .invalid:
            statusText = String(localized: "Invalid")
        }
    }

    @MainActor
    func refreshBlockingStats() {
        let snapshot = blockingStatsStore.read()
        blockedTodayCount = snapshot.todayCount
        allTimeBlockCount = snapshot.allTimeCount
    }

    @MainActor
    func applicationDidBecomeActive() async {
        invalidateProtectionStateForReconciliation()
        await subscriptionManager.loadAndRefresh()
        hasSubscription = subscriptionManager.hasActiveEntitlement
        if needsStartupAuthorizationReconciliation, hasSubscription {
            authorizationRequired = true
            isProtectionActive = false
        }
        needsStartupAuthorizationReconciliation = false
        await ensureAuthorizationIfNeeded()
        await disableIfSubscriptionExpired()
        await reconcileProtectionState()
        refreshBlockingStats()
        await refreshCloudStats()
    }

    private func refreshCloudStats() async {
        guard isProtectionActive else { return }
        do {
            let total = try await statsAPIClient.fetchBlockedTotal()
            let snapshot = blockingStatsStore.updateRemoteTotal(total)
            blockedTodayCount = snapshot.todayCount
            allTimeBlockCount = snapshot.allTimeCount
        } catch {
            // The cached total remains visible. Statistics are best effort and
            // must never disable or delay DNS protection.
            AdlessSentry.capture(error, operation: "stats.fetch")
            refreshBlockingStats()
        }
    }

    private func ensureAuthorizationIfNeeded() async {
        guard hasSubscription, authorizationRequired || !InstallationTokenStore.shared.hasAuthorizedCredentials() else { return }
        guard let authorization = await subscriptionManager.currentEntitlementAuthorization() else {
            AdlessSentry.capture(
                SubscriptionActivationError.verifiedTransactionUnavailable,
                operation: "subscription.authorization.current_entitlement"
            )
            return
        }
        let previousDNSState = await dnsSettingsManager.currentState()
        await authorizeAndActivate(
            authorization,
            shouldActivateAfterAuthorization: Self.shouldActivateAfterAuthorization(
                explicitlyRequested: false,
                previousDNSState: previousDNSState
            ),
            allowActivationDuringPreparation: isPreparing,
            // Automatic startup/foreground reconciliation must never change
            // the Worker preference. Only an explicit user action may do so.
            enableBlockingAfterAuthorization: false
        )
    }

    private func authorizeAndActivate(
        _ authorization: SubscriptionAuthorization,
        shouldActivateAfterAuthorization: Bool,
        allowActivationDuringPreparation: Bool = false,
        enableBlockingAfterAuthorization: Bool = true
    ) async {
        guard hasSubscription, !isAuthorizing else { return }
        isAuthorizing = true
        defer { isAuthorizing = false }
        authorizationRequired = true
        isProtectionActive = false
        statusText = String(localized: "Authorizing")
        var receivedCredentials = false
        var attempt: InstallationAuthorizationAttempt?
        do {
            let appTransactionJWS = await subscriptionManager.currentAppTransactionJWS()
            let installationId = try InstallationTokenStore.shared.installationID()
            let preparedAttempt = try InstallationTokenStore.shared.authorizationAttempt(
                transactionId: authorization.transactionId
            )
            attempt = preparedAttempt
            let credentials = try await authorizationAPIClient.authorize(
                transactionJWS: authorization.transactionJWS,
                appTransactionJWS: appTransactionJWS,
                installationId: installationId,
                rotationNonce: preparedAttempt.rotationNonce,
                currentCredentials: preparedAttempt.currentCredentials
            )
            receivedCredentials = true
            try InstallationTokenStore.shared.commit(
                credentials,
                transactionId: authorization.transactionId,
                rotationNonce: preparedAttempt.rotationNonce
            )
            authorizationRequired = false
            isSubscriptionPresented = false
            if shouldActivateAfterAuthorization {
                await activateProtection(
                    allowDuringPreparation: allowActivationDuringPreparation,
                    enableBlocking: enableBlockingAfterAuthorization
                )
            } else {
                await reconcileProtectionState()
            }
        } catch {
            authorizationRequired = true
            isProtectionActive = false
            AdlessSentry.capture(error, operation: "subscription.authorization")
            if receivedCredentials, attempt?.isPendingRotation == true {
                await removeStaleDNSAfterFailedCredentialCommit()
            }
            await reconcileProtectionState()
        }
    }

    private func removeStaleDNSAfterFailedCredentialCommit() async {
        do {
            try await dnsSettingsManager.remove()
        } catch {
            AdlessSentry.capture(error, operation: "dns.settings.remove_after_credential_commit_failure")
            isManualDisableAlertPresented = true
        }
    }

    @discardableResult
    private func updateBlockingPreference(_ enabled: Bool) async -> Bool {
        do {
            let confirmedValue = try await blockingAPIClient.setBlockingEnabled(enabled)
            return confirmedValue == enabled
        } catch {
            AdlessSentry.capture(error, operation: "blocking.preference.update")
            return false
        }
    }

    private func beginPreparation() {
        let preparationStartedAt = Date()
        let minimumPreparationDuration: TimeInterval = 0.35

        Task { @MainActor [weak self] in
            guard let self else { return }
            self.hasSubscription = self.subscriptionManager.hasActiveEntitlement
            await self.applicationDidBecomeActive()

            let elapsed = Date().timeIntervalSince(preparationStartedAt)
            let remaining = max(0, minimumPreparationDuration - elapsed)
            if remaining > 0 {
                try? await Task.sleep(for: .seconds(remaining))
            }
            self.isPreparing = false
        }
    }

    @MainActor
    private func disableIfSubscriptionExpired() async {
        guard !hasSubscription else { return }
        // The Worker already turns an expired known credential into DNS
        // pass-through. Keep the system DNS profile intact so renewed access
        // does not require another trip to Settings.
        await reconcileProtectionState()
    }
}
