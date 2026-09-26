import Foundation
import Network
import SwiftUI

@MainActor
final class AppStore: ObservableObject {
    @Published var settings = ConnectionSettings()
    @Published var tasks: [TaskSummary] = []
    @Published var currentTask: FieldTask?
    @Published var pending: [PendingSubmission] = []
    @Published var error: String?
    @Published var notice: String?
    @Published var busy = false
    @Published var syncing = false
    @Published var isOffline = false
    private var token = ""
    private var outbox: LocalOutbox?
    private var poller: Task<Void, Never>?
    private var selectedTaskId: String?
    private let networkMonitor = NWPathMonitor()
    private let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FieldAgent", isDirectory: true)

    var api: APIClient { APIClient(settings: settings, token: token) }
    var tokenIsSet: Bool { !token.isEmpty }

    init() {
        if let bytes = UserDefaults.standard.data(forKey: "field.connection"), let saved = try? JSONDecoder().decode(ConnectionSettings.self, from: bytes) { settings = saved }
        token = TokenVault.read()
        do {
            outbox = try LocalOutbox()
            try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            pending = try outbox?.list() ?? []
            if let bytes = try? Data(contentsOf: tasksCache) { tasks = (try? JSONDecoder().decode([TaskSummary].self, from: bytes)) ?? [] }
        } catch { self.error = "端末内の保存領域を開けません: \(error.localizedDescription)" }
        networkMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor [weak self] in await self?.syncOutbox() }
        }
        networkMonitor.start(queue: DispatchQueue(label: "field.network"))
    }
    func saveSettings(baseURL: String, newToken: String) async {
        error = nil
        busy = true; defer { busy = false }
        do {
            let next = ConnectionSettings(baseURL: baseURL.trimmingCharacters(in: .whitespacesAndNewlines))
            _ = try next.url("/api/tasks")
            guard !newToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !token.isEmpty else { throw ClientError.message("接続トークンを入力してください") }
            if !newToken.isEmpty { try TokenVault.save(newToken.trimmingCharacters(in: .whitespacesAndNewlines)); token = TokenVault.read() }
            let originChanged = settings.origin != next.origin
            settings = next
            UserDefaults.standard.set(try JSONEncoder().encode(next), forKey: "field.connection")
            if originChanged { tasks = []; currentTask = nil; selectedTaskId = nil; stopPolling() }
            notice = "接続設定を保存しました"
            await refreshTasks()
            await syncOutbox()
        } catch { self.error = error.localizedDescription }
    }
    func refreshTasks() async {
        let client = api
        do {
            let fetched = try await client.get("/api/tasks", as: [TaskSummary].self)
            guard settings.origin == client.settings.origin else { return }
            tasks = fetched
            try JSONEncoder().encode(tasks).write(to: tasksCache, options: .atomic)
            isOffline = false
        } catch { if settings.origin == client.settings.origin { isOffline = true; self.error = error.localizedDescription } }
    }
    func createTask(title: String) async -> String? {
        busy = true; defer { busy = false }
        do {
            let response = try await api.post("/api/tasks", ["title": title.isEmpty ? "現場の確認" : title, "planOrientation": "pendent"])
            let value = try JSONDecoder().decode(TaskSummary.self, from: response)
            await refreshTasks()
            return value.id
        } catch { self.error = error.localizedDescription; return nil }
    }
    func openTask(_ id: String) async {
        selectedTaskId = id
        if currentTask?.id != id {
            currentTask = nil
            if let bytes = try? Data(contentsOf: taskCache(id)), let task = try? JSONDecoder().decode(FieldTask.self, from: bytes) { currentTask = task }
        }
        await refreshTask(id)
        guard selectedTaskId == id, !Task.isCancelled else { return }
        stopPolling()
        poller = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled, let self else { return }
                await self.refreshTask(id, reportError: false)
            }
        }
    }
    func stopPolling() { poller?.cancel(); poller = nil }
    func refreshTask(_ id: String, reportError: Bool = true) async {
        let client = api
        do {
            let task = try await client.get("/api/tasks/\(id)", as: FieldTask.self)
            guard settings.origin == client.settings.origin, selectedTaskId == id else { return }
            currentTask = task
            try JSONEncoder().encode(task).write(to: taskCache(id), options: .atomic)
            isOffline = false
        } catch {
            guard settings.origin == client.settings.origin, selectedTaskId == id else { return }
            isOffline = true
            if reportError { self.error = error.localizedDescription }
        }
    }
    private func taskCache(_ id: String) -> URL {
        func key(_ value: String) -> String { Data(value.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "=", with: "") }
        let safeID = key(id)
        let originKey = key(settings.origin)
        return support.appendingPathComponent("task-\(originKey)-\(safeID).json")
    }
    private var tasksCache: URL { taskCache("list") }
    func queue(task: FieldTask, photos: [CapturedPhoto], measurement: ARMeasurement? = nil, requestId: String? = nil, existingObservationIds: [String] = [], unavailableReason: String? = nil) async -> Bool {
        do {
            guard let outbox else { throw ClientError.message("端末内へ保存できないため、送信を開始できません") }
            _ = try outbox.enqueue(origin: settings.origin, taskId: task.id, photos: photos, measurement: measurement, requestId: requestId, existingObservationIds: existingObservationIds, unavailableReason: unavailableReason)
            pending = try outbox.list()
            notice = "端末に保存しました。通信が戻れば同じIDで再送します"
            Task { await syncOutbox() }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func syncOutbox() async {
        guard !syncing, tokenIsSet, let outbox else { return }
        syncing = true; defer { syncing = false }
        let client = api
        do {
            let entries = try outbox.list()
            for var item in entries where item.serverOrigin == client.settings.origin {
                do {
                    // Observation uploads must precede the measurement and answer that reference them.
                    for photo in item.photos { try await client.upload(taskId: item.taskId, metadata: photo.metadata, jpeg: outbox.photoData(photo, item: item)) }
                    for measurement in item.measurements { try await client.post("/api/tasks/\(item.taskId)/measurements", measurement) }
                    if let answer = item.answer { try await client.post("/api/tasks/\(item.taskId)/answers", answer) }
                    try outbox.acknowledge(item)
                    if settings.origin == client.settings.origin, currentTask?.id == item.taskId { await refreshTask(item.taskId, reportError: false) }
                } catch {
                    item.error = error.localizedDescription
                    try outbox.save(item)
                    self.error = "未送信データは端末に残っています。\(error.localizedDescription)"
                    if case ClientError.http(let status, _) = error, [400, 404, 409, 413, 422].contains(status) { continue }
                    break
                }
            }
            pending = try outbox.list()
        } catch { self.error = error.localizedDescription }
    }
    func run(_ id: String) async {
        busy = true; defer { busy = false }
        do { try await api.post("/api/tasks/\(id)/run", ["message": "現場の観測と回答を確認し、検証して、必要な追加情報を依頼してください"]); await refreshTask(id) }
        catch { self.error = error.localizedDescription }
    }
    func validate(_ id: String) async {
        busy = true; defer { busy = false }
        do { try await api.post("/api/tasks/\(id)/validate", [String: String]()); await refreshTask(id) }
        catch { self.error = error.localizedDescription }
    }
    func confirmFacts(task: FieldTask, facts: [String: Fact], requestId: String? = nil) async -> Bool {
        error = nil
        busy = true; defer { busy = false }
        do {
            try await api.post("/api/tasks/\(task.id)/facts", FactsCommand(baseRevision: task.revision, facts: facts), operationId: UUID().uuidString)
            await refreshTask(task.id)
            if let requestId {
                return await queue(task: task, photos: [], requestId: requestId, existingObservationIds: Array(Set(facts.values.flatMap(\.evidenceIds))))
            }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
}
