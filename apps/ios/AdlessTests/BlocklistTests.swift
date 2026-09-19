import Foundation
import XCTest
@testable import Adless

@MainActor
final class BlocklistTests: XCTestCase {
    func testSentryDoesNotStartInsideXCTest() {
        XCTAssertFalse(AdlessSentry.shouldStart(environment: ProcessInfo.processInfo.environment))
        XCTAssertFalse(AdlessSentry.shouldStart(environment: [
            "XCTestConfigurationFilePath": "/tmp/AdlessTests.xctestconfiguration"
        ]))
        XCTAssertFalse(AdlessSentry.shouldStart(environment: [
            "XCTestBundlePath": "/tmp/AdlessTests.xctest"
        ]))
        XCTAssertTrue(AdlessSentry.shouldStart(environment: [:]))
    }

    func testCanonicalParsingAndSubdomainMatching() throws {
        let entries = try BlocklistParser.parseCanonical(Data("ads.example.com\ntracker.example.com\n".utf8))

        XCTAssertEqual(entries.count, 2)
        XCTAssertTrue(BlocklistParser.matches(domain: "cdn.ads.example.com.", entries: entries))
        XCTAssertFalse(BlocklistParser.matches(domain: "ads.example.co", entries: entries))
    }

    func testDomainMatchingUsesBoundedSuffixesAndNormalizesDNSNames() {
        let entries: Set<String> = ["ads.example.com", "xn--bcher-kva.example"]

        XCTAssertTrue(BlocklistParser.matches(domain: "ADS.EXAMPLE.COM.", entries: entries))
        XCTAssertTrue(BlocklistParser.matches(domain: "cdn.ads.example.com.", entries: entries))
        XCTAssertFalse(BlocklistParser.matches(domain: "ads.example.com.evil", entries: entries))
        XCTAssertTrue(BlocklistParser.matches(domain: "XN--BCHER-KVA.EXAMPLE.", entries: entries))
        XCTAssertTrue(BlocklistParser.matches(domain: "bücher.example.", entries: entries))
        XCTAssertFalse(BlocklistParser.matches(domain: "bücher.example..", entries: entries))
    }

    func testCanonicalParserRejectsUnsortedAndInvalidContent() {
        XCTAssertThrowsError(try BlocklistParser.parseCanonical(Data("z.example.com\na.example.com\n".utf8)))
        XCTAssertThrowsError(try BlocklistParser.parseCanonical(Data("<html>blocked</html>\n".utf8)))
        XCTAssertThrowsError(try BlocklistParser.parseCanonical(Data("ads.example.com".utf8)))
    }

    func testSubscriptionAccessPolicyAllowsActiveAndGracePeriodUntilExpiry() {
        let now = Date(timeIntervalSince1970: 10_000)
        let active = SubscriptionAccessSnapshot(
            isEntitled: true,
            productID: "com.orbeworks.adless.pro.monthly",
            effectiveUntil: now.addingTimeInterval(60),
            inGracePeriod: false,
            lastVerifiedAt: now
        )
        let grace = SubscriptionAccessSnapshot(
            isEntitled: true,
            productID: "com.orbeworks.adless.pro.monthly",
            effectiveUntil: now.addingTimeInterval(60),
            inGracePeriod: true,
            lastVerifiedAt: now
        )

        XCTAssertTrue(SubscriptionAccessPolicy.allowsAccess(active, at: now))
        XCTAssertTrue(SubscriptionAccessPolicy.allowsAccess(grace, at: now))
        XCTAssertFalse(SubscriptionAccessPolicy.allowsAccess(active, at: now.addingTimeInterval(60)))
        XCTAssertFalse(SubscriptionAccessPolicy.allowsAccess(.inactive(at: now), at: now))
    }

    func testSubscriptionAuthorizationUsesTheLongestVerifiedStoreStatus() throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let shorter = SubscriptionAuthorizationCandidate(
            snapshot: SubscriptionAccessSnapshot(
                isEntitled: true,
                productID: SubscriptionConfiguration.monthlyProductID,
                effectiveUntil: now.addingTimeInterval(60),
                inGracePeriod: false,
                lastVerifiedAt: now
            ),
            authorization: SubscriptionAuthorization(
                transactionJWS: "shorter-jws",
                transactionId: "1"
            )
        )
        let longer = SubscriptionAuthorizationCandidate(
            snapshot: SubscriptionAccessSnapshot(
                isEntitled: true,
                productID: SubscriptionConfiguration.yearlyProductID,
                effectiveUntil: now.addingTimeInterval(120),
                inGracePeriod: false,
                lastVerifiedAt: now
            ),
            authorization: SubscriptionAuthorization(
                transactionJWS: "longer-jws",
                transactionId: "2"
            )
        )

