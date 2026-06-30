import AppKit
import SwiftUI

/// Native source-list style hierarchy of chezmoi-managed files.
///
/// Folders are **not selectable** — only files carry a `.tag()`, so the detail
/// pane only ever reflects a file. Clicking anywhere on a folder row toggles its
/// expansion (not just the disclosure triangle), so we manage the expanded set
/// ourselves rather than using the auto `List(children:)` API.
struct FileTreeView: View {
    let nodes: [FileNode]
    /// chezmoi control files (`.chezmoiignore`, `.chezmoi.toml.tmpl`, …), shown
    /// in a dedicated section. Editable but not managed: no apply/forget/re-add.
    let controlNodes: [FileNode]
    @Binding var selection: FileNode?
    /// Invoked to stop managing a file (`chezmoi forget`). The actual file on
    /// disk is left untouched.
    let onForget: (FileNode) -> Void
    /// Invoked to re-add a file (`chezmoi re-add`): overwrite the source state
    /// with the on-disk file. Never offered for templates.
    let onReAdd: (FileNode) -> Void
    /// Invoked to apply a file (`chezmoi apply`): overwrite the on-disk file
    /// with the rendered source state. Offered only when the target differs.
    let onApply: (FileNode) -> Void
    /// Invoked to add unmanaged on-disk files (`chezmoi add`) — dropped onto the
    /// sidebar from Finder. Each is an absolute destination path.
    let onAdd: ([String]) -> Void
    @State private var expanded: Set<String> = []
    /// The file pending a forget confirmation, or nil when no dialog is shown.
    @State private var forgetTarget: FileNode?
    /// The file pending a re-add confirmation, or nil when no dialog is shown.
    @State private var reAddTarget: FileNode?
    /// The file pending an apply confirmation, or nil when no dialog is shown.
    @State private var applyTarget: FileNode?
    /// Files dropped from Finder pending an add confirmation, or nil when none.
    @State private var dropTargets: [String]?

