# ChezGUI

A native macOS GUI for [chezmoi](https://www.chezmoi.io/) — browse your managed
dotfiles as a tree and inspect them with colourised diffs, syntax-highlighted
source, and rich previews.

> **Read-only MVP.** ChezGUI does not edit, save, or run `apply` yet — it only
> reads your chezmoi state via read-only commands. Editing and applying are the
> next phase (see [Roadmap](#roadmap)).

![Platform](https://img.shields.io/badge/platform-macOS-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## Features

- **File tree** of everything chezmoi manages, with `M / A / D / R` status
  badges and a change indicator that rolls up to parent folders.
- **Diff view** powered by a real diff editor: left = the file on disk
  (original), right = `chezmoi cat` (the rendered target). Side-by-side ⇄ inline
  toggle.
- **Source view** with full VS Code TextMate syntax highlighting and themes.
  chezmoi `*.tmpl` templates highlight their Go-template `{{ … }}` *inside*
  string values via a TextMate injection grammar.
- **Rich view** for Markdown (rendered with `markdown-it`, YAML frontmatter
  parsed into a table) and images (inline preview).

Tabs are shown per file based on what makes sense: Diff only when there's a
diff, Rich only for Markdown/images.

## Requirements

- macOS (recent; built unsandboxed)
- [chezmoi](https://www.chezmoi.io/) installed (Homebrew or on `PATH`)
- For building: Xcode + command line tools, and Node.js / npm for the web bundle

## Architecture

```
ChezGUI/ (SwiftUI)
  ContentView      NavigationSplitView (sidebar tree + detail) + refresh toolbar
  Chezmoi/         ChezmoiClient (Process wrapper, read-only cmds) + ChezmoiModels
  Sidebar/         FileNode (tree builder), FileTreeView (sidebar list), StatusBadge
  Detail/          DetailView (Diff/Source/Rich tabs), WebViewHost (WKWebView), WebBridge
web/ (Vite + TS)   @codingame/monaco-vscode-api — the real VS Code TextMate +
                   theme services for diff/source highlighting, markdown-it for
                   rich previews. Served to the WKWebView over a custom app://
                   scheme (not file://) so workers/WASM load.
```

Highlighting is one unified pipeline built on `@codingame/monaco-vscode-api`
(real VS Code TextMate + theme services — not Monarch, not Shiki). This is what
lets `*.tmpl` files highlight Go-template syntax inside string values, which
Shiki cannot do.

### chezmoi commands used (all read-only)

- `chezmoi managed --format json --path-style all` — tree of entries
- `chezmoi managed --path-style relative --include=dirs` — dir/file classification
- `chezmoi status -p absolute` — per-file `M / A / D / R`
- `chezmoi cat <target>` — rendered target contents (diff right side, rich view)
- `chezmoi source-path <target>` — source file path (source view)

## Build & run

The Swift app bundles a pre-built copy of the web assets, so **after any change
under `web/` you must rebuild and re-stage before building the app:**

```sh
# 1. Build the web bundle and stage it into the app's resources
npm --prefix web install
npm --prefix web run build
rsync -a --delete web/dist/ ChezGUI/Resources/web/

# 2. Build & run the app
xcodebuild -project ChezGUI.xcodeproj -target ChezGUI -configuration Debug build
open build/Debug/ChezGUI.app
```

Run all commands from the project root. `ChezGUI/Resources/web/` is git-ignored
(regenerated from `web/dist`).

The app is built **unsandboxed** so it can exec `chezmoi` and read files under
`$HOME`. `chezmoi` is discovered from common Homebrew paths, falling back to a
login shell (`zsh -lc 'command -v chezmoi'`).

## Developing the web UI standalone

```sh
npm --prefix web run dev    # open the printed URL; drive window.chezgui.* from the console
cd web && npx tsc --noEmit  # type-check (the Vite build itself does not)
```

Whenever `web/` changes, re-run the `npm run build` + `rsync` step before
rebuilding the app.

## Roadmap

- Editing the source state from the app (`chezmoi edit` / write-back)
- `chezmoi apply` (with a confirmation dialog), `add` / `re-add` / `forget` / `merge`
- Side-by-side rendered "rich diff" (old vs new Markdown)

## License

[MIT](LICENSE) © Yoshito Ohata
