import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During `vite dev` the React app runs on Vite's dev server while the
// serverless function is served by `vercel dev`. Running `vercel dev` alone
// serves both together, so no proxy is needed there. This config is the
// minimal React setup; Vercel builds the static site from `dist/`.
export default defineConfig({
  plugins: [react()],
});
