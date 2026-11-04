import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { handleAsk } from "./ask.js";

// Production server: serves the built app from dist/ and the /api/ask endpoint.
// In development, vite.config.ts mounts the same handler instead.

const DIST = resolve("dist");
const PORT = Number(process.env.PORT) || 8787;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/ask") return handleAsk(req, res);

  // Resolve inside dist/ only, falling back to index.html.
  const requested = normalize(join(DIST, decodeURIComponent(url.pathname)));
  let file = requested.startsWith(DIST) ? requested : join(DIST, "index.html");
  try {
    if (!(await stat(file)).isFile()) file = join(DIST, "index.html");
  } catch {
    file = join(DIST, "index.html");
  }

  try {
    const content = await readFile(file);
    const headers = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Accept-Ranges": "bytes" };
    // Browsers stream and loop <video> through range requests; without them the clip can stall at the wrap.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const size = content.length;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      res.end(content.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": content.length });
    res.end(content);
  } catch {
    res.writeHead(404).end("Not found. Did you run `npm run build`?");
  }
}).listen(PORT, () => {
  console.log(`Panda avatar running on http://localhost:${PORT}`);
});
