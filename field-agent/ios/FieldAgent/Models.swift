import Foundation

struct TaskSummary: Codable, Identifiable {
    let id: String
    let title: String
    let state: String
    let revision: Int
}

struct FieldTask: Codable, Identifiable {
    let id: String
    let title: String
    let targetId: String
    let revision: Int
    let state: String
    let plan: Plan
    let facts: [String: Fact]
    let candidates: [Candidate]
    let observations: [Observation]
    let requests: [EvidenceRequest]
    let validation: ValidationReport?
    let artifact: Artifact?
    let run: RunState
}

struct Plan: Codable { let revision: Int; let orientation: String; let lengthMeters: Double; let svg: String }
struct Fact: Codable { var value: String?; var confirmed: Bool; var evidenceIds: [String]; var source: String }
struct Candidate: Codable, Identifiable { let id: String; let reason: String; let facts: [String: Fact] }
struct Observation: Codable, Identifiable {
    let id: String
    let targetId: String
    let assetId: String
    let capturedAt: String
    let source: String
    let synthetic: Bool
    let superseded: Bool?
}
struct EvidenceRequest: Codable, Identifiable {
    let id: String
    let kind: String
    let reason: String
    let fields: [String]
    let status: String
    let baseRevision: Int
}
struct ValidationReport: Codable {
    let taskRevision: Int
    let planRevision: Int
    let rule: RuleResult
    let comparison: PlanComparison
    let missingInputs: [String]
    let measurements: [MeasurementValidation]
}
struct MeasurementValidation: Codable { let status: String; let accuracy: String; let valueMeters: Double?; let reason: String }
struct RuleResult: Codable { let status: String; let reason: String; let missingInputs: [String] }
struct PlanComparison: Codable { let status: String; let reason: String }
struct Artifact: Codable, Identifiable { let id: String; let title: String; let unresolved: [String]; let scope: String }
struct RunState: Codable { let status: String; let error: String? }

struct ObservationMetadata: Codable {
    let id: String
    let targetId: String
    let capturedAt: String
    let source: String
    let synthetic: Bool
    let spatial: SpatialMetadata?
}
struct SpatialMetadata: Codable {
    let coordinateFrameId: String
    let captureSessionId: String
    let timestamp: Double
    let cameraToWorld: [Float]
    let intrinsics: [Float]
    let tracking: String
    // ARKit image and matrix conventions are retained separately from the normalized JPEG.
    let rawImageWidth: Int
    let rawImageHeight: Int
    let imageRotation: String
    let matrixLayout: String
    let worldUnit: String
    let worldAlignment: String
    let cameraGravity: [Float]
}
struct MeasurementEndpoint: Codable {
    let coordinateFrameId: String
    let captureSessionId: String
    let timestamp: Double
    let position: [Float]
    let hit: String
    let tracking: String
    let evidenceIds: [String]
}
struct ARMeasurement: Codable, Identifiable {
    let id: String
    let targetId: String
    let unit: String
    let evidenceIds: [String]
    let method: String
    let from: MeasurementEndpoint
    let to: MeasurementEndpoint
}
struct RequestAnswer: Codable {
    let id: String
    let requestId: String
    let observationIds: [String]
    let measurementIds: [String]
    let unavailableReason: String?
}
struct FactsCommand: Codable { let baseRevision: Int; let facts: [String: Fact] }

struct CapturedPhoto {
    let metadata: ObservationMetadata
    let jpeg: Data
}

extension String {
    var fieldLabel: String {
        ["model": "型式", "installation": "設置状態", "mounting": "取付方式", "orientation": "向き", "verticalReference": "上下の根拠",
         "pendent": "下向き", "upright": "上向き", "sideways": "横向き", "unknown": "未確認", "installed": "設置済み", "uninstalled": "未設置", "standard": "標準", "recessed": "埋込", "gravity": "重力・現場の鉛直", "verified_record": "確認済み記録",
         "pass": "条件を満たす", "fail": "条件と不一致", "not_applicable": "この条件の適用外", "match": "図面と一致", "different": "図面と相違", "capture": "追加撮影", "measurement": "計測", "confirmation": "事実の確認", "active": "作業中", "waiting": "追加情報待ち", "review_ready": "確認待ち", "cancelled": "中止"] [self] ?? self
    }
}
