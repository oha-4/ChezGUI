import Foundation
import WebKit

/// Serves the bundled Vite/Monaco build over a custom `app://app/...` scheme.
/// A custom scheme (rather than file://) lets Monaco's web worker and relative
/// module imports load reliably.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "app"

    /// Directory inside the app bundle holding the built web assets (`web/`).
    private var rootURL: URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web")?
            .deletingLastPathComponent()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let root = rootURL, let url = task.request.url else {
            task.didFailWithError(ChezmoiError(message: "web assets missing"))
            return
        }
        var relative = url.path
        if relative.hasPrefix("/") { relative.removeFirst() }
        if relative.isEmpty { relative = "index.html" }

        let fileURL = root.appendingPathComponent(relative)
        guard let data = try? Data(contentsOf: fileURL) else {
            task.didFailWithError(ChezmoiError(message: "not found: \(relative)"))
            return
        }
        // Must be an HTTPURLResponse with an explicit 200: a plain URLResponse
        // surfaces to `fetch()` as `status: 0`, which some loaders (e.g. the
        // monaco-vscode-api theme loader, which requires `status === 200`) treat
        // as a failure even though the body is delivered.
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": Self.mimeType(for: fileURL.pathExtension),
                "Content-Length": String(data.count),
                "Access-Control-Allow-Origin": "*",
            ]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "wasm": return "application/wasm"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        default: return "application/octet-stream"
        }
    }
}

/// Owns the WKWebView and drives Monaco. Buffers commands until the page
/// reports `ready`, then flushes the latest one.
@MainActor
final class MonacoBridge: NSObject, ObservableObject, WKScriptMessageHandler {
    let webView: WKWebView
    private var isReady = false
    /// Commands issued before the page reports `ready`, flushed in order once it
    /// does. A queue (not a single slot) so independent commands — e.g. setTheme
    /// + showDiff — can't clobber each other during startup.
    private var pendingScripts: [String] = []

    override init() {
        let config = WKWebViewConfiguration()
        let handler = AppSchemeHandler()
        config.setURLSchemeHandler(handler, forURLScheme: AppSchemeHandler.scheme)
        // Retain the handler for the lifetime of the config.
        objc_setAssociatedObject(config, "schemeHandler", handler, .OBJC_ASSOCIATION_RETAIN)

        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        config.userContentController.add(self, name: "bridge")
        if let start = URL(string: "\(AppSchemeHandler.scheme)://app/index.html") {
            webView.load(URLRequest(url: start))
        }
    }

    // MARK: - JS -> Swift

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            isReady = true
            for script in pendingScripts {
                webView.evaluateJavaScript(script)
            }
            pendingScripts.removeAll()
        case "log":
            if let payload = body["payload"] { print("[web] \(payload)") }
        default:
            break
        }
    }

    // MARK: - Swift -> JS

    func showDiff(path: String, language: String?, original: String, modified: String) {
        send("showDiff", [
            "path": path,
            "language": language as Any,
            "original": original,
            "modified": modified,
        ])
    }

    func showSource(path: String, language: String?, content: String, readOnly: Bool = true) {
        send("showSource", [
            "path": path,
            "language": language as Any,
            "content": content,
            "readOnly": readOnly,
        ])
    }

    func showRich(path: String, markdown: String) {
        send("showRich", ["path": path, "markdown": markdown])
    }

    func showImage(path: String, dataURI: String) {
        send("showImage", ["path": path, "dataUri": dataURI])
    }

    func clear(_ text: String) {
        send("clear", text)
    }

    /// Push the selected theme palette key (e.g. "github", "system"). The web
    /// side resolves light/dark from the OS appearance within that palette.
    func setTheme(_ palette: String) {
        send("setTheme", palette)
    }

    private func send(_ fn: String, _ arg: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: [arg], options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        // json is a one-element array literal; unwrap to the single argument.
        let script = "window.chezgui.\(fn).apply(null, \(json));"
        if isReady {
            webView.evaluateJavaScript(script)
        } else {
            pendingScripts.append(script)
        }
    }
}
