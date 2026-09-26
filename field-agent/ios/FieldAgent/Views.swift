import SwiftUI

struct TaskListView: View {
    @EnvironmentObject var store: AppStore
    @State private var settingsOpen = false
    @State private var newTaskOpen = false
    @State private var newTitle = ""
    @State private var path: [String] = []
    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("現場から、確認を進める。")
                            .font(.title2.weight(.semibold))
                        Text("写真・観測・図面を一つの仕事に集めます。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }.padding(.vertical, 12).listRowBackground(Color.clear)
                }
                if !store.tokenIsSet { Button("接続先とトークンを設定", systemImage: "network") { settingsOpen = true } }
                if store.isOffline { Label("オフライン · 保存済みの内容を表示", systemImage: "wifi.slash").foregroundStyle(.orange) }
                if !store.pending.isEmpty {
                    Section("未送信 \(store.pending.count)件") {
                        ForEach(store.pending) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("写真 \(item.photos.count)枚 · 計測 \(item.measurements.count)件")
                                Text(item.error ?? (item.serverOrigin == store.settings.origin ? "送信待ち" : "別の接続先に保存されたデータ"))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Button(store.syncing ? "送信中…" : "再送する", systemImage: "arrow.clockwise") { Task { await store.syncOutbox() } }.disabled(store.syncing)
                    }
                }
                Section("仕事") {
                    if store.tasks.isEmpty { Text("＋から最初の仕事を作成します").foregroundStyle(.secondary) }
                    ForEach(store.tasks) { task in
                        NavigationLink(value: task.id) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(task.title).font(.headline)
                                Text("\(task.state.fieldLabel) · 更新 \(task.revision)").font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 5)
                        }
                    }
                }
            }
            .navigationTitle("Field Agent")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("設定", systemImage: "gearshape") { settingsOpen = true } }
                ToolbarItem(placement: .topBarTrailing) { Button("新しい仕事", systemImage: "plus") { newTaskOpen = true } }
            }
            .navigationDestination(for: String.self) { TaskDetailView(taskId: $0) }
            .refreshable { await store.refreshTasks(); await store.syncOutbox() }
            .sheet(isPresented: $settingsOpen) { SettingsView() }
            .alert("新しい仕事", isPresented: $newTaskOpen) {
                TextField("例: H1の設置を確認", text: $newTitle)
                Button("作成") { Task { if let id = await store.createTask(title: newTitle) { path.append(id); newTitle = "" } } }
                Button("キャンセル", role: .cancel) {}
            } message: { Text("対象H1・下向きのサンプル図面から始めます。") }
            .alert("確認が必要です", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
                Button("閉じる") { store.error = nil }
            } message: { Text(store.error ?? "") }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var baseURL = ""
    @State private var token = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("Macのサーバー") {
                    TextField("http://MacのIP:4310", text: $baseURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    SecureField(store.tokenIsSet ? "トークン変更時のみ入力" : "接続トークン", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("iPhone実機ではlocalhostではなく、同じネットワークのMacのIPアドレスを指定します。トークンはKeychainへ保存します。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section { Button("保存して接続") { Task { await store.saveSettings(baseURL: baseURL, newToken: token); if store.error == nil { dismiss() } } }.disabled(store.busy) }
                if let error = store.error { Section { Text(error).font(.caption).foregroundStyle(.red) } }
            }.navigationTitle("接続設定")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
                .onAppear { baseURL = store.settings.baseURL }
        }
    }
}

private struct CaptureIntent: Identifiable {
    let id = UUID()
    let task: FieldTask
    let measurement: Bool
    let requestId: String?
    let reason: String
}

private struct ConfirmationIntent: Identifiable {
    let id = UUID()
    let task: FieldTask
    let requestId: String?
}

