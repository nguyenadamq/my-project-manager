import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: "autoUpdate",
    manifest: {
      name: "Project Manager", short_name: "PM", description: "Manage local projects and AI prompt queues",
      theme_color: "#101c19", background_color: "#f3f0e8", display: "standalone", start_url: "/",
      icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
    },
  })],
  server: { port: 4173, proxy: { "/api": "http://127.0.0.1:4174", "/ws": { target: "ws://127.0.0.1:4174", ws: true } } },
});
