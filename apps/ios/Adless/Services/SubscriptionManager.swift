import Combine
import Foundation
import os.log
import StoreKit

enum SubscriptionManagerState: Equatable {
    case checking
    case active(productID: String, effectiveUntil: Date, inGracePeriod: Bool)
    case inactive
    case unavailable
}

enum SubscriptionAuthorizationSource: Equatable {
    case purchase
    case restore
    case transactionUpdate
}

struct SubscriptionAuthorization: Equatable, Sendable {
    let transactionJWS: String
    let transactionId: String
}

struct SubscriptionAuthorizationCandidate: Equatable {
    let snapshot: SubscriptionAccessSnapshot
    let authorization: SubscriptionAuthorization
}

@MainActor
final class SubscriptionManager: ObservableObject {
    @Published private(set) var products: [Product] = []
    @Published private(set) var options: [SubscriptionOption] = []
    @Published private(set) var state: SubscriptionManagerState = .checking
    @Published private(set) var isProcessing = false
    @Published private(set) var message: String?

    var onEntitlementChanged: ((Bool) -> Void)?
    var onPurchaseCompleted: ((SubscriptionAuthorization, SubscriptionAuthorizationSource) -> Void)?

    private let storage: SubscriptionStorage
    private var transactionUpdatesTask: Task<Void, Never>?
    private var verifiedAuthorizationCandidate: SubscriptionAuthorizationCandidate?

    convenience init() {
        self.init(storage: SubscriptionStorage())
    }

    init(storage: SubscriptionStorage) {
        self.storage = storage
        transactionUpdatesTask = listenForTransactionUpdates()

        if let cached = storage.load(), SubscriptionAccessPolicy.allowsAccess(cached) {
            state = .active(
                productID: cached.productID ?? "",
                effectiveUntil: cached.effectiveUntil ?? Date(),
                inGracePeriod: cached.inGracePeriod
            )
        }

        Task { await loadAndRefresh() }
    }

    var hasActiveEntitlement: Bool {
        if case .active = state { return true }
        return false
    }

    var isInGracePeriod: Bool {
        if case .active(_, _, let inGracePeriod) = state { return inGracePeriod }
        return false
    }

    func loadAndRefresh() async {
        await loadProducts()
        await refreshEntitlement()
    }

    func purchase(_ product: Product) async {
        isProcessing = true
        message = nil
        defer { isProcessing = false }

        do {
            switch try await product.purchase() {
            case .success(let verificationResult):
                guard case .verified(let transaction) = verificationResult else {
                    message = String(localized: "The purchase could not be verified")
                    return
                }
                let authorization = SubscriptionAuthorization(
                    transactionJWS: verificationResult.jwsRepresentation,
                    transactionId: String(transaction.id)
                )
                await transaction.finish()
                await refreshEntitlement()
                if hasActiveEntitlement {
                    onPurchaseCompleted?(authorization, .purchase)
                }
            case .userCancelled:
                break
            case .pending:
                message = String(localized: "The purchase is awaiting approval")
            @unknown default:
                message = String(localized: "The purchase could not be completed")
            }
        } catch {
            AdlessSentry.capture(error, operation: "subscription.purchase")
            os_log("Subscription purchase failed: %{public}@", log: .default, type: .error, error.localizedDescription)
            message = String(localized: "The purchase could not be completed")
        }
    }

    func purchase(_ option: SubscriptionOption) async {
        guard let product = option.product else {
#if DEBUG && os(iOS) && targetEnvironment(simulator)
            message = String(localized: "Run the Adless scheme from Xcode to test purchases in the simulator.")
#else
            message = String(localized: "The purchase could not be completed")
#endif
            return
        }

        await purchase(product)
    }

    func restorePurchases() async {
        isProcessing = true
        message = nil
        defer { isProcessing = false }

        do {
            try await AppStore.sync()
            await refreshEntitlement()
            if hasActiveEntitlement, let authorization = await currentEntitlementAuthorization() {
                onPurchaseCompleted?(authorization, .restore)
            }
        } catch {
            AdlessSentry.capture(error, operation: "subscription.restore")
            os_log("Subscription restore failed: %{public}@", log: .default, type: .error, error.localizedDescription)
            message = String(localized: "Purchases could not be restored")
        }
    }

    func clearMessage() {
        message = nil
    }

