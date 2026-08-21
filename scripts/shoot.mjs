// Re-takes Chrome Web Store screenshots 1-3 from source: bundles the preview harness, serves the
// demo page, and drives headless Chrome over CDP to capture it at exactly 1280x800.
//
// CDP by hand rather than a browser-automation dependency: this runs a few times a year, and a
// ~300MB devDependency to do it would cost more than it saves. Node's global WebSocket is enough.
// (Chrome's old --screenshot flag is not an option — it belonged to the old headless mode, which
// was removed in Chrome 132.)
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "./serve-demo.mjs";

const PORT = Number(process.env.PORT ?? 8123);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const VIEWPORT = { width: 1280, height: 800 };
const SHOTS = [
  { state: "ready", out: "store-assets/1-ready-green.png" },
  { state: "panel", out: "store-assets/2-status-panel.png" },
  { state: "call", out: "store-assets/3-on-a-call.png" }
];

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error(`No Chrome found. Set CHROME=/path/to/chrome. Looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
  process.exit(1);
}

/** Minimal CDP client: one socket, id-matched replies, flat sessions. */
class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();

  static async connect(url) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url);
    cdp.#ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const waiter = cdp.#pending.get(msg.id);
      if (waiter) {
        cdp.#pending.delete(msg.id);
        msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
      }
    });
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener("open", resolve, { once: true });
      cdp.#ws.addEventListener("error", () => reject(new Error(`CDP connect failed: ${url}`)), { once: true });
    });
    return cdp;
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  close() {
    this.#ws.close();
  }
}

async function browserWsUrl() {
  // Chrome needs a moment to write the DevTools endpoint; poll rather than guess a sleep.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await delay(200);
    }
  }
  throw new Error(`Chrome never opened its DevTools endpoint on port ${CDP_PORT}`);
}

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const work = mkdtempSync(join(tmpdir(), "wsp-shoot-"));
const previewJs = join(work, "preview.js");

await build({
  entryPoints: ["scripts/screenshot-preview.ts"],
  outfile: previewJs,
  bundle: true,
  format: "iife",
  target: "chrome116",
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: "warning"
});

const server = await startServer({ port: PORT, previewJs });
// A throwaway profile: never touch the user's own Chrome profile.
const chrome = spawn(
  chromePath,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(work, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

try {
  const cdp = await Cdp.connect(await browserWsUrl());
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, sessionId);

  for (const shot of SHOTS) {
    await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/?state=${shot.state}` }, sessionId);
    // The harness stamps the root element once fonts are loaded and the widget has rendered,
    // so a slow font load can never land mid-render in the PNG.
    for (let i = 0; ; i++) {
      const { result } = await cdp.send(
        "Runtime.evaluate",
        { expression: `document.documentElement.getAttribute("data-preview-ready")`, returnByValue: true },
        sessionId
      );
      if (result.value === shot.state) {
        break;
      }
      if (i > 100) {
        throw new Error(`Preview "${shot.state}" never signalled ready`);
      }
      await delay(100);
    }
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(shot.out, Buffer.from(data, "base64"));
    console.log(`Wrote ${shot.out}`);
  }
  cdp.close();
} finally {
  chrome.kill();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
