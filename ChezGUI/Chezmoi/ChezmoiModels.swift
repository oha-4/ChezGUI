import SwiftUI

/// A single entry managed by chezmoi in the destination directory.
struct ManagedEntry: Hashable {
    let relativePath: String   // e.g. ".config/claude/settings.json"
    let absolutePath: String   // destination path in $HOME
    let sourceAbsolute: String // path in the chezmoi source dir
    let isDir: Bool
}

/// The effect that `chezmoi apply` would have on a target, derived from the
/// second column of `chezmoi status` (git-status style).
enum ChezmoiStatus: String {
    case modified = "M"
    case added = "A"
    case deleted = "D"
    case run = "R"

    init?(code: Character) {
        switch code {
        case "M": self = .modified
        case "A": self = .added
        case "D": self = .deleted
        case "R": self = .run
        default: return nil
        }
    }

    var color: Color {
        switch self {
        case .modified: return .orange
        case .added: return .green
        case .deleted: return .red
        case .run: return .blue
        }
    }
}

/// Error surfaced when a chezmoi invocation fails or the binary is missing.
struct ChezmoiError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