    private func loadProducts() async {
#if DEBUG && os(iOS) && targetEnvironment(simulator)
        if !ProcessInfo.processInfo.arguments.contains("-useStoreKitProducts") {
            options = SubscriptionConfiguration.simulatorOptions
            state = .unavailable
            os_log("Loaded %{public}d simulator subscription options", log: .default, type: .info, options.count)
            return
        }
#endif

        for attempt in 0..<3 {
            do {
                let loaded = try await Product.products(for: SubscriptionConfiguration.productIDs)
                products = loaded.sorted { lhs, rhs in
                    let lhsIndex = SubscriptionConfiguration.productIDs.firstIndex(of: lhs.id) ?? .max
                    let rhsIndex = SubscriptionConfiguration.productIDs.firstIndex(of: rhs.id) ?? .max
                    return lhsIndex < rhsIndex
                }
                var loadedOptions: [SubscriptionOption] = []
                for product in products {
                    let isEligibleForIntroOffer = await product.subscription?.isEligibleForIntroOffer ?? false
                    loadedOptions.append(
                        Self.makeOption(
                            from: product,
                            isEligibleForIntroOffer: isEligibleForIntroOffer
                        )
                    )
                }
                options = loadedOptions
                os_log("Loaded %{public}d subscription products", log: .default, type: .info, products.count)
                if !products.isEmpty || attempt == 2 {
#if DEBUG && os(iOS) && targetEnvironment(simulator)
                    if options.isEmpty {
                        options = SubscriptionConfiguration.simulatorOptions
                        os_log("Loaded %{public}d simulator subscription options", log: .default, type: .info, options.count)
                    }
#endif
                    if products.isEmpty { state = .unavailable }
                    return
                }
            } catch {
                os_log("Subscription products unavailable (attempt %{public}d): %{public}@", log: .default, type: .error, attempt + 1, error.localizedDescription)
                if attempt == 2 {
#if DEBUG && os(iOS) && targetEnvironment(simulator)
                    if options.isEmpty {
                        options = SubscriptionConfiguration.simulatorOptions
                        os_log("Loaded %{public}d simulator subscription options after StoreKit failure", log: .default, type: .info, options.count)
                    }
#endif
                    if !hasValidCachedEntitlement() {
                        state = .unavailable
                    }
                    return
                }
            }

            try? await Task.sleep(nanoseconds: 750_000_000)
        }
    }

    private static func makeOption(
        from product: Product,
        isEligibleForIntroOffer: Bool
    ) -> SubscriptionOption {
        let isAnnual = product.id == SubscriptionConfiguration.yearlyProductID
        let configuredTrialText = product.subscription?.introductoryOffer.flatMap(
            SubscriptionOfferFormatter.trialDurationText
        )
        let trialText = SubscriptionOfferFormatter.eligibleTrialText(
            configuredTrialText: configuredTrialText,
            isEligibleForIntroOffer: isEligibleForIntroOffer
        )
        let renewalText = SubscriptionOfferFormatter.renewalText(
            displayPrice: product.displayPrice,
            isAnnual: isAnnual,
            hasFreeTrial: trialText != nil
        )

        let description: String
        if isAnnual {
            let monthlyPrice = (product.price / Decimal(12)).formatted(product.priceFormatStyle)
            let monthlyDescription = SubscriptionOfferFormatter.monthlyEquivalentText(displayPrice: monthlyPrice)
            description = [trialText, monthlyDescription].compactMap { $0 }.joined(separator: " · ")
        } else {
            description = trialText ?? String(localized: "Charged immediately")
        }

        return SubscriptionOption(
            id: product.id,
            name: String(localized: isAnnual ? "Annual" : "Monthly"),
            price: product.price,
            description: description,
            renewalText: renewalText,
            hasFreeTrial: trialText != nil,
            product: product
        )
    }

    private func refreshEntitlement() async {
        let previousAccess = hasActiveEntitlement
        let now = Date()
        var candidates: [SubscriptionAuthorizationCandidate] = []
        var receivedStoreStatus = false

        let groupIDs = Set(products.compactMap { $0.subscription?.subscriptionGroupID })
        for groupID in groupIDs {
            do {
                let statuses = try await Product.SubscriptionInfo.status(for: groupID)
                receivedStoreStatus = true
                candidates.append(contentsOf: statuses.compactMap { candidate(from: $0, now: now) })
            } catch {
                os_log("Subscription status refresh failed: %{public}@", log: .default, type: .error, error.localizedDescription)
            }
        }

        if candidates.isEmpty, let current = await currentEntitlementCandidate(at: now) {
            candidates.append(current)
            receivedStoreStatus = true
        }

        if let best = Self.preferredAuthorizationCandidate(candidates) {
            verifiedAuthorizationCandidate = best
            saveAndApply(best.snapshot)
        } else if !receivedStoreStatus, hasValidCachedEntitlement() {
            // Keep the last verified entitlement during a temporary offline period.
            applyCachedState()
        } else {
            verifiedAuthorizationCandidate = nil
            let inactive = SubscriptionAccessSnapshot.inactive(at: now)
            try? storage.save(inactive)
            state = products.isEmpty ? .unavailable : .inactive
            notifyIfAccessChanged(previousAccess)
        }
    }

