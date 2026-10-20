import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    tailwindcss(),
    cloudflare({
      persistState: { path: "../api/.wrangler/state" },
      viteEnvironment: { name: "ssr" },
      auxiliaryWorkers: [{ configPath: "../api/wrangler.jsonc" }],
    }),
    tanstackStart(),
    react(),
  ],
});
