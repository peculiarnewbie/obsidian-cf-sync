import { defineConfig } from "vite";
import builtinModules from "builtin-modules";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { copyFileSync, mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "dist");

export default defineConfig({
  plugins: [
    {
      name: "copy-obsidian-plugin-assets",
      writeBundle() {
        mkdirSync(outDir, { recursive: true });
        copyFileSync(resolve(__dirname, "../../manifest.json"), resolve(outDir, "manifest.json"));
        copyFileSync(resolve(__dirname, "styles.css"), resolve(outDir, "styles.css"));
      },
    },
  ],
  build: {
    lib: {
      entry: resolve(__dirname, "src/main.ts"),
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      external: [
        "obsidian",
        "electron",
        "@codemirror/autocomplete",
        "@codemirror/collab",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
        ...builtinModules,
      ],
      output: {
        exports: "default",
      },
    },
    minify: "esbuild",
    sourcemap: true,
    target: "es2018",
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
