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

    /// True when the source state is a chezmoi template (`*.tmpl`), so the Edit
    /// tab shows Go-template syntax rather than the final rendered file.
    var isTemplate: Bool { sourceAbsolute.hasSuffix(".tmpl") }

    /// Whether this file changes when `chezmoi apply` runs (has a real diff).
    var hasDiff: Bool { !isDir && status != nil }

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
            let kids = builder.children
                .map(convert)
                .sorted(by: Self.order)
            let ownStatus = status[entry.absolutePath]
            let changedDescendant = kids.contains { $0.status != nil || $0.hasChangedDescendant }
            return FileNode(
                id: entry.relativePath,
                name: (entry.relativePath as NSString).lastPathComponent,
                relativePath: entry.relativePath,
                absolutePath: entry.absolutePath,
                sourceAbsolute: entry.sourceAbsolute,
                isDir: entry.isDir,
                children: entry.isDir ? kids : nil,
                status: ownStatus,
                hasChangedDescendant: changedDescendant
            )
        }

        return roots.map(convert).sorted(by: order)
    }

    /// Directories first, then files; alphabetical within each group.
    private static func order(_ a: FileNode, _ b: FileNode) -> Bool {
        if a.isDir != b.isDir { return a.isDir && !b.isDir }
        return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
    }
}
