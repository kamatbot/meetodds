import CryptoKit
import Foundation
import Security
import MeetOddsCore

struct CompanionStatus: Decodable, Sendable {
    struct Model: Decodable, Identifiable, Sendable { let id: String; let name: String }
    let connected: Bool
    let models: [Model]
    let plan: String?
}
struct CompanionSummary: Decodable, Sendable { let markdown: String; let model: String }

/// TLS is pinned to the exact certificate paired by the user. No redirects or shared cookie jar.
final class CompanionClient: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let pairing: CompanionPairing
    init(pairing: CompanionPairing) { self.pairing = pairing }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == pairing.url.host,
              let trust = challenge.protectionSpace.serverTrust,
              let certificate = SecTrustGetCertificateAtIndex(trust, 0) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        let bytes = SecCertificateCopyData(certificate) as Data
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard hash == pairing.fingerprint else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, challenge.protectionSpace.host as CFString))
        guard SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    private func request<T: Decodable>(_ path: String, body: Data? = nil) async throws -> T {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 180; config.timeoutIntervalForResource = 190
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: pairing.url.appendingPathComponent(path))
        request.httpMethod = body == nil ? "GET" : "POST"; request.httpBody = body
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw MeetingError.failed("The companion returned an invalid response.") }
        guard response.statusCode == 200 else {
            switch response.statusCode {
            case 401: throw MeetingError.failed("Pair this iPhone again. The companion token is no longer valid.")
            case 409: throw MeetingError.failed("The companion is already generating a summary. Retry after it finishes.")
            case 429: throw MeetingError.failed("ChatGPT's usage limit was reached. No API fallback was used.")
            default: throw MeetingError.failed("The companion could not generate this summary. Check its ChatGPT sign-in and selected model, then retry. Your recording is unchanged.")
            }
        }
        guard data.count <= 512_000 else { throw MeetingError.tooLarge }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func status() async throws -> CompanionStatus { try await request("v1/status") }
    func summarize(input: String, templateID: String, model: String?) async throws -> CompanionSummary {
        struct Body: Encodable { let input: String; let templateID: String; let model: String? }
        let body = try JSONEncoder().encode(Body(input: input, templateID: templateID, model: model))
        guard body.count <= 600_000 else { throw MeetingError.tooLarge }
        return try await request("v1/summary", body: body)
    }
}

enum PairingKeychain {
    private static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.meetodds.companion", kSecAttrAccount as String: "pairing"] }
    static func save(_ pairing: CompanionPairing) throws {
        let data = try JSONEncoder().encode(pairing)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var item = query; item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw MeetingError.failed("Pairing could not be saved securely.") }
        } else if update != errSecSuccess { throw MeetingError.failed("Pairing could not be updated securely.") }
    }
    static func load() -> CompanionPairing? {
        var item = query; item[kSecReturnData as String] = true; item[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &value) == errSecSuccess, let data = value as? Data,
              let decoded = try? JSONDecoder().decode(CompanionPairing.self, from: data) else { return nil }
        return try? CompanionPairing(url: decoded.url, token: decoded.token, fingerprint: decoded.fingerprint)
    }
    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw MeetingError.failed("Pairing could not be removed.") }
    }
}
