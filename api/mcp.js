// FRONTAGE — MCP server: exposes the FREE structured search + intel engines to any MCP
// client, most importantly claude.ai custom connectors ("normal" Claude chat on web/
// desktop/mobile). Add it in claude.ai → Settings → Connectors → Add custom connector:
//
//   https://<your-deployment>/api/mcp?key=<MCP_SECRET>
//
// Protocol: MCP Streamable HTTP, STATELESS mode — every message is a self-contained
// JSON-RPC 2.0 POST answered with a single application/json response (no SSE stream, no
// session ids). That's the simplest legal shape of the transport and all this server
// needs: initialize / tools/list / tools/call. Hand-rolled on purpose — no SDK dependency.
//
// AUTH: ?key= (or an Authorization: Bearer) must match MCP_SECRET, falling back to
// SITE_PASSWORD. If neither env is set the endpoint is open (same stance as search.js).
//
// COST DISCIPLINE: only the FREE engines are exposed — the market searches (direct
// module imports, no double lambda hop) and the per-parcel intel connectors + CT comps
// (internal fetch to their endpoints, password injected server-side). The PAID tools
// (skip trace, AI web research, outreach drafting) are deliberately NOT here: in chat
// the model decides when to call tools, and paid calls must stay behind an explicit
// human click in the app.

import * as nyc from "./_markets/nyc.js";
import * as hamptons from "./_markets/hamptons.js";
import * as ct from "./_markets/ct.js";
import * as ma from "./_markets/ma.js";
import * as sf from "./_markets/sf.js";
import * as nashville from "./_markets/nashville.js";
import * as charleston from "./_markets/charleston.js";
import * as savannah from "./_markets/savannah.js";
import * as teton from "./_markets/teton.js";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ── Tool catalog ─────────────────────────────────────────────────────────────
// Descriptions are what chat-Claude reasons from — each one states what comes back,
// the market's quirks, and the follow-on move, mirroring the Scout agent's briefing.

const num = (d) => ({ type: "number", description: d });
const str = (d) => ({ type: "string", description: d });
const LIMIT = num("Max rows to return (default 25, cap 50 — keep small for chat).");

// The assessor-market searches share a runner: call the module, cap the rows.
const marketRunner = (mod, marketArgs) => async (a) => {
  const out = await mod.search({ ...marketArgs(a), limit: Math.min(Number(a.limit) || 25, 50) });
  if (Array.isArray(out.properties)) out.properties = out.properties.slice(0, Math.min(Number(a.limit) || 25, 50));
  return out;
};

