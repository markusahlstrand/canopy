// Bundles the extension host (Node side) into a single CommonJS file. `vscode` is
// provided by the runtime, so it stays external. The webview is built separately
// by Vite (see vite.config.ts).
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild] watching extension host…");
} else {
  await esbuild.build(options);
}