    var body: some View {
        List(selection: $selection) {
            ForEach(nodes) { node in
                nodeView(node)
            }
            if !controlNodes.isEmpty {
                Section("chezmoi") {
                    ForEach(controlNodes) { node in
                        controlNodeView(node)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .dropDestination(for: URL.self) { urls, _ in
            let paths = urls.filter(\.isFileURL).map(\.path)
            guard !paths.isEmpty else { return false }
            dropTargets = paths   // route through a confirmation
            return true
        }
        .confirmationDialog(
            forgetTarget?.isDir == true ? "Stop managing this folder?" : "Stop managing this file?",
            isPresented: Binding(
                get: { forgetTarget != nil },
                set: { if !$0 { forgetTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: forgetTarget
        ) { node in
            Button("Stop Managing", role: .destructive) { onForget(node) }
            Button("Cancel", role: .cancel) {}
        } message: { node in
            if node.isDir {
                Text("“\(node.name)” and every managed file inside it will be removed from chezmoi’s source state. The files on disk are left untouched.")
            } else {
                Text("“\(node.name)” will be removed from chezmoi’s source state. The file on disk is left untouched.")
            }
        }
        .confirmationDialog(
            reAddTarget?.isDir == true ? "Re-add this folder from disk?" : "Re-add this file from disk?",
            isPresented: Binding(
                get: { reAddTarget != nil },
                set: { if !$0 { reAddTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: reAddTarget
        ) { node in
            Button("Re-add", role: .destructive) { onReAdd(node) }
            Button("Cancel", role: .cancel) {}
        } message: { node in
            if node.isDir {
                Text("chezmoi’s source state for every managed file inside “\(node.name)” will be overwritten with the current files on disk, making the on-disk versions the source of truth. Templates are skipped.")
            } else {
                Text("chezmoi’s source state for “\(node.name)” will be overwritten with the current file on disk, making the on-disk version the source of truth.")
            }
        }
        .confirmationDialog(
            applyTarget?.isDir == true ? "Apply this folder to disk?" : "Apply this file to disk?",
            isPresented: Binding(
                get: { applyTarget != nil },
                set: { if !$0 { applyTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: applyTarget
        ) { node in
            Button("Apply", role: .destructive) { onApply(node) }
            Button("Cancel", role: .cancel) {}
        } message: { node in
            if node.isDir {
                Text("The on-disk files for every changed managed file inside “\(node.name)” will be overwritten with chezmoi’s rendered source state, making the source the source of truth.")
            } else {
                Text("The on-disk file “\(node.name)” will be overwritten with chezmoi’s rendered source state, making the source the source of truth.")
            }
        }
        .confirmationDialog(
            "Add to chezmoi?",
            isPresented: Binding(
                get: { dropTargets != nil },
                set: { if !$0 { dropTargets = nil } }
            ),
            titleVisibility: .visible,
            presenting: dropTargets
        ) { paths in
            Button("Add") { onAdd(paths) }
            Button("Cancel", role: .cancel) {}
        } message: { paths in
            if paths.count == 1 {
                Text("“\((paths[0] as NSString).lastPathComponent)” will be added to chezmoi’s source state.")
            } else {
                Text("\(paths.count) files will be added to chezmoi’s source state.")
            }
        }
    }

    // Returns AnyView to break the opaque-type self-reference in the recursion.
    private func nodeView(_ node: FileNode) -> AnyView {
        if node.isDir, let children = node.children {
            return AnyView(
                DisclosureGroup(isExpanded: binding(for: node.id)) {
                    ForEach(children) { child in
                        nodeView(child)
                    }
                } label: {
                    row(node)
                        .contentShape(Rectangle())
                        .onTapGesture { toggle(node.id) }
                        .contextMenu {
                            Button("Reveal in Finder") { revealInFinder(node) }
                            Divider()
                            // Re-add re-adds every managed file in the folder;
                            // chezmoi skips templates and no-op files, so only
                            // offer it when something inside actually changed.
                            if node.hasChangedDescendant {
                                Button("Apply Folder to Disk…") { applyTarget = node }
                                Button("Re-add Folder from Disk…") { reAddTarget = node }
                            }
                            Button("Stop Managing Folder (Forget)…", role: .destructive) {
                                forgetTarget = node
                            }
                        }
                }
            )
        } else {
            return AnyView(
                row(node)
                    .tag(node)
                    .contextMenu {
                        Button("Open with Default App") { open(node) }
                        Button("Reveal in Finder") { revealInFinder(node) }
                        Divider()
                        // Apply / re-add only make sense when the on-disk file
                        // differs from the source. chezmoi never re-adds
                        // templates, but apply renders them fine.
                        if node.hasDiff {
                            Button("Apply to Disk…") { applyTarget = node }
                        }
                        if node.hasDiff && !node.isTemplate {
                            Button("Re-add from Disk…") { reAddTarget = node }
                        }
                        Button("Stop Managing (Forget)…", role: .destructive) {
                            forgetTarget = node
                        }
                    }
            )
        }
    }

    // Control files / dirs: editable, but no apply/forget/re-add (not managed).
    private func controlNodeView(_ node: FileNode) -> AnyView {
        if node.isDir, let children = node.children {
            return AnyView(
                DisclosureGroup(isExpanded: binding(for: node.id)) {
                    ForEach(children) { child in
                        controlNodeView(child)
                    }
                } label: {
                    row(node)
                        .contentShape(Rectangle())
                        .onTapGesture { toggle(node.id) }
                        .contextMenu {
                            Button("Reveal in Finder") { revealInFinder(node) }
                        }
                }
            )
        } else {
            return AnyView(
                row(node)
                    .tag(node)
                    .contextMenu {
                        Button("Open with Default App") { open(node) }
                        Button("Reveal in Finder") { revealInFinder(node) }
                    }
            )
        }
    }

    private func open(_ node: FileNode) {
        NSWorkspace.shared.open(URL(fileURLWithPath: node.absolutePath))
    }

    private func revealInFinder(_ node: FileNode) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: node.absolutePath)])
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(id) },
            set: { isOn in
                if isOn { expanded.insert(id) } else { expanded.remove(id) }
            }
        )
    }

    private func toggle(_ id: String) {
        withAnimation {
            if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        }
    }

    @ViewBuilder
    private func row(_ node: FileNode) -> some View {
        HStack(spacing: 6) {
            Image(systemName: node.isDir ? "folder" : "doc")
                .foregroundStyle(node.isDir ? Color.accentColor : Color.secondary)
                .frame(width: 16)
            Text(node.name)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            StatusBadge(node: node)
        }
    }
}
