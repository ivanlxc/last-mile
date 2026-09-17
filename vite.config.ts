import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3111", changeOrigin: false } },
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
