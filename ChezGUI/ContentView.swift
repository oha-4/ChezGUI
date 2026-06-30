import AppKit
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    let client = ChezmoiClient()

    @Published var nodes: [FileNode] = []
    /// chezmoi control files (`.chezmoiignore`, `.chezmoi.toml.tmpl`, …) shown in
    /// the dedicated sidebar section. Editable but not managed (no apply/status).
    @Published var controlNodes: [FileNode] = []
    @Published var selection: FileNode?
    @Published var errorMessage: String?
    @Published var isLoading = false

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let entries = client.managed()
            async let status = client.status()
            async let special = client.specialFiles()
            let tree = FileNode.buildTree(entries: try await entries, status: try await status)
            self.nodes = tree
            self.controlNodes = FileNode.controlNodes(from: try await special)
            // Re-resolve the selection to the rebuilt node (its status may have
            // changed) so the sidebar highlight survives and the detail view
            // keeps the same file without reloading the editor.
            if let id = selection?.id {
                selection = Self.node(withId: id, in: tree) ?? Self.node(withId: id, in: controlNodes)
            }
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    /// Stop managing a file: `chezmoi forget` removes it from the source state
    /// but leaves the actual file on disk. Clears the selection if it was the
    /// forgotten file (it disappears from the tree) and reloads.
    func forget(_ node: FileNode) async {
        do {
            try await client.forget(target: node.absolutePath)
            if selection?.id == node.id { selection = nil }
            await refresh()
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    /// Re-add a file: `chezmoi re-add` overwrites the source state with the
    /// current on-disk file (the destination becomes the source of truth). The
    /// diff disappears afterwards, so we reload. Never called for templates.
    func reAdd(_ node: FileNode) async {
        do {
            try await client.reAdd(target: node.absolutePath)
            await refresh()
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    /// Apply a file: `chezmoi apply` writes the rendered source state to the
    /// destination file on disk (the source becomes the source of truth). The
    /// diff disappears afterwards, so we reload. Works for templates too.
    func apply(_ node: FileNode) async {
        do {
            try await client.apply(target: node.absolutePath)
            await refresh()
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    /// Add one or more unmanaged on-disk files to chezmoi (`chezmoi add`). After
    /// reloading, select the last added file so the user sees it land in the
    /// tree. Unlike forget/re-add/apply, the targets come from a file picker or a
    /// drop (no sidebar node exists for an unmanaged file).
    func add(paths: [String], encrypt: Bool = false) async {
        guard !paths.isEmpty else { return }
        do {
            for path in paths {
                try await client.add(target: path, encrypt: encrypt)
            }
            await refresh()
            if let last = paths.last,
               let node = Self.node(withAbsolutePath: last, in: nodes) {
                selection = node
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

    /// Depth-first lookup of a node by its destination absolute path — used after
    /// `add`, where the new node's relative-path id isn't known from the dest path.
    private static func node(withAbsolutePath path: String, in nodes: [FileNode]) -> FileNode? {
        for node in nodes {
            if node.absolutePath == path { return node }
            if let children = node.children,
               let found = Self.node(withAbsolutePath: path, in: children) {
                return found
            }
        }
        return nil
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
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
            FileTreeView(
                nodes: model.nodes,
                controlNodes: model.controlNodes,
                selection: Binding(
                    get: { model.selection },
                    set: { newValue in guardedNavigate { model.selection = newValue } }
                ),
                onForget: { node in Task { await model.forget(node) } },
                onReAdd: { node in Task { await model.reAdd(node) } },
                onApply: { node in Task { await model.apply(node) } },
                onAdd: { paths in Task { await model.add(paths: paths) } }
            )
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
            ToolbarItem(placement: .navigation) {
                Button {
                    let panel = NSOpenPanel()
                    panel.canChooseFiles = true
                    panel.canChooseDirectories = true   // chezmoi add recurses into dirs
                    panel.allowsMultipleSelection = true
                    panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
                    panel.prompt = "Add"
                    panel.message = "Choose files in your home directory to add to chezmoi"
                    // An accessory checkbox lets the user encrypt the added source
                    // state (chezmoi add --encrypt) without a second dialog.
                    let encryptCheck = NSButton(
                        checkboxWithTitle: "Encrypt (--encrypt)",
                        target: nil,
                        action: nil
                    )
                    let accessory = NSStackView(views: [encryptCheck])
                    accessory.orientation = .vertical
                    accessory.alignment = .leading
                    accessory.edgeInsets = NSEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)
                    panel.accessoryView = accessory
                    panel.isAccessoryViewDisclosed = true
                    if panel.runModal() == .OK {
                        let paths = panel.urls.map(\.path)
                        let encrypt = encryptCheck.state == .on
                        Task { await model.add(paths: paths, encrypt: encrypt) }
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .help("Add a file to chezmoi (chezmoi add)")
                .disabled(model.isLoading)
            }
        }
        .task {
            // A successful save changes the source, so refresh status/diff.
            bridge.onSaved = { [weak model] in Task { await model?.refresh() } }
            await model.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            // Files can change on disk (terminal, other tools) while the app is
            // backgrounded; re-sync tree + status on return to foreground.
            // refresh() rebuilds the tree only — it never reloads the editor
            // (.task is keyed on path+mode), so unsaved Edit-tab edits survive.
            guard phase == .active, !model.isLoading else { return }
            Task { await model.refresh() }
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
