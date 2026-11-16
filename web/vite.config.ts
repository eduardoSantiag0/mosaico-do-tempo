import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Mobile camera access requires a secure context; use a tunnel (e.g. ngrok)
    // or `vite --host` plus a self-signed cert when testing on a real phone.
    host: true,
  },
  build: {
    target: "es2022",
  },
  worker: {
    format: "es",
  },
});