        let selected = try XCTUnwrap(
            SubscriptionManager.preferredAuthorizationCandidate([shorter, longer])
        )

        XCTAssertEqual(selected.authorization, longer.authorization)
        XCTAssertEqual(selected.snapshot, longer.snapshot)
    }

    func testSubscriptionOfferFormatterUsesStoreKitPeriod() {
        XCTAssertEqual(
            SubscriptionOfferFormatter.freeTrialText(value: 7, unit: .day),
            String(format: String(localized: "free_trial_new_subscriber_format", defaultValue: "%d %@ free for new subscribers"), 7, String(localized: "days"))
        )
        XCTAssertEqual(
            SubscriptionOfferFormatter.freeTrialText(value: 1, unit: .week),
            String(format: String(localized: "free_trial_new_subscriber_format", defaultValue: "%d %@ free for new subscribers"), 1, String(localized: "week"))
        )
    }

    func testIntroOfferPresentationRequiresStoreKitEligibility() {
        let configuredTrialText = SubscriptionOfferFormatter.trialDurationText(value: 7, unit: .day)

        XCTAssertEqual(
            SubscriptionOfferFormatter.eligibleTrialText(
                configuredTrialText: configuredTrialText,
                isEligibleForIntroOffer: true
            ),
            configuredTrialText
        )
        XCTAssertNil(
            SubscriptionOfferFormatter.eligibleTrialText(
                configuredTrialText: configuredTrialText,
                isEligibleForIntroOffer: false
            )
        )
        XCTAssertNil(
            SubscriptionOfferFormatter.eligibleTrialText(
                configuredTrialText: nil,
                isEligibleForIntroOffer: true
            )
        )
    }

#if DEBUG && os(iOS) && targetEnvironment(simulator)
    func testSimulatorMonthlyPlanHasNoTrialAndAnnualPlanKeepsTrial() throws {
        let monthly = try XCTUnwrap(
            SubscriptionConfiguration.simulatorOptions.first { $0.id == SubscriptionConfiguration.monthlyProductID }
        )
        let yearly = try XCTUnwrap(
            SubscriptionConfiguration.simulatorOptions.first { $0.id == SubscriptionConfiguration.yearlyProductID }
        )

        XCTAssertFalse(monthly.hasFreeTrial)
        XCTAssertFalse(monthly.description.isEmpty)
        XCTAssertTrue(yearly.hasFreeTrial)
    }
