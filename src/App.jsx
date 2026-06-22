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
  ink: "#f4f4fb", panel: "#ffffff", panel2: "#eceaf7", line: "#e5e3f1",
  ivory: "#1b1930", muted: "#6c6982", gold: "#6a5cf6", goldSoft: "rgba(106,92,246,0.10)",
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

  // Which tool is showing: the OM screener or the NYC sourcing page.
  const [view, setView] = useState("screener");

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
      const res = await fetch("/api/screen", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, pdfData, memoText, password: pw, config }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
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
    <div style={{ background: C.ink, color: C.ivory, minHeight: "100vh", fontFamily: "Archivo, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
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
      `}</style>

      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "28px 22px 80px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", borderBottom: `1px solid ${C.line}`, paddingBottom: 18 }}>
          <div>
            <div className="serif" style={{ fontSize: 34, letterSpacing: "0.04em", fontWeight: 500, lineHeight: 1 }}>
              FRONTAGE<span style={{ color: C.gold }}>.</span>
            </div>
            <div className="mono" style={{ color: C.gold, fontSize: 10, marginTop: 7, letterSpacing: "0.22em" }}>
              TROPHY RETAIL ACQUISITIONS
            </div>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>
              {view === "agent"
                ? "Just ask. Scout runs the right engines — sourcing, intel, contacts, research — and hands back the read."
                : view === "screener"
                ? "Underwrite high-street flagship assets against your mandate."
                : view === "radar"
                ? "Scan a corridor for leases estimated to be coming available — off-market, before they list."
                : view === "nda"
                ? "Redline an NDA against your playbook — what to leave in, narrow, or strike."
                : view === "skiptrace"
                ? "Trace a name + address straight to graded phones & emails — charged only on a match."
                : "Source owners & deals from NYC public records — ACRIS · DOB · PLUTO."}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {/* Lease Radar deactivated 2026-06-17, NDA Review hidden 2026-06-22 (times out on Hobby's 60s limit) — re-add ["radar","LEASE RADAR"] / ["nda","NDA REVIEW"] to restore. Components + api endpoints left intact. */}
              {[["agent", "✦ AGENT"], ["screener", "SCREENER"], ["sourcing", "SOURCING"], ["skiptrace", "SKIP TRACE"]].map(([v, lab]) => (
                <button key={v} onClick={() => setView(v)} className="mono"
                  style={{ cursor: "pointer", fontSize: 12, padding: "6px 13px", borderRadius: 7, border: `1px solid ${view === v ? C.gold : C.line}`, background: view === v ? C.goldSoft : "transparent", color: view === v ? C.gold : C.muted }}>
                  {lab}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
            {view === "screener" && (
              <button onClick={() => setShowSettings((s) => !s)} className="mono lift"
                style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, border: `1px solid ${showSettings ? C.gold : C.line}`, background: showSettings ? C.goldSoft : C.panel, color: showSettings ? C.gold : C.ivory }}>
                ⚙ GRADING CRITERIA
              </button>
            )}
            <div className="mono" style={{ fontSize: 11, color: C.gold, textAlign: "right", lineHeight: 1.5 }}>
              POWERED BY CLAUDE<br /><span style={{ color: C.muted }}>{view === "agent" ? "Scout · orchestrator" : view === "screener" ? `mandate · ${config.name}` : view === "nda" ? "NDA playbook" : "ACRIS · DOB"}</span>
            </div>
          </div>
        </div>

        {view === "agent" && <AgentChat pw={pw} />}

        {view === "sourcing" && <Sourcing pw={pw} />}

        {view === "radar" && <LeaseRadar pw={pw} />}

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
    loadPreset(Object.keys(next)[0]);
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
  if (!res.ok) throw new Error(data.error || `Server error (HTTP ${res.status}).`);
  if (data.error) throw new Error(data.error);
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
  search_properties: { url: "/api/source", label: "Searching properties", body: (a) => ({ sources: ["pluto"], assetType: a.assetType || "retail", borough: a.borough, nearAddress: a.nearAddress, radiusMiles: a.radiusMiles || 0, limit: 50, minSqft: a.minSqft, minRetailSqft: a.minRetailSqft, minUnits: a.minUnits, builtAfter: a.builtAfter, builtBefore: a.builtBefore, devOnly: a.devOnly, minBuildable: a.minBuildable }) },
  property_intel: { url: "/api/intel", label: "Pulling public records", body: (a) => ({ borough: a.borough, block: a.block, lot: a.lot, name: a.name }) },
  transaction_history: { url: "/api/history", label: "Reading ACRIS history", body: (a) => ({ borough: a.borough, block: a.block, lot: a.lot }) },
  owner_portfolio: { url: "/api/owner", label: "Mapping owner portfolio", body: (a) => ({ name: a.name }) },
  hidden_portfolio: { url: "/api/portfolio", label: "Finding hidden portfolio", body: (a) => ({ name: a.name }) },
  foot_traffic: { url: "/api/foottraffic", label: "Checking foot traffic", body: (a) => ({ lat: a.lat, lon: a.lon }) },
  sales_comps: { url: "/api/comps", label: "Pulling sale comps", body: (a) => ({ borough: a.borough, block: a.block }) },
  web_research: { url: "/api/research", label: "Researching owner", body: (a) => ({ mode: "knowledge", name: a.name, address: a.address, borough: a.borough }) },
  reveal_contact: { url: "/api/skiptrace", label: "Revealing contact", paid: true, body: (a) => ({ name: a.name, entity_type: a.entity_type, contact_address: a.contact_address, city: a.city, state: a.state, zip: a.zip, address: a.address, borough: a.borough }) },
};

// Keep the model's view of a search result small (token + cost control): only the
// fields it needs to reason and to drive follow-on tools.
function pickLeadFields(r) {
  return {
    name: r.name, entity_type: r.entity_type, address: r.address, borough: r.borough,
    block: r.block, lot: r.lot, lat: r.lat, lon: r.lon,
    mailing: [r.contact_address, r.city, r.state, r.zip].filter(Boolean).join(", "),
    contact_address: r.contact_address, city: r.city, state: r.state, zip: r.zip,
    years_owned: r.years_owned, last_sale_date: r.last_sale_date, last_sale_price: r.last_sale_price,
    absentee: r.absentee || null, tax_lien: r.tax_lien || false, buildable_sqft: r.buildable_sqft || null,
    retail_sqft: r.retail_sqft || null, portfolio_count: r.portfolio_count || null,
    distance: r.distance ?? null,
  };
}

const SPEND_KEY = "fr_skiptrace_spend_v1";
function addSpend(amount) { try { const cur = Number(localStorage.getItem(SPEND_KEY)) || 0; localStorage.setItem(SPEND_KEY, String(cur + amount)); } catch { /* quota */ } }

// Trim/summarize an endpoint's response into { forModel, uiSummary }.
function shapeResult(name, data) {
  if (name === "search_properties") {
    const leads = (data.leads || []).slice(0, 25).map(pickLeadFields);
    const n = leads.length;
    return { forModel: { count: data.counts?.deals ?? n, center: data.center, leads }, uiSummary: `${n} propert${n === 1 ? "y" : "ies"}` };
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

function AgentChat({ pw }) {
  const [log, setLog] = useState([]);        // render transcript
  const [convo, setConvo] = useState([]);    // raw Anthropic-format messages
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const idRef = useRef(0);
  const scrollRef = useRef(null);

  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log, busy]);

  const pushTool = (name) => {
    const id = ++idRef.current;
    setLog((l) => [...l, { kind: "tool", id, name, label: TOOL_ROUTES[name]?.label || name, status: "running" }]);
    return id;
  };
  const updateTool = (id, status, detail) => setLog((l) => l.map((e) => (e.id === id ? { ...e, status, detail } : e)));

  const runTool = async (name, inputArgs) => {
    const route = TOOL_ROUTES[name];
    if (!route) return { forModel: { error: `Unknown tool ${name}` }, uiSummary: "unknown tool" };
    if (route.paid) {
      const ok = typeof window !== "undefined" && window.confirm(`This runs a PAID skip trace (~$0.10, billed only on a match) for ${inputArgs.name || "this owner"}. Proceed?`);
      if (!ok) return { forModel: { declined: true, note: "User declined the paid skip trace." }, uiSummary: "declined" };
    }
    const data = await postJSON(route.url, { password: pw, ...route.body(inputArgs) });
    return shapeResult(name, data);
  };

  // One request = run the agent loop to completion (or the safety step cap).
  const runLoop = async (messages) => {
    for (let turn = 0; turn < 10; turn++) {
      const data = await postJSON("/api/agent", { password: pw, messages });
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
        const id = pushTool(tu.name);
        try {
          const out = await runTool(tu.name, tu.input || {});
          updateTool(id, "done", out.uiSummary);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out.forModel).slice(0, 14000) });
        } catch (e) {
          updateTool(id, "error", e.message);
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: e.message });
        }
      }
      messages.push({ role: "user", content: results });
    }
    setConvo([...messages]);
    setLog((l) => [...l, { kind: "error", text: "Hit the step limit for one request. Ask me to continue if you need more." }]);
  };

  const send = async (preset) => {
    const text = (preset ?? input).trim();
    if (!text || busy) return;
    setInput("");
    const messages = [...convo, { role: "user", content: [{ type: "text", text }] }];
    setConvo(messages);
    setLog((l) => [...l, { kind: "user", text }]);
    setBusy(true);
    try { await runLoop(messages); }
    catch (e) { setLog((l) => [...l, { kind: "error", text: e.message }]); }
    finally { setBusy(false); }
  };

  const reset = () => { setLog([]); setConvo([]); };

  return (
    <div style={{ marginTop: 22 }}>
      <div ref={scrollRef} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, minHeight: 360, maxHeight: 560, overflowY: "auto" }}>
        {log.length === 0 && !busy && (
          <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
            <div style={{ color: C.ivory, fontWeight: 600, marginBottom: 8 }}>Hi — I'm Scout. ✦</div>
            Ask me to source owners, read a property, check distress, map a portfolio, or research who's behind an LLC. I'll run the right engines and give you the read. Try:
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
              {AGENT_EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => send(ex)} className="lift" style={{ textAlign: "left", cursor: "pointer", fontSize: 12.5, padding: "10px 13px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.ink, color: C.ivory }}>{ex}</button>
              ))}
            </div>
          </div>
        )}
        {log.map((e, i) => {
          if (e.kind === "user") return (
            <div key={i} style={{ display: "flex", justifyContent: "flex-end", margin: "12px 0" }}>
              <div style={{ maxWidth: "82%", background: C.goldSoft, border: `1px solid ${C.gold}40`, color: C.ivory, fontSize: 13, lineHeight: 1.5, padding: "9px 13px", borderRadius: "12px 12px 3px 12px" }}>{e.text}</div>
            </div>
          );
          if (e.kind === "assistant") return (
            <div key={i} style={{ margin: "12px 0", maxWidth: "92%" }}>
              <div className="mono" style={{ fontSize: 9.5, color: C.gold, letterSpacing: "0.18em", marginBottom: 5 }}>SCOUT</div>
              <ResearchBriefBody text={e.text} />
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
        {busy && <div className="mono" style={{ fontSize: 11, color: C.gold, marginTop: 10 }}>▸ Scout is working…</div>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input} onChange={(e) => setInput(e.target.value)} disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask Scout to source, screen, or research…"
          style={{ flex: 1, fontSize: 14, padding: "12px 14px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.panel, color: C.ivory }} />
        <button onClick={() => send()} disabled={busy || !input.trim()} className="mono lift"
          style={{ cursor: busy || !input.trim() ? "default" : "pointer", fontSize: 12, padding: "0 20px", borderRadius: 9, border: `1px solid ${C.gold}`, background: busy || !input.trim() ? C.panel : C.goldSoft, color: C.gold, opacity: busy || !input.trim() ? 0.5 : 1 }}>SEND</button>
        {log.length > 0 && <button onClick={reset} disabled={busy} className="mono" style={{ cursor: "pointer", fontSize: 12, padding: "0 14px", borderRadius: 9, border: `1px solid ${C.line}`, background: "transparent", color: C.muted }}>NEW</button>}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
        Scout runs your live engines (ACRIS · PLUTO · DOB · HPD · NY registry · foot traffic · AI research). Contact reveals are a paid skip trace and always ask first.
      </div>
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
function AddressAutocomplete({ value, onChange, onPick, placeholder, style }) {
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
      // 1) NYC GeoSearch — best for NYC and carries the lot's BBL.
      try {
        const r = await fetch(`https://geosearch.planninglabs.nyc/v2/autocomplete?text=${encodeURIComponent(text)}`);
        if (r.ok) {
          const d = await r.json();
          items = (d.features || [])
            .filter((f) => f.geometry && f.properties)
            .map((f) => ({ label: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], bbl: ((f.properties.addendum || {}).pad || {}).bbl || null }));
        }
      } catch { /* fall through to backup */ }
      // 2) Backup: Photon (free, no key, CORS-open) when GeoSearch is down/empty.
      //    No BBL — the backend then snaps to the nearest lot from the coordinates.
      if (items.length === 0) {
        try {
          const r = await fetch(`https://photon.komoot.io/api?q=${encodeURIComponent(text)}&limit=6&lat=40.75&lon=-73.98&bbox=-74.3,40.49,-73.69,40.92`);
          if (r.ok) {
            const d = await r.json();
            items = (d.features || [])
              .filter((f) => f.geometry)
              .map((f) => {
                const p = f.properties || {};
                const line1 = [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || "";
                const label = [line1, p.city || p.district, p.state].filter(Boolean).join(", ");
                return { label: label || p.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], bbl: null };
              })
              .filter((x) => x.label);
          }
        } catch { /* leave items empty */ }
      }
      setSugs(items); setOpen(items.length > 0);
    }, 220);
  }

  return (
    <div ref={box} style={{ position: "relative" }}>
      <input value={value} onChange={(e) => handle(e.target.value)} onFocus={() => sugs.length && setOpen(true)} placeholder={placeholder} autoComplete="off" style={style} />
      {open && (
        <div style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, right: 0, marginTop: 4, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, boxShadow: "0 10px 28px rgba(20,16,48,0.18)", maxHeight: 240, overflow: "auto" }}>
          {sugs.map((s, i) => (
            <div key={i} className="addr-opt" onClick={() => { onPick(s.label, s.lat, s.lon, s.bbl); setOpen(false); setSugs([]); }}
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

function Sourcing({ pw }) {
  const [sources, setSources] = useState({ acris: true, dob: true, pluto: true });
  const [borough, setBorough] = useState("");
  const [assetType, setAssetType] = useState("any");
  const [street, setStreet] = useState("");
  const [nearAddress, setNearAddress] = useState("");
  const [pickedCoords, setPickedCoords] = useState(null);
  const [radiusMiles, setRadiusMiles] = useState("");
  const [limit, setLimit] = useState(100);
  const [minSqft, setMinSqft] = useState("");
  const [minRetailSqft, setMinRetailSqft] = useState("");
  const [minUnits, setMinUnits] = useState("");
  const [builtAfter, setBuiltAfter] = useState("");
  const [builtBefore, setBuiltBefore] = useState("");
  const [devOnly, setDevOnly] = useState(false);
  const [minBuildable, setMinBuildable] = useState("");
  const [showMore, setShowMore] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [leads, setLeads] = useState(null);
  const [center, setCenter] = useState(null);
  const [saved, setSaved] = useState(() => new Set(loadSaved()));
  const [savedOnly, setSavedOnly] = useState(false);
  const toggleSave = (id) => setSaved((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); persistSaved([...n]); return n; });

  async function run() {
    setError(""); setLeads(null); setCenter(null);
    const picked = Object.keys(sources).filter((s) => sources[s]);
    if (!picked.length) { setError("Pick at least one source (ACRIS, DOB, or PLUTO)."); return; }
    setLoading(true);
    try {
      const data = await postJSON("/api/source", { password: pw, sources: picked, borough, assetType, street, nearAddress, radiusMiles, limit, minSqft, minRetailSqft, minUnits, builtAfter, builtBefore, devOnly, minBuildable, ...(pickedCoords ? { centerLat: pickedCoords.lat, centerLon: pickedCoords.lon, pickedBbl: pickedCoords.bbl } : {}) });
      setLeads(data.leads || []);
      setCenter(data.center || null);
    } catch (e) { setError(e.message || "Sourcing failed."); }
    finally { setLoading(false); }
  }

  function csvName() {
    const parts = ["frontage_leads"];
    if (borough) parts.push(borough.toLowerCase().replace(/\s+/g, "_"));
    if (assetType && assetType !== "any") parts.push(assetType);
    if (street) parts.push(street.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
    parts.push(new Date().toISOString().slice(0, 10));
    return parts.join("_") + ".csv";
  }

  return (
    <div style={{ marginTop: 22 }}>
          {/* Filters */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
            <div className="mono" style={{ ...labelStyle, marginBottom: 10 }}>SOURCES</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              {[["acris", "ACRIS (deeds + parties)"], ["dob", "DOB (filings + owners)"], ["pluto", "PLUTO (properties by type)"]].map(([s, lab]) => (
                <button key={s} onClick={() => setSources((p) => ({ ...p, [s]: !p[s] }))} className="mono"
                  style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, border: `1px solid ${sources[s] ? C.gold : C.line}`, background: sources[s] ? C.goldSoft : "transparent", color: sources[s] ? C.gold : C.muted }}>
                  {sources[s] ? "✓ " : ""}{lab}
                </button>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
              <label>
                <div className="mono" style={labelStyle}>BOROUGH</div>
                <select value={borough} onChange={(e) => setBorough(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
                  {BOROUGHS.map((b) => <option key={b} value={b}>{b || "All boroughs"}</option>)}
                </select>
              </label>
              <label>
                <div className="mono" style={labelStyle}>ASSET TYPE</div>
                <select value={assetType} onChange={(e) => setAssetType(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
                  {ASSET_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label style={{ gridColumn: "span 2" }}>
                <div className="mono" style={labelStyle}>ADDRESS — type &amp; pick (radius · PLUTO)</div>
                <div style={{ marginTop: 4 }}>
                  <AddressAutocomplete
                    value={nearAddress}
                    onChange={(t) => { setNearAddress(t); setPickedCoords(null); }}
                    onPick={(label, lat, lon, bbl) => { setNearAddress(label); setPickedCoords({ lat, lon, bbl }); }}
                    placeholder="Start typing an address, e.g. 200 5th Ave…"
                    style={{ ...fieldStyle, width: "100%" }}
                  />
                </div>
              </label>
              <label>
                <div className="mono" style={labelStyle}>RADIUS</div>
                <select value={radiusMiles} onChange={(e) => setRadiusMiles(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }}>
                  {[["", "off · just this property"], ["0.05", "0.05 mi · ~1 block"], ["0.1", "0.1 mi · ~2 blocks"], ["0.25", "0.25 mi"], ["0.5", "0.5 mi"], ["1", "1 mi"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
              <strong style={{ color: C.ivory }}>Address</strong> — type and pick from the dropdown. With <strong style={{ color: C.ivory }}>radius off</strong> you get just that one property; pick a radius to also pull the PLUTO properties around it (nearest first). Radius searches ignore ACRIS/DOB, which can’t do radius. Click an address for Google Maps, or “▸ details” for owner, deeds &amp; records.
            </div>

            <button onClick={() => setShowMore((s) => !s)} className="mono" style={{ marginTop: 12, cursor: "pointer", background: "none", border: "none", padding: 0, color: C.gold, fontSize: 12 }}>
              {showMore ? "▾ fewer filters" : "▸ more filters — size · units · year (PLUTO)"}
            </button>
            {showMore && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 10 }}>
                  <label><div className="mono" style={labelStyle}>MIN BLDG SQFT</div><input type="number" value={minSqft} onChange={(e) => setMinSqft(e.target.value)} placeholder="e.g. 5000" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
                  <label><div className="mono" style={labelStyle}>MIN RETAIL SQFT</div><input type="number" value={minRetailSqft} onChange={(e) => setMinRetailSqft(e.target.value)} placeholder="e.g. 2000" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
                  <label><div className="mono" style={labelStyle}>MIN UNITS</div><input type="number" value={minUnits} onChange={(e) => setMinUnits(e.target.value)} placeholder="e.g. 10" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
                  <label><div className="mono" style={labelStyle}>BUILT AFTER</div><input type="number" value={builtAfter} onChange={(e) => setBuiltAfter(e.target.value)} placeholder="e.g. 1900" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
                  <label><div className="mono" style={labelStyle}>BUILT BEFORE</div><input type="number" value={builtBefore} onChange={(e) => setBuiltBefore(e.target.value)} placeholder="e.g. 1940" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
                  <label><div className="mono" style={labelStyle}>MIN UNUSED BUILDABLE SF</div><input type="number" value={minBuildable} onChange={(e) => setMinBuildable(e.target.value)} placeholder="e.g. 5000" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13, color: C.ivory, cursor: "pointer" }}>
                  <input type="checkbox" checked={devOnly} onChange={(e) => setDevOnly(e.target.checked)} style={{ accentColor: C.gold }} />
                  Development sites only — underbuilt lots with unused air rights (PLUTO zoning)
                </label>
              </>
            )}

            <button onClick={run} disabled={loading}
              style={{ marginTop: 14, width: "100%", cursor: loading ? "default" : "pointer", border: "none", borderRadius: 9, padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em", background: loading ? C.panel2 : C.gold, color: loading ? C.muted : "#ffffff" }}>
              {loading ? "Sourcing from NYC Open Data…" : "Source deals & contacts →"}
            </button>
            {error && <div style={{ marginTop: 12, color: C.red, fontSize: 13 }}>{error}</div>}
          </div>

          {leads && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "22px 0 12px", flexWrap: "wrap", gap: 10 }}>
                <div className="serif" style={{ fontSize: 17 }}>{leads.length} contact{leads.length === 1 ? "" : "s"} sourced</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => setSavedOnly((v) => !v)} className="lift mono"
                    title="Show only the properties you've starred"
                    style={{ cursor: "pointer", fontSize: 12, padding: "9px 16px", borderRadius: 8, border: `1px solid ${savedOnly ? C.gold : C.line}`, background: savedOnly ? C.goldSoft : "transparent", color: savedOnly ? C.gold : C.ivory }}>★ SAVED ({saved.size})</button>
                  <button onClick={() => leads.length && downloadBlob(leadsToCSV(leads), csvName(), "text/csv")} className="lift mono"
                    style={{ cursor: "pointer", fontSize: 12, padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXPORT CSV</button>
                  <button onClick={() => leads.length && downloadBlob(skiptraceCSV(leads), csvName().replace(/\.csv$/, "_skiptrace.csv"), "text/csv")} className="lift mono"
                    title="Owner + mailing address, deduped — ready to upload to a skip-trace provider"
                    style={{ cursor: "pointer", fontSize: 12, padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.gold}`, background: C.goldSoft, color: C.gold }}>↓ SKIP-TRACE CSV</button>
                </div>
              </div>
              {center && (
                <div style={{ margin: "-4px 0 12px", fontSize: 12.5, color: C.muted }}>
                  {center.single ? (
                    <>Showing only the property you searched — <strong style={{ color: C.gold }}>{center.label}</strong>. Pick a radius to also see nearby properties.</>
                  ) : (
                    <>Within <strong style={{ color: C.gold }}>{center.radiusMiles} mi</strong> of {center.label} — nearest first. The address you searched is pinned at the top, marked <strong style={{ color: C.gold }}>★ THIS PROPERTY</strong>.</>
                  )}
                </div>
              )}
              <LeadTable rows={savedOnly ? leads.filter((l) => saved.has(l.deal_id)) : leads} pw={pw} saved={saved} onToggleSave={toggleSave} />
              {savedOnly && saved.size === 0 && <div style={{ color: C.muted, fontSize: 13 }}>Nothing saved yet — click the ☆ on a row to add it to your list.</div>}
              {leads.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No records matched those filters. Try widening the date or borough.</div>}
            </>
          )}

          {!leads && !loading && (
            <div style={{ marginTop: 22, color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
              <span className="serif" style={{ color: C.ivory, fontSize: 15 }}>What this does.</span> Pulls recently recorded deeds (ACRIS) and
              building-job filings (DOB) for the filters above, and extracts the people and companies attached to each — sellers, buyers,
              and owners — as your leads. Narrow by asset type and street, then export a clean CSV.
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
// is scored on public signals already attached to the lead by /api/source (no extra
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
      const src = await postJSON("/api/source", {
        password: pw, sources: ["pluto"], assetType, radiusMiles,
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
// Google blocked the old keyless Street View embed in 2026 (it now 301s and sends
// X-Frame-Options: SAMEORIGIN, so browsers refuse to render it in our iframe). The
// supported replacement is the Maps Embed API, which IS free (no usage charge, no
// billing) but needs an API key. If `VITE_GMAPS_EMBED_KEY` is set we render the real
// inline photo; otherwise we show a clickable card that opens Street View in a new tab.
const GMAPS_EMBED_KEY = import.meta.env.VITE_GMAPS_EMBED_KEY || "";
function PropertyPhoto({ r }) {
  if (r.lat == null || r.lon == null) return null;
  const pano = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${r.lat},${r.lon}`;
  const sat = `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lon}`;
  if (GMAPS_EMBED_KEY) {
    const src = `https://www.google.com/maps/embed/v1/streetview?key=${GMAPS_EMBED_KEY}&location=${r.lat},${r.lon}&fov=80`;
    return (
      <div style={{ marginBottom: 14 }}>
        <iframe title="Street View" src={src} loading="lazy"
          style={{ width: "100%", height: 190, border: `1px solid ${C.line}`, borderRadius: 10, display: "block" }} />
        <a href={pano} target="_blank" rel="noreferrer" className="mono" style={{ display: "inline-block", marginTop: 5, fontSize: 10.5, color: C.gold, textDecoration: "none" }}>↗ open full Street View</a>
      </div>
    );
  }
  // Keyless default: a street MAP of the block from Esri (free, no key). For the actual
  // building FRONT, Google's Street View now needs a key — set VITE_GMAPS_EMBED_KEY (free)
  // and the inline photo above replaces this map. Links below open Street View + satellite.
  const d = 0.0009; // ~100m half-span around the lot
  const bbox = `${r.lon - d},${r.lat - d},${r.lon + d},${r.lat + d}`;
  const streetmap = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=620,300&format=png&f=image`;
  return (
    <div style={{ marginBottom: 14 }}>
      <a href={sat} target="_blank" rel="noreferrer" style={{ display: "block", position: "relative" }}>
        <img src={streetmap} alt="Street map of the property location" loading="lazy"
          style={{ width: "100%", height: 190, objectFit: "cover", border: `1px solid ${C.line}`, borderRadius: 10, display: "block" }} />
        {/* The map bbox is centered on the lot's lat/lon, so the subject is dead-center.
            Drop a pin (tip at center) + an address label so it's unmistakable which one it is. */}
        <svg width="28" height="36" viewBox="0 0 28 36" aria-hidden="true"
          style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-100%)", pointerEvents: "none", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.5))" }}>
          <path d="M14 0C6.8 0 1 5.8 1 13c0 9.5 13 23 13 23s13-13.5 13-23C27 5.8 21.2 0 14 0z" fill={C.gold} stroke="#fff" strokeWidth="2" />
          <circle cx="14" cy="13" r="4.5" fill="#fff" />
        </svg>
        <div className="mono" style={{ position: "absolute", left: 8, top: 8, background: "rgba(27,25,48,0.82)", color: "#fff", fontSize: 9.5, letterSpacing: "0.04em", padding: "3px 7px", borderRadius: 5, pointerEvents: "none", maxWidth: "85%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          ★ SUBJECT{r.address ? ` · ${r.address}` : ""}
        </div>
      </a>
      <div style={{ display: "flex", gap: 12, marginTop: 5 }}>
        <a href={pano} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 10.5, color: C.gold, textDecoration: "none" }}>↗ Street View</a>
        <a href={sat} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 10.5, color: C.gold, textDecoration: "none" }}>↗ Map / Satellite</a>
      </div>
    </div>
  );
}

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

// Engine 2: on-demand AI web research. Costs an Anthropic call (with web search) only
// when the user clicks — never automatic.
function ResearchBrief({ r, pw }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [brief, setBrief] = useState("");
  const [err, setErr] = useState("");
  const run = async () => {
    setState("loading"); setErr("");
    try {
      // Knowledge mode (instant). Live web search exceeds Vercel's 60s function limit
      // on the current plan; flip to mode "web" once on a plan with a higher timeout.
      const d = await postJSON("/api/research", { mode: "knowledge", password: pw, name: r.name, entity_type: r.entity_type, address: r.address, borough: r.borough, contact_address: r.contact_address, city: r.city, state: r.state, last_sale_date: r.last_sale_date, last_sale_price: r.last_sale_price, years_owned: r.years_owned });
      setBrief(d.brief || ""); setState("done");
    } catch (e) { setErr(e.message || "Research failed."); setState("error"); }
  };
  const isCo = isCompanyRow(r);
  return (
    <div style={{ background: C.panel2, border: `1px solid ${isCo ? C.gold : C.line}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>✦ AI QUICK TAKE — {isCo ? "who they are & how to reach them" : "what’s known about this owner"}{isCo && <span style={{ color: C.muted }}> · recommended</span>}</div>
        {state !== "loading" && (
          <button onClick={run} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>
            {state === "done" || state === "error" ? "↻ re-run" : "▸ run"}
          </button>
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

// Session cache so a given owner's contact is paid for at most once (owner-dedupe).
// Key = owner name + mailing zip/state; survives re-opening rows for the session.
const _skipCache = new Map();
const skipKey = (r) => `${(r.name || "").toUpperCase().trim()}|${(r.zip || r.state || "").toString().trim()}`;
function readSkipSpend() { try { return JSON.parse(localStorage.getItem("fr_skiptrace_spend_v1") || "{}"); } catch { return {}; } }
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
      // Strongly prefer a number on the owner-name-matched person over a building occupant.
      const s = (ph.grade?.score || 0) + (p.matchesOwner ? 1000 : 0);
      if (s > bestScore) { bestScore = s; bestPhone = { ...ph, name: p.name, matchesOwner: p.matchesOwner }; }
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

// Owner-contact WORKFLOW (the waterfall): one click runs the FREE web-search lane
// first (/api/findcontact, $0). If that finds a usable contact, you're done for free.
// If it whiffs, a "deep skip trace" button runs the PAID lane (/api/skiptrace), which
// is charged only on a match and cached by owner so you never pay twice.
// Owner-contact lookup — one click runs the skip trace (Tracerfy), charged only on a
// match, owner-deduped + cached so you never pay twice. (The free web-search lane is
// parked; /api/findcontact still exists if a BRAVE_API_KEY is ever added back.)
function ContactReveal({ r, pw, autoRun }) {
  const cachedSkip = _skipCache.get(skipKey(r)) || null;
  const [skip, setSkip] = useState(cachedSkip);
  const [skipState, setSkipState] = useState(cachedSkip ? "done" : "idle"); // idle|loading|done|error|nokey
  const [err, setErr] = useState("");
  const [spend, setSpend] = useState(readSkipSpend());

  const runSkip = async () => {
    setSkipState("loading"); setErr("");
    try {
      const d = await postJSON("/api/skiptrace", {
        password: pw, name: r.name, entity_type: r.entity_type,
        contact_address: r.contact_address, city: r.city, state: r.state, zip: r.zip,
        address: r.address, borough: r.borough,
      });
      if (d.noKey) { setSkip(d); setSkipState("nokey"); return; }
      const result = { persons: d.persons || [], phones: d.phones || [], emails: d.emails || [], provider: d.provider, business: d.business, matched: d.matched, tracedAddress: d.tracedAddress };
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

  if (skipState === "idle") {
    return (
      <div style={box}>
        <button onClick={runSkip} className="mono lift" style={pill(C.gold)}>🔎 Find owner contact</button>
        <span style={{ fontSize: 11, color: C.muted, marginLeft: 10 }}>~$0.12 · charged only on a match · cached</span>
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
                      {p.matchesOwner && <span className="mono" title="Name matches the owner of record — most likely the right party." style={{ fontSize: 9, color: C.green, marginLeft: 6, border: `1px solid ${C.green}`, borderRadius: 4, padding: "0 5px" }}>✓ OWNER MATCH</span>}
                      {p.isEntity && <span className="mono" title="A company name, not an individual — likely the owner's corporate web. Verify." style={{ fontSize: 9, color: C.amber, marginLeft: 6, border: `1px solid ${C.amber}`, borderRadius: 4, padding: "0 5px" }}>ENTITY ⚠</span>}
                    </div>
                    <ContactList phones={p.phones} emails={p.emails} />
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
                <span style={{ color: C.green }}>✓ OWNER MATCH</span> = name matches the owner of record (most likely right). <span style={{ color: C.red }}>DNC</span> = Do-Not-Call — prefer email there.
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
    </div>
  );
}

// Manual skip-trace tool — type any name + address and trace it directly (e.g. an
// officer name you found in a property's HPD records, far better than tracing a building).
function ManualSkipTrace({ pw }) {
  const [name, setName] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [stateV, setStateV] = useState("NY");
  const [zip, setZip] = useState("");
  const [target, setTarget] = useState(null);

  const ready = name.trim() && street.trim();
  const run = () => {
    if (!ready) return;
    setTarget({
      name: name.trim(), entity_type: "",
      contact_address: street.trim(), city: city.trim(), state: stateV.trim() || "NY", zip: zip.trim(),
      address: street.trim(), borough: "",
      deal_id: `manual-${name.trim()}-${zip.trim()}-${Date.now()}`,
    });
  };

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div className="mono" style={{ fontSize: 11, color: C.muted, letterSpacing: "0.05em", marginBottom: 12 }}>MANUAL SKIP TRACE — name + address</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          <label style={{ gridColumn: "span 2" }}><div className="mono" style={labelStyle}>NAME</div><input value={name} onChange={(e) => setName(e.target.value)} placeholder="First Last (or an LLC name)" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
          <label style={{ gridColumn: "span 2" }}><div className="mono" style={labelStyle}>STREET ADDRESS</div><input value={street} onChange={(e) => setStreet(e.target.value)} placeholder="123 Main St" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
          <label><div className="mono" style={labelStyle}>CITY</div><input value={city} onChange={(e) => setCity(e.target.value)} placeholder="New York" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
          <label><div className="mono" style={labelStyle}>STATE</div><input value={stateV} onChange={(e) => setStateV(e.target.value)} placeholder="NY" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
          <label><div className="mono" style={labelStyle}>ZIP</div><input value={zip} onChange={(e) => setZip(e.target.value)} placeholder="10012" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} /></label>
        </div>
        <button onClick={run} disabled={!ready}
          style={{ marginTop: 14, width: "100%", cursor: ready ? "pointer" : "default", border: "none", borderRadius: 9, padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em", background: ready ? C.gold : C.panel2, color: ready ? "#ffffff" : C.muted }}>
          Skip trace →
        </button>
      </div>

      {target && <ContactReveal key={target.deal_id} r={target} pw={pw} autoRun />}

      <div style={{ marginTop: 14, fontSize: 12, color: C.muted, lineHeight: 1.55 }}>
        Trace any name + address directly. <strong style={{ color: C.ivory }}>~$0.10 per match</strong> (Tracerfy), charged only on a hit, cached so you never pay twice for the same name. Best use: trace a <strong style={{ color: C.gold }}>specific person</strong> — e.g. a head officer / owner name from a property’s HPD records — instead of the building (which returns occupants). <span style={{ color: C.green }}>✓ OWNER MATCH</span> means a returned name matched what you typed.
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
      <ResearchBrief r={r} pw={pw} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 22 }}>
      <div>
        <PropertyPhoto r={r} />
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
          <span style={{ width: 150, color: h.doc_type === "DEED" ? C.green : /lease/i.test(h.doc_label) ? "#3b82c4" : C.ivory }}>{h.doc_label}</span>
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
