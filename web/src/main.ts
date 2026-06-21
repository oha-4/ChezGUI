import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import MarkdownIt from "markdown-it";
import yaml from "js-yaml";
import { ensureTemplateLanguage } from "./tm";

// Vendored monaco-themes (MIT) — only the few palettes we expose. Each is a
// single light *or* dark theme; we pair them in PALETTES below.
import githubLight from "./themes/github-light.json";
import githubDark from "./themes/github-dark.json";
import solarizedLight from "./themes/solarized-light.json";
import solarizedDark from "./themes/solarized-dark.json";
import tomorrow from "./themes/tomorrow.json";
import tomorrowNight from "./themes/tomorrow-night.json";
import clouds from "./themes/clouds.json";
import cloudsMidnight from "./themes/clouds-midnight.json";

// Monaco needs a worker for background tokenization/diffing. The generic
// editor worker covers diff + basic editing for all languages we care about
// (json, sh, toml, yaml, md, …). Language *services* (json schema validation
// etc.) are intentionally omitted to keep the bundle lean.
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

// ---- Go text/template language ------------------------------------------
// The Edit tab shows the *raw* chezmoi source, so a `*.tmpl` file is Go
// template syntax (not the rendered target). We highlight the `{{ ... }}`
// actions distinctly while still giving the surrounding literal text basic
// config-ish colouring (strings / numbers / booleans), which covers the common
// json/yaml/toml dotfiles. Diff/Rich keep their target-language highlighting
// since they show the rendered output.
monaco.languages.register({ id: "gotmpl" });
monaco.languages.setMonarchTokensProvider("gotmpl", {
  defaultToken: "",
  tokenizer: {
    root: [
      [/\{\{\/\*/, "comment", "@tmplComment"],
      [/\{\{-?/, { token: "delimiter.bracket", next: "@tmplAction" }],
      // Literal-text (the templated config) — light, generic colouring.
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/-?\b\d+(?:\.\d+)?\b/, "number"],
    ],
    tmplAction: [
      [/-?\}\}/, { token: "delimiter.bracket", next: "@pop" }],
      [
        /\b(?:if|else|end|range|with|template|define|block|break|continue|and|or|not|eq|ne|lt|le|gt|ge|len|index|slice|printf|print|println|html|js|urlquery|call|nil)\b/,
        "keyword",
      ],
      [/\$[A-Za-z_]\w*/, "variable"],
      [/\.[A-Za-z_][\w.]*/, "variable"],
      [/\./, "variable"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/`[^`]*`/, "string"],
      [/-?\b\d+(?:\.\d+)?\b/, "number"],
      [/\|/, "operator"],
      [/[=:]/, "operator"],
      [/[()]/, "delimiter.parenthesis"],
      [/,/, "delimiter"],
    ],
    tmplComment: [
      [/[^*]+/, "comment"],
      [/\*\/-?\}\}/, "comment", "@pop"],
      [/./, "comment"],
    ],
  },
});

const root = document.getElementById("root") as HTMLElement;
const rich = document.getElementById("rich") as HTMLElement;
const placeholder = document.getElementById("placeholder") as HTMLElement;

// Minimal i18n for the few strings the web side owns. Native-supplied text
// (placeholder/error messages pushed over the bridge) is already localized in
// Swift; this only covers strings rendered purely in the web layer.
const isJa = (navigator.language || "").toLowerCase().startsWith("ja");
const t = {
  noFileSelected: isJa ? "ファイルが選択されていません" : "No file selected",
  switchToInline: isJa ? "インライン差分に切り替え" : "Switch to inline diff",
  switchToSideBySide: isJa ? "サイドバイサイド差分に切り替え" : "Switch to side-by-side diff",
};
// Localize the initial placeholder (before the native side pushes anything).
placeholder.textContent = t.noFileSelected;

// Markdown renderer. html:false escapes raw HTML so rendering the user's own
// (but still untrusted-shaped) dotfiles can't inject script into the WebView.
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

/** Which of the three overlapping panes is visible. */
function setActivePane(pane: "editor" | "rich" | "placeholder") {
  root.style.display = pane === "editor" ? "block" : "none";
  rich.style.display = pane === "rich" ? "block" : "none";
  placeholder.style.display = pane === "placeholder" ? "flex" : "none";
}

type Disposable = { dispose(): void };
let current: (monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor) & Disposable | null = null;

// Diff layout preference (side-by-side vs inline), owned by the web side and
// driven by the in-editor icon toolbar (no native round-trip).
let diffLayout: "inline" | "sidebyside" = "sidebyside";

// ---- bridge to native (JS -> Swift) -------------------------------------
type BridgeMessage = { type: string; payload?: unknown };
function postNative(msg: BridgeMessage) {
  const handlers = (window as any).webkit?.messageHandlers;
  if (handlers?.bridge) {
    handlers.bridge.postMessage(msg);
  }
}

// ---- theme --------------------------------------------------------------
// Pairs only: every selectable palette is a {light, dark} pair that follows the
// OS appearance. Custom palettes are registered with Monaco here; "system" maps
// to Monaco's own vs / vs-dark. The native Settings UI picks the palette key and
// pushes it over the bridge (setTheme); the light/dark choice stays automatic.
type ThemePair = { light: string; dark: string };

const CUSTOM_THEMES: Record<string, monaco.editor.IStandaloneThemeData> = {
  "github-light": githubLight as unknown as monaco.editor.IStandaloneThemeData,
  "github-dark": githubDark as unknown as monaco.editor.IStandaloneThemeData,
  "solarized-light": solarizedLight as unknown as monaco.editor.IStandaloneThemeData,
  "solarized-dark": solarizedDark as unknown as monaco.editor.IStandaloneThemeData,
  tomorrow: tomorrow as unknown as monaco.editor.IStandaloneThemeData,
  "tomorrow-night": tomorrowNight as unknown as monaco.editor.IStandaloneThemeData,
  clouds: clouds as unknown as monaco.editor.IStandaloneThemeData,
  "clouds-midnight": cloudsMidnight as unknown as monaco.editor.IStandaloneThemeData,
};
for (const [name, data] of Object.entries(CUSTOM_THEMES)) {
  monaco.editor.defineTheme(name, data);
}

const PALETTES: Record<string, ThemePair> = {
  system: { light: "vs", dark: "vs-dark" },
  github: { light: "github-light", dark: "github-dark" },
  solarized: { light: "solarized-light", dark: "solarized-dark" },
  tomorrow: { light: "tomorrow", dark: "tomorrow-night" },
  clouds: { light: "clouds", dark: "clouds-midnight" },
};

// Page background behind Monaco, per concrete theme. The builtins carry no
// colours object, so seed defaults; custom themes bring their own.
const THEME_BG: Record<string, string> = { vs: "#ffffff", "vs-dark": "#1e1e1e" };
for (const [name, data] of Object.entries(CUSTOM_THEMES)) {
  const bg = data.colors?.["editor.background"];
  if (bg) THEME_BG[name] = bg;
}

// Selected palette key, driven from native Settings via setTheme().
let selectedPalette = "system";

function osIsDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
/** Concrete Monaco theme for the current palette + OS appearance. */
function currentTheme(): string {
  const pair = PALETTES[selectedPalette] ?? PALETTES.system;
  return osIsDark() ? pair.dark : pair.light;
}
function applyBodyBg() {
  const bg = THEME_BG[currentTheme()] ?? (osIsDark() ? "#1e1e1e" : "#ffffff");
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

window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", applyTheme);

// ---- language detection -------------------------------------------------
const EXT_LANG: Record<string, string> = {
  json: "json",
  jsonc: "json",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  lua: "lua",
  vim: "vim",
  py: "python",
  rb: "ruby",
  js: "javascript",
  ts: "typescript",
  go: "go",
  rs: "rust",
  conf: "ini",
  ini: "ini",
  gitconfig: "ini",
  xml: "xml",
  html: "html",
  css: "css",
};
function detectLanguage(path: string, explicit?: string): string {
  if (explicit) return explicit;
  const base = path.split("/").pop() ?? "";
  // strip chezmoi-ish suffixes that shouldn't affect highlighting
  const cleaned = base.replace(/\.tmpl$/, "");
  const ext = cleaned.includes(".")
    ? cleaned.split(".").pop()!.toLowerCase()
    : cleaned.replace(/^dot_/, "").toLowerCase();
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
    // Honour the layout toggle regardless of pane width (Monaco otherwise
    // auto-collapses to inline below ~900px).
    useInlineViewWhenSpaceIsLimited: false,
    // Always show the full diff (no unchanged-region folding) — keeps the view
    // simple and avoids the collapse flash / compactMode-vs-side-by-side issues.
  };
}

function applyDiffOptions() {
  if (current && current instanceof Object && "updateOptions" in current) {
    (current as monaco.editor.IStandaloneDiffEditor).updateOptions?.(
      diffEditorOptions()
    );
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
  let lang = detectLanguage(args.path, args.language);
  // Templates: the native side sends language "gotmpl". Highlight the raw
  // source as base-language + Go-template injection (TextMate). Fall back to the
  // template-only Monarch grammar for base types we don't ship a TM grammar for.
  if (args.language === "gotmpl") {
    const base = detectLanguage(args.path);
    lang = ensureTemplateLanguage(base) ?? "gotmpl";
  }
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
    .map(
      ([k, v]) =>
        `<tr><th>${escapeHtml(k)}</th><td>${formatFmValue(v)}</td></tr>`
    )
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
      /* separate (not collapse) so border-radius + overflow can clip corners */
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

buildToolbar();
injectRichStyles();
applyBodyBg();
postNative({ type: "ready" });
