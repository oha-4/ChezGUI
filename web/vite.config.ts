import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readdirSync } from "node:fs";

// All installed @codingame/* packages must be deduped so the monaco-vscode-api
// module graph (incl. the internal vscode-textmate at `_virtual/main`) stays a
// SINGLE copy. Without this, a dynamic import resolves to a duplicate whose
// namespace lacks `main` (=> "applyStateStackDiff of undefined" at runtime).
const codingame = readdirSync(resolve(__dirname, "node_modules/@codingame")).map(
  (n) => `@codingame/${n}`
);
const dedupe = ["vscode", "monaco-editor", "vscode-textmate", "vscode-oniguruma", ...codingame];

// monaco-vscode-api's background tokenizer does
//   import('@codingame/monaco-vscode-api/_virtual/main').then(n => n.main)
// In a vite build, rollup tree-shakes the target (seeing only `.main` used) to
// export just `main`, while vite's dynamic-import handling rewrites the consumer
// to destructure top-level props — the two disagree and `applyStateStackDiff`
// ends up undefined. Rewriting `.then(n => n.main)` to identity makes both agree
// on the top-level exports our shim (aliased below) provides.
const patchBackgroundTokenizer = {
  name: "patch-textmate-background-tokenizer",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (id.includes("textMateWorkerTokenizerController")) {
      const patched = code.replace(
        /\.then\(function\s*\(n\)\s*\{\s*return n\.main;\s*\}\)/g,
        ".then(function (n) { return n; })"
      );
      if (patched !== code) return { code: patched, map: null };
    }
    return null;
  },
};

// base must be relative so the bundle loads under the custom `app://` scheme.
export default defineConfig({
  base: "./",
  plugins: [patchBackgroundTokenizer],
  resolve: {
    alias: {
      // monaco-vscode-api ships its own monaco build; swap it in for monaco-editor.
      "monaco-editor": "@codingame/monaco-vscode-editor-api",
      // Shim the mis-compiled `_virtual/main` dynamic import (see plugin above).
      "@codingame/monaco-vscode-api/_virtual/main": resolve(__dirname, "src/shims/textmate-main.ts"),
    },
    dedupe,
  },
  esbuild: { minifySyntax: false },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    // esbuild minification breaks monaco-vscode-api's TextMate tokenization /
    // theme-colour path in WKWebView (tokens render but stay the default colour).
    // The app is bundled & served offline, so the larger output is fine.
    minify: false,
    // Monaco-vscode-api ships large chunks; silence the size warning.
    chunkSizeWarningLimit: 8192,
  },
});
