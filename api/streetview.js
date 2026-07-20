// FRONTAGE — storefront photo proxy (Google Street View Static API). Returns an actual
// PHOTO of the building front for a property, so every candidate shows what the retail
// storefront looks like — the thing a spreadsheet of owners can't tell you.
//
// Server-side proxy so the Google key stays OFF the client (the app's convention). The
// Street View Static API is billed but carries a large monthly free credit (~$200 ≈
// ~28k images), so at this app's volume it's effectively free. METADATA is always free,
// so we check it first and never bill for (or show) a broken image where no pano exists.
//
// Set GOOGLE_MAPS_API_KEY in Vercel env (enable "Street View Static API"). With no key
// the endpoint says so and the UI falls back to the free keyless "open in Street View"
// link + a street map.
//
//   POST /api/streetview { password, address?, lat?, lon?, heading?, size? }
//     → image/jpeg (the storefront)  |  { noKey:true }  |  { noImage:true }
//
// Password-gated (in the POST body, so it never rides in a URL); the React component
// fetches it as a blob for an <img>.

const GSV = "https://maps.googleapis.com/maps/api/streetview";
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

// ── Mapillary lane (free, NO billing card — just a free token) ────────────────────
// Meta's open street-level imagery. Query images in a small bbox around the point,
// pick the nearest, and return its CDN JPEG. The thumb URL is public (no token), but we
// proxy the bytes so the response shape matches the Google lane (image | JSON).
async function mapillaryPhoto(token, lat, lon, res) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { fell: true };
  const d = 0.00045; // ~50m half-span
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const url = `https://graph.mapillary.com/images?${new URLSearchParams({
    access_token: token, fields: "id,thumb_2048_url,captured_at,geometry", bbox, limit: "25",
  })}`;
  const j = await fetch(url).then((r) => r.json()).catch(() => null);
  const imgs = (j && Array.isArray(j.data)) ? j.data : [];
  if (!imgs.length) return { none: true };
  // Nearest image to the parcel point (equirectangular distance is fine at this scale).
  const dist = (g) => { const c = g && g.coordinates; if (!c) return Infinity; const dx = (c[0] - lon) * Math.cos((lat * Math.PI) / 180), dy = c[1] - lat; return dx * dx + dy * dy; };
  imgs.sort((a, b) => dist(a.geometry) - dist(b.geometry));
  const pick = imgs.find((i) => i.thumb_2048_url) || imgs[0];
  if (!pick || !pick.thumb_2048_url) return { none: true };
  const img = await fetch(pick.thumb_2048_url);
  if (!img.ok) return { none: true };
  const buf = Buffer.from(await img.arrayBuffer());
  res.setHeader("Content-Type", img.headers.get("content-type") || "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Photo-Source", "mapillary");
  if (pick.captured_at) res.setHeader("X-Pano-Date", new Date(Number(pick.captured_at)).toISOString().slice(0, 10));
  res.status(200).send(buf);
  return { sent: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const b = req.body || {};
    if (process.env.SITE_PASSWORD && b.password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    // Two lanes, in preference order:
    //   GOOGLE (best coverage; billed but ~$200/mo free credit) — GOOGLE_MAPS_API_KEY.
    //   MAPILLARY (free, NO billing card, open imagery) — MAPILLARY_TOKEN.
    // Accept any of the common Google names (picks up an older Maps-embed key too).
    const KEY_NAMES = ["GOOGLE_MAPS_API_KEY", "GOOGLE_API_KEY", "GMAPS_API_KEY", "VITE_GMAPS_EMBED_KEY", "GMAPS_EMBED_KEY"];
    const keyName = KEY_NAMES.find((n) => clean(process.env[n]));
    const key = keyName ? clean(process.env[keyName]) : "";
    const mapillary = clean(process.env.MAPILLARY_TOKEN) || clean(process.env.MAPILLARY_ACCESS_TOKEN);
    if (b.debug) return res.status(200).json({ ok: true, google: !!key, googleEnv: keyName || null, mapillary: !!mapillary, build: "streetview-v3" });
    if (!key && !mapillary) return res.status(200).json({ noKey: true, keyEnv: "GOOGLE_MAPS_API_KEY", alt: "MAPILLARY_TOKEN" });

    const address = clean(b.address);
    const lat = b.lat != null && b.lat !== "" ? Number(b.lat) : null;
    const lon = b.lon != null && b.lon !== "" ? Number(b.lon) : null;

    // ── Google lane ──
    if (key) {
      // Prefer the ADDRESS (Google auto-orients toward that building's frontage).
      const location = address || (Number.isFinite(lat) && Number.isFinite(lon) ? `${lat},${lon}` : "");
      if (location) {
        // Free metadata check — is there a pano here? (never bill for / show a gray tile).
        const meta = await fetch(`${GSV}/metadata?${new URLSearchParams({ location, key })}`).then((r) => r.json()).catch(() => null);
        if (meta && meta.status === "OK") {
          const size = /^\d+x\d+$/.test(clean(b.size)) ? clean(b.size) : "640x360";
          const params = { size, location, fov: "80", key, source: "outdoor", return_error_code: "true" };
          if (b.heading != null && b.heading !== "") params.heading = String(Number(b.heading) % 360);
          if (b.pitch != null && b.pitch !== "") params.pitch = String(b.pitch);
          const img = await fetch(`${GSV}?${new URLSearchParams(params)}`);
          if (img.ok) {
            const buf = Buffer.from(await img.arrayBuffer());
            res.setHeader("Content-Type", img.headers.get("content-type") || "image/jpeg");
            res.setHeader("Cache-Control", "private, max-age=86400");
            res.setHeader("X-Photo-Source", "google");
            if (meta.date) res.setHeader("X-Pano-Date", String(meta.date));
            return res.status(200).send(buf);
          }
        }
        // Google had no pano here — fall through to Mapillary if available.
      }
    }

    // ── Mapillary lane (coordinate-based) ──
    if (mapillary && Number.isFinite(lat) && Number.isFinite(lon)) {
      const out = await mapillaryPhoto(mapillary, lat, lon, res).catch(() => ({ none: true }));
      if (out.sent) return; // bytes already streamed
    }

    return res.status(200).json({ noImage: true, location: address || (Number.isFinite(lat) ? `${lat},${lon}` : "") });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "streetview" });
  }
}
