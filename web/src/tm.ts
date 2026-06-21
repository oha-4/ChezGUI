// TextMate-based highlighting for chezmoi `*.tmpl` source files.
//
// The Edit tab shows the *raw* template source, which is a base config language
// (json/yaml/toml/ini/shell) with Go-template `{{ ... }}` actions woven in. To
// highlight BOTH at once we use real TextMate grammars (via vscode-textmate +
// the oniguruma WASM regex engine) and an *injection* grammar whose selector is
// `L:*`, so it overlays `{{ ... }}` onto whatever base grammar is loaded.
//
// We deliberately do NOT replace Monaco's theme system (no Shiki). Instead each
// token's deepest TextMate scope (e.g. `string.quoted.double.json`) is handed to
// Monaco as the token type; Monaco's theme matcher prefix-matches it against the
// active palette's rules (`string`, `keyword`, …), so the existing
// monaco-themes palettes colour it for free.
import * as monaco from "monaco-editor";
import { loadWASM, OnigScanner, OnigString } from "vscode-oniguruma";
import {
  Registry,
  INITIAL,
  type IGrammar,
  type IRawGrammar,
  type StateStack,
} from "vscode-textmate";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";

import jsonGrammar from "./grammars/json.tmLanguage.json";
import yamlGrammar from "./grammars/yaml.tmLanguage.json";
import tomlGrammar from "./grammars/toml.tmLanguage.json";
import iniGrammar from "./grammars/ini.tmLanguage.json";
import shellGrammar from "./grammars/shellscript.tmLanguage.json";
import injectionGrammar from "./grammars/injection.go-template.tmLanguage.json";
import goTemplateGrammar from "./grammars/go-template.tmLanguage.json";

const INJECTION_SCOPE = "text.injection.go-template";

/** Monaco base-language id (from detectLanguage) -> TextMate base scope. */
const BASE_SCOPE: Record<string, string> = {
  json: "source.json",
  yaml: "source.yaml",
  toml: "source.toml",
  ini: "source.ini",
  shell: "source.shell",
};

/** Every grammar the registry might be asked to resolve, keyed by scope name. */
const GRAMMARS: Record<string, unknown> = {
  "source.json": jsonGrammar,
  "source.yaml": yamlGrammar,
  "source.toml": tomlGrammar,
  "source.ini": iniGrammar,
  "source.shell": shellGrammar,
  "text.injection.go-template": injectionGrammar,
  "source.go-template": goTemplateGrammar,
};

const BASE_SCOPES = new Set(Object.values(BASE_SCOPE));

let registryPromise: Promise<Registry> | null = null;
function getRegistry(): Promise<Registry> {
  if (!registryPromise) {
    registryPromise = (async () => {
      // oniguruma's loadWASM may only be called once per page. Pass the raw
      // bytes (not a streaming Response) so it doesn't depend on the wasm MIME
      // type the app:// scheme handler returns.
      const bytes = await (await fetch(onigWasmUrl)).arrayBuffer();
      await loadWASM(bytes);
      return new Registry({
        onigLib: Promise.resolve({
          createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
          createOnigString: (s: string) => new OnigString(s),
        }),
        loadGrammar: async (scope: string) =>
          (GRAMMARS[scope] as IRawGrammar | undefined) ?? null,
        // Overlay the Go-template injection onto every base language we load.
        getInjections: (scope: string) =>
          BASE_SCOPES.has(scope) ? [INJECTION_SCOPE] : [],
      });
    })();
  }
  return registryPromise;
}

/** Carries the TextMate rule stack across lines as a Monaco IState. */
class TMState implements monaco.languages.IState {
  constructor(public readonly ruleStack: StateStack) {}
  clone(): monaco.languages.IState {
    return new TMState(this.ruleStack);
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof TMState && other.ruleStack === this.ruleStack;
  }
}

// Map a TextMate scope to a Monaco *standard* token type. Monaco's built-in
// themes (vs / vs-dark, our "system" palette) only carry rules for these
// standard names — NOT for raw TextMate scopes like
// `support.type.property-name.json` — so we must translate, or keys/punctuation
// fall back to the default colour. The custom palettes (github/…) define the
// standard names too, so one mapping colours every theme uniformly. Rules are
// tried deepest-scope first; order matters (more specific patterns first).
const SCOPE_RULES: Array<[RegExp, string]> = [
  [/^comment/, "comment"],
  [/^punctuation\.definition\.comment/, "comment"],
  [/^constant\.numeric/, "number"],
  [/^constant\.language/, "keyword"], // true / false / null
  [/^constant\.character\.escape/, "string"],
  [/^constant/, "constant"],
  [/^(?:punctuation\.definition\.string|string)/, "string"],
  [/^keyword\.operator/, "operator"],
  [/^keyword/, "keyword"],
  [/^storage/, "keyword"],
  [/^entity\.name\.tag/, "tag"],
  [/^entity\.other\.attribute-name/, "attribute.name"],
  // Object keys: JSON `support.type.property-name`, YAML `entity.name.tag`.
  [/property-name/, "variable"],
  [/^(?:variable|support\.variable)/, "variable"],
  [/^(?:entity\.name|support\.type|support\.class|support\.function|storage\.type)/, "type"],
  [/^punctuation/, "delimiter"],
];

function scopeToMonacoToken(scopes: string[]): string {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i];
    for (const [re, token] of SCOPE_RULES) {
      if (re.test(scope)) return token;
    }
  }
  return "";
}

function makeTokensProvider(grammar: IGrammar): monaco.languages.TokensProvider {
  return {
    getInitialState: () => new TMState(INITIAL),
    tokenize(line, state) {
      const result = grammar.tokenizeLine(line, (state as TMState).ruleStack);
      const tokens = result.tokens.map((tk) => ({
        startIndex: tk.startIndex,
        scopes: scopeToMonacoToken(tk.scopes),
      }));
      return { tokens, endState: new TMState(result.ruleStack) };
    },
  };
}

const requested = new Set<string>();

/**
 * Ensure a Monaco language exists that highlights a `*.tmpl` whose underlying
 * type is `baseLang` (json/yaml/…) with Go-template injection, and return its
 * id. Registration of the actual tokenizer is async (the WASM engine loads
 * lazily); the id is returned synchronously so the editor can be created
 * immediately — Monaco re-tokenizes once the provider attaches. Returns null
 * for base languages we don't ship a grammar for (caller falls back).
 */
export function ensureTemplateLanguage(baseLang: string): string | null {
  const scope = BASE_SCOPE[baseLang];
  if (!scope) return null;
  const id = `gotmpl-${baseLang}`;
  if (!requested.has(id)) {
    requested.add(id);
    monaco.languages.register({ id });
    void (async () => {
      try {
        const registry = await getRegistry();
        const grammar = await registry.loadGrammar(scope);
        if (grammar) {
          monaco.languages.setTokensProvider(id, makeTokensProvider(grammar));
        }
      } catch (err) {
        // Highlighting is best-effort; on failure the editor stays plain.
        // eslint-disable-next-line no-console
        console.error("TextMate setup failed for", id, err);
      }
    })();
  }
  return id;
}
