// WKWebView's requestIdleCallback can be throttled/absent and monaco drives
// some tokenization through it. Install a prompt setTimeout-based version before
// monaco schedules any idle work, so highlighting lands reliably.
{
  const w = self as any;
  w.requestIdleCallback = (cb: (d: { didTimeout: boolean; timeRemaining: () => number }) => void) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1) as unknown as number;
  w.cancelIdleCallback = (id: number) => clearTimeout(id);
}

import MarkdownIt from "markdown-it";
import yaml from "js-yaml";

import * as monaco from "monaco-editor";

import { initialize, getService } from "@codingame/monaco-vscode-api";
import { registerExtension, ExtensionHostKind } from "@codingame/monaco-vscode-api/extensions";
import getTextMateServiceOverride, {
  ITextMateTokenizationService,
} from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getConfigurationServiceOverride, {
  initUserConfiguration,
} from "@codingame/monaco-vscode-configuration-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
// File service + an in-memory filesystem so editor buffers are backed by model
// REFERENCES. With the full VS Code services, a plain monaco.editor.createModel
// is auto-disposed once unreferenced (a standalone editor doesn't hold a service
// reference), which blanked the editor. createModelReference keeps the model
// alive until we release the reference.
import getFileServiceOverride, {
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import { createModelReference } from "@codingame/monaco-vscode-api/monaco";

// Default VS Code extensions: each registers a language + TextMate grammar.
// (Side-effect imports; we await their `whenReady` below.)
import { whenReady as jsonReady } from "@codingame/monaco-vscode-json-default-extension";
import { whenReady as yamlReady } from "@codingame/monaco-vscode-yaml-default-extension";
import { whenReady as iniReady } from "@codingame/monaco-vscode-ini-default-extension";
import { whenReady as shellReady } from "@codingame/monaco-vscode-shellscript-default-extension";
import { whenReady as markdownReady } from "@codingame/monaco-vscode-markdown-basics-default-extension";
import { whenReady as pythonReady } from "@codingame/monaco-vscode-python-default-extension";
import { whenReady as rubyReady } from "@codingame/monaco-vscode-ruby-default-extension";
import { whenReady as luaReady } from "@codingame/monaco-vscode-lua-default-extension";
import { whenReady as rustReady } from "@codingame/monaco-vscode-rust-default-extension";
import { whenReady as goReady } from "@codingame/monaco-vscode-go-default-extension";
import { whenReady as jsReady } from "@codingame/monaco-vscode-javascript-default-extension";
import { whenReady as tsReady } from "@codingame/monaco-vscode-typescript-basics-default-extension";
import { whenReady as perlReady } from "@codingame/monaco-vscode-perl-default-extension";
import { whenReady as xmlReady } from "@codingame/monaco-vscode-xml-default-extension";
import { whenReady as htmlReady } from "@codingame/monaco-vscode-html-default-extension";
import { whenReady as cssReady } from "@codingame/monaco-vscode-css-default-extension";

// Vendored grammars not shipped as VS Code builtins. `?url` => bundled as a
// relative asset, served over app:// offline.
import tomlGrammarUrl from "./grammars/toml.tmLanguage.json?url";
import injectionGrammarUrl from "./grammars/injection.go-template.tmLanguage.json?url";
import goTemplateGrammarUrl from "./grammars/go-template.tmLanguage.json?url";
// Vimscript isn't a VS Code builtin; vendored grammar (MIT, XadillaX/vscode-language-viml).
import vimlGrammarUrl from "./grammars/viml.tmLanguage.json?url";
// gitignore-style patterns, for chezmoi's `.chezmoiignore` / `.chezmoiremove`.
import ignoreGrammarUrl from "./grammars/ignore.tmLanguage.json?url";

// Vendored VS Code colour themes, registered via our own extension + `?url`
// (the path that loads reliably over app:// in WKWebView). Default = the classic
// VS Light/Dark; Solarized = the VS Code Solarized themes.
import defaultLightThemeUrl from "./themes-vscode/light_vs.json?url";
import defaultDarkThemeUrl from "./themes-vscode/dark_vs.json?url";
import solarizedLightThemeUrl from "./themes-vscode/solarized-light.json?url";
import solarizedDarkThemeUrl from "./themes-vscode/solarized-dark.json?url";

// ---- monaco-vscode-api workers ------------------------------------------
// Resolved by *label* via getWorkerUrl/getWorkerOptions. `?worker&url` makes
// vite bundle each worker (with its dep graph) as a relative asset URL.
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker?worker&url";
import extensionHostWorkerUrl from "@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url";
import textMateWorkerUrl from "@codingame/monaco-vscode-textmate-service-override/worker?worker&url";

const WORKER_URL: Record<string, string> = {
  editorWorkerService: editorWorkerUrl,
  extensionHostWorkerMain: extensionHostWorkerUrl,
  TextMateWorker: textMateWorkerUrl,
};
self.MonacoEnvironment = {
  getWorkerUrl: (_: unknown, label: string) => WORKER_URL[label] ?? editorWorkerUrl,
  getWorkerOptions: () => ({ type: "module" as const }),
} as any;

const root = document.getElementById("root") as HTMLElement;
const rich = document.getElementById("rich") as HTMLElement;
const placeholder = document.getElementById("placeholder") as HTMLElement;

// Minimal i18n for the few strings the web side owns.
const isJa = (navigator.language || "").toLowerCase().startsWith("ja");
const t = {
  noFileSelected: isJa ? "ファイルが選択されていません" : "No file selected",
  switchToInline: isJa ? "インライン差分に切り替え" : "Switch to inline diff",
  switchToSideBySide: isJa ? "サイドバイサイド差分に切り替え" : "Switch to side-by-side diff",
  save: isJa ? "保存 (⌘S)" : "Save (⌘S)",
};
placeholder.textContent = t.noFileSelected;

// Markdown renderer. html:false escapes raw HTML so the user's own dotfiles
// can't inject script into the WebView.
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

/** Which of the three overlapping panes is visible. */
function setActivePane(pane: "editor" | "rich" | "placeholder") {
  root.style.display = pane === "editor" ? "block" : "none";
  rich.style.display = pane === "rich" ? "block" : "none";
  placeholder.style.display = pane === "placeholder" ? "flex" : "none";
}

type Disposable = { dispose(): void };
let current: (monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor) & Disposable | null = null;

// Diff layout preference (side-by-side vs inline), owned by the web side.
let diffLayout: "inline" | "sidebyside" = "sidebyside";

// ---- editable source state ----------------------------------------------
// The Edit tab's editor (when editable), its last-saved value, and whether the
// buffer currently differs from it. Dirty transitions are reported to native.
let srcEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let srcCleanValue = "";
let srcDirty = false;

// In-memory filesystem backing editor models (registered in bootstrap).
let fsProvider: RegisteredFileSystemProvider | null = null;
// Monotonic counter for unique virtual file paths (never reused).
let modelSeq = 0;
// Disposers for the model references / files backing the current editor; run on
// disposeCurrent so the underlying models are released (and then disposed).
let currentDisposers: Array<() => void> = [];
// Bumped on every disposeCurrent so an in-flight async show() can detect it was
// superseded (model resolution is async) and bail out instead of mounting stale.
let showGeneration = 0;

/** Create a model backed by a fresh virtual file, returning it plus a disposer. */
async function makeModel(
  content: string,
  lang: string,
  label: string
): Promise<{ model: monaco.editor.ITextModel; dispose: () => void }> {
  const uri = monaco.Uri.file(`/chezgui/${++modelSeq}/${label}`);
  const fileDisposable = fsProvider!.registerFile(new RegisteredMemoryFile(uri, content));
  const ref = await createModelReference(uri);
  const model = ref.object.textEditorModel as monaco.editor.ITextModel;
  monaco.editor.setModelLanguage(model, lang);
  return {
    model,
    dispose: () => {
      ref.dispose();
      fileDisposable.dispose();
    },
  };
}

/** Last path segment, for a readable virtual filename (uniqueness comes from the
 *  per-model counter, so collisions don't matter). */
function baseName(path: string): string {
  const seg = path.split("/").pop();
  return seg && seg.length > 0 ? seg : "file";
}

// ---- bridge to native (JS -> Swift) -------------------------------------
type BridgeMessage = { type: string; payload?: unknown };
function postNative(msg: BridgeMessage) {
  const handlers = (window as any).webkit?.messageHandlers;
  if (handlers?.bridge) handlers.bridge.postMessage(msg);
}

// ---- theme --------------------------------------------------------------
// Every palette is a {light, dark} pair following the OS appearance. The keys
// here must match the rawValues of ThemePalette in Swift. Values are VS Code
// theme ids contributed by the imported theme extensions.
type ThemePair = { light: string; dark: string };
const PALETTES: Record<string, ThemePair> = {
  Default: { light: "chezgui-default-light", dark: "chezgui-default-dark" },
  Solarized: { light: "chezgui-solarized-light", dark: "chezgui-solarized-dark" },
};
// Page background behind monaco per concrete theme (avoids a flash on switch).
const THEME_BG: Record<string, string> = {
  "chezgui-default-light": "#ffffff",
  "chezgui-default-dark": "#1e1e1e",
  "chezgui-solarized-light": "#fdf6e3",
  "chezgui-solarized-dark": "#002b36",
};

let selectedPalette = "Default";

function osIsDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
/** Concrete VS Code theme id for the current palette + OS appearance. */
function currentTheme(): string {
  const pair = PALETTES[selectedPalette] ?? PALETTES.Default;
  return osIsDark() ? pair.dark : pair.light;
}
function applyBodyBg() {
  const bg = THEME_BG[currentTheme()] ?? (osIsDark() ? "#1f1f1f" : "#ffffff");
  document.documentElement.style.setProperty("--bg", bg);
}
/** Re-apply the resolved theme to the live editor and the page background. */
function applyTheme() {
  monaco.editor.setTheme(currentTheme());
  applyBodyBg();
}
/** Native -> web: switch the selected palette (light/dark stays automatic). */
function setTheme(palette: string) {
  selectedPalette = palette;
  applyTheme();
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

// ---- language detection -------------------------------------------------
// Maps file extensions to VS Code language ids. Languages without a registered
// TextMate grammar fall back to plaintext (uncoloured) — that's fine; the common
// dotfile languages below are all covered.
const EXT_LANG: Record<string, string> = {
  json: "json",
  jsonc: "jsonc",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  conf: "ini",
  ini: "ini",
  cfg: "ini",
  gitconfig: "ini",
  py: "python",
  pyw: "python",
  rb: "ruby",
  lua: "lua",
  rs: "rust",
  go: "go",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  pl: "perl",
  pm: "perl",
  xml: "xml",
  xsl: "xml",
  html: "html",
  htm: "html",
  css: "css",
  vim: "viml",
};
// Whole-filename matches (dotfiles that carry no useful extension, e.g. `.zshrc`).
const FILENAME_LANG: Record<string, string> = {
  zshrc: "shellscript",
  zshenv: "shellscript",
  zprofile: "shellscript",
  zlogin: "shellscript",
  zlogout: "shellscript",
  zpreztorc: "shellscript",
  bashrc: "shellscript",
  bash_profile: "shellscript",
  bash_login: "shellscript",
  bash_logout: "shellscript",
  bash_aliases: "shellscript",
  profile: "shellscript",
  aliases: "shellscript",
  shrc: "shellscript",
  kshrc: "shellscript",
  envrc: "shellscript",
  xprofile: "shellscript",
  xinitrc: "shellscript",
  vimrc: "viml",
  gvimrc: "viml",
  gitconfig: "ini",
  npmrc: "ini",
  editorconfig: "ini",
  inputrc: "ini",
  curlrc: "ini",
  wgetrc: "ini",
  // chezmoi control files (leading dot stripped by the normaliser below).
  chezmoiignore: "ignore",
  chezmoiremove: "ignore",
  gitignore: "ignore",
};
// Interpreter (from a `#!` shebang) → VS Code language id. Used only as a
// fallback for files whose name/extension says nothing (common for executable
// dotfile scripts). Most interpreters have no registered grammar so resolve to
// plaintext anyway, but shellscript — by far the common case — is covered.
const SHEBANG_LANG: Record<string, string> = {
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  ksh: "shellscript",
  dash: "shellscript",
  ash: "shellscript",
  python: "python",
  python2: "python",
  python3: "python",
  node: "javascript",
  ruby: "ruby",
  perl: "perl",
};
// Parse the interpreter out of a leading `#!` line, handling `/usr/bin/env`
// (incl. `env -S`) and trailing interpreter args, e.g. `#!/bin/bash -e`.
function detectShebang(content?: string): string | undefined {
  const m = content?.match(/^#!\s*(\S+)(.*)/);
  if (!m) return undefined;
  let interp = m[1].split("/").pop() ?? "";
  if (interp === "env") {
    // First arg that isn't a flag (`-S`) or a VAR=val assignment is the program.
    const arg = m[2].trim().split(/\s+/).find((t) => t && !t.startsWith("-") && !t.includes("="));
    interp = (arg ?? "").split("/").pop() ?? "";
  }
  return SHEBANG_LANG[interp.toLowerCase()];
}
function detectLanguage(path: string, explicit?: string, content?: string): string {
  if (explicit) return explicit;
  const base = (path.split("/").pop() ?? "").replace(/\.tmpl$/, "");
  // Normalize chezmoi source attributes + the leading dot so `.zshrc`,
  // `dot_zshrc`, `private_dot_zshrc` all resolve to the same name.
  const name = base
    .replace(/^(private_|readonly_|executable_|encrypted_|symlink_|literal_|exact_|empty_)*/, "")
    .replace(/^dot_/, "")
    .replace(/^\./, "")
    .toLowerCase();
  // Whole-name match first (rc files), then by extension, then the shebang.
  if (FILENAME_LANG[name]) return FILENAME_LANG[name];
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  if (EXT_LANG[ext]) return EXT_LANG[ext];
  return detectShebang(content) ?? "plaintext";
}

// ---- rendering ----------------------------------------------------------
function disposeCurrent() {
  // Invalidate any in-flight async show().
  showGeneration++;
  if (current) {
    const editor = current;
    current = null;
    // Detach models from the diff widget first so its onWillDispose guard is
    // removed before the models are released ("TextModel got disposed before
    // DiffEditorWidget model got reset" otherwise blanks the view).
    const model = (editor as monaco.editor.IStandaloneDiffEditor).getModel?.();
    if (model && "original" in model) {
      (editor as monaco.editor.IStandaloneDiffEditor).setModel(null);
    }
    editor.dispose();
  }
  // Release the model references AFTER the editor is gone; the model service then
  // disposes the underlying models (they live only as long as a reference does).
  for (const dispose of currentDisposers.splice(0)) {
    try {
      dispose();
    } catch {
      /* best-effort */
    }
  }
  // The editable-source refs point into `current`; drop them too. We don't post
  // a dirty:false here — native ownership of dirty state is reset explicitly via
  // setEditableSource when a new source loads (or after a confirmed discard).
  srcEditor = null;
  srcDirty = false;
  srcCleanValue = "";
}

// ---- save / dirty (JS <-> native) ---------------------------------------
/** Recompute dirty vs the last-saved value; report only on transitions. */
function updateDirty() {
  if (!srcEditor) return;
  const dirty = srcEditor.getValue() !== srcCleanValue;
  if (dirty === srcDirty) return;
  srcDirty = dirty;
  if (saveBtn) saveBtn.disabled = !dirty;
  postNative({ type: "dirty", payload: dirty });
}

/** Ask native to write the current buffer to the source file. */
function requestSave() {
  if (!srcEditor) return;
  postNative({ type: "save", payload: { content: srcEditor.getValue() } });
}

/** Native -> web: the write succeeded; adopt the current buffer as clean. */
function markSaved() {
  if (!srcEditor) return;
  srcCleanValue = srcEditor.getValue();
  srcDirty = false;
  if (saveBtn) saveBtn.disabled = true;
  postNative({ type: "dirty", payload: false });
}

/** Native -> web: current editor text (or null when no editor is shown). */
function getEditorContent(): string | null {
  return srcEditor ? srcEditor.getValue() : null;
}

function showPlaceholder(text: string) {
  disposeCurrent();
  setToolbarMode("none");
  rich.innerHTML = "";
  placeholder.textContent = text;
  setActivePane("placeholder");
}

// ---- diff view options + in-editor toolbar ------------------------------
function diffEditorOptions(): monaco.editor.IDiffEditorConstructionOptions {
  return {
    renderSideBySide: diffLayout === "sidebyside",
    // Honour the layout toggle regardless of pane width.
    useInlineViewWhenSpaceIsLimited: false,
    // Always show the full diff (no unchanged-region folding).
  };
}

function applyDiffOptions() {
  if (current && current instanceof Object && "updateOptions" in current) {
    (current as monaco.editor.IStandaloneDiffEditor).updateOptions?.(diffEditorOptions());
  }
}

const ICON = {
  sideBySide: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="5.5" height="11" rx="1"/><rect x="9" y="2.5" width="5.5" height="11" rx="1"/></svg>`,
  inline: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><line x1="4" y1="6" x2="12" y2="6"/><line x1="4" y1="10" x2="12" y2="10"/></svg>`,
  save: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 2.5h7.5L13.5 5.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M5 2.5v3.5h5V2.5"/><rect x="4.5" y="9" width="7" height="4.5"/></svg>`,
};

// The toolbar overlay is shared by Diff (layout toggle) and Edit (save). At most
// one button is visible at a time; "none" hides the whole bar.
type ToolbarMode = "diff" | "edit" | "none";
let toolbar: HTMLElement | null = null;
let layoutBtn: HTMLButtonElement | null = null;
let saveBtn: HTMLButtonElement | null = null;

function buildToolbar() {
  const style = document.createElement("style");
  style.textContent = `
    #toolbar {
      position: absolute; top: 6px; right: 16px; z-index: 10;
      display: none; gap: 4px;
    }
    #toolbar button {
      width: 26px; height: 24px; display: inline-flex;
      align-items: center; justify-content: center;
      border: none; border-radius: 5px; cursor: pointer;
      color: var(--tb-fg, #cfcfcf);
      background: var(--tb-bg, rgba(120,120,120,0.16));
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      transition: background 0.12s, color 0.12s;
    }
    #toolbar button:hover { background: var(--tb-hover, rgba(120,120,120,0.32)); }
    #toolbar button.active {
      color: var(--tb-active-fg, #ffffff);
      background: var(--tb-active-bg, rgba(10,132,255,0.85));
    }
    #toolbar button:disabled { opacity: 0.4; cursor: default; }
    #toolbar button:disabled:hover { background: var(--tb-bg, rgba(120,120,120,0.16)); }
    @media (prefers-color-scheme: light) {
      #toolbar button { --tb-fg:#444; --tb-bg:rgba(0,0,0,0.06); --tb-hover:rgba(0,0,0,0.12); --tb-active-fg:#fff; }
    }
  `;
  document.head.appendChild(style);

  toolbar = document.createElement("div");
  toolbar.id = "toolbar";

  layoutBtn = document.createElement("button");
  layoutBtn.addEventListener("click", () => {
    diffLayout = diffLayout === "sidebyside" ? "inline" : "sidebyside";
    applyDiffOptions();
    updateToolbarUI();
  });

  saveBtn = document.createElement("button");
  saveBtn.innerHTML = ICON.save;
  saveBtn.title = t.save;
  saveBtn.disabled = true;
  saveBtn.addEventListener("click", () => requestSave());

  toolbar.append(layoutBtn, saveBtn);
  document.body.appendChild(toolbar);
}

function updateToolbarUI() {
  if (!layoutBtn) return;
  // The layout button shows the layout it will switch *to*.
  const goingToInline = diffLayout === "sidebyside";
  layoutBtn.innerHTML = goingToInline ? ICON.inline : ICON.sideBySide;
  layoutBtn.title = goingToInline ? t.switchToInline : t.switchToSideBySide;
}

function setToolbarMode(mode: ToolbarMode) {
  if (!toolbar) return;
  if (mode === "none") {
    toolbar.style.display = "none";
    return;
  }
  toolbar.style.display = "flex";
  if (layoutBtn) layoutBtn.style.display = mode === "diff" ? "inline-flex" : "none";
  if (saveBtn) saveBtn.style.display = mode === "edit" ? "inline-flex" : "none";
}

interface DiffArgs {
  path: string;
  language?: string;
  original: string; // destination (current file on disk)
  modified: string; // target (chezmoi cat)
}
async function showDiff(args: DiffArgs) {
  disposeCurrent();
  const gen = showGeneration;
  const lang = detectLanguage(args.path, args.language, args.modified || args.original);
  const name = baseName(args.path);
  const [original, modified] = await Promise.all([
    makeModel(args.original, lang, `original-${name}`),
    makeModel(args.modified, lang, `modified-${name}`),
  ]);
  if (gen !== showGeneration) {
    // A newer show()/clear() superseded us while resolving models.
    original.dispose();
    modified.dispose();
    return;
  }
  setActivePane("editor");
  const editor = monaco.editor.createDiffEditor(root, {
    theme: currentTheme(),
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    // Read-only diff: hide the per-hunk gutter menu (only offers Revert).
    renderGutterMenu: false,
    fontSize: 12,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    ...diffEditorOptions(),
  });
  editor.setModel({ original: original.model, modified: modified.model });
  current = editor as any;
  currentDisposers.push(original.dispose, modified.dispose);
  updateToolbarUI();
  setToolbarMode("diff");
}

interface SourceArgs {
  path: string;
  language?: string;
  content: string;
  readOnly?: boolean;
}
async function showSource(args: SourceArgs) {
  disposeCurrent();
  const gen = showGeneration;
  // The Edit tab shows the raw source. For templates that's the base language
  // (json/yaml/…) with Go-template `{{ … }}` actions; the injectTo grammar
  // overlays those automatically, so no special "gotmpl" handling is needed.
  const lang = detectLanguage(args.path, args.language, args.content);
  const readOnly = args.readOnly ?? true;
  const m = await makeModel(args.content, lang, baseName(args.path));
  if (gen !== showGeneration) {
    m.dispose();
    return;
  }
  setActivePane("editor");
  const editor = monaco.editor.create(root, {
    model: m.model,
    theme: currentTheme(),
    automaticLayout: true,
    readOnly,
    fontSize: 12,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
  });
  current = editor as any;
  currentDisposers.push(m.dispose);
  srcEditor = editor;
  srcCleanValue = args.content;
  srcDirty = false;
  if (readOnly) {
    setToolbarMode("none");
    return;
  }
  // Editable: track dirty state, expose Cmd-S, and show the save button.
  editor.onDidChangeModelContent(() => updateDirty());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => requestSave());
  if (saveBtn) saveBtn.disabled = true;
  setToolbarMode("edit");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!
  );
}

/** Split leading YAML frontmatter (`---\n…\n---`) from the markdown body. */
function splitFrontmatter(src: string): {
  data: Record<string, unknown> | null;
  body: string;
} {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: null, body: src };
  try {
    const data = yaml.load(m[1]);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return { data: data as Record<string, unknown>, body: src.slice(m[0].length) };
    }
  } catch {
    // Malformed YAML — fall through and render the whole thing as markdown.
  }
  return { data: null, body: src };
}

