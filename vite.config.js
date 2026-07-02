import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During `vite dev` the React app runs on Vite's dev server while the
// serverless function is served by `vercel dev`. Running `vercel dev` alone
// serves both together, so no proxy is needed there. This config is the
// minimal React setup; Vercel builds the static site from `dist/`.
export default defineConfig({
  plugins: [react()],
  // Stamp the deployed commit into the bundle (Vercel sets VERCEL_GIT_COMMIT_SHA at
  // build time) so the UI can show which build the browser is actually running —
  // ends the "is this the new version or a cached bundle?" guessing game.
  define: {
    __BUILD_SHA__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7)),
  },
});