const TOOLS = [
  {
    name: "search_nyc_properties",
    description:
      "Source properties in NEW YORK CITY from public records (PLUTO). Returns leads with owner name, address, borough/block/lot, " +
      "building + retail SF, units, year built, assessed value, and mailing (absentee flagged). Filter by borough, asset type, or " +
      "near an address with a radius. The deal-flow leads are the useful part — rank by the motivation signals (long hold, " +
      "absentee, tax lien).",
    inputSchema: {
      type: "object",
      properties: {
        borough: str("Manhattan | Brooklyn | Queens | Bronx | Staten Island"),
        assetType: { type: "string", enum: ["retail", "office", "multifamily", "one_two_family", "industrial", "vacant", "any"], description: "Asset type (default retail)." },
        nearAddress: str("Anchor address for a proximity search, e.g. '120 5th Ave'."),
        radiusMiles: num("Radius around nearAddress (0 = just that property)."),
        minSqft: num("Minimum building SF."),
        minUnits: num("Minimum residential units."),
        limit: LIMIT,
      },
    },
    run: async (a) => {
      const out = await nyc.search({ sources: ["pluto"], assetType: a.assetType || "retail", borough: a.borough, nearAddress: a.nearAddress, radiusMiles: a.radiusMiles || 0, minSqft: a.minSqft, minUnits: a.minUnits, limit: Math.min(Number(a.limit) || 25, 50) });
      if (Array.isArray(out.leads)) out.leads = out.leads.slice(0, Math.min(Number(a.limit) || 25, 50));
      if (Array.isArray(out.deals)) out.deals = out.deals.slice(0, 10);
      return out;
    },
  },
  {
    name: "search_ct_properties",
    description:
      "Source properties in GREENWICH / CONNECTICUT (statewide parcel+assessor data). Returns OWNER of record + mailing " +
      "(absentee flagged), use, building SF, assessed value, and latest sale. CT publicly discloses LLC principals — for an " +
      "entity owner, say so and suggest the CT Business Registry (data.ct.gov).",
    inputSchema: {
      type: "object",
      properties: {
        town: str("CT town (default Greenwich): Greenwich, Darien, New Canaan, Westport, Stamford…"),
        propertyType: { type: "string", enum: ["any", "commercial", "apartments", "residential", "industrial", "vacant"], description: "Use filter." },
        address: str("Street or address filter, e.g. 'GREENWICH AVENUE'."),
        minValue: num("Minimum assessed value."), maxValue: num("Maximum assessed value."),
        minSqft: num("Minimum building SF."), sinceYear: num("Only parcels sold this year or later."),
        limit: LIMIT,
      },
    },
    run: marketRunner(ct, (a) => ({ town: a.town || "Greenwich", propertyType: a.propertyType, address: a.address, minValue: a.minValue, maxValue: a.maxValue, minSqft: a.minSqft, sinceYear: a.sinceYear })),
  },
  {
    name: "search_hamptons_properties",
    description:
      "Source properties in the HAMPTONS (East Hampton / Southampton / Shelter Island, NY State assessment roll). Returns OWNER " +
      "+ mailing (absentee flagged) + property class. NY assessed $ are rough (varying town ratios) — lead with owner/address/class.",
    inputSchema: {
      type: "object",
      properties: {
        town: str("East Hampton | Southampton | Shelter Island | all (default all)."),
        propertyType: { type: "string", enum: ["any", "commercial", "residential", "industrial", "vacant"], description: "Class filter." },
        address: str("Street filter, e.g. 'MAIN ST'."),
        minValue: num("Minimum assessed value."),
        limit: LIMIT,
      },
    },
    run: marketRunner(hamptons, (a) => ({ town: a.town || "all", propertyType: a.propertyType, address: a.address, minValue: a.minValue })),
  },
  {
    name: "search_ma_properties",
    description:
      "Source properties in MASSACHUSETTS — any MA town (MassGIS assessor data): Boston, Nantucket, Martha's Vineyard, the Cape. " +
      "Returns OWNER + mailing (absentee flagged), use, value, building SF, year built, latest sale.",
    inputSchema: {
      type: "object",
      properties: {
        town: str("MA town/city, e.g. 'Boston', 'Nantucket', 'Edgartown'."),
        propertyType: { type: "string", enum: ["any", "commercial", "apartments", "residential", "industrial", "vacant"], description: "Use filter." },
        address: str("Street or address filter."),
        minValue: num("Minimum assessed value."), maxValue: num("Maximum assessed value."),
        minSqft: num("Minimum building SF."), sinceYear: num("Only parcels sold this year or later."),
        limit: LIMIT,
      },
    },
    run: marketRunner(ma, (a) => ({ town: a.town, propertyType: a.propertyType, address: a.address, minValue: a.minValue, maxValue: a.maxValue, minSqft: a.minSqft, sinceYear: a.sinceYear })),
  },
  {
    name: "search_sf_properties",
    description:
      "Source properties in SAN FRANCISCO (DataSF assessor roll). Returns characteristics (use, SF, frontage, year, units, " +
      "zoning) + assessed value + block/lot. IMPORTANT: California publishes NO owner names — pair with sf_property_intel " +
      "(block+lot) for permits/evictions/the operating business.",
    inputSchema: {
      type: "object",
      properties: {
        neighborhood: str("SF neighborhood, e.g. 'Financial District', 'Mission', 'Marina'."),
        address: str("Street filter, e.g. 'GEARY'."),
        propertyType: { type: "string", enum: ["any", "retail", "office", "apartments", "residential", "industrial", "vacant"], description: "Use filter." },
        minValue: num("Minimum assessed value."), maxValue: num("Maximum assessed value."), minSqft: num("Minimum building SF."),
        limit: LIMIT,
      },
    },
    run: marketRunner(sf, (a) => ({ neighborhood: a.neighborhood, address: a.address, propertyType: a.propertyType, minValue: a.minValue, maxValue: a.maxValue, minSqft: a.minSqft })),
  },
  {
    name: "search_nashville_properties",
    description:
      "Source properties in NASHVILLE / Davidson County, TN (Metro parcel data, updated daily). FULL owner market: OWNER + " +
      "mailing (absentee flagged), land use, value, last sale + years owned, acreage + frontage (no building SF). Pass owner " +
      "for their whole county portfolio. Follow with nashville_property_intel (APN) for permits/zoning/distress.",
    inputSchema: {
      type: "object",
      properties: {
        propertyType: { type: "string", enum: ["any", "retail", "commercial", "apartments", "residential", "industrial", "vacant"], description: "Use filter." },
        address: str("Street or address filter, e.g. 'BROADWAY' or '2222 12th Ave S'."),
        owner: str("Owner-portfolio mode: every Davidson County parcel this owner holds."),
        minValue: num("Minimum appraised value."), maxValue: num("Maximum appraised value."),
        minAcres: num("Minimum acreage."), sinceYear: num("Only parcels sold this year or later."),
        limit: LIMIT,
      },
    },
    run: marketRunner(nashville, (a) => ({ propertyType: a.propertyType, address: a.address, owner: a.owner, minValue: a.minValue, maxValue: a.maxValue, minAcres: a.minAcres, sinceYear: a.sinceYear })),
  },
  {
    name: "search_charleston_properties",
    description:
      "Source properties in CHARLESTON, SC / Charleston County (assessor parcels): downtown, Mt Pleasant, N. Charleston, the " +
      "islands. FULL owner market: OWNER + mailing (absentee flagged), use class, acreage, last SALE price + year, deed book/" +
      "page. QUIRK: no assessed value / building SF — $ figures are last sale prices, so leave minValue empty when hunting " +
      "long-held parcels. Follow with charleston_property_intel (PID) for zoning/BAR/flood/permits.",
    inputSchema: {
      type: "object",
      properties: {
        propertyType: { type: "string", enum: ["any", "retail", "commercial", "apartments", "residential", "industrial", "vacant"], description: "Use filter." },
        address: str("Street or address filter, e.g. 'KING ST'."),
        owner: str("Owner-portfolio mode: every Charleston County parcel this owner holds."),
        minValue: num("Minimum last-sale price (careful: drops long-held parcels)."), maxValue: num("Maximum last-sale price."),
        minAcres: num("Minimum acreage."), sinceYear: num("Only parcels sold this year or later."),
        limit: LIMIT,
      },
    },
    run: marketRunner(charleston, (a) => ({ propertyType: a.propertyType, address: a.address, owner: a.owner, minValue: a.minValue, maxValue: a.maxValue, minAcres: a.minAcres, sinceYear: a.sinceYear })),
  },
  {
    name: "search_savannah_properties",
    description:
      "Source properties in SAVANNAH, GA / Chatham County (SAGIS assessor parcels): Savannah, Pooler, Tybee. FULL owner market: " +
      "OWNER (+ co-owner) + mailing (absentee flagged), GA use class, fair-market value (land/building split), acreage, year " +
      "built, last sale + years owned, street frontage. QUIRK: GA lumps retail/office/commercial into one class C.",
    inputSchema: {
      type: "object",
      properties: {
        propertyType: { type: "string", enum: ["any", "commercial", "retail", "office", "multifamily", "residential", "industrial", "vacant", "agricultural"], description: "GA class filter (retail/office/commercial are all class C)." },
        address: str("Street or address filter, e.g. 'BROUGHTON ST'."),
        owner: str("Owner-portfolio mode: every Chatham County parcel this owner holds."),
        minValue: num("Minimum fair-market value."), maxValue: num("Maximum fair-market value."),
        minAcres: num("Minimum acreage."), sinceYear: num("Only parcels sold this year or later."),
        limit: LIMIT,
      },
    },
    run: marketRunner(savannah, (a) => ({ propertyType: a.propertyType, address: a.address, owner: a.owner, minValue: a.minValue, maxValue: a.maxValue, minAcres: a.minAcres, sinceYear: a.sinceYear })),
  },
  {
    name: "search_teton_properties",
    description:
      "Source properties in JACKSON HOLE, WY / Teton County (Wyoming Property Tax Division parcel roll): Jackson, Teton " +
      "Village, Wilson, Moose, Kelly, Moran, Alta, Hoback. FULL owner market: OWNER (+ co-owner) + mailing (absentee flagged — " +
      "the norm in a resort market, not a distress signal alone), actual (market) value + assessed value, acreage, tax " +
      "district. QUIRKS: no use/class code (refine retail vs residential by street — Broadway/Cache/Center St = commercial " +
      "core), no year built, no sale history. Wyoming HIDES LLC members but the registered agent is public (wyobiz.wyo.gov).",
    inputSchema: {
      type: "object",
      properties: {
        address: str("Street or address filter, e.g. 'BROADWAY' or '45 S Cache St'."),
        owner: str("Owner-portfolio mode: every Teton County parcel this owner holds."),
        minValue: num("Minimum actual (market) value."), maxValue: num("Maximum actual (market) value."),
        minAcres: num("Minimum gross acreage."),
        limit: LIMIT,
      },
    },
    run: marketRunner(teton, (a) => ({ address: a.address, owner: a.owner, minValue: a.minValue, maxValue: a.maxValue, minAcres: a.minAcres })),
  },
  {
    name: "nashville_property_intel",
    description:
      "Consolidated public-records intel for ONE Nashville parcel (pass the APN from search_nashville_properties, or an " +
      "address): building permits (new/rehab/demolition/tenant finish-out = repositioning), trade + beer + STR permits, 311 " +
      "complaints (distress), zoning overlays, FEMA flood zone, land-use policy.",
    inputSchema: { type: "object", properties: { apn: str("Parcel APN from search_nashville_properties (preferred)."), address: str("Street address (resolved if no APN).") } },
    run: (a) => internal("/api/nashvilleintel", { apn: a.apn, address: a.address }),
  },
  {
    name: "charleston_property_intel",
    description:
      "Consolidated public-records intel for ONE Charleston, SC parcel (pass the PID from search_charleston_properties, or an " +
      "address): appraised value, building footprints, code enforcement (distress), construction permits, hotel entitlement, " +
      "zoning + Old & Historic District + height district (BAR review — THE peninsula constraint), STR overlays, FEMA flood + " +
      "street-flooding history, nearby crime.",
    inputSchema: { type: "object", properties: { pid: str("Parcel PID from search_charleston_properties (preferred)."), address: str("Street address (resolved if no PID).") } },
    run: (a) => internal("/api/charlestonintel", { pid: a.pid, address: a.address }),
  },
  {
    name: "sf_property_intel",
    description:
      "Consolidated public-records intel for ONE San Francisco parcel (pass block+lot from search_sf_properties, or an " +
      "address): permits, DBI complaints, the active business operator (a real contact lead — CA hides owners), eviction " +
      "notices (Ellis Act = landlord clearing the building), fire violations, 311.",
    inputSchema: { type: "object", properties: { block: str("Assessor block."), lot: str("Assessor lot."), address: str("Street address (resolved if no block/lot).") } },
    run: (a) => internal("/api/sfintel", { block: a.block, lot: a.lot, address: a.address }),
  },
  {
    name: "ct_sales_comps",
    description:
      "Recent recorded SALES in a CT town (pricing/underwriting context): sale amount, date, sales ratio, property type. " +
      "Filter by town, type, street, since-year, and amount range.",
    inputSchema: {
      type: "object",
      properties: {
        town: str("CT town (default Greenwich)."),
        propertyType: { type: "string", enum: ["any", "commercial", "apartments", "residential", "industrial", "vacant"], description: "Type filter." },
        address: str("Street filter."), sinceYear: num("Sales since this year."),
        minAmount: num("Minimum sale amount."), maxAmount: num("Maximum sale amount."),
      },
    },
    run: (a) => internal("/api/ctcomps", { town: a.town || "Greenwich", propertyType: a.propertyType, address: a.address, sinceYear: a.sinceYear, minAmount: a.minAmount, maxAmount: a.maxAmount }),
  },
];

