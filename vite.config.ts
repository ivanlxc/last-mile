import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  isUnityAssetRequest,
  unityAssetHeaders,
} from "./server/http/unity-assets.js";
export default defineConfig({
  root: "client",
  worker: { format: "es" },
  plugins: [
    react(),
    {
      name: "last-mile-unity-assets",
      configureServer(server) {
        // Runs before Vite's SPA fallback. Missing builds must return 404, and
        // Unity's explicit .gz/.br filenames need the same headers as production.
        server.middlewares.use((request, response, next) => {
          if (!isUnityAssetRequest(request.url ?? "")) return next();
          void (async () => {
            if (!["GET", "HEAD"].includes(request.method ?? "")) {
              response.writeHead(405).end();
              return;
            }
            const pathname = decodeURIComponent(request.url!.split("?")[0]!);
            const segments = pathname.slice("/unity/".length).split("/");
            if (
              segments.some(
                (part) =>
                  part.startsWith(".") ||
                  part.includes("\\") ||
                  part.includes("\0"),
              )
            ) {
              response.writeHead(404).end();
              return;
            }
            const root = await realpath(
              path.resolve(server.config.publicDir, "unity"),
            );
            const file = await realpath(path.resolve(root, ...segments));
            if (!file.startsWith(root + path.sep)) {
              response.writeHead(404).end();
              return;
            }
            const info = await stat(file);
            if (!info.isFile()) {
              response.writeHead(404).end();
              return;
            }
            response.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": info.size,
              ...unityAssetHeaders(file),
            });
            if (request.method === "HEAD") response.end();
            else
              createReadStream(file)
                .on("error", () => response.destroy())
                .pipe(response);
          })().catch(() => {
            if (!response.headersSent) response.writeHead(404).end();
            else response.destroy();
          });
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3111",
        changeOrigin: false,
        ws: true,
      },
    },
    fs: {
      strict: true,
      allow: [path.resolve("client"), path.resolve("node_modules")],
      deny: [
        ".env",
        ".env.*",
        "**/*.{crt,pem}",
        "**/server/**",
        "**/docs/**",
        "**/.last-mile/**",
        "**/assets/authoring/**",
        "**/archive/**",
        "**/.local-artifacts/**",
      ],
    },
  },
  build: {
    outDir: path.resolve("dist/client"),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: (id: string) =>
          id.includes("/three/") ? "three" : undefined,
      },
    },
  },
});
