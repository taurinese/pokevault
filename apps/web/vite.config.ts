import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 3000 },
  // `sharp` est un addon natif (binaire par plateforme) : jamais inliné dans le bundle SSR,
  // chargé à l'exécution depuis `node_modules` (import dynamique de
  // `@pokevault/services/cover-image-sharp`, uniquement côté serveur).
  ssr: { external: ["sharp"] },
  plugins: [tanstackStart(), viteReact(), tailwindcss()],
});
