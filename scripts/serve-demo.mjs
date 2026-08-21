// Serves store-assets/demo-page over loopback for the store screenshots. Loopback is a permitted
// Allow Site host (see shared/config.ts), so the widget runs here without a TLS certificate.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("../store-assets/demo-page/", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8100);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  // normalize() before join() so a "../" in the request cannot climb out of the demo directory.
  const rel = normalize(decodeURIComponent(new URL(req.url, "http://localhost").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, rel.endsWith("/") ? `${rel}index.html` : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Demo page: http://localhost:${PORT}/ — add "localhost" under Allow Sites`);
});
