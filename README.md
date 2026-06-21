# ChezGUI

A native macOS GUI for [chezmoi](https://www.chezmoi.io/) — browse your managed
dotfiles as a tree and view colourised diffs. **Read-only MVP**: no editing,
saving, or `apply` yet (those are intentionally out of scope for now).

## Architecture

- **SwiftUI app** (`ChezGUI/`) — `NavigationSplitView` with a native source-list
  tree on the left and a WebView detail pane on the right.
  - `Chezmoi/` — `ChezmoiClient` runs the `chezmoi` CLI (read-only commands) and
    parses its JSON/text output; `ChezmoiModels` holds the data types.
  - `Sidebar/` — `FileNode` builds the tree from `chezmoi managed`, with
    `M/A/D/R` status badges (and an aggregation dot on changed folders).
  - `Detail/` — `DetailView` hosts `Diff | Edit` view tabs; `MonacoBridge`
    drives an embedded `WKWebView` over a custom `app://` scheme.
- **Web bundle** (`web/`) — Vite + TypeScript + Monaco Editor. `showDiff` uses
  Monaco's diff editor (left = file on disk, right = `chezmoi cat` target);
  `showSource` shows the raw source file read-only.

## chezmoi commands used (all read-only)

- `chezmoi managed --format json --path-style all` — tree of entries
- `chezmoi managed --path-style relative --include=dirs` — dir/file classification
- `chezmoi status -p absolute` — per-file M/A/D/R
- `chezmoi cat <target>` — rendered target contents (diff right side)
- `chezmoi source-path <target>` — source file path (Edit tab)

## Build & run

```sh
# 1. Build the web bundle and stage it into the app's resources
cd web
npm install
npm run build
cd ..
rsync -a --delete web/dist/ ChezGUI/Resources/web/

# 2. Build & run the app
xcodebuild -project ChezGUI.xcodeproj -target ChezGUI -configuration Debug build
open build/Debug/ChezGUI.app
```

The app is built **unsandboxed** so it can exec `chezmoi` and read files under
`$HOME`. `chezmoi` is discovered from common Homebrew paths, falling back to a
login shell (`zsh -lc 'command -v chezmoi'`).

## Developing the web UI standalone

```sh
cd web
npm run dev    # open the printed URL; drive window.chezgui.* from the console
```

Whenever `web/` changes, re-run the `npm run build` + `rsync` step before
rebuilding the app (the bundle ships a pre-built copy under
`ChezGUI/Resources/web/`).

## Not yet implemented (next phase)

- Editing the Edit tab and writing back to the source state
- `chezmoi apply` (with a confirmation dialog), `add` / `re-add` / `forget` / `merge`
- Template / encrypted file handling, multi-file tabs
