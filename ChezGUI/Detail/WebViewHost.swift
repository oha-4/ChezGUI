import SwiftUI
import WebKit

/// Embeds the Monaco-hosting WKWebView into SwiftUI.
struct WebViewHost: NSViewRepresentable {
    let bridge: MonacoBridge

    func makeNSView(context: Context) -> WKWebView {
        bridge.webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
