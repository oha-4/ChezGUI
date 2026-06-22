# CLAUDE.md — ChezGUI dev notes

Native macOS GUI for [chezmoi](https://www.chezmoi.io/). Browse managed dotfiles as
a tree, view colourised diffs / rich previews, **edit the source state** in the
Edit tab (save writes directly to the chezmoi source file), **manage membership**
(`chezmoi forget` / `re-add`), and **apply** changes to disk per file/folder
(`chezmoi apply`) — all from the sidebar right-click menu. No batch/apply-all yet.
See `README.md` for the user-facing overview.

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
  Chezmoi/         ChezmoiClient (Process wrapper; read-only cmds + apply/forget/re-add) + ChezmoiModels
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
the vendored `toml` + `go-template` + `viml` + `ignore` grammars (none but `toml`
are VS Code builtins; `viml` is MIT, from XadillaX/vscode-language-viml; `ignore`
is a small gitignore-style grammar for `.chezmoiignore`/`.chezmoiremove`/`.gitignore`,
mapped by filename in `FILENAME_LANG`), the `injectTo` injection grammar
(`web/src/grammars/`), and the VS Code colour themes (`web/src/themes-vscode/`).
Base languages (json/yaml/ini/shellscript/markdown/python/ruby/lua/rust/go/
javascript/typescript/perl/xml/html/css) come from
`@codingame/monaco-vscode-*-default-extension` packages — to add another, install
its package, `await` its `whenReady` in `bootstrap()`, and add the extension to
`EXT_LANG` (and its `source.*` scope to the injection's `injectTo` if `*.tmpl`
of that language should also highlight `{{ … }}`). There is no more
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
- **Editor models MUST be held via `createModelReference`, NOT `monaco.editor.create
  Model`.** With the full VS Code services, a plain `createModel` model is reference-
  counted and **auto-disposed once nothing holds a reference** — a standalone
  editor's `setModel`/`model:` does NOT count. The model got disposed right after
  `showSource`/`showDiff`, throwing *"TextModel got disposed before DiffEditorWidget
  model got reset"* and **blanking the editor on the first click/keystroke**. Fix
  (`web/src/main.ts`): `getFileServiceOverride()` + a `RegisteredFileSystemProvider`
  registered via `registerFileSystemOverlay`, then `makeModel()` writes content to a
  unique `file:///chezgui/<seq>/<name>` virtual file and `createModelReference`s it;
  we hold the ref (`currentDisposers`) and release it in `disposeCurrent`, which
  disposes the model. `showDiff`/`showSource` are therefore **async**, guarded by a
  `showGeneration` token so a superseded in-flight show bails instead of mounting.
- **Diff disposal order**: in `disposeCurrent`, call `diffEditor.setModel(null)`
  BEFORE releasing the model references — the DiffEditorWidget registers an
  onWillDispose guard on its models that fires the same BugIndicatingError otherwise.

Data flow: `chezmoi managed --format json --path-style all` (+ `--include=dirs`) builds the
tree; `chezmoi status -p absolute` → M/A/D/R badges; Diff = file on disk (original) vs
`chezmoi cat` (modified); Rich = render `chezmoi cat` (markdown) or base64 image data URI.

**chezmoi control-files section** (sidebar "chezmoi" `Section`, below the managed tree):
the source-dir special files (`.chezmoiignore`, `.chezmoi.toml.tmpl`, contents of
`.chezmoitemplates/` / `.chezmoiscripts/`, …) are NOT in `chezmoi managed`, so
`ChezmoiClient.specialFiles()` discovers them by scanning `chezmoi source-path`'s root for
`.chezmoi*` entries (one level deep into the two container dirs). They become `FileNode`s
with **`isControlFile = true`** (id prefixed `control:`, `hasDiff` forced false,
`absolutePath == sourceAbsolute == the file itself`), held in `AppModel.controlNodes`.
They are **edit-only**: `DetailView.availableModes` returns `[.edit]`, and the sidebar
context menu is just Open / Reveal — no apply/forget/re-add/Diff (all managed-only). Saving
reuses the normal Edit-tab flow (writes straight to the source file). The config template
`.chezmoi.toml.tmpl` highlights via the existing `*.tmpl` path; `.chezmoiignore` /
`.chezmoiremove` highlight via a vendored `ignore` grammar (gitignore-style) with the
Go-template injection overlaid (they're always templates in chezmoi). Out of scope: the
external config file (`~/.config/chezmoi/chezmoi.toml`),
and creating/deleting special files (edit only).

Membership & apply commands (sidebar right-click; `ChezmoiClient` mutating section,
`AppModel` actions, `FileTreeView` context menu + a `confirmationDialog` per action).
Menu order is **Apply → Re-add → Forget** (forward, reverse, then destructive-last):
- `chezmoi apply --force <target>` — write the rendered source state to the on-disk
  file (the source becomes the source of truth). `--force` required (no TTY). Offered
  **when `node.hasDiff`** (files) or **`node.hasChangedDescendant`** (folders) — a no-op
  without a diff. **Templates ARE offered** (unlike re-add): apply renders `{{ … }}`
  fine. Touches the destination only, so the Edit tab's source buffer is unaffected.
- `chezmoi re-add <target>` — overwrite the source state from the on-disk file (make the
  destination the source of truth). Offered **only when `node.hasDiff && !node.isTemplate`**:
  re-add is a no-op without changes, and chezmoi never re-adds templates (would clobber the
  `{{ … }}` with rendered output).
- `chezmoi forget --force <target>` — stop managing a file; **leaves the on-disk file**.
  `--force` is required (no TTY for the prompt). Offered for every file.
All run `await model.<action>` → `refresh()`.

Save flow (Edit tab): web posts `{type:"save", payload:{content}}` → `MonacoBridge`
writes it **directly to `editableSourcePath`** (the `*.tmpl`/source file,
`Data.write(atomically:)` — no `chezmoi` shell-out) → `markSaved()` back to JS +
`onSaved` → `AppModel.refresh()` (re-resolves the selection by id so the editor
session survives). Dirty state is web-tracked (`onDidChangeModelContent`) and mirrored
to `MonacoBridge.isDirty`; navigation (sidebar + tabs) is gated through
`ContentView.guardedNavigate` → a Save/Discard/Cancel `confirmationDialog`.

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
- **Templates**: source may be `*.tmpl`; the Edit tab shows (and now **edits**) raw
  template source (with a "Template" badge), highlighted as its base language +
  Go-template injection (see the highlighting section above). Saving writes the raw
  template text back to the source. Diff/Rich use `chezmoi cat` so they show the
  rendered result — templates are transparent there. `.tmpl` is stripped for
  syntax-highlight language detection.
- **`MonacoBridge` is owned by `ContentView`** (one WebView), passed into `DetailView`
  as `@ObservedObject`, so the sidebar's selection guard can read `bridge.isDirty`.
  `WebViewHost` hosts the shared `bridge.webView` inside a throwaway container NSView
  (re-attaching on update) — returning the reused WKWebView directly from `makeNSView`
  lets a re-render (now triggered by `isDirty` changes) detach and blank it.
- **Rich View** renders the *target* (`chezmoi cat`), not the source. YAML frontmatter is
  parsed (`js-yaml`) into a table; markdown via `markdown-it` with `html:false` (XSS-safe).

## Remaining / next phase (not started)

- `chezmoi add` / `merge`; a batch/apply-all across the whole tree (per-file/folder
  apply is done).
- ③ side-by-side rendered "rich diff" (old vs new markdown) — deprioritised after the diff
  simplification; only do it if the user asks.

Done (so not "remaining"):
- Editing the Edit tab → writes back to the source file (see the save flow + the
  model-reference gotcha above).
- `apply` / `forget` / `re-add` per file/folder from the sidebar right-click menu
  (see the membership & apply commands under Data flow).
