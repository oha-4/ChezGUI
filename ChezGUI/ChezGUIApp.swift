import SwiftUI

/// A selectable colour theme. Each case is a {light, dark} *pair*; the web side
/// resolves which half to show from the OS appearance, so there's no separate
/// light/dark toggle. `rawValue` is the palette key sent over the bridge and
/// persisted in UserDefaults; it must match the keys in `PALETTES` in main.ts.
enum ThemePalette: String, CaseIterable, Identifiable {
    case `default` = "Default"
    case solarized = "Solarized"

    static let storageKey = "themePalette"
    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .default: return String(localized: "Default")
        case .solarized: return "Solarized"
        }
    }
}

@main
struct ChezGUIApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // `Window` (not `WindowGroup`) is a single-instance scene: ⌘N no longer
        // spawns extra windows, so only one app window ever exists.
        Window("ChezGUI", id: "main") {
            ContentView()
                .frame(minWidth: 800, minHeight: 500)
        }
        .windowToolbarStyle(.unified)

        Settings {
            SettingsView()
        }
    }
}

/// Quit the whole app when its (single) window is closed.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

/// Preferences window (⌘,). Read-only MVP exposes just the theme picker.
struct SettingsView: View {
    @AppStorage(ThemePalette.storageKey) private var themePalette = ThemePalette.default.rawValue

    var body: some View {
        Form {
            Picker("Theme", selection: $themePalette) {
                ForEach(ThemePalette.allCases) { palette in
                    Text(palette.displayName).tag(palette.rawValue)
                }
            }
            Text("Each theme follows your system's light/dark appearance.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 340)
    }
}