    private func candidate(
        from status: Product.SubscriptionInfo.Status,
        now: Date
    ) -> SubscriptionAuthorizationCandidate? {
        guard status.state == .subscribed || status.state == .inGracePeriod,
              case .verified(let transaction) = status.transaction,
              SubscriptionConfiguration.productIDs.contains(transaction.productID),
              transaction.revocationDate == nil,
              case .verified(let renewalInfo) = status.renewalInfo else {
            return nil
        }

        let effectiveUntil: Date?
        if status.state == .inGracePeriod {
            effectiveUntil = renewalInfo.gracePeriodExpirationDate ?? transaction.expirationDate
        } else {
            effectiveUntil = transaction.expirationDate ?? renewalInfo.renewalDate
        }

        guard let effectiveUntil, effectiveUntil > now else { return nil }
        return SubscriptionAuthorizationCandidate(
            snapshot: SubscriptionAccessSnapshot(
                isEntitled: true,
                productID: transaction.productID,
                effectiveUntil: effectiveUntil,
                inGracePeriod: status.state == .inGracePeriod,
                lastVerifiedAt: now
            ),
            authorization: SubscriptionAuthorization(
                transactionJWS: status.transaction.jwsRepresentation,
                transactionId: String(transaction.id)
            )
        )
    }

    private func currentEntitlementCandidate(at now: Date) async -> SubscriptionAuthorizationCandidate? {
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  SubscriptionConfiguration.productIDs.contains(transaction.productID),
                  transaction.revocationDate == nil,
                  let expirationDate = transaction.expirationDate,
                  expirationDate > now else { continue }

            return SubscriptionAuthorizationCandidate(
                snapshot: SubscriptionAccessSnapshot(
                    isEntitled: true,
                    productID: transaction.productID,
                    effectiveUntil: expirationDate,
                    inGracePeriod: false,
                    lastVerifiedAt: now
                ),
                authorization: SubscriptionAuthorization(
                    transactionJWS: result.jwsRepresentation,
                    transactionId: String(transaction.id)
                )
            )
        }
        return nil
    }

    func currentEntitlementAuthorization() async -> SubscriptionAuthorization? {
        let now = Date()
        if let candidate = verifiedAuthorizationCandidate,
           SubscriptionAccessPolicy.allowsAccess(candidate.snapshot, at: now) {
            return candidate.authorization
        }
        if let candidate = await currentEntitlementCandidate(at: now) {
            verifiedAuthorizationCandidate = candidate
            return candidate.authorization
        }
        return nil
    }

    static func preferredAuthorizationCandidate(
        _ candidates: [SubscriptionAuthorizationCandidate]
    ) -> SubscriptionAuthorizationCandidate? {
        candidates.max {
            ($0.snapshot.effectiveUntil ?? .distantPast)
                < ($1.snapshot.effectiveUntil ?? .distantPast)
        }
    }

    func currentEntitlementJWS() async -> String? {
        await currentEntitlementAuthorization()?.transactionJWS
    }

    func currentAppTransactionJWS() async -> String? {
        do {
            let result = try await AppTransaction.shared
            guard case .verified(let appTransaction) = result,
                  appTransaction.bundleID == BuildEnvironment.bundleIdentifier else {
                return nil
            }
            return result.jwsRepresentation
        } catch {
            os_log("App transaction unavailable: %{public}@", log: .default, type: .error, error.localizedDescription)
            return nil
        }
    }

    private func saveAndApply(_ snapshot: SubscriptionAccessSnapshot) {
        try? storage.save(snapshot)
        let previousAccess = hasActiveEntitlement
        state = .active(
            productID: snapshot.productID ?? "",
            effectiveUntil: snapshot.effectiveUntil ?? Date(),
            inGracePeriod: snapshot.inGracePeriod
        )
        notifyIfAccessChanged(previousAccess)
    }

    private func applyCachedState() {
        guard let cached = storage.load(),
              SubscriptionAccessPolicy.allowsAccess(cached) else {
            state = .inactive
            return
        }
        let previousAccess = hasActiveEntitlement
        state = .active(
            productID: cached.productID ?? "",
            effectiveUntil: cached.effectiveUntil ?? Date(),
            inGracePeriod: cached.inGracePeriod
        )
        notifyIfAccessChanged(previousAccess)
    }

    private func hasValidCachedEntitlement() -> Bool {
        guard let cached = storage.load() else { return false }
        return SubscriptionAccessPolicy.allowsAccess(cached)
    }

    private func notifyIfAccessChanged(_ previousAccess: Bool) {
        guard previousAccess != hasActiveEntitlement else { return }
        onEntitlementChanged?(hasActiveEntitlement)
    }

    private func listenForTransactionUpdates() -> Task<Void, Never> {
        Task { @MainActor [weak self] in
            for await result in Transaction.updates {
                guard !Task.isCancelled, let self else { return }
                switch result {
                case .verified(let transaction):
                    let authorization = SubscriptionAuthorization(
                        transactionJWS: result.jwsRepresentation,
                        transactionId: String(transaction.id)
                    )
                    await transaction.finish()
                    await self.refreshEntitlement()
                    if self.hasActiveEntitlement {
                        self.onPurchaseCompleted?(authorization, .transactionUpdate)
                    }
                case .unverified:
                    os_log("Unverified subscription transaction received", log: .default, type: .error)
                }
            }
        }
    }
}
