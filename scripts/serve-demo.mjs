// Serves store-assets/demo-page over loopback for the store screenshots. Loopback is a permitted
// Allow Site host (see shared/allow-sites.ts), so the widget runs here without a TLS certificate.
//
// With a preview bundle (see shoot.mjs) the server also answers /preview.js and injects it into
// the page for requests carrying ?state=. The injection is server-side so the checked-in page
// stays a plain business page: what the extension renders on it must not be baked into it.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("../store-assets/demo-page/", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

export function startServer({ port = 8100, previewJs = null } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    // normalize() before join() so a "../" in the request cannot climb out of the demo directory.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");

    if (previewJs && rel === "/preview.js") {
      res.writeHead(200, { "Content-Type": TYPES[".js"] });
      res.end(await readFile(previewJs));
      return;
    }

    const file = join(ROOT, rel.endsWith("/") ? `${rel}index.html` : rel);
    try {
      let body = await readFile(file);
      if (previewJs && url.searchParams.has("state") && extname(file) === ".html") {
        body = body
          .toString()
          .replace("</body>", `<script src="/preview.js"></script>\n</body>`);
      }
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// Run directly (`npm run demo`) rather than imported by shoot.mjs.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 8100);
  await startServer({ port });
  console.log(`Demo page: http://localhost:${port}/ — add "localhost" under Allow Sites`);
}
