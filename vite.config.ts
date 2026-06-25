import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    // In dev, proxy API calls to the local admin server (tools/admin-server.mjs)
    // so both the public views and the /admin panel work against live SQLite.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});