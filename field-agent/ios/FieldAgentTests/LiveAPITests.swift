import XCTest
import UIKit
@testable import FieldAgent

/// Opt-in: this exercises native URLSession against the local server, using visibly synthetic records.
final class LiveAPITests: XCTestCase {
    @MainActor
    func testNativeClientRoundTripWithSyntheticEvidence() async throws {
        guard let tokenPath = ProcessInfo.processInfo.environment["FIELD_AGENT_TEST_TOKEN_FILE"] else {
            throw XCTSkip("Set FIELD_AGENT_TEST_TOKEN_FILE to enable the local-server integration test")
        }
        let token = try String(contentsOfFile: tokenPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let origin = ProcessInfo.processInfo.environment["FIELD_AGENT_TEST_URL"] ?? "http://127.0.0.1:4310"
        let client = APIClient(settings: ConnectionSettings(baseURL: origin), token: token)
        let created = try await client.post("/api/tasks", ["title": "iOS通信検証 · 合成データ", "planOrientation": "pendent"])
        let initial = try JSONDecoder().decode(FieldTask.self, from: created)
        let path = "/api/tasks/\(initial.id)"
        let list = try await client.get("/api/tasks", as: [TaskSummary].self)
        XCTAssertTrue(list.contains { $0.id == initial.id })

        struct RequestCommand: Encodable { let kind = "measurement"; let reason = "通信検証用の合成計測"; let fields = ["distance"] }
        let requestBytes = try await client.post(path + "/requests", RequestCommand())
        let request = try JSONDecoder().decode(EvidenceRequest.self, from: requestBytes)
        let jpeg = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 100, height: 100)).image { context in
            UIColor.systemOrange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
            ("SYNTHETIC" as NSString).draw(at: CGPoint(x: 4, y: 40), withAttributes: [.font: UIFont.systemFont(ofSize: 12), .foregroundColor: UIColor.black])
        }.jpegData(compressionQuality: 0.9))
        var photos: [CapturedPhoto] = []
        var endpoints: [MeasurementEndpoint] = []
        let captureId = UUID().uuidString, frameId = UUID().uuidString
        for index in 0..<2 {
            let id = UUID().uuidString
            let timestamp = 100 + Double(index)
            let spatial = SpatialMetadata(coordinateFrameId: frameId, captureSessionId: captureId, timestamp: timestamp, cameraToWorld: [], intrinsics: [], tracking: "normal", rawImageWidth: 100, rawImageHeight: 100, imageRotation: "clockwise_90", matrixLayout: "column_major", worldUnit: "m", worldAlignment: "gravity", cameraGravity: [0, -1, 0])
            let metadata = ObservationMetadata(id: id, targetId: initial.targetId, capturedAt: ISO8601DateFormatter().string(from: Date()), source: "ios_ar", synthetic: true, spatial: spatial)
            photos.append(CapturedPhoto(metadata: metadata, jpeg: jpeg))
            endpoints.append(MeasurementEndpoint(coordinateFrameId: frameId, captureSessionId: captureId, timestamp: timestamp, position: [Float(index), 0, -1], hit: "estimated_plane", tracking: "normal", evidenceIds: [id]))
        }
        for photo in photos {
            try await client.upload(taskId: initial.id, metadata: photo.metadata, jpeg: photo.jpeg)
            // Retry the exact original bytes and metadata. The server must not duplicate the observation.
            try await client.upload(taskId: initial.id, metadata: photo.metadata, jpeg: photo.jpeg)
        }
        let evidence = photos.map(\.metadata.id)
        let measurement = ARMeasurement(id: UUID().uuidString, targetId: initial.targetId, unit: "m", evidenceIds: evidence, method: "ar_raycast", from: endpoints[0], to: endpoints[1])
        try await client.post(path + "/measurements", measurement)
        try await client.post(path + "/measurements", measurement)
        let answer = RequestAnswer(id: UUID().uuidString, requestId: request.id, observationIds: evidence, measurementIds: [measurement.id], unavailableReason: nil)
        try await client.post(path + "/answers", answer)
        try await client.post(path + "/answers", answer)
        let captured = try await client.get(path, as: FieldTask.self)
        XCTAssertEqual(captured.observations.count, 2)
        XCTAssertEqual(captured.requests.first?.status, "answered")
        let asset = try XCTUnwrap(captured.observations.first?.assetId)
        let imageBytes = try await client.request(path + "/assets/" + asset)
        XCTAssertNotNil(UIImage(data: imageBytes))
        let values = ["model": "TY3231", "installation": "installed", "mounting": "standard", "orientation": "pendent", "verticalReference": "gravity"]
        let facts = values.mapValues { Fact(value: $0, confirmed: true, evidenceIds: evidence, source: "manual") }
        try await client.post(path + "/facts", FactsCommand(baseRevision: captured.revision, facts: facts), operationId: UUID().uuidString)
        let validation = try JSONDecoder().decode(ValidationReport.self, from: await client.post(path + "/validate", [String: String]()))
        XCTAssertEqual(validation.rule.status, "pass")
        XCTAssertEqual(validation.comparison.status, "match")
        XCTAssertEqual(validation.measurements.count, 1)
        XCTAssertEqual(validation.measurements.first?.status, "recorded")
        XCTAssertEqual(validation.measurements.first?.accuracy, "unknown")
        XCTAssertEqual(validation.measurements.first?.valueMeters, 1)
        try await client.post(path + "/artifact", [String: String]())
        let reviewed = try await client.get(path, as: FieldTask.self)
        XCTAssertNotNil(reviewed.artifact)
        try await client.post(path + "/cancel", [String: String]())
    }
}