#endif

    func testSubscriptionStorageRoundTripsWithoutAnAppGroup() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = SubscriptionStorage(baseDirectory: directory)
        let now = Date(timeIntervalSince1970: 20_000)
        let snapshot = SubscriptionAccessSnapshot(
            isEntitled: true,
            productID: "com.orbeworks.adless.pro.yearly",
            effectiveUntil: now.addingTimeInterval(3600),
            inGracePeriod: false,
            lastVerifiedAt: now
        )

        try storage.save(snapshot)
        XCTAssertEqual(storage.load(), snapshot)
    }

    func testCloudTotalUpdatesLocalDayBaselineAndNeverDecreases() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let store = BlockingStatsStore(baseDirectory: directory, now: now)

        let first = store.updateRemoteTotal(12)
        XCTAssertEqual(first.allTimeCount, 12)
        XCTAssertEqual(first.todayCount, 0)

        let second = store.updateRemoteTotal(17)
        XCTAssertEqual(second.allTimeCount, 17)
        XCTAssertEqual(second.todayCount, 5)

        let stale = store.updateRemoteTotal(3)
        XCTAssertEqual(stale.allTimeCount, 17)
        XCTAssertEqual(stale.todayCount, 5)
    }

    func testDNSConfigurationUsesOnlyTheDNSCredential() throws {
        let token = String(repeating: "A", count: 43)
        let endpoint = try DNSCloudConfiguration.endpointURL(for: token)

        XCTAssertEqual(endpoint.host, "adless-dns.orbeworks.workers.dev")
        XCTAssertEqual(endpoint.path, "/\(token)/dns-query")
        XCTAssertTrue(DNSCloudConfiguration.isAdlessEndpoint(endpoint))
        XCTAssertFalse(DNSCloudConfiguration.isAdlessEndpoint(URL(string: "https://adless-dns.orbeworks.workers.dev/v1/stats")!))
        XCTAssertTrue(InstallationTokenStore.isValid(token))
        XCTAssertFalse(InstallationTokenStore.isValid(String(repeating: "A", count: 42)))
    }

    func testFailedDNSRemovalExplainsManualSettingsFallback() {
        let error = DNSSettingsManagerError.removalNotConfirmed

        XCTAssertTrue(error.errorDescription?.contains("Disable it manually in Settings") == true)
    }

    func testAuthorizationPayloadIncludesVerifiedAppTransactionEvidence() throws {
        let data = try JSONEncoder().encode(DNSAuthorizationRequest(
            installationId: "11111111-1111-4111-8111-111111111111",
            transactionJWS: "transaction-jws",
            appTransactionJWS: "app-transaction-jws",
            rotationNonce: String(repeating: "N", count: 43),
            currentDnsToken: nil,
            currentStatsToken: nil
        ))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])

        XCTAssertEqual(payload["appTransactionJWS"], "app-transaction-jws")
        XCTAssertEqual(payload["rotationNonce"], String(repeating: "N", count: 43))
        XCTAssertNil(payload["currentDnsToken"])
        XCTAssertNil(payload["currentStatsToken"])
    }

    func testAuthorizationPayloadOmitsUnavailableAppTransactionEvidence() throws {
        let data = try JSONEncoder().encode(DNSAuthorizationRequest(
            installationId: "11111111-1111-4111-8111-111111111111",
            transactionJWS: "transaction-jws",
            appTransactionJWS: nil,
            rotationNonce: String(repeating: "N", count: 43),
            currentDnsToken: String(repeating: "D", count: 43),
            currentStatsToken: String(repeating: "S", count: 43)
        ))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])

        XCTAssertNil(payload["appTransactionJWS"])
        XCTAssertEqual(payload["currentDnsToken"], String(repeating: "D", count: 43))
        XCTAssertEqual(payload["currentStatsToken"], String(repeating: "S", count: 43))
    }

    func testRestoreAlwaysReconcilesExistingCredentialsWithTheWorker() {
        XCTAssertTrue(AppViewModel.authorizationIsRequired(
            hasAccess: true,
            hasCredentials: true,
            source: .restore
        ))
        XCTAssertTrue(AppViewModel.authorizationIsRequired(
            hasAccess: true,
            hasCredentials: true,
            source: .purchase
        ))
        XCTAssertTrue(AppViewModel.authorizationIsRequired(
            hasAccess: true,
            hasCredentials: true,
            source: .transactionUpdate
        ))
        XCTAssertTrue(AppViewModel.authorizationIsRequired(hasAccess: true, hasCredentials: false))
        XCTAssertFalse(AppViewModel.authorizationIsRequired(hasAccess: false, hasCredentials: false))
    }

    func testUIClaimsProtectionOnlyAfterSubscriptionCredentialsAndDNSAreConfirmed() {
        XCTAssertTrue(AppViewModel.protectionIsConfirmed(
            hasAccess: true,
            hasCredentials: true,
            authorizationRequired: false,
            remoteBlockingState: .enabled,
            dnsState: .enabled
        ))
        XCTAssertFalse(AppViewModel.protectionIsConfirmed(
            hasAccess: true,
            hasCredentials: true,
            authorizationRequired: true,
            remoteBlockingState: .enabled,
            dnsState: .enabled
        ))
        XCTAssertFalse(AppViewModel.protectionIsConfirmed(
            hasAccess: true,
            hasCredentials: false,
            authorizationRequired: false,
            remoteBlockingState: .enabled,
            dnsState: .enabled
        ))
        XCTAssertFalse(AppViewModel.protectionIsConfirmed(
            hasAccess: true,
            hasCredentials: true,
            authorizationRequired: false,
            remoteBlockingState: .paused,
            dnsState: .enabled
        ))
        XCTAssertFalse(AppViewModel.protectionIsConfirmed(
            hasAccess: true,
            hasCredentials: true,
            authorizationRequired: false,
            remoteBlockingState: .unknown,
            dnsState: .enabled
        ))
        XCTAssertFalse(AppViewModel.protectionIsConfirmed(
            hasAccess: true,
            hasCredentials: true,
            authorizationRequired: false,
            remoteBlockingState: .enabled,
            dnsState: .disabled
        ))
    }

    func testStartupAuthorizationOnlyReinstallsAnAlreadyEnabledDNSProfile() {
        XCTAssertFalse(AppViewModel.shouldActivateAfterAuthorization(
            explicitlyRequested: false,
            previousDNSState: .notConfigured
        ))
        XCTAssertFalse(AppViewModel.shouldActivateAfterAuthorization(
            explicitlyRequested: false,
            previousDNSState: .disabled
        ))
        XCTAssertTrue(AppViewModel.shouldActivateAfterAuthorization(
            explicitlyRequested: false,
            previousDNSState: .enabled
        ))
        XCTAssertTrue(AppViewModel.shouldActivateAfterAuthorization(
            explicitlyRequested: false,
            previousDNSState: .staleEnabled
        ))
        XCTAssertTrue(AppViewModel.shouldActivateAfterAuthorization(
            explicitlyRequested: true,
            previousDNSState: .disabled
        ))
    }
}
