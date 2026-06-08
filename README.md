# FRONTAGE — Retail Deal Screener

Upload a retail offering memorandum (PDF or pasted text) and the app calls Claude
to extract underwriting data, break out the tenant roster by lease expiration and
credit quality, recompute the deal's own math, and score it against a trophy-retail
buy box.

The Anthropic API call runs in a **Vercel serverless function** (`api/screen.js`)
so the API key is **server-side only** — it never reaches the browser or the
client bundle.

## Stack

- **Frontend:** Vite + React (`src/`), single-page app.
- **Backend:** one Vercel serverless function (`api/screen.js`) that holds the key
  and calls the Anthropic Messages API (model `claude-sonnet-4-6`).
- No database, no auth.

## Local development

The `/api` function only runs under the Vercel CLI, so use `vercel dev` (not
`npm run dev`) to exercise the full flow locally.

```bash
npm install
# Put your real key in .env.local (already gitignored):
#   ANTHROPIC_API_KEY=sk-ant-...
npm i -g vercel        # if you don't have the CLI
vercel dev             # serves the React app + /api/screen together
```

Then open the printed localhost URL and:

1. Click **✦ TRY SAMPLE DEAL → Screen this deal** — you should get a full rendered
   result (metrics, math reconciliation, buy-box score, tenant roster).
2. Switch to **UPLOAD PDF** and try a real retail OM PDF.

> Plain `npm run dev` runs only the React frontend — `/api/screen` will 404.
> Use `vercel dev`.

## Deploy to Vercel

1. `git init && git add . && git commit -m "FRONTAGE"` — confirm `.env.local` is
   **not** staged (it's gitignored). Push to a new GitHub repo.
2. Import the repo at [vercel.com](https://vercel.com). Vercel auto-detects Vite
   (build: `vite build`, output: `dist/`) and the `api/` function.
3. In the Vercel project → **Settings → Environment Variables**, add
   `ANTHROPIC_API_KEY` with your key (Production + Preview + Development).
4. Deploy. Verify the live URL runs both the sample-deal and PDF-upload paths.

## Notes & limits

- **PDF size:** Vercel serverless functions accept up to ~4.5 MB request bodies.
  A PDF is base64-encoded (~33% larger) before sending, so very large PDFs may be
  rejected. The text-paste path is the reliable fallback for big documents.
- **Key safety:** the key lives only in `process.env.ANTHROPIC_API_KEY`, read
  inside `api/screen.js`. It appears in no `src/` file and no committed file.
  Verify in the browser: open DevTools → Sources/Network and confirm the key is
  not present in the JS bundle, and that requests go to `/api/screen` (not
  `api.anthropic.com`).
