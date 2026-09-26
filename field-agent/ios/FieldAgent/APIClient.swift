import Foundation
import Security

struct ConnectionSettings: Codable, Equatable {
    var baseURL: String = "http://localhost:4310"
    var origin: String { baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    func url(_ path: String) throws -> URL {
        guard let root = URL(string: origin), ["https", "http"].contains(root.scheme), root.host != nil,
              root.user == nil, root.password == nil, root.query == nil, root.fragment == nil,
              root.path.isEmpty || root.path == "/",
              let result = URL(string: origin + path) else { throw ClientError.message("接続先は http(s)://ホスト:ポート の形で指定してください") }
        return result
    }
}

enum ClientError: LocalizedError {
    case message(String)
    case http(Int, String)
    var errorDescription: String? {
        switch self { case .message(let text): return text; case .http(let status, let text): return "HTTP \(status): \(text)" }
    }
}

enum TokenVault {
    static let service = "dev.innovationcup.field-agent"
    static func read() -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "api-token", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func save(_ token: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "api-token"]
        let bytes = Data(token.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = bytes
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw ClientError.message("接続トークンをKeychainへ保存できません") }
        } else if status != errSecSuccess { throw ClientError.message("接続トークンを更新できません") }
    }
}

struct APIClient {
    let settings: ConnectionSettings
    let token: String
    var session: URLSession = .shared

    func request(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json", operationId: String? = nil) async throws -> Data {
        guard !token.isEmpty else { throw ClientError.message("設定で接続トークンを入力してください") }
        var request = URLRequest(url: try settings.url(path))
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let operationId { request.setValue(operationId, forHTTPHeaderField: "Idempotency-Key") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.message("サーバーの応答を確認できません") }
        guard (200..<300).contains(http.statusCode) else {
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let detail = object?["error"] as? String ?? object?["message"] as? String ?? "リクエストが完了しませんでした"
            throw ClientError.http(http.statusCode, detail)
        }
        return data
    }
    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        try JSONDecoder().decode(type, from: await request(path))
    }
    @discardableResult
    func post<T: Encodable>(_ path: String, _ value: T, operationId: String? = nil) async throws -> Data {
        try await request(path, method: "POST", body: JSONEncoder().encode(value), operationId: operationId)
    }
    func upload(taskId: String, metadata: ObservationMetadata, jpeg: Data) async throws {
        let boundary = "FieldAgent-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n")
        body.append(try JSONEncoder().encode(metadata))
        append("\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n")
        body.append(jpeg)
        append("\r\n--\(boundary)--\r\n")
        _ = try await request("/api/tasks/\(taskId)/observations", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)")
    }
}
