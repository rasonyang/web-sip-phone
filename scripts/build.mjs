import { build } from "esbuild";
import { cpSync, readFileSync, rmSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const define = { __SIPJS_REF__: JSON.stringify(pkg.dependencies["sip.js"]) };
const common = { bundle: true, target: "chrome116", outdir: "dist", define, logLevel: "info" };

rmSync("dist", { recursive: true, force: true });

// Extension pages and the service worker are ES modules.
await build({
  ...common,
  format: "esm",
  entryPoints: [
    { in: "src/background/service-worker.ts", out: "service-worker" },
    { in: "src/offscreen/offscreen.ts", out: "offscreen" },
    { in: "src/options/options.ts", out: "options" }
  ]
});

// Content scripts cannot be modules: bundle as IIFE.
await build({ ...common, format: "iife", entryPoints: [{ in: "src/content/index.ts", out: "content" }] });

cpSync("static", "dist", { recursive: true });
console.log("Built dist/");
