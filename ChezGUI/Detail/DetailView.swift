import SwiftUI

enum ViewMode: String, Identifiable {
    case diff = "Diff"
    case edit = "Edit"
    case rich = "Rich"
    /// Read-only rendered target (`chezmoi cat`). Offered only for templates with
    /// no diff, where the Edit tab shows raw `{{ … }}` source and there's no Diff
    /// tab — so this is the only way to see the actual rendered file on disk.
    case current = "Current"
    var id: String { rawValue }
}

/// Right pane: view tabs over a single selected file, rendered by Monaco (Diff/
/// Edit) or as rich content (markdown / image) in the embedded web view. The
/// available tabs depend on the file: Diff only when it has changes, Rich only
/// for markdown/images.
struct DetailView: View {
    let node: FileNode?
    let client: ChezmoiClient
    /// Owned by `ContentView` (single WebView) so the unsaved-changes guard can
    /// observe dirty state from the navigation sites too.
    @ObservedObject var bridge: MonacoBridge
    /// Runs `action` immediately, or defers it behind the unsaved-changes dialog
    /// when the Edit buffer is dirty. Used to guard tab switches.
    let guardedNavigate: (@escaping () -> Void) -> Void

    /// Selected colour-theme palette, shared with the Settings window via the
    /// same UserDefaults key. The web side resolves light/dark automatically.
    @AppStorage(ThemePalette.storageKey) private var themePalette = ThemePalette.default.rawValue

    /// The user's explicit tab choice for the current file. `nil` means "use the
    /// default for this file"; it is cleared whenever the selected file changes
    /// so each file opens on its own best-fit tab.
    @State private var modeSelection: ViewMode?

    /// Canonical tab order: the read-only views of the rendered result (Diff /
    /// Rich / Current) grouped together first, then Edit (the editable source)
    /// last — so viewing the result and editing the source stay visually distinct.
    private static let modeOrder: [ViewMode] = [.diff, .rich, .current, .edit]

    /// Tabs available for a file (pure function of the node — no `self` state),
    /// always returned in `modeOrder`.
    private func availableModes(for node: FileNode?) -> [ViewMode] {
        guard let node, !node.isDir else { return [] }
        // Control files (.chezmoiignore, .chezmoi.toml.tmpl, …) have no
        // destination, so no Diff/Current/Rich — only the editable source.
        if node.isControlFile { return [.edit] }
        if node.isImage { return [.rich] } // raw bytes aren't useful in Diff/Edit
        var modes: Set<ViewMode> = [.edit]
        if node.hasDiff { modes.insert(.diff) }
        if node.isMarkdown { modes.insert(.rich) }
        // Templates with no diff have no Diff tab and only show raw template
        // source in Edit — add a read-only view of the rendered result.
        if node.isTemplate && !node.hasDiff { modes.insert(.current) }
        return Self.modeOrder.filter(modes.contains)
    }

    /// Best default tab for a freshly selected file: the first available tab in
    /// the canonical `modeOrder` (Diff → Rich → Current → Edit).
    private func defaultMode(for node: FileNode?) -> ViewMode {
        let available = availableModes(for: node)
        return Self.modeOrder.first(where: available.contains) ?? .edit
    }

    /// The tab actually shown: the user's choice if still valid, else the default.
    private func effectiveMode(for node: FileNode?) -> ViewMode {
        if let modeSelection, availableModes(for: node).contains(modeSelection) {
            return modeSelection
        }
        return defaultMode(for: node)
    }

    var body: some View {
        // Resolve everything from the fresh `node` here in `body`, then capture
        // it into the escaping task closure as locals — never read `self.node`
        // from inside onChange/task, where the value can be stale.
        let currentNode = node
        let modes = availableModes(for: currentNode)
        let resolved = effectiveMode(for: currentNode)
        let palette = themePalette

        return VStack(spacing: 0) {
            header(node: currentNode, modes: modes, resolved: resolved)
            Divider()
            WebViewHost(bridge: bridge)
        }
        .task(id: TaskKey(path: currentNode?.absolutePath, mode: resolved)) {
            await load(node: currentNode, mode: resolved)
        }
        .task(id: palette) {
            // Push the chosen palette to the web side (buffered until ready).
            bridge.setTheme(palette)
        }
        .onChange(of: currentNode?.id) { _, _ in
            // Reset to "use default" on file change. Safe: reads no node state.
            modeSelection = nil
        }
    }

