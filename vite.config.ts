import { copyFileSync, createReadStream, mkdirSync } from "node:fs";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Mounts the API endpoints inside the Vite dev server, so `npm run dev`
// runs front and back in one process, with hot reload of the server code too.
// Production uses server/index.ts.
function pandaApi(): Plugin {
  return {
    name: "panda-api",
    configureServer(server) {
      server.middlewares.use("/api/ask", (req, res, next) => {
        server
          .ssrLoadModule("/server/ask.ts")
          .then((mod) => (mod as typeof import("./server/ask")).handleAsk(req, res))
          .catch(next);
      });
      server.middlewares.use("/api/tts", (req, res, next) => {
        server
          .ssrLoadModule("/server/tts.ts")
          .then((mod) => (mod as typeof import("./server/tts")).handleTts(req, res))
          .catch(next);
      });
    },
  };
}

/**
 * Serves Whisper's runtime from this site instead of its default CDN. Copied from
 * the installed package, so it always matches the library's version.
 */
function ortRuntime(): Plugin {
  const from = "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist";
  const types: Record<string, string> = {
    "ort-wasm-simd-threaded.asyncify.mjs": "text/javascript",
    "ort-wasm-simd-threaded.asyncify.wasm": "application/wasm",
  };
  return {
    name: "ort-runtime",
    buildStart() {
      mkdirSync("public/ort", { recursive: true });
      for (const file of Object.keys(types)) copyFileSync(`${from}/${file}`, `public/ort/${file}`);
    },
    // The dev server refuses to run a file from public/ as a module, so it gets these directly.
    configureServer(server) {
      server.middlewares.use("/ort", (req, res, next) => {
        const file = req.url?.split("?")[0].slice(1) ?? "";
        if (!types[file]) return next();
        res.setHeader("Content-Type", types[file]);
        createReadStream(`${from}/${file}`).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pandaApi(), ortRuntime()],
  // The 3D scene chunk is mostly three.js and is already lazy-loaded behind the UI.
  // Whisper loads on demand for free on-device speech-to-text (works in mainland China).
  build: { chunkSizeWarningLimit: 1200 },
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
