import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.CLIENT_PORT ?? 5173), host: true },
  build: {
    target: "es2023",
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: "es" },
});
