import Foundation

/// Thin wrapper around the `chezmoi` CLI. All invocations run off the main
/// thread; callers `await` the results. Read-only commands only (MVP).
actor ChezmoiClient {
    /// Resolved path to the chezmoi binary, discovered lazily.
    private var binaryPath: String?

    /// PATH from a login shell, used to run chezmoi so its own child
    /// processes (`output` template funcs, `run_` scripts) can find user
    /// binaries even when the app is launched from Finder/Dock with a
    /// minimal inherited PATH. Resolved lazily, cached.
    private var loginPathValue: String??

    // MARK: - Binary discovery

    private func resolveBinary() throws -> String {
        if let binaryPath { return binaryPath }

        // Resolve via a login shell, the same PATH chezmoi's own child
        // processes get (see `chezmoiEnvironment`) — one source of truth, so
        // if we can run chezmoi its `output`/`run_` helpers resolve too.
        if let resolved = try? runRaw(
            executable: "/bin/zsh",
            args: ["-lc", "command -v chezmoi"]
        ).stdout.trimmingCharacters(in: .whitespacesAndNewlines),
            !resolved.isEmpty,
            FileManager.default.isExecutableFile(atPath: resolved)
        {
            binaryPath = resolved
            return resolved
        }

        throw ChezmoiError(message: String(localized: "chezmoi executable not found. Install it (e.g. `brew install chezmoi`) and try again."))
    }

    /// PATH as seen by a login shell (`.zshenv`/`.zprofile`/`.zlogin`), so
    /// chezmoi's child processes resolve user binaries when the app is
    /// launched from Finder/Dock. NOT interactive (no `.zshrc`) — env vars
    /// belong in the login files by zsh convention.
    private func loginPath() -> String? {
        if let cached = loginPathValue { return cached }
        let resolved = try? runRaw(
            executable: "/bin/zsh",
            args: ["-lc", "printf %s \"$PATH\""]
        ).stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = (resolved?.isEmpty == false) ? resolved : nil
        loginPathValue = value
        return value
    }

    /// Base environment for chezmoi invocations: the inherited environment
    /// with PATH overridden by the login-shell PATH when available.
    private func chezmoiEnvironment() -> [String: String]? {
        guard let path = loginPath() else { return nil }
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        return env
    }

    // MARK: - Process execution

    private struct ProcessResult {
        let stdout: String
        let stderr: String
        let exitCode: Int32
    }

    private func runRawData(executable: String, args: [String], environment: [String: String]? = nil) throws -> (stdout: Data, stderr: String, exitCode: Int32) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        if let environment { process.environment = environment }

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        try process.run()
        // Read before waiting to avoid deadlock on large output.
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        return (
            stdout: outData,
            stderr: String(decoding: errData, as: UTF8.self),
            exitCode: process.terminationStatus
        )
    }

    private func runRaw(executable: String, args: [String], environment: [String: String]? = nil) throws -> ProcessResult {
        let raw = try runRawData(executable: executable, args: args, environment: environment)
        return ProcessResult(
            stdout: String(decoding: raw.stdout, as: UTF8.self),
            stderr: raw.stderr,
            exitCode: raw.exitCode
        )
    }

    /// Run a chezmoi subcommand and return stdout, throwing on non-zero exit.
    private func run(_ args: [String]) throws -> String {
        let binary = try resolveBinary()
        let result = try runRaw(executable: binary, args: args, environment: chezmoiEnvironment())
        guard result.exitCode == 0 else {
            let detail = result.stderr.isEmpty ? result.stdout : result.stderr
            let command = args.joined(separator: " ")
            throw ChezmoiError(message: String(localized: "chezmoi \(command) failed: \(detail.trimmingCharacters(in: .whitespacesAndNewlines))"))
        }
        return result.stdout
    }

    // MARK: - Commands

    private struct ManagedJSONEntry: Decodable {
        let absolute: String
        let sourceAbsolute: String
        let sourceRelative: String
    }

    /// List all managed entries with destination + source paths, classified
    /// into files vs directories.
    func managed() throws -> [ManagedEntry] {
        let json = try run(["managed", "--format", "json", "--path-style", "all"])
        let decoded = try JSONDecoder().decode(
            [String: ManagedJSONEntry].self,
            from: Data(json.utf8)
        )

        // Determine which relative paths are directories.
        let dirList = try run(["managed", "--path-style", "relative", "--include=dirs"])
        let dirs = Set(
            dirList.split(separator: "\n").map { String($0) }
        )

        return decoded.map { (relative, entry) in
            ManagedEntry(
                relativePath: relative,
                absolutePath: entry.absolute,
                sourceAbsolute: entry.sourceAbsolute,
                isDir: dirs.contains(relative)
            )
        }
    }

    /// Map of absolute destination path -> apply effect, for entries that differ.
    func status() throws -> [String: ChezmoiStatus] {
        let output = try run(["status", "-p", "absolute"])
        var result: [String: ChezmoiStatus] = [:]
        for line in output.split(separator: "\n", omittingEmptySubsequences: true) {
            let chars = Array(line)
            guard chars.count > 3 else { continue }
            let first = chars[0]
            let second = chars[1]
            // Path begins after the two status columns and a space.
            let path = String(chars[3...]).trimmingCharacters(in: .whitespaces)
            // Prefer the second column (effect of apply); fall back to the first.
            let status = ChezmoiStatus(code: second) ?? ChezmoiStatus(code: first)
            if let status { result[path] = status }
        }
        return result
    }

    /// Rendered target contents (what `apply` would write).
    func cat(target: String) throws -> String {
        try run(["cat", target])
    }

    /// Rendered target contents as raw bytes (for binary targets like images).
    func catData(target: String) throws -> Data {
        let binary = try resolveBinary()
        let raw = try runRawData(executable: binary, args: ["cat", target], environment: chezmoiEnvironment())
        guard raw.exitCode == 0 else {
            let detail = raw.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            throw ChezmoiError(message: String(localized: "chezmoi cat \(target) failed: \(detail)"))
        }
        return raw.stdout
    }

    /// Absolute path of the source-state file backing a target.
    func sourcePath(target: String) throws -> String {
        try run(["source-path", target])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Absolute path of the chezmoi source directory root (`chezmoi source-path`
    /// with no argument).
    func sourceRoot() throws -> String {
        try run(["source-path"])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// chezmoi control files that live in the source directory but are NOT
    /// managed destination entries (they steer chezmoi's behaviour):
    /// `.chezmoiignore`, `.chezmoiremove`, `.chezmoiroot`, `.chezmoiversion`,
    /// `.chezmoidata.*`, `.chezmoiexternal.*`, the config template
    /// (`.chezmoi.<fmt>.tmpl`), and the contents of the `.chezmoitemplates/` and
    /// `.chezmoiscripts/` directories. These don't appear in `chezmoi managed`,
    /// so we discover them by scanning the source root directly. Returned sorted
    /// for a stable sidebar order.
    func specialFiles() throws -> [ChezmoiSpecialFile] {
        let root = try sourceRoot()
        guard !root.isEmpty else { return [] }
        let fm = FileManager.default
        let rootURL = URL(fileURLWithPath: root)

        // Directory specials whose contents we surface as children.
        let containerDirs: Set<String> = [".chezmoitemplates", ".chezmoiscripts"]

        // `options: []` keeps dotfiles (every special file starts with `.`).
        guard let entries = try? fm.contentsOfDirectory(
            at: rootURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: []
        ) else { return [] }

        func isDirectory(_ url: URL) -> Bool {
            (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
        }

        var result: [ChezmoiSpecialFile] = []
        for url in entries {
            let name = url.lastPathComponent
            guard name.hasPrefix(".chezmoi") else { continue }
            let dir = isDirectory(url)
            if dir && containerDirs.contains(name) {
                // List the directory's contents as children (one level deep).
                let children = (try? fm.contentsOfDirectory(
                    at: url,
                    includingPropertiesForKeys: [.isDirectoryKey],
                    options: []
                )) ?? []
                let kids = children
                    .filter { !isDirectory($0) }
                    .map { ChezmoiSpecialFile(path: $0.path, name: $0.lastPathComponent, isDir: false, children: nil) }
                    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                result.append(ChezmoiSpecialFile(path: url.path, name: name, isDir: true, children: kids))
            } else if !dir {
                result.append(ChezmoiSpecialFile(path: url.path, name: name, isDir: false, children: nil))
            }
        }
        return result.sorted { lhs, rhs in
            if lhs.isDir != rhs.isDir { return lhs.isDir && !rhs.isDir }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    // MARK: - Mutating commands

    /// Stop managing a target: removes it from the source state but leaves the
    /// actual file in the destination directory untouched. `--force` skips the
    /// interactive confirmation prompt (we run without a TTY).
    func forget(target: String) throws {
        _ = try run(["forget", "--force", target])
    }

    /// Re-add a target: overwrite the source state with the current on-disk
    /// file, making the destination the source of truth. chezmoi itself never
    /// overwrites templates, and callers should not offer this for `*.tmpl`.
    func reAdd(target: String) throws {
        _ = try run(["re-add", target])
    }

    /// Apply a target: write the rendered source state to the destination file
    /// on disk (the source becomes the source of truth). `--force` skips the
    /// interactive prompt (we run without a TTY). Templates apply fine, so this
    /// is offered for any changed target. A no-op without a diff.
    ///
    /// `chezmoi apply <target>` does NOT create the target's ancestor
    /// directories — if the parent folder doesn't yet exist on disk it fails
    /// with `stat …: no such file or directory`. We create the parent chain
    /// first so applying a single file/folder into a not-yet-materialised tree
    /// works; a folder apply is recursive once its parent exists.
    func apply(target: String) throws {
        let parent = (target as NSString).deletingLastPathComponent
        if !parent.isEmpty {
            try? FileManager.default.createDirectory(
                atPath: parent,
                withIntermediateDirectories: true
            )
        }
        _ = try run(["apply", "--force", target])
    }

    /// Add an on-disk file (or directory, recursively) in the destination dir to
    /// chezmoi's source state. The target must already exist on disk and live
    /// under chezmoi's destination dir (~), else chezmoi errors (surfaced to the
    /// user). No parent-dir pre-creation needed (unlike `apply`): the target
    /// already exists.
    func add(target: String) throws {
        _ = try run(["add", target])
    }
}