function formatFmValue(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(formatFmValue).join(", ");
  if (typeof v === "object") {
    return `<code>${escapeHtml(JSON.stringify(v))}</code>`;
  }
  return escapeHtml(String(v));
}

function renderFrontmatterTable(data: Record<string, unknown>): string {
  const rows = Object.entries(data)
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${formatFmValue(v)}</td></tr>`)
    .join("");
  if (!rows) return "";
  return `<table class="frontmatter"><tbody>${rows}</tbody></table>`;
}

interface RichArgs {
  path: string;
  markdown: string;
}
function showRich(args: RichArgs) {
  disposeCurrent();
  setToolbarMode("none");
  const { data, body } = splitFrontmatter(args.markdown);
  const fm = data ? renderFrontmatterTable(data) : "";
  rich.innerHTML = `<div class="md-body">${fm}${md.render(body)}</div>`;
  rich.scrollTop = 0;
  setActivePane("rich");
}

interface ImageArgs {
  path: string;
  dataUri: string;
}
function showImage(args: ImageArgs) {
  disposeCurrent();
  setToolbarMode("none");
  const safeAlt = args.path.replace(/"/g, "&quot;");
  rich.innerHTML = `<div class="img-wrap"><img src="${args.dataUri}" alt="${safeAlt}" /></div>`;
  rich.scrollTop = 0;
  setActivePane("rich");
}

function injectRichStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .md-body {
      max-width: 820px; margin: 0 auto; padding: 24px 28px 64px;
      font: 14px/1.65 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      word-wrap: break-word;
    }
    .md-body h1, .md-body h2 { border-bottom: 1px solid rgba(128,128,128,0.25); padding-bottom: .3em; }
    .md-body h1 { font-size: 1.8em; } .md-body h2 { font-size: 1.4em; }
    .md-body h3 { font-size: 1.2em; }
    .md-body code {
      font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
      background: rgba(128,128,128,0.16); padding: .15em .4em; border-radius: 4px;
    }
    .md-body pre {
      background: rgba(128,128,128,0.12); padding: 12px 14px; border-radius: 8px;
      overflow: auto;
    }
    .md-body pre code { background: none; padding: 0; }
    .md-body blockquote {
      margin: 0; padding: 0 1em; color: #8a8a8a;
      border-left: 3px solid rgba(128,128,128,0.4);
    }
    .md-body table { border-collapse: collapse; }
    .md-body th, .md-body td { border: 1px solid rgba(128,128,128,0.3); padding: 6px 12px; }
    .md-body table.frontmatter {
      width: 100%; margin: 0 0 22px; font-size: 13px;
      background: rgba(128,128,128,0.07);
      border-collapse: separate; border-spacing: 0;
      border: 1px solid rgba(128,128,128,0.2);
      border-radius: 8px; overflow: hidden;
    }
    .md-body table.frontmatter th,
    .md-body table.frontmatter td {
      border: none;
      border-bottom: 1px solid rgba(128,128,128,0.16);
      padding: 6px 12px;
    }
    .md-body table.frontmatter tr:last-child th,
    .md-body table.frontmatter tr:last-child td { border-bottom: none; }
    .md-body table.frontmatter th {
      text-align: left; white-space: nowrap; vertical-align: top;
      width: 1%; color: #8a8a8a; font-weight: 600;
    }
    .md-body table.frontmatter td { width: 100%; }
    .md-body table.frontmatter code { background: rgba(128,128,128,0.16); }
    .md-body a { color: #2f7bd6; text-decoration: none; }
    .md-body img { max-width: 100%; }
    .img-wrap {
      min-height: 100%; display: flex; align-items: center; justify-content: center;
      padding: 24px; box-sizing: border-box;
    }
    .img-wrap img {
      max-width: 100%; max-height: 100%;
      box-shadow: 0 1px 8px rgba(0,0,0,0.2); border-radius: 4px;
    }
  `;
  document.head.appendChild(style);
}

