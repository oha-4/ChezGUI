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
    @State private var expanded: Set<String> = []

    var body: some View {
        List(selection: $selection) {
            ForEach(nodes) { node in
                nodeView(node)
            }
        }
        .listStyle(.sidebar)
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
