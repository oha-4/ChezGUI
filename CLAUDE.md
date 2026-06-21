# CLAUDE.md — ChezGUI dev notes

Native macOS GUI for [chezmoi](https://www.chezmoi.io/). **Read-only MVP**: browse
managed dotfiles as a tree, view colourised diffs / source / rich previews. No
editing, saving, or `apply` yet. See `README.md` for the user-facing overview.

## Build & run (important workflow)

The Swift app bundles a pre-built copy of the web assets. **After any change under
`web/`, you must rebuild and re-stage before building the app:**

```sh
npm --prefix web run build                 # web/ → web/dist
rsync -a --delete web/dist/ ChezGUI/Resources/web/
xcodebuild -project ChezGUI.xcodeproj -target ChezGUI -configuration Debug build
open build/Debug/ChezGUI.app
```

- Run all commands from the **project root** (a stray `cd web` breaks the relative paths above).
- `web/` build doesn't type-check; run `cd web && npx tsc --noEmit` to catch TS errors.
- `ChezGUI/Resources/web/` is git-ignored (regenerated from `web/dist`).

## Project structure quirks

- **`ChezGUI.xcodeproj/project.pbxproj` is hand-written** (no xcodegen/tuist available).
  Adding a new Swift file means **manually editing the pbxproj** (a PBXFileReference +
  PBXBuildFile entry + listing it in the Sources phase). IDs use `DEAD…`/`BEEF…`/`C0DE…` prefixes.
- App is built **unsandboxed** (no entitlements) so it can exec `chezmoi` and read `$HOME`.
- `chezmoi` binary is discovered in `ChezmoiClient` (Homebrew paths → `zsh -lc 'command -v chezmoi'`).

## Architecture

```
ChezGUI/ (SwiftUI)
  ContentView      NavigationSplitView (sidebar tree + detail) + refresh toolbar
  Chezmoi/         ChezmoiClient (Process wrapper, read-only cmds) + ChezmoiModels
  Sidebar/         FileNode (tree builder), FileTreeView (.sidebar list), StatusBadge
  Detail/          DetailView (Diff/Edit/Rich tabs), WebViewHost (WKWebView), WebBridge
web/ (Vite + TS)   Monaco (diff/source) + markdown-it (rich). Served to WKWebView over
                   a custom app:// scheme (NOT file://) so Monaco workers load.
```

Data flow: `chezmoi managed --format json --path-style all` (+ `--include=dirs`) builds the
tree; `chezmoi status -p absolute` → M/A/D/R badges; Diff = file on disk (original) vs
`chezmoi cat` (modified); Rich = render `chezmoi cat` (markdown) or base64 image data URI.

Tabs are dynamic per file (`DetailView.availableModes`): Diff only when the file has a
diff, Rich only for markdown/images. `defaultMode` picks the best tab on selection.

## Key decisions & DEAD ENDS — do not redo these

- **Diff is full-diff only. Do NOT re-add `hideUnchangedRegions` folding or `compactMode`.**
  We tried both and removed them:
  - `compactMode: true` (for a "N hidden lines" text indicator) **hijacks `renderSideBySide`**:
    Monaco forces inline view for "simple" diffs (`isSimpleDiff` = all changes are pure
    add/delete, no in-place modification). That's the "side-by-side sometimes doesn't work" bug.
  - The collapse "flash" (full diff paints, then unchanged regions collapse a few frames later)
    is **inherent to Monaco's async diff** and not cleanly fixable (visibility-hiding until
    `onDidUpdateDiff` + rAF did not help). No GitHub fix exists; not fixed in 0.53–0.55.
  - Net: the user chose **full diff + a side-by-side⇄inline toggle only**. Keep it that way
    unless they explicitly ask to revisit.
- **Diff toolbar** lives in the web side (icon button, top-right), not the native header —
  view-rendering options stay next to Monaco. Native header owns Diff/Edit/Rich + Template badge + path.
- **SwiftUI stale-self gotcha**: `onChange`/`task` action closures can read a stale `self`
  (value-type snapshot). `DetailView` resolves node/mode in `body` and passes them as
  locals into `.task`/`load(node:mode:)`; `onChange(node.id)` only resets `modeSelection = nil`.
  Don't reintroduce reads of `self.node` inside those closures.
- **Templates**: source may be `*.tmpl`; the Edit tab shows raw template source (with a
  "Template" badge). Diff/Rich use `chezmoi cat` so they show the rendered result — templates
  are transparent there. `.tmpl` is stripped for syntax-highlight language detection.
- **Rich View** renders the *target* (`chezmoi cat`), not the source. YAML frontmatter is
  parsed (`js-yaml`) into a table; markdown via `markdown-it` with `html:false` (XSS-safe).

## Remaining / next phase (not started)

- Editing: make the Edit tab writable → write back to source / `chezmoi edit`.
- `chezmoi apply` (with confirmation dialog), `add` / `re-add` / `forget` / `merge`.
- ③ side-by-side rendered "rich diff" (old vs new markdown) — deprioritised after the diff
  simplification; only do it if the user asks.
