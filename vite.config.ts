import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves this repo from https://scottjahn.github.io/hwpl-manager/,
// so production builds are rooted at that sub-path. Dev stays at "/" so the
// local admin panel keeps working at http://localhost:5173/admin.
export default defineConfig(({ mode }) => ({
  base: mode === "production" ? "/hwpl-manager/" : "/",
  plugins: [react()],
  server: {
    // In dev, proxy API calls to the local admin server (tools/admin-server.mjs)
    // so both the public views and the /admin panel work against live SQLite.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
}));
