import Foundation

struct QueuedPhoto: Codable { let metadata: ObservationMetadata; let filename: String }
struct PendingSubmission: Codable, Identifiable {
    let id: String
    let serverOrigin: String
    let taskId: String
    let createdAt: Date
    let photos: [QueuedPhoto]
    let measurements: [ARMeasurement]
    let answer: RequestAnswer?
    var error: String?
}

/// The manifest is written last. Retry always uses the same IDs and original JPEG bytes.
struct LocalOutbox {
    let root: URL
    init(root: URL? = nil) throws {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FieldAgent/Outbox", isDirectory: true)
        try FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
    }
    func list() throws -> [PendingSubmission] {
        let directories = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        return try directories.compactMap { directory -> PendingSubmission? in
            let manifest = directory.appendingPathComponent("manifest.json")
            guard FileManager.default.fileExists(atPath: manifest.path) else { return nil }
            return try JSONDecoder().decode(PendingSubmission.self, from: Data(contentsOf: manifest))
        }.sorted { $0.createdAt < $1.createdAt }
    }
    func enqueue(origin: String, taskId: String, photos: [CapturedPhoto], measurement: ARMeasurement? = nil, requestId: String? = nil, existingObservationIds: [String] = [], unavailableReason: String? = nil) throws -> PendingSubmission {
        let id = UUID().uuidString
        let directory = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let queued = try photos.map { photo -> QueuedPhoto in
            let filename = photo.metadata.id + ".jpg"
            try photo.jpeg.write(to: directory.appendingPathComponent(filename), options: .atomic)
            return QueuedPhoto(metadata: photo.metadata, filename: filename)
        }
        let answer = requestId.map { RequestAnswer(id: id, requestId: $0, observationIds: Array(Set(photos.map(\.metadata.id) + existingObservationIds)).sorted(), measurementIds: measurement.map { [$0.id] } ?? [], unavailableReason: unavailableReason) }
        let item = PendingSubmission(id: id, serverOrigin: origin, taskId: taskId, createdAt: Date(), photos: queued, measurements: measurement.map { [$0] } ?? [], answer: answer, error: nil)
        try save(item)
        return item
    }
    func save(_ item: PendingSubmission) throws {
        try JSONEncoder().encode(item).write(to: root.appendingPathComponent(item.id).appendingPathComponent("manifest.json"), options: .atomic)
    }
    func photoData(_ photo: QueuedPhoto, item: PendingSubmission) throws -> Data {
        guard photo.filename == photo.metadata.id + ".jpg", !photo.filename.contains("/"), !item.id.contains("/") else { throw ClientError.message("未送信データの参照が不正です") }
        return try Data(contentsOf: root.appendingPathComponent(item.id).appendingPathComponent(photo.filename))
    }
    func acknowledge(_ item: PendingSubmission) throws {
        // Only called after all server operations have succeeded; local pending copies are no longer needed.
        try FileManager.default.removeItem(at: root.appendingPathComponent(item.id))
    }
}
