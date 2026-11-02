import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Mounts the /api/ask endpoint inside the Vite dev server, so `npm run dev`
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
    },
  };
}

export default defineConfig({
  plugins: [react(), pandaApi()],
  // The 3D scene chunk is mostly three.js and is already lazy-loaded behind the UI.
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