// Internal hop to a sibling serverless endpoint (the intel connectors are written as
// HTTP handlers, not modules). The shared password is injected here, server-side —
// the MCP client never sees or needs it.
async function internal(path, body) {
  const base = process.env.MCP_SELF_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!base) throw new Error(`No self URL — set MCP_SELF_URL (or deploy on Vercel) so ${path} can be reached.`);
  const r = await fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: process.env.SITE_PASSWORD, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path} failed (${r.status})`);
  return j;
}

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return rpcError(msg?.id ?? null, -32600, "Invalid request");
  const { id, method, params } = msg;
  // Notifications (no id) get no response body.
  if (id === undefined || id === null) return null;

  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "frontage", title: "FRONTAGE deal screener", version: "1.0.0" },
      instructions:
        "FRONTAGE sources off-market real estate owners from free public records. Structured markets: NYC, Greenwich/CT, the " +
        "Hamptons, Massachusetts, San Francisco, Nashville TN, Charleston SC, Savannah GA, and Jackson Hole WY (Teton County). " +
        "Every tool is free public data — no calls cost money. Typical flow: search a market, rank by motivation signals " +
        "(long hold, absentee/out-of-state mailing, tax lien), then pull the per-parcel intel tool where one exists " +
        "(Nashville/Charleston/SF). Owners are public records everywhere except SF/CA (characteristics only there).",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return rpcError(id, -32602, `Unknown tool "${params?.name}"`);
    try {
      const out = await tool.run(params?.arguments || {});
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      return rpcResult(id, { content: [{ type: "text", text: `Tool failed: ${e.message}` }], isError: true });
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export default async function handler(req, res) {
  // Streamable HTTP, stateless: no SSE stream to offer, so GET has nothing to open.
  if (req.method === "GET") return res.status(405).json({ error: "POST only (stateless MCP endpoint)" });
  if (req.method === "DELETE") return res.status(200).end(); // session teardown — nothing to tear down
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Shared-secret gate: ?key= or Authorization: Bearer, vs MCP_SECRET (fallback SITE_PASSWORD).
  const secret = process.env.MCP_SECRET || process.env.SITE_PASSWORD;
  if (secret) {
    const url = new URL(req.url, "http://x");
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (url.searchParams.get("key") !== secret && bearer !== secret) {
      return res.status(401).json({ error: "Bad or missing key" });
    }
  }

  const body = req.body;
  // Single message or a batch (older protocol revisions allow arrays).
  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map(handleMessage))).filter((r) => r != null);

  if (!replies.length) return res.status(202).end(); // notifications only
  res.setHeader("content-type", "application/json");
  return res.status(200).json(Array.isArray(body) ? replies : replies[0]);
}
