import ARKit
import AVFoundation
import Combine
import CoreImage
import FocusEntity
import RealityKit
import SwiftUI

@MainActor
final class CaptureController: NSObject, ObservableObject, ARSessionDelegate {
    @Published var guidance = "周囲の模様が見えるように、ゆっくり端末を動かしてください"
    @Published var ready = false
    @Published var started = false
    @Published var error: String?
    @Published var firstPoint: MeasurementEndpoint?
    @Published var secondPoint: MeasurementEndpoint?
    @Published var photos: [CapturedPhoto] = []
    let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    private var focus: FocusEntity?
    private var captureSessionId = UUID().uuidString
    private var coordinateFrameId = UUID().uuidString
    private var pins: [AnchorEntity] = []
    private let imageContext = CIContext()
    private var starting = false
    private var coordinatesInvalidated = false

    var distance: Float? {
        guard let firstPoint, let secondPoint else { return nil }
        let a = SIMD3<Float>(firstPoint.position[0], firstPoint.position[1], firstPoint.position[2])
        let b = SIMD3<Float>(secondPoint.position[0], secondPoint.position[1], secondPoint.position[2])
        return simd_distance(a, b)
    }
    var isSupported: Bool { ARWorldTrackingConfiguration.isSupported }
    func start() async {
        guard !started, !starting else { return }
        starting = true
        defer { starting = false }
        guard isSupported else { guidance = "AR撮影・計測はiPhone実機で使用してください"; return }
        guard await AVCaptureDevice.requestAccess(for: .video) else { error = "設定アプリでカメラの使用を許可してください"; return }
        restart()
    }
    func restart() {
        clearPoints()
        captureSessionId = UUID().uuidString
        coordinateFrameId = UUID().uuidString
        coordinatesInvalidated = false
        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.planeDetection = [.horizontal, .vertical]
        arView.session.delegate = self
        arView.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        focus?.destroy()
        focus = FocusEntity(on: arView, style: .classic(color: .systemTeal))
        ready = false
        started = true
    }
    func stop() {
        arView.session.pause()
        focus?.destroy(); focus = nil
        started = false; ready = false
        clearPoints()
    }
    func clearPoints() {
        firstPoint = nil; secondPoint = nil; photos = []
        pins.forEach { $0.removeFromParent() }; pins = []
    }
    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            switch frame.camera.trackingState {
            case .normal:
                self.coordinatesInvalidated = false
                self.ready = true
                self.guidance = self.firstPoint == nil ? "中央の印を始点に合わせてください" : "中央の印を終点に合わせてください"
            case .notAvailable:
                self.ready = false; self.guidance = "位置追跡を利用できません"
            case .limited(let reason):
                self.ready = false
                switch reason {
                case .excessiveMotion: self.guidance = "端末の動きをゆっくりにしてください"
                case .insufficientFeatures: self.guidance = "周囲の模様や角を含めて映してください"
                case .relocalizing:
                    if !self.coordinatesInvalidated {
                        self.clearPoints()
                        self.coordinateFrameId = UUID().uuidString
                        self.coordinatesInvalidated = true
                    }
                    self.guidance = "位置を復元しています。計測は始点からやり直してください"
                default: self.guidance = "周囲を映して位置を確認しています"
                }
            }
        }
    }
    nonisolated func sessionWasInterrupted(_ session: ARSession) {
        Task { @MainActor [weak self] in self?.ready = false; self?.clearPoints(); self?.guidance = "撮影が中断しました。再開すると始点から測り直します" }
    }
    nonisolated func sessionInterruptionEnded(_ session: ARSession) { Task { @MainActor [weak self] in self?.restart() } }
    nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        Task { @MainActor [weak self] in self?.ready = false; self?.clearPoints(); self?.error = error.localizedDescription }
    }
    func photo(targetId: String) throws -> CapturedPhoto {
        guard started, let frame = arView.session.currentFrame else { throw ClientError.message("カメラの準備ができていません") }
        return try encode(frame, targetId: targetId, source: "ios_camera")
    }
    func takeEndpoint(targetId: String) {
        do {
            guard secondPoint == nil, started, let frame = arView.session.currentFrame,
                  case .normal = frame.camera.trackingState else { throw ClientError.message("位置追跡が安定してから、もう一度指定してください") }
            guard ProcessInfo.processInfo.systemUptime - frame.timestamp < 1 else { throw ClientError.message("新しいカメラ画像を待っています") }
            // ARFrame expects normalized coordinates, unlike ARView's point-based API.
            let point = CGPoint(x: 0.5, y: 0.5)
            var selected: ARRaycastResult?
            for target in [ARRaycastQuery.Target.existingPlaneGeometry, .estimatedPlane] {
                let query = frame.raycastQuery(from: point, allowing: target, alignment: .any)
                if let result = arView.session.raycast(query).first { selected = result; break }
            }
            guard let hit = selected else { throw ClientError.message("表面が見つかりません。角度を変えるか、模様のある箇所を映してください") }
            let t = hit.worldTransform.columns.3
            let position = SIMD3<Float>(t.x, t.y, t.z)
            guard position.x.isFinite, position.y.isFinite, position.z.isFinite else { throw ClientError.message("取得した位置を使用できません") }
            let image = try encode(frame, targetId: targetId, source: "ios_ar")
            let endpoint = MeasurementEndpoint(coordinateFrameId: coordinateFrameId, captureSessionId: captureSessionId, timestamp: frame.timestamp, position: [position.x, position.y, position.z], hit: hit.target == .existingPlaneGeometry ? "existing_plane" : "estimated_plane", tracking: "normal", evidenceIds: [image.metadata.id])
            if let firstPoint {
                guard firstPoint.captureSessionId == captureSessionId, firstPoint.coordinateFrameId == coordinateFrameId else { clearPoints(); throw ClientError.message("座標系が変わりました。始点から指定してください") }
                secondPoint = endpoint
            } else { firstPoint = endpoint }
            photos.append(image)
            let marker = ModelEntity(mesh: .generateSphere(radius: 0.006), materials: [UnlitMaterial(color: .systemTeal)])
            let anchor = AnchorEntity(world: position)
            anchor.addChild(marker); arView.scene.addAnchor(anchor); pins.append(anchor)
        } catch { self.error = error.localizedDescription }
    }
    func measurement(targetId: String) throws -> ARMeasurement {
        guard let from = firstPoint, let to = secondPoint else { throw ClientError.message("始点と終点を指定してください") }
        return ARMeasurement(id: UUID().uuidString, targetId: targetId, unit: "m", evidenceIds: photos.map(\.metadata.id), method: "ar_raycast", from: from, to: to)
    }
    private func encode(_ frame: ARFrame, targetId: String, source: String) throws -> CapturedPhoto {
        // Portrait-only client; normalize ARKit's landscape pixel buffer by rotating clockwise.
        let raw = CIImage(cvPixelBuffer: frame.capturedImage)
        let oriented = raw.oriented(.right)
        guard let cg = imageContext.createCGImage(oriented, from: oriented.extent), let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.9) else { throw ClientError.message("撮影画像を保存できません") }
        let matrix = frame.camera.transform
        let intrinsic = frame.camera.intrinsics
        let rotation = simd_float3x3(SIMD3(matrix.columns.0.x, matrix.columns.0.y, matrix.columns.0.z), SIMD3(matrix.columns.1.x, matrix.columns.1.y, matrix.columns.1.z), SIMD3(matrix.columns.2.x, matrix.columns.2.y, matrix.columns.2.z))
        let gravity = rotation.transpose * SIMD3<Float>(0, -1, 0)
        let tracking: String
        switch frame.camera.trackingState { case .normal: tracking = "normal"; case .limited: tracking = "limited"; case .notAvailable: tracking = "unavailable" }
        let spatial = SpatialMetadata(coordinateFrameId: coordinateFrameId, captureSessionId: captureSessionId, timestamp: frame.timestamp,
            cameraToWorld: (0..<4).flatMap { c in (0..<4).map { r in matrix[c][r] } }, intrinsics: (0..<3).flatMap { c in (0..<3).map { r in intrinsic[c][r] } }, tracking: tracking,
            rawImageWidth: CVPixelBufferGetWidth(frame.capturedImage), rawImageHeight: CVPixelBufferGetHeight(frame.capturedImage), imageRotation: "clockwise_90", matrixLayout: "column_major", worldUnit: "m", worldAlignment: "gravity", cameraGravity: [gravity.x, gravity.y, gravity.z])
        return CapturedPhoto(metadata: ObservationMetadata(id: UUID().uuidString, targetId: targetId, capturedAt: ISO8601DateFormatter().string(from: Date()), source: source, synthetic: false, spatial: spatial), jpeg: jpeg)
    }
}

struct CameraPreview: UIViewRepresentable {
    let controller: CaptureController
    func makeUIView(context: Context) -> ARView { controller.arView }
    func updateUIView(_ uiView: ARView, context: Context) {}
}
