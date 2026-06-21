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
    @Binding var selection: FileNode?
    /// Invoked to stop managing a file (`chezmoi forget`). The actual file on
    /// disk is left untouched.
    let onForget: (FileNode) -> Void
    /// Invoked to re-add a file (`chezmoi re-add`): overwrite the source state
    /// with the on-disk file. Never offered for templates.
    let onReAdd: (FileNode) -> Void
    @State private var expanded: Set<String> = []
    /// The file pending a forget confirmation, or nil when no dialog is shown.
    @State private var forgetTarget: FileNode?
    /// The file pending a re-add confirmation, or nil when no dialog is shown.
    @State private var reAddTarget: FileNode?

    var body: some View {
        List(selection: $selection) {
            ForEach(nodes) { node in
                nodeView(node)
            }
        }
        .listStyle(.sidebar)
        .confirmationDialog(
            "Stop managing this file?",
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
            Text("“\(node.name)” will be removed from chezmoi’s source state. The file on disk is left untouched.")
        }
        .confirmationDialog(
            "Re-add this file from disk?",
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
            Text("chezmoi’s source state for “\(node.name)” will be overwritten with the current file on disk, making the on-disk version the source of truth.")
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
                        // Re-add only makes sense when the on-disk file differs
                        // from the source, and chezmoi never re-adds templates.
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
