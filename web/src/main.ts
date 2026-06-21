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

// Default VS Code extensions: each registers a language + TextMate grammar.
// (Side-effect imports; we await their `whenReady` below.)
import { whenReady as jsonReady } from "@codingame/monaco-vscode-json-default-extension";
import { whenReady as yamlReady } from "@codingame/monaco-vscode-yaml-default-extension";
import { whenReady as iniReady } from "@codingame/monaco-vscode-ini-default-extension";
import { whenReady as shellReady } from "@codingame/monaco-vscode-shellscript-default-extension";
import { whenReady as markdownReady } from "@codingame/monaco-vscode-markdown-basics-default-extension";

// Vendored grammars not shipped as VS Code builtins. `?url` => bundled as a
// relative asset, served over app:// offline.
import tomlGrammarUrl from "./grammars/toml.tmLanguage.json?url";
import injectionGrammarUrl from "./grammars/injection.go-template.tmLanguage.json?url";
import goTemplateGrammarUrl from "./grammars/go-template.tmLanguage.json?url";

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
  gitconfig: "ini",
  npmrc: "ini",
  editorconfig: "ini",
  inputrc: "ini",
  curlrc: "ini",
  wgetrc: "ini",
};
function detectLanguage(path: string, explicit?: string): string {
  if (explicit) return explicit;
  const base = (path.split("/").pop() ?? "").replace(/\.tmpl$/, "");
  // Normalize chezmoi source attributes + the leading dot so `.zshrc`,
  // `dot_zshrc`, `private_dot_zshrc` all resolve to the same name.
  const name = base
    .replace(/^(private_|readonly_|executable_|encrypted_|symlink_|literal_|exact_|empty_)*/, "")
    .replace(/^dot_/, "")
    .replace(/^\./, "")
    .toLowerCase();
  // Whole-name match first (rc files), then by extension.
  if (FILENAME_LANG[name]) return FILENAME_LANG[name];
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  return EXT_LANG[ext] ?? "plaintext";
}

// ---- rendering ----------------------------------------------------------
function disposeCurrent() {
  if (current) {
    const editor = current as monaco.editor.IStandaloneDiffEditor;
    const model = editor.getModel?.();
    if (model && "original" in model) {
      model.original?.dispose();
      model.modified?.dispose();
    } else {
      (current as monaco.editor.IStandaloneCodeEditor).getModel()?.dispose();
    }
    current.dispose();
    current = null;
  }
}

function showPlaceholder(text: string) {
  disposeCurrent();
  setToolbarVisible(false);
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
};

let toolbar: HTMLElement | null = null;
let layoutBtn: HTMLButtonElement | null = null;

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

  toolbar.append(layoutBtn);
  document.body.appendChild(toolbar);
}

function updateToolbarUI() {
  if (!layoutBtn) return;
  // The layout button shows the layout it will switch *to*.
  const goingToInline = diffLayout === "sidebyside";
  layoutBtn.innerHTML = goingToInline ? ICON.inline : ICON.sideBySide;
  layoutBtn.title = goingToInline ? t.switchToInline : t.switchToSideBySide;
}

function setToolbarVisible(visible: boolean) {
  if (!toolbar) return;
  toolbar.style.display = visible ? "flex" : "none";
}

interface DiffArgs {
  path: string;
  language?: string;
  original: string; // destination (current file on disk)
  modified: string; // target (chezmoi cat)
}
function showDiff(args: DiffArgs) {
  disposeCurrent();
  setActivePane("editor");
  const lang = detectLanguage(args.path, args.language);
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
  editor.setModel({
    original: monaco.editor.createModel(args.original, lang),
    modified: monaco.editor.createModel(args.modified, lang),
  });
  current = editor as any;
  updateToolbarUI();
  setToolbarVisible(true);
}

interface SourceArgs {
  path: string;
  language?: string;
  content: string;
  readOnly?: boolean;
}
function showSource(args: SourceArgs) {
  disposeCurrent();
  setToolbarVisible(false);
  setActivePane("editor");
  // The Edit tab shows the raw source. For templates that's the base language
  // (json/yaml/…) with Go-template `{{ … }}` actions; the injectTo grammar
  // overlays those automatically, so no special "gotmpl" handling is needed.
  const lang = detectLanguage(args.path, args.language);
  const editor = monaco.editor.create(root, {
    value: args.content,
    language: lang,
    theme: currentTheme(),
    automaticLayout: true,
    readOnly: args.readOnly ?? true,
    fontSize: 12,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
  });
  current = editor as any;
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
  setToolbarVisible(false);
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
  setToolbarVisible(false);
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
        ],
        grammars: [
          { language: "toml", scopeName: "source.toml", path: "./toml.tmLanguage.json" },
          { language: "go-template", scopeName: "source.go-template", path: "./go-template.tmLanguage.json" },
          {
            // Overlay Go-template `{{ … }}` onto these base scopes, INCLUDING
            // inside their string tokens (the chezmoi *.tmpl requirement).
            scopeName: "text.injection.go-template",
            path: "./injection.go-template.tmLanguage.json",
            injectTo: ["source.json", "source.yaml", "source.toml", "source.ini", "source.shell"],
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
    ...getExtensionServiceOverride(),
    ...getModelServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getTextMateServiceOverride(),
    ...getThemeServiceOverride(),
  });

  await Promise.all([
    ext.whenReady?.(),
    jsonReady,
    yamlReady,
    iniReady,
    shellReady,
    markdownReady,
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
