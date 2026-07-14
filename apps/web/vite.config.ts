import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveBuildRevision } from "./server/buildRevision.js";

const appCommit = resolveBuildRevision({
  env: process.env,
  readGitCommit: () =>
    execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8"
    })
});

export default defineConfig({
  base: process.env.CHATHTML_BASE_PATH?.trim() || "/",
  plugins: [react()],
  define: {
    __APP_COMMIT__: JSON.stringify(appCommit)
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (!normalizedId.includes("/node_modules/")) {
            return undefined;
          }
          if (normalizedId.includes("/node_modules/@assistant-ui/")) {
            return "assistant-ui";
          }
          if (
            /\/node_modules\/(?:react|react-dom|scheduler)\//.test(
              normalizedId
            )
          ) {
            return "react-vendor";
          }
          if (normalizedId.includes("/node_modules/lucide-react/")) {
            return "icons";
          }
          if (
            /\/node_modules\/(?:dom-to-svg|postcss|postcss-value-parser|source-map-js)\//.test(
              normalizedId
            )
          ) {
            return "artifact-export";
          }
          return "vendor";
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  }
});
