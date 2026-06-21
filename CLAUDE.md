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
web/ (Vite + TS)   monaco-vscode-api (real VS Code TextMate + theme services) for
                   diff/source highlighting + markdown-it (rich). Served to WKWebView
                   over a custom app:// scheme (NOT file://) so workers/WASM load.
```

## Syntax highlighting (monaco-vscode-api) — read before touching `web/`

Highlighting is **one unified pipeline**: `@codingame/monaco-vscode-api` with the
real VS Code **TextMate** + **theme** services (NOT Monaco's Monarch, NOT Shiki).
This is what lets chezmoi `*.tmpl` files highlight Go-template `{{ … }}` *inside*
string values (e.g. `"email": "{{ .email }}"`) via a TextMate **injection** grammar
(`injectTo`) — Shiki cannot do in-string injection; that's why it was rejected.

`web/src/main.ts` registers ONE local extension (`chezgui-grammars`) contributing:
the vendored `toml` + `go-template` grammars, the `injectTo` injection grammar
(`web/src/grammars/`), and the VS Code colour themes (`web/src/themes-vscode/`).
Base languages (json/yaml/ini/shellscript/markdown) come from
`@codingame/monaco-vscode-*-default-extension` packages. There is no more
`tm.ts`, no Monarch `gotmpl`, no per-scope colour mapping — the theme service
colours TextMate scopes directly. `DetailView.showSource` sends `language: nil`
even for templates; the base language is detected from the path and the injection
overlays `{{ … }}`.

**Hard-won gotchas — do NOT "fix" these back:**
- **`AppSchemeHandler` MUST return `HTTPURLResponse` with `statusCode: 200`** (see
  `WebBridge.swift`). A plain `URLResponse` surfaces to `fetch()` as `status: 0`,
  which the theme loader treats as failure → themes silently don't load → every
  token renders the default colour (`mtk1`). This was the single subtlest bug.
- **`build.minify: false` in `vite.config.ts` is required.** esbuild minification
  breaks the TextMate tokenisation/theme-colour path in WKWebView (tokens split
  but stay default-coloured). Offline-bundled app, so bundle size is a non-issue.
- **Themes are vendored as VS Code-format JSON and registered via our OWN extension
  + `?url`** (`web/src/themes-vscode/`). The `@codingame/*-theme-*` *packages* fail
  to load their theme files over app:// in WKWebView; our `?url`+registerFileUrl
  path is the one that works.
- **vite build needs two monaco-vscode-api patches** (in `vite.config.ts`): an
  alias of `@codingame/monaco-vscode-api/_virtual/main` → `src/shims/textmate-main.ts`,
  and a transform rewriting the background tokenizer's `.then(n => n.main)` to
  identity. Without them the build throws `applyStateStackDiff of undefined` at
  runtime. Also: `resolve.dedupe` all `@codingame/*`, `target: esnext`,
  `esbuild.minifySyntax: false`.
- **Workers** are wired by *label* via `MonacoEnvironment.getWorkerUrl/getWorkerOptions`
  using `?worker&url` imports (editor / extensionHost / TextMate). Enabling the
  TextMate service disables Monarch, so any unsupported language falls back to
  plaintext (acceptable; common dotfile languages are covered).
- `editor.experimental.asyncTokenization: false` (main-thread tokenisation) is set
  so small dotfiles colour without relying on the background-tokenisation worker.

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
  "Template" badge), highlighted as its base language + Go-template injection (see the
  highlighting section above). Diff/Rich use `chezmoi cat` so they show the rendered result —
  templates are transparent there. `.tmpl` is stripped for syntax-highlight language detection.
- **Rich View** renders the *target* (`chezmoi cat`), not the source. YAML frontmatter is
  parsed (`js-yaml`) into a table; markdown via `markdown-it` with `html:false` (XSS-safe).

## Remaining / next phase (not started)

- Editing: make the Edit tab writable → write back to source / `chezmoi edit`.
- `chezmoi apply` (with confirmation dialog), `add` / `re-add` / `forget` / `merge`.
- ③ side-by-side rendered "rich diff" (old vs new markdown) — deprioritised after the diff
  simplification; only do it if the user asks.
