import SwiftUI
import WebKit

/// Embeds the Monaco-hosting WKWebView into SwiftUI.
///
/// The WKWebView is owned by `MonacoBridge` and reused across the app's lifetime.
/// Returning that shared view *directly* from `makeNSView` is the classic SwiftUI
/// anti-pattern: when an ancestor re-renders (e.g. now that typing flips the
/// bridge's `@Published isDirty`), SwiftUI can detach the reused view and the
/// editor goes blank. Instead we hand SwiftUI a throwaway container and keep the
/// shared web view pinned inside it, re-attaching it if a remount ever moves it.
struct WebViewHost: NSViewRepresentable {
    let bridge: MonacoBridge

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        attach(bridge.webView, to: container)
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        let web = bridge.webView
        if web.superview !== nsView {
            attach(web, to: nsView)
        }
    }

    /// Pin `web` to fill `container` (re-parenting it if it lived elsewhere).
    private func attach(_ web: WKWebView, to container: NSView) {
        web.removeFromSuperview()
        web.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            web.topAnchor.constraint(equalTo: container.topAnchor),
            web.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }
}
