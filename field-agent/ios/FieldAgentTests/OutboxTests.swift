import XCTest
@testable import FieldAgent

final class OutboxTests: XCTestCase {
    private var folder: URL!
    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }
    override func tearDownWithError() throws { if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) } }

    func testRestartRetainsOriginalBytesAndIdempotencyIDs() throws {
        let outbox = try LocalOutbox(root: folder)
        let photo = samplePhoto()
        let queued = try outbox.enqueue(origin: "http://localhost:4310", taskId: "task-1", photos: [photo], requestId: "request-1")
        let reopened = try LocalOutbox(root: folder)
        let saved = try XCTUnwrap(reopened.list().first)
        XCTAssertEqual(saved.id, queued.id)
        XCTAssertEqual(saved.answer?.id, queued.id)
        XCTAssertEqual(saved.answer?.observationIds, [photo.metadata.id])
        XCTAssertEqual(saved.photos.first?.metadata.id, photo.metadata.id)
        XCTAssertEqual(try reopened.photoData(saved.photos[0], item: saved), photo.jpeg)
    }

    func testFailedSendStaysQueuedUntilAcknowledged() throws {
        let outbox = try LocalOutbox(root: folder)
        var queued = try outbox.enqueue(origin: "http://localhost:4310", taskId: "task-1", photos: [samplePhoto()])
        queued.error = "HTTP 409: stale request"
        try outbox.save(queued)
        XCTAssertEqual(try outbox.list().first?.error, queued.error)
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent(queued.id).appendingPathComponent(queued.photos[0].filename).path))
        try outbox.acknowledge(queued)
        XCTAssertTrue(try outbox.list().isEmpty)
    }

    func testIncompleteWriteWithoutManifestIsNeverSent() throws {
        let outbox = try LocalOutbox(root: folder)
        let interrupted = folder.appendingPathComponent("interrupted")
        try FileManager.default.createDirectory(at: interrupted, withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: interrupted.appendingPathComponent("capture.jpg"))
        XCTAssertTrue(try outbox.list().isEmpty)
    }

    func testConfirmationAnswerRetainsExistingEvidenceWithoutDuplicatingPhotos() throws {
        let outbox = try LocalOutbox(root: folder)
        let queued = try outbox.enqueue(origin: "http://localhost:4310", taskId: "task-1", photos: [], requestId: "request-1", existingObservationIds: ["observation-1"])
        XCTAssertEqual(try outbox.list().first?.answer?.observationIds, ["observation-1"])
        XCTAssertTrue(queued.photos.isEmpty)
    }

    func testARWireContractPreservesFrameTimeAndEvidence() throws {
        let photo = samplePhoto()
        let endpoint = MeasurementEndpoint(coordinateFrameId: "frame-1", captureSessionId: "capture-1", timestamp: 42.25, position: [0, 0, -1], hit: "estimated_plane", tracking: "normal", evidenceIds: [photo.metadata.id])
        let measurement = ARMeasurement(id: "measurement-1", targetId: "H1", unit: "m", evidenceIds: [photo.metadata.id], method: "ar_raycast", from: endpoint, to: endpoint)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(measurement)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["id", "targetId", "unit", "evidenceIds", "method", "from", "to"])
        let from = try XCTUnwrap(object["from"] as? [String: Any])
        XCTAssertEqual(from["timestamp"] as? Double, photo.metadata.spatial?.timestamp)
        XCTAssertEqual(from["tracking"] as? String, photo.metadata.spatial?.tracking)
        XCTAssertNil(object["accuracy"])
        XCTAssertNil(object["confirmed"])
    }

    func testConnectionRejectsCredentialsAndNonHTTPURL() throws {
        XCTAssertThrowsError(try ConnectionSettings(baseURL: "file:///etc").url("/api/tasks"))
        XCTAssertThrowsError(try ConnectionSettings(baseURL: "http://user:secret@localhost:4310").url("/api/tasks"))
        XCTAssertEqual(try ConnectionSettings(baseURL: "http://localhost:4310/").url("/api/tasks").absoluteString, "http://localhost:4310/api/tasks")
    }

    private func samplePhoto() -> CapturedPhoto {
        let spatial = SpatialMetadata(coordinateFrameId: "frame-1", captureSessionId: "capture-1", timestamp: 42.25, cameraToWorld: [], intrinsics: [], tracking: "normal", rawImageWidth: 1920, rawImageHeight: 1440, imageRotation: "clockwise_90", matrixLayout: "column_major", worldUnit: "m", worldAlignment: "gravity", cameraGravity: [0, -1, 0])
        return CapturedPhoto(metadata: ObservationMetadata(id: "observation-1", targetId: "H1", capturedAt: "2026-09-26T00:00:00Z", source: "ios_ar", synthetic: false, spatial: spatial), jpeg: Data([0xff, 0xd8, 0xff, 0xd9]))
    }
}
