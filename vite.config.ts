import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync } from "node:fs";

export default defineConfig({
  plugins: [
    react(),
    {
      // Cloudflare Pages serves 404.html for any path that has no matching file,
      // which is exactly the SPA fallback we need. Copy index.html → 404.html
      // after each build so deep-links (/team/:id, /player/:id, /admin) work.
      name: "cloudflare-pages-spa-fallback",
      closeBundle() {
        copyFileSync("dist/index.html", "dist/404.html");
      },
    },
  ],
  server: {
    // In dev, proxy API calls to the local admin server (tools/admin-server.mjs)
    // so both the public views and the /admin panel work against live SQLite.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
