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
            // Re-resolve the selection to the rebuilt node (its status may have
            // changed) so the sidebar highlight survives and the detail view
            // keeps the same file without reloading the editor.
            if let id = selection?.id {
                selection = Self.node(withId: id, in: tree)
            }
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    /// Depth-first lookup of a node by its stable id (relative path).
    private static func node(withId id: FileNode.ID, in nodes: [FileNode]) -> FileNode? {
        for node in nodes {
            if node.id == id { return node }
            if let children = node.children, let found = Self.node(withId: id, in: children) {
                return found
            }
        }
        return nil
    }
}

struct ContentView: View {
    @StateObject private var model = AppModel()
    /// The single web view / Monaco bridge, owned here so both the sidebar and
    /// the detail view can consult its dirty state for the unsaved-changes guard.
    @StateObject private var bridge = MonacoBridge()

    /// A navigation deferred behind the unsaved-changes dialog, plus whether the
    /// user chose "Save" (so we run it once the save lands and dirty clears).
    @State private var pendingNav: (() -> Void)?
    @State private var showDiscardDialog = false
    @State private var navAfterSave = false

    var body: some View {
        NavigationSplitView {
            FileTreeView(nodes: model.nodes, selection: Binding(
                get: { model.selection },
                set: { newValue in guardedNavigate { model.selection = newValue } }
            ))
            .navigationSplitViewColumnWidth(min: 220, ideal: 280)
        } detail: {
            DetailView(
                node: model.selection,
                client: model.client,
                bridge: bridge,
                guardedNavigate: guardedNavigate
            )
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
        .task {
            // A successful save changes the source, so refresh status/diff.
            bridge.onSaved = { [weak model] in Task { await model?.refresh() } }
            await model.refresh()
        }
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
        .alert(
            "Save failed",
            isPresented: Binding(
                get: { bridge.saveError != nil },
                set: { if !$0 { bridge.saveError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(bridge.saveError ?? "")
        }
        .confirmationDialog(
            "You have unsaved changes",
            isPresented: $showDiscardDialog,
            titleVisibility: .visible
        ) {
            Button("Save") {
                navAfterSave = true
                bridge.requestSave()
            }
            Button("Discard Changes", role: .destructive) {
                bridge.isDirty = false
                runPendingNav()
            }
            Button("Cancel", role: .cancel) { pendingNav = nil }
        } message: {
            Text("Save your changes before leaving this file?")
        }
        // Save chosen in the dialog: navigate once the write lands (dirty clears).
        .onChange(of: bridge.isDirty) { _, dirty in
            if !dirty && navAfterSave {
                navAfterSave = false
                runPendingNav()
            }
        }
        // Save failed: abandon the deferred navigation; the error alert shows.
        .onChange(of: bridge.saveError) { _, err in
            if err != nil {
                navAfterSave = false
                pendingNav = nil
            }
        }
    }

    /// Run `action` now, or defer it behind the unsaved-changes dialog if the
    /// Edit buffer is dirty.
    private func guardedNavigate(_ action: @escaping () -> Void) {
        if bridge.isDirty {
            pendingNav = action
            showDiscardDialog = true
        } else {
            action()
        }
    }

    private func runPendingNav() {
        let action = pendingNav
        pendingNav = nil
        action?()
    }
}