struct TaskDetailView: View {
    @EnvironmentObject var store: AppStore
    let taskId: String
    @State private var captureIntent: CaptureIntent?
    @State private var confirmationIntent: ConfirmationIntent?
    @State private var unavailableRequest: EvidenceRequest?
    @State private var unavailableReason = ""
    var body: some View {
        Group {
            if let task = store.currentTask, task.id == taskId {
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(task.title).font(.title2.weight(.semibold))
                            Text("対象 \(task.targetId) · \(task.state.fieldLabel)").foregroundStyle(.secondary)
                            if store.isOffline { Label("保存済みの内容を表示中", systemImage: "wifi.slash").foregroundStyle(.orange) }
                        }.padding(.vertical, 8)
                    }
                    Section("現場を伝える") {
                        Button("写真を追加", systemImage: "camera") { captureIntent = CaptureIntent(task: task, measurement: false, requestId: nil, reason: "対象が分かる全体と、型式が読める近接写真を残します") }
                        Button("2点の距離を記録", systemImage: "ruler") { captureIntent = CaptureIntent(task: task, measurement: true, requestId: nil, reason: "計測する始点と終点を指定します。値は概算です") }
                        Button("確認した事実を入力", systemImage: "checkmark.bubble") { confirmationIntent = ConfirmationIntent(task: task, requestId: nil) }
                    }
                    if !task.requests.filter({ $0.status == "open" }).isEmpty {
                        Section("次に必要な情報") {
                            ForEach(task.requests.filter { $0.status == "open" }) { request in
                                VStack(alignment: .leading, spacing: 10) {
                                    Label(request.kind.fieldLabel, systemImage: request.kind == "measurement" ? "ruler" : "viewfinder")
                                        .font(.headline)
                                    Text(request.reason)
                                    if !request.fields.isEmpty { Text(request.fields.map(\.fieldLabel).joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                                    HStack {
                                        Button(request.kind == "confirmation" ? "確認して入力" : "応答する") {
                                            if request.kind == "confirmation" { confirmationIntent = ConfirmationIntent(task: task, requestId: request.id) }
                                            else { captureIntent = CaptureIntent(task: task, measurement: request.kind == "measurement", requestId: request.id, reason: request.reason) }
                                        }.buttonStyle(.borderedProminent)
                                        Button("今は取得できない") { unavailableRequest = request; unavailableReason = "" }.buttonStyle(.bordered)
                                    }
                                }.padding(.vertical, 5)
                            }
                        }
                    }
                    if !task.candidates.isEmpty {
                        Section("AIの候補 · 未確認") {
                            ForEach(task.candidates) { candidate in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(candidate.reason)
                                    Text(candidate.facts.sorted(by: { $0.key < $1.key }).map { "\($0.key.fieldLabel): \(($0.value.value ?? "unknown").fieldLabel)" }.joined(separator: " / "))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Button("観測と照らし合わせて確認") { confirmationIntent = ConfirmationIntent(task: task, requestId: nil) }
                        }
                    }
                    Section("図面の予定") {
                        LabeledContent("H1の向き", value: task.plan.orientation.fieldLabel)
                        LabeledContent("基準線", value: task.plan.lengthMeters.formatted(.number.precision(.fractionLength(2))) + " m")
                    }
                    Section("検証結果") {
                        if let report = task.validation {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(report.rule.status.fieldLabel).font(.headline)
                                Text(report.rule.reason)
                                Divider()
                                Text(report.comparison.status.fieldLabel).font(.headline)
                                Text(report.comparison.reason)
                                ForEach(Array(report.measurements.enumerated()), id: \.offset) { index, measurement in
                                    Divider()
                                    Text("計測 \(index + 1)").font(.headline)
                                    if let value = measurement.valueMeters { Text(value.formatted(.number.precision(.fractionLength(3))) + " m · 概算").monospacedDigit() }
                                    Text(measurement.reason).font(.caption)
                                    Text("物理的な精度は未評価").font(.caption).foregroundStyle(.secondary)
                                }
                                if report.taskRevision != task.revision { Label("情報が更新されています。再検証してください", systemImage: "arrow.clockwise").foregroundStyle(.orange) }
                            }
                        } else { Text("まだ検証していません").foregroundStyle(.secondary) }
                        Button("検証する", systemImage: "checkmark.shield") { Task { await store.validate(task.id) } }.disabled(store.busy)
                    }
                    if !task.observations.isEmpty {
                        Section("根拠写真 \(task.observations.count)枚") {
                            ScrollView(.horizontal) {
                                HStack(spacing: 12) {
                                    ForEach(task.observations) { observation in
                                        VStack(alignment: .leading) {
                                            EvidenceImage(taskId: task.id, assetId: observation.assetId).frame(width: 130, height: 150).clipShape(RoundedRectangle(cornerRadius: 12))
                                            Text(observation.synthetic ? "評価用の合成画像" : observation.capturedAt).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                            if observation.superseded == true { Text("置き換え済み").font(.caption2).foregroundStyle(.orange) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if let artifact = task.artifact {
                        Section(artifact.title) {
                            Text(artifact.scope)
                            ForEach(artifact.unresolved, id: \.self) { Text($0).foregroundStyle(.secondary) }
                        }
                    }
                    Section {
                        Button(task.run.status == "running" || task.run.status == "queued" ? "AIが確認しています…" : "AIと確認を進める", systemImage: "sparkles") { Task { await store.run(task.id) } }
                            .disabled(store.busy || task.run.status == "running" || task.run.status == "queued")
                        if let error = task.run.error { Text(error).font(.caption).foregroundStyle(.red) }
                        if store.pending.contains(where: { $0.taskId == task.id }) { Button("この端末の未送信データを再送") { Task { await store.syncOutbox() } }.disabled(store.syncing) }
                    }
                }
                .sheet(item: $captureIntent) { intent in CaptureView(task: intent.task, isMeasurement: intent.measurement, requestId: intent.requestId, reason: intent.reason) }
                .sheet(item: $confirmationIntent) { intent in FactsView(task: intent.task, requestId: intent.requestId) }
                .alert("取得できない理由", isPresented: Binding(get: { unavailableRequest != nil }, set: { if !$0 { unavailableRequest = nil } })) {
                    TextField("例: 刻印が天井裏に隠れている", text: $unavailableReason)
                    Button("保存") {
                        guard let request = unavailableRequest else { return }
                        Task { _ = await store.queue(task: task, photos: [], requestId: request.id, unavailableReason: unavailableReason.isEmpty ? "現時点では取得できません" : unavailableReason) }
                        unavailableRequest = nil
                    }
                    Button("キャンセル", role: .cancel) { unavailableRequest = nil }
                }
            } else { ProgressView("仕事を読み込んでいます") }
        }
        .navigationTitle("現場の確認").navigationBarTitleDisplayMode(.inline)
        .task(id: taskId) { await store.openTask(taskId) }
        .onDisappear { store.stopPolling() }
        .refreshable { await store.refreshTask(taskId) }
    }
}

struct EvidenceImage: View {
    @EnvironmentObject var store: AppStore
    let taskId: String
    let assetId: String
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            Color.secondary.opacity(0.1)
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else { Image(systemName: "photo").foregroundStyle(.secondary) }
        }.task(id: assetId) {
            if let data = try? await store.api.request("/api/tasks/\(taskId)/assets/\(assetId)") { image = UIImage(data: data) }
        }
    }
}

struct CaptureView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var camera = CaptureController()
    let task: FieldTask
    let isMeasurement: Bool
    let requestId: String?
    let reason: String
    @State private var still: CapturedPhoto?
    @State private var confirmedEndpoints = false
    @State private var saving = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Text(reason).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).padding()
                ZStack {
                    if let still, let image = UIImage(data: still.jpeg) { Image(uiImage: image).resizable().scaledToFit().background(.black) }
                    else {
                        CameraPreview(controller: camera)
                        if camera.isSupported {
                            Image(systemName: "plus").font(.system(size: 32, weight: .light)).foregroundStyle(.white).shadow(radius: 2).allowsHitTesting(false)
                        } else { ContentUnavailableView("実機で撮影します", systemImage: "iphone", description: Text("Simulatorは画面と通信の確認用です。カメラ・ARの検証にはiPhoneを接続してください。")) }
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
                VStack(spacing: 12) {
                    if let error = camera.error { Text(error).font(.caption).foregroundStyle(.red) }
                    if isMeasurement {
                        if let distance = camera.distance {
                            Text("\(Double(distance).formatted(.number.precision(.fractionLength(3)))) m").font(.largeTitle.monospacedDigit())
                            Text("概算 · 精度は未評価").font(.caption).foregroundStyle(.secondary)
                            ScrollView(.horizontal) {
                                HStack {
                                    ForEach(Array(camera.photos.enumerated()), id: \.offset) { index, photo in
                                        if let image = UIImage(data: photo.jpeg) {
                                            VStack {
                                                ZStack { Image(uiImage: image).resizable().scaledToFit(); Image(systemName: "plus").foregroundStyle(.orange) }.frame(width: 100, height: 110)
                                                Text(index == 0 ? "始点" : "終点").font(.caption)
                                            }
                                        }
                                    }
                                }
                            }
                            Toggle("印が意図した両端を指していることを確認した", isOn: $confirmedEndpoints).font(.caption)
                            HStack {
                                Button("測り直す") { camera.clearPoints(); confirmedEndpoints = false }.buttonStyle(.bordered)
                                Button("記録を保存") { saveMeasurement() }.buttonStyle(.borderedProminent).disabled(!confirmedEndpoints || saving)
                            }
                        } else {
                            Text(camera.guidance).font(.caption).multilineTextAlignment(.center)
                            Button(camera.firstPoint == nil ? "始点を指定" : "終点を指定") { camera.error = nil; camera.takeEndpoint(targetId: task.targetId) }
                                .buttonStyle(.borderedProminent).controlSize(.large).disabled(!camera.ready)
                            if camera.firstPoint != nil { Button("始点からやり直す") { camera.clearPoints() } }
                        }
                    } else if let still {
                        HStack {
                            Button("撮り直す") { self.still = nil; camera.error = nil }.buttonStyle(.bordered)
                            Button("写真を保存") {
                                saving = true
                                Task { if await store.queue(task: task, photos: [still], requestId: requestId) { dismiss() }; saving = false }
                            }.buttonStyle(.borderedProminent).disabled(saving)
                        }
                    } else {
                        Text("対象と必要な刻印が読める位置から撮影します").font(.caption)
                        Button("撮影", systemImage: "camera.fill") {
                            do { still = try camera.photo(targetId: task.targetId); camera.error = nil } catch { camera.error = error.localizedDescription }
                        }.buttonStyle(.borderedProminent).controlSize(.large).disabled(!camera.started)
                    }
                }.padding().background(.regularMaterial)
            }
            .navigationTitle(isMeasurement ? "2点の距離" : "写真を追加").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .task { await camera.start() }
            .onDisappear { camera.stop() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await camera.start() } }
                else if phase == .background { camera.stop(); confirmedEndpoints = false }
            }
        }
    }
    private func saveMeasurement() {
        do {
            let measurement = try camera.measurement(targetId: task.targetId)
            let photos = camera.photos
            saving = true
            Task { if await store.queue(task: task, photos: photos, measurement: measurement, requestId: requestId) { dismiss() }; saving = false }
        } catch { camera.error = error.localizedDescription }
    }
}