// ---- public API consumed by the native side -----------------------------
(window as any).chezgui = {
  showDiff,
  showSource,
  showRich,
  showImage,
  setTheme,
  requestSave,
  markSaved,
  getEditorContent,
  clear: showPlaceholder,
};

// ---- bootstrap ----------------------------------------------------------
// Register the Go-template injection (+ toml) extension, bring up the VS Code
// services, then signal `ready`. The native side buffers all commands until
// then, so editors are only created once tokenization + themes are available.
async function bootstrap() {
  const ext = registerExtension(
    {
      name: "chezgui-grammars",
      publisher: "chezgui",
      version: "0.0.0",
      engines: { vscode: "*" },
      contributes: {
        languages: [
          { id: "toml", extensions: [".toml"] },
          { id: "go-template", extensions: [".gotmpl"] },
          { id: "viml", extensions: [".vim", ".vimrc"], filenames: [".vimrc", ".gvimrc", "vimrc", "gvimrc"] },
          { id: "ignore", filenames: [".chezmoiignore", ".chezmoiremove", ".gitignore"] },
        ],
        grammars: [
          { language: "toml", scopeName: "source.toml", path: "./toml.tmLanguage.json" },
          { language: "go-template", scopeName: "source.go-template", path: "./go-template.tmLanguage.json" },
          { language: "viml", scopeName: "source.viml", path: "./viml.tmLanguage.json" },
          { language: "ignore", scopeName: "source.ignore", path: "./ignore.tmLanguage.json" },
          {
            // Overlay Go-template `{{ … }}` onto these base scopes, INCLUDING
            // inside their string tokens (the chezmoi *.tmpl requirement).
            scopeName: "text.injection.go-template",
            path: "./injection.go-template.tmLanguage.json",
            injectTo: [
              "source.json", "source.yaml", "source.toml", "source.ini", "source.shell",
              "source.python", "source.ruby", "source.lua", "source.rust", "source.go",
              "source.js", "source.ts", "source.perl", "text.xml", "text.html.basic", "source.css",
              "source.viml", "source.ignore",
            ],
            embeddedLanguages: { "meta.embedded.go-template": "go-template" },
          },
        ],
        themes: [
          { id: "chezgui-default-light", label: "Default Light", uiTheme: "vs", path: "./light_vs.json" },
          { id: "chezgui-default-dark", label: "Default Dark", uiTheme: "vs-dark", path: "./dark_vs.json" },
          { id: "chezgui-solarized-light", label: "Solarized Light", uiTheme: "vs", path: "./solarized-light.json" },
          { id: "chezgui-solarized-dark", label: "Solarized Dark", uiTheme: "vs-dark", path: "./solarized-dark.json" },
        ],
      },
    },
    ExtensionHostKind.LocalProcess,
    { system: true } as any
  ) as any;
  ext.registerFileUrl("./toml.tmLanguage.json", new URL(tomlGrammarUrl, import.meta.url).toString());
  ext.registerFileUrl("./injection.go-template.tmLanguage.json", new URL(injectionGrammarUrl, import.meta.url).toString());
  ext.registerFileUrl("./go-template.tmLanguage.json", new URL(goTemplateGrammarUrl, import.meta.url).toString());
  ext.registerFileUrl("./viml.tmLanguage.json", new URL(vimlGrammarUrl, import.meta.url).toString());
  ext.registerFileUrl("./ignore.tmLanguage.json", new URL(ignoreGrammarUrl, import.meta.url).toString());
  ext.registerFileUrl("./light_vs.json", new URL(defaultLightThemeUrl, import.meta.url).toString());
  ext.registerFileUrl("./dark_vs.json", new URL(defaultDarkThemeUrl, import.meta.url).toString());
  ext.registerFileUrl("./solarized-light.json", new URL(solarizedLightThemeUrl, import.meta.url).toString());
  ext.registerFileUrl("./solarized-dark.json", new URL(solarizedDarkThemeUrl, import.meta.url).toString());

  // Synchronous (main-thread) TextMate tokenization + our initial theme. Set
  // before initialize so there's no flash / no attempt to load another default.
  await initUserConfiguration(
    JSON.stringify({
      "editor.experimental.asyncTokenization": false,
      "workbench.colorTheme": currentTheme(),
    })
  );

  await initialize({
    ...getFileServiceOverride(),
    ...getExtensionServiceOverride(),
    ...getModelServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getTextMateServiceOverride(),
    ...getThemeServiceOverride(),
  });

  // Back editor buffers with an in-memory filesystem so models can be held via
  // references (see makeModel) instead of being auto-disposed when unreferenced.
  fsProvider = new RegisteredFileSystemProvider(false);
  registerFileSystemOverlay(1, fsProvider);

  await Promise.all([
    ext.whenReady?.(),
    jsonReady,
    yamlReady,
    iniReady,
    shellReady,
    markdownReady,
    pythonReady,
    rubyReady,
    luaReady,
    rustReady,
    goReady,
    jsReady,
    tsReady,
    perlReady,
    xmlReady,
    htmlReady,
    cssReady,
  ]);

  // Warm the TextMate service so the first editor highlights immediately.
  try {
    const tm = await getService(ITextMateTokenizationService);
    await tm.createTokenizer("json");
  } catch {
    /* best-effort */
  }

  applyTheme();
  buildToolbar();
  injectRichStyles();
  applyBodyBg();
  postNative({ type: "ready" });
}

void bootstrap();
