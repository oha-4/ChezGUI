import Foundation

/// Thin wrapper around the `chezmoi` CLI. All invocations run off the main
/// thread; callers `await` the results. Read-only commands only (MVP).
actor ChezmoiClient {
    /// Resolved path to the chezmoi binary, discovered lazily.
    private var binaryPath: String?

    // MARK: - Binary discovery

    private func resolveBinary() throws -> String {
        if let binaryPath { return binaryPath }

        let candidates = [
            "/opt/homebrew/bin/chezmoi",
            "/usr/local/bin/chezmoi",
            (NSHomeDirectory() as NSString).appendingPathComponent(".local/bin/chezmoi"),
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            binaryPath = path
            return path
        }

        // Fall back to a login shell so we pick up a user-customised PATH.
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

    // MARK: - Process execution

    private struct ProcessResult {
        let stdout: String
        let stderr: String
        let exitCode: Int32
    }

    private func runRawData(executable: String, args: [String]) throws -> (stdout: Data, stderr: String, exitCode: Int32) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args

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

    private func runRaw(executable: String, args: [String]) throws -> ProcessResult {
        let raw = try runRawData(executable: executable, args: args)
        return ProcessResult(
            stdout: String(decoding: raw.stdout, as: UTF8.self),
            stderr: raw.stderr,
            exitCode: raw.exitCode
        )
    }

    /// Run a chezmoi subcommand and return stdout, throwing on non-zero exit.
    private func run(_ args: [String]) throws -> String {
        let binary = try resolveBinary()
        let result = try runRaw(executable: binary, args: args)
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
        let raw = try runRawData(executable: binary, args: ["cat", target])
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
}
