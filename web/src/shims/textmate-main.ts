// Shim for `@codingame/monaco-vscode-api/_virtual/main`.
//
// monaco-vscode-api's background tokenizer does:
//   const { applyStateStackDiff, INITIAL } =
//     await import('@codingame/monaco-vscode-api/_virtual/main').then(n => n.main)
// In a vite *production build* that `.then(n => n.main)` indirection gets
// mis-compiled into a top-level destructure, so the original module (which only
// exports `main`/`default`) yields `applyStateStackDiff === undefined`.
//
// We alias that specifier to this shim, which exposes the vscode-textmate API
// BOTH at the top level AND under `main` — so whichever shape the bundler emits,
// the destructure resolves.
import * as vscodeTextmate from "vscode-textmate";

export const applyStateStackDiff = vscodeTextmate.applyStateStackDiff;
export const INITIAL = vscodeTextmate.INITIAL;
export const main = vscodeTextmate;
export default vscodeTextmate;
