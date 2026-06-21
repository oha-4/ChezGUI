import { defineConfig } from "vite";

// base must be relative so the bundle loads under the custom `app://` scheme
// served by the macOS app (WKURLSchemeHandler) as well as `vite preview`.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Monaco ships large chunks; silence the size warning.
    chunkSizeWarningLimit: 4096,
  },
  worker: {
    format: "es",
  },
});
