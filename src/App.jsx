import React, { useState, useRef, useMemo, useEffect } from "react";

// FRONTAGE — Retail Acquisitions Screener
// Ingests a retail offering memorandum, extracts underwriting data, breaks out
// the tenant roster, and scores the deal against a CUSTOMIZABLE buy box:
//  - editable criteria (what Claude grades on)
//  - weight sliders (how much each criterion counts)
//  - threshold sliders (Pursue / Watch / Pass cutoffs)
//  - a free-text "commands" box for rules sliders can't capture
//  - saved presets (mandates) shared across the team
// Weights/thresholds recompute the score instantly in the browser; Claude scores
// each criterion and the app does the weighted math deterministically.
//
// The Anthropic call lives in the serverless backend (api/screen.js) so the key
// never reaches the browser.

const SAMPLE_OM = `CONFIDENTIAL OFFERING MEMORANDUM
"The Madison Collection" — 712 Madison Avenue, New York, NY 10065

INVESTMENT SUMMARY
Prime Upper East Side high-street retail condominium on the Madison Avenue luxury corridor between 63rd and 64th Streets. 60 feet of uninterrupted Madison Avenue frontage. Irreplaceable trophy positioning among the world's leading luxury flagships.

Asking Price: $96,000,000
Gross Leasable Area: 18,400 SF (ground + lower level + second floor)
In-Place Net Operating Income: $4,512,000
Going-In Cap Rate: 4.70%
Occupancy: 96%
Year Built: 1923 (gut renovated 2019)

TENANCY
- Luxury fashion flagship (investment-grade national/global brand): 9,200 SF, ground + 2nd floor, lease expires Aug 2031, ~$3.1M base rent.
- Fine jewelry boutique (well-known national jeweler): 4,800 SF, ground, lease expires Mar 2028, ~$1.05M base rent.
- Ground-floor café (local independent operator): 1,600 SF, lease expires Jun 2026, ~$360K base rent.
- Lower-level showroom (regional retailer): 2,000 SF, lease expires Dec 2029, ~$420K base rent.
- Vacant: 800 SF second-floor suite available for lease.

VALUE-ADD / UPSIDE
In-place rents are estimated ~20% below current Madison Avenue market. Near-term lease-up of the vacant 800 SF suite. Mark-to-market opportunity on the 2026 and 2028 rollovers. Strong landmark facade; no major capital needs.

MARKET
Madison Avenue luxury corridor — among the highest-barrier, highest-rent retail submarkets in North America. Limited comparable trophy product trades.`;

// Default mandate: the trophy-retail buy box.
const DEFAULT_CONFIG = {
  name: "Trophy Retail",
  criteria: [
    { id: "location", label: "Location", desc: "High-street / prime corridor / dense high-barrier gateway market", weight: 30 },
    { id: "tenancy_credit", label: "Tenant credit", desc: "Strength and durability of tenant credit", weight: 25 },
    { id: "asset_quality", label: "Asset quality", desc: "Trophy / irreplaceable vs commodity", weight: 20 },
    { id: "lease_durability", label: "Lease durability", desc: "Weighted lease term and rollover risk", weight: 15 },
    { id: "value_add", label: "Value-add", desc: "Mark-to-market, lease-up, or repositioning upside", weight: 10 },
  ],
  thresholds: { pursue: 75, watch: 55 },
  commands: "",
};

const PRESETS_KEY = "fr_presets_v1";
const ACTIVE_KEY = "fr_active_v1";

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function genId() { return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

function loadPresets() {
  try { const p = JSON.parse(localStorage.getItem(PRESETS_KEY)); if (p && typeof p === "object" && Object.keys(p).length) return p; } catch {}
  return { [DEFAULT_CONFIG.name]: clone(DEFAULT_CONFIG) };
}
function loadActive() {
  try { const a = JSON.parse(localStorage.getItem(ACTIVE_KEY)); if (a && Array.isArray(a.criteria)) return a; } catch {}
  return clone(DEFAULT_CONFIG);
}

// Deterministic grade: weighted average of Claude's per-criterion scores, with
// the recommendation derived from the firm's thresholds.
function gradeFrom(result, config) {
  const crit = (result && result.buy_box && result.buy_box.criteria) || {};
  let num = 0, wsum = 0, scored = 0;
  (config.criteria || []).forEach((c) => {
    const cell = crit[c.id];
    const sc = cell && typeof cell.score === "number" ? cell.score : null;
    const w = Number(c.weight) || 0;
    if (sc != null && w > 0) { num += sc * w; wsum += w; scored++; }
  });
  const fallback = Math.round((result && result.buy_box && result.buy_box.overall_score) || 0);
  const overall = wsum > 0 ? Math.round(num / wsum) : fallback;
  const t = config.thresholds || { pursue: 75, watch: 55 };
  const rec = overall >= t.pursue ? "Pursue" : overall >= t.watch ? "Watch" : "Pass";
  return { overall, rec, scored };
}

const C = {
  ink: "#f3f6fd", panel: "#ffffff", panel2: "#e7eef9", line: "#dfe7f3",
  ivory: "#161b2c", muted: "#606b82", gold: "#2f64e8", goldSoft: "rgba(47,100,232,0.10)",
  green: "#1f9d63", amber: "#b7791f", red: "#d14a3c",
};

function recColor(rec) {
  if (rec === "Pursue") return C.green;
  if (rec === "Watch") return C.amber;
  return C.red;
}

export default function App() {
  const [mode, setMode] = useState("text");
  const [pdfData, setPdfData] = useState(null);
  const [fileName, setFileName] = useState("");
  const [memoText, setMemoText] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  // Customizable grading config + saved presets.
  const [config, setConfigState] = useState(loadActive);
  const [presets, setPresetsState] = useState(loadPresets);
  const [showSettings, setShowSettings] = useState(false);

  // Which tool is showing. Defaults to the Agent tab (the Screener is hidden / folded
  // into Scout, so it must NOT be the default or a reload lands on the tabless OM grader).
  const [view, setView] = useState("agent");
  const [sourcingRows, setSourcingRows] = useState(null); // shared between Scout + the Sourcing tab

  function setConfig(updater) {
    setConfigState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }
  function setPresets(next) {
    setPresetsState(next);
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch {}
  }

  // Shared-password gate.
  const [pw, setPw] = useState(() => sessionStorage.getItem("lr_pw") || "");
  const [authed, setAuthed] = useState(() => !!sessionStorage.getItem("lr_pw"));
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  async function submitPw(e) {
    e?.preventDefault?.();
    setPwError(""); setPwBusy(true);
    try {
      const res = await fetch("/api/screen", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check: true, password: pwInput }),
      });
      if (res.ok) { sessionStorage.setItem("lr_pw", pwInput); setPw(pwInput); setAuthed(true); }
      else { const d = await res.json().catch(() => ({})); setPwError(d.error || "Incorrect password."); }
    } catch { setPwError("Could not reach the server. Try again."); }
    finally { setPwBusy(false); }
  }

  function onFile(f) {
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setPdfData(reader.result.split(",")[1]);
    reader.readAsDataURL(f);
  }

  async function analyze() {
    setError(""); setResult(null); setLoading(true);
    setProgress("Reading the memorandum…");
    try {
      if (mode === "pdf") {
        if (!pdfData) { setError("Upload a PDF offering memorandum first."); setLoading(false); return; }
      } else {
        if (!memoText.trim()) { setError("Paste the memo text or load the sample deal."); setLoading(false); return; }
      }
      setProgress("Extracting underwriting data and scoring the buy box…");
      // postJSON (not raw res.json()): a big PDF can push the function past the timeout,
      // where Vercel returns an HTML error page — this turns that into a clear message.
      const data = await postJSON("/api/screen", { mode, pdfData, memoText, password: pw, config });
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const start = text.indexOf("{"); const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("Could not read a structured result. Try again or check the document.");
      const parsed = JSON.parse(text.slice(start, end + 1));
      parsed._checks = reconcile(parsed);
      setResult(parsed);
    } catch (e) {
      setError(e.message || "Something went wrong. Try again.");
    } finally {
      setLoading(false); setProgress("");
    }
  }

  // Reliability layer: recompute the math the memo claims and flag mismatches.
  function reconcile(p) {
    const checks = [];
    const tol = 0.03;
    if (p.asking_price_num && p.square_footage_num) {
      const calc = p.asking_price_num / p.square_footage_num;
      const stated = p.price_per_sf_num;
      checks.push({
        label: "Price / SF", computed: "$" + Math.round(calc).toLocaleString() + "/SF",
        stated: stated ? "$" + Math.round(stated).toLocaleString() + "/SF" : "not stated",
        ok: stated ? Math.abs(calc - stated) / stated <= tol : null,
      });
    }
    if (p.in_place_noi_num && p.asking_price_num) {
      const calc = (p.in_place_noi_num / p.asking_price_num) * 100;
      const stated = p.cap_rate_num;
      checks.push({
        label: "Cap rate (NOI / Price)", computed: calc.toFixed(2) + "%",
        stated: stated ? stated.toFixed(2) + "%" : "not stated",
        ok: stated ? Math.abs(calc - stated) <= 0.15 : null,
      });
    }
    if (Array.isArray(p.tenants) && p.square_footage_num) {
      const sum = p.tenants.reduce((a, t) => a + (t.sf || 0), 0);
      checks.push({
        label: "Roster SF vs GLA", computed: sum.toLocaleString() + " SF",
        stated: p.square_footage_num.toLocaleString() + " SF",
        ok: Math.abs(sum - p.square_footage_num) / p.square_footage_num <= 0.05,
      });
    }
    return checks;
  }

  // Recompute the grade whenever the result or the config changes — so moving a
  // weight or threshold slider re-scores instantly without re-calling Claude.
  const grade = useMemo(() => (result ? gradeFrom(result, config) : null), [result, config]);

  function exportJSON() {
    const out = clone(result);
    if (grade) out.buy_box = { ...out.buy_box, overall_score: grade.overall, recommendation: grade.rec };
    out._mandate = config.name;
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    dl(blob, (result.property_name || "deal").replace(/\W+/g, "_") + ".json");
  }
  function exportCSV() {
    const rows = [["Field", "Value", "Confidence"]];
    const c = result.confidence || {};
    rows.push(["Property", result.property_name || "", ""]);
    rows.push(["Address", result.address || "", ""]);
    rows.push(["Asset type", result.asset_type || "", ""]);
    rows.push(["Asking price", result.asking_price || "", c.asking_price || ""]);
    rows.push(["GLA (SF)", result.square_footage || "", c.square_footage || ""]);
    rows.push(["Price/SF", result.price_per_sf || "", ""]);
    rows.push(["In-place NOI", result.in_place_noi || "", c.in_place_noi || ""]);
    rows.push(["Cap rate", result.cap_rate || "", c.cap_rate || ""]);
    rows.push(["Occupancy", result.occupancy || "", c.occupancy || ""]);
    rows.push([]);
    rows.push(["Tenant", "SF", "Lease expiration", "Credit tier"]);
    (result.tenants || []).forEach((t) => rows.push([t.name, t.sf || "", t.lease_expiration || "", t.credit_tier || ""]));
    rows.push([]);
    rows.push(["Mandate", config.name, ""]);
    rows.push(["Buy-box score", grade ? grade.overall : "", grade ? grade.rec : ""]);
    const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    dl(new Blob([csv], { type: "text/csv" }), (result.property_name || "deal").replace(/\W+/g, "_") + ".csv");
  }
  function dl(blob, name) {
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  }

  if (!authed) {
    return (
      <div style={{ background: C.ink, color: C.ivory, minHeight: "100vh", fontFamily: "Archivo, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 22 }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
          * { box-sizing: border-box; }
          .serif { font-family: 'Fraunces', serif; }
          .mono { font-family: 'IBM Plex Mono', monospace; }
          input:focus, button:focus { outline: none; }
        `}</style>
        <form onSubmit={submitPw} style={{ width: "100%", maxWidth: 360, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 28 }}>
          <div className="serif" style={{ fontSize: 30, letterSpacing: "-0.01em", fontWeight: 600 }}>
            FRONTAGE<span style={{ color: C.gold }}>.</span>
          </div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>Enter the access password to continue.</div>
          <input type="password" value={pwInput} onChange={(e) => setPwInput(e.target.value)} autoFocus placeholder="Password"
            style={{ width: "100%", marginTop: 18, background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 9, padding: 13, fontSize: 14, fontFamily: "Archivo, sans-serif" }} />
          <button type="submit" disabled={pwBusy || !pwInput}
            style={{ marginTop: 12, width: "100%", cursor: pwBusy || !pwInput ? "default" : "pointer", border: "none", borderRadius: 9, padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em", background: pwBusy || !pwInput ? C.panel2 : C.gold, color: pwBusy || !pwInput ? C.muted : "#ffffff" }}>
            {pwBusy ? "Checking…" : "Enter →"}
          </button>
          {pwError && <div style={{ marginTop: 12, color: C.red, fontSize: 13 }}>{pwError}</div>}
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell" style={{ display: "flex", height: "100vh", overflow: "hidden", fontFamily: "'Hanken Grotesk', Archivo, sans-serif", background: C.ink, color: C.ivory }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;600;700&family=Hanken+Grotesk:wght@300;400;500;600&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        .serif { font-family: 'Fraunces', serif; }
        .fade { animation: fade .5s ease both; }
        @keyframes fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        .bar { transition: width .9s cubic-bezier(.2,.8,.2,1); }
        textarea::placeholder, input::placeholder { color: ${C.muted}; }
        textarea:focus, button:focus, input:focus, select:focus { outline: none; }
        .lift { transition: transform .15s ease, border-color .15s ease; }
        .lift:hover { transform: translateY(-1px); border-color: ${C.gold}; }
        input[type=range] { accent-color: ${C.gold}; }
        .addr-opt:hover { background: ${C.goldSoft}; color: ${C.gold}; }
        .rail-item { position:relative; display:flex; align-items:center; gap:11px; padding:11px 14px; border-radius:9px; font-family:'Hanken Grotesk',sans-serif; font-size:11px; font-weight:400; letter-spacing:1.5px; text-transform:uppercase; color:#AAB4CC; cursor:pointer; border:1px solid transparent; transition:background .2s,color .2s,box-shadow .2s; background:none; width:100%; text-align:left; }
        .rail-item .ic { width:16px; text-align:center; color:#666f88; font-size:13px; transition:color .2s; }
        .rail-item:hover { background:rgba(255,255,255,.05); color:#F1F4FB; }
        .rail-item:hover .ic { color:#AAB4CC; }
        .rail-item.active { background:linear-gradient(90deg,rgba(96,148,250,.18),rgba(96,148,250,.07)); color:#CCDAFB; border-color:rgba(96,148,250,.28); box-shadow:0 10px 30px -16px rgba(96,148,250,.9); }
        .rail-item.active .ic { color:#94B4FB; }
        .rail-item.active::before { content:""; position:absolute; left:0; top:50%; transform:translateY(-50%); width:2px; height:18px; border-radius:2px; background:#7BA0F8; box-shadow:0 0 10px rgba(96,148,250,.9); }
        @media (max-width:820px){
          .app-shell{ flex-direction:column !important; height:auto !important; min-height:100vh; overflow:auto !important; }
          .rail-wrap{ width:100% !important; flex:none !important; flex-direction:row !important; align-items:center !important; padding:14px 16px !important; gap:16px; overflow-x:auto; }
          .rail-brand{ border-bottom:none !important; border-right:1px solid rgba(255,255,255,.09); padding:0 16px 0 0 !important; flex:0 0 auto; }
          .rail-eyebrow{ display:none !important; }
          .rail-nav{ flex-direction:row !important; padding:0 !important; flex:1; }
          .rail-label, .rail-foot{ display:none !important; }
          .rail-item{ white-space:nowrap; padding:8px 12px; }
          .main-top, .main-scroll{ padding-left:20px !important; padding-right:20px !important; }
        }
      `}</style>

      {/* LUXURY SIDEBAR */}
      <aside className="rail-wrap" style={{ width: 268, flex: "0 0 268px", background: "radial-gradient(120% 60% at 50% -10%, rgba(96,148,250,.14), transparent 60%), linear-gradient(180deg,#16192a 0%,#11131e 60%,#0c0e16 100%)", borderRight: "1px solid rgba(255,255,255,.06)", display: "flex", flexDirection: "column", padding: "40px 0 28px" }}>
        <div className="rail-brand" style={{ padding: "0 30px 28px", borderBottom: "1px solid rgba(255,255,255,.07)" }}>
          <div style={{ fontFamily: "'Bricolage Grotesque', sans-serif", fontWeight: 600, fontSize: 31, letterSpacing: "-.5px", lineHeight: 1, color: "#F1F4FB" }}>FRONTAGE<span style={{ color: "#7BA0F8", textShadow: "0 0 16px rgba(96,148,250,.75)" }}>.</span></div>
          <div className="rail-eyebrow" style={{ fontSize: 9.5, letterSpacing: "2.8px", textTransform: "uppercase", color: "#838DA6", marginTop: 12 }}>Trophy Retail Acquisitions</div>
          <div className="mono" title="Deployed build — if this doesn't match the latest commit, the browser is running a cached bundle" style={{ fontSize: 9, letterSpacing: "1.5px", color: "#555f76", marginTop: 8 }}>BUILD {typeof __BUILD_SHA__ !== "undefined" ? __BUILD_SHA__ : "dev"}</div>
        </div>
        <nav className="rail-nav" style={{ padding: "28px 18px", display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
          <div className="rail-label" style={{ fontSize: 9, fontWeight: 500, letterSpacing: "2.4px", textTransform: "uppercase", color: "#555f76", padding: "4px 14px 12px" }}>Engines</div>
          {[["agent", "Agent", "✦"], ["sourcing", "Sourcing", "◎"], ["corridors", "Corridors", "▚"], ["pipeline", "Pipeline", "★"], ["comps", "Comp Sheet", "≣"], ["skiptrace", "Skip Trace", "🔎"]].map(([v, lab, ic]) => (
            <button key={v} onClick={() => setView(v)} className={view === v ? "rail-item active" : "rail-item"}>
              <span className="ic">{ic}</span> {lab}
            </button>
          ))}
        </nav>
        <div className="rail-foot" style={{ padding: "20px 30px 0", borderTop: "1px solid rgba(255,255,255,.07)" }}>
          <div style={{ fontSize: 9, fontWeight: 500, letterSpacing: "2px", textTransform: "uppercase", color: "#7BA0F8", lineHeight: 1.8 }}>Powered by Claude<span style={{ color: "#555f76", display: "block", letterSpacing: "1.6px", fontWeight: 400 }}>Scout · orchestrator</span></div>
        </div>
      </aside>

      {/* MAIN */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: C.ink }}>
        <header className="main-top" style={{ padding: "20px 40px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", background: C.panel }}>
          <h1 style={{ fontSize: 12, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: C.ivory, margin: 0 }}>
            {view === "agent" ? "Agent" : view === "sourcing" ? "Sourcing" : view === "corridors" ? "Corridors" : view === "pipeline" ? "Pipeline" : view === "comps" ? "Comp Sheet" : view === "screener" ? "Screener" : view === "skiptrace" ? "Skip Trace" : view === "nda" ? "NDA Review" : "Lease Radar"}
          </h1>
          <p style={{ fontSize: 13, color: C.muted, fontWeight: 300, margin: 0, flex: "1 1 240px" }}>
            {view === "agent"
              ? "Just ask. Scout runs the right engines — sourcing, intel, contacts, research — and hands back the read."
              : view === "comps"
              ? "Auto-build a retail comp sheet — nearby sales with $/SF, subject summary, and rent context."
              : view === "screener"
              ? "Underwrite high-street flagship assets against your mandate."
              : view === "radar"
              ? "Scan a corridor for leases estimated to be coming available — off-market, before they list."
              : view === "nda"
              ? "Redline an NDA against your playbook — what to leave in, narrow, or strike."
              : view === "pipeline"
              ? "Your saved leads as a working list — status, notes, and the full dossier + owner contact in one place."
              : view === "skiptrace"
              ? "Trace a name + address straight to graded phones & emails — charged only on a match."
              : "Source owners & deals from public records — NYC, Greenwich/CT, the Hamptons, Nashville, Charleston SC, and Savannah GA — plus an AI web lookup for any other US address."}
          </p>
          {(view === "screener" || view === "agent") && (
            <button onClick={() => setShowSettings((s) => !s)} className="mono lift"
              style={{ cursor: "pointer", fontSize: 11, padding: "7px 13px", borderRadius: 7, border: `1px solid ${showSettings ? C.gold : C.line}`, background: showSettings ? C.goldSoft : C.panel, color: showSettings ? C.gold : C.ivory, letterSpacing: "0.5px" }}>
              ⚙ GRADING CRITERIA
            </button>
          )}
        </header>
        <div className="main-scroll" style={{ flex: 1, overflowY: "auto", padding: "0 40px 60px" }}>
          <div style={{ maxWidth: 1040, margin: "0 auto" }}>

        {view === "agent" && <>
          {showSettings && <Settings config={config} setConfig={setConfig} presets={presets} setPresets={setPresets} onClose={() => setShowSettings(false)} />}
          <AgentChat pw={pw} config={config} onSourced={(ui) => setSourcingRows(ui.rows)} goSourcing={() => setView("sourcing")} />
        </>}

        {view === "comps" && <CompTool pw={pw} />}

        {view === "sourcing" && <UnifiedSourcing pw={pw} rows={sourcingRows} setRows={setSourcingRows} />}

        {view === "corridors" && <CorridorsPage pw={pw} />}

        {view === "radar" && <LeaseRadar pw={pw} />}

        {view === "pipeline" && <Pipeline pw={pw} />}
        {view === "skiptrace" && <ManualSkipTrace pw={pw} />}

        {view === "nda" && <NDAReview pw={pw} />}

        {view === "screener" && (<>
        {showSettings && (
          <Settings config={config} setConfig={setConfig} presets={presets} setPresets={setPresets} onClose={() => setShowSettings(false)} />
        )}

        {/* Input */}
        <div style={{ marginTop: 22, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {["text", "pdf"].map((m) => (
              <button key={m} onClick={() => setMode(m)} className="mono"
                style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, border: `1px solid ${mode === m ? C.gold : C.line}`, background: mode === m ? C.goldSoft : "transparent", color: mode === m ? C.gold : C.muted }}>
                {m === "text" ? "PASTE TEXT" : "UPLOAD PDF"}
              </button>
            ))}
            <button onClick={() => { setMode("text"); setMemoText(SAMPLE_OM); }} className="mono"
              style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, marginLeft: "auto", border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>
              ✦ TRY SAMPLE DEAL
            </button>
          </div>

          {mode === "text" ? (
            <textarea value={memoText} onChange={(e) => setMemoText(e.target.value)} rows={7}
              placeholder="Paste the offering memorandum text here, or load the sample deal…"
              style={{ width: "100%", background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 9, padding: 14, fontSize: 13.5, lineHeight: 1.5, resize: "vertical", fontFamily: "Archivo, sans-serif" }} />
          ) : (
            <div onClick={() => fileRef.current?.click()} className="lift"
              style={{ cursor: "pointer", border: `1px dashed ${C.line}`, borderRadius: 9, padding: "30px 16px", textAlign: "center", background: C.ink }}>
              <div style={{ color: C.gold, fontSize: 22 }} className="serif">↑</div>
              <div style={{ marginTop: 6, fontSize: 14 }}>{fileName || "Drop a PDF offering memorandum, or click to browse"}</div>
              <input ref={fileRef} type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e) => onFile(e.target.files[0])} />
            </div>
          )}

          <button onClick={analyze} disabled={loading}
            style={{ marginTop: 14, width: "100%", cursor: loading ? "default" : "pointer", border: "none", borderRadius: 9, padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em", background: loading ? C.panel2 : C.gold, color: loading ? C.muted : "#ffffff" }}>
            {loading ? progress || "Working…" : `Screen this deal against “${config.name}” →`}
          </button>
          {error && <div style={{ marginTop: 12, color: C.red, fontSize: 13 }}>{error}</div>}
        </div>

        {result && <Results r={result} grade={grade} config={config} onJSON={exportJSON} onCSV={exportCSV} />}

        {!result && !loading && (
          <div style={{ marginTop: 22, color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
            <span className="serif" style={{ color: C.ivory, fontSize: 15 }}>What this does.</span> Reads a retail OM, pulls the underwriting
            data, breaks out the tenant roster by lease expiration and credit quality, recomputes the deal's own math to catch
            inconsistencies, and scores it against your buy box — editable in <strong>Grading criteria</strong> above with weight sliders,
            score thresholds, and free-text rules.
          </div>
        )}
        </>)}
          </div>
        </div>
      </main>
    </div>
  );
}

function Settings({ config, setConfig, presets, setPresets, onClose }) {
  const totalW = (config.criteria || []).reduce((a, c) => a + (Number(c.weight) || 0), 0) || 1;

  function updateCrit(id, patch) {
    setConfig((prev) => ({ ...prev, criteria: prev.criteria.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  }
  function addCrit() {
    setConfig((prev) => ({ ...prev, criteria: [...prev.criteria, { id: genId(), label: "New criterion", desc: "", weight: 10 }] }));
  }
  function removeCrit(id) {
    setConfig((prev) => ({ ...prev, criteria: prev.criteria.filter((c) => c.id !== id) }));
  }
  function setThreshold(key, v) {
    setConfig((prev) => ({ ...prev, thresholds: { ...prev.thresholds, [key]: v } }));
  }
  function loadPreset(name) {
    if (presets[name]) setConfig(clone(presets[name]));
  }
  function savePreset() {
    const name = (config.name || "Untitled").trim() || "Untitled";
    setPresets({ ...presets, [name]: clone({ ...config, name }) });
  }
  function deletePreset() {
    const name = config.name;
    if (!presets[name]) return;
    const next = { ...presets }; delete next[name];
    const remaining = Object.keys(next);
    if (!remaining.length) { next[DEFAULT_CONFIG.name] = clone(DEFAULT_CONFIG); }
    setPresets(next);
    // Load from `next`, not loadPreset(): loadPreset reads the STALE `presets` closure, so
    // deleting the last (re-seeded) preset would reload the just-deleted customized copy.
    setConfig(clone(next[Object.keys(next)[0]]));
  }

  const label = { fontSize: 11, color: C.muted, letterSpacing: "0.05em" };
  const field = { background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 7, padding: "8px 10px", fontSize: 13, fontFamily: "Archivo, sans-serif" };

  return (
    <div className="fade" style={{ marginTop: 18, background: C.panel, border: `1px solid ${C.gold}55`, borderRadius: 12, padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="serif" style={{ fontSize: 18 }}>Grading criteria</div>
        <button onClick={onClose} className="mono" style={{ cursor: "pointer", fontSize: 12, color: C.muted, background: "transparent", border: "none" }}>✕ CLOSE</button>
      </div>

      {/* Mandate / presets */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <div>
          <div className="mono" style={label}>SAVED MANDATE</div>
          <select value={presets[config.name] ? config.name : ""} onChange={(e) => loadPreset(e.target.value)} style={{ ...field, marginTop: 4, minWidth: 160 }}>
            {!presets[config.name] && <option value="">{config.name} (unsaved)</option>}
            {Object.keys(presets).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <div className="mono" style={label}>NAME</div>
          <input value={config.name} onChange={(e) => setConfig((p) => ({ ...p, name: e.target.value }))} style={{ ...field, marginTop: 4, width: 160 }} />
        </div>
        <button onClick={savePreset} className="mono lift" style={{ cursor: "pointer", fontSize: 12, padding: "8px 14px", borderRadius: 7, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold }}>↓ SAVE</button>
        <button onClick={deletePreset} className="mono lift" style={{ cursor: "pointer", fontSize: 12, padding: "8px 14px", borderRadius: 7, border: `1px solid ${C.line}`, background: "transparent", color: C.muted }}>DELETE</button>
      </div>

      {/* Criteria + weights */}
      <div className="mono" style={{ ...label, marginBottom: 8 }}>CRITERIA &amp; WEIGHTS</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {config.criteria.map((c) => {
          const pct = Math.round(((Number(c.weight) || 0) / totalW) * 100);
          return (
            <div key={c.id} style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input value={c.label} onChange={(e) => updateCrit(c.id, { label: e.target.value })} style={{ ...field, flex: "1 1 140px", fontWeight: 600 }} />
                <div className="mono" style={{ fontSize: 12, color: C.gold, width: 42, textAlign: "right" }}>{pct}%</div>
                <button onClick={() => removeCrit(c.id)} title="Remove" style={{ cursor: "pointer", border: "none", background: "transparent", color: C.muted, fontSize: 15 }}>✕</button>
              </div>
              <input value={c.desc} onChange={(e) => updateCrit(c.id, { desc: e.target.value })} placeholder="What does a high score mean for this factor?"
                style={{ ...field, width: "100%", marginTop: 8, color: C.muted }} />
              <input type="range" min="0" max="40" step="1" value={c.weight} onChange={(e) => updateCrit(c.id, { weight: Number(e.target.value) })} style={{ width: "100%", marginTop: 10 }} />
            </div>
          );
        })}
      </div>
      <button onClick={addCrit} className="mono lift" style={{ cursor: "pointer", marginTop: 10, fontSize: 12, padding: "8px 14px", borderRadius: 7, border: `1px dashed ${C.line}`, background: "transparent", color: C.ivory }}>+ ADD CRITERION</button>

      {/* Thresholds */}
      <div className="mono" style={{ ...label, margin: "20px 0 8px" }}>SCORE THRESHOLDS</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 }}>
        <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span>Pursue at or above</span><span className="mono" style={{ color: C.green }}>{config.thresholds.pursue}</span>
          </div>
          <input type="range" min="0" max="100" step="1" value={config.thresholds.pursue} onChange={(e) => setThreshold("pursue", Number(e.target.value))} style={{ width: "100%", marginTop: 8 }} />
        </div>
        <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span>Watch at or above</span><span className="mono" style={{ color: C.amber }}>{config.thresholds.watch}</span>
          </div>
          <input type="range" min="0" max="100" step="1" value={config.thresholds.watch} onChange={(e) => setThreshold("watch", Number(e.target.value))} style={{ width: "100%", marginTop: 8 }} />
        </div>
      </div>

      {/* Commands */}
      <div className="mono" style={{ ...label, margin: "20px 0 8px" }}>COMMANDS — RULES THE SLIDERS CAN'T CAPTURE</div>
      <textarea value={config.commands} onChange={(e) => setConfig((p) => ({ ...p, commands: e.target.value }))} rows={4}
        placeholder={"e.g.\n• Instant Pass if the anchor tenant is not investment-grade.\n• Penalize anything below 15,000 SF.\n• Only Pursue in primary gateway markets (NYC, LA, SF, Miami)."}
        style={{ width: "100%", background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 9, padding: 12, fontSize: 13, lineHeight: 1.5, resize: "vertical", fontFamily: "Archivo, sans-serif" }} />

      <div style={{ marginTop: 12, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
        Weights and thresholds re-score the current deal instantly. Changes to criteria, descriptions, or commands take effect the next time you screen a deal.
      </div>
    </div>
  );
}

function Results({ r, grade, config, onJSON, onCSV }) {
  const bb = r.buy_box || {};
  const crit = bb.criteria || {};
  const conf = r.confidence || {};
  const tenants = [...(r.tenants || [])].sort((a, b) => (a.expiration_year || 9999) - (b.expiration_year || 9999));
  const rec = (grade && grade.rec) || bb.recommendation || "Watch";
  const overall = grade ? grade.overall : (bb.overall_score ?? 0);
  const totalW = (config.criteria || []).reduce((a, c) => a + (Number(c.weight) || 0), 0) || 1;

  const metrics = [
    ["Asking price", r.asking_price, conf.asking_price],
    ["GLA", r.square_footage, conf.square_footage],
    ["Price / SF", r.price_per_sf, null],
    ["In-place NOI", r.in_place_noi, conf.in_place_noi],
    ["Going-in cap", r.cap_rate, conf.cap_rate],
    ["Occupancy", r.occupancy, conf.occupancy],
  ];

  return (
    <div className="fade" style={{ marginTop: 22 }}>
      {/* Deal header + score */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "stretch" }}>
        <div style={{ flex: "1 1 380px", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
          <div style={{ color: C.gold, fontSize: 11, letterSpacing: "0.08em" }} className="mono">{(r.asset_type || "RETAIL").toUpperCase()}</div>
          <div className="serif" style={{ fontSize: 26, marginTop: 4, lineHeight: 1.1 }}>{r.property_name || "Untitled asset"}</div>
          <div style={{ color: C.muted, fontSize: 14, marginTop: 6 }}>{r.address || "—"}</div>
          {r.submarket && <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>{r.submarket}{r.year_built ? ` · Built ${r.year_built}` : ""}</div>}
        </div>
        <div style={{ flex: "1 1 260px", background: C.panel, border: `1px solid ${recColor(rec)}55`, borderRadius: 12, padding: 20, display: "flex", alignItems: "center", gap: 18 }}>
          <Gauge score={overall} color={recColor(rec)} />
          <div>
            <div className="mono" style={{ fontSize: 11, color: C.muted, letterSpacing: "0.08em" }}>BUY-BOX FIT</div>
            <div className="serif" style={{ fontSize: 24, color: recColor(rec), fontWeight: 600 }}>{rec}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{config.name}</div>
          </div>
        </div>
      </div>

      {/* Rationale */}
      {bb.rationale && (
        <div style={{ marginTop: 16, background: C.goldSoft, border: `1px solid ${C.gold}40`, borderRadius: 12, padding: "14px 18px", fontSize: 14, lineHeight: 1.55 }}>
          <span className="serif" style={{ color: C.gold }}>Read. </span>{bb.rationale}
        </div>
      )}

      {/* Metrics */}
      <SectionTitle>Underwriting</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
        {metrics.map(([lab, val, c]) => (
          <div key={lab} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12, color: C.muted }}>{lab}</div>
            <div className="mono" style={{ fontSize: 18, marginTop: 4, color: val ? C.ivory : C.muted }}>{val || "not stated"}</div>
            {c && <ConfTag level={c} />}
          </div>
        ))}
      </div>

      {/* Reconciliation */}
      {r._checks?.length > 0 && (
        <>
          <SectionTitle>Math reconciliation <span style={{ color: C.muted, fontWeight: 400 }} className="mono">— recomputed from the memo's own figures</span></SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
            {r._checks.map((ck, i) => (
              <div key={i} style={{ background: C.panel, border: `1px solid ${ck.ok === false ? C.red + "66" : C.line}`, borderRadius: 10, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13 }}>{ck.label}</span>
                  <span className="mono" style={{ fontSize: 11, color: ck.ok == null ? C.muted : ck.ok ? C.green : C.red }}>
                    {ck.ok == null ? "NO CLAIM" : ck.ok ? "✓ TIES" : "✗ MISMATCH"}
                  </span>
                </div>
                <div className="mono" style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>computed {ck.computed} · stated {ck.stated}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Buy box breakdown — driven by the firm's criteria + weights */}
      <SectionTitle>Buy-box breakdown <span style={{ color: C.muted, fontWeight: 400 }} className="mono">— {config.name}, weighted</span></SectionTitle>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: "8px 18px" }}>
        {config.criteria.map((c) => {
          const cell = crit[c.id] || {};
          const score = typeof cell.score === "number" ? cell.score : null;
          const pct = Math.round(((Number(c.weight) || 0) / totalW) * 100);
          return (
            <div key={c.id} style={{ padding: "12px 0", borderBottom: `1px solid ${C.line}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
                <span>{c.label} <span className="mono" style={{ color: C.muted, fontSize: 11 }}>· {pct}% weight</span></span>
                <span className="mono" style={{ color: C.gold }}>{score == null ? "—" : score}</span>
              </div>
              <div style={{ height: 5, background: C.ink, borderRadius: 4, marginTop: 7, overflow: "hidden" }}>
                <div className="bar" style={{ width: `${score || 0}%`, height: "100%", background: C.gold, borderRadius: 4 }} />
              </div>
              {cell.note && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6 }}>{cell.note}</div>}
              {score == null && <div style={{ fontSize: 12, color: C.amber, marginTop: 6 }}>Not scored on the last run — re-screen to grade this criterion.</div>}
            </div>
          );
        })}
      </div>

      {/* Tenant roster */}
      {tenants.length > 0 && (
        <>
          <SectionTitle>Tenant roster <span style={{ color: C.muted, fontWeight: 400 }} className="mono">— by lease expiration</span></SectionTitle>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
            <div className="mono" style={{ display: "grid", gridTemplateColumns: "2fr 0.8fr 1fr 1.2fr", gap: 8, padding: "11px 16px", fontSize: 11, color: C.muted, letterSpacing: "0.05em", borderBottom: `1px solid ${C.line}` }}>
              <span>TENANT</span><span style={{ textAlign: "right" }}>SF</span><span>EXPIRES</span><span>CREDIT</span>
            </div>
            {tenants.map((t, i) => {
              const vacant = (t.name || "").toUpperCase() === "VACANT";
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 0.8fr 1fr 1.2fr", gap: 8, padding: "11px 16px", fontSize: 13.5, alignItems: "center", borderBottom: i < tenants.length - 1 ? `1px solid ${C.line}` : "none", opacity: vacant ? 0.55 : 1 }}>
                  <span>{t.name}{t.note ? <span style={{ color: C.muted, fontSize: 12 }}> · {t.note}</span> : ""}</span>
                  <span className="mono" style={{ textAlign: "right", color: C.muted }}>{t.sf ? t.sf.toLocaleString() : "—"}</span>
                  <span className="mono" style={{ color: C.muted }}>{t.lease_expiration || "—"}</span>
                  <CreditTag tier={t.credit_tier} />
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Export */}
      <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
        <button onClick={onCSV} className="lift mono" style={{ cursor: "pointer", fontSize: 12, padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXPORT CSV</button>
        <button onClick={onJSON} className="lift mono" style={{ cursor: "pointer", fontSize: 12, padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXPORT JSON</button>
        <span style={{ alignSelf: "center", color: C.muted, fontSize: 12 }}>Graded against “{config.name}”. Ready to drop into an underwriting model.</span>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div className="serif" style={{ fontSize: 17, margin: "26px 0 13px", color: C.ivory }}>{children}</div>;
}
function ConfTag({ level }) {
  const col = level === "high" ? C.green : level === "medium" ? C.amber : C.red;
  return <div className="mono" style={{ fontSize: 10, color: col, marginTop: 6, letterSpacing: "0.05em" }}>● {String(level).toUpperCase()} CONFIDENCE</div>;
}
function CreditTag({ tier }) {
  const map = { "investment-grade": C.green, national: C.gold, regional: C.amber, local: C.muted, vacant: C.muted };
  const col = map[(tier || "").toLowerCase()] || C.muted;
  return <span className="mono" style={{ fontSize: 11, color: col, textTransform: "capitalize" }}>{tier || "—"}</span>;
}
function Gauge({ score, color }) {
  const r = 30, circ = 2 * Math.PI * r, off = circ * (1 - Math.max(0, Math.min(100, score)) / 100);
  return (
    <svg width="78" height="78" viewBox="0 0 78 78">
      <circle cx="39" cy="39" r={r} fill="none" stroke={C.line} strokeWidth="7" />
      <circle cx="39" cy="39" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={off} transform="rotate(-90 39 39)"
        style={{ transition: "stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1)" }} />
      <text x="39" y="44" textAnchor="middle" className="mono" fill={C.ivory} fontSize="20">{Math.round(score)}</text>
    </svg>
  );
}

// ───────────────────────── Sourcing page ─────────────────────────

// POST + safely parse. If a serverless function times out or crashes, Vercel returns
// a non-JSON error page ("An error occurred…") — calling res.json() on that throws a
// cryptic "Unexpected token" error (and used to blank the screen). This reads the body
// as text and turns any non-JSON / error response into a clear, actionable message.
async function postJSON(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    const timedOut = res.status === 504 || res.status === 408 || /timeout|timed out/i.test(text);
    throw new Error(
      timedOut
        ? "The request timed out on the server. Try a smaller radius, fewer sources, or a tighter filter."
        : `The server returned an error (HTTP ${res.status}). Please try again in a moment.`
    );
  }
  // Anthropic error bodies pass through the endpoints verbatim as {error:{type,message}} —
  // an OBJECT, which `new Error(obj)` would render as "[object Object]". Extract the message.
  const errMsg = (e) => (typeof e === "string" ? e : e && e.message) || null;
  if (!res.ok) throw new Error(errMsg(data.error) || `Server error (HTTP ${res.status}).`);
  if (data.error) throw new Error(errMsg(data.error) || "The server reported an error.");
  return data;
}

// ── Engine 4: Scout, the orchestrating agent ────────────────────────────────────
// A chat that turns plain-English asks into engine calls. The agent LOOP RUNS IN THE
// BROWSER: /api/agent plans one step (a tool call, or the final written answer), the
// browser runs that tool against the real endpoint, feeds the result back, and repeats
// until Scout writes its answer. Keeping the loop client-side means each serverless
// call is short (no 60s timeout) and every existing engine is reused untouched.

// tool name -> how to run it. Each `body` returns the endpoint request body (the
// password is injected by the caller). Field names mirror what each endpoint accepts.
const TOOL_ROUTES = {
  search_properties: { url: "/api/search", label: "Searching properties", body: (a) => ({ market: "nyc", sources: ["pluto"], assetType: a.assetType || "retail", borough: a.borough, nearAddress: a.nearAddress, radiusMiles: a.radiusMiles || 0, limit: 50, minSqft: a.minSqft, minRetailSqft: a.minRetailSqft, minUnits: a.minUnits, builtAfter: a.builtAfter, builtBefore: a.builtBefore, devOnly: a.devOnly, minBuildable: a.minBuildable }) },
  retail_availability: { url: "/api/availability", label: "Screening corridor availability", body: (a) => ({ corridor: a.corridor, list: a.list, limit: a.limit }) },
  property_intel: { url: "/api/intel", label: "Pulling public records", body: (a) => ({ borough: a.borough, block: a.block, lot: a.lot, name: a.name }) },
  transaction_history: { url: "/api/history", label: "Reading ACRIS history", body: (a) => ({ borough: a.borough, block: a.block, lot: a.lot }) },
  owner_portfolio: { url: "/api/owner", label: "Mapping owner portfolio", body: (a) => ({ name: a.name }) },
  hidden_portfolio: { url: "/api/portfolio", label: "Finding hidden portfolio", body: (a) => ({ name: a.name }) },
  foot_traffic: { url: "/api/foottraffic", label: "Checking foot traffic", body: (a) => ({ lat: a.lat, lon: a.lon }) },
  sales_comps: { url: "/api/comps", label: "Pulling sale comps", body: (a) => ({ borough: a.borough, block: a.block }) },
  web_research: { url: "/api/research", label: "Researching owner", body: (a) => ({ mode: "web", name: a.name, address: a.address, borough: a.borough }) },
  web_search: { url: "/api/research", label: "Searching the web", body: (a) => ({ mode: "web", query: a.query }) },
  brand_radar: { url: "/api/research", label: "Scouting brands", body: (a) => ({ mode: "web", query: `Compile a list of NEW / trendy / emerging retail brands that are expanding into physical stores, opening flagships, or actively seeking retail space${a.market ? `, relevant to ${a.market}` : ""}${a.category ? `, in ${a.category}` : ""}. For each brand give: what they sell, their growth/expansion status, any reported new store locations or space requirements, and the source. Favor buzzy / DTC-going-physical / fast-growing brands over legacy chains. Cite sources.` }) },
  search_ct_properties: { url: "/api/search", label: "Searching Greenwich / CT", body: (a) => ({ market: "ct", town: a.town || "Greenwich", propertyType: a.propertyType, minValue: a.minPrice, maxValue: a.maxPrice, minSqft: a.minSqft, sinceYear: a.sinceYear, address: a.address }) },
  ct_sales_comps: { url: "/api/ctcomps", label: "Pulling CT sale comps", body: (a) => ({ town: a.town, propertyType: a.propertyType, address: a.address, sinceYear: a.sinceYear, minAmount: a.minAmount, maxAmount: a.maxAmount }) },
  ct_entity_lookup: { url: "/api/ctentity", label: "CT entity lookup", body: (a) => ({ name: a.name }) },
  tn_entity_lookup: { url: "/api/research", label: "TN entity lookup", body: (a) => ({ mode: "web", query: `Look up the Tennessee business entity "${a.name}" in the Tennessee Secretary of State business registry (TNBear / tncab.tnsos.gov) and OpenCorporates (opencorporates.com/companies/us_tn). Report exactly what the records show: the precise entity name, SOS control number, type (LLC / corporation), status (active / inactive / dissolved), formation date, the REGISTERED AGENT (name + full address — the key contact for an anonymous LLC), the principal office / mailing address, and any listed officers / members / managers. If several entities match the name, list the most likely with its address. Cite each source. Do NOT invent any detail that isn't in the records; if a field isn't public, say so.` }) },
  ca_entity_lookup: { url: "/api/research", label: "CA entity lookup", body: (a) => ({ mode: "web", query: `Look up the California business entity "${a.name}" in the California Secretary of State business registry (bizfileOnline at bizfileonline.sos.ca.gov) and OpenCorporates (opencorporates.com/companies/us_ca). Report exactly what the records show: the precise entity name, entity number, type (LLC / corporation), status (active / suspended / FTB-suspended / dissolved), registration/formation date, jurisdiction, the AGENT FOR SERVICE OF PROCESS (name + full address — this is the key contact for an anonymous LLC), the principal office / mailing address, and any listed managers / members / officers. If several entities match the name, list the most likely with its address. Cite each source. Do NOT invent any detail that isn't in the records; if a field isn't public, say so.` }) },
  sc_entity_lookup: { url: "/api/research", label: "SC entity lookup", body: (a) => ({ mode: "web", query: SC_ENTITY_QUERY(a.name) }) },
  search_hamptons_properties: { url: "/api/search", label: "Searching the Hamptons", body: (a) => ({ market: "hamptons", town: a.town || "all", propertyType: a.propertyType, minValue: a.minValue, address: a.address }) },
  search_ma_properties: { url: "/api/search", label: "Searching Massachusetts", body: (a) => ({ market: "ma", town: a.town, propertyType: a.propertyType, minValue: a.minValue, maxValue: a.maxValue, minSqft: a.minSqft, sinceYear: a.sinceYear, address: a.address }) },
  search_nashville_properties: { url: "/api/search", label: "Searching Nashville", body: (a) => ({ market: "nashville", propertyType: a.propertyType, address: a.address, minValue: a.minValue, maxValue: a.maxValue, minAcres: a.minAcres, sinceYear: a.sinceYear }) },
  search_charleston_properties: { url: "/api/search", label: "Searching Charleston", body: (a) => ({ market: "charleston", propertyType: a.propertyType, address: a.address, owner: a.owner, minValue: a.minValue, maxValue: a.maxValue, minAcres: a.minAcres, sinceYear: a.sinceYear }) },
  search_savannah_properties: { url: "/api/search", label: "Searching Savannah", body: (a) => ({ market: "savannah", propertyType: a.propertyType, address: a.address, owner: a.owner, minValue: a.minValue, maxValue: a.maxValue, minAcres: a.minAcres, sinceYear: a.sinceYear }) },
  nashville_property_intel: { url: "/api/nashvilleintel", label: "Pulling Nashville records", body: (a) => ({ apn: a.apn, address: a.address }) },
  charleston_property_intel: { url: "/api/charlestonintel", label: "Pulling Charleston records", body: (a) => ({ pid: a.pid, address: a.address }) },
  search_sf_properties: { url: "/api/search", label: "Searching San Francisco", body: (a) => ({ market: "sf", neighborhood: a.neighborhood, address: a.address, propertyType: a.propertyType, minValue: a.minValue, maxValue: a.maxValue, minSqft: a.minSqft }) },
  sf_property_intel: { url: "/api/sfintel", label: "Pulling SF records", body: (a) => ({ block: a.block, lot: a.lot, address: a.address }) },
  grade_offering_memo: { label: "Grading offering memo" }, // executed specially in runTool (PDF/text + mandate)
  review_nda: { label: "Reviewing NDA" }, // executed specially in runTool (PDF/text + NDA playbook)
  reveal_contact: { url: "/api/skiptrace", label: "Revealing contact", paid: true, body: (a) => ({ name: a.name, entity_type: a.entity_type, contact_address: a.contact_address, city: a.city, state: a.state, zip: a.zip, address: a.address, borough: a.borough }) },
};

// Keep the model's view of a search result small (token + cost control): only the
// fields it needs to reason and to drive follow-on tools.
function pickLeadFields(r) {
  return {
    name: r.name, entity_type: r.entity_type, address: r.address, borough: r.borough,
    block: r.block, lot: r.lot, lat: r.lat, lon: r.lon,
    // Mailing address as discrete fields only (reveal_contact needs them); the model can
    // read them as-is — no need to also send a pre-joined string (duplicate tokens × leads × turns).
    contact_address: r.contact_address, city: r.city, state: r.state, zip: r.zip,
    years_owned: r.years_owned, last_sale_date: r.last_sale_date, last_sale_price: r.last_sale_price,
    absentee: r.absentee || null, tax_lien: r.tax_lien || false, buildable_sqft: r.buildable_sqft || null,
    retail_sqft: r.retail_sqft || null, portfolio_count: r.portfolio_count || null,
    distance: r.distance ?? null,
  };
}

const SPEND_KEY = "fr_skiptrace_spend_v1";
// Same {hits, est} shape as readSkipSpend/bumpSkipSpend (the dossier's ContactReveal) —
// this key has TWO writers (Scout's reveal_contact lands here too), and a plain-number
// write used to corrupt the dossier's counter (and vice versa). One reveal = one hit.
function addSpend(amount) {
  try {
    const cur = JSON.parse(localStorage.getItem(SPEND_KEY) || "{}");
    const base = typeof cur === "number" ? { hits: 0, est: cur } : cur; // migrate legacy plain-number value
    localStorage.setItem(SPEND_KEY, JSON.stringify({
      hits: (Number(base.hits) || 0) + 1,
      est: Math.round(((Number(base.est) || 0) + (Number(amount) || 0)) * 100) / 100,
    }));
  } catch { /* quota */ }
}

// Scout web-research spend tracking + monthly cap (client-side guardrail; cost is an
// estimate, ~$0.30 per live web run). Resets automatically each calendar month.
const SCOUT_SPEND_KEY = "fr_scout_spend_v1", SCOUT_CAP_KEY = "fr_scout_cap_v1", SCOUT_MODE_KEY = "fr_scout_mode_v1";
// Per deep web-research run. Bumped 0.15 -> 0.30 after depth was raised (up to 8 web
// searches + longer briefs), so the monthly spend tracker stays roughly honest.
const WEB_RUN_COST = 0.30;
const MAX_AGENT_STEPS = 10; // cap tool steps per request. The system prompt tells Scout to chain
// search -> intel/history/foot_traffic -> portfolio -> web_research and "go deep"; 6 cut routine
// dossiers off mid-chain (esp. when calls run one-at-a-time). Free tools dominate, so 10 buys depth
// without much cost; web calls are still gated by the prompt.
const DEEP_RESEARCH_STEPS = 24; // higher budget in Deep Research mode (opt-in, exhaustive)
// Final guard on how much of a (already array-bounded by shapeResult) tool result the model sees.
// Was a blind 14k .slice() that could cut mid-JSON and silently drop whole layers of rich free
// intel; raised + made truncation explicit so the model never reasons over malformed/half-dropped data.
const TOOL_RESULT_CHARS = 30000;
const SCOUT_DEEP_KEY = "fr_scout_deepresearch_v1";
const curMonth = () => new Date().toISOString().slice(0, 7);
function scoutSpend() { try { const o = JSON.parse(localStorage.getItem(SCOUT_SPEND_KEY) || "{}"); return o.month === curMonth() ? (Number(o.spent) || 0) : 0; } catch { return 0; } }
function addScoutSpend(amt) { try { localStorage.setItem(SCOUT_SPEND_KEY, JSON.stringify({ month: curMonth(), spent: scoutSpend() + amt })); } catch { /* quota */ } }
function scoutCap() { try { const v = Number(localStorage.getItem(SCOUT_CAP_KEY)); return Number.isFinite(v) && v > 0 ? v : 25; } catch { return 25; } }
function setScoutCapLS(n) { try { localStorage.setItem(SCOUT_CAP_KEY, String(n)); } catch { /* quota */ } }
// Effective research mode for ANY web-research caller (Scout, dossier, comp sheet):
// honors the global Quick/Deep toggle and the monthly cap. Over cap or in Quick →
// "knowledge" (no paid web search). Use with addScoutSpend when it returns "web".
function webResearchMode() {
  try {
    const m = localStorage.getItem(SCOUT_MODE_KEY) || "deep";
    if (m !== "deep") return "knowledge";
    return scoutSpend() >= scoutCap() ? "knowledge" : "web";
  } catch { return "web"; }
}

// ── Token + cost tracker ────────────────────────────────────────────────────────
// Real Anthropic usage (not an estimate): every AI response carries a `usage` object
// (input / output / cache-read / cache-write tokens, + web_search_requests). We tally it
// per calendar month in localStorage and price it. Built to extend per-user when the team
// hub lands (today it's per-browser). Pricing = Claude Sonnet 4.6 (the agent + research
// default), USD per 1M tokens; web search is $/request.
const TOKEN_KEY = "fr_token_usage_v1";
// Per-model pricing ($/1M tokens) so Opus Deep Research is costed correctly, not at Sonnet
// rates. Cache read = 0.1x input, cache write (5m) = 1.25x input. Web search = $/request.
const MODEL_PRICE = {
  opus: { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
const WEB_SEARCH_PRICE = 0.01; // $ per web_search request
const priceFor = (model) => { const m = String(model || "").toLowerCase(); return m.includes("opus") ? MODEL_PRICE.opus : m.includes("haiku") ? MODEL_PRICE.haiku : MODEL_PRICE.sonnet; };
const blankUsage = () => ({ month: curMonth(), in: 0, out: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0, calls: 0, cost: 0 });
function tokenUsage() { try { const o = JSON.parse(localStorage.getItem(TOKEN_KEY) || "{}"); return o && o.month === curMonth() ? o : blankUsage(); } catch { return blankUsage(); } }
function recordUsage(u, model) {
  const cur = tokenUsage();
  if (u) {
    const p = priceFor(model);
    const inTok = u.input_tokens || 0, outTok = u.output_tokens || 0;
    const cR = u.cache_read_input_tokens || 0, cW = u.cache_creation_input_tokens || 0;
    const web = u.web_search_requests || (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
    cur.in += inTok; cur.out += outTok; cur.cacheRead += cR; cur.cacheWrite += cW; cur.webSearch += web; cur.calls += 1;
    cur.cost += (inTok * p.in + outTok * p.out + cR * p.cacheRead + cW * p.cacheWrite) / 1e6 + web * WEB_SEARCH_PRICE;
  }
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(cur)); } catch { /* quota */ }
  return cur;
}
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n || 0));

// Trim a web-research/brand_radar response down to just the brief — `model` and
// `stop_reason` are noise that would ride along in context on every later turn.
function shapeWebResult(data) {
  if (!data || typeof data !== "object") return data;
  if (data.error || data.noKey) return data;
  // Keep the brief + the verifiable sources (so Scout can cite them as links); drop the rest.
  return data.brief ? { brief: data.brief, ...(data.sources && data.sources.length ? { sources: data.sources } : {}) } : data;
}

// Trim/summarize an endpoint's response into { forModel, uiSummary }. The forModel
// payload is appended to the conversation and RE-SENT on every subsequent agent turn,
// so keeping it lean is the main token lever for Scout — cap arrays and drop fields the
// model never reasons over (coords, document ids, etc.).
function shapeResult(name, data) {
  if (name === "search_properties") {
    const leads = (data.leads || []).slice(0, 15).map(pickLeadFields);
    const n = leads.length;
    return { forModel: { count: data.counts?.deals ?? n, center: data.center, leads }, uiSummary: `${n} propert${n === 1 ? "y" : "ies"}` };
  }
  if (name === "retail_availability") {
    if (data.corridors) return { forModel: data, uiSummary: data.no_match ? "no corridor match — returned the configured list" : `${data.corridors.length} corridor${data.corridors.length === 1 ? "" : "s"} configured` };
    // The engine can emit hundreds of ranked rows; the model only needs the head of the
    // ranking (it's already sorted) + the coverage report to caveat thin data honestly.
    const all = data.rows || [];
    const rows = all.slice(0, 20);
    return {
      forModel: {
        corridor: data.corridor, candidate_count: data.candidate_count,
        rows, ...(all.length > rows.length ? { note: `showing top ${rows.length} of ${data.candidate_count} ranked candidates — ask with a higher limit if the user wants deeper cuts` } : {}),
        coverage: data.coverage,
      },
      uiSummary: `${data.candidate_count} candidates in ${data.corridor?.name || "corridor"}`,
    };
  }
  if (name === "search_ct_properties" || name === "search_hamptons_properties" || name === "search_ma_properties") {
    const props = (data.properties || []).slice(0, 30);
    return { forModel: { count: data.count, town: data.town, note: data.note, properties: props }, uiSummary: `${data.count || 0} in ${data.town || "area"}` };
  }
  if (name === "search_nashville_properties") {
    const props = (data.properties || []).slice(0, 30);
    return { forModel: { count: data.count, county: data.county, note: data.note, properties: props }, uiSummary: `${data.count || 0} in Nashville` };
  }
  if (name === "search_charleston_properties") {
    const props = (data.properties || []).slice(0, 30);
    return { forModel: { count: data.count, county: data.county, note: data.note, properties: props }, uiSummary: `${data.count || 0} in Charleston` };
  }
  if (name === "search_savannah_properties") {
    const props = (data.properties || []).slice(0, 30);
    return { forModel: { count: data.count, county: data.county, note: data.note, properties: props }, uiSummary: `${data.count || 0} in Savannah` };
  }
  if (name === "search_sf_properties") {
    const props = (data.properties || []).slice(0, 30);
    return { forModel: { count: data.count, neighborhood: data.neighborhood, note: data.note, properties: props }, uiSummary: `${data.count || 0} in SF` };
  }
  if (name === "sf_property_intel") {
    // Endpoint already caps each section; pass through (it's the bounded SF analog of intel).
    return { forModel: data, uiSummary: "SF records" };
  }
  if (name === "nashville_property_intel") {
    // Endpoint already caps each section; pass through (the TN analog of intel).
    const sig = (data.building_permits?.signals || []).length;
    return { forModel: data, uiSummary: sig ? `Nashville records (${sig} permit signal${sig === 1 ? "" : "s"})` : "Nashville records" };
  }
  if (name === "charleston_property_intel") {
    // Endpoint already caps each section; pass through (the SC analog of intel).
    return { forModel: data, uiSummary: "Charleston records" };
  }
  if (name === "property_intel") {
    // Already mostly scalars; just cap the two list fields the model doesn't need in full.
    const officers = (data.officers || []).slice(0, 6);
    const businesses = (data.businesses || []).slice(0, 6);
    return { forModel: { ...data, officers, businesses }, uiSummary: "public records" };
  }
  if (name === "transaction_history") {
    // ACRIS can return hundreds of docs; keep the 20 most recent and drop document_id
    // (an internal key the model never uses), capping parties per doc.
    const all = data.history || [];
    const history = all.slice(0, 20).map((h) => ({
      doc: h.doc_label || h.doc_type, date: h.date, amount: h.amount,
      parties: (h.parties || []).slice(0, 4),
    }));
    return { forModel: { count: all.length, history }, uiSummary: `${all.length} record${all.length === 1 ? "" : "s"}` };
  }
  if (name === "owner_portfolio") {
    // Can be up to 500 lots — the worst offender. Keep the count + total and only the
    // top ~20 properties by assessed value (already sorted DESC by the endpoint).
    const all = data.properties || [];
    const properties = all.slice(0, 20).map((p) => ({
      address: p.address, borough: p.borough, bldgclass: p.bldgclass, assessed: p.assessed, block: p.block, lot: p.lot,
    }));
    return { forModel: { count: data.count ?? all.length, total_assessed: data.total_assessed, properties }, uiSummary: `${data.count ?? all.length} properties` };
  }
  if (name === "hidden_portfolio") {
    const all = data.buildings || [];
    return { forModel: { person: data.person, count: data.count ?? all.length, buildings: all.slice(0, 25) }, uiSummary: `${data.count ?? all.length} buildings` };
  }
  if (name === "sales_comps") {
    const all = data.comps || [];
    return { forModel: { count: all.length, comps: all.slice(0, 15) }, uiSummary: `${all.length} comps` };
  }
  if (name === "ct_sales_comps") {
    const all = data.comps || [];
    return { forModel: { count: data.count ?? all.length, town: data.town, note: data.note, comps: all.slice(0, 20) }, uiSummary: `${data.count ?? all.length} CT comps` };
  }
  if (name === "reveal_contact") {
    if (data.noKey) return { forModel: data, uiSummary: "skip-trace not configured" };
    const matched = data.matched || data.hit;
    const cost = Number(data.cost) || 0;
    if (matched && cost) addSpend(cost);
    return { forModel: data, uiSummary: matched ? `contact found${cost ? ` ($${cost.toFixed(2)})` : ""}` : "no match" };
  }
  return { forModel: data, uiSummary: "done" };
}

const AGENT_EXAMPLES = [
  "Find absentee retail owners within 0.25 mi of 120 5 AVENUE, Manhattan who've held 15+ years",
  "Who owns 103 PRINCE STREET, Manhattan and what distress signals are on it?",
  "Scout SoHo for trophy retail with maturing debt or tax liens and rank the best targets",
];

// One-click Deep Research recipes — structured templates so every analyst's deep dive
// follows the same rigorous shape. Clicking turns Deep Research on and drops the template
// (with a <…> slot to fill) into the box; the user fills the target and hits RESEARCH.
const RESEARCH_PLAYBOOKS = [
  ["🏛️ Owner-unmasking dossier", "Deep research: who really owns <ADDRESS>? Unmask the owning LLC to its principals, map their portfolio across entities, and give me every verified way to reach the decision-maker — with sources."],
  ["⚑ Distress / motivation report", "Deep research <ADDRESS>: how motivated is the owner to sell? Pull EVERY distress and intent signal (recorded debt/maturity, liens, violations & penalties, evictions, retrofit, vacancy, hold period, absentee), weigh them, and give a motivation read — with sources."],
  ["🗺️ Corridor sweep", "Deep research the <NEIGHBORHOOD / CORRIDOR> retail corridor: surface the most motivated trophy-retail owners and rank the best 5–10 targets, each with the why and the contact path — with sources."],
  ["🛍️ Tenant / brand match", "Deep research: which new or expanding retail brands fit <ADDRESS / CORRIDOR>? Match the space to brands actively opening stores or seeking space, and explain the fit — with sources."],
];

// Extract mappable items from a Scout tool result (NYC leads or any market's properties), so the
// transcript can drop a map under a search. Returns null for non-spatial results (single-property
// intel, web research, etc.).
function scoutMapData(fm) {
  if (!fm || typeof fm !== "object") return null;
  let items = null;
  if (Array.isArray(fm.leads)) items = fm.leads.map((l) => ({ address: l.address, city: "New York", lat: l.lat ?? null, lon: l.lon ?? null, label: [l.address, l.name].filter(Boolean).join(" — ") }));
  else if (Array.isArray(fm.properties)) items = fm.properties.map((p) => ({ address: p.address, city: p.city || p.town || "", lat: p.lat ?? p.latitude ?? null, lon: p.lon ?? p.longitude ?? null, label: [p.address, p.owner].filter(Boolean).join(" — ") }));
  else if (Array.isArray(fm.rows)) items = fm.rows.filter((r) => r.address).map((r) => ({ address: r.address, city: r.city || r.town || "New York", lat: r.lat ?? null, lon: r.lon ?? null, label: [r.address, r.ownership_entity].filter(Boolean).join(" — ") })); // corridor availability screen (NYC or Charleston — rows carry their city)
  if (!items || !items.length) return null;
  return { items, center: fm.center || null };
}

// Display-only map for Scout's transcript. Uses coords when present (NYC), geocodes the rest.
function ScoutMap({ items, center }) {
  const [points, setPoints] = useState(() => items.map((it, i) => ({ id: i, lat: it.lat != null ? Number(it.lat) : null, lon: it.lon != null ? Number(it.lon) : null, label: it.label || it.address })));
  useEffect(() => {
    let alive = true;
    const miss = points.filter((p) => (p.lat == null || p.lon == null) && items[p.id] && items[p.id].address);
    (async () => {
      for (let i = 0; i < miss.length && i < 40; i += 4) {
        const got = await Promise.all(miss.slice(i, i + 4).map(async (p) => {
          const it = items[p.id];
          const g = await geocodeAddress(`${it.address}, ${it.city || ""}`);
          return g ? { id: p.id, ...g } : null;
        }));
        if (!alive) return;
        setPoints((prev) => { const n = prev.slice(); for (const g of got) if (g) { const idx = n.findIndex((x) => x.id === g.id); if (idx >= 0) n[idx] = { ...n[idx], lat: g.lat, lon: g.lon }; } return n; });
      }
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!points.some((p) => p.lat != null && p.lon != null)) return null;
  return (
    <div style={{ margin: "8px 0 4px" }}>
      <div className="mono" style={{ fontSize: 10, color: C.muted, marginBottom: 6 }}>◎ {points.filter((p) => p.lat != null).length} located</div>
      <PropertyMap points={points} center={center || points.find((p) => p.lat != null)} height={300} />
    </div>
  );
}

// Convert a Scout search tool result into Sourcing-tab rows (same shape the manual search uses),
// so a Scout-driven search populates the Sourcing tab's table + map + dossiers. Null for tools that
// aren't a mappable property search, or markets the Sourcing tab doesn't render (SF/MA).
function sourcingRowsFrom(name, data) {
  if (!data || data.error) return null;
  if (name === "search_properties") return { market: "nyc", center: data.center || null, rows: (data.leads || []).map(nycRow) };
  if (name === "search_nashville_properties") return { market: "tn", center: null, rows: (data.properties || []).map(nashRow) };
  if (name === "search_charleston_properties") return { market: "sc", center: null, rows: (data.properties || []).map(scRow) };
  if (name === "search_savannah_properties") return { market: "savannah", center: null, rows: (data.properties || []).map(savRow) };
  if (name === "search_ct_properties") return { market: "ct", center: null, rows: (data.properties || []).map(ctRow) };
  if (name === "search_hamptons_properties") return { market: "ny", center: null, rows: (data.properties || []).map(nyRow) };
  return null;
}

function AgentChat({ pw, config, onSourced, goSourcing }) {
  const [log, setLog] = useState([]);        // render transcript
  const [convo, setConvo] = useState([]);    // raw Anthropic-format messages
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachedDoc, setAttachedDoc] = useState(null); // { name, kind:"pdf"|"text", data|text } — an OM/NDA PDF to grade, or a CSV/text list of leads to rank
  const [mode, setModeState] = useState(() => { try { return localStorage.getItem(SCOUT_MODE_KEY) || "deep"; } catch { return "deep"; } });
  const [spend, setSpend] = useState(scoutSpend());
  const [cap, setCapState] = useState(scoutCap());
  const [deepResearch, setDeepState] = useState(() => { try { return localStorage.getItem(SCOUT_DEEP_KEY) === "1"; } catch { return false; } });
  const [tokens, setTokens] = useState(() => tokenUsage());
  const setMode = (m) => { setModeState(m); try { localStorage.setItem(SCOUT_MODE_KEY, m); } catch { /* quota */ } };
  const setDeep = (v) => { setDeepState(v); try { localStorage.setItem(SCOUT_DEEP_KEY, v ? "1" : "0"); } catch { /* quota */ } };
  const idRef = useRef(0);
  const scrollRef = useRef(null);
  const fileRef = useRef(null);
  // AgentChat is conditionally rendered (tab switch unmounts it), but runLoop is a plain
  // async loop — without this flag it would keep calling /api/agent and PAID tools
  // invisibly after unmount. Checked between steps to stop the run (and the spend).
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  // Dedupe identical tool calls within a session: same tool + same args -> reuse the
  // shaped result instead of re-hitting the endpoint and burning an agent turn. Keyed by
  // name+args (web tools also key on mode, since deep vs quick yields a different answer).
  const toolCacheRef = useRef(new Map());

  // Accept a PDF (offering memo / NDA to grade) OR a CSV/text list of leads to rank ("who do I
  // call first"). Text files are read as text and injected into Scout's context so it can read and
  // rank the rows; PDFs stay base64 and route to the OM/NDA grader tools.
  const onAttach = (f) => {
    if (!f) return;
    const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    const isText = /csv|tab-separated|plain|text/.test(f.type || "") || /\.(csv|tsv|txt|md)$/i.test(f.name);
    if (isPdf) {
      const reader = new FileReader();
      reader.onload = () => setAttachedDoc({ name: f.name, kind: "pdf", data: reader.result.split(",")[1] });
      reader.readAsDataURL(f);
    } else if (isText) {
      const reader = new FileReader();
      reader.onload = () => {
        let text = String(reader.result || "");
        const MAX = 60000; // cap so the list doesn't blow the agent's re-sent context
        const truncated = text.length > MAX;
        if (truncated) text = text.slice(0, MAX);
        setAttachedDoc({ name: f.name, kind: "text", text, truncated });
      };
      reader.readAsText(f);
    } else {
      setLog((l) => [...l, { kind: "error", text: "Attach a PDF (offering memo / NDA) or a CSV/TXT list of owners to rank. For Excel, use File → Save As → CSV first." }]);
    }
  };

  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log, busy]);

  const pushTool = (name) => {
    const id = ++idRef.current;
    setLog((l) => [...l, { kind: "tool", id, name, label: TOOL_ROUTES[name]?.label || name, status: "running" }]);
    return id;
  };
  const updateTool = (id, status, detail) => setLog((l) => l.map((e) => (e.id === id ? { ...e, status, detail } : e)));

  const runTool = async (name, inputArgs) => {
    // Offering-memo grading: feed the attached PDF (or pasted text) + the firm's active
    // mandate to the screener endpoint. Handled here because it isn't a simple body map.
    if (name === "grade_offering_memo") {
      let body;
      if (attachedDoc && attachedDoc.kind === "pdf") body = { password: pw, mode: "pdf", pdfData: attachedDoc.data, config };
      else if (inputArgs.memo_text) body = { password: pw, mode: "text", memoText: inputArgs.memo_text, config };
      else return { forModel: { error: "No offering memo provided — ask the user to attach the OM PDF (📎) or paste its text." }, uiSummary: "no OM" };
      const data = await postJSON("/api/screen", body);
      return { forModel: data, uiSummary: (attachedDoc && attachedDoc.kind === "pdf") ? `graded ${attachedDoc.name}` : "graded OM" };
    }
    // NDA redline against the firm's NDA playbook (loaded from localStorage), same
    // PDF/text mechanism as the OM grader.
    if (name === "review_nda") {
      let body;
      if (attachedDoc && attachedDoc.kind === "pdf") body = { password: pw, mode: "pdf", pdfData: attachedDoc.data, config: loadNdaActive() };
      else if (inputArgs.nda_text) body = { password: pw, mode: "text", ndaText: inputArgs.nda_text, config: loadNdaActive() };
      else return { forModel: { error: "No NDA provided — ask the user to attach the NDA PDF (📎) or paste its text." }, uiSummary: "no NDA" };
      const data = await postJSON("/api/nda", body);
      return { forModel: data, uiSummary: (attachedDoc && attachedDoc.kind === "pdf") ? `reviewed ${attachedDoc.name}` : "reviewed NDA" };
    }
    // Web research/search: honor Quick (knowledge, free-ish) vs Deep (live web, paid) and
    // the monthly spend cap. Over cap, deep auto-downgrades to knowledge so nothing breaks.
    if (name === "web_research" || name === "web_search" || name === "brand_radar" || name === "ca_entity_lookup" || name === "tn_entity_lookup" || name === "sc_entity_lookup") {
      const overCap = scoutSpend() >= cap;
      const deep = mode === "deep" && !overCap;
      const wKey = `${name}:${deep ? "web" : "knowledge"}:${JSON.stringify(inputArgs)}`;
      const wHit = toolCacheRef.current.get(wKey);
      if (wHit) return { ...wHit, uiSummary: `${wHit.uiSummary} (cached)` };
      const data = await postJSON(TOOL_ROUTES[name].url, { password: pw, ...TOOL_ROUTES[name].body(inputArgs), mode: deep ? "web" : "knowledge" });
      if (data && data.usage) setTokens(recordUsage(data.usage, data.model));
      if (deep) { addScoutSpend(WEB_RUN_COST); setSpend(scoutSpend()); }
      const out = { forModel: shapeWebResult(data), uiSummary: deep ? "web research" : (overCap ? "quick take (cap reached)" : "quick take") };
      if (!data.error) toolCacheRef.current.set(wKey, out);
      return out;
    }
    const route = TOOL_ROUTES[name];
    if (!route || !route.url) return { forModel: { error: `Unknown tool ${name}` }, uiSummary: "unknown tool" };
    if (route.paid) {
      const ok = typeof window !== "undefined" && window.confirm(`This runs a PAID skip trace (~$0.10, billed only on a match) for ${inputArgs.name || "this owner"}. Proceed?`);
      if (!ok) return { forModel: { declined: true, note: "User declined the paid skip trace." }, uiSummary: "declined" };
      const data = await postJSON(route.url, { password: pw, ...route.body(inputArgs) });
      return shapeResult(name, data); // never cache a paid lookup
    }
    // Free structured lookups: serve from the session cache on an identical repeat call.
    const key = `${name}:${JSON.stringify(inputArgs)}`;
    const hit = toolCacheRef.current.get(key);
    if (hit) return { ...hit, uiSummary: `${hit.uiSummary} (cached)` };
    const data = await postJSON(route.url, { password: pw, ...route.body(inputArgs) });
    const out = shapeResult(name, data);
    if (!data.error) { out.ui = sourcingRowsFrom(name, data); toolCacheRef.current.set(key, out); }
    return out;
  };

  // One request = run the agent loop to completion (or the safety step cap). Deep Research
  // mode lifts the step budget and tells the backend to plan → investigate → write a report.
  const runLoop = async (messages, deep = false) => {
    const maxSteps = deep ? DEEP_RESEARCH_STEPS : MAX_AGENT_STEPS;
    for (let turn = 0; turn < maxSteps; turn++) {
      if (!aliveRef.current) return; // tab switched away — stop the run instead of spending invisibly
      const data = await postJSON("/api/agent", { password: pw, messages, deepResearch: deep });
      if (!aliveRef.current) return;
      if (data && data.usage) setTokens(recordUsage(data.usage, data.model));
      const content = data.content || [];
      const toolUses = [];
      for (const block of content) {
        if (block.type === "text" && block.text.trim()) setLog((l) => [...l, { kind: "assistant", text: block.text }]);
        if (block.type === "tool_use") toolUses.push(block);
      }
      messages.push({ role: "assistant", content });           // must include tool_use blocks verbatim
      if (data.stop_reason !== "tool_use" || !toolUses.length) { setConvo([...messages]); return; }

      const results = [];
      for (const tu of toolUses) {
        if (!aliveRef.current) return; // don't start more (possibly paid) tool calls after unmount
        const id = pushTool(tu.name);
        try {
          const out = await runTool(tu.name, tu.input || {});
          updateTool(id, "done", out.uiSummary);
          const md = scoutMapData(out.forModel);
          if (md) setLog((l) => [...l, { kind: "map", items: md.items, center: md.center }]);
          if (out.ui && out.ui.rows && out.ui.rows.length) { if (onSourced) onSourced(out.ui); setLog((l) => [...l, { kind: "sourced", count: out.ui.rows.length }]); }
          let payload = JSON.stringify(out.forModel);
          if (payload.length > TOOL_RESULT_CHARS) {
            // shapeResult already caps arrays, so this is a rare belt-and-suspenders trim.
            // Tell the model explicitly rather than handing it silently-cut JSON.
            payload = payload.slice(0, TOOL_RESULT_CHARS) + ' …[result truncated for length — ask to narrow if you need the rest]';
          }
          results.push({ type: "tool_result", tool_use_id: tu.id, content: payload });
        } catch (e) {
          updateTool(id, "error", e.message);
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: e.message });
        }
      }
      messages.push({ role: "user", content: results });
    }
    setConvo([...messages]);
    setLog((l) => [...l, { kind: "error", text: "Reached the step limit for this run. Ask me to continue if you need more." }]);
  };

  const send = async (preset) => {
    let text = (preset ?? input).trim();
    const doc = attachedDoc;
    if (!text && doc) text = doc.kind === "text"
      ? "Here's a list — rank which owners I should call first, and tell me why for each."
      : "Here's a document — grade it if it's an offering memo, or redline it against our playbook if it's an NDA.";
    if (!text || busy) return;
    setInput("");
    let note = "";
    if (doc && doc.kind === "pdf") {
      note = `\n\n[The user attached a PDF: ${doc.name}. Use grade_offering_memo if it's an offering memo, or review_nda if it's an NDA — pick from their request.]`;
    } else if (doc && doc.kind === "text") {
      // Put the list in-context so Scout reads the actual rows, plus the call-priority rubric.
      note = `\n\n--- ATTACHED LIST (${doc.name})${doc.truncated ? " — truncated to fit" : ""} ---\n${doc.text}\n--- END LIST ---\n\n[The user uploaded this list. If they're asking who to CALL / CONTACT FIRST, RANK the rows by how likely each owner is to be a motivated seller — weight signals like long ownership tenure, absentee / out-of-state owner, distress (violations, tax liens, vacancy), single-asset LLCs, and any notes already in the list. Use the columns present; for addresses in a supported market you MAY look up a few of the TOP candidates with the sourcing/intel tools to confirm, but do NOT run dozens of lookups. Return a clear ranked call order with a one-line reason for each.]`;
    }
    const messages = [...convo, { role: "user", content: [{ type: "text", text: text + note }] }];
    setConvo(messages);
    setLog((l) => [...l, { kind: "user", text: doc ? `${text}  📎 ${doc.name}` : text }]);
    setBusy(true);
    try { await runLoop(messages, deepResearch); }
    catch (e) { setLog((l) => [...l, { kind: "error", text: e.message }]); }
    finally { setBusy(false); setAttachedDoc(null); }
  };

  const reset = () => { setLog([]); setConvo([]); };

  return (
    <div style={{ marginTop: 22 }}>
      <div ref={scrollRef} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, minHeight: 360, maxHeight: 560, overflowY: "auto" }}>
        {log.length === 0 && !busy && (
          <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
            <div style={{ color: C.ivory, fontWeight: 600, marginBottom: 8 }}>Hi — I'm Scout. ✦</div>
            Ask me to source owners, read a property, check distress, map a portfolio, research who's behind an LLC, grade an offering memo, or redline an NDA (📎 attach the PDF). I'll run the right engines and give you the read. Try:
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
              {AGENT_EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => send(ex)} className="lift" style={{ textAlign: "left", cursor: "pointer", fontSize: 12.5, padding: "10px 13px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.ink, color: C.ivory }}>{ex}</button>
              ))}
            </div>
            <div style={{ marginTop: 18, fontSize: 10, color: C.muted, letterSpacing: "0.16em" }} className="mono">🧠 DEEP RESEARCH PLAYBOOKS</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 9 }}>
              {RESEARCH_PLAYBOOKS.map(([label, tmpl]) => (
                <button key={label} onClick={() => { setDeep(true); setInput(tmpl); }} className="lift" title={tmpl}
                  style={{ cursor: "pointer", fontSize: 12, padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.gold}55`, background: C.goldSoft, color: C.gold }}>{label}</button>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: C.muted, marginTop: 7 }}>Loads a template + turns on Deep Research — fill the &lt;…&gt; and hit RESEARCH.</div>
          </div>
        )}
        {log.map((e, i) => {
          if (e.kind === "user") return (
            <div key={i} style={{ display: "flex", justifyContent: "flex-end", margin: "12px 0" }}>
              <div style={{ maxWidth: "82%", background: C.goldSoft, border: `1px solid ${C.gold}40`, color: C.ivory, fontSize: 13, lineHeight: 1.5, padding: "9px 13px", borderRadius: "12px 12px 3px 12px" }}>{e.text}</div>
            </div>
          );
          if (e.kind === "assistant") return (
            <div key={i} className="scout-msg" style={{ margin: "12px 0", maxWidth: "92%" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                <span className="mono" style={{ fontSize: 9.5, color: C.gold, letterSpacing: "0.18em" }}>SCOUT</span>
                <button onClick={() => { if (!openPrintable("Scout response", e.text)) setLog((l) => [...l, { kind: "error", text: "Allow pop-ups for this site to open the printable view." }]); }}
                  className="mono scout-print" title="Open a printable / save-as-PDF view of this response"
                  style={{ cursor: "pointer", fontSize: 9, letterSpacing: "0.1em", color: C.muted, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "2px 8px" }}>⤓ PRINT</button>
              </div>
              <ResearchBriefBody text={e.text} />
            </div>
          );
          if (e.kind === "map") return (<div key={i}><ScoutMap items={e.items} center={e.center} /></div>);
          if (e.kind === "sourced") return (
            <div key={i} onClick={() => goSourcing && goSourcing()} className="lift" style={{ cursor: "pointer", margin: "8px 0", fontSize: 12, color: C.gold, background: C.goldSoft, border: `1px solid ${C.gold}40`, borderRadius: 8, padding: "8px 12px", display: "inline-block" }}>
              ◎ {e.count} propert{e.count === 1 ? "y" : "ies"} added to the Sourcing tab — open the table, map &amp; dossiers →
            </div>
          );
          if (e.kind === "tool") return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", fontSize: 11.5, color: C.muted }}>
              <span className="mono" style={{ fontSize: 10, padding: "2px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.ink, color: e.status === "error" ? C.red : e.status === "done" ? C.green : C.gold }}>
                {e.status === "running" ? "▸" : e.status === "error" ? "✕" : "✓"} {e.label}
              </span>
              {e.detail && <span style={{ color: e.status === "error" ? C.red : C.muted }}>{e.detail}</span>}
            </div>
          );
          return (
            <div key={i} style={{ margin: "10px 0", fontSize: 12.5, color: C.red, background: `${C.red}10`, border: `1px solid ${C.red}40`, borderRadius: 8, padding: "9px 12px" }}>{e.text}</div>
          );
        })}
        {busy && <div className="mono" style={{ fontSize: 11, color: C.gold, marginTop: 10 }}>▸ {deepResearch ? "Scout is researching deeply — planning, investigating, compiling…" : "Scout is working…"}</div>}
      </div>

      {attachedDoc && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 12, color: C.ivory, background: C.goldSoft, border: `1px solid ${C.gold}40`, borderRadius: 8, padding: "7px 11px", width: "fit-content" }}>
          📎 {attachedDoc.name} <span style={{ color: C.muted }}>· {attachedDoc.kind === "text" ? `list to rank${attachedDoc.truncated ? " (truncated)" : ""}` : "offering memo / NDA to grade"}</span>
          <span onClick={() => setAttachedDoc(null)} style={{ cursor: "pointer", color: C.muted, marginLeft: 4 }}>✕</span>
        </div>
      )}
      {/* Cost controls: Deep Research depth · Quick (free-ish) vs Deep web · monthly web-spend cap */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap", fontSize: 11.5 }}>
        <button onClick={() => setDeep(!deepResearch)}
          title="Deep Research: Scout plans, investigates exhaustively across every engine, and writes a full cited report. Slower (more steps); uses live web only if 'Deep web' is also on."
          className="mono lift" style={{ cursor: "pointer", fontSize: 10.5, padding: "5px 12px", borderRadius: 7, letterSpacing: "0.04em", border: `1px solid ${deepResearch ? C.gold : C.line}`, background: deepResearch ? C.goldSoft : "transparent", color: deepResearch ? C.gold : C.muted }}>
          🧠 Deep Research{deepResearch ? " · ON" : ""}
        </button>
        <div style={{ display: "flex", gap: 3, border: `1px solid ${C.line}`, borderRadius: 8, padding: 2 }}>
          {[["quick", "⚡ Quick", "Knowledge only — no paid web search"], ["deep", "🔎 Deep web", "Live web research (~$0.30/run)"]].map(([m, lab, tip]) => (
            <button key={m} onClick={() => setMode(m)} title={tip} className="mono"
              style={{ cursor: "pointer", fontSize: 10.5, padding: "5px 11px", borderRadius: 6, border: "none", background: mode === m ? C.goldSoft : "transparent", color: mode === m ? C.gold : C.muted, letterSpacing: "0.04em" }}>{lab}</button>
          ))}
        </div>
        <span style={{ color: spend >= cap ? C.red : C.muted }}>
          Web spend / mo: <strong style={{ color: spend >= cap ? C.red : C.ivory }}>${spend.toFixed(2)}</strong> / $
          <input type="number" value={cap} onChange={(e) => { const n = Number(e.target.value) || 0; setCapState(n); setScoutCapLS(n); }}
            style={{ width: 46, fontSize: 11.5, padding: "2px 4px", border: `1px solid ${C.line}`, borderRadius: 5, background: C.panel, color: C.ivory, fontFamily: "'IBM Plex Mono',monospace" }} />
        </span>
        {spend >= cap && <span style={{ color: C.red }}>cap reached — deep web paused, using Quick</span>}
        <span style={{ color: C.muted, borderLeft: `1px solid ${C.line}`, paddingLeft: 12 }}
          title={`Actual API usage this month: ${fmtTok(tokens.in)} input · ${fmtTok(tokens.out)} output · ${fmtTok(tokens.cacheRead)} cache-read · ${fmtTok(tokens.cacheWrite)} cache-write${tokens.webSearch ? ` · ${tokens.webSearch} web searches` : ""}, across ${tokens.calls} AI calls. Cost is an estimate at Claude Sonnet 4.6 rates.`}>
          Tokens / mo: <strong style={{ color: C.ivory }}>{fmtTok(tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite)}</strong> · est <strong style={{ color: C.ivory }}>${(tokens.cost || 0).toFixed(2)}</strong>
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input ref={fileRef} type="file" accept=".pdf,.csv,.tsv,.txt,.md,application/pdf,text/csv,text/plain,text/tab-separated-values" style={{ display: "none" }} onChange={(e) => { onAttach(e.target.files[0]); e.target.value = ""; }} />
        <button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy} title="Attach a PDF (offering memo / NDA to grade) or a CSV/TXT list of owners to rank"
          className="mono lift" style={{ cursor: busy ? "default" : "pointer", fontSize: 14, padding: "0 14px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.panel, color: C.ivory }}>📎</button>
        <input
          value={input} onChange={(e) => setInput(e.target.value)} disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask Scout to source, research, grade an OM/NDA, or rank a list of owners to call…"
          style={{ flex: 1, fontSize: 14, padding: "12px 14px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.panel, color: C.ivory }} />
        <button onClick={() => send()} disabled={busy || (!input.trim() && !attachedDoc)} className="mono lift"
          style={{ cursor: busy || (!input.trim() && !attachedDoc) ? "default" : "pointer", fontSize: 12, padding: "0 20px", borderRadius: 9, border: `1px solid ${C.gold}`, background: busy || (!input.trim() && !attachedDoc) ? C.panel : C.goldSoft, color: C.gold, opacity: busy || (!input.trim() && !attachedDoc) ? 0.5 : 1 }}>{deepResearch ? "RESEARCH" : "SEND"}</button>
        {log.length > 0 && <button onClick={reset} disabled={busy} className="mono" style={{ cursor: "pointer", fontSize: 12, padding: "0 14px", borderRadius: 9, border: `1px solid ${C.line}`, background: "transparent", color: C.muted }}>NEW</button>}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
        Scout runs your live engines (ACRIS · PLUTO · DOB · HPD · NY registry · foot traffic · AI research) and grades offering memos against your buy-box (📎 attach a PDF · ⚙ edit criteria above). Contact reveals are a paid skip trace and always ask first.
      </div>
    </div>
  );
}

// ── COMP SHEET — automatic retail comparable analysis ───────────────────────────
// Given a subject address, pull nearby PLUTO properties (reusing /api/search nyc), keep the
// ones that traded recently and have a building size, compute $/SF, and render a clean
// tear sheet: subject summary + sales comps + stats + a rent section (auto-fills via web
// research on Pro). Exports CSV and prints to a one-page PDF. No new backend function.
const COMP_COLS = [
  ["", (r, i) => (r._subject ? "SUBJECT" : i)],
  ["Address", (r) => r.address],
  ["Sale date", (r) => r._saleYear || ""],
  ["Sale price", (r) => (r._price != null ? r._price : "")],
  ["Building SF", (r) => (r.bldg_sqft != null ? r.bldg_sqft : "")],
  ["$/SF", (r) => (r._ppsf != null ? Math.round(r._ppsf) : "")],
  ["Retail SF", (r) => (r.retail_sqft != null ? r.retail_sqft : "")],
  ["Year built", (r) => (r.year_built != null ? r.year_built : "")],
  ["Distance (mi)", (r) => (r.distance != null ? Number(r.distance).toFixed(2) : "")],
];
function compsToCSV(subject, comps) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const head = COMP_COLS.map((c) => esc(c[0])).join(",");
  const rows = [{ ...subject, _subject: true }, ...comps];
  const body = rows.map((r, i) => COMP_COLS.map((c) => esc(c[1](r, i))).join(",")).join("\n");
  return head + "\n" + body;
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ppsfOf = (r) => (r.last_sale_price && r.bldg_sqft ? r.last_sale_price / r.bldg_sqft : null);

// ── Presentable one-pager export ────────────────────────────────────────────────
// Builds a STANDALONE, branded HTML document (its own light theme + print CSS) and
// opens it in a new tab — so the export looks like a designed tear sheet, not a
// screenshot of the app. The user saves it to PDF from the print dialog.
// Auto investment highlights derived from the subject's PLUTO attributes — the
// trophy-retail value drivers (frontage, landmark, air rights, zoning, owner signals).
function siteHighlights(s) {
  const h = [];
  if (s.frontage_ft) h.push(`${s.frontage_ft} ft of building frontage${Number(s.frontage_ft) >= 25 ? " — strong high-street presence" : ""}`);
  if (s.retail_sqft) h.push(`${Number(s.retail_sqft).toLocaleString()} SF of ground-floor retail`);
  if (s.bldg_sqft) h.push(`${Number(s.bldg_sqft).toLocaleString()} SF building${s.num_floors ? ` across ${s.num_floors} floor${Number(s.num_floors) === 1 ? "" : "s"}` : ""}`);
  if (s.landmark || s.hist_district) h.push(`Landmarked / historic district — protected facade and trophy permanence`);
  if (s.special_district) h.push(`Within the ${s.special_district} special district (signage / use overlay)`);
  if (s.overlay) h.push(`Commercial overlay ${s.overlay} — retail use as-of-right`);
  else if (s.zoning) h.push(`Zoned ${s.zoning}`);
  if (s.buildable_sqft && Number(s.buildable_sqft) >= 2500) h.push(`~${Number(s.buildable_sqft).toLocaleString()} SF of unused air rights — expansion / development upside`);
  if (s.year_built && Number(s.year_built) < 1940) h.push(`Prewar construction (built ${s.year_built})`);
  if (s.years_owned != null && Number(s.years_owned) >= 15) h.push(`Held ${s.years_owned}+ years by the current owner — potential off-market seller`);
  if (s.absentee) h.push(`${s.absentee === "out-of-state" ? "Out-of-state" : "Out-of-area"} owner — approachable off-market`);
  if (s.tax_lien) h.push(`Tax lien on record — possible distress / motivation`);
  return h;
}
// Deep link to the actual recorded deed in NYC's public ACRIS document viewer.
const acrisDeedUrl = (id) => (id ? `https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id=${encodeURIComponent(id)}` : null);
const escHtml = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function miniMd(text) {
  return String(text || "").split("\n").map((line) => {
    if (!line.trim()) return "";
    const bullet = /^\s*[-•]\s+/.test(line);
    let c = escHtml(line.replace(/^\s*[-•]\s+/, "").replace(/^#+\s*/, ""));
    c = c.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return bullet ? `<li>${c}</li>` : `<p>${c}</p>`;
  }).join("");
}
// Generic printable document for any markdown response (e.g. a Scout answer).
// Plain, no-logo, opens in a new tab with a Print / Save-as-PDF button.
function printableHTML(title, markdown) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escHtml(title)}</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;background:#f3f3f3;color:#1a1a1a;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .page{max-width:760px;margin:20px auto;background:#fff;border:1px solid #ddd;padding:38px 42px;}
  .bar{text-align:center;padding:10px 0;}
  .bar button{font-size:13px;cursor:pointer;padding:8px 18px;border:1px solid #888;background:#fff;color:#1a1a1a;border-radius:4px;}
  .head{border-bottom:2px solid #1a1a1a;padding-bottom:10px;display:flex;justify-content:space-between;align-items:flex-end;gap:14px;}
  h1{font-size:16px;font-weight:700;margin:0;}
  .meta{font-size:11px;color:#666;white-space:nowrap;}
  .body{margin-top:18px;}
  .body p{font-size:13.5px;line-height:1.65;margin:8px 0;}
  .body li{font-size:13.5px;line-height:1.65;margin:5px 0 5px 20px;}
  .body strong{color:#1a1a1a;} .body a{color:#1a1a1a;}
  .foot{margin-top:24px;padding-top:10px;border-top:1px solid #ddd;font-size:9.5px;color:#999;}
  @media print{body{background:#fff;}.bar{display:none;}.page{margin:0;border:none;padding:0;}@page{margin:16mm;}}
</style></head><body>
<div class="bar"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="page">
  <div class="head"><h1>${escHtml(title)}</h1><div class="meta">${new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</div></div>
  <div class="body">${miniMd(markdown)}</div>
  <div class="foot">Generated by Scout · FRONTAGE</div>
</div></body></html>`;
}
function openPrintable(title, markdown) {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open(); w.document.write(printableHTML(title, markdown)); w.document.close();
  return true;
}

function onePagerHTML(s, comps, st, meta, rentText, highlights, notes, preparedBy, leaseTerms) {
  const money = (a) => (a == null || a === "" ? "—" : "$" + Number(a).toLocaleString());
  const num = (a) => (a == null || a === "" ? "—" : Number(a).toLocaleString());
  const ppsf = (a) => (a == null ? "—" : "$" + Math.round(a).toLocaleString());
  const deedLink = (id, label) => (id ? `<a href="${acrisDeedUrl(id)}">${label} ↗</a>` : label);
  const compRows = comps.map((c, i) => `<tr>
      <td class="muted">${i + 1}</td><td>${escHtml(c.address)}</td><td>${deedLink(c.last_deed_id, escHtml(c._saleYear))}</td>
      <td class="r">${money(c._price)}</td><td class="r">${num(c.bldg_sqft)}</td>
      <td class="r b">${ppsf(c._ppsf)}</td><td class="r">${c.year_built || "—"}</td>
      <td class="r">${c.distance != null ? Number(c.distance).toFixed(2) : "—"}</td></tr>`).join("");
  const kv = (k, v) => `<div class="kv"><span class="kl">${k}</span><span class="kvv">${v}</span></div>`;
  const stat = (k, v) => `<div class="stat"><div class="sk">${k}</div><div class="sv">${v}</div></div>`;
  const lastSale = (s.source === "pluto" ? s.last_sale_price : s.amount);
  const lastSaleYr = s.last_sale_date ? String(s.last_sale_date).slice(0, 4) : "";
  const subjHead = escHtml(s.address || "Subject property");
  const ownerNow = s.deed_owner || s.name || "—";
  const ownerNote = (s.deed_owner && s.name && s.deed_owner.toUpperCase() !== s.name.toUpperCase())
    ? `<div class="note">Owner per latest deed: <strong>${escHtml(s.deed_owner)}</strong> — PLUTO assessor lists "${escHtml(s.name)}" (annual snapshot, may lag).</div>` : "";
  const deedNote = s.portfolio_sale
    ? `<div class="note">Most recent transfer was a portfolio / bulk deed conveying ${s.last_deed_lots} lots${s.portfolio_total_price ? ` for $${Number(s.portfolio_total_price).toLocaleString()} total` : ""}${s.last_sale_date ? ` (${String(s.last_sale_date).slice(0, 10)})` : ""} — this lot's individual price isn't separable. ${s.last_deed_id ? `<a href="${acrisDeedUrl(s.last_deed_id)}">View deed ↗</a>` : ""}</div>`
    : (s.last_deed_id ? `<div class="note"><a href="${acrisDeedUrl(s.last_deed_id)}">View recorded deed ↗</a> (ACRIS document ${escHtml(s.last_deed_id)})</div>` : "");
  const hlBlock = (highlights && highlights.length)
    ? `<div class="sec">INVESTMENT HIGHLIGHTS</div><ul class="hl">${highlights.map((h) => `<li>${escHtml(h)}</li>`).join("")}</ul>` : "";
  const notesBlock = (notes && notes.trim())
    ? `<div class="sec">NOTES &amp; INVESTMENT THESIS</div><div class="notes">${miniMd(notes)}</div>` : "";
  const leaseBlock = (leaseTerms && leaseTerms.trim())
    ? `<div class="sec">LEASE TERMS</div><div class="notes">${miniMd(leaseTerms)}</div>` : "";
  const rentBlock = rentText
    ? `<div class="sec">RENT COMPARABLES (asking · corridor)</div><div class="notes">${miniMd(rentText)}</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Retail Comparable Analysis — ${subjHead}</title>
<style>
  *{ box-sizing:border-box; }
  body{ margin:0; background:#f3f3f3; color:#1a1a1a; font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .page{ max-width:800px; margin:20px auto; background:#fff; border:1px solid #ddd; padding:38px 40px; }
  .bar{ text-align:center; padding:10px 0; }
  .bar button{ font-size:13px; cursor:pointer; padding:8px 18px; border:1px solid #888; background:#fff; color:#1a1a1a; border-radius:4px; }
  h1{ font-size:18px; font-weight:700; margin:0; letter-spacing:.01em; }
  .head{ border-bottom:2px solid #1a1a1a; padding-bottom:10px; display:flex; justify-content:space-between; align-items:flex-end; }
  .meta{ font-size:11px; color:#666; text-align:right; line-height:1.6; }
  .sec{ font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#1a1a1a; margin:24px 0 10px; border-bottom:1px solid #ccc; padding-bottom:4px; }
  .subj{ font-size:18px; font-weight:700; }
  .subline{ color:#666; font-size:12px; margin-top:2px; }
  .grid{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px 24px; margin-top:14px; }
  .kv{ display:flex; flex-direction:column; gap:1px; border-bottom:1px solid #eee; padding-bottom:5px; }
  .kl{ font-size:10px; letter-spacing:.03em; color:#888; text-transform:uppercase; }
  .kvv{ font-size:13.5px; font-weight:600; }
  .stats{ display:flex; margin-top:18px; border:1px solid #ddd; }
  .stat{ flex:1; padding:12px 14px; }
  .stat+.stat{ border-left:1px solid #ddd; }
  .sk{ font-size:9px; letter-spacing:.08em; color:#888; text-transform:uppercase; }
  .sv{ font-size:18px; font-weight:700; margin-top:4px; }
  ul.hl{ margin:0; padding-left:20px; } ul.hl li{ font-size:12.5px; line-height:1.55; margin:4px 0; }
  table{ width:100%; border-collapse:collapse; }
  th{ text-align:left; font-size:10px; letter-spacing:.04em; text-transform:uppercase; color:#888; border-bottom:1.5px solid #999; padding:7px 9px; }
  td{ font-size:12.5px; padding:8px 9px; border-bottom:1px solid #eee; }
  .r{ text-align:right; } th.r{ text-align:right; } .b{ font-weight:700; } .muted{ color:#999; }
  .notes p{ font-size:12.5px; line-height:1.6; margin:4px 0; } .notes li{ font-size:12.5px; line-height:1.6; margin:3px 0 3px 18px; }
  .note{ font-size:11px; color:#555; line-height:1.6; margin-top:8px; } .note a{ color:#1a1a1a; }
  .foot{ margin-top:22px; padding-top:10px; border-top:1px solid #ddd; font-size:9.5px; color:#888; line-height:1.55; }
  @media print{ body{ background:#fff; } .bar{ display:none; } .page{ margin:0; border:none; padding:0; } @page{ margin:16mm; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="page">
  <div class="head">
    <div><h1>Retail Comparable Analysis</h1>${preparedBy && preparedBy.trim() ? `<div style="font-size:11px;color:#666;margin-top:3px">Prepared by ${escHtml(preparedBy)}</div>` : ""}</div>
    <div class="meta">${new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}<br/>${comps.length} comps · ${escHtml(meta.radius)} mi · ≤${escHtml(meta.lookback)}y</div>
  </div>

  <div class="sec">Subject property</div>
  <div class="subj">${subjHead}</div>
  <div class="subline">${escHtml([s.borough, s.doc_type && ("class " + s.doc_type)].filter(Boolean).join(" · "))}</div>
  <div class="grid">
    ${kv("Owner", escHtml(ownerNow))}
    ${kv("Building SF", num(s.bldg_sqft))}
    ${kv("Retail SF", num(s.retail_sqft))}
    ${kv("Lot SF", num(s.lot_sqft))}
    ${kv("Year built", s.year_built || "—")}
    ${kv("Frontage", s.frontage_ft ? s.frontage_ft + " ft" : "—")}
    ${kv("Zoning", escHtml(s.zoning || "—"))}
    ${kv("Assessed value", money(s.source === "pluto" ? s.amount : null))}
    ${kv("Last sale", lastSale ? money(lastSale) + (lastSaleYr ? " (" + lastSaleYr + ")" : "") : "—")}
  </div>
  ${ownerNote}${deedNote}

  ${hlBlock}

  <div class="stats">
    ${stat("Comps", st.count)}
    ${stat("Avg $/SF", st.avg != null ? "$" + Math.round(st.avg).toLocaleString() : "—")}
    ${stat("Median $/SF", st.median != null ? "$" + Math.round(st.median).toLocaleString() : "—")}
    ${stat("Implied value", st.implied != null ? "$" + Math.round(st.implied).toLocaleString() : "—")}
  </div>

  <div class="sec">Sales comparables</div>
  ${comps.length ? `<table><thead><tr>
    <th>#</th><th>Address</th><th>Sold</th><th class="r">Price</th><th class="r">Bldg SF</th><th class="r">$/SF</th><th class="r">Yr</th><th class="r">Dist</th>
  </tr></thead><tbody>${compRows}</tbody></table>` : `<p class="muted" style="font-size:12.5px">No recorded sales in this radius and window.</p>`}

  ${leaseBlock}
  ${notesBlock}
  ${rentBlock}

  <div class="foot">Sources: NYC ACRIS (recorded sale prices) + PLUTO (building areas). $/SF = recorded deed price ÷ PLUTO gross building area; implied value = average $/SF × subject building area. Recorded prices can include non-arm's-length transfers — verify outliers. Asking rents are not effective/in-place rents. For internal underwriting use.</div>
</div></body></html>`;
}

// Comp tool wrapper — one tool, a market dropdown (NYC · Greenwich/CT · Hamptons/NY).
function CompTool({ pw }) {
  const [market, setMarket] = useState("nyc");
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span className="mono" style={{ ...labelStyle }}>MARKET</span>
        <select value={market} onChange={(e) => setMarket(e.target.value)} style={{ ...fieldStyle, fontSize: 13, padding: "8px 12px" }}>
          <option value="nyc">New York City</option>
          <option value="ct">Greenwich · CT</option>
          <option value="ny">Hamptons · NY</option>
          <option value="tn">Nashville · TN</option>
        </select>
      </div>
      {market === "nyc" && <CompSheet pw={pw} />}
      {market === "ct" && <CTCompSheet pw={pw} />}
      {market === "ny" && <NYCompSheet pw={pw} />}
      {market === "tn" && <NashCompSheet pw={pw} />}
    </div>
  );
}

const CT_COMP_TYPES = [["commercial", "Commercial (retail / office)"], ["apartments", "Apartments"], ["industrial", "Industrial"], ["any", "Any type"]];
function ctCompCSV(rows) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const cols = [["Address", (r) => r.address], ["Owner", (r) => r.owner], ["Use", (r) => r.use], ["Sale price", (r) => r._price], ["Building SF", (r) => r.building_sqft], ["$/SF", (r) => (r._ppsf ? Math.round(r._ppsf) : "")], ["Sold", (r) => r.sale_date], ["Assessed", (r) => r.assessed_value]];
  return cols.map((c) => esc(c[0])).join(",") + "\n" + rows.map((r) => cols.map((c) => esc(c[1](r))).join(",")).join("\n");
}
function CTCompSheet({ pw }) {
  const [town, setTown] = useState("Greenwich");
  const [type, setType] = useState("commercial");
  const [sinceYear, setSinceYear] = useState("2018");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const run = async () => {
    setError(""); setData(null); setLoading(true);
    try {
      const d = await postJSON("/api/search", { password: pw, market: "ct", town, propertyType: type, sinceYear });
      const cutoff = Number(sinceYear || 0);
      const comps = (d.properties || []).filter((p) => p.sale_price && p.building_sqft && p.sale_date)
        .map((p) => ({ ...p, _ppsf: p.sale_price / p.building_sqft, _price: p.sale_price, _year: Number((p.sale_date || "").split("/").pop()) }))
        .filter((c) => c._price >= 100000 && c._ppsf >= 25 && c._ppsf <= 60000 && (!cutoff || c._year >= cutoff))
        .sort((a, b) => (b._year || 0) - (a._year || 0));
      const ppsfs = comps.map((c) => c._ppsf);
      const avg = ppsfs.length ? ppsfs.reduce((s, x) => s + x, 0) / ppsfs.length : null;
      setData({ comps, stats: { count: comps.length, avg, median: median(ppsfs), min: ppsfs.length ? Math.min(...ppsfs) : null, max: ppsfs.length ? Math.max(...ppsfs) : null } });
    } catch (e) { setError(e.message || "Failed."); }
    finally { setLoading(false); }
  };
  const st = data && data.stats;
  return (
    <div>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          <label><div className="mono" style={labelStyle}>TOWN</div><input value={town} onChange={(e) => setTown(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }} placeholder="Greenwich" /></label>
          <label><div className="mono" style={labelStyle}>TYPE</div><select value={type} onChange={(e) => setType(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>{CT_COMP_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label><div className="mono" style={labelStyle}>SOLD SINCE</div><input type="number" value={sinceYear} onChange={(e) => setSinceYear(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }} placeholder="2018" /></label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
          <button onClick={run} disabled={loading} className="mono lift" style={{ cursor: loading ? "default" : "pointer", fontSize: 12, padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold, opacity: loading ? 0.5 : 1 }}>{loading ? "BUILDING…" : "■ BUILD COMP SET"}</button>
          {data && data.comps.length > 0 && <button onClick={() => downloadBlob(ctCompCSV(data.comps), `comps_${town.toLowerCase().replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.csv`, "text/csv")} className="mono" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ CSV</button>}
        </div>
        {error && <div style={{ marginTop: 12, fontSize: 12.5, color: C.red }}>{error}</div>}
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>Connecticut CAMA sales — $/SF = recorded sale price ÷ assessor building area, for the town's traded {type === "any" ? "" : type + " "}properties. Town-level (CT records have no coordinates for a radius).</div>
      </div>
      {data && (<div style={{ marginTop: 18 }}>
        {data.comps.length === 0 ? <div style={{ color: C.muted, fontSize: 13 }}>No sales with a building size matched. Widen the year or type.</div> : (<>
          <div style={{ display: "flex", border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
            {[["COMPS", st.count], ["AVG $/SF", st.avg != null ? `$${Math.round(st.avg).toLocaleString()}` : "—"], ["MEDIAN $/SF", st.median != null ? `$${Math.round(st.median).toLocaleString()}` : "—"], ["RANGE $/SF", st.min != null ? `$${Math.round(st.min).toLocaleString()}–${Math.round(st.max).toLocaleString()}` : "—"]].map(([k, v], i) => (
              <div key={k} style={{ flex: 1, padding: "10px 12px", borderLeft: i ? `1px solid ${C.line}` : "none", background: C.ink }}><div className="mono" style={{ fontSize: 9, color: C.muted, letterSpacing: "0.12em" }}>{k}</div><div style={{ fontSize: 16, fontWeight: 700, marginTop: 3 }}>{v}</div></div>
            ))}
          </div>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>{["Address", "Owner", "Use", "Sale", "Bldg SF", "$/SF", "Sold"].map((h, i) => <th key={h} style={{ textAlign: i >= 3 && i <= 5 ? "right" : "left", padding: "9px 12px", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: C.muted }}>{h}</th>)}</tr></thead>
              <tbody>{data.comps.map((c, i) => (<tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
                <td style={{ padding: "8px 12px", fontSize: 12.5 }}>{c.address}</td>
                <td style={{ padding: "8px 12px", fontSize: 12, color: C.muted, maxWidth: 180 }}>{c.owner}</td>
                <td style={{ padding: "8px 12px", fontSize: 12, color: C.muted }}>{c.use}</td>
                <td className="mono" style={{ padding: "8px 12px", fontSize: 12.5, textAlign: "right" }}>{fmtAmount(c._price)}</td>
                <td className="mono" style={{ padding: "8px 12px", fontSize: 12, textAlign: "right", color: C.muted }}>{Number(c.building_sqft).toLocaleString()}</td>
                <td className="mono" style={{ padding: "8px 12px", fontSize: 12.5, textAlign: "right", fontWeight: 700, color: C.gold }}>${Math.round(c._ppsf).toLocaleString()}</td>
                <td className="mono" style={{ padding: "8px 12px", fontSize: 12, color: C.muted }}>{c.sale_date}</td>
              </tr>))}</tbody>
            </table>
          </div>
        </>)}
      </div>)}
    </div>
  );
}
function NYCompSheet({ pw }) {
  const [town, setTown] = useState("all");
  const [type, setType] = useState("commercial");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [props, setProps] = useState(null);
  const [sales, setSales] = useState({ state: "idle", text: "", err: "" });
  const run = async () => {
    setError(""); setProps(null); setSales({ state: "idle", text: "", err: "" }); setLoading(true);
    try { const d = await postJSON("/api/search", { password: pw, market: "hamptons", town, propertyType: type }); setProps(d.properties || []); }
    catch (e) { setError(e.message || "Failed."); }
    finally { setLoading(false); }
  };
  const pullSales = async () => {
    setSales({ state: "loading", text: "", err: "" });
    try {
      const m = webResearchMode();
      const q = `Find recently reported commercial/retail building SALES in the Hamptons (${town === "all" ? "East Hampton, Southampton, Shelter Island" : town}, NY) in the last ~5 years — address, price, date, and $/SF or building size if reported, with the SOURCE. Sorted by price. Only real reported sales with a source — never invent prices.`;
      const d = await postJSON("/api/research", { mode: m, password: pw, query: q });
      if (m === "web") addScoutSpend(WEB_RUN_COST);
      setSales({ state: "done", text: d.brief || "No reported sales found.", err: "" });
    } catch (e) { setSales({ state: "error", text: "", err: e.message || "Failed." }); }
  };
  return (
    <div>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          <label><div className="mono" style={labelStyle}>TOWN</div><select value={town} onChange={(e) => setTown(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>{HAMPTONS_TOWN_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label><div className="mono" style={labelStyle}>TYPE</div><select value={type} onChange={(e) => setType(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>{NY_TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
          <button onClick={run} disabled={loading} className="mono lift" style={{ cursor: loading ? "default" : "pointer", fontSize: 12, padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold, opacity: loading ? 0.5 : 1 }}>{loading ? "LOADING…" : "■ LOAD PROPERTIES"}</button>
          {props && props.length > 0 && <button onClick={() => downloadBlob(nyCSV(props), `hamptons_${new Date().toISOString().slice(0, 10)}.csv`, "text/csv")} className="mono" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ CSV</button>}
        </div>
        {error && <div style={{ marginTop: 12, fontSize: 12.5, color: C.red }}>{error}</div>}
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>⚠ NY's assessment roll has <strong style={{ color: C.ivory }}>no sale prices or building SF</strong>, so structured $/SF comps aren't possible for the Hamptons. This lists assessor records (owner / assessed value); for real sale comps use <strong style={{ color: C.ivory }}>✦ Pull market sales</strong> (web).</div>
      </div>
      {props && (<div style={{ marginTop: 18 }}>
        <div className="mono" style={{ ...labelStyle, marginBottom: 8 }}>{props.length} PROPERTIES · {town === "all" ? "HAMPTONS" : town.toUpperCase()}</div>
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>{["Owner", "Address", "Use", "Assessed", "Frontage"].map((h, i) => <th key={h} style={{ textAlign: i === 3 ? "right" : "left", padding: "9px 12px", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: C.muted }}>{h}</th>)}</tr></thead>
            <tbody>{props.slice(0, 60).map((p, i) => (<tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
              <td style={{ padding: "8px 12px", fontSize: 12.5, maxWidth: 220 }}>{p.owner}{p.absentee && <span className="mono" style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", borderRadius: 5, background: C.goldSoft, color: C.amber }}>{p.absentee === "out-of-state" ? "OOS" : "OOA"}</span>}</td>
              <td style={{ padding: "8px 12px", fontSize: 12.5 }}>{p.address}</td>
              <td style={{ padding: "8px 12px", fontSize: 12, color: C.muted }}>{p.use}</td>
              <td className="mono" style={{ padding: "8px 12px", fontSize: 12.5, textAlign: "right" }}>{p.assessed_value ? fmtAmount(p.assessed_value) : "—"}</td>
              <td className="mono" style={{ padding: "8px 12px", fontSize: 12, color: C.muted }}>{p.frontage_ft ? `${p.frontage_ft} ft` : "—"}</td>
            </tr>))}</tbody>
          </table>
        </div>
        <div style={{ marginTop: 14 }}>
          <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", marginBottom: 8 }}>MARKET SALES <span style={{ color: C.muted }}>(reported · web)</span></div>
          {sales.state === "idle" && <button onClick={pullSales} style={{ cursor: "pointer", fontSize: 12, padding: "7px 13px", borderRadius: 7, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold }}>✦ Pull market sales</button>}
          {sales.state === "loading" && <div className="mono" style={{ fontSize: 11, color: C.gold }}>▸ searching reported sales…</div>}
          {sales.state === "error" && <div style={{ fontSize: 12.5, color: C.red }}>{sales.err}</div>}
          {sales.state === "done" && <ResearchBriefBody text={sales.text} />}
        </div>
      </div>)}
    </div>
  );
}

const NASH_COMP_TYPES = [["retail", "Retail"], ["commercial", "Commercial (retail / office)"], ["office", "Office"], ["apartments", "Apartments"], ["industrial", "Industrial"], ["any", "Any type"]];
function nashCompCSV(rows) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const cols = [["Address", (r) => r.address], ["Owner", (r) => r.owner], ["Use", (r) => r.use], ["Sale price", (r) => r._price], ["Sold", (r) => r.sale_year], ["Building SF", (r) => r.building_sqft || ""], ["$/SF", (r) => (r._ppsf ? Math.round(r._ppsf) : "")], ["Year built", (r) => r.year_built || ""], ["Acres", (r) => r.acres], ["$/acre", (r) => (r._ppa ? Math.round(r._ppa) : "")], ["Frontage ft", (r) => r.frontage_ft || ""], ["Appraised", (r) => r.appraised_value || ""]];
  return cols.map((c) => esc(c[0])).join(",") + "\n" + rows.map((r) => cols.map((c) => esc(c[1](r))).join(",")).join("\n");
}
// Nashville / Davidson County sale comps. TN's parcel data DOES carry recorded sale price +
// year (unlike the Hamptons roll), so these are real sales — but it has NO building SF (acreage
// only), so the comp basis is sale price + $/acre, not $/SF. Filter by an optional street/corridor
// (Metro PropAddr LIKE), type, and sold-since year.
function NashCompSheet({ pw }) {
  const [area, setArea] = useState("");
  const [type, setType] = useState("retail");
  const [sinceYear, setSinceYear] = useState("2019");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const run = async () => {
    setError(""); setData(null); setLoading(true);
    try {
      const d = await postJSON("/api/search", { password: pw, market: "nashville", propertyType: type, address: area.trim() || undefined, sinceYear, limit: 500 });
      const cutoff = Number(sinceYear || 0);
      const comps = (d.properties || []).filter((p) => p.sale_price && p.sale_year)
        .map((p) => ({ ...p, _price: p.sale_price, _year: Number(p.sale_year), _ppa: (p.acres && p.acres > 0) ? p.sale_price / p.acres : null, _ppsf: (p.building_sqft && p.building_sqft > 0) ? p.sale_price / p.building_sqft : null }))
        .filter((c) => c._price >= 50000 && (!cutoff || c._year >= cutoff) && (!c._ppsf || (c._ppsf >= 20 && c._ppsf <= 20000)))
        .sort((a, b) => (b._year || 0) - (a._year || 0) || (b._price || 0) - (a._price || 0));
      const prices = comps.map((c) => c._price);
      const ppas = comps.map((c) => c._ppa).filter((x) => x != null);
      const ppsfs = comps.map((c) => c._ppsf).filter((x) => x != null);
      setData({ comps, stats: { count: comps.length, medPrice: median(prices), medPpsf: median(ppsfs), ppsfCount: ppsfs.length, medPpa: median(ppas) } });
    } catch (e) { setError(e.message || "Failed."); }
    finally { setLoading(false); }
  };
  const st = data && data.stats;
  return (
    <div>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          <label><div className="mono" style={labelStyle}>STREET / CORRIDOR <span style={{ color: C.muted }}>(optional)</span></div><input value={area} onChange={(e) => setArea(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }} placeholder="e.g. Broadway (blank = citywide)" /></label>
          <label><div className="mono" style={labelStyle}>TYPE</div><select value={type} onChange={(e) => setType(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>{NASH_COMP_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label><div className="mono" style={labelStyle}>SOLD SINCE</div><input type="number" value={sinceYear} onChange={(e) => setSinceYear(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }} placeholder="2019" /></label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
          <button onClick={run} disabled={loading} className="mono lift" style={{ cursor: loading ? "default" : "pointer", fontSize: 12, padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold, opacity: loading ? 0.5 : 1 }}>{loading ? "BUILDING…" : "■ BUILD COMP SET"}</button>
          {data && data.comps.length > 0 && <button onClick={() => downloadBlob(nashCompCSV(data.comps), `comps_nashville_${new Date().toISOString().slice(0, 10)}.csv`, "text/csv")} className="mono" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ CSV</button>}
        </div>
        {error && <div style={{ marginTop: 12, fontSize: 12.5, color: C.red }}>{error}</div>}
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>Nashville / Davidson County recorded sales (Metro parcel data) for {type === "any" ? "all traded" : type} properties. <strong style={{ color: C.ivory }}>$/SF</strong> uses Metro's assessor building area (improved SF), on the higher-value parcels; <strong style={{ color: C.ivory }}>$/acre</strong> covers the rest. Top 500 by value; recorded prices can include non-arm's-length transfers — verify outliers.</div>
      </div>
      {data && (<div style={{ marginTop: 18 }}>
        {data.comps.length === 0 ? <div style={{ color: C.muted, fontSize: 13 }}>No recorded sales matched. Widen the year, clear the corridor, or change the type.</div> : (<>
          <div style={{ display: "flex", border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
            {[["COMPS", st.count], ["MEDIAN PRICE", st.medPrice != null ? fmtAmount(st.medPrice) : "—"], ["MEDIAN $/SF", st.medPpsf != null ? `$${Math.round(st.medPpsf).toLocaleString()}` : "—", st.ppsfCount ? `${st.ppsfCount} w/ SF` : ""], ["MEDIAN $/ACRE", st.medPpa != null ? `$${Math.round(st.medPpa).toLocaleString()}` : "—"]].map(([k, v, sub], i) => (
              <div key={k} style={{ flex: 1, padding: "10px 12px", borderLeft: i ? `1px solid ${C.line}` : "none", background: C.ink }}><div className="mono" style={{ fontSize: 9, color: C.muted, letterSpacing: "0.12em" }}>{k}</div><div style={{ fontSize: 16, fontWeight: 700, marginTop: 3 }}>{v}</div>{sub ? <div className="mono" style={{ fontSize: 8.5, color: C.muted, marginTop: 1 }}>{sub}</div> : null}</div>
            ))}
          </div>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>{["Address", "Owner", "Use", "Sale", "Sold", "Bldg SF", "$/SF", "$/acre"].map((h, i) => <th key={h} style={{ textAlign: i >= 3 ? "right" : "left", padding: "9px 12px", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: C.muted }}>{h}</th>)}</tr></thead>
              <tbody>{data.comps.map((c, i) => (<tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
                <td style={{ padding: "8px 12px", fontSize: 12.5 }}>{c.address}{c.year_built ? <span className="mono" style={{ fontSize: 9.5, color: C.muted, marginLeft: 6 }}>’{String(c.year_built).slice(-2)}</span> : null}</td>
                <td style={{ padding: "8px 12px", fontSize: 12, color: C.muted, maxWidth: 180 }}>{c.owner}</td>
                <td style={{ padding: "8px 12px", fontSize: 12, color: C.muted }}>{c.use}</td>
                <td className="mono" style={{ padding: "8px 12px", fontSize: 12.5, textAlign: "right" }}>{fmtAmount(c._price)}</td>
                <td className="mono" style={{ padding: "8px 12px", fontSize: 12, textAlign: "right", color: C.muted }}>{c.sale_year || "—"}</td>
                <td className="mono" style={{ padding: "8px 12px", fontSize: 12, textAlign: "right", color: C.muted }}>{c.building_sqft ? Number(c.building_sqft).toLocaleString() : "—"}</td>
                <td className="mono" style={{ padding: "8px 12px", fontSize: 12.5, textAlign: "right", fontWeight: 700, color: C.gold }}>{c._ppsf ? `$${Math.round(c._ppsf).toLocaleString()}` : "—"}</td>
                <td className="mono" style={{ padding: "8px 12px", fontSize: 12, textAlign: "right", color: C.muted }}>{c._ppa ? `$${Math.round(c._ppa).toLocaleString()}` : "—"}</td>
              </tr>))}</tbody>
            </table>
          </div>
        </>)}
      </div>)}
    </div>
  );
}

function CompSheet({ pw }) {
  const [nearAddress, setNearAddress] = useState("");
  const [picked, setPicked] = useState(null);
  const [radius, setRadius] = useState("0.25");
  const [assetType, setAssetType] = useState("retail");
  const [lookback, setLookback] = useState("7");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null); // { subject, comps, stats }
  const [rent, setRent] = useState({ state: "idle", text: "", err: "" });
  const [sales, setSales] = useState({ state: "idle", text: "", err: "" });
  const [leases, setLeases] = useState({ state: "idle", recorded: [], text: "", err: "" });
  const [leaseTerms, setLeaseTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [sortBy, setSortBy] = useState("recent"); // recent | ppsf | price
  const [preparedBy, setPreparedBy] = useState(() => { try { return localStorage.getItem("fr_prepared_by") || ""; } catch { return ""; } });
  const setPrepared = (t) => { setPreparedBy(t); try { localStorage.setItem("fr_prepared_by", t); } catch { /* quota */ } };

  // Persist analyst notes per subject (BBL) so they survive a re-generate / reload.
  const NOTES_STORE = "fr_comp_notes_v1";
  const loadCompNote = (bbl) => { try { return (JSON.parse(localStorage.getItem(NOTES_STORE) || "{}"))[bbl] || ""; } catch { return ""; } };
  const updateNotes = (t) => {
    setNotes(t);
    try { const all = JSON.parse(localStorage.getItem(NOTES_STORE) || "{}"); const bbl = data && data.subject.deal_id; if (bbl) { if (t) all[bbl] = t; else delete all[bbl]; localStorage.setItem(NOTES_STORE, JSON.stringify(all)); } } catch { /* quota */ }
  };

  // Have Claude draft a short "why it's attractive" thesis from the subject's own
  // attributes (reasoning over the data — works now in knowledge mode, web on Pro).
  const draftThesis = async () => {
    if (!data || drafting) return;
    setDrafting(true);
    try {
      const hi = siteHighlights(s).join("; ");
      const q = `Write a concise investment thesis — 3 to 4 tight bullet points, no fluff — for why this NYC retail property is an attractive acquisition target. Ground it ONLY in these facts: Address ${s.address}, ${s.borough}. Attributes: ${hi || "n/a"}. Building ${s.bldg_sqft ? Number(s.bldg_sqft).toLocaleString() + " SF" : "size n/a"}${s.year_built ? `, built ${s.year_built}` : ""}. Focus on trophy / high-street retail value drivers (frontage, location, retail SF, air rights, zoning, owner motivation). Do not invent facts not given.`;
      // webResearchMode (not hardcoded "web"): honors the Quick/Deep toggle + monthly cap,
      // and meters the spend like every sibling caller (pullRent/pullSales/findLeases).
      const m = webResearchMode();
      const d = await postJSON("/api/research", { mode: m, password: pw, query: q });
      if (m === "web") addScoutSpend(WEB_RUN_COST);
      const brief = (d.brief || "").trim();
      if (brief) updateNotes(notes ? `${notes}\n\n${brief}` : brief);
    } catch (e) { setError(e.message || "Draft failed."); }
    finally { setDrafting(false); }
  };

  const generate = async () => {
    if (!picked) { setError("Pick an address from the dropdown so I have exact coordinates."); return; }
    setLoading(true); setError(""); setData(null); setRent({ state: "idle", text: "", err: "" }); setSales({ state: "idle", text: "", err: "" }); setLeases({ state: "idle", recorded: [], text: "", err: "" });
    try {
      const res = await postJSON("/api/search", {
        password: pw, market: "nyc", sources: ["pluto"], assetType, radiusMiles: radius || "0.25",
        centerLat: picked.lat, centerLon: picked.lon, pickedBbl: picked.bbl,
      });
      const leads = res.leads || [];
      const subject = leads.find((l) => l.pinned) || leads[0] || null;
      if (!subject) { setError("Couldn't load the subject property. Try another address."); setLoading(false); return; }
      const cutoff = new Date().getFullYear() - Number(lookback || 7);
      // Accuracy guards: a recorded deed price must clear a floor (drops $0/$10/nominal
      // intra-LLC transfers that aren't real sales) and the resulting $/SF must be sane
      // (drops non-arm's-length deeds that would skew the average). Tunable.
      const MIN_PRICE = 100000, MIN_PPSF = 25, MAX_PPSF = 60000;
      const comps = leads
        .filter((l) => !l.pinned && l.last_sale_price && l.bldg_sqft && l.last_sale_date && Number(String(l.last_sale_date).slice(0, 4)) >= cutoff)
        .map((l) => ({ ...l, _ppsf: ppsfOf(l), _price: l.last_sale_price, _saleYear: String(l.last_sale_date).slice(0, 4) }))
        .filter((c) => c._price >= MIN_PRICE && c._ppsf != null && c._ppsf >= MIN_PPSF && c._ppsf <= MAX_PPSF)
        .sort((a, b) => (b._saleYear || "").localeCompare(a._saleYear || ""));
      const ppsfs = comps.map((c) => c._ppsf).filter((x) => x != null && isFinite(x));
      const avg = ppsfs.length ? ppsfs.reduce((s, x) => s + x, 0) / ppsfs.length : null;
      const stats = {
        count: comps.length, withPpsf: ppsfs.length,
        avg, median: median(ppsfs), min: ppsfs.length ? Math.min(...ppsfs) : null, max: ppsfs.length ? Math.max(...ppsfs) : null,
        implied: avg && subject.bldg_sqft ? avg * subject.bldg_sqft : null,
      };
      setData({ subject, comps, stats });
      setNotes(loadCompNote(subject.deal_id));
      setLeaseTerms(loadLeaseTerms(subject.deal_id));
    } catch (e) { setError(e.message || "Something went wrong."); }
    finally { setLoading(false); }
  };

  const pullRent = async () => {
    if (!data) return;
    setRent({ state: "loading", text: "", err: "" });
    try {
      const where = [data.subject.address, data.subject.borough].filter(Boolean).join(", ");
      const q = `What are current asking RETAIL rents (per SF/year) near ${where}? Give the corridor/neighborhood asking-rent range and cite specific sources — REBNY's Manhattan Retail Report, brokerage market reports (Cushman/CBRE/JLL/Colliers), and any recently reported lease deals. Be clear these are asking rents and name each source.`;
      const m = webResearchMode();
      const d = await postJSON("/api/research", { mode: m, password: pw, query: q });
      if (m === "web") addScoutSpend(WEB_RUN_COST);
      setRent({ state: "done", text: d.brief || "No rent context found.", err: "" });
    } catch (e) { setRent({ state: "error", text: "", err: e.message || "Rent lookup failed." }); }
  };

  // Live-web sale comps (Pro): real reported transaction prices from news/public sources,
  // to verify/augment the recorded ACRIS figures and catch sales records miss.
  const pullSales = async () => {
    if (!data) return;
    setSales({ state: "loading", text: "", err: "" });
    try {
      const where = [data.subject.address, data.subject.borough].filter(Boolean).join(", ");
      const q = `Find RECENT reported commercial/retail building SALES near ${where} (within ~0.25 mile, last ~5 years). For each, give the address, sale price, sale date, and building size or $/SF if reported, and CITE the source (The Real Deal, Commercial Observer, public records, broker release). List them SORTED BY PRICE (highest first). Only include sales you actually find with a source — do not estimate or invent prices.`;
      const m = webResearchMode();
      const d = await postJSON("/api/research", { mode: m, password: pw, query: q });
      if (m === "web") addScoutSpend(WEB_RUN_COST);
      setSales({ state: "done", text: d.brief || "No reported sales found.", err: "" });
    } catch (e) { setSales({ state: "error", text: "", err: e.message || "Sales lookup failed." }); }
  };

  // Lease verification: recorded ACRIS leases for the subject (free) + reported retail
  // lease deals nearby from the web (metered). No public lease DB exists, so this surfaces
  // the available evidence; the user fills in actual terms below as they confirm them.
  const findLeases = async () => {
    if (!data) return;
    setLeases({ state: "loading", recorded: [], text: "", err: "" });
    try {
      const s2 = data.subject;
      const where = [s2.address, s2.borough].filter(Boolean).join(", ");
      const q = `Find RECENTLY REPORTED RETAIL LEASE deals near ${where} (same corridor, last ~3 years). For each, give the tenant, the address, the rent ($/SF/yr if reported), the term/length, and CITE the source (The Real Deal, Commercial Observer, broker release). Only include leases you actually find with a source — never invent a tenant, rent, or term. If little is reported, say so.`;
      const m = webResearchMode();
      const [lc, research] = await Promise.all([
        (s2.borough && s2.block)
          ? postJSON("/api/leasecomps", { password: pw, borough: s2.borough, block: s2.block }).catch(() => ({ leases: [] }))
          : Promise.resolve({ leases: [] }),
        postJSON("/api/research", { mode: m, password: pw, query: q }).catch((e) => ({ _err: e.message })),
      ]);
      if (m === "web" && research && !research._err) addScoutSpend(WEB_RUN_COST);
      const recorded = lc.leases || [];
      setLeases({ state: "done", recorded, text: research && research.brief ? research.brief : (research && research._err ? "" : "No reported leases found."), err: research && research._err ? research._err : "" });
    } catch (e) { setLeases({ state: "error", recorded: [], text: "", err: e.message || "Lease lookup failed." }); }
  };

  // Editable, persisted "known lease terms" (per subject BBL) — fill in real terms as found.
  const LEASE_STORE = "fr_comp_leaseterms_v1";
  const loadLeaseTerms = (bbl) => { try { return (JSON.parse(localStorage.getItem(LEASE_STORE) || "{}"))[bbl] || ""; } catch { return ""; } };
  const updateLeaseTerms = (t) => {
    setLeaseTerms(t);
    try { const all = JSON.parse(localStorage.getItem(LEASE_STORE) || "{}"); const bbl = data && data.subject.deal_id; if (bbl) { if (t) all[bbl] = t; else delete all[bbl]; localStorage.setItem(LEASE_STORE, JSON.stringify(all)); } } catch { /* quota */ }
  };

  // Re-sort comps for display without refetching.
  const sortComps = (arr) => {
    const a = [...arr];
    if (sortBy === "ppsf") a.sort((x, y) => (y._ppsf || 0) - (x._ppsf || 0));
    else if (sortBy === "price") a.sort((x, y) => (y._price || 0) - (x._price || 0));
    else a.sort((x, y) => (y._saleYear || "").localeCompare(x._saleYear || ""));
    return a;
  };

  const s = data && data.subject;
  const st = data && data.stats;
  const cell = { padding: "7px 10px", fontSize: 12, borderBottom: `1px solid ${C.line}`, textAlign: "left" };
  const numCell = { ...cell, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" };
  const kv = (label, val) => (<><div style={{ color: C.muted, fontSize: 12 }}>{label}</div><div style={{ color: C.ivory, fontSize: 12.5 }}>{val ?? "—"}</div></>);

  return (
    <div style={{ marginTop: 22 }}>
      {/* print rules: when printing, show only the comp sheet */}
      <style>{`.cs-print-only{ display:none; } @media print { body * { visibility: hidden !important; } #compsheet, #compsheet * { visibility: visible !important; } #compsheet { position: absolute; left: 0; top: 0; width: 100%; } .no-print { display: none !important; } .cs-print-only { display: block !important; } }`}</style>

      {/* Controls */}
      <div className="no-print" style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 12, alignItems: "end" }}>
          <label>
            <div className="mono" style={labelStyle}>SUBJECT ADDRESS — type &amp; pick</div>
            <div style={{ marginTop: 4 }}>
              <AddressAutocomplete value={nearAddress}
                onChange={(t) => { setNearAddress(t); setPicked(null); }}
                onPick={(label, lat, lon, bbl) => { setNearAddress(label); setPicked({ lat, lon, bbl }); }}
                placeholder="e.g. 650 5th Ave…" style={{ ...fieldStyle, width: "100%" }} />
            </div>
          </label>
          <label><div className="mono" style={labelStyle}>ASSET TYPE</div>
            <select value={assetType} onChange={(e) => setAssetType(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
              {ASSET_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <label><div className="mono" style={labelStyle}>RADIUS</div>
            <select value={radius} onChange={(e) => setRadius(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
              {[["0.1", "0.1 mi"], ["0.25", "0.25 mi"], ["0.5", "0.5 mi"], ["1", "1 mi"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <label><div className="mono" style={labelStyle}>SOLD WITHIN</div>
            <select value={lookback} onChange={(e) => setLookback(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
              {[["3", "3 years"], ["5", "5 years"], ["7", "7 years"], ["10", "10 years"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
          <button onClick={generate} disabled={loading} className="mono lift"
            style={{ cursor: loading ? "default" : "pointer", fontSize: 12, padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold, opacity: loading ? 0.5 : 1 }}>
            {loading ? "BUILDING…" : "■ GENERATE COMP SHEET"}
          </button>
          {data && <>
            <button onClick={() => downloadBlob(compsToCSV({ ...s, _ppsf: null, _price: purchasePrice(s), _saleYear: purchaseDate(s) }, sortComps(data.comps)), `comp-sheet-${(s.address || "subject").replace(/[^a-z0-9]+/gi, "-")}.csv`, "text/csv")}
              className="mono" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ CSV</button>
            <button onClick={() => {
              const html = onePagerHTML(s, sortComps(data.comps), data.stats, { radius, lookback, assetType }, rent.state === "done" ? rent.text : "", siteHighlights(s), notes, preparedBy, leaseTerms);
              const w = window.open("", "_blank");
              if (!w) { setError("Allow pop-ups for this site to open the one-pager."); return; }
              w.document.open(); w.document.write(html); w.document.close();
            }} className="mono lift" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold }}>⤓ ONE-PAGER</button>
            <button onClick={() => window.print()} className="mono" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>⎙ PRINT</button>
            <label className="mono" style={{ marginLeft: "auto", fontSize: 11, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}>SORT
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ ...fieldStyle, padding: "6px 8px", fontSize: 12 }}>
                {[["recent", "Most recent"], ["price", "Price (high→low)"], ["ppsf", "$/SF (high→low)"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></label>
          </>}
        </div>
        {data && (
          <div style={{ marginTop: 10 }}>
            <div className="mono" style={labelStyle}>PREPARED BY (optional — your name / firm)</div>
            <input value={preparedBy} onChange={(e) => setPrepared(e.target.value)} placeholder="e.g. Jordan Avery · Avery Retail Advisory"
              style={{ ...fieldStyle, width: "100%", marginTop: 4, maxWidth: 420 }} />
          </div>
        )}
        {error && <div style={{ marginTop: 12, fontSize: 12.5, color: C.red, background: `${C.red}10`, border: `1px solid ${C.red}40`, borderRadius: 8, padding: "9px 12px" }}>{error}</div>}
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>
          Comps are nearby {assetType === "any" ? "" : assetType + " "}properties that traded in the lookback window, with $/SF from the recorded ACRIS price ÷ PLUTO building area. Rent comps populate via live web research (REBNY / brokerage reports) once Vercel Pro is on.
        </div>
      </div>

      {/* The tear sheet */}
      {data && (
        <div id="compsheet" style={{ marginTop: 18, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 24, color: C.ivory }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: `2px solid ${C.ivory}`, paddingBottom: 10 }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "0.01em" }}>Retail Comparable Analysis</div>
              {preparedBy.trim() && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Prepared by {preparedBy}</div>}
            </div>
            <div className="mono" style={{ fontSize: 10, color: C.muted, textAlign: "right" }}>{new Date().toLocaleDateString()}<br />{data.comps.length} comps · {radius} mi · ≤{lookback}y</div>
          </div>

          {/* Subject */}
          <div style={{ marginTop: 16 }}>
            <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", marginBottom: 8 }}>SUBJECT PROPERTY</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{s.address || "—"}</div>
            <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{[s.borough, s.doc_type && `class ${s.doc_type}`].filter(Boolean).join(" · ")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, auto 1fr)", gap: "4px 14px", marginTop: 12 }}>
              {kv("Owner", s.deed_owner || s.name || "—")}
              {kv("Building SF", s.bldg_sqft ? Number(s.bldg_sqft).toLocaleString() : "—")}
              {kv("Retail SF", s.retail_sqft ? Number(s.retail_sqft).toLocaleString() : "—")}
              {kv("Lot SF", s.lot_sqft ? Number(s.lot_sqft).toLocaleString() : "—")}
              {kv("Year built", s.year_built || "—")}
              {kv("Frontage", s.frontage_ft ? `${s.frontage_ft} ft` : "—")}
              {kv("Zoning", s.zoning || "—")}
              {kv("Assessed", assessedValue(s) != null ? fmtAmount(assessedValue(s)) : "—")}
              {kv("Last sale", purchasePrice(s) != null && purchasePrice(s) !== "" ? `${fmtAmount(purchasePrice(s))}${purchaseDate(s) ? ` (${purchaseDate(s)})` : ""}` : "—")}
              {kv("Implied value", st.implied != null ? `${fmtAmount(Math.round(st.implied))}` : "—")}
            </div>
          </div>

          {/* Owner currency, portfolio-deed context, and a link to the actual deed */}
          {(s.last_deed_id || s.portfolio_sale || (s.deed_owner && s.name && s.deed_owner.toUpperCase() !== s.name.toUpperCase())) && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: C.muted, lineHeight: 1.65 }}>
              {s.deed_owner && s.name && s.deed_owner.toUpperCase() !== s.name.toUpperCase() && (
                <div>Owner per latest deed: <strong style={{ color: C.ivory }}>{s.deed_owner}</strong> — PLUTO assessor still lists "{s.name}" (annual snapshot, can lag a sale by 1–2 years).</div>
              )}
              {s.portfolio_sale && (
                <div>ⓘ Most recent transfer was a <strong style={{ color: C.ivory }}>portfolio / bulk deed</strong> conveying {s.last_deed_lots} lots{s.portfolio_total_price ? ` for ${fmtAmount(s.portfolio_total_price)} total` : ""}{s.last_sale_date ? ` (${String(s.last_sale_date).slice(0, 10)})` : ""} — this lot's individual price isn't separable from the bundle. {acrisDeedUrl(s.last_deed_id) && <a href={acrisDeedUrl(s.last_deed_id)} target="_blank" rel="noreferrer" style={{ color: C.gold }}>View deed ↗</a>}</div>
              )}
              {!s.portfolio_sale && s.last_deed_id && (
                <div><a href={acrisDeedUrl(s.last_deed_id)} target="_blank" rel="noreferrer" style={{ color: C.gold }}>View recorded deed ↗</a> <span>(ACRIS document {s.last_deed_id})</span></div>
              )}
            </div>
          )}

          {/* Investment highlights (auto from PLUTO attributes) */}
          {siteHighlights(s).length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", marginBottom: 8 }}>INVESTMENT HIGHLIGHTS</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {siteHighlights(s).map((t, i) => <li key={i} style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 3 }}>{t}</li>)}
              </ul>
            </div>
          )}

          {/* Stats band */}
          <div style={{ display: "flex", gap: 0, marginTop: 18, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
            {[["COMPS", st.count], ["AVG $/SF", st.avg != null ? `$${Math.round(st.avg).toLocaleString()}` : "—"], ["MEDIAN $/SF", st.median != null ? `$${Math.round(st.median).toLocaleString()}` : "—"], ["RANGE $/SF", st.min != null ? `$${Math.round(st.min).toLocaleString()}–${Math.round(st.max).toLocaleString()}` : "—"]].map(([k, v], i) => (
              <div key={k} style={{ flex: 1, padding: "10px 12px", borderLeft: i ? `1px solid ${C.line}` : "none", background: C.ink }}>
                <div className="mono" style={{ fontSize: 9, color: C.muted, letterSpacing: "0.12em" }}>{k}</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3 }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Comps table */}
          <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "18px 0 8px" }}>SALES COMPARABLES</div>
          {data.comps.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.muted }}>No recorded retail sales in this radius and window. Try a wider radius or longer lookback.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>
                {["#", "Address", "Sold", "Price", "Bldg SF", "$/SF", "Yr", "Dist"].map((h, i) => <th key={h} style={{ ...cell, color: C.muted, fontWeight: 600, textAlign: i >= 3 && i <= 5 ? "right" : "left" }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {sortComps(data.comps).map((c, i) => (
                  <tr key={c.deal_id || i}>
                    <td style={{ ...cell, color: C.muted }}>{i + 1}</td>
                    <td style={cell}>{c.address}</td>
                    <td style={cell}>{c.last_deed_id ? <a href={acrisDeedUrl(c.last_deed_id)} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }} title="View recorded deed in ACRIS">{c._saleYear} ↗</a> : c._saleYear}</td>
                    <td style={numCell}>{fmtAmount(c._price)}</td>
                    <td style={numCell}>{Number(c.bldg_sqft).toLocaleString()}</td>
                    <td style={{ ...numCell, fontWeight: 700, color: C.gold }}>${Math.round(c._ppsf).toLocaleString()}</td>
                    <td style={numCell}>{c.year_built || "—"}</td>
                    <td style={numCell}>{c.distance != null ? Number(c.distance).toFixed(2) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Notes / investment thesis — editable, persisted, and printed */}
          <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "20px 0 8px" }}>NOTES · INVESTMENT THESIS</div>
          <textarea className="no-print" value={notes} onChange={(e) => updateNotes(e.target.value)} rows={Math.max(3, notes.split("\n").length)}
            placeholder="Why is this site attractive? Add your thesis, or click ✦ Draft to have Claude propose one from the property's attributes…"
            style={{ width: "100%", resize: "vertical", fontFamily: "Archivo, sans-serif", fontSize: 12.5, lineHeight: 1.6, color: C.ivory, background: C.ink, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px" }} />
          <div className="no-print" style={{ marginTop: 6 }}>
            <button onClick={draftThesis} disabled={drafting} style={{ cursor: drafting ? "default" : "pointer", fontSize: 11.5, padding: "6px 12px", borderRadius: 7, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold, opacity: drafting ? 0.5 : 1 }}>{drafting ? "▸ drafting…" : "✦ Draft thesis"}</button>
          </div>
          {notes.trim() && <div className="cs-print-only" style={{ fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap", marginTop: 4 }}>{notes}</div>}

          {/* Rent comps */}
          <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "20px 0 8px" }}>RENT COMPARABLES <span style={{ color: C.muted }}>(asking · corridor)</span></div>
          {rent.state === "idle" && (
            <div style={{ fontSize: 12.5, color: C.muted }}>
              <button className="no-print" onClick={pullRent} style={{ cursor: "pointer", fontSize: 12, padding: "7px 13px", borderRadius: 7, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold }}>✦ Pull rent context</button>
              <span style={{ marginLeft: 10 }}>Synthesizes corridor asking rents from REBNY + brokerage reports. Live web on Pro; on the current plan it answers from model knowledge and flags what needs live web.</span>
            </div>
          )}
          {rent.state === "loading" && <div className="mono" style={{ fontSize: 11, color: C.gold }}>▸ pulling rent context…</div>}
          {rent.state === "error" && <div style={{ fontSize: 12.5, color: C.red }}>{rent.err}</div>}
          {rent.state === "done" && <ResearchBriefBody text={rent.text} />}

          {/* Online market sales — verifies/augments the recorded comps with reported deals (live web on Pro) */}
          <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "20px 0 8px" }}>MARKET SALES <span style={{ color: C.muted }}>(reported · online)</span></div>
          {sales.state === "idle" && (
            <div style={{ fontSize: 12.5, color: C.muted }}>
              <button className="no-print" onClick={pullSales} style={{ cursor: "pointer", fontSize: 12, padding: "7px 13px", borderRadius: 7, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold }}>✦ Pull market sales</button>
              <span style={{ marginLeft: 10 }}>Finds recently reported nearby sales (price, date, source) and sorts by price — the online cross-check for the recorded comps above. Live web on Pro.</span>
            </div>
          )}
          {sales.state === "loading" && <div className="mono" style={{ fontSize: 11, color: C.gold }}>▸ searching reported sales…</div>}
          {sales.state === "error" && <div style={{ fontSize: 12.5, color: C.red }}>{sales.err}</div>}
          {sales.state === "done" && <ResearchBriefBody text={sales.text} />}

          {/* Lease comps — recorded ACRIS leases on the block (free) + reported corridor leases (web) + your own terms */}
          <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "20px 0 8px" }}>LEASE COMPS <span style={{ color: C.muted }}>(recorded · reported)</span></div>
          {leases.state === "idle" && (
            <div style={{ fontSize: 12.5, color: C.muted }}>
              <button className="no-print" onClick={findLeases} style={{ cursor: "pointer", fontSize: 12, padding: "7px 13px", borderRadius: 7, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold }}>✦ Find lease comps</button>
              <span style={{ marginLeft: 10 }}>Pulls ACRIS-recorded leases on this block (tenant + landlord, free) and recently reported retail leases on the corridor (tenant/rent/term, web). No public lease database exists, so recorded leases are sparse — record confirmed terms below.</span>
            </div>
          )}
          {leases.state === "loading" && <div className="mono" style={{ fontSize: 11, color: C.gold }}>▸ checking recorded + reported lease comps…</div>}
          {leases.state === "error" && <div style={{ fontSize: 12.5, color: C.red }}>{leases.err}</div>}
          {leases.state === "done" && (<>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>Recorded leases (ACRIS, this block): {leases.recorded.length === 0 ? <span>none on record (most retail leases aren't recorded)</span> : null}</div>
            {leases.recorded.map((h, i) => (
              <div key={i} style={{ fontSize: 12.5, marginBottom: 2 }}>
                <span className="mono" style={{ color: C.muted }}>{h.date || "—"}</span> · {h.doc_label} · <span style={{ color: C.ivory }}>{h.address || "—"}</span>
                {h.tenant && <span> · tenant <span style={{ color: C.ivory }}>{h.tenant}</span></span>}
                {h.landlord && <span style={{ color: C.muted }}> ← {h.landlord}</span>}
                {h.document_id && <a href={acrisDeedUrl(h.document_id)} target="_blank" rel="noreferrer" style={{ color: C.gold, marginLeft: 6 }}>↗</a>}
              </div>
            ))}
            {leases.text && <div style={{ marginTop: 8 }}><div style={{ fontSize: 12, color: C.muted, marginBottom: 2 }}>Reported leases (web · corridor):</div><ResearchBriefBody text={leases.text} /></div>}
          </>)}

          {/* Your confirmed lease terms (editable + persisted + printed) */}
          <div style={{ marginTop: 12 }}>
            <div className="mono no-print" style={{ fontSize: 10, color: C.muted, letterSpacing: "0.1em", marginBottom: 4 }}>CONFIRMED LEASE TERMS (yours)</div>
            <textarea className="no-print" value={leaseTerms} onChange={(e) => updateLeaseTerms(e.target.value)} rows={Math.max(2, leaseTerms.split("\n").length)}
              placeholder="Enter actual lease terms as you confirm them — e.g. Tenant · 4,200 SF · $425/SF NNN · 10yr term, expires 2031 · source. Saved with this property and printed on the sheet."
              style={{ width: "100%", resize: "vertical", fontFamily: "Archivo, sans-serif", fontSize: 12.5, lineHeight: 1.6, color: C.ivory, background: C.ink, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 11px" }} />
            {leaseTerms.trim() && <div className="cs-print-only" style={{ fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap", marginTop: 4 }}>{leaseTerms}</div>}
          </div>

          <div style={{ marginTop: 18, paddingTop: 10, borderTop: `1px solid ${C.line}`, fontSize: 9.5, color: C.muted, lineHeight: 1.5 }}>
            Sources: NYC ACRIS (recorded sale prices) + PLUTO (building areas) for sales comps; rent comps via published market reports. $/SF = recorded deed price ÷ PLUTO gross building area; recorded prices can include non-arm's-length transfers — verify outliers. Asking rents are not effective/in-place rents. For internal underwriting use.
          </div>
        </div>
      )}
    </div>
  );
}

// Saved properties + per-property notes, persisted in the browser (localStorage).
// Lets the team flag targets and jot notes without a DB — the first step toward a
// real pipeline (and the foundation for the future shared hub).
const SAVED_KEY = "fr_saved_v1", NOTES_KEY = "fr_notes_v1";
function loadSaved() { try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch { return []; } }
function persistSaved(arr) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(arr)); } catch { /* quota */ } }
function loadNotes() { try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || {}; } catch { return {}; } }
function saveNote(id, text) { try { const o = loadNotes(); if (text) o[id] = text; else delete o[id]; localStorage.setItem(NOTES_KEY, JSON.stringify(o)); } catch { /* quota */ } }

function downloadBlob(content, name, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

// Real .xlsx export (SheetJS, loaded on demand so it never weighs down the main
// bundle). `cols` is the same [label, getter] shape the CSV builders use, so any
// list that exports CSV can export Excel from one column definition.
async function downloadXlsx(filename, sheetName, cols, items) {
  const mod = await import("xlsx");
  const XLSX = mod.utils ? mod : mod.default;
  const header = cols.map((c) => c[0]);
  const rows = items.map((it) => cols.map((c) => c[1](it)));
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map((h, i) => ({ wch: Math.min(44, Math.max(h.length + 2, ...rows.slice(0, 200).map((r) => String(r[i] ?? "").length + 1))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename);
}

const LEAD_COLS = [
  { key: "name", label: "Name" }, { key: "entity_type", label: "Type" }, { key: "role", label: "Role" },
  { key: "pinned", label: "This property", get: (r) => (r.pinned ? "YES" : "") },
  { key: "address", label: "Property" }, { key: "borough", label: "Borough" },
  { key: "retail_sqft", label: "Retail SF" }, { key: "bldg_sqft", label: "Building SF" }, { key: "lot_sqft", label: "Lot SF" },
  { key: "assessed_value", label: "Assessed value ($)", get: (r) => assessedValue(r) ?? "" },
  { key: "purchase_price", label: "Purchase price ($)", get: (r) => purchasePrice(r) ?? "" },
  { key: "purchase_year", label: "Purchase year", get: (r) => purchaseDate(r) },
  { key: "doc_type", label: "Building class" }, { key: "source", label: "Source" },
  { key: "contact_address", label: "Contact address" }, { key: "city", label: "City" },
  { key: "state", label: "State" }, { key: "zip", label: "Zip" },
  { key: "years_owned", label: "Years owned" }, { key: "absentee", label: "Absentee" },
  { key: "tax_lien", label: "Tax lien" }, { key: "portfolio_count", label: "Owner #props in set" },
  { key: "built_far", label: "Built FAR" }, { key: "max_far", label: "Max FAR" }, { key: "buildable_sqft", label: "Unused buildable sf" },
  { key: "lat", label: "Lat" }, { key: "lon", label: "Lon" },
];

function leadsToCSV(rows) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const head = LEAD_COLS.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => LEAD_COLS.map((c) => esc(c.get ? c.get(r) : r[c.key])).join(",")).join("\n");
  return head + "\n" + body;
}

// A lean CSV shaped for skip-trace providers (BatchData/Enformion/TLO/Terrakotta):
// owner name + mailing address split out, with the property + BBL as reference.
// This is what they ingest to return phone/email — one clean upload.
const SKIPTRACE_COLS = [
  ["Owner Name", (r) => r.name],
  ["Mailing Street", (r) => r.contact_address],
  ["Mailing City", (r) => r.city],
  ["Mailing State", (r) => r.state],
  ["Mailing Zip", (r) => r.zip],
  ["Property Address", (r) => r.address],
  ["Borough", (r) => r.borough],
  ["BBL", (r) => r.deal_id],
];
function skiptraceCSV(rows) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const head = SKIPTRACE_COLS.map((c) => esc(c[0])).join(",");
  // Only rows with a usable mailing address are worth skip-tracing; dedupe by owner.
  const seen = new Set();
  const usable = rows.filter((r) => {
    if (!r.contact_address) return false;
    const k = `${(r.name || "").toUpperCase()}|${(r.contact_address || "").toUpperCase()}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  const body = usable.map((r) => SKIPTRACE_COLS.map((c) => esc(c[1](r))).join(",")).join("\n");
  return head + "\n" + body;
}
const fmtAmount = (a) => (a == null || a === "" ? "" : "$" + Number(a).toLocaleString());
// Two different dollar figures live on a row and must never be conflated:
//  • ASSESSED VALUE — the City's tax assessment (PLUTO `assesstot`). Not a sale price.
//  • PURCHASE PRICE — what the current owner actually paid (latest ACRIS deed).
// For PLUTO rows `amount` is the assessment and `last_sale_price` is the purchase.
// For ACRIS rows `amount` IS the deed/sale price (no assessment available).
const assessedValue = (r) => (r.source === "pluto" ? r.amount : null);
const purchasePrice = (r) => (r.source === "pluto" ? r.last_sale_price : r.amount);
const purchaseDate = (r) => {
  const d = r.source === "pluto" ? r.last_sale_date : r.deal_date;
  return d ? String(d).slice(0, 4) : "";
};
const fmtMoneyShort = (n) => {
  if (n == null || n === "") return "";
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K";
  return "$" + n;
};
// The party's mailing address (mainly from ACRIS) — where to reach the lead.
const mailing = (r) => [r.contact_address, [r.city, r.state].filter(Boolean).join(", "), r.zip].filter(Boolean).join(" · ");
// Google Maps link for a result — precise pin when we have coordinates (PLUTO),
// otherwise a text address search. No API key required.
function mapUrl(r) {
  if (r.lat != null && r.lon != null) return `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lon}`;
  const q = [r.address, r.borough, "NY"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// Free one-click contact-lookup links per owner (no API/key) — targeted tools, not
// generic search. People -> Whitepages + TruePeopleSearch (phone). Companies ->
// OpenCorporates (find the principals) + LinkedIn + RocketReach (business email/phone).
const ACTION_PILL = { display: "inline-block", cursor: "pointer", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 6, padding: "3px 8px", color: C.gold, fontSize: 11, textDecoration: "none", whiteSpace: "nowrap" };

function isCompanyRow(r) {
  return r.entity_type === "company" || /\b(LLC|INC|CORP|CO|COMPANY|LP|LLP|TRUST|ASSOCIATES|REALTY|PARTNERS|HOLDINGS|GROUP|MANAGEMENT|PROPERTIES|HDFC|FUND|BANK)\b/i.test(r.name || "");
}
function lookupLinks(r) {
  const enc = encodeURIComponent;
  const slug = (s) => String(s || "").trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Reverse-address phone lookup on the owner's MAILING address — for absentee owners
  // this is their home, so TruePeopleSearch returns the resident's name + phone. This is
  // the most effective free way to get an actual number.
  const addr = r.contact_address || "";
  const csz = [[r.city, r.state].filter(Boolean).join(", "), r.zip].filter(Boolean).join(" ");
  const tpsAddr = addr ? { label: "📞 Phone at mailing addr", href: `https://www.truepeoplesearch.com/resultaddress?streetaddress=${enc(addr)}${csz ? `&citystatezip=${enc(csz)}` : ""}` } : null;

  if (isCompanyRow(r)) {
    const co = r.name || "";
    return [
      // Company website — Google surfaces the firm's official site (+ knowledge panel with
      // phone/address) as the top result. Keyless; the real fetched URL needs a search key.
      { label: "🌐 Website", href: `https://www.google.com/search?q=${enc(`"${co}" official website`)}` },
      // OpenCorporates → the LLC's actual officers/principals (a real human to skip-trace).
      { label: "🏢 NY officers (OpenCorporates)", href: `https://opencorporates.com/companies?q=${enc(co)}&jurisdiction_code=us_ny` },
      ...(tpsAddr ? [tpsAddr] : []),
      // LinkedIn PEOPLE search (not "all") so it surfaces humans tied to the firm, not the entity page.
      { label: "👤 LinkedIn people", href: `https://www.linkedin.com/search/results/people/?keywords=${enc(co)}` },
    ];
  }
  const first = r.first_name || "";
  const last = r.last_name || "";
  const name = (first && last) ? `${first} ${last}` : (r.name || "");
  const cityState = [r.city, r.state].filter(Boolean).join(", ");
  const wpName = [slug(first), slug(last)].filter(Boolean).join("-") || slug(name);
  const wpLoc = (r.city && r.state) ? `${slug(r.city)}-${r.state}` : "";
  const wp = wpName ? `https://www.whitepages.com/name/${wpName}${wpLoc ? `/${wpLoc}` : ""}` : "https://www.whitepages.com/";
  return [
    ...(tpsAddr ? [tpsAddr] : []),
    { label: "📞 TruePeopleSearch", href: `https://www.truepeoplesearch.com/results?name=${enc(name)}${cityState ? `&citystatezip=${enc(cityState)}` : ""}` },
    { label: "📞 Whitepages", href: wp },
    { label: "👤 LinkedIn", href: `https://www.linkedin.com/search/results/people/?keywords=${enc(name)}` },
  ];
}

// Is the space currently on the market? No public feed exists, so these run targeted
// searches of the major listing sites for THIS address (for-lease + for-sale).
function onMarketLinks(r) {
  const enc = encodeURIComponent;
  const q = [r.address, r.borough, "NY"].filter(Boolean).join(" ");
  return [
    { label: "For lease", href: `https://www.google.com/search?q=${enc(`"${r.address}" ${r.borough || ""} for lease (site:loopnet.com OR site:crexi.com)`)}` },
    { label: "For sale", href: `https://www.google.com/search?q=${enc(`"${r.address}" ${r.borough || ""} for sale (site:loopnet.com OR site:crexi.com)`)}` },
    { label: "LoopNet ⌕", href: `https://www.loopnet.com/search/commercial-real-estate/${enc(q)}/for-lease/` },
    { label: "Crexi ⌕", href: `https://www.crexi.com/properties?searchText=${enc(q)}` },
  ];
}

// Deep links into NYC property-research sites + commercial listing/lease sources.
const BORO_CODE = { Manhattan: "1", Bronx: "2", Brooklyn: "3", Queens: "4", "Staten Island": "5" };
// Deep-links that land on THIS property where the site allows it (Property portal,
// ZoLa, Street View); the ⌕ ones are web searches (those sites have no per-lot URL).
function researchLinks(r) {
  const boro = BORO_CODE[r.borough];
  const block = r.block ? Number(r.block) : null;
  const lot = r.lot ? Number(r.lot) : null;
  const bbl = boro && block && lot ? `${boro}${String(block).padStart(5, "0")}${String(lot).padStart(4, "0")}` : "";
  const links = [];
  if (bbl) links.push({ label: "Property portal", href: `https://propertyinformationportal.nyc.gov/parcels/parcel/${bbl}` });
  if (boro && block && lot) links.push({ label: "ZoLa zoning", href: `https://zola.planning.nyc.gov/lot/${boro}/${block}/${lot}` });
  if (r.lat != null && r.lon != null) links.push({ label: "Street View", href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${r.lat},${r.lon}` });
  links.push({ label: "Listings ⌕", href: `https://www.google.com/search?q=${encodeURIComponent(`${r.address} ${r.borough} NY for lease OR for sale (loopnet OR crexi)`)}` });
  links.push({ label: "Tenants ⌕", href: `https://www.google.com/search?q=${encodeURIComponent(`${r.address} ${r.borough} NY store OR tenant`)}` });
  return links;
}

// Google-Maps-style address lookup using NYC GeoSearch autocomplete (free, no key,
// CORS-open so the browser calls it directly). Pick a suggestion -> exact coords.
function AddressAutocomplete({ value, onChange, onPick, placeholder, style, onEnter, marketHint }) {
  const [sugs, setSugs] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const box = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function handle(text) {
    onChange(text);
    if (timer.current) clearTimeout(timer.current);
    if (!text || text.trim().length < 3) { setSugs([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      let items = [];
      // If the text names another market (Nashville, a CT/Hamptons town, Charleston), skip the
      // NYC geocoder so it doesn't surface NYC look-alikes — go straight to that market's
      // suggester / the national geocoder below. A LOCKED market (marketHint) forces this
      // regardless of the text, so "123 king st" with Charleston·SC locked never offers the
      // NYC geocoder's King St / Staten-Island-Charleston look-alikes.
      const det = marketFromText(text);
      const hint = marketHint && marketHint !== "auto" ? marketHint : null;
      const firstSeg = String(text).split(",")[0].trim();
      const nonNyc = hint
        ? (hint === "nyc" ? null : { market: hint, address: (det && det.market === hint && det.address) || firstSeg })
        : det;
      // 1) NYC GeoSearch — best for NYC and carries the lot's BBL.
      if (!nonNyc) {
        try {
          const r = await fetch(`https://geosearch.planninglabs.nyc/v2/autocomplete?text=${encodeURIComponent(text)}`);
          if (r.ok) {
            const d = await r.json();
            items = (d.features || [])
              .filter((f) => f.geometry && f.properties)
              .map((f) => ({ label: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], bbl: ((f.properties.addendum || {}).pad || {}).bbl || null }));
          }
        } catch { /* fall through to backup */ }
      }
      // 1b) NASHVILLE — pull real addresses straight from Metro's parcel layer (PropAddr), so typing
      //     "2222 12th" suggests "2222 12TH AVE S" with the house number (Photon only gives the street).
      //     Runs for an explicit Nashville search OR any bare numbered address — so a Nashville address
      //     pops up even without typing "nashville" (wrong-number / other-city hits get dropped by the
      //     house-number filter below; the user disambiguates by the ", Nashville, TN" in the label).
      const isTn = nonNyc && nonNyc.market === "tn";
      if (isTn || (!hint && !nonNyc && /^\s*\d/.test(text.trim()))) {
        try {
          const street = ((nonNyc && nonNyc.address) || text).trim();
          const m = street.match(/^(\d+)\s+(\S+)/); // house number + first street word
          const prefix = (m ? `${m[1]} ${m[2]}` : street).toUpperCase().replace(/'/g, "''");
          const url = `https://maps.nashville.gov/arcgis/rest/services/Cadastral/Parcels/MapServer/0/query?where=${encodeURIComponent(`UPPER(PropAddr) LIKE '${prefix}%'`)}&outFields=PropAddr&orderByFields=PropAddr&returnGeometry=true&outSR=4326&resultRecordCount=8&f=json`;
          const r = await fetch(url);
          if (r.ok) {
            const d = await r.json();
            const seen = new Set();
            const nash = [];
            for (const f of (d.features || [])) {
              const addr = String((f.attributes && f.attributes.PropAddr) || "").replace(/\s+/g, " ").trim();
              if (!addr || seen.has(addr)) continue;
              seen.add(addr);
              let lat = null, lon = null;
              const rings = f.geometry && f.geometry.rings;
              if (rings && rings[0] && rings[0].length) { let sx = 0, sy = 0; for (const [x, y] of rings[0]) { sx += x; sy += y; } lon = sx / rings[0].length; lat = sy / rings[0].length; }
              nash.push({ label: `${addr}, Nashville, TN`, lon, lat, bbl: null });
            }
            if (isTn) items = nash; // Metro parcel addresses are authoritative for an explicit Nashville search
            else for (const e of nash) if (!items.some((x) => x.label === e.label)) items.push(e); // else merge with NYC hits
          }
        } catch { /* fall through to Photon */ }
      }
      // 1c) CHARLESTON SC — real addresses from the county + City of Charleston address point
      //     layers, so an explicit Charleston search suggests actual parcel addresses and the
      //     pick routes to the SC engine (never the NYC geocoder's Staten Island "Charleston").
      const isSc = nonNyc && nonNyc.market === "sc";
      if (isSc) {
        try {
          const street = ((nonNyc && nonNyc.address) || text).trim();
          const m = street.match(/^(\d+)\s+(\S+)/); // house number + first street word
          const prefix = (m ? `${m[1]} ${m[2]}` : street).toUpperCase().replace(/'/g, "''");
          const mk = (feats, addrField, townField) => (feats || [])
            .filter((f) => f.attributes && f.attributes[addrField])
            .map((f) => ({
              label: `${String(f.attributes[addrField]).replace(/\s+/g, " ").trim()}, ${String((f.attributes[townField] || "Charleston")).replace(/\s+/g, " ").trim()}, SC`,
              lon: f.geometry ? f.geometry.x : null, lat: f.geometry ? f.geometry.y : null, bbl: null,
            }));
          const [city, cty] = await Promise.all([
            fetch(`https://services2.arcgis.com/tQaXW7Zb1Vphzvgd/arcgis/rest/services/City_Addresses/FeatureServer/0/query?${new URLSearchParams({ where: `UPPER(ADDRLABEL) LIKE '${prefix}%'`, outFields: "ADDRLABEL,CMTYNAME", returnGeometry: "true", outSR: "4326", resultRecordCount: "8", f: "json" })}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
            fetch(`https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/1/query?${new URLSearchParams({ where: `UPPER(WHOLE_ADDRESS) LIKE '${prefix}%'`, outFields: "WHOLE_ADDRESS,POSTAL_TOWN", returnGeometry: "true", outSR: "4326", resultRecordCount: "8", f: "json" })}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
          ]);
          const seen = new Set();
          const sc = [...mk(city.features, "ADDRLABEL", "CMTYNAME"), ...mk(cty.features, "WHOLE_ADDRESS", "POSTAL_TOWN")]
            .filter((s) => { if (seen.has(s.label)) return false; seen.add(s.label); return true; });
          if (sc.length) items = sc; // county/city address points are authoritative for an explicit Charleston search
        } catch { /* fall through to Photon */ }
      }
      // 2) National Photon (free, no key, CORS-open): runs whenever results are sparse, so an
      //    address ANYWHERE in the US surfaces. US-centroid rank bias, but NO bbox — the old NYC bbox
      //    was excluding every out-of-town address. Merged after the NYC/Nashville hits.
      if (items.length < 5) {
        try {
          // A locked market steers the national geocoder too (unless the text already names it).
          const HINT_SUFFIX = { sc: ", Charleston, SC", tn: ", Nashville, TN", ct: ", Connecticut", ny: ", Suffolk County, NY", nyc: ", New York, NY" };
          const photonQ = hint && !(det && det.market === hint) && HINT_SUFFIX[hint] ? text + HINT_SUFFIX[hint] : text;
          const r = await fetch(`https://photon.komoot.io/api?q=${encodeURIComponent(photonQ)}&limit=8&lat=39.8&lon=-98.6`);
          if (r.ok) {
            const d = await r.json();
            const extra = (d.features || [])
              .filter((f) => f.geometry)
              .map((f) => {
                const p = f.properties || {};
                const line1 = [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || "";
                const label = [line1, p.city || p.district, p.state].filter(Boolean).join(", ");
                return { label: label || p.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], bbl: null };
              })
              .filter((x) => x.label);
            for (const e of extra) if (!items.some((x) => x.label === e.label)) items.push(e);
          }
        } catch { /* keep whatever NYC items we have */ }
      }
      // If you typed a house number, drop suggestions with a DIFFERENT number — geocoders offer
      // nearby addresses (300 / 2000 …) that aren't your building, which is misleading. Keep
      // exact-number matches and street-level results (the pick handler adds your number to those).
      const typedNum = (text.match(/^\s*(\d+)\b/) || [])[1];
      if (typedNum) items = items.filter((it) => { const m = String(it.label).match(/^\s*(\d+)\b/); return !m || m[1] === typedNum; });
      items = items.slice(0, 8);
      setSugs(items); setOpen(items.length > 0);
    }, 220);
  }

  return (
    <div ref={box} style={{ position: "relative" }}>
      <input value={value} onChange={(e) => handle(e.target.value)} onFocus={() => sugs.length && setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setOpen(false); setSugs([]); if (onEnter) onEnter(); } }}
        placeholder={placeholder} autoComplete="off" style={style} />
      {open && (
        <div style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, right: 0, marginTop: 4, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, boxShadow: "0 10px 28px rgba(20,16,48,0.18)", maxHeight: 240, overflow: "auto" }}>
          {sugs.map((s, i) => (
            <div key={i} className="addr-opt" onClick={() => {
                // Photon often returns a STREET-level suggestion ("12th Avenue South, Nashville")
                // that drops the house number you typed → picking it would search the whole street.
                // If the typed text led with a house number the suggestion lacks, carry it onto the pick.
                const typedNum = (String(value || "").match(/^\s*(\d+[A-Za-z]?)\b/) || [])[1];
                const label = typedNum && !/^\s*\d/.test(s.label) ? `${typedNum} ${s.label}` : s.label;
                onPick(label, s.lat, s.lon, s.bbl); setOpen(false); setSugs([]);
              }}
              style={{ padding: "9px 12px", fontSize: 13, cursor: "pointer", borderBottom: i < sugs.length - 1 ? `1px solid ${C.line}` : "none" }}>
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_COLOR = { new: C.gold, working: C.amber, contacted: C.green, dead: C.muted };
const BOROUGHS = ["", "Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"];
const ASSET_OPTIONS = [
  ["any", "Any asset type"], ["retail", "Retail / store"], ["office", "Office"],
  ["multifamily", "Multifamily"], ["mixed_use", "Mixed-use"], ["industrial", "Industrial / warehouse"],
  ["hotel", "Hotel"], ["vacant", "Development site (vacant)"], ["one_two_family", "1–2 family"], ["condo", "Condo"],
];

const fieldStyle = { background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 7, padding: "8px 10px", fontSize: 13, fontFamily: "Archivo, sans-serif" };
const labelStyle = { fontSize: 11, color: C.muted, letterSpacing: "0.05em" };


// Hamptons / NY-State (ex-NYC) sourcing — NY assessment roll via /api/search (market: hamptons).
const HAMPTONS_TOWN_OPTIONS = [["all", "All Hamptons"], ["East Hampton", "East Hampton"], ["Southampton", "Southampton"], ["Shelter Island", "Shelter Island"]];
const NY_TYPE_OPTIONS = [["commercial", "Commercial (retail / office)"], ["any", "Any type"], ["residential", "Residential"], ["vacant", "Vacant land"], ["industrial", "Industrial"]];
function nyCSV(rows) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const cols = [["Owner", (r) => r.owner], ["Co-owner", (r) => r.co_owner], ["Mailing", (r) => r.mailing], ["Absentee", (r) => r.absentee || ""], ["Property address", (r) => r.address], ["Town", (r) => r.town], ["Use", (r) => r.use], ["Class", (r) => r.property_class], ["Assessed value", (r) => r.assessed_value], ["Market value", (r) => r.market_value], ["Frontage ft", (r) => r.frontage_ft]];
  return cols.map((c) => esc(c[0])).join(",") + "\n" + rows.map((r) => cols.map((c) => esc(c[1](r))).join(",")).join("\n");
}

// ── Unified sourcing — ONE search bar across NYC, Greenwich/CT, and the Hamptons ──
// Type a NYC borough/address, a CT town, or a Hamptons town; the market is auto-detected
// and routed to the right engine, with one results table. NYC rows keep the full dossier.
const CT_TOWN_SET = new Set(["greenwich", "darien", "new canaan", "westport", "norwalk", "stamford", "wilton", "weston", "fairfield", "ridgefield", "cos cob", "old greenwich", "riverside", "rowayton"]);
const HAMPTON_SET = new Set(["east hampton", "southampton", "shelter island", "sag harbor", "bridgehampton", "montauk", "amagansett", "water mill", "sagaponack", "wainscott", "westhampton", "westhampton beach", "quogue", "north haven", "springs", "noyac"]);
const NYC_BORO_SET = { manhattan: "Manhattan", brooklyn: "Brooklyn", queens: "Queens", bronx: "Bronx", "staten island": "Staten Island", "new york": "Manhattan", nyc: "Manhattan" };
const NASHVILLE_SET = new Set(["nashville", "davidson", "davidson county", "nashville tn", "nashville, tn", "metro nashville"]);
const CHARLESTON_SET = new Set(["charleston", "charelston", "charlston", "charleston sc", "charleston, sc", "charleston county", "mount pleasant", "mt pleasant", "north charleston", "daniel island", "james island", "johns island", "west ashley", "sullivans island", "sullivan's island", "isle of palms", "folly beach", "kiawah", "kiawah island", "seabrook island", "awendaw", "mcclellanville", "ravenel", "hollywood sc", "wadmalaw island"]);
const SAVANNAH_SET = new Set(["savannah", "savannah ga", "savannah, ga", "chatham", "chatham county", "pooler", "tybee", "tybee island", "port wentworth", "garden city", "thunderbolt", "bloomingdale", "georgetown ga"]);
const HAMLET_TOWN = { montauk: "East Hampton", amagansett: "East Hampton", wainscott: "East Hampton", springs: "East Hampton", "sag harbor": "East Hampton", bridgehampton: "Southampton", "water mill": "Southampton", sagaponack: "Southampton", westhampton: "Southampton", "westhampton beach": "Southampton", quogue: "Southampton", noyac: "Southampton", "north haven": "Southampton" };
const UNIFIED_TYPES = [["any", "Any type"], ["retail", "Retail"], ["commercial", "Commercial / office"], ["multifamily", "Multifamily"], ["residential", "Residential"], ["industrial", "Industrial"], ["vacant", "Vacant / dev site"]];
const TYPE_MAP_BY_MARKET = {
  nyc: { retail: "retail", commercial: "office", multifamily: "multifamily", residential: "one_two_family", industrial: "industrial", vacant: "vacant", any: "any" },
  ct: { retail: "commercial", commercial: "commercial", multifamily: "apartments", residential: "residential", industrial: "industrial", vacant: "vacant", any: "any" },
  ny: { retail: "commercial", commercial: "commercial", multifamily: "commercial", residential: "residential", industrial: "industrial", vacant: "vacant", any: "any" },
  tn: { retail: "retail", commercial: "commercial", multifamily: "apartments", residential: "residential", industrial: "industrial", vacant: "vacant", any: "any" },
  sc: { retail: "retail", commercial: "commercial", multifamily: "apartments", residential: "residential", industrial: "industrial", vacant: "vacant", any: "any" },
  // GA use class doesn't separate retail/office from commercial (all class C), so they all map to commercial.
  savannah: { retail: "commercial", commercial: "commercial", multifamily: "multifamily", residential: "residential", industrial: "industrial", vacant: "vacant", any: "any" },
};
const mapType = (t, m) => (TYPE_MAP_BY_MARKET[m] || {})[t] || "any";
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
// Spot a non-NYC market inside free text (typed OR a picked autocomplete label like
// "123 Broadway, Nashville, Tennessee"), and pull out the street for an address-level search.
function marketFromText(raw) {
  const k = String(raw || "").toLowerCase();
  if (/\bnashville\b|\bdavidson\b|,\s*tn\b|\btennessee\b/.test(k)) {
    const street = String(raw).replace(/,?\s*(metro\s+)?(nashville|davidson county|davidson|tennessee|tn|usa|united states).*$/i, "").replace(/[, ]+$/, "").trim();
    return { market: "tn", town: "Nashville", address: street.length >= 3 ? street : "" };
  }
  // Charleston SC metro (any Charleston County town, or a "…, SC" address naming one).
  // Spelled-tolerant (char(le|el)ston catches the common transposition), and guarded against
  // the OTHER Charlestons: Staten Island NY has a Charleston neighborhood, WV has the city.
  if (/\bchar(?:le|el)ston\b|\bmt\.?\s*pleasant\b|\bmount pleasant\b|\bdaniel island\b|\bjames island\b|\bjohns island\b|\bwest ashley\b|\bsullivan'?s island\b|\bisle of palms\b|\bfolly beach\b|\bkiawah\b|\bseabrook island\b|\bwadmalaw\b|\bawendaw\b|\bmcclellanville\b/.test(k) && !/\bwest virginia\b|,\s*wv\b|\bstaten\b|\bnew york\b|,\s*ny\b/.test(k)) {
    const street = String(raw).replace(/,?\s*(north\s+char(?:le|el)ston|char(?:le|el)ston( county)?|mt\.?\s*pleasant|mount pleasant|daniel island|james island|johns island|west ashley|sullivan'?s island|isle of palms|folly beach|kiawah( island)?|seabrook island|wadmalaw( island)?|awendaw|mcclellanville|south carolina|sc|usa|united states).*$/i, "").replace(/[, ]+$/, "").trim();
    return { market: "sc", town: "Charleston", address: street.length >= 3 && /\d/.test(street) ? street : "" };
  }
  // Savannah / Chatham County, GA (the famous one — guard against Savannah, TN in Hardin County).
  if (/\bsavannah\b|\bchatham\b|\bpooler\b|\btybee\b|\bport wentworth\b|\bthunderbolt\b|\bgarden city ga\b/.test(k) && !/,\s*tn\b|\btennessee\b/.test(k)) {
    const street = String(raw).replace(/,?\s*(savannah|chatham county|chatham|pooler|tybee island|tybee|port wentworth|garden city|thunderbolt|bloomingdale|georgetown|georgia|ga|usa|united states).*$/i, "").replace(/[, ]+$/, "").trim();
    return { market: "savannah", town: "Savannah", address: street.length >= 3 && /\d/.test(street) ? street : "" };
  }
  for (const t of CT_TOWN_SET) if (k.includes(t)) return { market: "ct", town: titleCase(t), address: firstAddrSeg(raw) };
  for (const t of HAMPTON_SET) if (k.includes(t)) return { market: "ny", town: HAMLET_TOWN[t] || titleCase(t), address: firstAddrSeg(raw) };
  return null;
}
// The street portion of a typed/picked label, ONLY when it names a specific building
// (has a house number) — lets the town-level markets (CT / Hamptons) pin one property.
function firstAddrSeg(raw) { const seg = String(raw || "").split(",")[0].trim(); return /\d/.test(seg) ? seg : ""; }
// Split "100 West Putnam Ave" → { num:"100", core:"WEST PUTNAM" }. `core` is the street name
// MINUS its trailing type suffix, so a LIKE matches whether the data says AVE/AVENUE, ST/STREET,
// RD/ROAD, etc. (keeps the full name — not just the first word — so directionals don't truncate it).
const STREET_SUFFIX = new Set(["AVE", "AVENUE", "ST", "STREET", "RD", "ROAD", "DR", "DRIVE", "LN", "LANE", "BLVD", "BOULEVARD", "CT", "COURT", "PL", "PLACE", "PKWY", "PARKWAY", "HWY", "HIGHWAY", "TER", "TERRACE", "WAY", "CIR", "CIRCLE", "TPKE", "TURNPIKE", "SQ", "SQUARE", "ROW", "PLZ", "PLAZA", "PATH", "WALK", "ALY", "ALLEY", "TRL", "TRAIL", "LOOP", "PIKE", "CV", "COVE"]);
function streetBits(addr) {
  const s = String(addr || "").trim();
  const m = s.match(/^(\d+[A-Za-z]?)\s+(.+)$/);
  const num = m ? m[1] : "";
  let toks = (m ? m[2] : s).toUpperCase().trim().split(/\s+/);
  // The street name ENDS at its type suffix (St/Ave/Rd…). The name is everything before the
  // first suffix token that isn't the very first word (a street needs a name before the
  // suffix — "Court St" → COURT, not empty). Whatever follows the suffix is town/state/zip
  // noise the user typed without commas ("145 Greenwich Ave Greenwich CT 06830") — drop it,
  // so the LIKE matches the street, not the whole string. Falls back to trimming just a
  // trailing suffix when there's no interior suffix.
  const si = toks.findIndex((t, i) => i >= 1 && STREET_SUFFIX.has(t));
  if (si >= 1) toks = toks.slice(0, si);
  else if (toks.length > 1 && STREET_SUFFIX.has(toks[toks.length - 1])) toks.pop();
  return { num, core: toks.join(" ") };
}
// Does a property address carry/cover the target house number? Handles a single number OR a
// RANGE ("252-264", "1216-1252" — common for assembled CT/retail lots), zero-padding, and both
// number-FIRST formats (NYC/TN/Hamptons "36 MAIN ST") and street-first/padded CT ("GREENWICH
// AVENUE 0252-0264"). `trailing` = read the number group off the END (CT) vs the START.
function houseInAddress(address, numStr, trailing) {
  const n = Number(numStr);
  if (!Number.isFinite(n)) return false;
  const m = trailing
    ? String(address || "").match(/(\d+)(?:\s*-\s*(\d+))?\s*$/)
    : String(address || "").match(/^\s*(\d+)(?:\s*-\s*(\d+))?/);
  if (!m) return false;
  const lo = Number(m[1]);
  const hi = m[2] != null ? Number(m[2]) : lo;
  return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
}
const US_STATE_CODES = new Set(["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"]);
const inNycBox = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= 40.49 && lat <= 40.92 && lon >= -74.3 && lon <= -73.69;
function unifiedDetect(loc, coords) {
  const raw = String(loc || "").trim();
  const mt = marketFromText(raw);
  // A picked autocomplete result carries coords. Non-NYC named market wins; a NYC lot (has BBL or
  // sits in the NYC box) takes the point-search path; anything else in the US -> web research.
  if (coords) {
    if (mt && mt.market !== "nyc") return { ...mt, kind: "address-text" };
    if (coords.bbl || inNycBox(Number(coords.lat), Number(coords.lon))) return { market: "nyc", kind: "address" };
    return { market: "web", kind: "address", address: raw, coords };
  }
  const k = raw.toLowerCase();
  if (!k) return { market: null };
  if (k in NYC_BORO_SET) return { market: "nyc", kind: "borough", borough: NYC_BORO_SET[k] };
  if (CT_TOWN_SET.has(k)) return { market: "ct", town: titleCase(raw) };
  if (HAMPTON_SET.has(k)) return { market: "ny", town: HAMLET_TOWN[k] || titleCase(raw) };
  if (NASHVILLE_SET.has(k)) return { market: "tn", town: "Nashville" };
  if (CHARLESTON_SET.has(k)) return { market: "sc", town: "Charleston" };
  if (SAVANNAH_SET.has(k)) return { market: "savannah", town: "Savannah" };
  // Free text naming a non-NYC market (e.g. "123 Broadway, Nashville") routes there, not to NYC.
  if (mt) return { ...mt, kind: "address-text" };
  // A typed address naming a non-NY US state (e.g. "500 Main St, Austin, TX") -> nationwide web research.
  const st = (raw.match(/,\s*([A-Za-z]{2})\b\.?(?:\s+\d{5})?\s*$/) || [])[1];
  if (st && US_STATE_CODES.has(st.toUpperCase()) && st.toUpperCase() !== "NY") return { market: "web", kind: "address-text", address: raw };
  // Otherwise a bare street address (number/comma) is treated as NYC (the only point-search market).
  if (/\d/.test(raw) || raw.includes(",")) return { market: "nyc", kind: "address-text", nearAddress: raw };
  return { market: null };
}
const UNIFIED_COLS = [["Opportunity", (r) => { const g = opportunityScore(r); return g ? g.overall : ""; }], ["Grade", (r) => { const g = opportunityScore(r); return g ? g.rec : ""; }], ["Market", (r) => r.marketLabel], ["Owner", (r) => r.owner], ["Mailing", (r) => r.mailing], ["Absentee", (r) => r.absentee || ""], ["Address", (r) => r.address], ["Use", (r) => r.use], ["Value", (r) => r.value]];
function unifiedCSV(rows) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  return UNIFIED_COLS.map((c) => esc(c[0])).join(",") + "\n" + rows.map((r) => UNIFIED_COLS.map((c) => esc(c[1](r))).join(",")).join("\n");
}
const nycRow = (l) => ({ market: "nyc", marketLabel: "NYC", owner: l.name, address: l.address, use: l.doc_type ? `class ${l.doc_type}` : (l.retail_sqft ? "Retail" : ""), value: assessedValue(l) != null ? fmtAmount(assessedValue(l)) : "", absentee: l.absentee, mailing: mailing(l), mapsUrl: mapUrl(l), raw: l });
const ctRow = (p) => ({ market: "ct", marketLabel: `${p.town}, CT`, owner: p.owner, address: p.address, use: p.use, value: p.assessed_value ? fmtAmount(p.assessed_value) : "", absentee: p.absentee, mailing: p.mailing, mapsUrl: p.maps_url, raw: p });
const nyRow = (p) => ({ market: "ny", marketLabel: `${p.town}, NY`, owner: p.owner, address: p.address, use: p.use, value: p.assessed_value ? fmtAmount(p.assessed_value) : "", absentee: p.absentee, mailing: p.mailing, mapsUrl: p.maps_url, raw: p });
const nashRow = (p) => ({ market: "tn", marketLabel: "Nashville, TN", owner: p.owner, address: p.address, use: p.use, value: p.appraised_value ? fmtAmount(p.appraised_value) : (p.assessed_value ? fmtAmount(p.assessed_value) : ""), absentee: p.absentee, mailing: p.mailing, mapsUrl: p.maps_url, raw: p });
// Charleston County publishes no assessed value — the value column is the LAST SALE price.
const scRow = (p) => ({ market: "sc", marketLabel: `${p.town || "Charleston"}, SC`, owner: p.owner, address: p.address, use: p.use, value: p.sale_price ? `${fmtAmount(p.sale_price)}${p.sale_year ? ` (${p.sale_year} sale)` : " (sale)"}` : "", absentee: p.absentee, mailing: p.mailing, mapsUrl: p.maps_url, raw: p });
// Savannah / Chatham County (GA) — fair-market value is published, so that's the value column.
const savRow = (p) => ({ market: "savannah", marketLabel: `${p.city || "Savannah"}, GA`, owner: p.owner, address: p.address, use: p.use, value: p.market_value ? fmtAmount(p.market_value) : "", absentee: p.absentee, mailing: p.mailing, mapsUrl: p.maps_url, raw: p });

function AssessorDetail({ p, market }) {
  const ny = market === "ny", tn = market === "tn", sc = market === "sc", sav = market === "savannah";
  const grid = sav
    ? [["Owner", p.owner], ["Co-owner", p.co_owner], ["Mailing", p.mailing], ["City", p.city], ["Use class", p.use], ["Fair-market value", p.market_value ? fmtAmount(p.market_value) : null], ["Land value", p.land_value ? fmtAmount(p.land_value) : null], ["Building value", p.improvement_value ? fmtAmount(p.improvement_value) : null], ["Acres", p.acres || null], ["Year built", p.year_built || null], ["Frontage", p.frontage_ft ? `${p.frontage_ft} ft` : null], ["Last sale", p.sale_price ? `${fmtAmount(p.sale_price)}${p.sale_year ? ` · ${p.sale_year}` : ""}` : null], ["Years owned", p.years_owned != null ? `~${p.years_owned}` : null], ["PIN", p.pin || null]]
    : sc
    ? [["Owner", p.owner], ["Co-owner", p.co_owner], ["Mailing", p.mailing], ["Town", p.town], ["Use", p.use], ["Acres", p.acres || null], ["Subdivision", p.subdivision || null], ["Tax district", p.tax_district || null], ["Last sale", p.sale_price ? `${fmtAmount(p.sale_price)}${p.sale_year ? ` · ${p.sale_year}` : ""}` : null], ["Years owned", p.years_owned != null ? `~${p.years_owned}` : null], ["Deed book/page", p.deed_book_page || null], ["Permits (city, since 2010)", p.permit_count || null], ["Latest permit", p.latest_permit_year || null], ["Permit valuation", p.permit_valuation ? fmtAmount(p.permit_valuation) : null], ["Permit types", (p.permit_types || []).join(", ") || null], ["PID", p.pid || null]]
    : tn
    ? [["Owner", p.owner], ["Mailing", p.mailing], ["Use", p.use], ["Zone", p.zone], ["Appraised", p.appraised_value ? fmtAmount(p.appraised_value) : null], ["Land value", p.land_value ? fmtAmount(p.land_value) : null], ["Building value", p.improvement_value ? fmtAmount(p.improvement_value) : null], ["Assessed", p.assessed_value ? fmtAmount(p.assessed_value) : null], ["Building SF", p.building_sqft ? Number(p.building_sqft).toLocaleString() : null], ["Retail SF", p.retail_sqft ? Number(p.retail_sqft).toLocaleString() : null], ["Year built", p.year_built || null], ["Structures", (p.structure_types || []).join(", ") || null], ["Frontage", p.frontage_ft ? `${p.frontage_ft} ft` : null], ["Depth", p.depth_ft ? `${p.depth_ft} ft` : null], ["Land acres", p.acres || null], ["Council dist.", p.council_district || null], ["Last sale", p.sale_price ? `${fmtAmount(p.sale_price)}${p.sale_year ? ` · ${p.sale_year}` : ""}` : null], ["Years owned", p.years_owned != null ? `~${p.years_owned}` : null], ["APN", p.apn || null]]
    : ny
    ? [["Owner", p.owner], ["Co-owner", p.co_owner], ["Mailing", p.mailing], ["Town", p.town], ["County", p.county], ["Use", p.use], ["Class", p.property_class], ["Assessed", p.assessed_value ? fmtAmount(p.assessed_value) : null], ["Market value", p.market_value ? fmtAmount(p.market_value) : null], ["Frontage", p.frontage_ft ? `${p.frontage_ft} ft` : null], ["School district", p.school_district]]
    : [["Owner", p.owner], ["Co-owner", p.co_owner], ["Mailing", p.mailing], ["Use", p.use], ["Zone", p.zone], ["Assessed", p.assessed_value ? fmtAmount(p.assessed_value) : null], ["Building SF", p.building_sqft ? Number(p.building_sqft).toLocaleString() : null], ["Frontage", p.frontage_ft ? `${p.frontage_ft} ft` : null], ["Year built", p.year_built || null], ["Condition", p.condition], ["Grade", p.grade], ["Last sale", p.sale_price ? `${fmtAmount(p.sale_price)}${p.sale_date ? ` · ${p.sale_date}` : ""}` : null]];
  return (
    <div>
      <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "10px 0 8px" }}>{sav ? "GA · CHATHAM COUNTY (SAVANNAH)" : sc ? "SC · CHARLESTON COUNTY" : tn ? "TN · NASHVILLE" : ny ? "NY" : "CT"} ASSESSOR RECORD</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: "6px 18px", fontSize: 12.5 }}>
        {grid.filter(([, v]) => v != null && v !== "" && v !== 0).map(([k, v]) => (<div key={k}><span style={{ color: C.muted }}>{k}: </span><span style={{ color: C.ivory }}>{v}</span></div>))}
      </div>
      {!ny && /greenwich/i.test(p.town || "") && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <a href="https://greenwich.ct.publicsearch.us/" target="_blank" rel="noreferrer" style={{ color: C.gold }}>Greenwich Land Records ↗</a>
          <span style={{ color: C.muted }}> — official deeds / mortgages / liens portal{p.owner ? `. Search "${p.owner}" or the address.` : "."}</span>
        </div>
      )}
    </div>
  );
}

// Nashville consolidated intel, shown right in the dossier (the TN analog of NYC's PropertyDetail
// city-records sections). Auto-loads on expand from /api/nashvilleintel — free public ArcGIS, no cost.
function NashvilleIntelPanel({ apn, address, pw }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [d, setD] = useState(null);
  useEffect(() => {
    if (!apn && !address) { setState("idle"); return; }
    let alive = true; setState("loading");
    postJSON("/api/nashvilleintel", { password: pw, apn, address })
      .then((res) => { if (alive) { setD(res); setState("done"); } })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, [apn, address, pw]);
  const H = ({ children }) => <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "14px 0 6px" }}>{children}</div>;
  const muted = { color: C.muted }, ivory = { color: C.ivory };
  if (state === "loading") return <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>Loading Nashville city records…</div>;
  if (state === "error") return <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>Nashville city records unavailable right now.</div>;
  if (state !== "done" || !d) return null;
  const bp = d.building_permits || {}, tp = d.trade_permits || {}, bz = d.beer_permits || {}, sr = d.service_requests_311 || {};
  const pa = d.pending_applications || {}, zo = d.zoning_overlays || {}, fl = d.flood, po = d.policy, bld = d.building, bid = d.business_improvement_district;
  const cv = d.code_violations || {}, rz = d.rezonings || {};
  const tif = d.tif || {}, redev = d.redevelopment_district, ped = d.pedestrian_zone, hist = d.historic_property;
  const crime = d.crime, walk = d.walkability, food = d.food_stores, hood = d.neighborhood, traffic = d.traffic;
  const transit = d.transit, bza = d.bza, dtc = d.downtown_code, adult = d.adult_businesses;
  const hasDev = (bp.count || 0) + (tp.count || 0) + (pa.count || 0) + (rz.count || 0) > 0;
  const overlays = (zo.districts || []).map((o) => o.type || o.name).filter(Boolean);
  return (
    <div style={{ marginTop: 6 }}>
      <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "12px 0 2px" }}>NASHVILLE CITY RECORDS</div>
      {(bld || bid) && <>
        <H>BUILDING{bid ? " · DISTRICT" : ""}</H>
        {bld && <div style={{ fontSize: 12.5, ...ivory }}><span style={muted}>Size (est): </span>~{bld.est_gross_sqft ? Number(bld.est_gross_sqft).toLocaleString() : "?"} SF{bld.footprint_sqft ? ` · ${Number(bld.footprint_sqft).toLocaleString()} SF footprint` : ""}{bld.est_stories ? ` × ~${bld.est_stories} floors` : ""}{bld.height_ft ? ` · ${bld.height_ft} ft tall` : ""}</div>}
        {bld && <div style={{ fontSize: 11, ...muted }}>Footprint-derived estimate — Metro publishes no assessor building SF.</div>}
        {bid && <div style={{ fontSize: 12.5, marginTop: 2 }}><span style={muted}>District: </span><span style={ivory}>{bid}</span></div>}
      </>}
      {hasDev && <>
        <H>DEVELOPMENT ACTIVITY</H>
        {bp.count > 0 && <div style={{ fontSize: 12.5, ...ivory }}>{bp.count} building permit{bp.count === 1 ? "" : "s"}{bp.signals && bp.signals.length ? <span style={muted}> · {bp.signals.join(", ").replace(/_/g, " ")}</span> : ""}</div>}
        {(bp.recent || []).slice(0, 3).map((p, i) => (<div key={i} style={{ fontSize: 11.5, ...muted, marginLeft: 8 }}>• {p.type}{p.cost ? ` · $${Number(p.cost).toLocaleString()}` : ""}{p.issued ? ` · ${p.issued}` : ""}</div>))}
        {pa.count > 0 && <div style={{ fontSize: 12.5, ...ivory, marginTop: 3 }}>{pa.count} pending application{pa.count === 1 ? "" : "s"} <span style={muted}>(forward-looking)</span></div>}
        {tp.count > 0 && <div style={{ fontSize: 12.5, ...ivory, marginTop: 3 }}>{tp.count} trade permit{tp.count === 1 ? "" : "s"} <span style={muted}>(electrical/plumbing/mechanical = live renovation)</span></div>}
        {rz.count > 0 && <div style={{ marginTop: 4 }}>
          {(rz.recent || []).slice(0, 3).map((z, i) => (<div key={i} style={{ fontSize: 12 }}><span style={ivory}>{z.type}</span>{z.from_zone && z.to_zone ? <span style={muted}> · {z.from_zone} → {z.to_zone}</span> : ""}{z.status ? <span style={muted}> · {z.status}</span> : ""}{z.filed ? <span style={muted}> · {z.filed}</span> : ""}</div>))}
          <div style={{ fontSize: 11, ...muted }}>Planning case{rz.count === 1 ? "" : "s"} touching this parcel (rezoning / SP / PUD = active repositioning).</div>
        </div>}
      </>}
      {(bz.count || 0) > 0 && <>
        <H>F&amp;B · BEER PERMITS</H>
        {(bz.recent || []).slice(0, 4).map((b, i) => (<div key={i} style={{ fontSize: 12 }}><span style={ivory}>{b.business || b.owner}</span>{b.status ? <span style={muted}> · {b.status}</span> : ""}{b.issued ? <span style={muted}> · {b.issued}</span> : ""}</div>))}
        <div style={{ fontSize: 11, ...muted, marginTop: 2 }}>{bz.active > 0 ? `${bz.active} active — an operating F&B tenant (a contact lead).` : "No active permit — possible F&B vacancy."}</div>
      </>}
      {(cv.count || 0) > 0 && <>
        <H>DISTRESS · CODE VIOLATIONS</H>
        {(cv.recent || []).slice(0, 4).map((v, i) => (<div key={i} style={{ fontSize: 12 }}><span style={{ color: /closed|resolved|complete/i.test(v.status || "") ? C.muted : C.red }}>{v.problem}</span>{v.status ? <span style={muted}> · {v.status}</span> : ""}{v.received ? <span style={muted}> · {v.received}</span> : ""}</div>))}
        <div style={{ fontSize: 11, ...muted, marginTop: 2 }}>{cv.open} open of {cv.count} Property-Standards violation{cv.count === 1 ? "" : "s"} — the parcel-exact distress this property's grade uses.</div>
      </>}
      {(sr.codes_related || 0) > 0 && <>
        <H>DISTRESS · 311 CODES COMPLAINTS</H>
        {(sr.recent_codes || []).slice(0, 4).map((c, i) => (<div key={i} style={{ fontSize: 12 }}><span style={{ color: C.amber }}>{c.type}</span>{c.subtype ? <span style={muted}> · {c.subtype}</span> : ""}{c.status ? <span style={muted}> · {c.status}</span> : ""}</div>))}
        <div style={{ fontSize: 11, ...muted, marginTop: 2 }}>{sr.codes_related} codes/condition complaint{sr.codes_related === 1 ? "" : "s"} of {sr.total} total 311 requests.</div>
      </>}
      {(overlays.length || fl || (po && (po.policy || po.transect)) || (dtc && (dtc.subdistrict || dtc.use_area)) || bza) && <>
        <H>ZONING / CONTEXT</H>
        {overlays.length > 0 && <div style={{ fontSize: 12.5 }}><span style={muted}>Overlays: </span><span style={ivory}>{overlays.join(", ")}</span>{zo.historic ? <span style={{ color: C.amber }}> · HISTORIC (constraint)</span> : ""}</div>}
        {dtc && (dtc.subdistrict || dtc.use_area) && <div style={{ fontSize: 12.5 }}><span style={muted}>Downtown Code: </span><span style={ivory}>{[dtc.subdistrict, dtc.use_area].filter(Boolean).join(" · ")}</span></div>}
        {bza && <div style={{ fontSize: 12.5 }}><span style={muted}>Zoning appeals (BZA): </span><span style={ivory}>{bza.count} case{bza.count === 1 ? "" : "s"}</span>{bza.recent && bza.recent[0] ? <span style={muted}> · {[bza.recent[0].type, bza.recent[0].action, bza.recent[0].date].filter(Boolean).join(" · ")}</span> : ""}</div>}
        {fl && <div style={{ fontSize: 12.5 }}><span style={muted}>Flood: </span><span style={fl.special_flood_hazard ? { color: C.red } : ivory}>Zone {fl.zone || "?"}{fl.special_flood_hazard ? " — SFHA (insurance / diligence cost)" : ` — ${fl.description || "minimal risk"}`}</span></div>}
        {po && (po.policy || po.transect) && <div style={{ fontSize: 12.5 }}><span style={muted}>Land-use policy: </span><span style={ivory}>{[po.policy, po.transect].filter(Boolean).join(" · ")}</span></div>}
      </>}
      {((tif.count || 0) > 0 || redev || ped || hist) && <>
        <H>INCENTIVES / DISTRICTS</H>
        {(tif.count || 0) > 0 && <div style={{ fontSize: 12.5 }}><span style={{ color: C.green }}>TIF: </span><span style={ivory}>{(tif.projects || []).map((t) => `${t.name || "project"}${t.amount ? ` ($${Number(t.amount).toLocaleString()})` : ""}${t.year ? ` ${t.year}` : ""}${t.paid_off ? " · paid off" : ""}`).join("; ")}</span><span style={muted}> — tax-increment financing (redevelopment incentive)</span></div>}
        {redev && <div style={{ fontSize: 12.5 }}><span style={muted}>Redevelopment district: </span><span style={{ color: C.gold }}>{redev}</span><span style={muted}> (MDHA urban renewal — design review + incentives)</span></div>}
        {ped && <div style={{ fontSize: 12.5 }}><span style={muted}>Pedestrian benefit zone: </span><span style={ivory}>{ped.zone}{ped.description ? ` · ${ped.description}` : ""}</span><span style={muted}> — walkable, reduced parking minimums</span></div>}
        {hist && <div style={{ fontSize: 12.5 }}><span style={{ color: C.amber }}>Historic: </span><span style={ivory}>{[hist.status, hist.year_built ? `built ${hist.year_built}` : "", hist.survey].filter(Boolean).join(" · ")}</span><span style={muted}> — landmark/district design-review constraint</span></div>}
      </>}
      {(crime || walk || hood || traffic || transit || adult) && <>
        <H>LOCATION / SAFETY</H>
        {hood && <div style={{ fontSize: 12.5 }}><span style={muted}>Neighborhood: </span><span style={ivory}>{hood}</span></div>}
        {traffic && <div style={{ fontSize: 12.5 }}><span style={muted}>Traffic (TDOT): </span><span style={ivory}>~{Number(traffic.nearest.aadt).toLocaleString()} vehicles/day</span><span style={muted}>{traffic.nearest.location ? ` · ${traffic.nearest.location}` : ""}{traffic.nearest.dist_mi != null ? ` · ${traffic.nearest.dist_mi} mi` : ""} · AADT {traffic.nearest.year} (latest published count)</span></div>}
        {transit && <div style={{ fontSize: 12.5 }}><span style={muted}>Transit: </span><span style={ivory}>WeGo “{transit.nearest.name}”{transit.nearest.dist_mi != null ? ` ${transit.nearest.dist_mi} mi` : ""}</span><span style={muted}> · {transit.stops_nearby} stop{transit.stops_nearby === 1 ? "" : "s"} nearby{transit.routes && transit.routes.length ? ` · routes ${transit.routes.join(", ")}` : ""}</span></div>}
        {walk && <div style={{ fontSize: 12.5 }}><span style={muted}>Walkability: </span><span style={ivory}>BCycle “{walk.nearest_bcycle.name}”{walk.nearest_bcycle.dist_mi != null ? ` ${walk.nearest_bcycle.dist_mi} mi` : ""}</span><span style={muted}> · {walk.bcycle_within_075mi} station{walk.bcycle_within_075mi === 1 ? "" : "s"} within ¾ mi</span></div>}
        {crime && <div style={{ fontSize: 12.5 }}><span style={muted}>Crime (~¼ mi, 24 mo): </span><span style={crime.violent > 0 ? { color: C.amber } : ivory}>{crime.count}{crime.capped ? "+" : ""} incident{crime.count === 1 ? "" : "s"}{crime.violent ? ` · ${crime.violent} violent` : ""}</span>{crime.top_offenses && crime.top_offenses.length ? <span style={muted}> · {crime.top_offenses.slice(0, 3).map((o) => `${o.offense.toLowerCase()} (${o.count})`).join(", ")}</span> : ""}</div>}
        {crime && <div style={{ fontSize: 10.5, ...muted }}>MNPD incidents, masked to ~block — context, not a precise rate.</div>}
        {adult && <div style={{ fontSize: 12 }}><span style={{ color: C.amber }}>⚠ {adult.count} adult-oriented business{adult.count === 1 ? "" : "es"} within ¼ mi</span>{adult.nearest && adult.nearest.dist_mi != null ? <span style={muted}> · nearest {adult.nearest.dist_mi} mi</span> : ""}</div>}
      </>}
      {food && <>
        <H>RETAIL CONTEXT · NEARBY STORES</H>
        <div style={{ fontSize: 12.5, ...ivory }}>{food.operating} operating of {food.count} food/grocery store{food.count === 1 ? "" : "s"} within ~⅓ mi</div>
        {(food.nearest || []).slice(0, 4).map((s, i) => (<div key={i} style={{ fontSize: 11.5, ...muted, marginLeft: 8 }}>• {s.name}{s.type ? ` · ${s.type}` : ""}{s.dist_mi != null ? ` · ${s.dist_mi} mi` : ""}{s.operating ? "" : " · CLOSED"}</div>))}
      </>}
    </div>
  );
}

// Charleston consolidated intel, shown right in the dossier (the SC analog of NashvilleIntelPanel).
// Auto-loads on expand from /api/charlestonintel — free public ArcGIS layers, no cost.
function CharlestonIntelPanel({ pid, address, pw }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [d, setD] = useState(null);
  useEffect(() => {
    if (!pid && !address) { setState("idle"); return; }
    let alive = true; setState("loading");
    postJSON("/api/charlestonintel", { password: pw, pid, address })
      .then((res) => { if (alive) { setD(res); setState(res && res.error ? "error" : "done"); } })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, [pid, address, pw]);
  const H = ({ children }) => <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "14px 0 6px" }}>{children}</div>;
  const muted = { color: C.muted }, ivory = { color: C.ivory };
  if (state === "loading") return <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>Loading Charleston city records…</div>;
  if (state === "error") return <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>Charleston city records unavailable right now.</div>;
  if (state !== "done" || !d) return null;
  const z = d.zoning || {}, fl = d.flood || {}, cr = d.crime_300m || {}, pm = d.permits || {}, hot = d.hotel_entitlement;
  const val = d.valuation || {}, bld = d.buildings || {}, code = d.code_enforcement || {};
  const zoneBits = [z.city_base_zone && `city ${z.city_base_zone}`, z.city_pud && `PUD ${z.city_pud}`, !z.city_base_zone && z.county_zone && z.county_zone !== "MUNI" && `county ${z.county_zone}${z.county_zone_desc ? ` (${z.county_zone_desc})` : ""}`].filter(Boolean);
  const fmt$ = (n) => n != null ? `$${Number(n).toLocaleString()}` : null;
  return (
    <div style={{ marginTop: 6 }}>
      <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.15em", margin: "12px 0 2px" }}>CHARLESTON CITY RECORDS</div>
      {(val.total_appraised || bld.count) && <>
        <H>VALUATION / BUILDING</H>
        {val.total_appraised && <div style={{ fontSize: 12.5 }}><span style={muted}>Appraised value: </span><span style={ivory}>{fmt$(val.total_appraised)}</span>{(val.land_appraised || val.improvement_appraised) ? <span style={muted}> · land {fmt$(val.land_appraised)} + improvement {fmt$(val.improvement_appraised)}</span> : ""}</div>}
        {bld.count > 0 && <div style={{ fontSize: 12.5 }}><span style={muted}>Buildings: </span><span style={ivory}>{bld.count} footprint{bld.count === 1 ? "" : "s"}{bld.total_sqft ? ` · ${bld.total_sqft.toLocaleString()} sq ft` : ""}</span>{bld.note ? <span style={muted}> · {bld.note}</span> : ""}</div>}
      </>}
      {code.count > 0 && <>
        <H>CODE ENFORCEMENT · VIOLATIONS</H>
        <div style={{ fontSize: 12.5 }}><span style={{ color: C.amber }}>{code.count} code case{code.count === 1 ? "" : "s"}</span><span style={muted}> on the parcel{code.recent_year ? ` · most recent ${code.recent_year}` : ""}</span></div>
        {(code.rows || []).slice(0, 4).map((c, i) => (<div key={i} style={{ fontSize: 11.5, ...muted, marginLeft: 8 }}>• {[c.case, c.type, c.year].filter(Boolean).join(" · ")}</div>))}
        <div style={{ fontSize: 10.5, ...muted }}>County EnerGov code-enforcement cases at the parcel — a distress / deferred-maintenance signal.</div>
      </>}
      {(zoneBits.length > 0 || z.old_and_historic_district || z.old_city_height_district || z.short_term_rental_overlay || z.accommodations_overlay) && <>
        <H>ZONING / OVERLAYS</H>
        {zoneBits.length > 0 && <div style={{ fontSize: 12.5 }}><span style={muted}>Zoning: </span><span style={ivory}>{zoneBits.join(" · ")}</span></div>}
        {z.old_and_historic_district && <div style={{ fontSize: 12.5 }}><span style={{ color: C.amber }}>Historic: </span><span style={ivory}>{z.old_and_historic_district}</span><span style={muted}> — BAR design review on exterior work</span></div>}
        {z.old_city_height_district && <div style={{ fontSize: 12.5 }}><span style={muted}>Height district: </span><span style={ivory}>{z.old_city_height_district}</span><span style={muted}> — Old City height cap</span></div>}
        {z.short_term_rental_overlay && <div style={{ fontSize: 12.5 }}><span style={muted}>Short-term rentals: </span><span style={ivory}>{z.short_term_rental_overlay}</span><span style={muted}> overlay</span></div>}
        {z.accommodations_overlay && <div style={{ fontSize: 12.5 }}><span style={muted}>Accommodations: </span><span style={ivory}>{z.accommodations_overlay}</span><span style={muted}> — hotel-use overlay (hospitality entitlement fight)</span></div>}
      </>}
      {hot && <>
        <H>HOTEL ENTITLEMENT</H>
        <div style={{ fontSize: 12.5 }}><span style={ivory}>{hot.name || "Hotel"}</span><span style={muted}>{hot.rooms ? ` · ${hot.rooms} rooms` : ""}{hot.status ? ` · ${hot.status}` : ""}{hot.open_date ? ` · opened ${String(hot.open_date).slice(0, 4)}` : ""}</span></div>
      </>}
      {(pm.count || 0) > 0 && <>
        <H>DEVELOPMENT ACTIVITY · CITY PERMITS</H>
        <div style={{ fontSize: 12.5, ...ivory }}>{pm.count} construction permit{pm.count === 1 ? "" : "s"} since 2010{pm.total_valuation ? <span style={muted}> · ~${Number(pm.total_valuation).toLocaleString()} total</span> : ""}</div>
        {(pm.rows || []).slice(0, 4).map((p, i) => (<div key={i} style={{ fontSize: 11.5, ...muted, marginLeft: 8 }}>• {[p.work || p.type, p.year, p.valuation ? `$${Number(p.valuation).toLocaleString()}` : "", p.status].filter(Boolean).join(" · ")}</div>))}
      </>}
      <H>FLOOD (THE CHARLESTON QUESTION)</H>
      <div style={{ fontSize: 12.5 }}><span style={muted}>FEMA: </span><span style={fl.special_flood_hazard_area ? { color: C.red } : ivory}>Zone {fl.fema_zone || "?"}{fl.special_flood_hazard_area ? " — SFHA (flood insurance / diligence cost)" : " — outside the special flood hazard area"}</span>{fl.static_bfe_ft ? <span style={muted}> · BFE {fl.static_bfe_ft} ft</span> : ""}</div>
      <div style={{ fontSize: 12.5 }}><span style={muted}>Street flooding nearby: </span><span style={fl.street_flood_events_400m > 0 ? { color: C.amber } : ivory}>{fl.street_flood_events_400m || 0} flooded-vehicle event{fl.street_flood_events_400m === 1 ? "" : "s"} within ¼ mi</span>{(fl.recent_flood_dates || []).length ? <span style={muted}> · {fl.recent_flood_dates.slice(-3).join(", ")}</span> : ""}</div>
      <div style={{ fontSize: 10.5, ...muted }}>City flooded-vehicle log — chronic street flooding FEMA maps can miss.</div>
      {cr.count != null && <>
        <H>SAFETY · CRIME (~300 M, LAST 3 YRS)</H>
        <div style={{ fontSize: 12.5, ...ivory }}>{cr.count}{cr.count >= 1000 ? "+" : ""} reported incident{cr.count === 1 ? "" : "s"}{(cr.by_category || []).length ? <span style={muted}> · {(cr.by_category || []).slice(0, 3).map((c) => `${c.category.toLowerCase()} (${c.count})`).join(", ")}</span> : ""}</div>
        <div style={{ fontSize: 10.5, ...muted }}>City of Charleston PD reported incidents — context, not a precise rate; downtown corridors run high.</div>
      </>}
    </div>
  );
}

// Machine-readable footer appended to every unmask/people query so the UI can turn the
// found people into one-click skip-trace chips (parseTraceList strips it from the shown
// brief). The whole chain — LLC → principal → phone — then needs no retyping.
const TRACE_FOOTER = `

FINALLY — after the brief — append a machine-readable footer EXACTLY like this (plain text on its own lines, no markdown table):
TRACE LIST
Full Name | street address if found | city | 2-letter state | zip
One line per REAL PERSON you actually found and named above (skip corporate registered-agent services like CT Corporation / Registered Agents Inc / Northwest). Leave unknown fields empty but keep all four pipes. Omit the footer entirely if you found no real people. Never invent a name or address.`;

// Scout's sc_entity_lookup tool query (TOOL_ROUTES). SC's registry pages aren't crawlable
// (JS-rendered + captcha), so a registry-only query usually whiffs on small LLCs — this
// works the wider web too (sale coverage / deed aggregators / local CRE press / LinkedIn
// usually name the principal behind a Charleston LLC). The dossier's own unmask lives in
// OwnerPeople (which merges the LLC-unmask with the relatives/associates lookup).
const SC_ENTITY_QUERY = (name) => `You are looking up the South Carolina business entity "${name}" (a South Carolina / Charleston-area property owner) to find its REGISTERED AGENT and the people behind it. South Carolina's official registry (businessfilings.sc.gov) is captcha-gated and usually NOT reachable by search — but its filings are mirrored on crawlable third-party business-record sites that DO surface in search results (often the agent + address appear right in the result snippet even when the page itself is gated). Work those hard before concluding anything is unavailable, and do NOT give up just because the SOS site can't be opened.

Run several TARGETED searches (don't narrate them). Search the EXACT entity name together with "South Carolina" and "registered agent", and mine these mirrors of the SOS filing for the agent name + address, principal/office address, entity type, status, and filing/registration date:
- Bizapedia (bizapedia.com/sc/…), OpenCorporates (opencorporates.com/companies/us_sc/…), OpenGovUS, CorporationWiki, Buzzfile, Bisprofiles, Dun & Bradstreet.
Then, to put a real decision-maker behind a single-asset LLC, also check property/deed aggregators, Charleston CRE press (Post and Courier, Charleston Regional Business Journal, trade press), and LinkedIn — sale/development coverage frequently names the principal or firm.

Report, leading with what matters most:
1. REGISTERED AGENT — name + full address (the key contact for an anonymous LLC), with its source.
2. PRINCIPALS / manager / organizer — named people + their firm and where they're based (so they can be skip-traced).
3. Entity status, type, and filing date, if found.
4. The best way to reach the decision-maker.
Cite each source inline and clearly separate CONFIRMED record facts from inference. NEVER invent an agent, name, address, or contact. Report whatever you DID find rather than giving up — a partial answer (just the agent, or just an aggregator listing) is still valuable. Only if genuinely nothing is on the crawlable web, say so plainly and note the record can be pulled by hand at businessfilings.sc.gov.${TRACE_FOOTER}`;

// LLC tracker — every county parcel held by the same owner name (Nashville / Davidson Co.
// and Charleston Co. both support owner-name search). Maps an entity to its whole book
// (find a motivated owner's other buildings). Single-asset LLCs return one; a reused name
// (a developer / operating co) returns the portfolio.
const PORTFOLIO_MARKETS = {
  tn: { market: "nashville", place: "Nashville", county: "Davidson County", value: (p) => p.appraised_value || p.assessed_value },
  sc: { market: "charleston", place: "Charleston", county: "Charleston County", value: (p) => p.sale_price },
  savannah: { market: "savannah", place: "Savannah", county: "Chatham County", value: (p) => p.market_value },
};
function OwnerPortfolio({ owner, pw, st }) {
  const cfg = PORTFOLIO_MARKETS[st];
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [props, setProps] = useState([]);
  const [err, setErr] = useState("");
  const run = async () => {
    setState("loading"); setErr("");
    try {
      const d = await postJSON("/api/search", { password: pw, market: cfg.market, owner, propertyType: "any" });
      setProps(d.properties || []); setState("done");
    } catch (e) { setErr(e.message || "Lookup failed."); setState("error"); }
  };
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>▦ OWNER PORTFOLIO — what this owner holds in {cfg.place}</div>
        {state !== "loading" && <button onClick={run} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>{state === "done" || state === "error" ? "↻" : "▸ show"}</button>}
      </div>
      {state === "idle" && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 6 }}>Every {cfg.county} parcel held by <strong style={{ color: C.ivory }}>{owner}</strong>. A single-asset LLC returns one; a reused name (a developer / operating co) returns the whole book.</div>}
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>Searching the county roll…</div>}
      {state === "error" && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {state === "done" && (props.length ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>{props.length} propert{props.length === 1 ? "y" : "ies"} under this owner</div>
          {props.slice(0, 40).map((p, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "3px 0", borderBottom: `1px solid ${C.line}` }}>
              <span style={{ color: C.ivory }}>{p.address}{p.use ? <span style={{ color: C.muted }}> · {p.use}</span> : ""}</span>
              <span className="mono" style={{ color: C.muted, whiteSpace: "nowrap" }}>{cfg.value(p) ? fmtAmount(cfg.value(p)) : ""}</span>
            </div>
          ))}
          {props.length > 40 && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>+{props.length - 40} more</div>}
        </div>
      ) : <div style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>No other parcels found under this exact owner name.</div>)}
    </div>
  );
}

const ENTITY_RE = /\b(LLC|INC|CORP|LP|LLP|TRUST|COMPANY|CO|ASSOCIATES|PARTNERS|HOLDINGS|REALTY|PROPERTIES|GROUP|ENTERPRISES|VENTURES)\b/i;
// CT publicly discloses LLC PRINCIPALS (unlike most states), free + structured via the state
// Business Registry. For a Greenwich/CT entity owner this is the BEST "who's behind the LLC"
// source — real member names, not a skip-trace guess or a web inference. Server-side token
// matching resolves the assessor's owner spelling ("COHEN M H REALTY LLC") to the registry's
// ("M.H. COHEN REALTY, L.L.C"). Free, no metering.
function CtEntityFinder({ owner, pw }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [ents, setEnts] = useState([]);
  const [err, setErr] = useState("");
  const run = async () => {
    setState("loading"); setErr("");
    try {
      const d = await postJSON("/api/ctentity", { password: pw, name: owner });
      setEnts(d.entities || []); setState("done");
    } catch (e) { setErr(e.message || "Lookup failed."); setState("error"); }
  };
  const shown = ents.slice(0, 4);
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>🔎 CT REGISTRY — real principals behind the LLC</div>
        {state !== "loading" && <button onClick={run} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>{state === "done" || state === "error" ? "↻" : "▸ find principals"}</button>}
      </div>
      {state === "idle" && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 6 }}>Connecticut publicly lists LLC principals — a FREE, structured lookup of the real people behind <strong style={{ color: C.ivory }}>{owner}</strong> (name-matched, so punctuation / word-order differences still resolve). More reliable than skip-tracing the LLC.</div>}
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>Searching the CT Business Registry…</div>}
      {state === "error" && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {state === "done" && (shown.length ? (
        <div style={{ marginTop: 10 }}>
          {shown.map((e, i) => (
            <div key={i} style={{ marginBottom: 9, paddingBottom: 9, borderBottom: i < shown.length - 1 ? `1px solid ${C.line}` : "none" }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ivory }}>{e.name}<span className="mono" style={{ fontSize: 9, color: e.status === "Active" ? C.green : C.muted, marginLeft: 6, border: `1px solid ${e.status === "Active" ? C.green : C.line}`, borderRadius: 4, padding: "0 5px" }}>{(e.status || "—").toUpperCase()}</span></div>
              {e.principals && e.principals.length ? e.principals.map((p, j) => (
                <div key={j} style={{ fontSize: 12.5, marginTop: 3 }}>👤 <span style={{ color: C.ivory, fontWeight: 600 }}>{p.name}</span>{(p.residence_location || p.business_location) ? <span style={{ color: C.muted }}> · {p.residence_location || p.business_location}</span> : ""}</div>
              )) : <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>No individual principals listed (registered agent only{e.agent ? `: ${e.agent.name}` : ""}).</div>}
              {e.agent && e.principals && e.principals.length > 0 && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Agent: {e.agent.name}{e.agent.address ? ` · ${e.agent.address}` : ""}</div>}
            </div>
          ))}
          {ents.length > shown.length && <div style={{ fontSize: 11, color: C.muted }}>+{ents.length - shown.length} more name matches</div>}
          <div style={{ fontSize: 10.5, color: C.muted, marginTop: 5, lineHeight: 1.5 }}>Several matches = the loose name search; the top one is the closest. Confirm the address lines up with the property owner before relying on it.</div>
        </div>
      ) : <div style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>No CT registry match for this name — try the 👥 unmask (web) below.</div>)}
    </div>
  );
}

// SC SOS registry — the LIVE state record behind a South Carolina LLC (the "real
// database" lane the AI unmask can't reach: SC captcha-gates businessfilings.sc.gov).
// /api/scentity runs it through Cobalt Intelligence when COBALT_API_KEY is set; with
// the lane off it says so and the 👥 AI unmask below stays the working path. Found
// officers / an individual agent render as one-click skip-trace chips (TracePeople).
function ScEntityFinder({ owner, pw }) {
  const [state, setState] = useState("idle"); // idle | loading | done | nokey | error
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");
  const run = async () => {
    setState("loading"); setErr("");
    try {
      const d = await postJSON("/api/scentity", { password: pw, name: owner });
      if (d.noKey) { setRes(d); setState("nokey"); return; }
      setRes(d); setState("done");
    } catch (e) { setErr(e.message || "Lookup failed."); setState("error"); }
  };
  const ents = (res?.entities || []).slice(0, 4);
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>🏛️ SC SOS REGISTRY — the live state record</div>
        {state !== "loading" && <button onClick={run} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>{state === "idle" ? "▸ pull record" : "↻"}</button>}
      </div>
      {state === "idle" && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 6 }}>Pulls the <strong style={{ color: C.ivory }}>actual SC Secretary of State filing</strong> for <strong style={{ color: C.ivory }}>{owner}</strong> — exact status, filing date, registered agent + address, officers — via the Cobalt Intelligence SOS API (SC's own site is captcha-gated). Structured record, not AI guesswork; pair with the 👥 unmask below for the humans.</div>}
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>Pulling the state record… (SC scrapes in real time — can take ~20s)</div>}
      {state === "error" && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {state === "nokey" && <div style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>Registry lane is <strong style={{ color: C.amber }}>off</strong> — no <span className="mono" style={{ color: C.ivory }}>COBALT_API_KEY</span> in the Vercel env. Sign up at <a href="https://cobaltintelligence.com" target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>cobaltintelligence.com ↗</a> (they have a trial), add the key, and this pulls the live SOS record. Until then the 👥 AI unmask below is the SC path.</div>}
      {state === "done" && (ents.length ? (
        <div style={{ marginTop: 10 }}>
          {ents.map((e, i) => (
            <div key={i} style={{ marginBottom: 9, paddingBottom: 9, borderBottom: i < ents.length - 1 ? `1px solid ${C.line}` : "none" }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ivory }}>{e.name}{e.status && <span className="mono" style={{ fontSize: 9, color: /good|active|exist/i.test(e.status) ? C.green : C.amber, marginLeft: 6, border: `1px solid ${/good|active|exist/i.test(e.status) ? C.green : C.line}`, borderRadius: 4, padding: "0 5px" }}>{e.status.toUpperCase()}</span>}</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{[e.entity_type, e.filing_date && `filed ${e.filing_date}`, e.sos_id && `#${e.sos_id}`].filter(Boolean).join(" · ")}</div>
              {e.registered_agent && <div style={{ fontSize: 12.5, marginTop: 3 }}>Agent: <span style={{ color: C.ivory, fontWeight: 600 }}>{e.registered_agent}</span>{e.agent_address ? <span style={{ color: C.muted }}> · {e.agent_address}</span> : ""}</div>}
              {e.principal_address && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>Principal address: {e.principal_address}</div>}
              {e.officers && e.officers.length > 0 && e.officers.map((o, j) => (
                <div key={j} style={{ fontSize: 12.5, marginTop: 3 }}>👤 <span style={{ color: C.ivory, fontWeight: 600 }}>{o.name}</span>{o.title ? <span style={{ color: C.muted }}> · {o.title}</span> : ""}</div>
              ))}
            </div>
          ))}
          <TracePeople people={res.people || []} pw={pw} fallback={{ city: "Charleston", state: "SC" }} />
          <div style={{ fontSize: 10.5, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>{res.note}</div>
        </div>
      ) : <div style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>{res?.note || "No SC registry match for this name — try the 👥 unmask (web) below."}</div>)}
    </div>
  );
}

// ── CORRIDORS PAGE ────────────────────────────────────────────────────────────
// The RetailAvailability engine (api/availability.js) as its OWN tab — previously
// only Scout could run it. Pick a configured corridor (King St Charleston / SoHo
// NYC), get every likely-available retail space ranked by buy-box fit + availability
// probability, each row expandable into the SAME free owner-contact chain as Sourcing
// (county mailing-address unmask, SC registry, AI unmask, trace chips).

const zipFromMailing = (m) => { const x = String(m || "").match(/(\d{5})(-\d{4})?\s*$/); return x ? x[1] : ""; };

// Map a corridor screen row → the assessor/lead row shape the detail chain expects.
function corridorToRow(row) {
  const saleYr = row.last_sale_date ? String(row.last_sale_date).slice(0, 4) : null;
  const valueStr = row.last_sale_price ? `${fmtAmount(row.last_sale_price)}${saleYr ? ` (${saleYr})` : ""}` : "";
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${row.address || ""}, ${row.city === "New York" ? "New York NY" : "Charleston SC"}`)}`;
  if (row.city === "New York") {
    return {
      market: "nyc", marketLabel: "NYC", owner: row.ownership_entity, address: row.address,
      use: row.tier, value: valueStr, mailing: row.owner_mailing, mapsUrl,
      raw: { ...row, lat: row.lat, lon: row.lon },
    };
  }
  return {
    market: "sc", marketLabel: "Charleston, SC", owner: row.ownership_entity, address: row.address,
    use: row.class_code || row.tier, value: valueStr, mailing: row.owner_mailing, mapsUrl,
    raw: {
      ...row, pid: row.pid, mailing: row.owner_mailing, mailing_zip: zipFromMailing(row.owner_mailing),
      mailing_city: "Charleston", mailing_state: "SC", town: row.town || "Charleston",
      lat: row.lat, lon: row.lon, sale_price: row.last_sale_price, sale_year: saleYr,
      use: row.class_code, acres: row.acres, deed_book_page: row.deed_book_page,
    },
  };
}

const TIER_COLOR = { flagship: "#e8c37e", luxury: "#c9a24a", boutique: "#8a7a52" };

// The availability read for one corridor candidate — the engine's numbers + reasons.
function AvailabilityHeader({ row }) {
  const pct = Math.round((row.availability_probability || 0) * 100);
  const col = pct >= 60 ? C.green : pct >= 35 ? C.amber : C.muted;
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "11px 14px", marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "baseline" }}>
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.04em", color: C.muted }}>FIT <span style={{ color: C.ivory, fontSize: 15 }}>{row.fit_score}</span>/100</div>
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.04em", color: C.muted }}>AVAILABILITY <span style={{ color: col, fontSize: 15 }}>{pct}%</span></div>
        <div className="mono" style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, background: C.panel, border: `1px solid ${C.line}`, color: TIER_COLOR[row.tier] || C.muted, textTransform: "uppercase" }}>{row.tier}</div>
        {row.hotel_entitlement && <div className="mono" style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, background: C.goldSoft, color: C.amber }}>HOTEL ENTITLEMENT</div>}
      </div>
      {(row.availability_reasons || []).length > 0 ? (
        <ul style={{ margin: "9px 0 0", paddingLeft: 18, color: C.ivory, fontSize: 12.5, lineHeight: 1.6 }}>
          {row.availability_reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      ) : <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>No active turnover signal — baseline availability. Ranked here for corridor fit; worth a direct owner approach.</div>}
      {row.principal && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Named principal (HPD): <strong style={{ color: C.ivory }}>{row.principal}</strong>{row.principal_role ? ` · ${row.principal_role}` : ""}</div>}
    </div>
  );
}

// One corridor candidate's expandable detail: the availability read, then the SAME
// free owner-contact chain the Sourcing tab uses (Charleston gets the county mailing
// unmask + SC registry; NYC gets the AI unmask + trace). No new paid calls.
function CorridorRowDetail({ row, pw }) {
  const r = corridorToRow(row);
  const isCo = ENTITY_RE.test(r.owner || "");
  const contactR = {
    name: r.owner || "", entity_type: isCo ? "company" : "person",
    contact_address: (r.mailing || "").split(",")[0].trim(),
    city: r.market === "nyc" ? "New York" : "Charleston", state: r.market === "nyc" ? "NY" : "SC",
    zip: r.raw.mailing_zip || zipFromMailing(r.mailing), address: r.address, borough: row.borough || "",
    last_sale_price: row.last_sale_price || null, last_sale_date: row.last_sale_date || null,
  };
  // The corridor's rich signals make the outreach draft specific (the vacant-lot flag,
  // the build-out permit, the tier) — pass them into the studio.
  const oExtra = {
    corridor_name: (row.corridor || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    tier: row.tier, availability_probability: row.availability_probability,
    availability_reasons: row.availability_reasons || [], principal: row.principal || "",
  };
  return (
    <div style={{ padding: "4px 14px 18px" }}>
      <AvailabilityHeader row={row} />
      {r.market === "sc"
        ? <AssessorMarketDetail r={r} pw={pw} outreachExtra={oExtra} />
        : <>
            <StorefrontPhoto r={r} pw={pw} />
            <AssessorDetail p={{ owner: r.owner, mailing: r.mailing, use: row.tier, frontage_ft: row.frontage_ft, sale_price: row.last_sale_price, sale_date: row.last_sale_date }} market="nyc-corridor" />
            <OutreachStudio ctx={outreachCtx(r, oExtra)} pw={pw} />
            <ResearchBrief r={contactR} pw={pw} />
            <ContactReveal r={contactR} pw={pw} />
            <OwnerPeople r={contactR} pw={pw} market="nyc" />
          </>}
    </div>
  );
}

function CorridorsPage({ pw }) {
  const [corridors, setCorridors] = useState(null);
  const [active, setActive] = useState(null); // corridor id
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null); // { corridor, rows, candidate_count, coverage }
  const [openIdx, setOpenIdx] = useState(null);

  useEffect(() => {
    let alive = true;
    postJSON("/api/availability", { password: pw, list: true })
      .then((d) => {
        if (!alive) return;
        const list = d.corridors || [];
        setCorridors(list);
        if (list.length) run(list[0].id); // auto-load the first corridor so results appear with no click
      })
      .catch((e) => { if (alive) setError(e.message || "Couldn't load corridors."); });
    return () => { alive = false; };
  }, []);

  const run = async (id) => {
    setActive(id); setLoading(true); setError(""); setData(null); setOpenIdx(null);
    try {
      const d = await postJSON("/api/availability", { password: pw, corridor: id });
      if (d.no_match) { setError(d.note || "No match."); return; }
      setData(d);
    } catch (e) { setError(e.message || "Screen failed."); }
    finally { setLoading(false); }
  };

  const uiRows = useMemo(() => (data?.rows || []).map(corridorToRow), [data]);
  const points = useSourcingPoints(uiRows);
  const pickPin = (id) => { setOpenIdx(id); const el = document.getElementById(`corr-row-${id}`); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); };
  const cov = data?.coverage;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      <div style={{ marginBottom: 6, fontSize: 22, fontWeight: 700, color: C.ivory, letterSpacing: "-0.01em" }}>Corridors</div>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 18, lineHeight: 1.55, maxWidth: 760 }}>
        Screen a whole retail corridor for likely-<strong style={{ color: C.ivory }}>available</strong> space — a deterministic pass over every retail lot in the corridor, ranked by buy-box fit and an availability probability with the reasons behind it. Expand any candidate for the full free owner-contact workup: mailing address, the county <strong style={{ color: C.ivory }}>same-address unmask</strong>, the SC registry, and one-click people lookups.
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        {corridors == null ? <div style={{ color: C.muted, fontSize: 13 }}>Loading corridors…</div>
          : corridors.length === 0 ? <div style={{ color: C.muted, fontSize: 13 }}>No corridors configured.</div>
          : corridors.map((c) => (
            <button key={c.id} onClick={() => run(c.id)} className="lift" style={{ cursor: "pointer", textAlign: "left", padding: "13px 16px", borderRadius: 12, border: `1px solid ${active === c.id ? C.gold : C.line}`, background: active === c.id ? C.goldSoft : C.panel, minWidth: 230 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: active === c.id ? C.gold : C.ivory }}>{c.name}</div>
              <div className="mono" style={{ fontSize: 10.5, color: C.muted, marginTop: 3 }}>{(c.market || "").toUpperCase()} · {c.segments} segment{c.segments === 1 ? "" : "s"} · {c.asset_class}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{(c.streets || []).slice(0, 4).join(" · ")}</div>
            </button>
          ))}
      </div>

      {error && <div style={{ fontSize: 12.5, color: C.red, background: `${C.red}10`, border: `1px solid ${C.red}40`, borderRadius: 8, padding: "10px 13px", marginBottom: 16 }}>{error}</div>}
      {loading && <div style={{ color: C.muted, fontSize: 13, padding: "20px 0" }}>Screening {corridors?.find((c) => c.id === active)?.name || "corridor"}… (a full corridor pass — a few seconds)</div>}

      {data && !loading && (
        <>
          {points.some((p) => p.lat != null) && (
            <div style={{ marginBottom: 16 }}>
              <PropertyMap points={points} center={points.find((p) => p.lat != null)} activeId={openIdx} onPick={pickPin} height={320} />
            </div>
          )}
          <div className="mono" style={{ fontSize: 11, color: C.muted, letterSpacing: "0.05em", marginBottom: 8 }}>
            {data.candidate_count} CANDIDATE{data.candidate_count === 1 ? "" : "S"} · {data.corridor?.name}
            {cov?.nulls ? <span> · owner known on {cov.nulls.of - (cov.nulls.ownership_entity || 0)}/{cov.nulls.of}</span> : ""}
          </div>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>
                {["Fit", "Avail", "Address", "Tier", "Owner", ""].map((h, i) => <th key={h} style={{ textAlign: i === 5 ? "right" : "left", padding: "9px 12px", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: C.muted }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {uiRows.map((r, i) => { const row = data.rows[i]; const pct = Math.round((row.availability_probability || 0) * 100); return (
                  <React.Fragment key={i}>
                    <tr id={`corr-row-${i}`} style={{ borderBottom: `1px solid ${C.line}`, background: openIdx === i ? C.goldSoft : "transparent" }}>
                      <td className="mono" style={{ padding: "9px 12px", fontSize: 13, color: C.ivory }}>{row.fit_score}</td>
                      <td className="mono" style={{ padding: "9px 12px", fontSize: 12.5, color: pct >= 60 ? C.green : pct >= 35 ? C.amber : C.muted }}>{pct}%</td>
                      <td style={{ padding: "9px 12px", fontSize: 12.5 }}><a href={r.mapsUrl} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{r.address || "—"} ↗</a></td>
                      <td style={{ padding: "9px 12px", fontSize: 11, color: TIER_COLOR[row.tier] || C.muted, textTransform: "capitalize" }}>{row.tier}</td>
                      <td style={{ padding: "9px 12px", fontSize: 12.5, color: C.ivory, maxWidth: 220 }}>{r.owner || "—"}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right" }}><button onClick={() => setOpenIdx(openIdx === i ? null : i)} className="mono lift" style={{ cursor: "pointer", fontSize: 11, padding: "4px 10px", borderRadius: 7, border: `1px solid ${openIdx === i ? C.gold : C.line}`, background: openIdx === i ? C.goldSoft : C.panel, color: openIdx === i ? C.gold : C.ivory, whiteSpace: "nowrap" }}>{openIdx === i ? "▾ hide" : "▸ work it"}</button></td>
                    </tr>
                    {openIdx === i && <tr><td colSpan={6} style={{ background: C.ink, padding: 0 }}><CorridorRowDetail row={row} pw={pw} /></td></tr>}
                  </React.Fragment>
                ); })}
              </tbody>
            </table>
          </div>
          {cov && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>
            Coverage: {cov.universe?.pids || cov.universe?.bbls || 0} lots screened{cov.notes?.length ? ` · ${cov.notes[0]}` : ""}. Availability is a prospecting signal from public records (permits, vacancy class, recent trades) — verify before outreach; no public feed confirms a live listing.
          </div>}
        </>
      )}
    </div>
  );
}

// FREE SC unmask #0 — the county's own data, auto-loaded on expand: every parcel whose
// ASSESSOR MAILING address matches this owner's tax-bill address. A single-asset LLC's
// tax bill usually goes to the principal's home or office, so the INDIVIDUALS sharing
// the address are the likely people behind it (each becomes a trace chip), and the
// entities sharing it are the owner's hidden portfolio — no registry, no key, no cost.
// County assessor person names are "LAST FIRST MIDDLE" — flip to "FIRST MIDDLE LAST"
// for trace seeds and people-search links (editable in the form if the guess is off).
const flipCountyName = (s) => {
  const t = String(s || "").trim().split(/\s+/);
  return t.length > 1 ? [...t.slice(1), t[0]].join(" ") : s;
};
function MailingXref({ r, pw }) {
  const raw = r.raw || {};
  const line = (r.mailing || raw.mailing || "").split(",")[0].trim();
  const zip = raw.mailing_zip || "";
  const owner = (r.owner || "").toUpperCase();
  const [state, setState] = useState(line ? "loading" : "none");
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!line) return;
    let alive = true;
    postJSON("/api/search", { password: pw, market: "charleston", mailingAddress: line, mailingZip: zip })
      .then((d) => { if (alive) { setRows(d.properties || []); setState("done"); } })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, []);
  if (state === "none" || state === "error") return null;
  const groups = new Map();
  for (const p of rows) {
    const k = (p.owner || "").toUpperCase();
    if (!k || k === owner) continue;
    if (!groups.has(k)) groups.set(k, { owner: p.owner, n: 0, sample: [] });
    const g = groups.get(k);
    g.n++;
    if (g.sample.length < 2 && p.address && !p.geocode_skip) g.sample.push(p.address);
  }
  const others = [...groups.values()].sort((a, b) => b.n - a.n);
  const people = others.filter((g) => !ENTITY_RE.test(g.owner));
  const ents = others.filter((g) => ENTITY_RE.test(g.owner)).slice(0, 10);
  if (state === "done" && !others.length) return null; // nothing shared — say nothing
  const massBox = others.length > 14; // a registered-agent / manager box, not a household
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>🏠 SAME TAX-BILL ADDRESS — free county unmask</div>
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>Cross-referencing {line}…</div>}
      {state === "done" && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>{others.length} other owner{others.length === 1 ? "" : "s"} get{others.length === 1 ? "s" : ""} county tax mail at <strong style={{ color: C.ivory }}>{line}</strong>{massBox ? " — a shared corporate / manager box, so read these as an office cluster rather than one household" : ""}:</div>
          {people.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {people.slice(0, 6).map((g, i) => (
                <div key={i} style={{ fontSize: 12.5, marginTop: 3 }}>👤 <span style={{ color: C.ivory, fontWeight: 600 }}>{g.owner}</span><span style={{ color: C.muted }}> · {g.n} parcel{g.n === 1 ? "" : "s"}{g.sample.length ? ` · ${g.sample[0]}` : ""} — likely a person behind this address</span></div>
              ))}
              <TracePeople people={people.slice(0, 6).map((g) => ({ name: flipCountyName(g.owner), street: line, city: raw.mailing_city || "", state: raw.mailing_state || "SC", zip }))} pw={pw} fallback={{ city: raw.mailing_city || "Charleston", state: raw.mailing_state || "SC" }} />
            </div>
          )}
          {ents.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              {ents.map((g, i) => (
                <div key={i}>🏢 <span style={{ color: C.ivory }}>{g.owner}</span> · {g.n} parcel{g.n === 1 ? "" : "s"}{g.sample.length ? ` · ${g.sample[0]}` : ""}</div>
              ))}
              <div style={{ fontSize: 10.5, marginTop: 4 }}>Related entities at the same address = the owner's likely wider book. Search any of them in Sourcing to pull their parcels.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── AI OUTREACH STUDIO ──────────────────────────────────────────────────────────
// The wow: one click turns a property's real signals into a ready-to-send outreach kit
// — cold-call opener, voicemail script, email, and text, personalized to THIS owner and
// building. The cheaper-Terrakotta move (their AI-voicemail/dialing, minus the auto-
// dialer). A human sends/dials — copy buttons, a prefilled email draft, and tel:/sms:
// links that light up when you paste the owner's number (from the trace/free lookup).
const COPY_LABELS = { call_opener: "Cold-call opener", voicemail: "Voicemail (~20s)", email: "Email", sms: "Text" };
function CopyBtn({ text, small }) {
  const [ok, setOk] = useState(false);
  return <button onClick={() => { if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1400); }).catch(() => {}); }}
    className="mono lift" style={{ ...ACTION_PILL, padding: small ? "3px 9px" : "4px 11px", fontSize: 10.5, background: ok ? C.goldSoft : C.panel, border: `1px solid ${ok ? C.gold : C.line}`, color: ok ? C.gold : C.ivory }}>{ok ? "✓ copied" : "⧉ copy"}</button>;
}
function OutreachStudio({ ctx, pw }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [kit, setKit] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("call_opener");
  const [phone, setPhone] = useState(""); // paste the owner's number → tel:/sms: light up
  const run = async () => {
    setState("loading"); setErr("");
    try {
      const d = await postJSON("/api/outreach", { password: pw, ...ctx });
      if (d.error) { setErr(d.error); setState("error"); return; }
      addScoutSpend(0.02); setKit(d.kit); setState("done");
    } catch (e) { setErr(e.message || "Draft failed."); setState("error"); }
  };
  const tel = phone.replace(/[^\d+]/g, "");
  const tabs = [["call_opener", "📞 Call"], ["voicemail", "🎙 Voicemail"], ["email", "✉️ Email"], ["sms", "💬 Text"]];
  const bodyFor = (t) => t === "email" ? `${kit.email_body}` : t === "sms" ? kit.sms : kit[t];
  const copyText = (t) => t === "email" ? `Subject: ${kit.email_subject}\n\n${kit.email_body}` : bodyFor(t);
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>✍️ AI OUTREACH STUDIO — call · voicemail · email · text</div>
        {state !== "loading" && <button onClick={run} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>{state === "done" ? "↻ redraft" : "▸ draft outreach"}</button>}
      </div>
      {state === "idle" && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 6 }}>Writes a personalized <strong style={{ color: C.ivory }}>cold-call opener, voicemail, email, and text</strong> for <strong style={{ color: C.ivory }}>{ctx.owner || "this owner"}</strong>, grounded in this property's real signals (corridor, availability read, tenure, last trade). One click, ~$0.02 — you send it.</div>}
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>Drafting the outreach kit…</div>}
      {state === "error" && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {state === "done" && kit && (
        <div style={{ marginTop: 10 }}>
          {kit.hook && <div style={{ fontSize: 12.5, color: C.ivory, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 11px", marginBottom: 10 }}><span style={{ color: C.gold }}>Angle:</span> {kit.hook}</div>}
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
            {tabs.map(([k, lab]) => <button key={k} onClick={() => setTab(k)} className="mono lift" style={{ ...ACTION_PILL, padding: "4px 11px", fontSize: 11, background: tab === k ? C.goldSoft : C.panel, border: `1px solid ${tab === k ? C.gold : C.line}`, color: tab === k ? C.gold : C.ivory }}>{lab}</button>)}
          </div>
          <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 8, padding: "11px 13px" }}>
            {tab === "email" && <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Subject: <span style={{ color: C.ivory }}>{kit.email_subject}</span></div>}
            <div style={{ fontSize: 13, color: C.ivory, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{bodyFor(tab)}</div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
              <CopyBtn text={copyText(tab)} />
              {tab === "email" && <a href={`mailto:?subject=${encodeURIComponent(kit.email_subject)}&body=${encodeURIComponent(kit.email_body)}`} className="mono lift" style={{ ...ACTION_PILL, padding: "4px 11px", fontSize: 10.5, background: C.panel, border: `1px solid ${C.gold}`, color: C.gold, textDecoration: "none" }}>✉️ open email draft</a>}
              {(tab === "call_opener" || tab === "voicemail") && (tel ? <a href={`tel:${tel}`} className="mono lift" style={{ ...ACTION_PILL, padding: "4px 11px", fontSize: 10.5, background: C.panel, border: `1px solid ${C.gold}`, color: C.gold, textDecoration: "none" }}>📞 call {phone}</a> : <span style={{ fontSize: 10.5, color: C.muted }}>paste a number below to enable one-tap call</span>)}
              {tab === "sms" && (tel ? <a href={`sms:${tel}?body=${encodeURIComponent(kit.sms)}`} className="mono lift" style={{ ...ACTION_PILL, padding: "4px 11px", fontSize: 10.5, background: C.panel, border: `1px solid ${C.gold}`, color: C.gold, textDecoration: "none" }}>💬 text {phone}</a> : <span style={{ fontSize: 10.5, color: C.muted }}>paste a number below to enable one-tap text</span>)}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="paste owner's number (from a trace / free lookup) for one-tap call & text" style={{ ...fieldStyle, flex: 1, fontSize: 12 }} />
          </div>
          <div style={{ fontSize: 10, color: C.muted, marginTop: 7, lineHeight: 1.5 }}>Review before sending — [bracketed] bits are yours to fill in. Grounded only in this property's data; verify any claim before you use it. You send it — no auto-dialing.</div>
        </div>
      )}
    </div>
  );
}

// Build the OutreachStudio context from an owner row (assessor / corridor shapes).
function outreachCtx(r, extra = {}) {
  const raw = r.raw || {};
  return {
    owner: r.owner || "", address: r.address || "", mailing: r.mailing || raw.mailing || "",
    market: r.marketLabel || "", use: r.use || raw.use || "",
    years_owned: raw.years_owned ?? "", last_sale_date: raw.sale_date || (raw.sale_year ? String(raw.sale_year) : "") || raw.last_sale_date || "",
    last_sale_price: raw.sale_price || raw.last_sale_price || null,
    ...extra,
  };
}

// Detail panel for the assessor markets (CT · Hamptons · Nashville): the record, the AI quick take,
// and the PAID skip trace — the SAME owner-contact workflow NYC has, so it works in every market.
function AssessorMarketDetail({ r, pw, outreachExtra = {} }) {
  const raw = r.raw || {};
  const isCo = ENTITY_RE.test(r.owner || "");
  const mState = raw.mailing_state || (r.market === "ct" ? "CT" : r.market === "tn" ? "TN" : r.market === "sc" ? "SC" : r.market === "savannah" ? "GA" : "NY");
  // One owner object shared by the AI brief and the skip trace (street = mailing before the first comma).
  const contactR = {
    name: r.owner || "", entity_type: isCo ? "company" : "person",
    contact_address: (r.mailing || "").split(",")[0].trim(), city: raw.mailing_city || raw.town || (r.market === "tn" ? "Nashville" : r.market === "sc" ? "Charleston" : r.market === "savannah" ? "Savannah" : ""),
    state: mState, zip: raw.mailing_zip || "", address: r.address, borough: r.marketLabel,
    last_sale_price: raw.sale_price || null, last_sale_date: raw.sale_date || (raw.sale_year ? String(raw.sale_year) : ""), years_owned: raw.years_owned ?? null,
  };
  return (
    <>
      <StorefrontPhoto r={r} pw={pw} />
      <AssessorDetail p={raw} market={r.market} />
      {r.market === "ct" && r.owner && ENTITY_RE.test(r.owner) && <CtEntityFinder owner={r.owner} pw={pw} />}
      {r.market === "sc" && <MailingXref r={r} pw={pw} />}
      {r.market === "sc" && r.owner && ENTITY_RE.test(r.owner) && <ScEntityFinder owner={r.owner} pw={pw} />}
      {r.market === "tn" && <NashvilleIntelPanel apn={raw.apn} address={r.address} pw={pw} />}
      {r.market === "sc" && <CharlestonIntelPanel pid={raw.pid} address={r.address} pw={pw} />}
      {(r.market === "tn" || r.market === "sc" || r.market === "savannah") && r.owner && <OwnerPortfolio owner={r.owner} pw={pw} st={r.market} />}
      <OutreachStudio ctx={outreachCtx(r, outreachExtra)} pw={pw} />
      <ResearchBrief r={contactR} pw={pw} />
      <ContactReveal r={contactR} pw={pw} />
      <OwnerPeople r={contactR} pw={pw} market={r.market} />
    </>
  );
}

// ───────────────────────── Map (Leaflet, reusable across Sourcing + Scout) ─────────────────────────
// Lazy-load Leaflet from CDN once — no build dependency, no API key, free OpenStreetMap/CARTO tiles.
let _leafletPromise = null;
function loadLeaflet() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.L) return Promise.resolve(window.L);
  if (_leafletPromise) return _leafletPromise;
  _leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"; js.async = true;
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error("Leaflet failed to load"));
    document.head.appendChild(js);
  });
  return _leafletPromise;
}
function useLeaflet() {
  const [L, setL] = useState(typeof window !== "undefined" ? window.L || null : null);
  useEffect(() => {
    if (L) return; let alive = true;
    loadLeaflet().then((lib) => { if (alive) setL(lib); }).catch(() => {});
    return () => { alive = false; };
  }, [L]);
  return L;
}

// Photon geocode (free, no key, CORS-open — same service AddressAutocomplete falls back to) for
// rows whose dataset has no coordinates (CT/Hamptons). Module-level cache so we never re-geocode.
const _geoCache = new Map();
async function geocodeAddress(q) {
  if (!q) return null;
  if (_geoCache.has(q)) return _geoCache.get(q);
  let pt = null;
  try {
    const r = await fetch(`https://photon.komoot.io/api?q=${encodeURIComponent(q)}&limit=1`);
    if (r.ok) {
      const f = ((await r.json()).features || [])[0];
      if (f && f.geometry) pt = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
    }
  } catch { /* leave null */ }
  _geoCache.set(q, pt);
  return pt;
}

function markerStyle(active) {
  return { radius: active ? 9 : 6, color: "#ffffff", weight: 2, fillColor: active ? C.amber : C.gold, fillOpacity: active ? 1 : 0.85 };
}

// Reusable property map. points: [{ id, lat, lon, label }]. Clicking a pin -> onPick(id).
function PropertyMap({ points, center, activeId, onPick, height = 320 }) {
  const L = useLeaflet();
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());

  useEffect(() => {
    if (!L || !elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", {
      maxZoom: 19, subdomains: "abcd", attribution: "© OpenStreetMap © CARTO",
    }).addTo(map);
    map.setView([center?.lat || 40.74, center?.lon || -73.98], 13);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 60); // size correctly after layout settles
    return () => { map.remove(); mapRef.current = null; markersRef.current.clear(); };
  }, [L]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current; if (!map || !L) return;
    markersRef.current.forEach((m) => map.removeLayer(m));
    markersRef.current.clear();
    const latlngs = [];
    for (const p of points || []) {
      if (p.lat == null || p.lon == null) continue;
      const m = L.circleMarker([p.lat, p.lon], markerStyle(p.id === activeId));
      if (onPick) m.on("click", () => onPick(p.id));
      if (p.label) m.bindTooltip(String(p.label), { direction: "top" });
      m.addTo(map);
      markersRef.current.set(p.id, m);
      latlngs.push([p.lat, p.lon]);
    }
    if (latlngs.length === 1) map.setView(latlngs[0], 16);
    else if (latlngs.length > 1) map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 16 });
    else if (center) map.setView([center.lat, center.lon], 13);
  }, [points, L]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    markersRef.current.forEach((m, id) => m.setStyle(markerStyle(id === activeId)));
    const am = activeId != null && markersRef.current.get(activeId);
    if (am) map.panTo(am.getLatLng());
  }, [activeId]);

  return (
    <div style={{ borderRadius: 12, overflow: "hidden", border: `1px solid ${C.line}`, position: "relative" }}>
      <div ref={elRef} style={{ height, width: "100%", background: C.panel2 }} />
      {!L && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: C.muted, fontSize: 12 }}>Loading map…</div>}
    </div>
  );
}

// Turn Sourcing rows into map points, filling coordinates: NYC rows already carry lat/lon; CT/
// Hamptons rows are geocoded (throttled) via Photon. Returns [points, setNothing] live-updating.
function useSourcingPoints(rows) {
  const [points, setPoints] = useState([]);
  useEffect(() => {
    if (!rows) { setPoints([]); return; }
    let alive = true;
    const base = rows.map((r, i) => {
      const raw = r.raw || {};
      const lat = raw.lat ?? raw.latitude ?? null, lon = raw.lon ?? raw.longitude ?? null;
      return { id: i, lat: lat != null ? Number(lat) : null, lon: lon != null ? Number(lon) : null, label: r.address || r.owner };
    });
    setPoints(base);
    // Skip rows the engine flagged as un-geocodable (e.g. Charleston parcels with only a
    // legal description — "TRACT B-1" geocodes to random places and drags the map away).
    const missing = base.filter((p) => (p.lat == null || p.lon == null) && rows[p.id] && rows[p.id].address && !(rows[p.id].raw && rows[p.id].raw.geocode_skip));
    (async () => {
      for (let i = 0; i < missing.length && i < 60; i += 4) {
        const batch = missing.slice(i, i + 4);
        const got = await Promise.all(batch.map(async (p) => {
          const r = rows[p.id];
          // A full address (already has a comma/city) geocodes as-is; a bare street gets its market appended.
          const q = /,/.test(r.address || "") ? r.address : `${r.address}, ${r.marketLabel || ""}`;
          const g = await geocodeAddress(q);
          return g ? { id: p.id, ...g } : null;
        }));
        if (!alive) return;
        setPoints((prev) => {
          const next = prev.slice();
          for (const g of got) if (g) { const idx = next.findIndex((x) => x.id === g.id); if (idx >= 0) next[idx] = { ...next[idx], lat: g.lat, lon: g.lon }; }
          return next;
        });
      }
    })();
    return () => { alive = false; };
  }, [rows]);
  return points;
}

function UnifiedSourcing({ pw, rows, setRows }) {
  const [loc, setLoc] = useState("");
  const [coords, setCoords] = useState(null);
  const [typedText, setTypedText] = useState(""); // what the user actually TYPED, kept across an autocomplete pick
  const [market, setMarket] = useState("auto"); // auto-detect, or lock to a market so a bare address can't mis-route
  const [type, setType] = useState("any"); // default to ANY so a search isn't silently limited to retail
  const [radius, setRadius] = useState("");
  const [minValue, setMinValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resolved, setResolved] = useState(null);
  const [openIdx, setOpenIdx] = useState(null);
  const [sortBy, setSortBy] = useState("opp"); // opp | default (distance, for radius searches)
  const points = useSourcingPoints(rows);
  // Render a sorted VIEW but keep each row's ORIGINAL index (`i`) — openIdx, the
  // row id, and map pins (useSourcingPoints keys on the original index) all stay aligned.
  const view = useMemo(() => {
    if (!rows) return rows;
    const arr = rows.map((r, i) => ({ r, i, opp: opportunityScore(r) }));
    if (sortBy === "opp") arr.sort((a, b) => (b.opp ? b.opp.overall : -1) - (a.opp ? a.opp.overall : -1));
    return arr;
  }, [rows, sortBy]);
  const anyScored = !!(rows && rows.some((r) => opportunityScore(r)));
  const pickPin = (id) => { setOpenIdx(id); const el = document.getElementById(`usrc-row-${id}`); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); };

  const run = async () => {
    if (loading) return; // Enter can re-fire mid-search — two runs race and the older response would clobber the newer market/rows
    let det = unifiedDetect(loc, coords);
    // If the user TYPED a city that names a specific market (e.g. "…Charleston SC") but then
    // PICKED an autocomplete suggestion from a different market (usually a same-named NYC street —
    // Charleston, Nashville & NYC all have a King St / Broad St / Church St), the pick's label +
    // coords would force that wrong market. Honor what they typed. Only on auto-detect, only when
    // the typed market differs from where the pick routed.
    if (market === "auto" && coords) {
      const typedMkt = marketFromText(typedText || "");
      if (typedMkt && typedMkt.market !== det.market) det = { ...typedMkt, kind: "address-text" };
    }
    // MARKET LOCK — if the user pinned a market, force the route there so a bare address can't
    // mis-route (e.g. a Nashville address fuzzy-matching a Brooklyn lot). Auto = detect from the text.
    if (market !== "auto") {
      const raw = (loc || "").trim();
      const addr = raw.split(",")[0].trim(); // street portion
      const hasNum = /\d/.test(addr);
      if (market === "nyc") det = hasNum ? { market: "nyc", kind: "address-text", nearAddress: addr } : (NYC_BORO_SET[raw.toLowerCase()] ? { market: "nyc", kind: "borough", borough: NYC_BORO_SET[raw.toLowerCase()] } : { market: "nyc", kind: "address-text", nearAddress: raw });
      else if (market === "tn") det = { market: "tn", town: "Nashville", address: hasNum ? addr : "", kind: "address-text" };
      else if (market === "sc") det = { market: "sc", town: "Charleston", address: hasNum ? addr : "", kind: "address-text" };
      else if (market === "savannah") det = { market: "savannah", town: "Savannah", address: hasNum ? addr : "", kind: "address-text" };
      else if (market === "ct") det = { market: "ct", town: CT_TOWN_SET.has(raw.toLowerCase()) ? titleCase(raw) : "Greenwich", address: hasNum ? addr : "", kind: "address-text" };
      else if (market === "ny") det = { market: "ny", town: HAMPTON_SET.has(raw.toLowerCase()) ? (HAMLET_TOWN[raw.toLowerCase()] || titleCase(raw)) : "East Hampton", address: hasNum ? addr : "", kind: "address-text" };
    }
    if (!det.market) { setError("Try a NYC borough or address (Manhattan · 120 5th Ave…), a CT town (Greenwich, Darien…), a Hamptons town (East Hampton, Southampton…), Nashville, Charleston SC, or Savannah GA."); return; }
    // Radius needs an ANCHOR point. Only an NYC address (picked or typed → geocoded) and a
    // picked Nashville address have one; a borough or a CT/Hamptons town does not, so radius
    // is silently ignored there — tell the user instead of looking broken.
    const radiusActive = !!radius && Number(radius) > 0;
    // A specific building was looked up (so "just it" returns one property, and radius is moot).
    const anchored = det.kind === "address" || det.kind === "address-text"
      || !!(det.address && det.address.trim()) || ((det.market === "tn" || det.market === "sc" || det.market === "savannah") && !!coords);
    // Radius only does a real area search in the coordinate markets (NYC + picked Nashville/Charleston/Savannah).
    const usesRadius = radiusActive && anchored && (det.market === "nyc" || ((det.market === "tn" || det.market === "sc" || det.market === "savannah") && !!coords));
    setNotice(radiusActive && !anchored
      ? "Radius needs a specific address — pick one from the dropdown. A borough or town has no center point, so these results cover the whole area."
      : "");
    // A radius area search shows nearest-first (the engine's order, anchor pinned); everything
    // else ranks by Opportunity Score.
    setSortBy(usesRadius ? "default" : "opp");
    setError(""); setRows(null); setOpenIdx(null); setLoading(true); setResolved(det);
    try {
      let out = [];
      let tnBroadened = false; // set when a missing Nashville house number is broadened to the whole street
      if (det.market === "nyc") {
        if (det.kind === "address" && coords) {
          // nearAddress must be sent too — the NYC search only sets the property anchor when
          // nearAddress is present (else it falls through to a citywide search).
          const d = await postJSON("/api/search", { password: pw, market: "nyc", sources: ["pluto"], assetType: mapType(type, "nyc"), nearAddress: loc, radiusMiles: radius || "", centerLat: coords.lat, centerLon: coords.lon, pickedBbl: coords.bbl });
          out = (d.leads || []).map(nycRow);
        } else if (det.kind === "address-text") {
          const d = await postJSON("/api/search", { password: pw, market: "nyc", sources: ["pluto"], assetType: mapType(type, "nyc"), nearAddress: det.nearAddress, radiusMiles: radius || "" });
          out = (d.leads || []).map(nycRow);
        } else {
          const d = await postJSON("/api/search", { password: pw, market: "nyc", sources: ["acris", "dob", "pluto"], borough: det.borough, assetType: mapType(type, "nyc"), limit: 80 });
          out = (d.leads || []).map(nycRow);
        }
      } else if (det.market === "ct") {
        const addr = (det.address || "").trim(); // a specific building was looked up
        if (addr) {
          // "Just it": pin the one property. CT `location` is "STREET NAME <padded #>", so match
          // on the street core (suffix-agnostic) then keep the parcel whose trailing # is the house.
          const { num, core } = streetBits(addr);
          // limit 500 (not the default 100-by-value) so a lower-value target parcel on a busy
          // street isn't dropped before the house-number filter — e.g. 145 Greenwich Ave sits
          // outside the top 100 Greenwich Avenue parcels by assessed value.
          const d = await postJSON("/api/search", { password: pw, market: "ct", town: det.town, propertyType: "any", address: core, limit: 500 });
          const rows = (d.properties || []).map(ctRow);
          const exact = num ? rows.filter((r) => houseInAddress(r.address, num, true)) : [];
          if (exact.length) out = exact.slice(0, 1);
          else if (num && rows.length) {
            // Don't silently present the street's highest-assessed parcel as the searched
            // building — say the number missed and show the street so the user can pick.
            setNotice(`No ${det.town || "CT"} parcel carries #${num} on ${core} — showing the street's parcels instead; pick the right one.`);
            out = rows.slice(0, 25);
          } else out = rows.slice(0, 1);
        } else {
          const d = await postJSON("/api/search", { password: pw, market: "ct", town: det.town, propertyType: mapType(type, "ct"), minValue });
          out = (d.properties || []).map(ctRow);
        }
      } else if (det.market === "tn") {
        const hasPoint = coords && coords.lat != null && coords.lon != null;
        const street = (det.address || "").trim(); // the street portion, if the text named one
        const justIt = !radius || Number(radius) === 0;
        const houseNum = streetBits(street).num; // present when a SPECIFIC building was looked up
        let d = null;
        if (justIt && houseNum) {
          // Specific building → the RELIABLE pin is an ADDRESS match (PropAddr LIKE), with the type
          // filter OFF so the building isn't excluded by its land use. (A map-pin / point-in-polygon
          // search can land off-parcel, and a retail filter would drop a non-retail address — that's
          // why "2222 12th Ave S" wouldn't come up.)
          d = await postJSON("/api/search", { password: pw, market: "nashville", propertyType: "any", address: street });
        } else if (hasPoint && (street || radius)) {
          // A radius area search around a picked point (keep the type filter for "retail nearby").
          d = await postJSON("/api/search", { password: pw, market: "nashville", centerLat: coords.lat, centerLon: coords.lon, radiusMiles: radius || "", propertyType: justIt ? "any" : mapType(type, "tn"), minValue });
        }
        // Bare street/city name (no house number), or an empty pinned search → attribute search.
        if (!d || !(d.properties || []).length) {
          const specific = /^\s*\d+\s/.test(street);
          d = await postJSON("/api/search", { password: pw, market: "nashville", propertyType: street && specific ? "any" : mapType(type, "tn"), minValue, ...(street ? { address: street } : {}) });
        }
        out = (d.properties || []).map(nashRow);
        // "Just it": pin to the single building matching the house number (TN addresses are number-first).
        if (justIt && houseNum) {
          const exact = out.filter((r) => houseInAddress(r.address, houseNum, false));
          if (exact.length) {
            out = exact.slice(0, 1);
          } else {
            // Exact house number isn't in Metro's records (a numbering gap / combined or vacant lot) →
            // show the rest of the STREET so the user can find the right parcel instead of getting nothing.
            const streetOnly = street.replace(/^\s*\d+[A-Za-z]?\s+/, "").trim();
            if (streetOnly) {
              try {
                const d2 = await postJSON("/api/search", { password: pw, market: "nashville", propertyType: "any", address: streetOnly });
                const rows = (d2.properties || []).map(nashRow);
                if (rows.length) { out = rows; tnBroadened = true; setNotice(`No "${street}" in Metro's records (the numbering skips it). Showing all of ${streetOnly} — pick the right parcel.`); }
                else out = [];
              } catch { out = []; }
            } else out = [];
          }
        }
      } else if (det.market === "sc") {
        // Charleston, SC — same shape as the Nashville flow: address pin, spatial radius
        // around a picked point, or an attribute browse (owner data is public in SC).
        const hasPoint = coords && coords.lat != null && coords.lon != null;
        const street = (det.address || "").trim();
        const justIt = !radius || Number(radius) === 0;
        const houseNum = streetBits(street).num;
        let d = null;
        if (justIt && houseNum) {
          d = await postJSON("/api/search", { password: pw, market: "charleston", propertyType: "any", address: street });
        } else if (hasPoint && (street || radius)) {
          d = await postJSON("/api/search", { password: pw, market: "charleston", centerLat: coords.lat, centerLon: coords.lon, radiusMiles: radius || "", propertyType: justIt ? "any" : mapType(type, "sc"), minValue });
        }
        if (!d || !(d.properties || []).length) {
          const specific = /^\s*\d+\s/.test(street);
          d = await postJSON("/api/search", { password: pw, market: "charleston", propertyType: street && specific ? "any" : mapType(type, "sc"), minValue, ...(street ? { address: street } : {}) });
        }
        out = (d.properties || []).map(scRow);
        // "Just it": pin to the single parcel matching the typed house number.
        if (justIt && houseNum) {
          const exact = out.filter((r) => houseInAddress(r.address, houseNum, false));
          if (exact.length) out = exact.slice(0, 1);
        }
      } else if (det.market === "savannah") {
        // Savannah / Chatham County, GA — same shape as the Charleston flow: address pin,
        // spatial radius around a picked point, or an attribute browse (GA owner data is public).
        const hasPoint = coords && coords.lat != null && coords.lon != null;
        const street = (det.address || "").trim();
        const justIt = !radius || Number(radius) === 0;
        const houseNum = streetBits(street).num;
        let d = null;
        if (justIt && houseNum) {
          d = await postJSON("/api/search", { password: pw, market: "savannah", propertyType: "any", address: street });
        } else if (hasPoint && (street || radius)) {
          d = await postJSON("/api/search", { password: pw, market: "savannah", centerLat: coords.lat, centerLon: coords.lon, radiusMiles: radius || "", propertyType: justIt ? "any" : mapType(type, "savannah"), minValue });
        }
        if (!d || !(d.properties || []).length) {
          const specific = /^\s*\d+\s/.test(street);
          d = await postJSON("/api/search", { password: pw, market: "savannah", propertyType: street && specific ? "any" : mapType(type, "savannah"), minValue, ...(street ? { address: street } : {}) });
        }
        out = (d.properties || []).map(savRow);
        if (justIt && houseNum) {
          const exact = out.filter((r) => houseInAddress(r.address, houseNum, false));
          if (exact.length) out = exact.slice(0, 1);
        }
      } else if (det.market === "web") {
        // Any US address outside the free-data markets: one row that offers AI web research
        // (gated behind a click in the dossier — never auto-spends).
        const pt = det.coords || coords || null;
        out = [{ market: "web", marketLabel: "Web research", owner: "", address: det.address || loc, use: "", value: "", absentee: null, mailing: "", mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(det.address || loc)}`, raw: { address: det.address || loc, lat: pt ? pt.lat : null, lon: pt ? pt.lon : null } }];
      } else {
        const addr = (det.address || "").trim(); // a specific building was looked up
        if (addr) {
          // "Just it": NY's roll street field has NO house number, so match the street core,
          // then keep only the parcel whose address carries the looked-up house number.
          const { num, core } = streetBits(addr);
          const d = await postJSON("/api/search", { password: pw, market: "hamptons", town: det.town, propertyType: "any", address: core, limit: 500 });
          const rows = (d.properties || []).map(nyRow);
          const exact = num ? rows.filter((r) => houseInAddress(r.address, num, false)) : [];
          if (exact.length) out = exact.slice(0, 1);
          else if (num && rows.length) {
            // Same guard as CT: never pass off an arbitrary street parcel as the searched building.
            setNotice(`No ${det.town || "Hamptons"} parcel carries #${num} on ${core} — showing the street's parcels instead; pick the right one.`);
            out = rows.slice(0, 25);
          } else out = rows.slice(0, 1);
        } else {
          const d = await postJSON("/api/search", { password: pw, market: "hamptons", town: det.town, propertyType: mapType(type, "ny"), minValue });
          out = (d.properties || []).map(nyRow);
        }
      }
      // ROBUSTNESS FALLBACK — an address typed WITHOUT its city defaults to NYC, where the geocoder
      // can FUZZY-MATCH a wrong lot (NYC has a "12 Avenue S" in Brooklyn, so "2222 12th ave south"
      // returned a house-8 Brooklyn lot, not empty). Detect that: if no returned lot carries the
      // house number the user typed, the search mis-routed → retry Nashville (then NYC) by exact house.
      const addrText = (det.address || det.nearAddress || loc || "").trim();
      const { num: typedNum, core: typedCore } = streetBits(addrText);
      // A match must carry the typed house number AND look like the typed STREET — the NYC
      // geocoder happily fuzzy-matches "360 King Street" to "360 W 125 St" (right number,
      // wrong street), which the number check alone can't catch.
      const coreToks = String(typedCore || "").split(/\s+/).filter((t) => t.length >= 3 && !STREET_SUFFIX.has(t) && !["EAST", "WEST", "NORTH", "SOUTH"].includes(t));
      const streetOk = (a) => !coreToks.length || coreToks.some((t) => String(a || "").toUpperCase().includes(t));
      // Both number formats: leading (NYC/TN/SC "145 GREENWICH AVE") AND trailing (CT
      // "GREENWICH AVENUE 0145") — checking only leading made every CORRECT CT pin look
      // like a miss, which sent the fallback hunting and let NYC replace the right answer.
      const addrOk = (r) => (houseInAddress(r.address, typedNum, false) || houseInAddress(r.address, typedNum, true)) && streetOk(r.address);
      const hasHouseMatch = typedNum ? (out && out.some(addrOk)) : (out && out.length > 0);
      // Only when AUTO-detecting — a locked market must not silently jump to another (that's the point).
      // Also skip when we intentionally broadened a Nashville street (that result is what we want to show).
      if (market === "auto" && !tnBroadened && /\d/.test(addrText) && !hasHouseMatch) {
        if (det.market !== "tn") {
          try {
            const d = await postJSON("/api/search", { password: pw, market: "nashville", propertyType: "any", address: addrText });
            let rows = (d.properties || []).map(nashRow);
            if (typedNum) rows = rows.filter(addrOk);
            if (rows.length) { out = typedNum ? rows.slice(0, 1) : rows; setResolved({ market: "tn", town: "Nashville" }); setNotice(""); }
          } catch { /* keep trying */ }
        }
        let stillNoMatch = !out.length || (typedNum && !out.some(addrOk));
        if (stillNoMatch && det.market !== "sc") {
          try {
            const d = await postJSON("/api/search", { password: pw, market: "charleston", propertyType: "any", address: addrText });
            let rows = (d.properties || []).map(scRow);
            if (typedNum) rows = rows.filter(addrOk);
            if (rows.length) { out = typedNum ? rows.slice(0, 1) : rows; setResolved({ market: "sc", town: "Charleston" }); setNotice(""); }
          } catch { /* keep trying */ }
        }
        stillNoMatch = !out.length || (typedNum && !out.some(addrOk));
        if (stillNoMatch && det.market !== "nyc") {
          try {
            const d = await postJSON("/api/search", { password: pw, market: "nyc", sources: ["pluto"], assetType: "any", nearAddress: addrText });
            let rows = (d.leads || []).map(nycRow);
            // Same house+street guard as the other legs — the NYC geocoder fuzzy-matches
            // hard, and an unfiltered last leg would swap in a wrong-borough lot.
            if (typedNum) rows = rows.filter(addrOk);
            if (rows.length) { out = typedNum ? rows.slice(0, 1) : rows; setResolved({ market: "nyc", borough: "" }); setNotice(""); }
          } catch { /* give up gracefully */ }
        }
      }
      setRows(out);
      if (out.length === 1) setOpenIdx(0); // single property → open its dossier immediately
    } catch (e) { setError(e.message || "Search failed."); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div className="mono" style={{ ...labelStyle, marginBottom: 10 }}>SEARCH ANY MARKET — NYC · CT · HAMPTONS · NASHVILLE · ANY US ADDRESS</div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1.1fr 1fr 1fr 1fr", gap: 12, alignItems: "end" }}>
          <label>
            <div className="mono" style={labelStyle}>WHERE — borough · town · or address</div>
            <div style={{ marginTop: 4 }}>
              <AddressAutocomplete value={loc}
                onChange={(t) => { setLoc(t); setCoords(null); setTypedText(t); }}
                marketHint={market}
                onPick={(label, lat, lon, bbl) => { setLoc(label); setCoords({ lat, lon, bbl }); }}
                onEnter={run}
                placeholder="Manhattan · Greenwich · Nashville · Charleston · or any US address (500 Main St, Austin TX)…" style={{ ...fieldStyle, width: "100%" }} />
            </div>
          </label>
          <label><div className="mono" style={labelStyle}>MARKET</div><select value={market} onChange={(e) => setMarket(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>{[["auto", "Auto-detect"], ["nyc", "New York City"], ["tn", "Nashville · TN"], ["sc", "Charleston · SC"], ["savannah", "Savannah · GA"], ["ct", "Greenwich · CT"], ["ny", "Hamptons · NY"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label><div className="mono" style={labelStyle}>TYPE</div><select value={type} onChange={(e) => setType(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>{UNIFIED_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label><div className="mono" style={labelStyle}>RADIUS (picked address)</div><select value={radius} onChange={(e) => setRadius(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>{[["", "off · just it"], ["0.1", "0.1 mi"], ["0.25", "0.25 mi"], ["0.5", "0.5 mi"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label><div className="mono" style={labelStyle}>MIN VALUE</div><input type="number" value={minValue} onChange={(e) => setMinValue(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }} placeholder="" /></label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={run} disabled={loading} className="mono lift" style={{ cursor: loading ? "default" : "pointer", fontSize: 12, padding: "9px 20px", borderRadius: 8, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold, opacity: loading ? 0.5 : 1 }}>{loading ? "SEARCHING…" : "◎ SEARCH"}</button>
          {rows && rows.length > 0 && <button onClick={() => downloadBlob(unifiedCSV(rows), `frontage_${(resolved && resolved.market) || "search"}_${new Date().toISOString().slice(0, 10)}.csv`, "text/csv")} className="mono" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ CSV</button>}
          {rows && rows.length > 0 && <button onClick={() => downloadXlsx(`frontage_${(resolved && resolved.market) || "search"}_${new Date().toISOString().slice(0, 10)}.xlsx`, "Leads", UNIFIED_COLS, rows)} className="mono" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXCEL</button>}
          {resolved && <span style={{ fontSize: 11.5, color: C.muted }}>Market: <strong style={{ color: C.gold }}>{resolved.market === "nyc" ? (resolved.borough || "New York City") : resolved.market === "web" ? "Web research (any US)" : resolved.town + (resolved.market === "ct" ? ", CT" : resolved.market === "tn" ? ", TN" : resolved.market === "sc" ? ", SC" : resolved.market === "savannah" ? ", GA" : ", NY")}</strong></span>}
        </div>
        {error && <div style={{ marginTop: 12, fontSize: 12.5, color: C.red, background: `${C.red}10`, border: `1px solid ${C.red}40`, borderRadius: 8, padding: "9px 12px" }}>{error}</div>}
        {notice && <div style={{ marginTop: 12, fontSize: 12, color: C.amber, background: C.goldSoft, border: `1px solid ${C.amber}40`, borderRadius: 8, padding: "9px 12px" }}>{notice}</div>}
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>
          One bar, every US market. Free public-records dossiers in <strong style={{ color: C.ivory }}>NYC</strong> (21 datasets), <strong style={{ color: C.ivory }}>Greenwich/CT</strong>, <strong style={{ color: C.ivory }}>Hamptons/NY</strong>, <strong style={{ color: C.ivory }}>Nashville/TN</strong>, <strong style={{ color: C.ivory }}>Charleston/SC</strong>, and <strong style={{ color: C.ivory }}>Savannah/GA</strong> — and for <strong style={{ color: C.ivory }}>any other US address</strong>, an on-demand AI web lookup that finds the owner + contacts (~$0.30, only when you click). Type a place or address; we route automatically; click <strong style={{ color: C.ivory }}>▸ details</strong> for the record + AI deep dive.
        </div>
      </div>

      {rows && rows.length > 0 && points.some((p) => p.lat != null && p.lon != null) && (
        <div style={{ marginTop: 18 }}>
          <div className="mono" style={{ ...labelStyle, marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
            <span>MAP</span>
            <span style={{ color: C.muted, textTransform: "none", letterSpacing: 0 }}>{points.filter((p) => p.lat != null).length} of {rows.length} located · click a pin</span>
          </div>
          <PropertyMap points={points} center={coords || points.find((p) => p.lat != null)} activeId={openIdx} onPick={pickPin} height={340} />
        </div>
      )}

      {rows && (
        <div style={{ marginTop: 18 }}>
          <div className="mono" style={{ ...labelStyle, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{rows.length} PROPERT{rows.length === 1 ? "Y" : "IES"}{!resolved ? " · FROM SCOUT" : ""}</span>
            {anyScored && rows.length > 1 && (
              <span style={{ display: "flex", alignItems: "center", gap: 6, textTransform: "none", letterSpacing: 0 }}>
                <span style={{ color: C.muted, fontSize: 10 }}>SORT</span>
                {[["opp", "Opportunity"], ["default", "Default"]].map(([v, l]) => (
                  <button key={v} onClick={() => setSortBy(v)} className="mono" style={{ cursor: "pointer", fontSize: 10, padding: "3px 9px", borderRadius: 6, border: `1px solid ${sortBy === v ? C.gold : C.line}`, background: sortBy === v ? C.goldSoft : "transparent", color: sortBy === v ? C.gold : C.muted }}>{l}</button>
                ))}
              </span>
            )}
          </div>
          {rows.length === 0 ? <div style={{ color: C.muted, fontSize: 13 }}>No properties matched. Try a different type or location.</div> : (
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>
                  {["Opportunity", "Owner", "Property", "Use", "Value", ""].map((h, i) => <th key={h} style={{ textAlign: i === 4 ? "right" : "left", padding: "9px 12px", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: C.muted }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {view.map(({ r, i, opp }) => (<React.Fragment key={i}>
                    <tr id={`usrc-row-${i}`} style={{ borderBottom: `1px solid ${C.line}`, background: openIdx === i ? C.goldSoft : "transparent" }}>
                      <td style={{ padding: "9px 12px" }}>{opp ? <GradeCell g={opp} /> : <span style={{ color: C.line, fontSize: 11 }}>—</span>}</td>
                      <td style={{ padding: "9px 12px", fontSize: 13, maxWidth: 240 }}>
                        <div style={{ fontWeight: 700, color: C.ivory }}>{r.owner || "—"}{r.absentee && <span className="mono" style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", borderRadius: 5, background: C.goldSoft, color: C.amber, whiteSpace: "nowrap" }}>{r.absentee === "out-of-state" ? "OUT-OF-STATE" : "OUT-OF-AREA"}</span>}</div>
                        {r.mailing && <div style={{ color: C.muted, fontSize: 11, marginTop: 1 }}>{r.mailing}</div>}
                      </td>
                      <td style={{ padding: "9px 12px", fontSize: 12.5 }}><a href={r.mapsUrl} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{r.address || "—"} ↗</a></td>
                      <td style={{ padding: "9px 12px", fontSize: 12, color: C.muted }}>{r.use}</td>
                      <td className="mono" style={{ padding: "9px 12px", fontSize: 12.5, textAlign: "right" }}>{r.value || "—"}</td>
                      <td style={{ padding: "9px 12px" }}><div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}><SaveLeadButton r={r} opp={opp} /><button onClick={() => setOpenIdx(openIdx === i ? null : i)} className="mono lift" style={{ cursor: "pointer", fontSize: 11, padding: "4px 10px", borderRadius: 7, border: `1px solid ${openIdx === i ? C.gold : C.line}`, background: openIdx === i ? C.goldSoft : C.panel, color: openIdx === i ? C.gold : C.ivory, whiteSpace: "nowrap" }}>{openIdx === i ? "▾ hide" : "▸ details"}</button></div></td>
                    </tr>
                    {openIdx === i && (
                      <tr><td colSpan={6} style={{ padding: r.market === "nyc" || r.market === "web" ? "0" : "4px 14px 18px", background: C.ink }}>
                        {r.market !== "web" && (
                          <div style={{ padding: r.market === "nyc" ? "14px 14px 0" : "0" }}>
                            {opp && <OppBreakdown g={opp} />}
                            <AcquisitionMemo r={r} score={opp} pw={pw} />
                            <OutreachDraft r={r} score={opp} pw={pw} />
                          </div>
                        )}
                        {r.market === "web" ? (() => {
                          const parts = (r.address || "").split(",").map((s) => s.trim());
                          const webR = { name: "", entity_type: "", address: parts[0] || r.address, contact_address: "", city: parts[1] || "", state: (parts[2] || "").split(/\s+/)[0] || "", zip: "", borough: "", last_sale_price: null, last_sale_date: "", years_owned: null };
                          return (
                            <div style={{ padding: "12px 14px 16px" }}>
                              <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>No free public-records feed covers this address, but you can still source it. Run AI web research to identify the owner of record, unmask the entity behind it, and pull published contacts — from the live web (~$0.30, only when you click). For deeper work, ask Scout the same.</div>
                              <ResearchBrief r={webR} pw={pw} forceMode="web" />
                              <div style={{ fontSize: 11, color: C.muted, margin: "10px 0 0" }}>No owner of record here, so the skip trace runs on the <strong>property address</strong> — it returns occupants / the operating business (verify before calling). For the actual owner, run the AI research above first.</div>
                              <ContactReveal r={webR} pw={pw} />
                            </div>
                          );
                        })() : r.market === "nyc" ? <PropertyDetail r={r.raw} pw={pw} /> : <AssessorMarketDetail r={r} pw={pw} />}
                      </td></tr>
                    )}
                  </React.Fragment>))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!rows && !loading && (
        <div style={{ marginTop: 22, color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
          <span className="serif" style={{ color: C.ivory, fontSize: 15 }}>One search, every market.</span> Type a NYC borough or address, a CT town (Greenwich, Darien…), a Hamptons town (East Hampton, Southampton, Shelter Island), <strong style={{ color: C.ivory }}>Nashville</strong>, or <strong style={{ color: C.ivory }}>Charleston SC</strong> (any Charleston County town). FRONTAGE routes to the right public-records engine and returns owners; open <strong style={{ color: C.ivory }}>▸ details</strong> for the full record and the AI deep dive.
        </div>
      )}
    </div>
  );
}

// ── LEASE RADAR ──────────────────────────────────────────────────────────────
// Scans a corridor of properties, pulls their recorded ACRIS leases, and ranks by
// an ESTIMATED expiration (latest recorded lease + assumed term). Surfaces lots
// whose leases are estimated to be coming available — off-market, before they list.
const radarNorm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const monthYear = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-US", { month: "short", year: "numeric" });
};
function radarBadge(L) {
  if (!L) return null;
  if (L.status === "expiring") return { text: "OFF-MARKET · EXPIRING", bg: C.goldSoft, fg: C.gold, border: C.gold };
  if (L.status === "expired") return { text: "EST. LEASE ENDED", bg: "rgba(183,121,31,0.12)", fg: C.amber, border: C.amber };
  if (L.status === "active") return { text: "LONG LEASE", bg: "transparent", fg: C.muted, border: C.line };
  return { text: "NO LEASE ON RECORD", bg: "transparent", fg: C.muted, border: C.line };
}
function mteText(L) {
  if (!L || L.months_to_expiry == null) return "";
  const m = L.months_to_expiry;
  if (m < 0) return `est. ended ~${-m} mo ago`;
  if (m === 0) return "est. ending now";
  return `est. ~${m} mo out`;
}
// ── LEASE RADAR grading workflow ─────────────────────────────────────────────
// Mirrors the Screener's mandate grader: editable signal WEIGHTS + Target/Watch/
// Pass THRESHOLDS, saved as named mandates in localStorage. Every scanned property
// is scored on public signals already attached to the lead by the NYC search (no extra
// API calls) — lease timing, how long the owner has held, tax-lien distress,
// absentee/out-of-state mailing, unused air rights — then blended into one 0–100
// TARGET score with a recommendation. Tuning weights re-grades results instantly.
const RADAR_PRESETS_KEY = "fr_radar_presets_v1";
const RADAR_ACTIVE_KEY = "fr_radar_active_v1";
const RADAR_DEFAULT_CONFIG = {
  name: "Off-Market Targets",
  weights: { lease_timing: 30, long_hold: 25, distress: 20, absentee: 15, air_rights: 10 },
  thresholds: { target: 65, watch: 40 },
};

// Each signal → a 0–100 sub-score derived from the public data on the lead.
const holdSub = (yo) => (yo == null ? 0 : yo >= 20 ? 100 : yo >= 15 ? 82 : yo >= 10 ? 60 : yo >= 5 ? 35 : Math.round(yo * 4));
const airSub = (sf) => { const n = Number(sf) || 0; return n >= 20000 ? 100 : n >= 8000 ? 66 : n >= 2500 ? 40 : 0; };
const absSub = (a) => (a === "out-of-state" ? 100 : a === "out-of-area" ? 60 : 0);
const RADAR_SIGNALS = [
  { id: "lease_timing", label: "Lease timing", desc: "Lease estimated to be coming available soon",
    sub: (r) => (r.lease ? r.lease.score : 0), note: (r) => (r.lease ? (mteText(r.lease) || r.lease.status) : "—") },
  { id: "long_hold", label: "Long hold", desc: "Owner has held a long time — classic seller candidate",
    sub: (r) => holdSub(r.years_owned), note: (r) => (r.years_owned == null ? "no deed on record" : `held ${r.years_owned} yr${r.years_owned === 1 ? "" : "s"}`) },
  { id: "distress", label: "Distress", desc: "On the tax-lien sale list — financial pressure",
    sub: (r) => (r.tax_lien ? 100 : 0), note: (r) => (r.tax_lien ? "tax lien on record" : "no tax lien") },
  { id: "absentee", label: "Absentee owner", desc: "Mails out of NYC / out of state — less attached",
    sub: (r) => absSub(r.absentee), note: (r) => (r.absentee ? r.absentee.replace(/-/g, " ") + " owner" : "mails within NYC") },
  { id: "air_rights", label: "Air rights", desc: "Unused buildable SF — sell-to-developer angle",
    sub: (r) => airSub(r.buildable_sqft), note: (r) => { const n = Number(r.buildable_sqft) || 0; return n >= 2500 ? `~${n.toLocaleString()} SF unused` : "fully built"; } },
];

function radarGrade(r, cfg) {
  const w = (cfg && cfg.weights) || {};
  let num = 0, wsum = 0;
  const parts = RADAR_SIGNALS.map((s) => {
    const sub = Math.max(0, Math.min(100, Math.round(s.sub(r))));
    const weight = Number(w[s.id]) || 0;
    if (weight > 0) { num += sub * weight; wsum += weight; }
    return { id: s.id, label: s.label, desc: s.desc, note: s.note(r), sub, weight };
  });
  const overall = wsum > 0 ? Math.round(num / wsum) : 0;
  const t = (cfg && cfg.thresholds) || { target: 65, watch: 40 };
  const rec = overall >= t.target ? "Target" : overall >= t.watch ? "Watch" : "Pass";
  return { overall, rec, parts };
}
const radarRecColor = (rec) => (rec === "Target" ? C.green : rec === "Watch" ? C.amber : C.muted);

// ── Opportunity Score ────────────────────────────────────────────────────────
// A lease-independent version of the radar grade for the live Sourcing table: one
// 0–100 "how worth pursuing is this owner" read on EVERY result, in every market.
// A signal only counts when the market actually carries the data (so CT/TN/Hamptons,
// which have no tax-lien / air-rights feeds, aren't penalised for missing them).
const OPP_SIGNALS = [
  { id: "long_hold", label: "Long hold", weight: 35,
    applies: (r) => r.raw && r.raw.years_owned != null,
    sub: (r) => holdSub(r.raw.years_owned),
    note: (r) => `held ${r.raw.years_owned} yr${r.raw.years_owned === 1 ? "" : "s"}` },
  { id: "absentee", label: "Absentee owner", weight: 25,
    applies: () => true,
    sub: (r) => absSub(r.absentee),
    note: (r) => (r.absentee ? r.absentee.replace(/-/g, " ") + " owner" : "local owner") },
  { id: "distress", label: "Distress", weight: 25,
    // NYC: tax-lien sale list. Nashville: open Property-Standards code violations (parcel-exact).
    applies: (r) => r.market === "nyc" || (r.market === "tn" && r.raw && r.raw.open_violations != null),
    sub: (r) => {
      if (r.market === "nyc") return r.raw && r.raw.tax_lien ? 100 : 0;
      const v = Number(r.raw && r.raw.open_violations) || 0; return v >= 3 ? 100 : v >= 1 ? 70 : 0;
    },
    note: (r) => {
      if (r.market === "nyc") return r.raw && r.raw.tax_lien ? "tax lien on record" : "no tax lien";
      const v = Number(r.raw && r.raw.open_violations) || 0; return v > 0 ? `${v} open code violation${v === 1 ? "" : "s"}` : "no open violations";
    } },
  { id: "air_rights", label: "Air rights", weight: 15,
    applies: (r) => r.market === "nyc",
    sub: (r) => airSub(r.raw && r.raw.buildable_sqft),
    note: (r) => { const n = Number(r.raw && r.raw.buildable_sqft) || 0; return n >= 2500 ? `~${n.toLocaleString()} SF unused` : "fully built"; } },
  // Redevelopment: where the assessor splits land vs building value (TN/CT), a high LAND share
  // means the building contributes little — a value-add / teardown / reposition candidate. The
  // out-of-NYC analog of air rights. Only counts where that split exists, so it enriches those
  // grades without affecting NYC (whose leads carry no land/building split).
  { id: "redevelopment", label: "Redevelopment", weight: 15,
    applies: (r) => r.raw && Number(r.raw.land_value) > 0 && Number(r.raw.improvement_value) >= 0 && (Number(r.raw.land_value) + Number(r.raw.improvement_value)) > 0,
    sub: (r) => { const land = Number(r.raw.land_value) || 0, impr = Number(r.raw.improvement_value) || 0; const share = land / (land + impr); return share >= 0.75 ? 100 : share >= 0.6 ? 70 : share >= 0.45 ? 40 : share >= 0.35 ? 20 : 0; },
    note: (r) => { const land = Number(r.raw.land_value) || 0, impr = Number(r.raw.improvement_value) || 0; const tot = land + impr; return tot > 0 ? `land ${Math.round((100 * land) / tot)}% of value` : "—"; } },
];
function opportunityScore(r) {
  if (!r || !r.raw || r.market === "web") return null;
  let num = 0, wsum = 0; const parts = [];
  for (const s of OPP_SIGNALS) {
    if (!s.applies(r)) continue;
    const sub = Math.max(0, Math.min(100, Math.round(s.sub(r))));
    num += sub * s.weight; wsum += s.weight;
    parts.push({ id: s.id, label: s.label, sub, weight: s.weight, note: s.note(r) });
  }
  if (!wsum) return null;
  const overall = Math.round(num / wsum);
  const rec = overall >= 65 ? "Target" : overall >= 40 ? "Watch" : "Pass";
  return { overall, rec, parts };
}
function OppBreakdown({ g }) {
  const col = radarRecColor(g.rec);
  const totalW = g.parts.reduce((a, p) => a + p.weight, 0) || 1;
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 13px", marginBottom: 12 }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: "0.04em", color: C.muted, marginBottom: 8 }}>
        OPPORTUNITY SCORE — <span style={{ color: col }}>{g.rec.toUpperCase()} · {g.overall}/100</span>
        <span style={{ color: C.muted }}> · prospecting priority, verify before outreach</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {g.parts.map((p) => {
          const wpct = Math.round((p.weight / totalW) * 100);
          return (
            <div key={p.id}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, alignItems: "baseline", gap: 8 }}>
                <span style={{ color: C.ivory }}>{p.label} <span style={{ color: C.muted }}>· {p.note}</span></span>
                <span className="mono" style={{ color: C.muted, whiteSpace: "nowrap" }}>{p.sub}<span style={{ color: C.line }}>/100</span> × {wpct}%</span>
              </div>
              <div style={{ width: "100%", height: 4, background: C.ink, borderRadius: 3, overflow: "hidden", marginTop: 3 }}>
                <div className="bar" style={{ width: `${p.sub}%`, height: "100%", background: C.gold }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function loadRadarPresets() {
  try { const p = JSON.parse(localStorage.getItem(RADAR_PRESETS_KEY)); if (p && typeof p === "object" && Object.keys(p).length) return p; } catch {}
  return { [RADAR_DEFAULT_CONFIG.name]: clone(RADAR_DEFAULT_CONFIG) };
}
function loadRadarActive() {
  try { const a = JSON.parse(localStorage.getItem(RADAR_ACTIVE_KEY)); if (a && a.weights) return a; } catch {}
  return clone(RADAR_DEFAULT_CONFIG);
}

function GradeCell({ g }) {
  const col = radarRecColor(g.rec);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="mono" style={{ fontSize: 10, padding: "3px 7px", borderRadius: 5, border: `1px solid ${col}`, color: col, whiteSpace: "nowrap", letterSpacing: "0.04em" }}>{g.rec.toUpperCase()}</span>
      <div style={{ width: 38, height: 6, background: C.panel2, borderRadius: 3, overflow: "hidden" }}>
        <div className="bar" style={{ width: `${g.overall}%`, height: "100%", background: col }} />
      </div>
      <span className="mono" style={{ fontSize: 11, color: col }}>{g.overall}</span>
    </div>
  );
}
function GradeBreakdown({ g, cfg }) {
  const col = radarRecColor(g.rec);
  const totalW = g.parts.reduce((a, p) => a + p.weight, 0) || 1;
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
      <div className="mono" style={{ fontSize: 11, letterSpacing: "0.04em", color: C.muted, marginBottom: 10 }}>
        TARGET GRADE — <span style={{ color: col }}>{g.rec.toUpperCase()} · {g.overall}/100</span>
        <span> · mandate “{cfg.name}”</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {g.parts.map((p) => {
          const wpct = Math.round((p.weight / totalW) * 100);
          const on = p.weight > 0;
          return (
            <div key={p.id} style={{ opacity: on ? 1 : 0.4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, alignItems: "baseline", gap: 8 }}>
                <span style={{ color: C.ivory }}>{p.label} <span style={{ color: C.muted }}>· {p.note}</span></span>
                <span className="mono" style={{ color: C.muted, whiteSpace: "nowrap" }}>{p.sub}<span style={{ color: C.line }}>/100</span> × {wpct}%</span>
              </div>
              <div style={{ width: "100%", height: 5, background: C.ink, borderRadius: 3, overflow: "hidden", marginTop: 3 }}>
                <div className="bar" style={{ width: `${p.sub}%`, height: "100%", background: on ? C.gold : C.line }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 9, lineHeight: 1.5 }}>
        Weighted blend of public signals — a prospecting priority, <em>not</em> a literal probability the owner will sell. Tune the mix in ⚙ Target criteria; verify via ▸ details below.
      </div>
    </div>
  );
}

// The Lease Radar mandate editor — the workflow analog of the Screener's "Grading
// criteria" panel: weight each signal, set Target/Watch thresholds, save named mandates.
function RadarSettings({ cfg, setCfg, presets, setPresets, onClose }) {
  const totalW = RADAR_SIGNALS.reduce((a, s) => a + (Number(cfg.weights[s.id]) || 0), 0) || 1;
  const setWeight = (id, v) => setCfg((p) => ({ ...p, weights: { ...p.weights, [id]: v } }));
  const setThreshold = (k, v) => setCfg((p) => ({ ...p, thresholds: { ...p.thresholds, [k]: v } }));
  const loadPreset = (name) => { if (presets[name]) setCfg(clone(presets[name])); };
  const savePreset = () => { const name = (cfg.name || "Untitled").trim() || "Untitled"; setPresets({ ...presets, [name]: clone({ ...cfg, name }) }); };
  const deletePreset = () => {
    const name = cfg.name; if (!presets[name]) return;
    const next = { ...presets }; delete next[name];
    if (!Object.keys(next).length) next[RADAR_DEFAULT_CONFIG.name] = clone(RADAR_DEFAULT_CONFIG);
    setPresets(next); loadPreset(Object.keys(next)[0]);
  };
  const label = { fontSize: 11, color: C.muted, letterSpacing: "0.05em" };
  const field = { background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 7, padding: "8px 10px", fontSize: 13, fontFamily: "Archivo, sans-serif" };
  return (
    <div className="fade" style={{ marginTop: 18, background: C.panel, border: `1px solid ${C.gold}55`, borderRadius: 12, padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="serif" style={{ fontSize: 18 }}>Target criteria</div>
        <button onClick={onClose} className="mono" style={{ cursor: "pointer", fontSize: 12, color: C.muted, background: "transparent", border: "none" }}>✕ CLOSE</button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <div>
          <div className="mono" style={label}>SAVED MANDATE</div>
          <select value={presets[cfg.name] ? cfg.name : ""} onChange={(e) => loadPreset(e.target.value)} style={{ ...field, marginTop: 4, minWidth: 160 }}>
            {!presets[cfg.name] && <option value="">{cfg.name} (unsaved)</option>}
            {Object.keys(presets).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <div className="mono" style={label}>NAME</div>
          <input value={cfg.name} onChange={(e) => setCfg((p) => ({ ...p, name: e.target.value }))} style={{ ...field, marginTop: 4, width: 160 }} />
        </div>
        <button onClick={savePreset} className="mono lift" style={{ cursor: "pointer", fontSize: 12, padding: "8px 14px", borderRadius: 7, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold }}>↓ SAVE</button>
        <button onClick={deletePreset} className="mono lift" style={{ cursor: "pointer", fontSize: 12, padding: "8px 14px", borderRadius: 7, border: `1px solid ${C.line}`, background: "transparent", color: C.muted }}>DELETE</button>
      </div>

      <div className="mono" style={{ ...label, marginBottom: 8 }}>SIGNAL WEIGHTS — WHAT MAKES A TARGET</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {RADAR_SIGNALS.map((s) => {
          const w = Number(cfg.weights[s.id]) || 0;
          const pct = Math.round((w / totalW) * 100);
          return (
            <div key={s.id} style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{s.label}</span>
                <span className="mono" style={{ fontSize: 12, color: C.gold }}>{pct}%</span>
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{s.desc}</div>
              <input type="range" min="0" max="40" step="1" value={w} onChange={(e) => setWeight(s.id, Number(e.target.value))} style={{ width: "100%", marginTop: 9 }} />
            </div>
          );
        })}
      </div>

      <div className="mono" style={{ ...label, margin: "20px 0 8px" }}>RECOMMENDATION THRESHOLDS</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 }}>
        <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span>Target at or above</span><span className="mono" style={{ color: C.green }}>{cfg.thresholds.target}</span>
          </div>
          <input type="range" min="0" max="100" step="1" value={cfg.thresholds.target} onChange={(e) => setThreshold("target", Number(e.target.value))} style={{ width: "100%", marginTop: 8 }} />
        </div>
        <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span>Watch at or above</span><span className="mono" style={{ color: C.amber }}>{cfg.thresholds.watch}</span>
          </div>
          <input type="range" min="0" max="100" step="1" value={cfg.thresholds.watch} onChange={(e) => setThreshold("watch", Number(e.target.value))} style={{ width: "100%", marginTop: 8 }} />
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
        Weights and thresholds re-grade the current results instantly. Save a mandate to reuse it across scans.
      </div>
    </div>
  );
}
function ScoreBar({ score }) {
  const col = score >= 60 ? C.green : score >= 35 ? C.amber : C.muted;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 46, height: 6, background: C.panel2, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${score}%`, height: "100%", background: col }} />
      </div>
      <span className="mono" style={{ fontSize: 11, color: col }}>{score}</span>
    </div>
  );
}
const RADAR_COLS = [
  ["Rank", (r, i) => i + 1], ["Status", (r) => r.lease.status], ["Off-market", (r) => (r.lease.off_market_opportunity ? "YES" : "")],
  ["Address", (r) => r.address], ["Borough", (r) => r.borough], ["Tenant", (r) => r.lease.tenant || ""],
  ["Owner", (r) => r.name || ""], ["Latest lease", (r) => r.lease.latest_lease_date || ""],
  ["Est. expiration", (r) => r.lease.estimated_expiration || ""], ["Months to expiry", (r) => r.lease.months_to_expiry ?? ""],
  ["Term yrs", (r) => r.lease.term_years], ["Leases on file", (r) => r.lease.lease_count], ["Lease timing score", (r) => r.lease.score],
  ["Target score", (r) => r.grade?.overall ?? ""], ["Recommendation", (r) => r.grade?.rec ?? ""],
  ["Years owned", (r) => r.years_owned ?? ""], ["Tax lien", (r) => (r.tax_lien ? "YES" : "")],
  ["Absentee", (r) => r.absentee || ""], ["Unused buildable SF", (r) => r.buildable_sqft ?? ""],
];
function radarCSV(rows) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const head = RADAR_COLS.map((c) => esc(c[0])).join(",");
  const body = rows.map((r, i) => RADAR_COLS.map((c) => esc(c[1](r, i))).join(",")).join("\n");
  return head + "\n" + body;
}

function RadarRow({ r, rank, pw, cfg, last }) {
  const [open, setOpen] = useState(false);
  const L = r.lease;
  const badge = radarBadge(L);
  const off = L.off_market_opportunity;
  const td = { padding: "11px 14px", borderBottom: last && !open ? "none" : `1px solid ${C.line}`, verticalAlign: "top" };
  return (
    <>
      <tr style={{ background: off ? C.goldSoft : "transparent" }}>
        <td className="mono" style={{ ...td, color: C.muted }}>{rank}</td>
        <td style={td}>{r.grade ? <GradeCell g={r.grade} /> : <span style={{ color: C.muted }}>—</span>}</td>
        <td style={td}>
          {badge && (
            <span className="mono" style={{ fontSize: 10, padding: "3px 7px", borderRadius: 5, border: `1px solid ${badge.border}`, background: badge.bg, color: badge.fg, whiteSpace: "nowrap" }}>
              {badge.text}
            </span>
          )}
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>{mteText(L)}</div>
        </td>
        <td style={td}>
          <a href={mapUrl(r)} target="_blank" rel="noreferrer" style={{ color: C.ivory, textDecoration: "none", fontWeight: 600 }}>{r.address || "—"}</a>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{r.borough}</div>
        </td>
        <td style={td}>
          <div style={{ fontSize: 13 }}>{L.estimated_expiration ? monthYear(L.estimated_expiration) : "—"}</div>
          {L.latest_lease_date && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
              leased {monthYear(L.latest_lease_date)} · {L.term_years}yr term{L.lease_count > 1 ? ` · ${L.lease_count} on file` : ""}
            </div>
          )}
        </td>
        <td style={{ ...td, fontSize: 12.5 }}>{L.tenant || <span style={{ color: C.muted }}>—</span>}</td>
        <td style={{ ...td, fontSize: 12.5 }}>{r.name || <span style={{ color: C.muted }}>—</span>}</td>
        <td style={td}><ScoreBar score={L.score} /></td>
        <td style={{ ...td, textAlign: "right" }}>
          <button onClick={() => setOpen((o) => !o)} className="mono" style={{ ...ACTION_PILL, border: `1px solid ${open ? C.gold : C.line}` }}>
            {open ? "▾ close" : "▸ details"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} style={{ padding: "0 14px 18px", borderBottom: last ? "none" : `1px solid ${C.line}`, background: off ? C.goldSoft : "transparent" }}>
            {r.grade && <GradeBreakdown g={r.grade} cfg={cfg} />}
            <PropertyDetail r={r} pw={pw} />
          </td>
        </tr>
      )}
    </>
  );
}

function LeaseRadar({ pw }) {
  const [nearAddress, setNearAddress] = useState("");
  const [pickedCoords, setPickedCoords] = useState(null);
  const [radiusMiles, setRadiusMiles] = useState("0.25");
  const [assetType, setAssetType] = useState("retail");
  const [term, setTerm] = useState(10);
  const [horizon, setHorizon] = useState(24);
  const [offOnly, setOffOnly] = useState(false);
  const [sortBy, setSortBy] = useState("grade"); // "grade" (target priority) | "lease" (timing)

  // Mandate (signal weights + thresholds), saved like the Screener's grading config.
  const [cfg, setCfgState] = useState(loadRadarActive);
  const [presets, setPresetsState] = useState(loadRadarPresets);
  const [showCriteria, setShowCriteria] = useState(false);
  function setCfg(updater) {
    setCfgState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem(RADAR_ACTIVE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }
  function setPresets(next) {
    setPresetsState(next);
    try { localStorage.setItem(RADAR_PRESETS_KEY, JSON.stringify(next)); } catch {}
  }

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);

  async function run() {
    setError(""); setRows(null); setMeta(null);
    if (!pickedCoords) { setError("Type an address and pick it from the dropdown to anchor the scan."); return; }
    setLoading(true);
    try {
      setProgress("Finding properties in the radius (PLUTO)…");
      const src = await postJSON("/api/search", {
        password: pw, market: "nyc", sources: ["pluto"], assetType, radiusMiles,
        centerLat: pickedCoords.lat, centerLon: pickedCoords.lon, pickedBbl: pickedCoords.bbl,
      });
      const leads = src.leads || [];
      if (!leads.length) { setRows([]); setMeta({ center: src.center }); return; }

      setProgress(`Reading recorded leases for ${Math.min(leads.length, 60)} properties (ACRIS)…`);
      const properties = leads.slice(0, 60).map((r) => ({ borough: r.borough, block: r.block, lot: r.lot, address: r.address }));
      const scan = await postJSON("/api/leasescan", { password: pw, properties, termYears: term, horizonMonths: horizon });

      const map = {};
      for (const x of scan.results || []) map[x.key] = x;
      const merged = leads
        .map((r) => ({ ...r, lease: map[`${radarNorm(r.borough)}|${radarNorm(r.block)}|${radarNorm(r.lot)}`] || null }))
        .filter((r) => r.lease);
      setRows(merged);
      setMeta({ center: src.center, termYears: scan.termYears, horizonMonths: scan.horizonMonths, scanned: merged.length });
    } catch (e) {
      setError(e.message || "Lease scan failed.");
    } finally {
      setLoading(false); setProgress("");
    }
  }

  // Grade against the current mandate. Recomputed whenever weights/thresholds change,
  // so tuning the criteria re-grades the results instantly (no re-scan) — like the Screener.
  const graded = useMemo(() => (rows ? rows.map((r) => ({ ...r, grade: radarGrade(r, cfg) })) : null), [rows, cfg]);
  const sortedRows = graded ? [...graded].sort((a, b) => (sortBy === "lease" ? b.lease.score - a.lease.score : b.grade.overall - a.grade.overall)) : null;
  const shown = sortedRows ? (offOnly ? sortedRows.filter((r) => r.lease.off_market_opportunity) : sortedRows) : null;
  const offCount = graded ? graded.filter((r) => r.lease.off_market_opportunity).length : 0;
  const targetCount = graded ? graded.filter((r) => r.grade.rec === "Target").length : 0;

  function csvName() {
    const parts = ["frontage_lease_radar"];
    if (nearAddress) parts.push(nearAddress.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30));
    parts.push(new Date().toISOString().slice(0, 10));
    return parts.join("_") + ".csv";
  }

  return (
    <div style={{ marginTop: 22 }}>
      {showCriteria && (
        <RadarSettings cfg={cfg} setCfg={setCfg} presets={presets} setPresets={setPresets} onClose={() => setShowCriteria(false)} />
      )}
      <div style={{ marginTop: showCriteria ? 14 : 0, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10, flexWrap: "wrap" }}>
          <div className="mono" style={{ fontSize: 11, color: C.muted, letterSpacing: "0.05em" }}>STEP 1 · WHERE TO SCAN</div>
          <button onClick={() => setShowCriteria((s) => !s)} className="mono lift"
            style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, border: `1px solid ${showCriteria ? C.gold : C.line}`, background: showCriteria ? C.goldSoft : "transparent", color: showCriteria ? C.gold : C.ivory }}>
            ⚙ TARGET CRITERIA · {cfg.name}
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          <label style={{ gridColumn: "span 2" }}>
            <div className="mono" style={labelStyle}>ANCHOR ADDRESS — type &amp; pick</div>
            <div style={{ marginTop: 4 }}>
              <AddressAutocomplete
                value={nearAddress}
                onChange={(t) => { setNearAddress(t); setPickedCoords(null); }}
                onPick={(label, lat, lon, bbl) => { setNearAddress(label); setPickedCoords({ lat, lon, bbl }); }}
                placeholder="e.g. 200 5th Ave…"
                style={{ ...fieldStyle, width: "100%" }}
              />
            </div>
          </label>
          <label>
            <div className="mono" style={labelStyle}>RADIUS</div>
            <select value={radiusMiles} onChange={(e) => setRadiusMiles(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
              {[["0.05", "0.05 mi · ~1 block"], ["0.1", "0.1 mi · ~2 blocks"], ["0.25", "0.25 mi"], ["0.5", "0.5 mi"], ["1", "1 mi"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>
            <div className="mono" style={labelStyle}>ASSET TYPE</div>
            <select value={assetType} onChange={(e) => setAssetType(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
              {ASSET_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>
            <div className="mono" style={labelStyle}>ASSUMED LEASE TERM</div>
            <select value={term} onChange={(e) => setTerm(Number(e.target.value))} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
              {[[5, "5 years"], [10, "10 years (typical retail)"], [15, "15 years"], [20, "20 years"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>
            <div className="mono" style={labelStyle}>“EXPIRING SOON” WINDOW</div>
            <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
              {[[12, "within 12 months"], [24, "within 24 months"], [36, "within 36 months"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 10, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          Pick an address to anchor the scan, then a radius. FRONTAGE pulls every property in the circle (nearest 60),
          reads each one’s recorded leases from ACRIS, then <strong style={{ color: C.ivory }}>grades</strong> each against your
          <strong style={{ color: C.gold }}> “{cfg.name}”</strong> mandate — blending lease timing with owner-motivation signals
          (long hold, distress, absentee, air rights). <strong style={{ color: C.green }}>Target</strong>-rated prospects float to the top.
          Tune the mix in <strong style={{ color: C.ivory }}>⚙ Target criteria</strong> above.
        </div>

        <button onClick={run} disabled={loading}
          style={{ marginTop: 14, width: "100%", cursor: loading ? "default" : "pointer", border: "none", borderRadius: 9, padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em", background: loading ? C.panel2 : C.gold, color: loading ? C.muted : "#ffffff" }}>
          {loading ? (progress || "Scanning…") : `Scan & grade against “${cfg.name}” →`}
        </button>
        {error && <div style={{ marginTop: 12, color: C.red, fontSize: 13 }}>{error}</div>}
      </div>

      {/* Honest data disclaimer — these are modeled estimates, not actual dates. */}
      <div style={{ marginTop: 14, background: "rgba(183,121,31,0.08)", border: `1px solid ${C.amber}`, borderRadius: 10, padding: "11px 14px", fontSize: 12, color: C.ivory, lineHeight: 1.55 }}>
        <strong style={{ color: C.amber }}>⚠ Estimates, not actual dates.</strong> NYC has no public dataset of lease expiration dates. These windows are
        modeled from the <em>latest recorded ACRIS lease</em> + your assumed term, so they’re a prospecting signal — verify each one
        (open ▸ details → AI research, on-market links, deed/lease history). Spaces with no recorded lease may be owner-occupied or vacant.
      </div>

      {shown && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "18px 0 12px", flexWrap: "wrap", gap: 10 }}>
            <div className="serif" style={{ fontSize: 17 }}>
              {rows.length} propert{rows.length === 1 ? "y" : "ies"} scanned
              {targetCount > 0 && <span style={{ color: C.green }}> · {targetCount} target{targetCount === 1 ? "" : "s"}</span>}
              {offCount > 0 && <span style={{ color: C.gold }}> · {offCount} off-market</span>}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 11, color: C.muted, letterSpacing: "0.04em" }}>SORT BY</span>
              <div style={{ display: "flex", border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
                {[["grade", "TARGET GRADE"], ["lease", "LEASE TIMING"]].map(([v, lab]) => (
                  <button key={v} onClick={() => setSortBy(v)} className="mono"
                    style={{ cursor: "pointer", fontSize: 11, padding: "9px 12px", border: "none", background: sortBy === v ? C.gold : "transparent", color: sortBy === v ? "#ffffff" : C.muted }}>
                    {lab}
                  </button>
                ))}
              </div>
              <button onClick={() => setOffOnly((v) => !v)} className="mono"
                style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 8, border: `1px solid ${offOnly ? C.gold : C.line}`, background: offOnly ? C.goldSoft : "transparent", color: offOnly ? C.gold : C.muted }}>
                {offOnly ? "✓ " : ""}OFF-MARKET ONLY
              </button>
              <button onClick={() => graded?.length && downloadBlob(radarCSV(graded), csvName(), "text/csv")} className="lift mono"
                style={{ cursor: "pointer", fontSize: 12, padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXPORT CSV</button>
            </div>
          </div>
          {meta?.center && (
            <div style={{ margin: "-4px 0 12px", fontSize: 12.5, color: C.muted }}>
              Within <strong style={{ color: C.gold }}>{meta.center.radiusMiles} mi</strong> of {meta.center.label} ·
              assumed {meta.termYears}yr term · “soon” = within {meta.horizonMonths} months. Graded against “{cfg.name}”, ranked by {sortBy === "lease" ? "lease timing (space coming available)" : "target grade (best prospects first)"}.
            </div>
          )}

          {shown.length > 0 ? (
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr className="mono" style={{ color: C.muted, fontSize: 11, letterSpacing: "0.04em" }}>
                    {["#", "Grade", "Status", "Address", "Est. expiration", "Tenant", "Owner", "Lease timing", ""].map((c, i) => (
                      <th key={i} style={{ textAlign: i === 8 ? "right" : "left", padding: "11px 14px", borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{c.toUpperCase()}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => (
                    <RadarRow key={`${r.borough}-${r.block}-${r.lot}-${i}`} r={r} rank={i + 1} pw={pw} cfg={cfg} last={i === shown.length - 1} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ color: C.muted, fontSize: 13 }}>
              {rows.length === 0
                ? "No properties matched in that radius. Try a wider radius or a different asset type."
                : "No off-market opportunities in this set — every scanned lot reads as a long lease or has no recorded lease. Toggle off the filter to see them all."}
            </div>
          )}
        </>
      )}

      {!shown && !loading && (
        <div style={{ marginTop: 22, color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
          <span className="serif" style={{ color: C.ivory, fontSize: 15 }}>How it works.</span> A three-step workflow, like the deal screener —
          but for off-market sourcing. <strong style={{ color: C.ivory }}>①</strong> Set your mandate in ⚙ Target criteria (weight the
          signals that make a prospect, set Target/Watch/Pass cutoffs — saved like a screener mandate). <strong style={{ color: C.ivory }}>②</strong> Anchor
          an address + radius and scan. <strong style={{ color: C.ivory }}>③</strong> FRONTAGE reads each property’s recorded leases, blends
          them with owner-motivation signals, and grades every lot <strong style={{ color: C.green }}>Target / Watch / Pass</strong> against your
          mandate. This is the wedge CoStar lacks: it shows what’s already listed; Lease Radar points you at who to call <em>before</em> it is.
        </div>
      )}
    </div>
  );
}

function LeadTable({ rows, statusEditor, pw, saved, onToggleSave }) {
  if (!rows.length) return null;
  const cols = ["Name", "Type", "Role", "Property", "Mailing address", "Borough", "Retail SF", "Assessed value", "Purchase price", "Source"];
  const colSpan = cols.length + (statusEditor ? 1 : 0);
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr className="mono" style={{ color: C.muted, fontSize: 11, letterSpacing: "0.04em" }}>
            {cols.map((c) => <th key={c} style={{ textAlign: "left", padding: "11px 14px", borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{c.toUpperCase()}</th>)}
            {statusEditor && <th style={{ textAlign: "left", padding: "11px 14px", borderBottom: `1px solid ${C.line}` }}>STATUS</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <LeadRow key={r.id ?? `${r.source}-${r.deal_id}-${i}`} r={r} last={i === rows.length - 1} statusEditor={statusEditor} pw={pw} colSpan={colSpan} saved={saved} onToggleSave={onToggleSave} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeadRow({ r, last, statusEditor, pw, colSpan, saved, onToggleSave }) {
  const [open, setOpen] = useState(false);
  const isSaved = saved && saved.has(r.deal_id);

  return (
    <>
      <tr style={{
        borderBottom: last && !open ? "none" : `1px solid ${C.line}`,
        // The property the user actually searched for is pinned to the top — give it a
        // clear highlight + left accent so it never blends in with the radius results.
        background: r.pinned ? C.goldSoft : undefined,
        boxShadow: r.pinned ? `inset 3px 0 0 ${C.gold}` : undefined,
      }}>
        <td style={{ padding: "10px 14px", fontWeight: 600, minWidth: 200 }}>
          {r.pinned && (
            <div className="mono" style={{ display: "inline-block", marginBottom: 5, fontSize: 9.5, padding: "2px 7px", borderRadius: 5, background: C.gold, color: C.ink, fontWeight: 700, whiteSpace: "nowrap" }}>★ THIS PROPERTY</div>
          )}
          {r.pinned && <br />}
          {onToggleSave && (
            <span onClick={() => onToggleSave(r.deal_id)} title={isSaved ? "Saved — click to remove" : "Save to your list"}
              style={{ cursor: "pointer", marginRight: 6, color: isSaved ? C.gold : C.muted, fontSize: 15, userSelect: "none" }}>{isSaved ? "★" : "☆"}</span>
          )}
          <span style={{ fontSize: 15, fontWeight: 700, color: C.ivory, letterSpacing: "0.01em" }}>{r.name || "—"}</span>
          {(r.tax_lien || r.portfolio_count > 1 || r.underbuilt) && (
            <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {r.tax_lien && <span className="mono" style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 5, background: "rgba(209,74,60,0.12)", color: C.red, whiteSpace: "nowrap" }}>⚑ TAX LIEN</span>}
              {r.underbuilt && <span className="mono" style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 5, background: "rgba(31,157,99,0.12)", color: C.green, whiteSpace: "nowrap" }} title={`Built ${r.built_far} of max ${r.max_far} FAR`}>▲ +{Number(r.buildable_sqft).toLocaleString()} SF</span>}
              {r.portfolio_count > 1 && <span className="mono" style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 5, background: C.goldSoft, color: C.gold, whiteSpace: "nowrap" }}>OWNS {r.portfolio_count}</span>}
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            <button onClick={() => setOpen((o) => !o)} className="mono lift" style={{ ...ACTION_PILL, padding: "4px 11px", background: open ? C.goldSoft : C.panel, border: `1px solid ${open ? C.gold : C.line}` }}>
              {open ? "▾ hide details" : "▸ details"}
            </button>
          </div>
        </td>
        <td style={{ padding: "10px 14px", color: C.muted }}>{r.entity_type}</td>
        <td style={{ padding: "10px 14px", color: C.muted }}>{r.role}</td>
        <td style={{ padding: "10px 14px" }}>
          {r.address
            ? <a href={mapUrl(r)} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{r.address} ↗</a>
            : "—"}
          {r.distance != null && <span className="mono" style={{ color: C.muted, fontSize: 11 }}> · {Number(r.distance).toFixed(2)} mi</span>}
        </td>
        <td style={{ padding: "10px 14px", color: C.muted }}>
          {mailing(r) || "—"}
          {r.absentee && <span className="mono" style={{ marginLeft: 6, fontSize: 9.5, padding: "1px 6px", borderRadius: 5, background: C.goldSoft, color: C.amber, whiteSpace: "nowrap" }}>{r.absentee === "out-of-state" ? "OUT-OF-STATE" : "OUT-OF-AREA"}</span>}
        </td>
        <td style={{ padding: "10px 14px", color: C.muted }}>{r.borough || "—"}</td>
        {/* Retail square footage (PLUTO retailarea); falls back to total building SF. */}
        <td className="mono" style={{ padding: "10px 14px", whiteSpace: "nowrap" }} title="Retail floor area (PLUTO). Shows total building SF when no retail area is recorded.">
          {r.retail_sqft ? <span>{Number(r.retail_sqft).toLocaleString()} SF</span>
            : r.bldg_sqft ? <span style={{ color: C.muted }}>{Number(r.bldg_sqft).toLocaleString()} SF <span style={{ fontSize: 10 }}>bldg</span></span>
            : <span style={{ color: C.muted }}>—</span>}
        </td>
        {/* Assessed value — the City tax assessment (PLUTO only). Not a sale price. */}
        <td className="mono" style={{ padding: "10px 14px", whiteSpace: "nowrap" }} title="City tax assessment (total assessed value)">
          {assessedValue(r) != null ? fmtAmount(assessedValue(r)) : "—"}
        </td>
        {/* Purchase price — what the owner actually paid, from the latest deed. */}
        <td className="mono" style={{ padding: "10px 14px", whiteSpace: "nowrap" }} title="Last recorded sale price (ACRIS deed)">
          {purchasePrice(r) != null && purchasePrice(r) !== "" ? fmtAmount(purchasePrice(r)) : "—"}
          {purchaseDate(r) && <span style={{ color: C.muted }}> · {purchaseDate(r)}</span>}
          {r.years_owned != null && <span style={{ color: r.years_owned >= 15 ? C.green : C.muted }}> · {r.years_owned}y owned</span>}
        </td>
        <td className="mono" style={{ padding: "10px 14px", color: C.muted }}>{r.source}</td>
        {statusEditor && <td style={{ padding: "10px 14px" }}>{statusEditor(r)}</td>}
      </tr>
      {open && (
        <tr style={{ borderBottom: last ? "none" : `1px solid ${C.line}` }}>
          <td colSpan={colSpan} style={{ background: C.ink, padding: "4px 18px 18px" }}>
            <PropertyDetail r={r} pw={pw} />
          </td>
        </tr>
      )}
    </>
  );
}

// A street-level photo of the property, keyed off the PLUTO lat/lon.
// STOREFRONT PHOTO — an actual Google Street View photo of the building front, auto-
// loaded for every candidate (the thing a list of owners can't show you). Fetches the
// server proxy (/api/streetview) as a blob so the Google key stays server-side. Rotate
// buttons re-frame the shot; a free keyless "open in Street View" link always works.
// Falls back to a street MAP (Esri, free, no key) when GOOGLE_MAPS_API_KEY isn't set or
// no pano exists at the location.
const STORE_PW = () => { try { return sessionStorage.getItem("lr_pw") || ""; } catch { return ""; } };
function StorefrontPhoto({ r, pw }) {
  const lat = r.lat ?? r.raw?.lat ?? null, lon = r.lon ?? r.raw?.lon ?? null;
  const address = r.address || "";
  const loc = address || (lat != null && lon != null ? `${lat},${lon}` : "");
  const [state, setState] = useState(loc ? "loading" : "none"); // loading | photo | nophoto | nokey | none
  const [imgUrl, setImgUrl] = useState("");
  const [date, setDate] = useState("");
  const [heading, setHeading] = useState(null); // null = Google auto-frames toward the address
  const password = pw || STORE_PW();

  useEffect(() => {
    if (!loc) return;
    let alive = true, objUrl = "";
    setState("loading");
    (async () => {
      try {
        const res = await fetch("/api/streetview", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password, address, lat, lon, heading, size: "640x360" }),
        });
        const ct = res.headers.get("content-type") || "";
        if (ct.startsWith("image/")) {
          const blob = await res.blob();
          objUrl = URL.createObjectURL(blob);
          if (!alive) { URL.revokeObjectURL(objUrl); return; }
          setDate(res.headers.get("X-Pano-Date") || "");
          setImgUrl(objUrl); setState("photo");
        } else {
          const j = await res.json().catch(() => ({}));
          if (!alive) return;
          setState(j.noKey ? "nokey" : "nophoto");
        }
      } catch { if (alive) setState("nophoto"); }
    })();
    return () => { alive = false; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [loc, heading]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === "none") return null;
  const pano = lat != null && lon != null ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;
  const sat = lat != null && lon != null ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}` : pano;
  const frame = { width: "100%", height: 200, objectFit: "cover", border: `1px solid ${C.line}`, borderRadius: 10, display: "block" };
  const rotate = (deg) => setHeading((h) => (((h == null ? 0 : h) + deg) % 360 + 360) % 360);

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ position: "relative" }}>
        {state === "loading" && <div style={{ ...frame, background: C.panel2, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 12 }}>Loading storefront photo…</div>}
        {state === "photo" && <img src={imgUrl} alt={`Storefront at ${address || "the property"}`} style={frame} />}
        {(state === "nophoto" || state === "nokey") && (() => {
          // Free keyless fallback: an Esri street MAP centered on the lot, pinned + labeled.
          if (lat == null || lon == null) return <div style={{ ...frame, background: C.panel2, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 12 }}>No storefront photo available</div>;
          const d = 0.0009, bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
          const streetmap = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=640,300&format=png&f=image`;
          return (
            // No API key needed: click through to Google's REAL storefront photo (opens in
            // a tab). The map shows the block; the overlay makes the one-click intent clear.
            <a href={pano} target="_blank" rel="noreferrer" title="Open the real storefront in Google Street View" style={{ display: "block", position: "relative" }}>
              <img src={streetmap} alt="Street map of the property location" loading="lazy" style={{ ...frame, filter: "brightness(0.7)" }} />
              <svg width="28" height="36" viewBox="0 0 28 36" aria-hidden="true" style={{ position: "absolute", left: "50%", top: "42%", transform: "translate(-50%,-100%)", pointerEvents: "none", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.5))" }}>
                <path d="M14 0C6.8 0 1 5.8 1 13c0 9.5 13 23 13 23s13-13.5 13-23C27 5.8 21.2 0 14 0z" fill={C.gold} stroke="#fff" strokeWidth="2" />
                <circle cx="14" cy="13" r="4.5" fill="#fff" />
              </svg>
              <div className="mono" style={{ position: "absolute", left: 0, right: 0, bottom: 0, textAlign: "center", background: "linear-gradient(transparent, rgba(0,0,0,0.7))", color: "#fff", fontSize: 12, padding: "22px 8px 10px" }}>
                📷 See the storefront in Google Street View ↗ <span style={{ color: C.muted, fontSize: 10 }}>(free, no key)</span>
              </div>
            </a>
          );
        })()}
        {state === "photo" && <div className="mono" style={{ position: "absolute", left: 8, top: 8, background: "rgba(27,25,48,0.82)", color: "#fff", fontSize: 9.5, letterSpacing: "0.04em", padding: "3px 7px", borderRadius: 5, maxWidth: "85%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📷 STOREFRONT{r.address ? ` · ${r.address}` : ""}{date ? ` · ${date}` : ""}</div>}
        {state === "photo" && (
          <div style={{ position: "absolute", right: 8, bottom: 8, display: "flex", gap: 5 }}>
            <button onClick={() => rotate(-45)} title="Look left" className="mono lift" style={{ ...ACTION_PILL, padding: "3px 9px", background: "rgba(27,25,48,0.85)", border: `1px solid ${C.line}`, color: "#fff" }}>‹</button>
            <button onClick={() => rotate(45)} title="Look right" className="mono lift" style={{ ...ACTION_PILL, padding: "3px 9px", background: "rgba(27,25,48,0.85)", border: `1px solid ${C.line}`, color: "#fff" }}>›</button>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 5, alignItems: "center", flexWrap: "wrap" }}>
        <a href={pano} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 10.5, color: C.gold, textDecoration: "none" }}>↗ open in Street View</a>
        <a href={sat} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 10.5, color: C.gold, textDecoration: "none" }}>↗ map / satellite</a>
        {state === "nokey" && <span style={{ fontSize: 10, color: C.muted }}>· to show the real storefront photo: set <span className="mono">GOOGLE_MAPS_API_KEY</span>, or <span className="mono">MAPILLARY_TOKEN</span> (free, no billing card) in Vercel</span>}
      </div>
    </div>
  );
}
// Back-compat alias — existing NYC detail calls <PropertyPhoto r={r} />.
const PropertyPhoto = StorefrontPhoto;

// Minimal markdown renderer for the research brief (bold, bullets, links).
function renderBriefLine(str, keyBase) {
  const out = [];
  const re = /(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0, m, k = 0;
  while ((m = re.exec(str))) {
    if (m.index > lastIndex) out.push(<span key={`${keyBase}-${k++}`}>{str.slice(lastIndex, m.index)}</span>);
    if (m[1]) out.push(<strong key={`${keyBase}-${k++}`} style={{ color: C.ivory }}>{m[1].slice(2, -2)}</strong>);
    else if (m[2]) { const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(m[2]); out.push(<a key={`${keyBase}-${k++}`} href={lm[2]} target="_blank" rel="noreferrer" style={{ color: C.gold }}>{lm[1]}</a>); }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < str.length) out.push(<span key={`${keyBase}-${k++}`}>{str.slice(lastIndex)}</span>);
  return out;
}
function ResearchBriefBody({ text }) {
  const lines = text.split("\n");
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.65 }}>
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
        const bulleted = /^\s*[-•]\s+/.test(line);
        const content = line.replace(/^\s*[-•]\s+/, "").replace(/^#+\s*/, "");
        return (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 3, color: C.muted }}>
            {bulleted && <span style={{ color: C.gold }}>•</span>}
            <span>{renderBriefLine(content, i)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ONE combined "who's behind this + who's around them" lookup (the merge of the old
// LLC-unmask and relatives finders). For an ENTITY owner it unmasks the LLC (registry:
// registered agent + principals + status) AND maps their business circle; for a PERSON
// owner it finds relatives + close associates. All via AI web research — the same public
// sources (SOS filings, deeds, news, obituaries, LinkedIn) — always LIVE web (never the
// silent knowledge downgrade). Metered + cached; a found name drops into the "trace a
// person" box below to get a number.
const REGISTRY_HINT = {
  sc: "the SC Secretary of State registry (businessfilings.sc.gov — captcha-gated, usually NOT reachable by search) and, crucially, the crawlable sites that MIRROR its filings and DO show the registered agent + address (often right in the search snippet): Bizapedia (bizapedia.com/sc), OpenCorporates (opencorporates.com/companies/us_sc), OpenGovUS, CorporationWiki, and Buzzfile — mine these before concluding the agent isn't public",
  tn: "the Tennessee Secretary of State registry (TNBear / tncab.tnsos.gov) and OpenCorporates",
  ct: "the Connecticut Business Registry (data.ct.gov — CT publicly discloses LLC principals) and OpenCorporates",
  savannah: "the Georgia Secretary of State corporations registry (ecorp.sos.ga.gov — lists the registered agent + officers) and OpenCorporates",
  nyc: "the New York State DOS business registry (note: NY hides LLC members, listing only the process-service contact) and OpenCorporates",
  ny: "the New York State DOS business registry (note: NY hides LLC members) and OpenCorporates",
};
const SOS_LINK = { sc: ["SC SOS entity search ↗", "https://businessfilings.sc.gov/BusinessFiling/Entity/Search"] };
function peopleQuery(r, market, isCo) {
  const owner = r.name || r.owner || "";
  const where = [r.address, r.city, r.borough, r.state].filter(Boolean).join(", ");
  const mail = r.contact_address ? `Owner mailing address: ${r.contact_address}${r.city ? ", " + r.city : ""}${r.state ? ", " + r.state : ""}.` : "";
  const registry = REGISTRY_HINT[market] || "the state Secretary of State / business registry and OpenCorporates";
  if (isCo) {
    return `For the real estate owner entity "${owner}" (owns property at ${where}), report BOTH who is behind it AND their business circle. ${mail}
Work public sources: ${registry}; property deeds and co-ownership records; court filings; business news/press; and LinkedIn. Provide:
1) UNMASK THE ENTITY — exact registered name, type, status (active/dissolved), filing date, the REGISTERED AGENT (name + full address — the key contact for an anonymous LLC), and the principal/mailing address.
2) THE PEOPLE — the principals / managers / members / organizers behind it (names + where they're based).
3) THE CIRCLE — known business ASSOCIATES, partners, or co-investors who appear alongside them on other entities, deeds, or filings.
For each person, give the best city/state to reach them so the user can skip-trace them. Cite each source. Clearly separate CONFIRMED record facts from likely-but-unconfirmed inferences. Do NOT invent names, numbers, or relationships — if the people behind the LLC aren't public, say so plainly and note the registry can be checked by hand.${TRACE_FOOTER}`;
  }
  return `Find the RELATIVES and close ASSOCIATES of "${owner}", the individual who owns property at ${where}. ${mail}
Work public sources: property deeds and co-ownership records (co-owners / spouses often appear on title), obituaries and public family notices, news, voter and public directories, business filings where they're a partner, and LinkedIn. Report a short list of:
- Likely FAMILY — spouse, adult children, siblings, parents (name + relationship).
- Close business ASSOCIATES or partners who appear alongside them on deeds, entities, or filings.
- For each: how they connect to the owner and the city/state they're likely reachable in, so the user can skip-trace that person to reach the owner.
Cite each source. Clearly separate CONFIRMED facts from likely-but-unconfirmed inferences, and mark uncertainty (name matches can be false positives). Do NOT invent people, phone numbers, or relationships — if nothing reliable is public, say so plainly.${TRACE_FOOTER}`;
}
// Split the TRACE LIST footer (see TRACE_FOOTER) off an unmask brief. Returns
// { display, people } — display is the brief without the footer; people are
// { name, street, city, state, zip }. Defensive: no footer (older cached answers,
// or a run that found nobody) → no chips, brief shown unchanged.
function parseTraceList(text) {
  const s = String(text || "");
  const m = s.match(/^\s*(?:#+\s*|\*\*)?TRACE LIST(?:\*\*)?\s*$/mi);
  if (!m) return { display: s, people: [] };
  const people = [];
  for (const line of s.slice(m.index + m[0].length).split("\n")) {
    const t = line.trim().replace(/^[-*•]\s*/, "");
    if (!t || !t.includes("|")) continue;
    const [name = "", street = "", city = "", st = "", zip = ""] = t.split("|").map((x) => x.trim().replace(/^`|`$/g, ""));
    if (name && !/^(full name|-+)$/i.test(name)) people.push({ name, street, city, state: st, zip });
  }
  return { display: s.slice(0, m.index).trim(), people };
}

// The bridge from an unmask result to the skip trace: every person the research
// actually named becomes a chip that seeds the trace form — LLC → principal → phone
// with no retyping. fallback city/state fill blanks (e.g. the property's market).
// FREE people-search deep links for a name (same numbers the paid providers sell,
// ad-supported + bot-gated — a human clicks through). Always shown, no cost.
function freePeopleLinks(name, city, st) {
  const q = encodeURIComponent(name);
  const loc = encodeURIComponent([city, st].filter(Boolean).join(", "));
  return [
    ["TruePeopleSearch", `https://www.truepeoplesearch.com/results?name=${q}&citystatezip=${loc}`],
    ["FastPeopleSearch", `https://www.fastpeoplesearch.com/name/${String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`],
    ["Google", `https://www.google.com/search?q=%22${q}%22+${loc}+phone+OR+contact`],
    ["LinkedIn", `https://www.linkedin.com/search/results/people/?keywords=${q}%20${encodeURIComponent(city)}`],
  ];
}

// Everyone the unmask found, with their FREE lookup links shown inline for each — no
// click needed to see the free paths. The paid auto-trace (~$0.10/hit) stays behind a
// per-person toggle so browsing never spends by accident.
function TracePeople({ people, pw, fallback = {} }) {
  const [sel, setSel] = useState(-1);
  if (!people || !people.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em", marginBottom: 6 }}>PEOPLE FOUND — free lookups shown, trace optional</div>
      {people.map((p, i) => {
        const city = p.city || fallback.city || "", st = p.state || fallback.state || "";
        const links = freePeopleLinks(p.name, city, st);
        return (
          <div key={`${p.name}-${i}`} style={{ background: C.panel2, border: `1px solid ${sel === i ? C.gold : C.line}`, borderRadius: 9, padding: "9px 12px", marginBottom: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
              <div style={{ fontSize: 12.5 }}><span style={{ color: C.ivory, fontWeight: 600 }}>{p.name}</span>{city ? <span style={{ color: C.muted }}> · {city}{st ? ", " + st : ""}</span> : ""}</div>
              <button onClick={() => setSel(sel === i ? -1 : i)} className="mono lift" style={{ ...ACTION_PILL, padding: "3px 10px", fontSize: 10.5, background: sel === i ? C.goldSoft : C.panel, border: `1px solid ${sel === i ? C.gold : C.line}`, color: sel === i ? C.gold : C.ivory }}>{sel === i ? "▾ close" : "▸ trace ~$0.10"}</button>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 5 }}><strong style={{ color: C.green }}>FREE:</strong> {links.map(([lab, url], j) => <span key={lab}>{j > 0 ? " · " : " "}<a href={url} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{lab} ↗</a></span>)}</div>
            {sel === i && (
              <div style={{ marginTop: 10, borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>Paid auto-trace — matches on the <strong style={{ color: C.ivory }}>person's own address</strong> (~$0.10, only charged on a hit). The free links above cost nothing.</div>
                <SkipTraceForm key={`${p.name}-${sel}`} pw={pw} seed={{ name: p.name, street: p.street, city, state: st, zip: p.zip }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OwnerPeople({ r, pw, market }) {
  const owner = r.name || r.owner || "";
  const isCo = ENTITY_RE.test(owner);
  const cached = getAiAnswer(r, "people");
  const [state, setState] = useState(cached ? "done" : "idle"); // idle | loading | done | error
  const [text, setText] = useState(cached ? cached.text : "");
  const [savedAt, setSavedAt] = useState(cached ? cached.savedAt : 0);
  const [err, setErr] = useState("");
  const link = isCo ? SOS_LINK[market] : null;
  const run = async (refine = false) => {
    setState("loading"); setErr("");
    try {
      // Always LIVE web — unmasking an LLC / finding people from public records is pointless
      // from model knowledge alone, so don't let the Quick toggle / cap silently downgrade it.
      const d = await postJSON("/api/research", { mode: "web", password: pw, query: peopleQuery(r, market, isCo), ...(refine && text ? { prior: text } : {}) });
      addScoutSpend(WEB_RUN_COST);
      const t = d.brief || "";
      setText(t); saveAiAnswer(r, "people", t, "web"); setSavedAt(Date.now()); setState("done");
    } catch (e) { setErr(e.message || "Lookup failed."); setState("error"); }
  };
  if (!owner) return null;
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>👥 {isCo ? "WHO’S BEHIND THIS LLC + THEIR CIRCLE" : "RELATIVES & ASSOCIATES"}</div>
        {state !== "loading" && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {state === "done" && savedAt > 0 && <span style={{ fontSize: 10, color: C.muted }}>saved · {savedAgo(savedAt)}</span>}
            {state === "done" && <button onClick={() => run(true)} title="Re-run, building on the saved answer" className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.line}` }}>↻ refine</button>}
            <button onClick={() => run(false)} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>{state === "done" || state === "error" ? "↻ re-run" : isCo ? "▸ unmask" : "▸ find"}</button>
          </div>
        )}
      </div>
      {state === "idle" && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 6 }}>{isCo
        ? <>Unmasks <strong style={{ color: C.ivory }}>{owner}</strong> — the registered agent + principals behind it — and maps their business associates, from public records. Drop any name into the <strong style={{ color: C.ivory }}>“trace a person”</strong> box below to get their number. <span>Live web search (~$0.30).</span></>
        : <>Finds likely <strong style={{ color: C.ivory }}>family and associates of {owner}</strong> — a way in when the owner’s own line is a dead end. Take any name into the <strong style={{ color: C.ivory }}>“trace a person”</strong> box below to skip-trace them. <span>Live web search (~$0.30).</span></>}</div>}
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>Searching public records…</div>}
      {state === "error" && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {state === "done" && (() => { const { display, people } = parseTraceList(text); return <div style={{ marginTop: 10 }}><ResearchBriefBody text={display} /><TracePeople people={people} pw={pw} fallback={{ city: r.city, state: r.state }} /><div style={{ fontSize: 10.5, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>Verify before relying on any name — public matches can be wrong. {people.length ? <>Click a <strong style={{ color: C.ivory }}>person chip above</strong> to trace them directly.</> : <>To reach one, use the <strong style={{ color: C.ivory }}>“trace a person”</strong> box below with their name + a likely address.</>}</div></div>; })()}
      {link && <div style={{ marginTop: 8, fontSize: 11 }}><a href={link[1]} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{link[0]}</a><span style={{ color: C.muted }}> — the official registry (captcha-gated; pull it by hand if the web lookup can’t reach it)</span></div>}
    </div>
  );
}

// Engine 2: on-demand AI web research. Costs an Anthropic call (with web search) only
// when the user clicks — never automatic.
function ResearchBrief({ r, pw, forceMode }) {
  const cached = getAiAnswer(r, "research");
  const [state, setState] = useState(cached ? "done" : "idle"); // idle | loading | done | error
  const [brief, setBrief] = useState(cached ? cached.text : "");
  const [savedAt, setSavedAt] = useState(cached ? cached.savedAt : 0);
  const [err, setErr] = useState("");
  const run = async (refine = false) => {
    setState("loading"); setErr("");
    try {
      // Requests live web mode; api/research transparently downgrades to knowledge until
      // the RESEARCH_LIVE_WEB env flag is set (needs Vercel Pro's 300s timeout). So this is
      // safe on Hobby today and auto-upgrades to real web research the moment Pro is on.
      const m = forceMode || webResearchMode();
      const d = await postJSON("/api/research", { mode: m, password: pw, name: r.name, entity_type: r.entity_type, address: r.address, borough: r.borough, contact_address: r.contact_address, city: r.city, state: r.state, last_sale_date: r.last_sale_date, last_sale_price: r.last_sale_price, years_owned: r.years_owned, ...(refine && brief ? { prior: brief } : {}) });
      if (m === "web") addScoutSpend(WEB_RUN_COST);
      const text = d.brief || "";
      setBrief(text); saveAiAnswer(r, "research", text, m); setSavedAt(Date.now()); setState("done");
    } catch (e) { setErr(e.message || "Research failed."); setState("error"); }
  };
  const isCo = isCompanyRow(r);
  return (
    <div style={{ background: C.panel2, border: `1px solid ${isCo ? C.gold : C.line}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>✦ AI QUICK TAKE — {isCo ? "who they are & how to reach them" : "what’s known about this owner"}{isCo && <span style={{ color: C.muted }}> · recommended</span>}</div>
        {state !== "loading" && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {state === "done" && savedAt > 0 && <span style={{ fontSize: 10, color: C.muted }}>saved · {savedAgo(savedAt)}</span>}
            {state === "done" && <button onClick={() => run(true)} title="Re-run, building on the saved take" className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.line}` }}>↻ refine</button>}
            <button onClick={() => run(false)} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>
              {state === "done" || state === "error" ? "↻ fresh" : "▸ run"}
            </button>
          </div>
        )}
      </div>
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>Compiling… (a few seconds)</div>}
      {state === "error" && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {state === "done" && <div style={{ marginTop: 10 }}><ResearchBriefBody text={brief} /></div>}
      {state === "idle" && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 6 }}>{isCo
        ? "Recommended for this owner — it reads as a company/firm, where skip tracing just returns the entity’s corporate web, not a person. The AI take recognizes named firms (REITs, big developers) and tells you who they are and how to reach their acquisitions team. For owners it doesn’t recognize, it says so rather than guess."
        : "Instant AI take from the model’s knowledge — best for recognizable owners (REITs, named developers). For obscure single-asset LLCs it will say there’s no public info rather than guess — use skip tracing there."}</div>}
    </div>
  );
}

// ── Browser-local AI answer cache ────────────────────────────────────────────
// Persists each property's AI answers (memo / outreach / research) in localStorage so
// re-opening the same property shows them instantly at $0 instead of re-running. Keyed
// by address+owner, one entry per property sub-keyed by answer kind — the SAME shape a
// shared team DB would use, so this migrates by swapping the storage backend, not the
// call sites. A "↻ refine" re-run feeds the saved answer back so knowledge compounds.
const AI_CACHE_KEY = "fr_ai_cache_v1";
const AI_CACHE_MAX = 300; // cap properties so localStorage (~5MB) can't overflow
function loadAiCache() { try { return JSON.parse(localStorage.getItem(AI_CACHE_KEY) || "{}") || {}; } catch { return {}; } }
function aiCacheId(r) {
  if (!r) return "";
  const addr = (r.address || "").toUpperCase().replace(/\s+/g, " ").trim();
  const owner = (r.owner || r.name || "").toUpperCase().replace(/\s+/g, " ").trim();
  return (addr || owner) ? `${addr}|${owner}` : "";
}
function getAiAnswer(r, kind) { const e = loadAiCache()[aiCacheId(r)]; return (e && e[kind]) || null; }
function saveAiAnswer(r, kind, text, mode) {
  const id = aiCacheId(r); if (!id || !text) return;
  try {
    const c = loadAiCache();
    c[id] = c[id] || {};
    c[id][kind] = { text, savedAt: Date.now(), mode: mode || "" };
    const ids = Object.keys(c);
    if (ids.length > AI_CACHE_MAX) {
      const newest = (e) => Math.max(0, ...Object.values(e).map((v) => v.savedAt || 0));
      ids.sort((a, b) => newest(c[a]) - newest(c[b]));
      for (const old of ids.slice(0, ids.length - AI_CACHE_MAX)) delete c[old];
    }
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(c));
  } catch { /* quota — drop silently */ }
}
function savedAgo(ts) {
  if (!ts) return "";
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Saved List / Pipeline (local-first, synced to the shared Postgres) ────────
// Same storage pattern as the AI answer cache: ONE localStorage object keyed by the
// property id (aiCacheId = ADDRESS|OWNER). localStorage stays the SYNCHRONOUS store
// the UI reads (instant stars, no loading states); /api/pipeline is the shared team
// copy. Every mutation also fires a background push, and opening the Pipeline tab
// pull-merges (last-write-wins by updatedAt, with server tombstones for removes).
// With no DATABASE_URL the endpoint answers dbConfigured:false and the list quietly
// stays device-local — the original behavior. Each lead stores the denormalized
// display fields + status + notes + the full normalized row (`row`) so the dossier
// can be re-rendered from the pipeline.
const PIPELINE_KEY = "fr_pipeline_v1";
const PIPELINE_MAX = 400; // cap so localStorage (~5MB) can't overflow; evict oldest
const PIPELINE_STATUSES = [["watching", "Watching"], ["contacted", "Contacted"], ["pursuing", "Pursuing"], ["passed", "Passed"]];
const statusLabel = (s) => (PIPELINE_STATUSES.find(([v]) => v === s) || [, "—"])[1];
const statusColor = (s) => (s === "pursuing" ? C.green : s === "contacted" ? C.gold : s === "passed" ? C.muted : C.ivory);
// Outreach = the CALL state, tracked separately from the deal status: a lead can be
// "Pursuing" while the last three dials went to voicemail. DNC is sticky and loud
// (red) so nobody on the shared list re-dials a do-not-call owner.
const OUTREACH_STATES = [["none", "Not called"], ["called", "Called"], ["voicemail", "Voicemail"], ["callback", "Callback set"], ["dnc", "DNC"]];
const outreachLabel = (s) => (OUTREACH_STATES.find(([v]) => v === s) || OUTREACH_STATES[0])[1];
const outreachColor = (s) => (s === "dnc" ? C.red : s === "callback" ? C.amber : s === "called" || s === "voicemail" ? C.gold : C.muted);
// Local date (en-CA = YYYY-MM-DD), not toISOString(): UTC flips to tomorrow at ~7-8pm ET,
// which flagged callbacks "DUE" the evening before.
const callbackDue = (l) => l.outreach === "callback" && l.callbackAt && l.callbackAt <= new Date().toLocaleDateString("en-CA");
function loadPipeline() { try { return JSON.parse(localStorage.getItem(PIPELINE_KEY) || "{}") || {}; } catch { return {}; } }
function writePipeline(p) { try { localStorage.setItem(PIPELINE_KEY, JSON.stringify(p)); } catch { /* quota — drop silently */ } }
function isSavedLead(r) { const id = aiCacheId(r); return !!(id && loadPipeline()[id]); }
function saveLead(r, opp) {
  const id = aiCacheId(r); if (!id) return;
  const p = loadPipeline();
  if (p[id]) return; // already saved
  p[id] = {
    id, market: r.market || "", marketLabel: r.marketLabel || "", owner: r.owner || "",
    address: r.address || "", mailing: r.mailing || "", use: r.use || "", value: r.value || "",
    absentee: r.absentee || null, mapsUrl: r.mapsUrl || "",
    opp: opp ? { overall: opp.overall, rec: opp.rec } : null,
    status: "watching", outreach: "none", callbackAt: "", outreachAt: null,
    notes: "", savedAt: Date.now(), updatedAt: Date.now(), row: r,
  };
  const ids = Object.keys(p);
  if (ids.length > PIPELINE_MAX) { ids.sort((a, b) => (p[a].savedAt || 0) - (p[b].savedAt || 0)); for (const old of ids.slice(0, ids.length - PIPELINE_MAX)) delete p[old]; }
  writePipeline(p);
  pipelinePush([p[id]]);
}
function unsaveLead(id) { const p = loadPipeline(); if (p[id]) { delete p[id]; writePipeline(p); pipelineRemove(id); } }
function updateLead(id, patch) { const p = loadPipeline(); if (p[id]) { p[id] = { ...p[id], ...patch, updatedAt: Date.now() }; writePipeline(p); pipelinePush([p[id]]); } }

// ── Shared-pipeline sync (Postgres via /api/pipeline) ─────────────────────────
// Pushes are fire-and-forget: the local copy is already right, and if the server
// is unreachable (offline, no DB) the next successful sync reconciles.
const pipelinePw = () => { try { return sessionStorage.getItem("lr_pw") || ""; } catch { return ""; } };
async function pipelinePush(leads) {
  try { await postJSON("/api/pipeline", { password: pipelinePw(), action: "upsert", leads }); } catch { /* stays local */ }
}
async function pipelineRemove(id) {
  try { await postJSON("/api/pipeline", { password: pipelinePw(), action: "remove", id }); } catch { /* stays local */ }
}
// Pull the shared list and merge into localStorage. Newer updatedAt wins; server
// tombstones delete local copies (unless the local one is newer — a re-save);
// anything the server is missing or has stale gets pushed back. Returns true when
// a shared DB is connected, false when the list is device-local.
async function syncPipeline() {
  const d = await postJSON("/api/pipeline", { password: pipelinePw(), action: "list" });
  if (!d || d.dbConfigured === false) return false;
  const merged = loadPipeline();
  const serverAt = {}; // id -> the server's updatedAt (live row or tombstone)
  for (const s of d.leads || []) {
    if (!s || !s.id) continue;
    serverAt[s.id] = s.updatedAt || 0;
    const mine = merged[s.id];
    if (!mine || (s.updatedAt || 0) >= (mine.updatedAt || 0)) merged[s.id] = s;
  }
  for (const t of d.deleted || []) {
    if (!t || !t.id) continue;
    serverAt[t.id] = Math.max(serverAt[t.id] || 0, t.updatedAt || 0);
    const mine = merged[t.id];
    if (mine && (t.updatedAt || 0) >= (mine.updatedAt || 0)) delete merged[t.id];
  }
  const toPush = Object.values(merged).filter((l) => (l.updatedAt || 0) > (serverAt[l.id] || 0) || !(l.id in serverAt));
  writePipeline(merged);
  if (toPush.length) pipelinePush(toPush); // background — the local list is already correct
  return true;
}

// Star toggle shown on each sourcing result — save/unsave the lead to the Pipeline.
function SaveLeadButton({ r, opp }) {
  const [saved, setSaved] = useState(() => isSavedLead(r));
  const toggle = (e) => {
    e.stopPropagation();
    if (saved) { unsaveLead(aiCacheId(r)); setSaved(false); }
    else { saveLead(r, opp); setSaved(true); }
  };
  return (
    <button onClick={toggle} title={saved ? "Saved to Pipeline — click to remove" : "Save to Pipeline"} className="mono lift"
      style={{ cursor: "pointer", fontSize: 12, padding: "4px 9px", borderRadius: 7, border: `1px solid ${saved ? C.gold : C.line}`, background: saved ? C.goldSoft : C.panel, color: saved ? C.gold : C.muted, whiteSpace: "nowrap" }}>
      {saved ? "★" : "☆"}
    </button>
  );
}

const PIPELINE_COLS = [["Status", (l) => statusLabel(l.status)], ["Outreach", (l) => outreachLabel(l.outreach || "none")], ["Callback", (l) => l.callbackAt || ""], ["Last outreach", (l) => (l.outreachAt ? new Date(l.outreachAt).toLocaleDateString() : "")], ["Opportunity", (l) => (l.opp ? l.opp.overall : "")], ["Grade", (l) => (l.opp ? l.opp.rec : "")], ["Market", (l) => l.marketLabel], ["Owner", (l) => l.owner], ["Address", (l) => l.address], ["Mailing", (l) => l.mailing], ["Use", (l) => l.use], ["Value", (l) => l.value], ["Absentee", (l) => l.absentee || ""], ["Notes", (l) => l.notes], ["Saved", (l) => new Date(l.savedAt).toLocaleDateString()]];
function pipelineCSV(leads) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  return PIPELINE_COLS.map((c) => esc(c[0])).join(",") + "\n" + leads.map((l) => PIPELINE_COLS.map((c) => esc(c[1](l))).join(",")).join("\n");
}

// ── Call prep sheets — one printable page per lead ────────────────────────────
// Everything a caller needs on one page, built ONLY from data already saved on the
// lead (no API calls, so a 30-sheet batch prints instantly): owner + mailing, the
// deal basis (last sale, tenure, SF, zoning), why it scored, saved notes, and a
// blank call log. Same plain no-logo document style as the comp one-pager.
function callSheetHTML(leads) {
  const esc = escHtml;
  const num = (v) => (v == null || v === "" ? null : Number(v).toLocaleString());
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const kv = (rows) => rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><strong>${esc(String(v))}</strong></div>`).join("");
  const sheets = leads.map((l) => {
    const r = l.row || {}; const raw = r.raw || {};
    const opp = (r.market && r.market !== "web") ? opportunityScore(r) : null;
    const salePrice = raw.last_sale_price || raw.sale_price;
    const saleYear = String(raw.last_sale_date || raw.sale_date || raw.sale_year || "").slice(0, 4);
    const owner = kv([
      ["Owner of record", l.owner || raw.deed_owner],
      ["Deed owner (if newer)", raw.deed_owner && raw.deed_owner !== l.owner ? raw.deed_owner : null],
      ["Mailing address", l.mailing],
      ["Owner location", l.absentee ? (l.absentee === "out-of-state" ? "OUT-OF-STATE (absentee)" : "OUT-OF-AREA (absentee)") : "Local"],
      ["Outreach status", `${outreachLabel(l.outreach || "none")}${l.callbackAt ? ` — callback ${l.callbackAt}` : ""}${l.outreachAt ? ` (last: ${new Date(l.outreachAt).toLocaleDateString()})` : ""}`],
    ]);
    const property = kv([
      ["Use", l.use || raw.use],
      ["Value", l.value],
      ["Building SF", num(raw.bldg_sqft || raw.building_sqft)],
      ["Retail SF", num(raw.retail_sqft)],
      ["Frontage", raw.frontage_ft ? `${raw.frontage_ft} ft` : null],
      ["Floors", raw.num_floors || raw.stories],
      ["Year built", raw.year_built || raw.ayb],
      ["Zoning", raw.zoning || raw.zone || raw.zone_description],
      ["Lot", raw.lot_sqft ? `${num(raw.lot_sqft)} SF` : (raw.acres || raw.land_acres ? `${raw.acres || raw.land_acres} acres` : null)],
    ]);
    const basis = kv([
      ["Last recorded sale", salePrice ? `${fmtAmount(salePrice)}${saleYear ? ` · ${saleYear}` : ""}` : (saleYear ? `recorded ${saleYear} (no separable price)` : null)],
      ["Portfolio deed", raw.portfolio_sale ? `Yes — bulk transfer of ${raw.last_deed_lots || "multiple"} lots${raw.portfolio_total_price ? ` for ${fmtAmount(raw.portfolio_total_price)} total` : ""}` : null],
      ["Years owned", raw.years_owned != null ? `~${raw.years_owned}` : null],
      ["Tax lien", raw.tax_lien ? "ON THE LIEN SALE LIST" : null],
      ["Open code violations", raw.open_violations || null],
      ["Unused air rights", raw.buildable_sqft && Number(raw.buildable_sqft) >= 2500 ? `~${num(raw.buildable_sqft)} SF buildable` : null],
    ]);
    const why = opp ? `<div class="sec">WHY THIS LEAD — ${esc(opp.rec.toUpperCase())} · ${opp.overall}/100</div><ul>${opp.parts.map((p) => `<li>${esc(p.label)}: ${esc(p.note)} — ${p.sub}/100</li>`).join("")}</ul>` : "";
    const notes = l.notes ? `<div class="sec">NOTES</div><p class="notes">${esc(l.notes)}</p>` : "";
    return `<div class="sheet">
  <div class="tag">CALL PREP SHEET · ${esc(l.marketLabel || "")} · ${esc(today)}</div>
  <h1>${esc(l.address || "—")}</h1>
  <div class="ownerline">${esc(l.owner || "Owner unknown")}</div>
  <div class="cols">
    <div><div class="sec">OWNER &amp; REACH</div>${owner}
      <div class="kv"><span>Phone</span><strong class="blank"></strong></div>
      <div class="kv"><span>Email</span><strong class="blank"></strong></div>
    </div>
    <div><div class="sec">PROPERTY</div>${property}<div class="sec">DEAL BASIS</div>${basis}</div>
  </div>
  ${why}${notes}
  <div class="sec">CALL LOG</div>
  ${[1, 2, 3, 4].map(() => `<div class="logline"><span>Date</span><span>Outcome</span><span>Next step</span></div>`).join("")}
  <div class="foot">FRONTAGE · verify current ownership (recent deed) before dialing · prospecting signals, not proven seller intent</div>
</div>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Call prep sheets</title>
<style>
  *{box-sizing:border-box;} body{margin:0;background:#f3f3f3;color:#1a1a1a;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .bar{text-align:center;padding:10px 0;} .bar button{font-size:13px;cursor:pointer;padding:8px 18px;border:1px solid #888;background:#fff;color:#1a1a1a;border-radius:4px;}
  .sheet{max-width:760px;margin:20px auto;background:#fff;border:1px solid #ddd;padding:34px 40px;page-break-after:always;}
  .tag{font-size:10px;letter-spacing:0.12em;color:#888;}
  h1{font-size:19px;margin:6px 0 2px;} .ownerline{font-size:13px;color:#444;margin-bottom:14px;}
  .sec{font-size:10.5px;letter-spacing:0.1em;color:#666;border-bottom:1px solid #1a1a1a;padding-bottom:3px;margin:14px 0 7px;}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:0 28px;align-items:start;}
  .kv{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:2.5px 0;border-bottom:1px dotted #e2e2e2;}
  .kv span{color:#777;white-space:nowrap;} .kv strong{font-weight:600;text-align:right;}
  .kv .blank{min-width:150px;border-bottom:1px solid #999;}
  ul{margin:4px 0;padding-left:18px;} li{font-size:12.5px;line-height:1.55;margin:2px 0;}
  .notes{font-size:12.5px;line-height:1.6;white-space:pre-wrap;margin:4px 0;}
  .logline{display:grid;grid-template-columns:90px 1fr 1fr;gap:14px;font-size:10px;color:#999;padding:15px 0 3px;border-bottom:1px solid #bbb;}
  .foot{margin-top:20px;padding-top:8px;border-top:1px solid #ddd;font-size:9px;color:#999;}
  @media print{body{background:#fff;}.bar{display:none;}.sheet{margin:0;border:none;padding:0 0 20px;}@page{margin:14mm;}}
</style></head><body>
<div class="bar"><button onclick="window.print()">Print / Save as PDF</button></div>
${sheets}
</body></html>`;
}
function openCallSheets(leads) {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open(); w.document.write(callSheetHTML(leads)); w.document.close();
  return true;
}

// The Pipeline tab — saved leads as a WORKING list: status, notes, and the full dossier
// (re-rendered from the saved row) so you research + reach owners without re-searching.
function Pipeline({ pw }) {
  const [leads, setLeads] = useState(() => Object.values(loadPipeline()));
  const [filter, setFilter] = useState("all");
  const [oFilter, setOFilter] = useState("all");
  const [openId, setOpenId] = useState(null);
  const [shared, setShared] = useState(null); // null = syncing, true = shared DB, false = device-local
  const refresh = () => setLeads(Object.values(loadPipeline()));
  useEffect(() => {
    let alive = true;
    syncPipeline()
      .then((ok) => { if (alive) { setShared(ok); refresh(); } })
      .catch(() => { if (alive) setShared(false); });
    return () => { alive = false; };
  }, []);

  const counts = {}; for (const l of leads) counts[l.status] = (counts[l.status] || 0) + 1;
  const oCounts = {}; for (const l of leads) { const o = l.outreach || "none"; oCounts[o] = (oCounts[o] || 0) + 1; }
  const dueCount = leads.filter(callbackDue).length;
  const sorted = [...leads].sort((a, b) => (b.opp?.overall ?? -1) - (a.opp?.overall ?? -1) || (b.savedAt || 0) - (a.savedAt || 0));
  let shown = filter === "all" ? sorted : sorted.filter((l) => l.status === filter);
  if (oFilter !== "all") shown = shown.filter((l) => (l.outreach || "none") === oFilter);
  // Working the callback queue: soonest scheduled call first, not highest score.
  if (oFilter === "callback") shown = [...shown].sort((a, b) => (a.callbackAt || "9999") < (b.callbackAt || "9999") ? -1 : 1);
  const tab = (v, label, n, active, set, color) => (
    <button key={v} onClick={() => set(v)} className="mono" style={{ cursor: "pointer", fontSize: 11, padding: "5px 11px", borderRadius: 7, border: `1px solid ${active ? (color || C.gold) : C.line}`, background: active ? C.goldSoft : "transparent", color: active ? (color || C.gold) : C.muted }}>{label}{n != null ? ` ${n}` : ""}</button>
  );

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tab("all", "All", leads.length, filter === "all", setFilter)}
          {PIPELINE_STATUSES.map(([v, l]) => tab(v, l, counts[v] || 0, filter === v, setFilter))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="mono" title={shared ? "Synced to the shared team database" : shared === false ? "No shared database connected — saved in this browser only" : "Checking the shared database…"}
            style={{ fontSize: 10, letterSpacing: "0.05em", color: shared ? C.green : C.muted }}>
            {shared ? "● SHARED LIST" : shared === false ? "○ THIS DEVICE ONLY" : "◌ SYNCING…"}
          </span>
          {leads.length > 0 && <button onClick={() => { if (shown.length && !openCallSheets(shown)) alert("Allow pop-ups for this site to open the call sheets."); }} title="One printable prep page per lead shown below" className="mono lift" style={{ cursor: "pointer", fontSize: 11, padding: "6px 12px", borderRadius: 7, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>⎙ CALL SHEETS ({shown.length})</button>}
          {leads.length > 0 && <button onClick={() => downloadBlob(pipelineCSV(shown), `pipeline_${new Date().toISOString().slice(0, 10)}.csv`, "text/csv")} className="mono lift" style={{ cursor: "pointer", fontSize: 11, padding: "6px 12px", borderRadius: 7, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ CSV</button>}
          {leads.length > 0 && <button onClick={() => downloadXlsx(`pipeline_${new Date().toISOString().slice(0, 10)}.xlsx`, "Pipeline", PIPELINE_COLS, shown)} className="mono lift" style={{ cursor: "pointer", fontSize: 11, padding: "6px 12px", borderRadius: 7, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXCEL</button>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: C.muted }}>OUTREACH:</span>
        {tab("all", "All", null, oFilter === "all", setOFilter)}
        {OUTREACH_STATES.map(([v, l]) => tab(v, l, oCounts[v] || 0, oFilter === v, setOFilter, v === "dnc" ? C.red : undefined))}
        {dueCount > 0 && <span className="mono" style={{ fontSize: 10.5, color: C.red, marginLeft: 4 }}>⏰ {dueCount} callback{dueCount === 1 ? "" : "s"} due</span>}
      </div>
      {leads.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, marginTop: 8 }}>
          <span className="serif" style={{ color: C.ivory, fontSize: 15 }}>Your pipeline is empty.</span> In <strong style={{ color: C.ivory }}>Sourcing</strong>, hit the <span style={{ color: C.gold }}>☆</span> on any result to save it here. Then set a status (Watching → Contacted → Pursuing → Passed), add notes, and work the dossier + owner contact — all in one place. <span style={{ color: C.muted }}>{shared ? "Saved to the shared team list — everyone on the password sees it." : "Saved on this device only; connect a Postgres (Vercel → Storage → Neon, set DATABASE_URL) to share it with the team."}</span>
        </div>
      ) : shown.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 13 }}>No leads with this status.</div>
      ) : (
        shown.map((l) => <PipelineRow key={l.id} lead={l} pw={pw} open={openId === l.id} onToggle={() => setOpenId(openId === l.id ? null : l.id)} onChange={refresh} onRemove={() => { unsaveLead(l.id); if (openId === l.id) setOpenId(null); refresh(); }} />)
      )}
    </div>
  );
}

function PipelineRow({ lead, pw, open, onToggle, onChange, onRemove }) {
  const [status, setStatusLocal] = useState(lead.status);
  const [outreach, setOutreachLocal] = useState(lead.outreach || "none");
  const [callbackAt, setCallbackLocal] = useState(lead.callbackAt || "");
  const [notes, setNotesLocal] = useState(lead.notes || "");
  const r = lead.row || {};
  const opp = (r.market && r.market !== "web") ? opportunityScore(r) : null;
  const changeStatus = (s) => { setStatusLocal(s); updateLead(lead.id, { status: s }); onChange(); };
  const changeOutreach = (s) => {
    setOutreachLocal(s);
    const patch = { outreach: s, outreachAt: s === "none" ? null : Date.now() };
    if (s !== "callback") { patch.callbackAt = ""; setCallbackLocal(""); }
    updateLead(lead.id, patch); onChange();
  };
  const changeCallback = (d) => { setCallbackLocal(d); updateLead(lead.id, { callbackAt: d }); onChange(); };
  const saveNotes = () => { if (notes !== (lead.notes || "")) { updateLead(lead.id, { notes }); onChange(); } };
  const due = callbackDue({ ...lead, outreach, callbackAt });
  return (
    <div style={{ background: C.panel, border: `1px solid ${outreach === "dnc" ? `${C.red}55` : C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        {opp && <div style={{ flexShrink: 0 }}><GradeCell g={opp} /></div>}
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: C.ivory, fontSize: 13 }}>{lead.owner || "—"}
            {lead.absentee && <span className="mono" style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", borderRadius: 5, background: C.goldSoft, color: C.amber }}>{lead.absentee === "out-of-state" ? "OUT-OF-STATE" : "OUT-OF-AREA"}</span>}
            {outreach === "dnc" && <span className="mono" style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", borderRadius: 5, background: `${C.red}18`, color: C.red }}>✋ DO NOT CALL</span>}
            {outreach === "callback" && callbackAt && <span className="mono" style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", borderRadius: 5, background: due ? `${C.red}18` : C.goldSoft, color: due ? C.red : C.amber }}>⏰ CALLBACK {callbackAt}{due ? " — DUE" : ""}</span>}
            {(outreach === "called" || outreach === "voicemail") && lead.outreachAt && <span className="mono" style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", borderRadius: 5, background: C.goldSoft, color: C.gold }}>☎ {outreachLabel(outreach).toUpperCase()} {new Date(lead.outreachAt).toLocaleDateString()}</span>}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 1 }}>{lead.mapsUrl ? <a href={lead.mapsUrl} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{lead.address || "—"} ↗</a> : (lead.address || "—")}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{[lead.marketLabel, lead.use, lead.value].filter(Boolean).join(" · ")}{lead.mailing ? ` · ${lead.mailing}` : ""}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          <select value={status} onChange={(e) => changeStatus(e.target.value)} style={{ ...fieldStyle, fontSize: 12, padding: "6px 10px", color: statusColor(status) }}>
            {PIPELINE_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={outreach} onChange={(e) => changeOutreach(e.target.value)} title="Call outcome" style={{ ...fieldStyle, fontSize: 12, padding: "6px 10px", color: outreachColor(outreach) }}>
            {OUTREACH_STATES.map(([v, l]) => <option key={v} value={v}>☎ {l}</option>)}
          </select>
          {outreach === "callback" && <input type="date" value={callbackAt} onChange={(e) => changeCallback(e.target.value)} title="Callback date" style={{ ...fieldStyle, fontSize: 12, padding: "5px 8px" }} />}
          <button onClick={onRemove} title="Remove from pipeline" className="mono lift" style={{ cursor: "pointer", fontSize: 11, padding: "5px 9px", borderRadius: 7, border: `1px solid ${C.line}`, background: "transparent", color: C.muted }}>✕</button>
        </div>
      </div>
      <textarea value={notes} onChange={(e) => setNotesLocal(e.target.value)} onBlur={saveNotes} placeholder="Notes — call outcomes, next step, terms…" rows={2}
        style={{ ...fieldStyle, width: "100%", marginTop: 10, resize: "vertical", fontFamily: "inherit", fontSize: 12.5 }} />
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={onToggle} className="mono lift" style={{ cursor: "pointer", fontSize: 11, padding: "5px 12px", borderRadius: 7, border: `1px solid ${open ? C.gold : C.line}`, background: open ? C.goldSoft : C.panel, color: open ? C.gold : C.ivory }}>{open ? "▾ hide" : "▸ work this lead"}</button>
        <button onClick={() => { if (!openCallSheets([{ ...lead, status, outreach, callbackAt, notes }])) alert("Allow pop-ups for this site to open the call sheet."); }} title="Printable one-page prep sheet for this lead" className="mono lift" style={{ cursor: "pointer", fontSize: 11, padding: "5px 12px", borderRadius: 7, border: `1px solid ${C.line}`, background: C.panel, color: C.ivory }}>⎙ CALL SHEET</button>
      </div>
      {open && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${C.line}`, paddingTop: 4 }}>
          {opp && <OppBreakdown g={opp} />}
          {r.market !== "web" && <><AcquisitionMemo r={r} score={opp} pw={pw} /><OutreachDraft r={r} score={opp} pw={pw} /></>}
          {r.market === "nyc" ? <PropertyDetail r={r.raw} pw={pw} /> : r.market === "web" ? <ContactReveal r={{ name: "", entity_type: "", address: (lead.address || "").split(",")[0], contact_address: "", city: "", state: "", zip: "", borough: "" }} pw={pw} /> : <AssessorMarketDetail r={r} pw={pw} />}
        </div>
      )}
    </div>
  );
}

// ── Engine: one-click Acquisition Memo ───────────────────────────────────────
// Turns a sourced property into a full institutional investment memo. Grounds the
// memo in the structured public-records facts we already pulled (so it can't invent
// the property), and leans on Claude's knowledge / live web only for the market &
// comps colour. Reuses /api/research's free-form query path — no new endpoint.
const MEMO_INSTRUCTIONS = `Write a concise, institutional one-page ACQUISITION MEMO for this retail property, in clean markdown using these section headings (omit a section only if you genuinely have nothing for it):

## Executive Summary
## Investment Highlights
## Property Overview
## Ownership & Seller Motivation
## Tenancy
## Market Context
## Comparable Sales
## Risks & Diligence
## Recommendation

Treat the VERIFIED FACTS below as ground truth and build the memo around them. For Market Context, Comparable Sales, and Tenancy where facts aren't supplied, draw on your knowledge or live web research and cite sources inline; clearly label any figure you infer as an estimate, and NEVER fabricate specific rents, prices, tenants, or contacts. The Opportunity Score is an internal prospecting signal — reference it under Ownership & Seller Motivation, not as proven intent. Keep it tight and decision-grade (~500–750 words). This is for a professional trophy / high-street retail acquisitions team.`;

function memoFacts(r) {
  const raw = r.raw || {};
  const f = [];
  const push = (k, v) => { if (v != null && v !== "" && v !== 0) f.push(`- ${k}: ${v}`); };
  const amt = (v) => (v != null && v !== "" && Number(v) ? fmtAmount(v) : null);
  push("Market", r.marketLabel);
  push("Address", r.address);
  push("Owner of record", r.owner);
  push("Owner mailing address", r.mailing);
  if (r.absentee) push("Owner location", r.absentee === "out-of-state" ? "Out-of-state (absentee owner)" : "Out-of-area (absentee owner)");
  push("Use / property type", r.use || raw.use);
  push("Assessed / stated value", r.value);
  push("Market value", amt(raw.market_value));
  const salePrice = amt(raw.last_sale_price || raw.sale_price);
  if (salePrice) push("Last recorded sale", `${salePrice}${(raw.last_sale_date || raw.sale_date || raw.sale_year) ? ` · ${String(raw.last_sale_date || raw.sale_date || raw.sale_year).slice(0, 4)}` : ""}`);
  if (raw.years_owned != null) push("Years owned by current owner", `~${raw.years_owned}`);
  push("Building SF", (raw.bldg_sqft || raw.building_sqft) ? Number(raw.bldg_sqft || raw.building_sqft).toLocaleString() : null);
  push("Retail SF", raw.retail_sqft ? Number(raw.retail_sqft).toLocaleString() : null);
  push("Lot SF", raw.lot_sqft ? Number(raw.lot_sqft).toLocaleString() : null);
  push("Frontage", raw.frontage_ft ? `${raw.frontage_ft} ft on the street` : null);
  push("Floors", raw.num_floors || raw.stories);
  push("Year built", raw.year_built || raw.ayb);
  push("Zoning", raw.zoning || raw.zone || raw.zone_description);
  push("Commercial overlay", raw.overlay);
  push("Special district", raw.special_district);
  if (raw.landmark) push("Landmark", "Yes — facade / alteration restrictions apply");
  if (raw.tax_lien) push("Distress signal", "On the tax-lien sale list");
  if (raw.buildable_sqft && Number(raw.buildable_sqft) >= 2500) push("Unused air rights", `~${Number(raw.buildable_sqft).toLocaleString()} SF buildable (development / expansion upside)`);
  return f.join("\n");
}

function AcquisitionMemo({ r, score, pw }) {
  const cached = getAiAnswer(r, "memo"); // saved on this browser from an earlier lookup
  const [state, setState] = useState(cached ? "done" : "idle"); // idle | loading | done | error
  const [memo, setMemo] = useState(cached ? cached.text : "");
  const [savedAt, setSavedAt] = useState(cached ? cached.savedAt : 0);
  const [err, setErr] = useState("");
  const run = async (refine = false) => {
    setState("loading"); setErr("");
    try {
      const scoreLine = score
        ? `\n\nFRONTAGE Opportunity Score (internal prospecting model — a priority signal, NOT confirmed seller intent): ${score.overall}/100 — ${score.rec}. Drivers: ${score.parts.map((p) => `${p.label} ${p.sub}/100 (${p.note})`).join("; ")}.`
        : "";
      const query = `${MEMO_INSTRUCTIONS}\n\nVERIFIED FACTS (ground truth — do not contradict):\n${memoFacts(r)}${scoreLine}`;
      // Honors the Quick/Deep toggle + monthly web cap exactly like every other web call.
      const m = webResearchMode();
      const d = await postJSON("/api/research", { query, mode: m, password: pw, ...(refine && memo ? { prior: memo } : {}) });
      if (m === "web") addScoutSpend(WEB_RUN_COST);
      const text = d.brief || "";
      setMemo(text); saveAiAnswer(r, "memo", text, m); setSavedAt(Date.now()); setState("done");
    } catch (e) { setErr(e.message || "Memo failed."); setState("error"); }
  };
  const title = `Acquisition Memo — ${r.address || r.owner || "Property"}`;
  const webOn = webResearchMode() === "web";
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.gold}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>▤ ACQUISITION MEMO — one-click investment memo</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {state === "done" && savedAt > 0 && <span style={{ fontSize: 10, color: C.muted }}>saved · {savedAgo(savedAt)}</span>}
          {state === "done" && <button onClick={() => { if (!openPrintable(title, memo)) alert("Allow pop-ups to open the printable memo."); }} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.line}` }}>⤓ print / PDF</button>}
          {state === "done" && <button onClick={() => run(true)} title="Re-run, building on the saved memo" className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.line}` }}>↻ refine</button>}
          {state !== "loading" && <button onClick={() => run(false)} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>{state === "done" || state === "error" ? "↻ fresh" : "▸ generate"}</button>}
        </div>
      </div>
      {state === "idle" && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 6 }}>Builds a full memo — executive summary, highlights, ownership & motivation, market, comps, risks, recommendation — grounded in this property's records{webOn ? ", plus live-web market context (~$0.30 in Deep mode)." : ". Switch Scout to Deep mode for live-web market & comps colour."} Saved on this browser for instant re-open; exports to a printable PDF.</div>}
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>Drafting the memo… (a few seconds)</div>}
      {state === "error" && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {state === "done" && <div style={{ marginTop: 10 }}><ResearchBriefBody text={memo} /></div>}
    </div>
  );
}

// ── Engine: AI Outreach Assistant ────────────────────────────────────────────
// Drafts a short, personalized owner-outreach email grounded in the same public-records
// facts — referencing genuine signals (tenure, absentee, portfolio) without sounding
// scraped. The "reach the owner" half of the North Star, one click from the dossier.
const OUTREACH_INSTRUCTIONS = `Draft a SHORT, warm, professional cold-outreach EMAIL from a trophy / high-street retail acquisitions firm to the OWNER of the property below, opening a low-pressure conversation about a potential off-market sale.

Output EXACTLY this shape and nothing else:
Subject: <a specific, non-spammy subject line>

<three short paragraphs, ~120–160 words total>

Guidelines:
- Personalize from the VERIFIED FACTS — reference genuine signals (how long they've held it, an absentee / out-of-area mailing, their portfolio, the corridor) WITHOUT sounding like you pulled a database. Use ONLY facts provided here or that you can actually verify; NEVER invent a "recent nearby acquisition", a specific number, or a compliment you can't support.
- Lead with relevance to THIS specific asset, not a generic pitch. Principal-to-principal tone: respectful, credible, concise. No emojis, no hype.
- Close with a soft ask (a brief call) and end with the signature placeholder exactly: "[Your name] · [Firm] · [phone / email]".
- If the owner is an LLC with no human named, address "the ownership" naturally rather than guessing a name.`;

function OutreachDraft({ r, score, pw }) {
  const cached = getAiAnswer(r, "outreach");
  const [state, setState] = useState(cached ? "done" : "idle"); // idle | loading | done | error
  const [email, setEmail] = useState(cached ? cached.text : "");
  const [savedAt, setSavedAt] = useState(cached ? cached.savedAt : 0);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const run = async (refine = false) => {
    setState("loading"); setErr("");
    try {
      const query = `${OUTREACH_INSTRUCTIONS}\n\nVERIFIED FACTS (ground truth — do not contradict):\n${memoFacts(r)}`;
      const m = webResearchMode();
      const d = await postJSON("/api/research", { query, mode: m, password: pw, ...(refine && email ? { prior: email } : {}) });
      if (m === "web") addScoutSpend(WEB_RUN_COST);
      const text = d.brief || "";
      setEmail(text); saveAiAnswer(r, "outreach", text, m); setSavedAt(Date.now()); setState("done");
    } catch (e) { setErr(e.message || "Draft failed."); setState("error"); }
  };
  const copy = () => { if (navigator.clipboard) navigator.clipboard.writeText(email).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>✉ OUTREACH ASSISTANT — draft a personalized owner email</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {state === "done" && savedAt > 0 && <span style={{ fontSize: 10, color: C.muted }}>saved · {savedAgo(savedAt)}</span>}
          {state === "done" && <button onClick={copy} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.line}` }}>{copied ? "✓ copied" : "⧉ copy"}</button>}
          {state === "done" && <button onClick={() => run(true)} title="Re-draft, building on the saved email" className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.line}` }}>↻ refine</button>}
          {state !== "loading" && <button onClick={() => run(false)} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>{state === "done" || state === "error" ? "↻ fresh" : "▸ draft"}</button>}
        </div>
      </div>
      {state === "idle" && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 6 }}>Writes a short, personal cold-outreach email to this owner — referencing real signals (tenure, absentee, portfolio), with a soft ask and a signature placeholder you fill in. Saved on this browser; verify any claim before sending.</div>}
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>Drafting the email…</div>}
      {state === "error" && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {state === "done" && <div style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.6, color: C.ivory }}>{email}</div>}
    </div>
  );
}

// Session cache so a given owner's contact is paid for at most once (owner-dedupe).
// Key = owner name + mailing zip/state; survives re-opening rows for the session.
const _skipCache = new Map();
// Key by owner name; for nameless rows (web/address-only traces) fall back to the property address
// so two different addresses don't collide on the same cache slot.
const skipKey = (r) => `${(r.name || r.address || "").toUpperCase().trim()}|${(r.zip || r.state || "").toString().trim()}`;
function readSkipSpend() { try { const v = JSON.parse(localStorage.getItem("fr_skiptrace_spend_v1") || "{}"); return typeof v === "number" ? { hits: 0, est: v } : v; } catch { return {}; } }
function bumpSkipSpend(est) {
  const cur = readSkipSpend();
  const next = { hits: (cur.hits || 0) + 1, est: Math.round(((cur.est || 0) + (est || 0)) * 100) / 100 };
  try { localStorage.setItem("fr_skiptrace_spend_v1", JSON.stringify(next)); } catch {}
  return next;
}

// The single most-callable number across all the people on a trace (phones are already
// graded + sorted), with an email fallback when no phone is on record.
function bestContact(persons) {
  let bestPhone = null, bestScore = -1, firstEmail = null, firstEmailName = "";
  for (const p of persons || []) {
    for (const ph of p.phones || []) {
      // Name-match dominates (a strong match beats a weak one beats a non-match), then the
      // phone's own callability grade breaks ties — so we never lead with a random occupant.
      const s = (p.matchScore || 0) * 12 + (ph.grade?.score || 0);
      if (s > bestScore) { bestScore = s; bestPhone = { ...ph, name: p.name, matchesOwner: p.matchesOwner, matchLabel: p.matchLabel }; }
    }
    if (!firstEmail && p.emails && p.emails.length) { firstEmail = p.emails[0]; firstEmailName = p.name; }
  }
  return { bestPhone, firstEmail, firstEmailName };
}

// Render a list of phones + emails (shared by the free and paid lanes).
function ContactList({ phones = [], emails = [] }) {
  if (!phones.length && !emails.length) return null;
  return (
    <>
      {phones.map((p, i) => {
        const tier = p.grade && p.grade.tier;
        const tcol = tier === "BEST" ? C.green : tier === "GOOD" ? C.gold : C.muted;
        return (
          <div key={`p${i}`} style={{ fontSize: 13.5, marginBottom: 3 }}>
            <a href={`tel:${String(p.number).replace(/[^\d+]/g, "")}`} style={{ color: C.ivory, textDecoration: "none", fontWeight: 600 }}>{p.number}</a>
            {tier && <span className="mono" title={`callability ${p.grade.score}/100`} style={{ fontSize: 9, color: tcol, marginLeft: 6, border: `1px solid ${tcol}`, borderRadius: 4, padding: "0 5px" }}>{tier}</span>}
            {p.type && <span className="mono" style={{ fontSize: 10, color: C.muted, marginLeft: 6 }}>{String(p.type).toUpperCase()}</span>}
            {p.dnc && <span className="mono" style={{ fontSize: 9.5, color: C.red, marginLeft: 6, border: `1px solid ${C.red}`, borderRadius: 4, padding: "0 5px" }}>DNC</span>}
          </div>
        );
      })}
      {emails.map((e, i) => (
        <div key={`e${i}`} style={{ fontSize: 13, marginBottom: 2 }}>
          <a href={`mailto:${e}`} style={{ color: C.gold, textDecoration: "none" }}>{e}</a>
        </div>
      ))}
    </>
  );
}

// Relatives / associates the skip trace returned for a person — the household/family
// side-channel for reaching an owner (a spouse or adult child often answers, or leads
// you to them). Only renders when the provider actually returned relatives. Each may
// carry its own phones/emails; where it doesn't, the name is a one-click trace lead.
function RelativeList({ relatives = [], loc = {} }) {
  const [open, setOpen] = useState(false);
  if (!relatives.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(!open)} className="mono lift" style={{ ...ACTION_PILL, fontSize: 9.5, padding: "2px 8px", color: C.muted, border: `1px solid ${C.line}` }}>
        {open ? "▾" : "▸"} FAMILY / RELATIVES ({relatives.length})
      </button>
      {open && (
        <div style={{ marginTop: 6, paddingLeft: 10, borderLeft: `2px solid ${C.line}` }}>
          {relatives.map((rel, i) => {
            const links = freePeopleLinks(rel.name, loc.city || "", loc.state || "");
            return (
            <div key={i} style={{ marginBottom: 7 }}>
              <div style={{ fontSize: 12, color: C.ivory }}>
                {rel.name}
                {rel.relationship && <span className="mono" style={{ fontSize: 9, color: C.muted, marginLeft: 6, border: `1px solid ${C.line}`, borderRadius: 4, padding: "0 5px" }}>{String(rel.relationship).toUpperCase()}</span>}
                {rel.age && <span style={{ fontSize: 10.5, color: C.muted, marginLeft: 6 }}>age {rel.age}</span>}
              </div>
              {(rel.phones?.length || rel.emails?.length)
                ? <div style={{ marginTop: 2 }}><ContactList phones={rel.phones} emails={rel.emails} /></div>
                : <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}><span style={{ color: C.green }}>FREE:</span> {links.map(([lab, url], j) => <span key={lab}>{j > 0 ? " · " : " "}<a href={url} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{lab} ↗</a></span>)}</div>}
            </div>
          ); })}
        </div>
      )}
    </div>
  );
}

// Owner-contact WORKFLOW (the waterfall): one click runs the FREE web-search lane
// first (/api/findcontact, $0). If that finds a usable contact, you're done for free.
// If it whiffs, a "deep skip trace" button runs the PAID lane (/api/skiptrace), which
// is charged only on a match and cached by owner so you never pay twice.
// Owner-contact lookup — one click runs the skip trace (Tracerfy), charged only on a
// match, owner-deduped + cached so you never pay twice. (The free web-search lane is
// parked; /api/findcontact still exists if a BRAVE_API_KEY is ever added back.)
function ContactReveal({ r, pw, autoRun, noAlt }) {
  const cachedSkip = _skipCache.get(skipKey(r)) || null;
  const [skip, setSkip] = useState(cachedSkip);
  const [skipState, setSkipState] = useState(cachedSkip ? "done" : "idle"); // idle|loading|done|error|nokey
  const [err, setErr] = useState("");
  const [spend, setSpend] = useState(readSkipSpend());
  const [altOpen, setAltOpen] = useState(false); // "trace a different person" (unmasked LLC principal)
  const looksCompany = r.entity_type === "company" || ENTITY_RE.test(r.name || "");

  const runSkip = async () => {
    setSkipState("loading"); setErr("");
    try {
      const d = await postJSON("/api/skiptrace", {
        password: pw, name: r.name, entity_type: r.entity_type,
        contact_address: r.contact_address, city: r.city, state: r.state, zip: r.zip,
        address: r.address, borough: r.borough,
      });
      if (d.noKey) { setSkip(d); setSkipState("nokey"); return; }
      const result = { persons: d.persons || [], phones: d.phones || [], emails: d.emails || [], provider: d.provider, business: d.business, matched: d.matched, tracedAddress: d.tracedAddress, entityLowConfidence: d.entityLowConfidence, ownerMatch: d.ownerMatch || null, weakMatch: d.weakMatch, ownerName: d.ownerName };
      _skipCache.set(skipKey(r), result);
      setSkip(result);
      if (result.matched) setSpend(bumpSkipSpend(d.cost));
      setSkipState("done");
    } catch (e) { setErr(e.message || "Skip trace failed."); setSkipState("error"); }
  };

  // Manual skip-trace tool passes autoRun so the trace fires immediately (no second click).
  useEffect(() => { if (autoRun && skipState === "idle") runSkip(); /* eslint-disable-next-line */ }, []);

  const box = { background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", marginTop: 10 };
  const pill = (color) => ({ ...ACTION_PILL, padding: "7px 13px", background: C.panel, border: `1px solid ${color}`, color });

  // "Unmasked the LLC elsewhere? Trace the person" — an inline manual trace seeded with THIS
  // property's address, so a principal you found on another site (OpenCorporates / SOS) can be
  // traced without leaving the dossier or re-typing the address. Suppressed on nested/manual
  // reveals (noAlt) so it doesn't recurse. The owner-of-record trace above still runs the LLC.
  const altBlock = noAlt ? null : (
    <div style={{ marginTop: 10, borderTop: `1px dashed ${C.line}`, paddingTop: 9 }}>
      {!altOpen ? (
        <button onClick={() => setAltOpen(true)} className="mono lift" style={{ ...ACTION_PILL, fontSize: 10.5, padding: "3px 9px" }}>
          🔓 Unmasked the LLC elsewhere? Trace the person →
        </button>
      ) : (
        <div>
          <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.05em", marginBottom: 7 }}>
            TRACE A PERSON — who you found behind the LLC + their address
          </div>
          <SkipTraceForm pw={pw} seed={{ name: "", street: r.contact_address || r.address || "", city: r.city || "", state: r.state || "", zip: r.zip || "" }} />
          <button onClick={() => setAltOpen(false)} className="mono lift" style={{ ...ACTION_PILL, marginTop: 8, fontSize: 10, padding: "2px 8px" }}>▾ hide</button>
        </div>
      )}
    </div>
  );

  if (skipState === "idle") {
    return (
      <div style={box}>
        {looksCompany ? (
          <div>
            <div style={{ fontSize: 11.5, color: C.amber, lineHeight: 1.55, marginBottom: 9 }}>
              ⚠ <strong style={{ color: C.ivory }}>{r.name}</strong> is an LLC. An entity has no phone, and tracing its address returns the registered agent or building occupants — <strong>not</strong> the principal. That’s why the numbers come back wrong. Use <strong style={{ color: C.ivory }}>👥 Who’s behind this LLC</strong> above to get the principal’s name + address, then trace <em>that person</em> below.
            </div>
            <button onClick={runSkip} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 11px", background: C.panel, border: `1px solid ${C.line}`, color: C.muted }}>trace the LLC address anyway</button>
            <span style={{ fontSize: 10.5, color: C.muted, marginLeft: 8 }}>~$0.12 · only worth it if the mailing is the owner’s home, not a suite / agent office</span>
          </div>
        ) : (
          <>
            <button onClick={runSkip} className="mono lift" style={pill(C.gold)}>🔎 Find owner contact</button>
            <span style={{ fontSize: 11, color: C.muted, marginLeft: 10 }}>~$0.12 · charged only on a match · cached</span>
            {r.name && !ENTITY_RE.test(r.name) && (() => {
              // FREE family/relatives — people-search sites list living relatives + associates
              // on a person's page at no cost; a human clicks through. No paid trace needed.
              const links = freePeopleLinks(r.name, r.city || "", r.state || "");
              return <div style={{ fontSize: 11, color: C.muted, marginTop: 9, lineHeight: 1.5 }}>🌳 <strong style={{ color: C.green }}>Family & relatives, free:</strong> {links.slice(0, 2).map(([lab, url], j) => <span key={lab}>{j > 0 ? " · " : " "}<a href={url} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{lab} ↗</a></span>)} <span style={{ color: C.muted }}>— these list {r.name.split(/[ ,]/)[0] || "the owner"}’s relatives & associates. Or 👥 “Who’s behind / relatives” above for an AI sweep.</span></div>;
            })()}
          </>
        )}
        {altBlock}
      </div>
    );
  }

  return (
    <div style={box}>
      {skipState === "loading" && <div style={{ color: C.muted, fontSize: 12.5 }}>Tracing owner…</div>}
      {skipState === "nokey" && (
        <div style={{ fontSize: 11.5, color: C.amber }}>
          Skip tracing isn’t configured — set <span className="mono">{skip?.keyEnv || "TRACERFY_API_KEY"}</span> in Vercel env. Provider: {skip?.provider || "Tracerfy"}.
        </div>
      )}
      {skipState === "done" && (
        <div>
          <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.06em", marginBottom: 6 }}>
            VERIFIED CONTACT — via {skip.provider}{skip.business ? " · business trace" : ""} · paid
          </div>
          {skip.matched ? (
            <>
              {skip.entityLowConfidence && (
                <div style={{ fontSize: 11.5, color: C.red, lineHeight: 1.5, marginBottom: 9, padding: "7px 10px", background: `${C.red}12`, border: `1px solid ${C.red}44`, borderRadius: 7 }}>
                  ⚠ <strong>Likely the wrong party.</strong> This is an LLC and none of these names match the owner — they’re probably the registered agent, office staff, or a shared-suite neighbor at the entity’s mailing address, not the principal. Don’t dial these blind. Use <strong style={{ color: C.ivory }}>👥 Who’s behind this LLC</strong> above to get the actual principal, then trace that person.
                </div>
              )}
              {/* Name-match verdict banner — the defense against "random names": say plainly
                  whether a returned person actually matches the owner we're looking for. */}
              {!skip.business && skip.ownerMatch && skip.ownerMatch.score >= 55 && (
                <div style={{ fontSize: 11.5, color: C.green, lineHeight: 1.5, marginBottom: 9, padding: "7px 10px", background: `${C.green}10`, border: `1px solid ${C.green}44`, borderRadius: 7 }}>
                  ✓ <strong>Name match: {skip.ownerMatch.name}</strong> {skip.ownerMatch.score >= 80 ? "— strong match to" : "— likely"} the owner{skip.ownerName ? ` of record (${skip.ownerName})` : ""}{skip.ownerMatch.reasons?.length ? ` · matched on ${skip.ownerMatch.reasons.join(" + ")}` : ""}. These numbers most likely reach the right person.
                </div>
              )}
              {!skip.business && skip.weakMatch && (
                <div style={{ fontSize: 11.5, color: C.amber, lineHeight: 1.5, marginBottom: 9, padding: "7px 10px", background: `${C.amber}12`, border: `1px solid ${C.amber}55`, borderRadius: 7 }}>
                  ⚠ <strong>No strong name match to {skip.ownerName || "the owner"}.</strong> The returned people don’t clearly match the owner of record — they may be prior residents, relatives, or occupants at this address, not the owner. Verify the name before you dial. Each result below shows how well it matches.
                </div>
              )}
              {(() => {
                const { bestPhone, firstEmail, firstEmailName } = bestContact(skip.persons);
                if (!bestPhone && !firstEmail) return null;
                const tcol = bestPhone ? (bestPhone.grade?.tier === "BEST" ? C.green : bestPhone.grade?.tier === "GOOD" ? C.gold : C.muted) : C.gold;
                return (
                  <div style={{ marginBottom: 9, padding: "7px 10px", background: C.panel, border: `1px solid ${tcol}`, borderRadius: 7 }}>
                    <span className="mono" style={{ fontSize: 9.5, color: C.muted, letterSpacing: "0.05em" }}>📞 BEST CONTACT </span>
                    {bestPhone ? (
                      <>
                        <a href={`tel:${String(bestPhone.number).replace(/[^\d+]/g, "")}`} style={{ color: C.ivory, fontWeight: 700, textDecoration: "none", fontSize: 14 }}>{bestPhone.number}</a>
                        <span className="mono" style={{ fontSize: 9, color: tcol, marginLeft: 6, border: `1px solid ${tcol}`, borderRadius: 4, padding: "0 5px" }}>{bestPhone.grade?.tier}</span>
                        {bestPhone.type && <span className="mono" style={{ fontSize: 10, color: C.muted, marginLeft: 6 }}>{String(bestPhone.type).toUpperCase()}</span>}
                        {bestPhone.name && <span style={{ color: C.muted, fontSize: 12.5 }}> · {bestPhone.name}</span>}
                      </>
                    ) : (
                      <>
                        <a href={`mailto:${firstEmail}`} style={{ color: C.gold, fontWeight: 700, textDecoration: "none", fontSize: 13.5 }}>{firstEmail}</a>
                        {firstEmailName && <span style={{ color: C.muted, fontSize: 12.5 }}> · {firstEmailName}</span>}
                        <span style={{ color: C.muted, fontSize: 11 }}> (no phone on record)</span>
                      </>
                    )}
                  </div>
                );
              })()}
              {skip.persons && skip.persons.length ? (
                skip.persons.map((p, i) => (
                  <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < skip.persons.length - 1 ? `1px solid ${C.line}` : "none" }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: p.isEntity ? C.muted : C.ivory, marginBottom: 3 }}>
                      {p.name || "Unnamed contact"}
                      {!p.isEntity && (() => {
                        // Graded name-match badge, so a random occupant can't masquerade as the owner.
                        const lab = p.matchLabel, sc = p.matchScore;
                        const cfg = lab === "strong" ? [C.green, "✓ STRONG MATCH"] : lab === "likely" ? [C.green, "✓ LIKELY"] : lab === "weak" ? [C.amber, "~ WEAK MATCH"] : [C.muted, "✗ NOT MATCHED"];
                        const why = (p.matchReasons && p.matchReasons.length ? `Matched on ${p.matchReasons.join(" + ")}. ` : "No name overlap with the owner. ") + `Score ${sc}/100 vs the owner of record.`;
                        return <span className="mono" title={why} style={{ fontSize: 9, color: cfg[0], marginLeft: 6, border: `1px solid ${cfg[0]}`, borderRadius: 4, padding: "0 5px" }}>{cfg[1]}</span>;
                      })()}
                      {p.isEntity && <span className="mono" title="A company name, not an individual — likely the owner's corporate web. Verify." style={{ fontSize: 9, color: C.amber, marginLeft: 6, border: `1px solid ${C.amber}`, borderRadius: 4, padding: "0 5px" }}>ENTITY ⚠</span>}
                    </div>
                    <ContactList phones={p.phones} emails={p.emails} />
                    <RelativeList relatives={p.relatives} loc={{ city: r.city, state: r.state }} />
                  </div>
                ))
              ) : (
                <ContactList phones={skip.phones} emails={skip.emails} />
              )}
              {skip.persons && skip.persons.length > 0 && skip.persons.every((p) => p.isEntity) && (
                <div style={{ fontSize: 11, color: C.amber, marginTop: 4, lineHeight: 1.5 }}>
                  ⚠ Only entity records came back — no individual. This owner is likely institutional (a REIT / big operator like Thor) whose data resolves to its corporate web, not a person. Use the ✦ AI Quick Take or the company’s office line; skip tracing works best on smaller private owners.
                </div>
              )}
              <div style={{ fontSize: 10, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
                {skip.tracedAddress === "property"
                  ? <>Traced on the <span style={{ color: C.amber }}>property address</span> (no owner mailing on file) — results may be building occupants; verify. </>
                  : <>Traced on the owner’s mailing address. </>}
                Badges grade each result against the owner of record: <span style={{ color: C.green }}>✓ STRONG/LIKELY</span> = the name lines up (right party); <span style={{ color: C.amber }}>~ WEAK</span> = last name only (owner or a relative); <span style={{ color: C.muted }}>✗ NOT MATCHED</span> = a different name (probably not the owner). <span style={{ color: C.red }}>DNC</span> = Do-Not-Call — prefer email there.
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: C.muted }}>No match found (no charge).</div>
          )}
          {skip.business && skip.matched && (
            <div style={{ fontSize: 10.5, color: C.muted, marginTop: 6, lineHeight: 1.45 }}>
              ⚠ LLC trace — may be the entity’s registered agent or manager, not the principal. Verify before calling.
            </div>
          )}
        </div>
      )}

      {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}
      {skipState === "error" && <button onClick={runSkip} className="mono lift" style={{ ...ACTION_PILL, marginTop: 8 }}>↻ retry</button>}
      {spend?.hits ? (
        <div style={{ fontSize: 10, color: C.muted, marginTop: 8 }}>skip-trace spend: ${Number(spend.est || 0).toFixed(2)} over {spend.hits} reveal{spend.hits === 1 ? "" : "s"}</div>
      ) : null}
      {altBlock}
    </div>
  );
}

// Persist the last city/state/zip typed into a manual trace so they don't have to be
// re-entered every lookup — especially the STATE, since you work one market at a time.
const SKIP_FORM_KEY = "fr_skipform_v1";
function loadSkipForm() { try { return JSON.parse(localStorage.getItem(SKIP_FORM_KEY) || "{}"); } catch { return {}; } }
function saveSkipForm(v) { try { localStorage.setItem(SKIP_FORM_KEY, JSON.stringify(v)); } catch {} }

// Shared name + address skip-trace form. Used standalone (the Skip Trace tab) and inline in a
// property dossier (seeded with that property's address) so an LLC principal you unmasked on
// another site can be traced without re-typing. NOTE: Tracerfy finds people by ADDRESS
// (find_owner), so enter the PERSON's own address — the name only flags whether the returned
// match is them. City/State/ZIP default from the seed (in-dossier) or the last values used.
function SkipTraceForm({ pw, seed }) {
  const last = loadSkipForm();
  const [name, setName] = useState(seed?.name || "");
  const [street, setStreet] = useState(seed?.street || "");
  const [city, setCity] = useState(seed?.city || last.city || "");
  const [stateV, setStateV] = useState(seed?.state || last.state || "");
  const [zip, setZip] = useState(seed?.zip || last.zip || "");
  const [target, setTarget] = useState(null);

  const ready = name.trim() && street.trim();
  const run = () => {
    if (!ready) return;
    saveSkipForm({ city: city.trim(), state: stateV.trim(), zip: zip.trim() });
    setTarget({
      name: name.trim(), entity_type: "",
      contact_address: street.trim(), city: city.trim(), state: stateV.trim(), zip: zip.trim(),
      address: street.trim(), borough: "",
      deal_id: `manual-${name.trim()}-${zip.trim()}-${Date.now()}`,
    });
  };
  const onKey = (e) => { if (e.key === "Enter" && ready) { e.preventDefault(); run(); } };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
        <label style={{ gridColumn: "span 2" }}><div className="mono" style={labelStyle}>NAME</div><input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} placeholder="First Last (the person)" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
        <label style={{ gridColumn: "span 2" }}><div className="mono" style={labelStyle}>STREET ADDRESS</div><input value={street} onChange={(e) => setStreet(e.target.value)} onKeyDown={onKey} placeholder="123 Main St (the person's address)" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
        <label><div className="mono" style={labelStyle}>CITY</div><input value={city} onChange={(e) => setCity(e.target.value)} onKeyDown={onKey} placeholder="Nashville" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
        <label><div className="mono" style={labelStyle}>STATE</div><input value={stateV} onChange={(e) => setStateV(e.target.value)} onKeyDown={onKey} placeholder="TN" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
        <label><div className="mono" style={labelStyle}>ZIP</div><input value={zip} onChange={(e) => setZip(e.target.value)} onKeyDown={onKey} placeholder="37206" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
      </div>
      <button onClick={run} disabled={!ready}
        style={{ marginTop: 14, width: "100%", cursor: ready ? "pointer" : "default", border: "none", borderRadius: 9, padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em", background: ready ? C.gold : C.panel2, color: ready ? "#ffffff" : C.muted }}>
        Skip trace →
      </button>
      {target && <ContactReveal key={target.deal_id} r={target} pw={pw} autoRun noAlt />}
    </>
  );
}

// Manual skip-trace tool — type any name + address and trace it directly (e.g. an LLC
// principal you unmasked on another site, far better than tracing a building).
function ManualSkipTrace({ pw }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div className="mono" style={{ fontSize: 11, color: C.muted, letterSpacing: "0.05em", marginBottom: 12 }}>MANUAL SKIP TRACE — name + address</div>
        <SkipTraceForm pw={pw} />
      </div>

      <div style={{ marginTop: 14, fontSize: 12, color: C.muted, lineHeight: 1.55 }}>
        Trace any name + address directly. <strong style={{ color: C.ivory }}>~$0.10 per match</strong> (Tracerfy), charged only on a hit, cached so you never pay twice for the same name. Best use: trace a <strong style={{ color: C.gold }}>specific person</strong> — e.g. an LLC principal you unmasked on another site, or an officer from a property’s records — instead of the building (which returns occupants). Enter the <strong style={{ color: C.ivory }}>person’s own address</strong>: Tracerfy finds people by address, and the name flags whether the <span style={{ color: C.green }}>✓ OWNER MATCH</span> is them. City / State / ZIP are remembered for next time.
      </div>
    </div>
  );
}

// Derive the property's recorded debt from its ACRIS history. Returns undefined while
// history is still loading, null when no mortgage is on record, else the latest one.
// NOTE: ACRIS records the ORIGINAL mortgage amount, not the current balance, and a
// later Satisfaction (SAT) means it was likely paid off — both flagged honestly.
function latestDebt(hist) {
  if (hist == null) return undefined;
  const m = hist.filter((h) => h.doc_type === "MTGE" || h.doc_type === "MMTG")
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (!m.length) return null;
  const latest = m[0];
  const satisfied = hist.some((h) => h.doc_type === "SAT" && (h.date || "") > (latest.date || ""));
  const lender = ((latest.parties || []).find((p) => /grantee|buyer|party/i.test(p.role)) || (latest.parties || [])[0] || {}).name || "";
  const year = Number(String(latest.date || "").slice(0, 4)) || null;
  const yearsAgo = year ? new Date().getFullYear() - year : null;
  // Maturity estimate. ACRIS doesn't record a maturity date, but commercial mortgages
  // are typically 5/7/10-year balloons — so an old, unsatisfied loan is likely at or
  // past maturity (refinance/sale pressure = a motivation signal). Estimate from age.
  let maturity = null;
  if (!satisfied && yearsAgo != null) {
    if (yearsAgo >= 10) maturity = { level: "high", text: `loan is ~${yearsAgo}y old — past a typical 10y term; likely matured (refinance or sale)` };
    else if (yearsAgo >= 7) maturity = { level: "med", text: `loan ~${yearsAgo}y old — nearing a typical 7–10y maturity` };
    else if (yearsAgo >= 5) maturity = { level: "low", text: `loan ~${yearsAgo}y old — a 5y balloon may be coming due` };
  }
  return { amount: latest.amount, date: latest.date, lender, satisfied, count: m.length, year, yearsAgo, maturity };
}

// Synthesize the distress / motivation signals the dossier already pulls into one read.
// (The specific lis-pendens / 421-a-expiry sources aren't cleanly in NYC open data — this
// uses what IS: tax lien, ECB penalties owed, open violations, evictions, 311, vacancy.)
function distressRead(intel, r) {
  if (!intel) return null;
  const reasons = [];
  let score = 0;
  if (r && r.tax_lien) { score += 3; reasons.push("tax lien"); }
  const ecb = Number(intel.ecb_balance_due) || 0;
  if (ecb >= 25000) { score += 3; reasons.push(`$${ecb.toLocaleString()} ECB penalties owed`); }
  else if (ecb > 0) { score += 1; reasons.push(`$${ecb.toLocaleString()} ECB owed`); }
  const viol = (Number(intel.dob_violations) || 0) + (Number(intel.ecb_violations) || 0) + (Number(intel.hpd_violations) || 0);
  if (viol >= 20) { score += 2; reasons.push(`${viol} open violations`); }
  else if (viol >= 5) { score += 1; reasons.push(`${viol} open violations`); }
  if (intel.evictions && intel.evictions.commercial) { score += 2; reasons.push("commercial eviction on record"); }
  const c311 = Number(intel.complaints_311) || 0;
  if (c311 >= 30) { score += 1; reasons.push(`${c311} 311 complaints (2yr)`); }
  if (intel.storefront && intel.storefront.any_vacant) { score += 1; reasons.push("storefront reported vacant"); }
  return { level: score >= 5 ? "High" : score >= 2 ? "Medium" : "Low", score, reasons };
}

// One HPD officer/owner with a one-click "trace this person" button → runs the skip
// trace on that human (name + their business address), instead of the building.
function OfficerRow({ o, pw }) {
  const [open, setOpen] = useState(false);
  const [port, setPort] = useState(null); // null=unloaded, "loading", or { buildings }
  const target = {
    name: o.name, entity_type: o.isPerson ? "person" : "",
    contact_address: o.street, city: o.city, state: o.state || "NY", zip: o.zip,
    address: o.street, borough: "",
    deal_id: `officer-${o.name}-${o.zip || ""}`,
  };
  const canTrace = o.isPerson && o.street;
  const loadPort = async () => {
    if (port && port !== "err") { setPort(port === "loading" ? port : (port.shown ? null : { ...port, shown: true })); return; }
    setPort("loading");
    try {
      const d = await postJSON("/api/portfolio", { password: pw, name: o.name });
      setPort({ buildings: d.buildings || [], shown: true });
    } catch { setPort("err"); }
  };
  return (
    <div style={{ marginTop: 2 }}>
      <div style={{ color: C.muted }}>
        <span className="mono" style={{ fontSize: 10, color: C.gold }}>{o.role}</span>{" "}
        <span style={{ color: C.ivory }}>{o.name}</span>{o.address ? <span style={{ fontSize: 11 }}> — {o.address}</span> : null}
        {canTrace && (
          <button onClick={() => setOpen((v) => !v)} className="mono lift" style={{ ...ACTION_PILL, marginLeft: 8, fontSize: 10, padding: "1px 7px" }}>
            {open ? "▾ close" : "🔎 trace"}
          </button>
        )}
        {o.isPerson && (
          <button onClick={loadPort} className="mono lift" style={{ ...ACTION_PILL, marginLeft: 6, fontSize: 10, padding: "1px 7px" }}>
            ▸ buildings
          </button>
        )}
      </div>
      {open && <ContactReveal key={target.deal_id} r={target} pw={pw} autoRun />}
      {port === "loading" && <div style={{ fontSize: 11, color: C.muted, marginLeft: 14 }}>Finding their other buildings…</div>}
      {port && typeof port === "object" && port.shown && (
        <div style={{ marginLeft: 14, marginTop: 3, fontSize: 11.5 }}>
          {port.buildings.length === 0 ? (
            <span style={{ color: C.muted }}>No other HPD-registered buildings under this person.</span>
          ) : (
            <>
              <div className="mono" style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>{port.buildings.length} building{port.buildings.length === 1 ? "" : "s"} where {o.name} is on the HPD registration:</div>
              {port.buildings.slice(0, 30).map((b, i) => (
                <div key={i} style={{ color: C.ivory }}>
                  <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.address}, ${b.borough} NY`)}`} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{b.address}</a>
                  <span style={{ color: C.muted }}> · {b.borough}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PropertyDetail({ r, pw }) {
  const [hist, setHist] = useState(null);
  const [histErr, setHistErr] = useState("");
  const [port, setPort] = useState(null);
  const [intel, setIntel] = useState(null);
  const [comps, setComps] = useState(null);
  const [foot, setFoot] = useState(null);
  const canHist = !!(r.borough && r.block && r.lot);

  useEffect(() => {
    let live = true;
    if (canHist) {
      fetch("/api/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw, borough: r.borough, block: r.block, lot: r.lot }) })
        .then((res) => res.json())
        .then((d) => { if (live) { d.error ? setHistErr(d.error) : setHist(d.history || []); } })
        .catch((e) => { if (live) setHistErr(e.message || "Could not load history."); });
    }
    fetch("/api/owner", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw, name: r.name }) })
      .then((res) => res.json())
      .then((d) => { if (live) setPort(d.error ? { properties: [] } : d); })
      .catch(() => { if (live) setPort({ properties: [] }); });
    fetch("/api/intel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw, borough: r.borough, block: r.block, lot: r.lot, name: r.name }) })
      .then((res) => res.json())
      .then((d) => { if (live) setIntel(d.error ? {} : d); })
      .catch(() => { if (live) setIntel({}); });
    if (r.borough && r.block) {
      fetch("/api/comps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw, borough: r.borough, block: r.block }) })
        .then((res) => res.json())
        .then((d) => { if (live) setComps(d.error ? [] : (d.comps || [])); })
        .catch(() => { if (live) setComps([]); });
    }
    if (r.lat != null && r.lon != null) {
      fetch("/api/foottraffic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw, lat: r.lat, lon: r.lon }) })
        .then((res) => res.json())
        .then((d) => { if (live) setFoot(d.error ? {} : d); })
        .catch(() => { if (live) setFoot({}); });
    }
    return () => { live = false; };
    // eslint-disable-next-line
  }, []);

  const title = { fontSize: 10.5, color: C.muted, letterSpacing: "0.06em", margin: "16px 0 7px" };
  const muted = { color: C.muted, fontSize: 12, padding: "8px 0" };
  return (
    <div style={{ paddingTop: 8 }}>
      <OutreachStudio ctx={outreachCtx({ owner: r.name, address: r.address, marketLabel: "NYC", raw: r })} pw={pw} />
      <ResearchBrief r={r} pw={pw} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 22 }}>
      <div>
        <PropertyPhoto r={r} pw={pw} />
        <div className="mono" style={{ ...title, marginTop: 0 }}>HOW TO REACH</div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{r.name} <span style={{ color: C.muted, fontWeight: 400, fontSize: 12 }}>· {r.entity_type}</span></div>
        <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>
          {mailing(r) || "mailing address not on record"}
          {r.absentee && <span className="mono" style={{ marginLeft: 6, fontSize: 9.5, padding: "1px 6px", borderRadius: 5, background: C.goldSoft, color: C.amber }}>{r.absentee === "out-of-state" ? "OUT-OF-STATE" : "OUT-OF-AREA"}</span>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {lookupLinks(r).map((lk) => <a key={lk.label} href={lk.href} target="_blank" rel="noreferrer" className="mono lift" style={ACTION_PILL}>{lk.label}</a>)}
        </div>
        {/* Free contacts we already have — business phone lines on file + NY registered
            contact. (Phones are the TENANT's business line, not the owner's cell.) */}
        {intel && (() => {
          const phones = []; const seen = new Set();
          (intel.businesses || []).forEach((b) => { const p = (b.phone || "").trim(); if (p && !seen.has(p)) { seen.add(p); phones.push({ phone: p, name: b.name }); } });
          const nyc = intel.ny_corp;
          if (!phones.length && !(nyc && nyc.process_name)) return null;
          return (
            <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
              {phones.length > 0 && (
                <div>
                  <span style={{ color: C.ivory }}>Phones on file (free):</span>
                  {phones.slice(0, 4).map((p, i) => (
                    <div key={i}>
                      <a href={`tel:${p.phone.replace(/[^0-9+]/g, "")}`} style={{ color: C.green, textDecoration: "none" }}>📞 {p.phone}</a>
                      <span style={{ color: C.muted }}> — {p.name} (tenant)</span>
                    </div>
                  ))}
                </div>
              )}
              {nyc && nyc.process_name && (
                <div style={{ color: C.muted, marginTop: phones.length ? 4 : 0 }}>
                  <span style={{ color: C.ivory }}>NY registered contact:</span> {nyc.process_name}{nyc.process_address ? ` — ${nyc.process_address}` : ""}
                </div>
              )}
            </div>
          );
        })()}
        <ContactReveal r={r} pw={pw} />
        <OwnerPeople r={r} pw={pw} market="nyc" />

        <div className="mono" style={title}>PROPERTY</div>
        <div style={{ fontSize: 13 }}>
          <a href={mapUrl(r)} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{r.address || "—"} ↗</a>
          <div style={{ color: C.muted, marginTop: 2 }}>
            {[r.borough, r.doc_type && `class ${r.doc_type}`].filter(Boolean).join(" · ")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", marginTop: 8, fontSize: 12.5 }}>
            <div style={{ color: C.muted }}>Frontage</div>
            <div style={{ color: C.ivory }}>{r.frontage_ft ? <strong style={{ color: C.gold }}>{Number(r.frontage_ft).toLocaleString()} ft</strong> : <span style={{ color: C.muted }}>—</span>}{r.num_floors ? <span style={{ color: C.muted }}> · {Number(r.num_floors)} floor{Number(r.num_floors) === 1 ? "" : "s"}</span> : null}</div>
            <div style={{ color: C.muted }}>Retail SF</div>
            <div style={{ color: C.ivory }}>{r.retail_sqft ? `${Number(r.retail_sqft).toLocaleString()} SF` : <span style={{ color: C.muted }}>none recorded</span>}</div>
            <div style={{ color: C.muted }}>Building SF</div>
            <div style={{ color: C.ivory }}>{r.bldg_sqft ? `${Number(r.bldg_sqft).toLocaleString()} SF` : "—"}{r.lot_sqft ? <span style={{ color: C.muted }}> · lot {Number(r.lot_sqft).toLocaleString()} SF</span> : null}</div>
            {(() => {
              // Floor-area breakdown by USE (PLUTO has no per-floor SF). Show the non-overlapping
              // use buckets that are present, plus an average SF/floor (total ÷ floors).
              const parts = [
                ["retail", r.retail_sqft], ["office", r.office_sqft], ["residential", r.res_sqft],
                ["garage", r.garage_sqft], ["storage", r.storage_sqft], ["factory", r.factory_sqft], ["other", r.other_sqft],
              ].filter(([, sf]) => Number(sf) > 0);
              if (!parts.length && !r.avg_floor_sqft) return null;
              return (<>
                <div style={{ color: C.muted }}>Floor area</div>
                <div style={{ color: C.ivory }}>
                  {parts.length ? parts.map(([lab, sf], i) => (
                    <span key={lab}>{i ? <span style={{ color: C.muted }}> · </span> : null}{Number(sf).toLocaleString()} <span style={{ color: C.muted }}>{lab}</span></span>
                  )) : <span style={{ color: C.muted }}>not split by use</span>}
                  {r.avg_floor_sqft ? <span style={{ color: C.muted }}> · ~{Number(r.avg_floor_sqft).toLocaleString()} SF/floor avg</span> : null}
                </div>
              </>);
            })()}
            <div style={{ color: C.muted }}>Assessed value</div>
            <div style={{ color: C.ivory }}>{assessedValue(r) != null ? fmtAmount(assessedValue(r)) : "—"} <span style={{ color: C.muted, fontSize: 11 }}>(City tax assessment)</span></div>
            <div style={{ color: C.muted }}>Purchase price</div>
            <div style={{ color: C.ivory }}>
              {purchasePrice(r) != null && purchasePrice(r) !== "" ? fmtAmount(purchasePrice(r)) : "—"}
              {purchaseDate(r) && <span style={{ color: C.muted }}> · bought {purchaseDate(r)}</span>}
              {r.years_owned != null && <span style={{ color: r.years_owned >= 15 ? C.green : C.muted }}> · {r.years_owned}y owned</span>}
            </div>
            <div style={{ color: C.muted }}>Recorded debt</div>
            <div style={{ color: C.ivory }}>
              {(() => {
                const debt = latestDebt(hist);
                if (debt === undefined) return <span style={{ color: C.muted }}>…</span>;
                if (debt === null) return <span style={{ color: C.muted }}>none on record</span>;
                const matCol = debt.maturity && debt.maturity.level === "high" ? C.amber : C.gold;
                return (
                  <>
                    <div>
                      {debt.amount != null ? fmtAmount(debt.amount) : "—"}
                      {debt.date && <span style={{ color: C.muted }}> · {String(debt.date).slice(0, 4)}</span>}
                      {debt.lender && <span style={{ color: C.muted }}> · {debt.lender}</span>}
                      {debt.satisfied
                        ? <span className="mono" style={{ marginLeft: 6, fontSize: 9.5, color: C.green, border: `1px solid ${C.green}`, borderRadius: 4, padding: "0 5px" }}>LIKELY SATISFIED</span>
                        : debt.maturity
                          ? <span className="mono" style={{ marginLeft: 6, fontSize: 9.5, color: matCol, border: `1px solid ${matCol}`, borderRadius: 4, padding: "0 5px" }}>⏰ LIKELY MATURING</span>
                          : <span style={{ color: C.muted, fontSize: 11 }}> (orig. amount)</span>}
                    </div>
                    {!debt.satisfied && debt.maturity && (
                      <div style={{ color: C.muted, fontSize: 11, marginTop: 1 }}>{debt.maturity.text}</div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
          {r.buildable_sqft > 0 && <div style={{ color: C.green, marginTop: 2 }}>▲ {Number(r.buildable_sqft).toLocaleString()} sf unused air rights (built {r.built_far} / max {r.max_far} FAR)</div>}
        </div>

        {r.lat != null && r.lon != null && (
          <>
            <div className="mono" style={title}>FOOT TRAFFIC</div>
            {foot == null ? <div style={muted}>Loading…</div> : (
              <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                {foot.ped && foot.ped.count != null ? (
                  <div>
                    <span style={{ color: C.ivory }}>Pedestrians:</span> <strong style={{ color: C.gold }}>{Number(foot.ped.count).toLocaleString()}</strong> <span style={{ color: C.muted }}>({foot.ped.period}, DOT count {foot.ped.on ? `on ${foot.ped.on}` : ""}{foot.ped.between ? ` btw ${foot.ped.between}` : ""} · {foot.ped.distance_mi} mi away)</span>
                  </div>
                ) : (
                  <div style={{ color: C.muted }}>No DOT pedestrian-count site nearby (only ~114 citywide).</div>
                )}
                {foot.subway && foot.subway.station ? (
                  <div><span style={{ color: C.ivory }}>Nearest subway:</span> {foot.subway.station} <span className="mono" style={{ color: C.gold, fontSize: 11 }}>{foot.subway.routes}</span> <span style={{ color: C.muted }}>· {foot.subway.distance_mi} mi</span></div>
                ) : null}
              </div>
            )}
          </>
        )}

        {(r.zoning || r.overlay || r.special_district || r.landmark || r.hist_district) && (
          <>
            <div className="mono" style={title}>RETAIL ZONING / DESIGNATION</div>
            <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.7 }}>
              {(r.zoning || r.overlay) && (
                <div>Zoning: <span style={{ color: C.ivory }}>{r.zoning || "—"}</span>{r.overlay ? <> · retail overlay <span style={{ color: C.green }}>{r.overlay}</span></> : <span style={{ color: C.muted }}> · no commercial overlay</span>}</div>
              )}
              {r.special_district && <div>Special district: <span style={{ color: C.gold }}>{r.special_district}</span> <span style={{ fontSize: 11 }}>(signage/use overlay)</span></div>}
              {(r.landmark || r.hist_district) && (
                <div style={{ color: C.amber }}>⚑ {[r.landmark, r.hist_district && `${r.hist_district} historic district`].filter(Boolean).join(" · ")} — facade/alterations restricted</div>
              )}
            </div>
          </>
        )}

        <div className="mono" style={title}>ON-MARKET / AVAILABILITY</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {onMarketLinks(r).map((lk) => <a key={lk.label} href={lk.href} target="_blank" rel="noreferrer" className="mono lift" style={ACTION_PILL}>{lk.label} ↗</a>)}
        </div>
        <div style={{ color: C.muted, fontSize: 11, marginTop: 5 }}>No public feed of live availability — these check LoopNet/Crexi for any current listing.</div>

        <div className="mono" style={title}>STOREFRONT / BUSINESS</div>
        {intel == null ? <div style={muted}>Loading…</div> : (intel.businesses && intel.businesses.length > 0) ? (
          <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            {intel.businesses.map((bz, i) => (
              <div key={i} style={{ padding: "3px 0", borderTop: i ? `1px solid ${C.line}` : "none" }}>
                <span style={{ color: bz.status === "Active" ? C.ivory : C.muted, fontWeight: 600 }}>{bz.name}</span>
                {bz.status && bz.status !== "Active" && <span className="mono" style={{ marginLeft: 6, fontSize: 9.5, color: C.amber }}>{bz.status.toUpperCase()}</span>}
                <div style={{ color: C.muted }}>{[bz.category, bz.phone].filter(Boolean).join(" · ") || "—"}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={muted}>No licensed business on record at this lot. (Many retail tenants — clothing, banks, offices — don’t need a city license, so absence here doesn’t mean it’s vacant; check Street View / Google.)</div>
        )}

        {intel && intel.storefront && (
          <div style={{ marginTop: 10, background: intel.storefront.any_vacant ? "rgba(183,121,31,0.10)" : C.panel2, border: `1px solid ${intel.storefront.any_vacant ? C.amber : C.line}`, borderRadius: 8, padding: "9px 12px" }}>
            <div className="mono" style={{ fontSize: 9.5, color: C.muted, letterSpacing: "0.05em", marginBottom: 5 }}>
              STOREFRONT REGISTRY (LL157) · {intel.storefront.reporting_year}
              {intel.storefront.any_vacant && <span style={{ marginLeft: 6, color: C.amber, border: `1px solid ${C.amber}`, borderRadius: 4, padding: "0 5px" }}>VACANT</span>}
            </div>
            {intel.storefront.units.map((u, i) => (
              <div key={i} style={{ fontSize: 12, padding: "2px 0", color: C.ivory }}>
                {u.vacant ? <span style={{ color: C.amber, fontWeight: 600 }}>Vacant on Dec 31</span> : <span>{u.activity || "Occupied"}</span>}
                {u.lease_expiry && <span style={{ color: C.muted }}> · lease ends {u.lease_expiry}</span>}
              </div>
            ))}
            <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>Owner-reported under Local Law 157 — ground/2nd-floor commercial premises.</div>
          </div>
        )}

        <div className="mono" style={title}>PUBLIC RECORDS</div>
        {intel && (() => {
          const d = distressRead(intel, r);
          if (!d) return null;
          const col = d.level === "High" ? C.red : d.level === "Medium" ? C.amber : C.muted;
          return (
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 9.5, color: col, border: `1px solid ${col}`, borderRadius: 4, padding: "1px 6px" }}>DISTRESS · {d.level.toUpperCase()}</span>
              {d.reasons.length > 0 && <span style={{ color: C.muted, marginLeft: 8 }}>{d.reasons.join(" · ")}</span>}
            </div>
          );
        })()}
        {intel == null ? <div style={muted}>Loading…</div> : (
          <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {intel.ny_corp ? (
              <div>
                <span style={{ color: C.ivory }}>NY State registry:</span> {intel.ny_corp.name}{intel.ny_corp.entity_type ? ` · ${String(intel.ny_corp.entity_type).toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())}` : ""}{intel.ny_corp.filed ? ` · filed ${intel.ny_corp.filed}` : ""}
                {intel.ny_corp.process_name && (
                  <div style={{ color: C.muted }}>Registered contact: <span style={{ color: C.ivory }}>{intel.ny_corp.process_name}</span>{intel.ny_corp.process_address ? ` — ${intel.ny_corp.process_address}` : ""}</div>
                )}
              </div>
            ) : (
              <div style={{ color: C.muted }}>NY State registry: no match for this owner name (often an individual owner or a dissolved entity).</div>
            )}
            {intel.officers && intel.officers.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <span style={{ color: C.ivory }}>Officers / owners</span> <span style={{ color: C.muted, fontSize: 11 }}>(HPD registration)</span>
                {intel.officers.map((o, i) => <OfficerRow key={i} o={o} pw={pw} />)}
              </div>
            )}
            <div style={{ marginTop: 4 }}>
              <span style={{ color: C.ivory }}>Violations:</span>{" "}
              <span style={{ color: intel.dob_violations ? C.red : C.muted }}>DOB {intel.dob_violations || 0}</span> ·{" "}
              <span style={{ color: intel.ecb_violations ? C.red : C.muted }}>ECB {intel.ecb_violations || 0}{intel.ecb_balance_due ? ` ($${Number(intel.ecb_balance_due).toLocaleString()} due)` : ""}</span> ·{" "}
              <span style={{ color: intel.hpd_violations ? C.red : C.muted }}>HPD {intel.hpd_violations || 0} open</span>
            </div>
            <div style={{ marginTop: 4 }}>
              <span style={{ color: C.ivory }}>City records:</span>{" "}
              <span style={{ color: C.muted }}>311: {intel.complaints_311 || 0} (2yr)</span> ·{" "}
              <span style={{ color: C.muted }}>DOB permits: {intel.dob_permits || 0}</span> ·{" "}
              <span style={{ color: intel.evictions && intel.evictions.count ? (intel.evictions.commercial ? C.amber : C.muted) : C.muted }}>
                Evictions: {intel.evictions ? intel.evictions.count : 0}{intel.evictions && intel.evictions.commercial ? " (commercial)" : ""}{intel.evictions && intel.evictions.latest ? ` · last ${intel.evictions.latest}` : ""}
              </span>
              {intel.cofo && <> · <span style={{ color: C.muted }}>C of O: {intel.cofo.date}{intel.cofo.status ? ` (${intel.cofo.status.toLowerCase()})` : ""}</span></>}
            </div>
          </div>
        )}

        <div className="mono" style={title}>RESEARCH — more sources</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {researchLinks(r).map((lk) => <a key={lk.label} href={lk.href} target="_blank" rel="noreferrer" className="mono lift" style={ACTION_PILL}>{lk.label} ↗</a>)}
        </div>
      </div>

      <div>
        <div className="mono" style={{ ...title, marginTop: 0 }}>TENANT / LEASES</div>
        {!canHist ? <div style={muted}>No tax lot to look up.</div>
          : hist == null ? <div style={muted}>Loading…</div>
          : <TenantList hist={hist} />}

        <div className="mono" style={title}>DEED &amp; LEASE HISTORY</div>
        {!canHist ? <div style={muted}>No tax lot to look up.</div>
          : histErr ? <div style={{ ...muted, color: C.red }}>{histErr}</div>
          : hist == null ? <div style={muted}>Loading…</div>
          : hist.length === 0 ? <div style={muted}>No recorded ACRIS documents.</div>
          : <HistoryList hist={hist} />}

        <div className="mono" style={title}>OWNER PORTFOLIO — citywide</div>
        {port == null ? <div style={muted}>Loading…</div> : <PortfolioList data={port} ownerName={r.name} />}

        <div className="mono" style={title}>BLOCK SALE COMPS</div>
        {comps == null ? <div style={muted}>Loading…</div>
          : comps.length === 0 ? <div style={muted}>No recent recorded deed sales on this block.</div>
          : (
          <div style={{ padding: "6px 0" }}>
            <div className="mono" style={{ fontSize: 10.5, color: C.muted, letterSpacing: "0.05em", padding: "4px 0" }}>
              {comps.length} recorded sale{comps.length === 1 ? "" : "s"} on this block (ACRIS deeds, newest first)
            </div>
            {comps.map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 12, padding: "6px 0", borderTop: `1px solid ${C.line}`, fontSize: 12.5, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="mono" style={{ color: C.muted, width: 84 }}>{c.date || "—"}</span>
                <span style={{ flex: "1 1 160px", color: C.ivory }}>{c.address || "—"}</span>
                <span className="mono" style={{ color: C.green, whiteSpace: "nowrap" }}>{c.price ? "$" + Number(c.price).toLocaleString() : "—"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function PortfolioList({ data, ownerName }) {
  const props = (data && data.properties) || [];
  if (!props.length) {
    return <div style={{ color: C.muted, fontSize: 12, padding: "10px 0" }}>No other NYC properties under this owner name (common name variants matched). Developers often use a separate LLC per building, which public data can’t link — use the AI research / skip trace to connect the principal.</div>;
  }
  return (
    <div style={{ padding: "6px 0" }}>
      <div className="mono" style={{ fontSize: 10.5, color: C.muted, letterSpacing: "0.05em", padding: "4px 0" }}>
        OWNER PORTFOLIO — {props.length} NYC propert{props.length === 1 ? "y" : "ies"} under “{ownerName}”{data.total_assessed ? ` · $${Number(data.total_assessed).toLocaleString()} total assessed` : ""}
      </div>
      {props.map((p, i) => (
        <div key={i} style={{ display: "flex", gap: 12, padding: "6px 0", borderTop: `1px solid ${C.line}`, fontSize: 12.5, alignItems: "baseline", flexWrap: "wrap" }}>
          <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.address || ""}, ${p.borough || ""} NY`)}`} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none", flex: "1 1 220px" }}>{p.address || "—"} ↗</a>
          <span style={{ color: C.muted, width: 100 }}>{p.borough}</span>
          <span className="mono" style={{ color: C.muted, width: 50 }}>{p.bldgclass}</span>
          <span className="mono" style={{ color: C.muted, width: 120, whiteSpace: "nowrap" }}>{p.assessed ? "$" + Number(p.assessed).toLocaleString() : "—"}</span>
        </div>
      ))}
    </div>
  );
}

// Pull the lease documents out of the ACRIS history and surface the tenant (lessee)
// up front. On a recorded lease, ACRIS party_type 2 ("grantee/buyer") is the tenant
// and party_type 1 ("grantor/seller") is the landlord — relabel them in this context.
// Caveat: not every ground-floor retail lease is recorded in ACRIS, so absence here
// doesn't prove the space is vacant.
function TenantList({ hist }) {
  const leases = (hist || []).filter((h) => /lease/i.test(h.doc_label));
  if (!leases.length) {
    return <div style={{ color: C.muted, fontSize: 12, padding: "8px 0" }}>No recorded leases on this lot. (Many retail leases aren’t recorded in ACRIS — check the on-market links and Street View.)</div>;
  }
  const tenants = (p) => p.filter((x) => x.role === "grantee/buyer").map((x) => x.name);
  const landlords = (p) => p.filter((x) => x.role === "grantor/seller").map((x) => x.name);
  return (
    <div style={{ padding: "6px 0" }}>
      {leases.slice(0, 8).map((h, i) => {
        const t = tenants(h.parties);
        const ll = landlords(h.parties);
        const names = t.length ? t : h.parties.map((p) => p.name);
        return (
          <div key={i} style={{ padding: "7px 0", borderTop: i ? `1px solid ${C.line}` : "none", fontSize: 12.5 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600, color: C.ivory, flex: "1 1 200px" }}>{names.join(" · ") || "—"}</span>
              <span className="mono" style={{ color: C.muted, fontSize: 11 }}>{h.doc_label}{h.date ? ` · ${h.date}` : ""}</span>
            </div>
            {ll.length > 0 && <div style={{ color: C.muted, marginTop: 1 }}>landlord: {ll.join(" · ")}</div>}
          </div>
        );
      })}
    </div>
  );
}

function HistoryList({ hist }) {
  return (
    <div style={{ padding: "6px 0" }}>
      <div className="mono" style={{ fontSize: 10.5, color: C.muted, letterSpacing: "0.05em", padding: "4px 0" }}>
        TRANSACTION HISTORY — {hist.length} document{hist.length === 1 ? "" : "s"} (ACRIS)
      </div>
      {hist.map((h, i) => (
        <div key={i} style={{ display: "flex", gap: 12, padding: "6px 0", borderTop: `1px solid ${C.line}`, fontSize: 12.5, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className="mono" style={{ color: C.muted, width: 84 }}>{h.date || "—"}</span>
          <span style={{ width: 150, color: h.doc_type === "DEED" ? C.green : /lease/i.test(h.doc_label) ? "#3b82c4" : C.ivory }}>
            {h.document_id ? <a href={acrisDeedUrl(h.document_id)} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }} title="Open this document in ACRIS">{h.doc_label} ↗</a> : h.doc_label}
          </span>
          <span className="mono" style={{ width: 110, color: C.muted, whiteSpace: "nowrap" }}>{h.amount ? "$" + Number(h.amount).toLocaleString() : "—"}</span>
          <span style={{ color: C.muted, flex: "1 1 220px" }}>{h.parties.map((p) => p.name).join(" · ") || "—"}</span>
        </div>
      ))}
    </div>
  );
}

function SharedLeads({ pw }) {
  const [rows, setRows] = useState(null);
  const [stats, setStats] = useState([]);
  const [dbConfigured, setDbConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [f, setF] = useState({ status: "", source: "", q: "" });

  async function load() {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/leads", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw, action: "list", filters: f }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDbConfigured(data.dbConfigured !== false);
      setRows(data.rows || []); setStats(data.stats || []);
    } catch (e) { setError(e.message || "Could not load the shared list."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function setStatus(id, status) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
    await fetch("/api/leads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw, action: "update", id, status }),
    }).catch(() => {});
  }

  if (!dbConfigured) {
    return (
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 22, color: C.muted, fontSize: 13.5, lineHeight: 1.6 }}>
        <span className="serif" style={{ color: C.ivory, fontSize: 15 }}>No database connected.</span> The shared list needs a Postgres
        database. Create one (Vercel → Storage → Neon), run <span className="mono" style={{ color: C.gold }}>db/schema.sql</span>, set
        <span className="mono" style={{ color: C.gold }}> DATABASE_URL</span> in your Vercel env, and redeploy. Live sourcing and CSV export
        work without it. See <strong>SOURCING_SETUP.md</strong>.
      </div>
    );
  }

  const statusEditor = (r) => (
    <select value={r.status || "new"} onChange={(e) => setStatus(r.id, e.target.value)}
      style={{ ...fieldStyle, padding: "5px 8px", color: STATUS_COLOR[r.status] || C.ivory, fontFamily: "IBM Plex Mono, monospace", fontSize: 12 }}>
      {["new", "working", "contacted", "dead"].map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
        <label>
          <div className="mono" style={labelStyle}>STATUS</div>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={{ ...fieldStyle, marginTop: 4 }}>
            {["", "new", "working", "contacted", "dead"].map((s) => <option key={s} value={s}>{s || "All"}</option>)}
          </select>
        </label>
        <label>
          <div className="mono" style={labelStyle}>SOURCE</div>
          <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} style={{ ...fieldStyle, marginTop: 4 }}>
            {["", "acris", "dob"].map((s) => <option key={s} value={s}>{s || "All"}</option>)}
          </select>
        </label>
        <label style={{ flex: "1 1 180px" }}>
          <div className="mono" style={labelStyle}>SEARCH NAME / ADDRESS</div>
          <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="e.g. LLC, Madison Ave" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} />
        </label>
        <button onClick={load} className="mono lift" style={{ cursor: "pointer", fontSize: 12, padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold }}>↻ APPLY</button>
        {rows && rows.length > 0 && (
          <button onClick={() => downloadBlob(leadsToCSV(rows), "frontage_shared_leads.csv", "text/csv")} className="mono lift"
            style={{ cursor: "pointer", fontSize: 12, padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ CSV</button>
        )}
      </div>

      {stats.length > 0 && (
        <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
          {stats.map((s) => (
            <span key={s.status} className="mono" style={{ fontSize: 12, color: STATUS_COLOR[s.status] || C.muted }}>
              {s.n} {s.status}
            </span>
          ))}
        </div>
      )}

      {error && <div style={{ marginBottom: 12, color: C.red, fontSize: 13 }}>{error}</div>}
      {loading && <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>}
      {rows && !loading && rows.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No saved leads yet. Source some on the “Source live” tab and check “Save to the shared list”.</div>}
      {rows && rows.length > 0 && <LeadTable rows={rows} statusEditor={statusEditor} pw={pw} />}
    </div>
  );
}

/* ============================== NDA REVIEW ==============================
   Fourth workflow. Reads an NDA (paste or PDF) and redlines it clause-by-clause
   against the firm's editable playbook of negotiating positions, flagging each
   clause Keep / Revise / Cut / Flag plus a list of missing protections.
   Backed by api/nda.js (Anthropic call, key server-side). Mirrors the screener:
   editable criteria + free-text rules + saved named playbooks in localStorage. */

const NDA_PRESETS_KEY = "fr_nda_presets_v1";
const NDA_ACTIVE_KEY = "fr_nda_active_v1";

// Mirrors api/nda.js DEFAULT_POSITIONS so the editor and the prompt agree.
const DEFAULT_NDA_CONFIG = {
  name: "Acquisitions NDA",
  perspective: "Receiving Party (we are receiving the counterparty's confidential information and reviewing their draft)",
  positions: [
    { id: "mutual", label: "Mutuality", desc: "Obligations should run both ways (mutual NDA), not bind only us.", want: "include" },
    { id: "term", label: "Confidentiality term", desc: "Finite, capped term — prefer 2 years from disclosure, 3 max.", want: "limit" },
    { id: "carveouts", label: "Standard carve-outs", desc: "Exclude info that is public, already known, independently developed, or rightfully received from a third party.", want: "include" },
    { id: "reps", label: "Permitted disclosures", desc: "Allow sharing with affiliates, employees, lenders, advisors on a need-to-know basis.", want: "include" },
    { id: "compelled", label: "Compelled disclosure", desc: "Permit disclosure required by law/subpoena/regulator with notice, without breach.", want: "include" },
    { id: "noncompete", label: "Non-compete / no-investment", desc: "Strike clauses barring us from pursuing the asset, the market, or competing deals.", want: "remove" },
    { id: "noncircumvent", label: "Non-circumvention / exclusivity", desc: "Strike broad non-circumvention, exclusivity, or no-contact terms.", want: "remove" },
    { id: "nonsolicit", label: "Non-solicitation", desc: "No-hire acceptable only if narrow and short (≤1yr, no general ads).", want: "limit" },
    { id: "standstill", label: "Standstill", desc: "Strike standstill provisions restricting our ability to transact, bid, or acquire.", want: "remove" },
    { id: "defn", label: "Definition scope", desc: "Confidential Information should be bounded (marked/identified), not everything exchanged.", want: "limit" },
    { id: "return", label: "Return / destruction", desc: "Return-or-destroy is fine, but preserve a retention carve-out for legal/archival/auto-backup copies.", want: "limit" },
    { id: "remedies", label: "Remedies & liability", desc: "Strike indemnification, liquidated damages, fee-shifting; injunctive relief OK.", want: "remove" },
    { id: "residuals", label: "Residuals", desc: "Acceptable to keep a residuals clause protecting unaided memory / general knowledge.", want: "include" },
    { id: "law", label: "Governing law / venue", desc: "Prefer New York law and NY venue; flag anything else.", want: "limit" },
    { id: "term_assign", label: "Assignment & survival", desc: "Flag broad assignment rights and perpetual survival of obligations.", want: "limit" },
  ],
  commands: "",
};

function loadNdaPresets() {
  try { const p = JSON.parse(localStorage.getItem(NDA_PRESETS_KEY)); if (p && typeof p === "object" && Object.keys(p).length) return p; } catch {}
  return { [DEFAULT_NDA_CONFIG.name]: clone(DEFAULT_NDA_CONFIG) };
}
function loadNdaActive() {
  try { const a = JSON.parse(localStorage.getItem(NDA_ACTIVE_KEY)); if (a && Array.isArray(a.positions)) return a; } catch {}
  return clone(DEFAULT_NDA_CONFIG);
}

const NDA_VERDICT = {
  Keep: { color: C.green, soft: "rgba(31,157,99,0.10)", label: "KEEP" },
  Revise: { color: C.amber, soft: "rgba(183,121,31,0.12)", label: "REVISE" },
  Cut: { color: C.red, soft: "rgba(209,74,60,0.10)", label: "CUT" },
  Flag: { color: C.gold, soft: C.goldSoft, label: "FLAG" },
};
const ndaVerdict = (v) => NDA_VERDICT[v] || NDA_VERDICT.Flag;
const NDA_WANT = { include: "Leave in", limit: "Narrow / limit", remove: "Take out" };

const SAMPLE_NDA = `MUTUAL NON-DISCLOSURE AGREEMENT

This Agreement is entered into between Meridian Capital Partners LLC ("Disclosing Party") and the recipient ("Receiving Party").

1. CONFIDENTIAL INFORMATION. "Confidential Information" means all information disclosed by either party, in any form, whether or not marked confidential, including all information the Receiving Party learns or observes.

2. TERM. The Receiving Party's obligations under this Agreement shall survive in perpetuity.

3. NON-DISCLOSURE. The Receiving Party shall not disclose Confidential Information to any third party for any purpose without prior written consent.

4. NON-CIRCUMVENTION. For a period of three (3) years, the Receiving Party shall not, directly or indirectly, contact, negotiate with, or transact with any property owner, broker, or counterparty introduced through the Confidential Information, nor pursue any acquisition in the subject market.

5. NON-COMPETE. The Receiving Party agrees not to acquire, invest in, or pursue any competing property within one mile of the subject asset for two (2) years.

6. RETURN OF MATERIALS. Upon request, the Receiving Party shall immediately return or destroy all Confidential Information and all copies, with no exceptions.

7. REMEDIES. The Receiving Party agrees that any breach causes irreparable harm, shall indemnify the Disclosing Party for all losses, and shall pay liquidated damages of $250,000 per breach plus the Disclosing Party's attorneys' fees.

8. GOVERNING LAW. This Agreement is governed by the laws of the State of Delaware, and the parties consent to exclusive jurisdiction in Wilmington, Delaware.

9. NO LICENSE. Nothing herein grants any license or rights beyond the limited review purpose stated.`;

function NDAReview({ pw }) {
  const [config, setConfigState] = useState(loadNdaActive);
  const [presets, setPresetsState] = useState(loadNdaPresets);
  const [showPlaybook, setShowPlaybook] = useState(false);

  const [mode, setMode] = useState("text");
  const [ndaText, setNdaText] = useState("");
  const [pdfData, setPdfData] = useState(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState("all");
  const fileRef = useRef(null);

  function setConfig(updater) {
    setConfigState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem(NDA_ACTIVE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }
  function setPresets(next) {
    setPresetsState(next);
    try { localStorage.setItem(NDA_PRESETS_KEY, JSON.stringify(next)); } catch {}
  }

  function onFile(f) {
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setPdfData(reader.result.split(",")[1]);
    reader.readAsDataURL(f);
  }

  async function review() {
    setError(""); setResult(null); setLoading(true);
    setProgress("Reading the agreement…");
    try {
      if (mode === "pdf") {
        if (!pdfData) { setError("Upload an NDA PDF first."); setLoading(false); return; }
      } else if (!ndaText.trim()) {
        setError("Paste the NDA text or load the sample."); setLoading(false); return;
      }
      setProgress("Redlining each clause against your playbook…");
      const res = await fetch("/api/nda", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, pdfData, ndaText, password: pw, config }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const start = text.indexOf("{"); const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("Could not read a structured result. Try again or check the document.");
      setResult(JSON.parse(text.slice(start, end + 1)));
    } catch (e) {
      setError(e.message || "Something went wrong. Try again.");
    } finally {
      setLoading(false); setProgress("");
    }
  }

  function exportCSV() {
    if (!result) return;
    const rows = [["Title", "Verdict", "Risk", "Playbook", "Excerpt", "Rationale", "Suggested language"]];
    (result.clauses || []).forEach((c) =>
      rows.push([c.title || "", c.verdict || "", c.risk || "", c.playbook_ref || "", c.excerpt || "", c.rationale || "", c.suggested_language || ""]));
    (result.missing || []).forEach((m) =>
      rows.push([m.title || "", "Missing", "", "", "", m.why || "", m.suggested_language || ""]));
    const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadBlob(csv, "frontage_nda_review.csv", "text/csv");
  }

  const clauses = (result && result.clauses) || [];
  const shown = filter === "all" ? clauses : clauses.filter((c) => c.verdict === filter);
  const counts = useMemo(() => {
    const c = { Keep: 0, Revise: 0, Cut: 0, Flag: 0 };
    clauses.forEach((x) => { if (c[x.verdict] != null) c[x.verdict]++; });
    return c;
  }, [clauses]);

  const label = { fontSize: 11, color: C.muted, letterSpacing: "0.05em" };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <button onClick={() => setShowPlaybook((s) => !s)} className="mono lift"
          style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, border: `1px solid ${showPlaybook ? C.gold : C.line}`, background: showPlaybook ? C.goldSoft : C.panel, color: showPlaybook ? C.gold : C.ivory }}>
          ⚙ NDA PLAYBOOK
        </button>
      </div>

      {showPlaybook && (
        <NDAPlaybook config={config} setConfig={setConfig} presets={presets} setPresets={setPresets} onClose={() => setShowPlaybook(false)} />
      )}

      {/* Input */}
      <div style={{ marginTop: 16, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {["text", "pdf"].map((m) => (
            <button key={m} onClick={() => setMode(m)} className="mono"
              style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, border: `1px solid ${mode === m ? C.gold : C.line}`, background: mode === m ? C.goldSoft : "transparent", color: mode === m ? C.gold : C.muted }}>
              {m === "text" ? "PASTE TEXT" : "UPLOAD PDF"}
            </button>
          ))}
          <button onClick={() => { setMode("text"); setNdaText(SAMPLE_NDA); }} className="mono"
            style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, marginLeft: "auto", border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>
            ✦ TRY SAMPLE NDA
          </button>
        </div>

        {mode === "text" ? (
          <textarea value={ndaText} onChange={(e) => setNdaText(e.target.value)} rows={8}
            placeholder="Paste the NDA / confidentiality agreement text here, or load the sample…"
            style={{ width: "100%", background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 9, padding: 14, fontSize: 13.5, lineHeight: 1.5, resize: "vertical", fontFamily: "Archivo, sans-serif" }} />
        ) : (
          <div onClick={() => fileRef.current?.click()} className="lift"
            style={{ cursor: "pointer", border: `1px dashed ${C.line}`, borderRadius: 9, padding: "30px 16px", textAlign: "center", background: C.ink }}>
            <div style={{ color: C.gold, fontSize: 22 }} className="serif">↑</div>
            <div style={{ marginTop: 6, fontSize: 14 }}>{fileName || "Drop an NDA PDF, or click to browse"}</div>
            <input ref={fileRef} type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e) => onFile(e.target.files[0])} />
          </div>
        )}

        <button onClick={review} disabled={loading}
          style={{ marginTop: 14, width: "100%", cursor: loading ? "default" : "pointer", border: "none", borderRadius: 9, padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em", background: loading ? C.panel2 : C.gold, color: loading ? C.muted : "#ffffff" }}>
          {loading ? progress || "Working…" : `Review against “${config.name}” →`}
        </button>
        {error && <div style={{ marginTop: 12, color: C.red, fontSize: 13 }}>{error}</div>}
      </div>

      {result && (
        <div className="fade" style={{ marginTop: 18 }}>
          {/* Summary */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="serif" style={{ fontSize: 20 }}>{result.doc_type || "NDA review"}</div>
                <div className="mono" style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.6 }}>
                  {result.parties ? <>PARTIES · {result.parties}<br /></> : null}
                  {result.mutual != null ? <>{result.mutual ? "MUTUAL" : "ONE-WAY"} · </> : null}
                  {result.term ? <>TERM {result.term} · </> : null}
                  {result.governing_law ? <>LAW {result.governing_law}</> : null}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="mono" style={label}>OVERALL RISK</div>
                <div className="serif" style={{ fontSize: 26, color: result.risk_level === "High" ? C.red : result.risk_level === "Medium" ? C.amber : C.green }}>
                  {result.risk_level || "—"}
                </div>
              </div>
            </div>
            {result.overall_assessment && (
              <div style={{ marginTop: 12, fontSize: 13.5, lineHeight: 1.6, color: C.ivory }}>{result.overall_assessment}</div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
              {["all", "Keep", "Revise", "Cut", "Flag"].map((v) => {
                const active = filter === v;
                const meta = v === "all" ? null : ndaVerdict(v);
                const n = v === "all" ? clauses.length : counts[v];
                return (
                  <button key={v} onClick={() => setFilter(v)} className="mono"
                    style={{ cursor: "pointer", fontSize: 11.5, padding: "6px 11px", borderRadius: 7, border: `1px solid ${active ? (meta ? meta.color : C.gold) : C.line}`, background: active ? (meta ? meta.soft : C.goldSoft) : "transparent", color: active ? (meta ? meta.color : C.gold) : C.muted }}>
                    {v === "all" ? "ALL" : ndaVerdict(v).label} · {n}
                  </button>
                );
              })}
              <button onClick={exportCSV} className="mono lift" style={{ cursor: "pointer", fontSize: 11.5, padding: "6px 11px", borderRadius: 7, marginLeft: "auto", border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ CSV</button>
            </div>
          </div>

          {/* Clauses */}
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {shown.map((c, i) => {
              const v = ndaVerdict(c.verdict);
              return (
                <div key={i} style={{ background: C.panel, border: `1px solid ${C.line}`, borderLeft: `4px solid ${v.color}`, borderRadius: 10, padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                    <div className="serif" style={{ fontSize: 16 }}>{c.title}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {c.risk && <span className="mono" style={{ fontSize: 10.5, color: c.risk === "High" ? C.red : c.risk === "Medium" ? C.amber : C.muted }}>{String(c.risk).toUpperCase()} RISK</span>}
                      <span className="mono" style={{ fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 6, background: v.soft, color: v.color }}>{v.label}</span>
                    </div>
                  </div>
                  {c.excerpt && (
                    <div style={{ marginTop: 8, fontSize: 12.5, color: C.muted, fontStyle: "italic", borderLeft: `2px solid ${C.line}`, paddingLeft: 10, lineHeight: 1.5 }}>“{c.excerpt}”</div>
                  )}
                  <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.6 }}>{c.rationale}</div>
                  {c.playbook_ref && <div className="mono" style={{ marginTop: 8, fontSize: 10.5, color: C.muted }}>PLAYBOOK · {c.playbook_ref}</div>}
                  {c.suggested_language && (
                    <div style={{ marginTop: 10, background: v.soft, border: `1px solid ${v.color}33`, borderRadius: 8, padding: "10px 12px" }}>
                      <div className="mono" style={{ fontSize: 10, color: v.color, letterSpacing: "0.06em", marginBottom: 5 }}>SUGGESTED REDLINE</div>
                      <div style={{ fontSize: 13, lineHeight: 1.55, fontFamily: "IBM Plex Mono, monospace", color: C.ivory }}>{c.suggested_language}</div>
                    </div>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No clauses in this category.</div>}
          </div>

          {/* Missing protections */}
          {Array.isArray(result.missing) && result.missing.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="mono" style={{ fontSize: 12, color: C.gold, letterSpacing: "0.1em", marginBottom: 10 }}>MISSING PROTECTIONS — CONSIDER ADDING</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {result.missing.map((m, i) => (
                  <div key={i} style={{ background: C.panel, border: `1px dashed ${C.gold}66`, borderRadius: 10, padding: 16 }}>
                    <div className="serif" style={{ fontSize: 15 }}>{m.title}</div>
                    <div style={{ marginTop: 8, fontSize: 13.5, lineHeight: 1.6 }}>{m.why}</div>
                    {m.suggested_language && (
                      <div style={{ marginTop: 10, background: C.goldSoft, border: `1px solid ${C.gold}33`, borderRadius: 8, padding: "10px 12px" }}>
                        <div className="mono" style={{ fontSize: 10, color: C.gold, letterSpacing: "0.06em", marginBottom: 5 }}>SUGGESTED CLAUSE</div>
                        <div style={{ fontSize: 13, lineHeight: 1.55, fontFamily: "IBM Plex Mono, monospace", color: C.ivory }}>{m.suggested_language}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mono" style={{ marginTop: 18, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
            ⚠ AI-assisted review against your playbook — a drafting aid, not legal advice. Have counsel confirm before signing.
          </div>
        </div>
      )}

      {!result && !loading && (
        <div style={{ marginTop: 18, color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
          <span className="serif" style={{ color: C.ivory, fontSize: 15 }}>What this does.</span> Reads an NDA, walks it clause by clause, and
          flags each one <strong style={{ color: C.green }}>Keep</strong> / <strong style={{ color: C.amber }}>Revise</strong> /{" "}
          <strong style={{ color: C.red }}>Cut</strong> / <strong style={{ color: C.gold }}>Flag</strong> against your firm's playbook —
          with suggested redline language and a list of protections the draft is missing. Tune what you'll leave in vs. take out in{" "}
          <strong>NDA Playbook</strong> above.
        </div>
      )}
    </>
  );
}

function NDAPlaybook({ config, setConfig, presets, setPresets, onClose }) {
  function updatePos(id, patch) {
    setConfig((prev) => ({ ...prev, positions: prev.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }
  function addPos() {
    setConfig((prev) => ({ ...prev, positions: [...prev.positions, { id: genId(), label: "New position", desc: "", want: "limit" }] }));
  }
  function removePos(id) {
    setConfig((prev) => ({ ...prev, positions: prev.positions.filter((p) => p.id !== id) }));
  }
  function loadPreset(name) { if (presets[name]) setConfig(clone(presets[name])); }
  function savePreset() {
    const name = (config.name || "Untitled").trim() || "Untitled";
    setPresets({ ...presets, [name]: clone({ ...config, name }) });
  }
  function deletePreset() {
    const name = config.name;
    if (!presets[name]) return;
    const next = { ...presets }; delete next[name];
    if (!Object.keys(next).length) next[DEFAULT_NDA_CONFIG.name] = clone(DEFAULT_NDA_CONFIG);
    setPresets(next);
    loadPreset(Object.keys(next)[0]);
  }

  const label = { fontSize: 11, color: C.muted, letterSpacing: "0.05em" };
  const field = { background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 7, padding: "8px 10px", fontSize: 13, fontFamily: "Archivo, sans-serif" };

  return (
    <div className="fade" style={{ marginTop: 14, background: C.panel, border: `1px solid ${C.gold}55`, borderRadius: 12, padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="serif" style={{ fontSize: 18 }}>NDA playbook</div>
        <button onClick={onClose} className="mono" style={{ cursor: "pointer", fontSize: 12, color: C.muted, background: "transparent", border: "none" }}>✕ CLOSE</button>
      </div>

      {/* Preset + name + perspective */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <div>
          <div className="mono" style={label}>SAVED PLAYBOOK</div>
          <select value={presets[config.name] ? config.name : ""} onChange={(e) => loadPreset(e.target.value)} style={{ ...field, marginTop: 4, minWidth: 150 }}>
            {!presets[config.name] && <option value="">{config.name} (unsaved)</option>}
            {Object.keys(presets).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <div className="mono" style={label}>NAME</div>
          <input value={config.name} onChange={(e) => setConfig((p) => ({ ...p, name: e.target.value }))} style={{ ...field, marginTop: 4, width: 150 }} />
        </div>
        <button onClick={savePreset} className="mono lift" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 7, border: `1px solid ${C.line}`, background: C.gold, color: "#fff" }}>SAVE</button>
        <button onClick={deletePreset} className="mono lift" style={{ cursor: "pointer", fontSize: 12, padding: "9px 14px", borderRadius: 7, border: `1px solid ${C.line}`, background: "transparent", color: C.muted }}>DELETE</button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="mono" style={label}>OUR ROLE / PERSPECTIVE</div>
        <input value={config.perspective} onChange={(e) => setConfig((p) => ({ ...p, perspective: e.target.value }))} style={{ ...field, marginTop: 4, width: "100%" }} />
      </div>

      {/* Positions */}
      <div className="mono" style={{ ...label, marginBottom: 8 }}>POSITIONS — WHAT TO LEAVE IN, NARROW, OR TAKE OUT</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {config.positions.map((p) => (
          <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", background: C.ink, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10 }}>
            <select value={p.want} onChange={(e) => updatePos(p.id, { want: e.target.value })} style={{ ...field, width: 130, flexShrink: 0 }}>
              {Object.entries(NDA_WANT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <input value={p.label} onChange={(e) => updatePos(p.id, { label: e.target.value })} style={{ ...field, fontWeight: 600 }} placeholder="Position" />
              <input value={p.desc} onChange={(e) => updatePos(p.id, { desc: e.target.value })} style={field} placeholder="What this means / the bound" />
            </div>
            <button onClick={() => removePos(p.id)} className="mono" style={{ cursor: "pointer", fontSize: 14, color: C.muted, background: "transparent", border: "none", padding: "4px 6px" }}>✕</button>
          </div>
        ))}
      </div>
      <button onClick={addPos} className="mono lift" style={{ cursor: "pointer", fontSize: 12, marginTop: 10, padding: "8px 14px", borderRadius: 7, border: `1px dashed ${C.line}`, background: "transparent", color: C.gold }}>+ ADD POSITION</button>

      <div style={{ marginTop: 16 }}>
        <div className="mono" style={label}>ADDITIONAL RULES (free text — applied strictly)</div>
        <textarea value={config.commands} onChange={(e) => setConfig((p) => ({ ...p, commands: e.target.value }))} rows={3}
          placeholder="e.g. Term must not exceed 18 months. Reject any exclusivity. We will not sign a standstill under any circumstances."
          style={{ ...field, marginTop: 4, width: "100%", resize: "vertical", lineHeight: 1.5 }} />
      </div>
    </div>
  );
}
