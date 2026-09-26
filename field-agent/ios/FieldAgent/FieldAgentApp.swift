import SwiftUI

@main
struct FieldAgentApp: App {
    @StateObject private var store = AppStore()
    var body: some Scene {
        WindowGroup {
            TaskListView().environmentObject(store)
                .tint(Color(red: 0.08, green: 0.48, blue: 0.45))
                .task { if store.tokenIsSet { await store.refreshTasks(); await store.syncOutbox() } }
        }
    }
}
