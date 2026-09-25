import Foundation

struct AccessPolicy: Decodable, Equatable, Sendable {
    let subscriptionRequired: Bool
}

final class AccessPolicyAPIClient: @unchecked Sendable {
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.urlCredentialStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.waitsForConnectivity = false
            configuration.timeoutIntervalForRequest = 4
            configuration.timeoutIntervalForResource = 4
            self.session = URLSession(configuration: configuration)
        }
    }

    deinit {
        session.invalidateAndCancel()
    }

    func fetch() async throws -> AccessPolicy {
        var request = URLRequest(url: DNSCloudConfiguration.accessPolicyURL)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              data.count <= 4 * 1024,
              let policy = try? JSONDecoder().decode(AccessPolicy.self, from: data) else {
            throw DNSStatsAPIError.invalidResponse
        }
        return policy
    }
}

struct DNSStatsResponse: Decodable, Equatable {
    let blockedTotal: Int
    let updatedAt: String
}

enum DNSStatsAPIError: LocalizedError {
    case invalidResponse
    case invalidPayload
    case authorizationRequired

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The blocking statistics service returned an invalid response"
        case .invalidPayload:
            return "The blocking statistics payload is invalid"
        case .authorizationRequired:
            return "Subscription authorization is required"
        }
    }
}

final class DNSStatsAPIClient: @unchecked Sendable {
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.urlCredentialStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.waitsForConnectivity = false
            configuration.timeoutIntervalForRequest = 4
            configuration.timeoutIntervalForResource = 4
            self.session = URLSession(configuration: configuration)
        }
    }

    deinit {
        session.invalidateAndCancel()
    }

    func fetchBlockedTotal() async throws -> Int {
        let token: String
        do {
            token = try InstallationTokenStore.shared.statsToken()
        } catch {
            throw DNSStatsAPIError.authorizationRequired
        }
        var request = URLRequest(url: DNSCloudConfiguration.statsURL)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              data.count <= 4 * 1024 else {
            throw DNSStatsAPIError.invalidResponse
        }

        let payload = try JSONDecoder().decode(DNSStatsResponse.self, from: data)
        guard payload.blockedTotal >= 0, !payload.updatedAt.isEmpty else {
            throw DNSStatsAPIError.invalidPayload
        }
        return payload.blockedTotal
    }
}

private struct DNSBlockingResponse: Decodable {
    let blockingEnabled: Bool
}

final class DNSBlockingAPIClient: @unchecked Sendable {
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.urlCredentialStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.waitsForConnectivity = false
            configuration.timeoutIntervalForRequest = 4
            configuration.timeoutIntervalForResource = 4
            self.session = URLSession(configuration: configuration)
        }
    }

    deinit {
        session.invalidateAndCancel()
    }

    func blockingIsEnabled() async throws -> Bool {
        try await request(method: "GET", blockingEnabled: nil)
    }

    func setBlockingEnabled(_ enabled: Bool) async throws -> Bool {
        try await request(method: "PUT", blockingEnabled: enabled)
    }

    private func request(method: String, blockingEnabled: Bool?) async throws -> Bool {
        let token: String
        do {
            token = try InstallationTokenStore.shared.statsToken()
        } catch {
            throw DNSStatsAPIError.authorizationRequired
        }
        var request = URLRequest(url: DNSCloudConfiguration.blockingURL)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let blockingEnabled {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(["blockingEnabled": blockingEnabled])
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              data.count <= 4 * 1024,
              let payload = try? JSONDecoder().decode(DNSBlockingResponse.self, from: data) else {
            throw DNSStatsAPIError.invalidResponse
        }
        return payload.blockingEnabled
    }
}

struct DNSAuthorizationRequest: Encodable {
    let installationId: String
    let transactionJWS: String
    let appTransactionJWS: String?
    let rotationNonce: String
    let currentDnsToken: String?
    let currentStatsToken: String?
}

private struct DNSAuthorizationResponse: Decodable {
    let installationId: String
    let dnsToken: String
    let statsToken: String
}

enum DNSAuthorizationAPIError: LocalizedError {
    case invalidResponse
    case transactionNotAuthorized

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The authorization service returned an invalid response"
        case .transactionNotAuthorized:
            return "The subscription could not be authorized"
        }
    }
}

final class DNSAuthorizationAPIClient: @unchecked Sendable {
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.urlCredentialStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.waitsForConnectivity = false
            configuration.timeoutIntervalForRequest = 8
            configuration.timeoutIntervalForResource = 8
            self.session = URLSession(configuration: configuration)
        }
    }

    deinit {
        session.invalidateAndCancel()
    }

    func authorize(
        transactionJWS: String,
        appTransactionJWS: String?,
        installationId: String,
        rotationNonce: String,
        currentCredentials: InstallationCredentials?,
        transactionIsRequired: Bool = true
    ) async throws -> InstallationCredentials {
        guard UUID(uuidString: installationId) != nil,
              transactionIsRequired ? !transactionJWS.isEmpty : transactionJWS.isEmpty,
              transactionJWS.utf8.count <= 128 * 1024,
              appTransactionJWS?.isEmpty != true,
              (appTransactionJWS?.utf8.count ?? 0) <= 128 * 1024,
              InstallationTokenStore.isValid(rotationNonce),
              currentCredentials?.installationId == installationId || currentCredentials == nil,
              currentCredentials.map({
                  InstallationTokenStore.isValid($0.dnsToken)
                      && InstallationTokenStore.isValid($0.statsToken)
                      && $0.dnsToken != $0.statsToken
              }) != false else {
            throw DNSAuthorizationAPIError.invalidResponse
        }

        var request = URLRequest(url: DNSCloudConfiguration.authorizationURL)
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(
            DNSAuthorizationRequest(
                installationId: installationId,
                transactionJWS: transactionJWS,
                appTransactionJWS: appTransactionJWS,
                rotationNonce: rotationNonce,
                currentDnsToken: currentCredentials?.dnsToken,
                currentStatsToken: currentCredentials?.statsToken
            )
        )

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DNSAuthorizationAPIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode), data.count <= 16 * 1024 else {
            if http.statusCode == 401 { throw DNSAuthorizationAPIError.transactionNotAuthorized }
            throw DNSAuthorizationAPIError.invalidResponse
        }

        let payload: DNSAuthorizationResponse
        do {
            payload = try JSONDecoder().decode(DNSAuthorizationResponse.self, from: data)
        } catch {
            throw DNSAuthorizationAPIError.invalidResponse
        }
        guard payload.installationId == installationId,
              InstallationTokenStore.isValid(payload.dnsToken),
              InstallationTokenStore.isValid(payload.statsToken),
              payload.dnsToken != payload.statsToken else {
            throw DNSAuthorizationAPIError.invalidResponse
        }
        return InstallationCredentials(
            installationId: payload.installationId,
            dnsToken: payload.dnsToken,
            statsToken: payload.statsToken
        )
    }

    func authorizeForDisabledSubscriptionRequirement(
        installationId: String,
        rotationNonce: String,
        currentCredentials: InstallationCredentials?
    ) async throws -> InstallationCredentials {
        try await authorize(
            transactionJWS: "",
            appTransactionJWS: nil,
            installationId: installationId,
            rotationNonce: rotationNonce,
            currentCredentials: currentCredentials,
            transactionIsRequired: false
        )
    }
}
