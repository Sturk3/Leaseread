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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const b = req.body || {};
    if (process.env.SITE_PASSWORD && b.password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    // Accept any of the common names so it works whatever you called it (and picks up an
    // older Maps-embed key if one's already set). GOOGLE_MAPS_API_KEY is the documented one.
    const KEY_NAMES = ["GOOGLE_MAPS_API_KEY", "GOOGLE_API_KEY", "GMAPS_API_KEY", "VITE_GMAPS_EMBED_KEY", "GMAPS_EMBED_KEY"];
    const keyName = KEY_NAMES.find((n) => clean(process.env[n]));
    const key = keyName ? clean(process.env[keyName]) : "";
    if (b.debug) return res.status(200).json({ ok: true, keyConfigured: !!key, keyEnv: keyName || "GOOGLE_MAPS_API_KEY", checked: KEY_NAMES, build: "streetview-v2" });
    if (!key) return res.status(200).json({ noKey: true, keyEnv: "GOOGLE_MAPS_API_KEY" });

    // Location: prefer the ADDRESS (Google auto-orients the camera toward that building's
    // frontage, which frames the storefront), fall back to lat/lon.
    const address = clean(b.address);
    const lat = b.lat != null && b.lat !== "" ? Number(b.lat) : null;
    const lon = b.lon != null && b.lon !== "" ? Number(b.lon) : null;
    const location = address || (Number.isFinite(lat) && Number.isFinite(lon) ? `${lat},${lon}` : "");
    if (!location) return res.status(400).json({ error: "Need an address or lat/lon." });

    // Free metadata check — is there a pano here at all? (avoids billing for / showing a
    // gray "no imagery" tile). Also returns the actual pano date for the caption.
    const meta = await fetch(`${GSV}/metadata?${new URLSearchParams({ location, key })}`).then((r) => r.json()).catch(() => null);
    if (!meta || meta.status !== "OK") return res.status(200).json({ noImage: true, status: meta?.status || "unknown", location });

    const size = /^\d+x\d+$/.test(clean(b.size)) ? clean(b.size) : "640x360";
    const params = { size, location, fov: "80", key, source: "outdoor", return_error_code: "true" };
    if (b.heading != null && b.heading !== "") params.heading = String(Number(b.heading) % 360);
    if (b.pitch != null && b.pitch !== "") params.pitch = String(b.pitch);

    const img = await fetch(`${GSV}?${new URLSearchParams(params)}`);
    if (!img.ok) return res.status(200).json({ noImage: true, status: `HTTP ${img.status}` });
    const buf = Buffer.from(await img.arrayBuffer());
    res.setHeader("Content-Type", img.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=86400"); // a storefront doesn't change hourly
    if (meta.date) res.setHeader("X-Pano-Date", String(meta.date));
    if (meta.location) res.setHeader("X-Pano-LatLng", `${meta.location.lat},${meta.location.lng}`);
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "streetview" });
  }
}
