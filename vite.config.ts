import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Allow legacy non-VITE_-prefixed secrets from the Mastra `.env` to be
  // referenced via `import.meta.env`. Only acceptable for a local dev
  // tool — Vite bakes these into the client bundle at build time, so
  // every prefix listed here ships to the renderer process. Production
  // builds should route these calls through `next-server` instead.
  envPrefix: ["VITE_", "REPLICATE_", "ELEVENLABS_", "OPENAI_", "ANTHROPIC_"],
}));
