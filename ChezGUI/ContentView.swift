import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    let client = ChezmoiClient()

    @Published var nodes: [FileNode] = []
    @Published var selection: FileNode?
    @Published var errorMessage: String?
    @Published var isLoading = false

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let entries = client.managed()
            async let status = client.status()
            let tree = FileNode.buildTree(entries: try await entries, status: try await status)
            self.nodes = tree
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }
}

struct ContentView: View {
    @StateObject private var model = AppModel()

    var body: some View {
        NavigationSplitView {
            FileTreeView(nodes: model.nodes, selection: $model.selection)
                .navigationSplitViewColumnWidth(min: 220, ideal: 280)
        } detail: {
            DetailView(node: model.selection, client: model.client)
                .frame(minWidth: 480, minHeight: 360)
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Reload managed files and status")
                .disabled(model.isLoading)
            }
        }
        .task { await model.refresh() }
        .alert(
            "chezmoi error",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }
}
