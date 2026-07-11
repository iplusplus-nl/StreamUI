import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function getAppCommit(): string {
  if (process.env.VITE_GIT_COMMIT?.trim()) {
    return process.env.VITE_GIT_COMMIT.trim();
  }

  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return "development";
  }
}

export default defineConfig({
  base: process.env.CHATHTML_BASE_PATH?.trim() || "/",
  plugins: [react()],
  define: {
    __APP_COMMIT__: JSON.stringify(getAppCommit())
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