    private func header(node: FileNode?, modes: [ViewMode], resolved: ViewMode) -> some View {
        HStack(spacing: 12) {
            if !modes.isEmpty {
                let modeBinding = $modeSelection
                Picker("", selection: Binding(
                    get: { resolved },
                    set: { newMode in guardedNavigate { modeBinding.wrappedValue = newMode } }
                )) {
                    ForEach(modes) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }

            Spacer()

            if node?.isTemplate == true {
                Text("Template")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.purple)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.purple.opacity(0.15), in: Capsule())
                    .help("This file is rendered by chezmoi from a Go template (*.tmpl). The Edit tab shows the raw template source.")
            }

            if let node {
                Text(node.relativePath)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    /// Identity that triggers a reload when the selection or mode changes.
    private struct TaskKey: Equatable {
        let path: String?
        let mode: ViewMode
    }

    private func load(node: FileNode?, mode: ViewMode) async {
        guard let node else {
            bridge.setEditableSource(nil)
            bridge.clear(String(localized: "No file selected"))
            return
        }
        guard !node.isDir else {
            bridge.setEditableSource(nil)
            bridge.clear(String(localized: "Select a file to view its diff"))
            return
        }

        switch mode {
        case .diff:
            await loadDiff(node)
        case .edit:
            await loadSource(node)
        case .rich:
            await loadRich(node)
        case .current:
            await loadCurrent(node)
        }
    }

    private func loadCurrent(_ node: FileNode) async {
        bridge.setEditableSource(nil) // Read-only rendered view.
        // Show the rendered target (`chezmoi cat`), highlighted as its base
        // language from the path — no `{{ … }}` remains, so no injection needed.
        do {
            let rendered = try await client.cat(target: node.absolutePath)
            bridge.showSource(
                path: node.relativePath,
                language: nil,
                content: rendered,
                readOnly: true
            )
        } catch {
            bridge.clear(String(localized: "chezmoi cat failed: \(error.localizedDescription)"))
        }
    }

    private func loadDiff(_ node: FileNode) async {
        bridge.setEditableSource(nil) // Diff is read-only.
        // Destination = current file on disk; Target = chezmoi cat output.
        guard let original = readText(atPath: node.absolutePath) else {
            bridge.clear(String(localized: "Binary or unreadable file — diff not shown"))
            return
        }
        do {
            let modified = try await client.cat(target: node.absolutePath)
            bridge.showDiff(
                path: node.relativePath,
                language: nil,
                original: original,
                modified: modified
            )
        } catch {
            bridge.clear(String(localized: "chezmoi cat failed: \(error.localizedDescription)"))
        }
    }

    private func loadSource(_ node: FileNode) async {
        // Show the raw source-state file (what you edit and save back to).
        guard let content = readText(atPath: node.sourceAbsolute) else {
            bridge.setEditableSource(nil)
            bridge.clear(String(localized: "Binary or unreadable source file"))
            return
        }
        // Editable: writes go back to the source path. Templates (*.tmpl) are
        // editable as raw template text and highlighted as their base language
        // (json/yaml/…) with Go-template `{{ … }}` overlaid by the injection
        // grammar on the web side, so no special language is needed.
        bridge.setEditableSource(node.sourceAbsolute)
        bridge.showSource(
            path: node.relativePath,
            language: nil,
            content: content,
            readOnly: false
        )
    }

    private func loadRich(_ node: FileNode) async {
        bridge.setEditableSource(nil) // Rich view renders the target, not editable.
        if node.isMarkdown {
            do {
                let markdown = try await client.cat(target: node.absolutePath)
                bridge.showRich(path: node.relativePath, markdown: markdown)
            } catch {
                bridge.clear(String(localized: "chezmoi cat failed: \(error.localizedDescription)"))
            }
        } else if node.isImage {
            do {
                let data = try await client.catData(target: node.absolutePath)
                let uri = "data:\(node.imageMIME);base64,\(data.base64EncodedString())"
                bridge.showImage(path: node.relativePath, dataURI: uri)
            } catch {
                bridge.clear(String(localized: "Failed to load image: \(error.localizedDescription)"))
            }
        }
    }

    /// Read a file as UTF-8 text, returning nil for binary/unreadable content.
    private func readText(atPath path: String) -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        if data.contains(0) { return nil } // NUL byte => treat as binary
        return String(data: data, encoding: .utf8)
    }
}