struct FactsView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let task: FieldTask
    let requestId: String?
    @State private var values: [String: String] = [:]
    @State private var checked: Set<String> = []
    @State private var evidence: Set<String> = []
    private let fields = ["model", "installation", "mounting", "orientation", "verticalReference"]
    private let choices = ["installation": ["installed", "uninstalled"], "mounting": ["standard", "recessed"], "orientation": ["pendent", "upright", "sideways", "unknown"], "verticalReference": ["gravity", "verified_record", "unknown"]]
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("写真・現物・確認済み記録と照らし合わせ、確認できた項目だけを選びます。AIの候補は未確認のまま表示しています。")
                        .font(.subheadline)
                }
                Section("根拠の写真を選択") {
                    ForEach(task.observations.filter { $0.superseded != true && $0.targetId == task.targetId }) { observation in
                        Button {
                            if evidence.contains(observation.id) { evidence.remove(observation.id) } else { evidence.insert(observation.id) }
                        } label: {
                            HStack {
                                EvidenceImage(taskId: task.id, assetId: observation.assetId).frame(width: 70, height: 80)
                                Text(observation.synthetic ? "評価用画像" : observation.capturedAt).font(.caption).foregroundStyle(.primary)
                                Spacer()
                                Image(systemName: evidence.contains(observation.id) ? "checkmark.circle.fill" : "circle")
                            }
                        }.buttonStyle(.plain)
                    }
                    if task.observations.isEmpty { Text("先に根拠写真を追加してください").foregroundStyle(.secondary) }
                }
                ForEach(fields, id: \.self) { field in
                    Section(field.fieldLabel) {
                        if let options = choices[field] {
                            Picker(field.fieldLabel, selection: valueBinding(field)) {
                                Text("選択してください").tag("")
                                ForEach(options, id: \.self) { Text($0.fieldLabel).tag($0) }
                            }
                        } else { TextField("刻印の型式", text: valueBinding(field)).textInputAutocapitalization(.characters).autocorrectionDisabled() }
                        Toggle("根拠と照合して確認した", isOn: Binding(get: { checked.contains(field) }, set: { if $0 { checked.insert(field) } else { checked.remove(field) } }))
                        if field == "verticalReference" { Text("画像の上端を鉛直とみなさず、現場の重力方向または確認済み記録で判断してください。").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                Section {
                    Button("確認した項目を保存") {
                        let facts = Dictionary(uniqueKeysWithValues: checked.compactMap { field -> (String, Fact)? in
                            guard let value = values[field], !value.isEmpty else { return nil }
                            return (field, Fact(value: value, confirmed: true, evidenceIds: evidence.sorted(), source: "manual"))
                        })
                        Task { if await store.confirmFacts(task: task, facts: facts, requestId: requestId) { dismiss() } }
                    }.disabled(checked.isEmpty || evidence.isEmpty || checked.contains(where: { values[$0]?.isEmpty != false }) || store.busy)
                    if let error = store.error { Text(error).font(.caption).foregroundStyle(.red) }
                }
            }
            .navigationTitle("事実を確認").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .onAppear {
                for field in fields { values[field] = task.candidates.last?.facts[field]?.value ?? task.facts[field]?.value ?? "" }
            }
        }
    }
    private func valueBinding(_ field: String) -> Binding<String> { Binding(get: { values[field] ?? "" }, set: { values[field] = $0; checked.remove(field) }) }
}
