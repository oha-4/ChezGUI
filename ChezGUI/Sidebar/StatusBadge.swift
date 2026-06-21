import SwiftUI

/// Trailing accessory for a sidebar row: a coloured M/A/D/R letter for changed
/// files, or a small aggregation dot for folders containing changes.
struct StatusBadge: View {
    let node: FileNode

    var body: some View {
        if let status = node.status {
            Text(status.rawValue)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(status.color)
                .frame(width: 14, height: 14)
                .background(status.color.opacity(0.15), in: RoundedRectangle(cornerRadius: 3))
        } else if node.isDir && node.hasChangedDescendant {
            Circle()
                .fill(Color.orange)
                .frame(width: 6, height: 6)
        }
    }
}
