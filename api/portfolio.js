// FRONTAGE — hidden-portfolio finder.
// Given a PERSON's name (typically an HPD officer/owner from the dossier), find every
// HPD-registered building where that same person is a contact. This surfaces an
// operator's holdings across SEPARATE single-asset LLCs — the common thread is the
// human, which the name-matched owner portfolio (PLUTO ownername) misses entirely.
// Password-gated.

const NYC = "https://data.cityofnewyork.us/resource";
const HPD_CONTACTS = process.env.HPD_CONTACTS_DATASET || "feu5-w2e2";
const HPD_REG = process.env.HPD_REG_DATASET || "tesw-yqqr";
const BORO = { "1": "Manhattan", "2": "Bronx", "3": "Brooklyn", "4": "Queens", "5": "Staten Island" };

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const sodaQuote = (vals) => [...new Set(vals)].map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
async function getJson(dataset, params, appToken) {
  const headers = appToken ? { "X-App-Token": appToken } : {};
  const r = await fetch(`${NYC}/${dataset}.json?${new URLSearchParams(params)}`, { headers });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function splitName(name) {
  const n = clean(name);
  if (n.includes(",")) { const [last, first] = n.split(","); return { first: clean(first), last: clean(last) }; }
  const p = n.split(" ");
  return p.length === 1 ? { first: "", last: p[0] } : { first: p[0], last: p.slice(1).join(" ") };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { password, name, first, last } = req.body || {};
    if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    const appToken = process.env.SOCRATA_APP_TOKEN || null;
    let f = clean(first), l = clean(last);
    if ((!f || !l) && name) ({ first: f, last: l } = splitName(name));
    if (!l) return res.status(400).json({ error: "Need a person's name." });

    // 1) All HPD contact rows for this exact person → registration ids.
    const where = f
      ? `upper(firstname)='${f.toUpperCase().replace(/'/g, "''")}' AND upper(lastname)='${l.toUpperCase().replace(/'/g, "''")}'`
      : `upper(lastname)='${l.toUpperCase().replace(/'/g, "''")}'`;
    const contacts = await getJson(HPD_CONTACTS, { $select: "registrationid,type", $where: where, $limit: "1000" }, appToken);
    const regIds = [...new Set(contacts.map((c) => clean(c.registrationid)).filter(Boolean))];
    if (!regIds.length) return res.status(200).json({ count: 0, buildings: [] });

    // 2) Those registrations → the buildings (address + bbl).
    let regs = [];
    for (const b of chunk(regIds, 75)) {
      regs = regs.concat(await getJson(HPD_REG, {
        $select: "registrationid,housenumber,streetname,boro,boroid,zip,block,lot,lastregistrationdate",
        $where: `registrationid in (${sodaQuote(b)})`, $limit: "2000",
      }, appToken));
    }

    // Dedupe by tax lot (boroid|block|lot); keep the most recent registration.
    const byLot = new Map();
    for (const r of regs) {
      const key = `${clean(r.boroid)}|${clean(r.block)}|${clean(r.lot)}`;
      const prev = byLot.get(key);
      if (!prev || clean(r.lastregistrationdate) > clean(prev.lastregistrationdate)) byLot.set(key, r);
    }
    const buildings = [...byLot.values()].map((r) => ({
      address: clean(`${clean(r.housenumber)} ${clean(r.streetname)}`),
      borough: clean(r.boro) || BORO[clean(r.boroid)] || "",
      zip: clean(r.zip),
      borough_code: clean(r.boroid), block: clean(r.block), lot: clean(r.lot),
    })).sort((a, b) => a.borough.localeCompare(b.borough) || a.address.localeCompare(b.address));

    return res.status(200).json({ person: `${f} ${l}`.trim(), count: buildings.length, buildings });
  } catch (e) {
    return res.status(500).json({ error: e.message, where: "portfolio" });
  }
}
