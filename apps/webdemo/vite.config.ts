import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.CHATHTML_BASE_PATH?.trim() || "/",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/demo-service": {
        target: "http://127.0.0.1:8790",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/demo-service/, "")
      }
    }
  }
});
