import Foundation

enum DNSCloudConfiguration {
    nonisolated static let dnsQueryPath = "dns-query"
    nonisolated static let statsPath = "/v1/stats"
    nonisolated static let blockingPath = "/v1/blocking"
    nonisolated static let authorizationPath = "/v1/authorization/register"
    nonisolated static let accessPolicyPath = "/v1/access-policy"

    nonisolated static var baseURL: URL {
        guard let url = URL(string: BuildEnvironment.dnsCloudBaseURL),
              url.scheme?.lowercased() == "https",
              url.host != nil,
              url.path.isEmpty || url.path == "/",
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil else {
            preconditionFailure("AdlessDNSCloudBaseURL must be an HTTPS origin")
        }
        return url
    }

    nonisolated static func endpointURL(for token: String) throws -> URL {
        guard InstallationTokenStore.isValid(token) else { throw DNSSettingsManagerError.invalidEndpoint }
        return baseURL
            .appendingPathComponent(token, isDirectory: true)
            .appendingPathComponent(dnsQueryPath)
    }

    nonisolated static var statsURL: URL {
        baseURL.appendingPathComponent(statsPath)
    }

    nonisolated static var blockingURL: URL {
        baseURL.appendingPathComponent(blockingPath)
    }

    nonisolated static var authorizationURL: URL {
        baseURL.appendingPathComponent(authorizationPath)
    }

    nonisolated static var accessPolicyURL: URL {
        baseURL.appendingPathComponent(accessPolicyPath)
    }

    nonisolated static func isAdlessEndpoint(_ url: URL) -> Bool {
        let components = url.path.split(separator: "/", omittingEmptySubsequences: true)
        guard components.count == 2,
              components[1] == Substring(dnsQueryPath),
              InstallationTokenStore.isValid(String(components[0])) else {
            return false
        }
        return url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == baseURL.host?.lowercased()
            && url.port == baseURL.port
            && url.query == nil
            && url.fragment == nil
    }
}
