import Foundation

/// A node in the managed-file tree shown in the sidebar.
struct FileNode: Identifiable, Hashable {
    let id: String          // relativePath, stable & unique
    let name: String        // last path component
    let relativePath: String
    let absolutePath: String
    let sourceAbsolute: String
    let isDir: Bool
    var children: [FileNode]?   // nil for files (no disclosure triangle)
    var status: ChezmoiStatus?  // own apply-effect, if changed
    var hasChangedDescendant: Bool // for the aggregated dot on folders
    /// True for chezmoi control files (`.chezmoiignore`, `.chezmoi.toml.tmpl`, …)
    /// shown in the dedicated sidebar section. These have no destination and are
    /// not part of the apply/status/membership machinery — only editable. For
    /// these `absolutePath == sourceAbsolute` (the source file is itself).
    var isControlFile: Bool = false
    /// True for `*.tmpl` sources containing `{{ … }}` actions. Such a template
    /// can't be reverted to a regular file (the delimiters would be written out
    /// literally), so the sidebar disables "Revert to Regular File" for it.
    var usesTemplateSyntax: Bool = false

    /// True when the source state is a chezmoi template (`*.tmpl`), so the Edit
    /// tab shows Go-template syntax rather than the final rendered file.
    var isTemplate: Bool { sourceAbsolute.hasSuffix(".tmpl") }

    /// Whether this file changes when `chezmoi apply` runs (has a real diff).
    /// Control files never participate in apply, so always false for them.
    var hasDiff: Bool { !isDir && !isControlFile && status != nil }

    /// Extension of the target file, ignoring a trailing `.tmpl`.
    private var targetExtension: String {
        let base = name.hasSuffix(".tmpl") ? String(name.dropLast(5)) : name
        return (base as NSString).pathExtension.lowercased()
    }

    var isMarkdown: Bool { targetExtension == "md" || targetExtension == "markdown" }

    var isImage: Bool {
        ["png", "jpg", "jpeg", "gif", "svg", "webp"].contains(targetExtension)
    }

    /// Eligible for the Rich View tab (rendered markdown / image preview).
    var isRichViewable: Bool { !isDir && (isMarkdown || isImage) }

    /// MIME type for `isImage` files, for building a data URI.
    var imageMIME: String {
        switch targetExtension {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        default: return "application/octet-stream"
        }
    }

    /// Build a sorted tree from flat managed entries, folding in status.
    static func buildTree(
        entries: [ManagedEntry],
        status: [String: ChezmoiStatus]
    ) -> [FileNode] {
        // Mutable builder nodes keyed by relative path.
        final class Builder {
            let entry: ManagedEntry
            var children: [Builder] = []
            init(_ entry: ManagedEntry) { self.entry = entry }
        }

        var map: [String: Builder] = [:]
        for entry in entries {
            map[entry.relativePath] = Builder(entry)
        }

        var roots: [Builder] = []
        for entry in entries {
            let path = entry.relativePath
            let parent = (path as NSString).deletingLastPathComponent
            if parent.isEmpty {
                roots.append(map[path]!)
            } else if let parentBuilder = map[parent] {
                parentBuilder.children.append(map[path]!)
            } else {
                // Parent not managed (shouldn't normally happen) — treat as root.
                roots.append(map[path]!)
            }
        }

        func convert(_ builder: Builder) -> FileNode {
            let entry = builder.entry
            // Drop empty-noise folders bottom-up: a directory with no file
            // descendants and no status anywhere in its subtree carries nothing
            // to show or act on. Recursion prunes leaves first, so a folder left
            // with no surviving children was wholly noise.
            let keptKids = builder.children
                .map(convert)
                .filter { !Self.isEmptyNoise($0) }
                .sorted(by: Self.order)
            let ownStatus = status[entry.absolutePath]
            let changedDescendant = keptKids.contains { $0.status != nil || $0.hasChangedDescendant }
            return FileNode(
                id: entry.relativePath,
                name: (entry.relativePath as NSString).lastPathComponent,
                relativePath: entry.relativePath,
                absolutePath: entry.absolutePath,
                sourceAbsolute: entry.sourceAbsolute,
                isDir: entry.isDir,
                children: entry.isDir ? keptKids : nil,
                status: ownStatus,
                hasChangedDescendant: changedDescendant,
                usesTemplateSyntax: entry.usesTemplateSyntax
            )
        }

        return roots.map(convert).filter { !isEmptyNoise($0) }.sorted(by: order)
    }

    /// A directory with no file descendants and no status anywhere in its
    /// subtree (own status nil and, by bottom-up pruning, no surviving
    /// children). Such folders are hidden from the sidebar — they have nothing
    /// to show or apply. A status-carrying empty dir (e.g. a `chezmoi apply`
    /// will-create `A`) is kept so its badge stays visible.
    private static func isEmptyNoise(_ node: FileNode) -> Bool {
        node.isDir && (node.children?.isEmpty ?? true) && node.status == nil
    }

    /// Build the flat control-file nodes (the dedicated "chezmoi" section). These
    /// don't go through `buildTree` — they're not managed entries — so they carry
    /// no status and `isControlFile = true`. ids are `control:`-prefixed to stay
    /// distinct from managed nodes (whose ids are destination relative paths).
    static func controlNodes(from files: [ChezmoiSpecialFile]) -> [FileNode] {
        files.map(node(fromSpecial:))
    }

    private static func node(fromSpecial file: ChezmoiSpecialFile) -> FileNode {
        let kids = file.children?.map(node(fromSpecial:))
        return FileNode(
            id: "control:\(file.path)",
            name: file.name,
            relativePath: file.name,
            absolutePath: file.path,
            sourceAbsolute: file.path,
            isDir: file.isDir,
            children: file.isDir ? (kids ?? []) : nil,
            status: nil,
            hasChangedDescendant: false,
            isControlFile: true
        )
    }

    /// Directories first, then files; alphabetical within each group.
    private static func order(_ a: FileNode, _ b: FileNode) -> Bool {
        if a.isDir != b.isDir { return a.isDir && !b.isDir }
        return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
    }
}
