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
              {view === "screener"
                ? "Underwrite high-street flagship assets against your mandate."
                : "Source owners & deals from NYC public records — ACRIS · DOB · PLUTO."}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {[["screener", "SCREENER"], ["sourcing", "SOURCING"]].map(([v, lab]) => (
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
              POWERED BY CLAUDE<br /><span style={{ color: C.muted }}>{view === "screener" ? `mandate · ${config.name}` : "ACRIS · DOB"}</span>
            </div>
          </div>
        </div>

        {view === "sourcing" && <Sourcing pw={pw} />}

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
      try {
        const r = await fetch(`https://geosearch.planninglabs.nyc/v2/autocomplete?text=${encodeURIComponent(text)}`);
        const d = await r.json();
        const items = (d.features || [])
          .filter((f) => f.geometry && f.properties)
          .map((f) => ({ label: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], bbl: ((f.properties.addendum || {}).pad || {}).bbl || null }));
        setSugs(items); setOpen(items.length > 0);
      } catch { setSugs([]); setOpen(false); }
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
  const [since, setSince] = useState("");
  const [assetType, setAssetType] = useState("any");
  const [street, setStreet] = useState("");
  const [nearAddress, setNearAddress] = useState("");
  const [pickedCoords, setPickedCoords] = useState(null);
  const [radiusMiles, setRadiusMiles] = useState("");
  const [limit, setLimit] = useState(100);
  const [minSqft, setMinSqft] = useState("");
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

  async function run() {
    setError(""); setLeads(null); setCenter(null);
    const picked = Object.keys(sources).filter((s) => sources[s]);
    if (!picked.length) { setError("Pick at least one source (ACRIS, DOB, or PLUTO)."); return; }
    setLoading(true);
    try {
      const data = await postJSON("/api/source", { password: pw, sources: picked, borough, since, assetType, street, nearAddress, radiusMiles, limit, minSqft, minUnits, builtAfter, builtBefore, devOnly, minBuildable, ...(pickedCoords ? { centerLat: pickedCoords.lat, centerLon: pickedCoords.lon, pickedBbl: pickedCoords.bbl } : {}) });
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
              <label>
                <div className="mono" style={labelStyle}>SINCE</div>
                <input type="date" value={since} onChange={(e) => setSince(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }} />
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
                <button onClick={() => leads.length && downloadBlob(leadsToCSV(leads), csvName(), "text/csv")} className="lift mono"
                  style={{ cursor: "pointer", fontSize: 12, padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXPORT CSV</button>
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
              <LeadTable rows={leads} pw={pw} />
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

function LeadTable({ rows, statusEditor, pw }) {
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
            <LeadRow key={r.id ?? `${r.source}-${r.deal_id}-${i}`} r={r} last={i === rows.length - 1} statusEditor={statusEditor} pw={pw} colSpan={colSpan} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeadRow({ r, last, statusEditor, pw, colSpan }) {
  const [open, setOpen] = useState(false);

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
          {r.name}
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
  // Keyless fallback: a tasteful photo card that links out (always works).
  return (
    <div style={{ marginBottom: 14, display: "flex", gap: 8 }}>
      <a href={pano} target="_blank" rel="noreferrer" className="lift"
        style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, height: 90, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, color: C.gold, textDecoration: "none" }}>
        <span style={{ fontSize: 22 }}>📷</span>
        <span className="mono" style={{ fontSize: 10.5 }}>STREET VIEW ↗</span>
      </a>
      <a href={sat} target="_blank" rel="noreferrer" className="lift"
        style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, height: 90, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, color: C.gold, textDecoration: "none" }}>
        <span style={{ fontSize: 22 }}>🛰️</span>
        <span className="mono" style={{ fontSize: 10.5 }}>MAP / SATELLITE ↗</span>
      </a>
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
      const d = await postJSON("/api/research", { password: pw, name: r.name, entity_type: r.entity_type, address: r.address, borough: r.borough, contact_address: r.contact_address, city: r.city, state: r.state, last_sale_date: r.last_sale_date, last_sale_price: r.last_sale_price, years_owned: r.years_owned });
      setBrief(d.brief || ""); setState("done");
    } catch (e) { setErr(e.message || "Research failed."); setState("error"); }
  };
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div className="mono" style={{ fontSize: 10.5, color: C.gold, letterSpacing: "0.06em" }}>✦ AI RESEARCH — scours the web for this owner & asset</div>
        {state !== "loading" && (
          <button onClick={run} className="mono lift" style={{ ...ACTION_PILL, padding: "5px 12px", background: C.panel, border: `1px solid ${C.gold}` }}>
            {state === "done" || state === "error" ? "↻ re-run" : "▸ run research"}
          </button>
        )}
      </div>
      {state === "loading" && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>Searching the web &amp; compiling the brief… this takes ~15–30s.</div>}
      {state === "error" && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {state === "done" && <div style={{ marginTop: 10 }}><ResearchBriefBody text={brief} /></div>}
      {state === "idle" && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 6 }}>Runs live web searches and writes an intelligence brief — principals behind the LLC, portfolio, news/distress signals, and whether it’s worth pursuing. On-demand only.</div>}
    </div>
  );
}

function PropertyDetail({ r, pw }) {
  const [hist, setHist] = useState(null);
  const [histErr, setHistErr] = useState("");
  const [port, setPort] = useState(null);
  const [intel, setIntel] = useState(null);
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

        <div className="mono" style={title}>PROPERTY</div>
        <div style={{ fontSize: 13 }}>
          <a href={mapUrl(r)} target="_blank" rel="noreferrer" style={{ color: C.gold, textDecoration: "none" }}>{r.address || "—"} ↗</a>
          <div style={{ color: C.muted, marginTop: 2 }}>
            {[r.borough, r.doc_type && `class ${r.doc_type}`].filter(Boolean).join(" · ")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", marginTop: 8, fontSize: 12.5 }}>
            <div style={{ color: C.muted }}>Retail SF</div>
            <div style={{ color: C.ivory }}>{r.retail_sqft ? `${Number(r.retail_sqft).toLocaleString()} SF` : <span style={{ color: C.muted }}>none recorded</span>}</div>
            <div style={{ color: C.muted }}>Building SF</div>
            <div style={{ color: C.ivory }}>{r.bldg_sqft ? `${Number(r.bldg_sqft).toLocaleString()} SF` : "—"}{r.lot_sqft ? <span style={{ color: C.muted }}> · lot {Number(r.lot_sqft).toLocaleString()} SF</span> : null}</div>
            <div style={{ color: C.muted }}>Assessed value</div>
            <div style={{ color: C.ivory }}>{assessedValue(r) != null ? fmtAmount(assessedValue(r)) : "—"} <span style={{ color: C.muted, fontSize: 11 }}>(City tax assessment)</span></div>
            <div style={{ color: C.muted }}>Purchase price</div>
            <div style={{ color: C.ivory }}>
              {purchasePrice(r) != null && purchasePrice(r) !== "" ? fmtAmount(purchasePrice(r)) : "—"}
              {purchaseDate(r) && <span style={{ color: C.muted }}> · bought {purchaseDate(r)}</span>}
              {r.years_owned != null && <span style={{ color: r.years_owned >= 15 ? C.green : C.muted }}> · {r.years_owned}y owned</span>}
            </div>
          </div>
          {r.buildable_sqft > 0 && <div style={{ color: C.green, marginTop: 2 }}>▲ {Number(r.buildable_sqft).toLocaleString()} sf unused air rights (built {r.built_far} / max {r.max_far} FAR)</div>}
        </div>

        <div className="mono" style={title}>ON-MARKET / AVAILABILITY</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {onMarketLinks(r).map((lk) => <a key={lk.label} href={lk.href} target="_blank" rel="noreferrer" className="mono lift" style={ACTION_PILL}>{lk.label} ↗</a>)}
        </div>
        <div style={{ color: C.muted, fontSize: 11, marginTop: 5 }}>No public feed of live availability — these check LoopNet/Crexi for any current listing.</div>

        <div className="mono" style={title}>PUBLIC RECORDS</div>
        {intel == null ? <div style={muted}>Loading…</div> : (
          <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {intel.ny_corp ? (
              <div>
                <span style={{ color: C.ivory }}>NY State registry:</span> {String(intel.ny_corp.entity_type || "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())}{intel.ny_corp.filed ? ` · filed ${intel.ny_corp.filed}` : ""}
                <div style={{ color: C.muted }}>Process: {intel.ny_corp.process_name}{intel.ny_corp.process_address ? ` — ${intel.ny_corp.process_address}` : ""}</div>
              </div>
            ) : <div style={{ color: C.muted }}>NY State registry: no exact entity match (often a single-building LLC, or an individual owner).</div>}
            <div style={{ marginTop: 4 }}>
              <span style={{ color: C.ivory }}>Violations:</span>{" "}
              <span style={{ color: intel.dob_violations ? C.red : C.muted }}>DOB {intel.dob_violations || 0}</span> ·{" "}
              <span style={{ color: intel.ecb_violations ? C.red : C.muted }}>ECB {intel.ecb_violations || 0}{intel.ecb_balance_due ? ` ($${Number(intel.ecb_balance_due).toLocaleString()} due)` : ""}</span> ·{" "}
              <span style={{ color: intel.hpd_violations ? C.red : C.muted }}>HPD {intel.hpd_violations || 0} open</span>
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
      </div>
      </div>
    </div>
  );
}

function PortfolioList({ data, ownerName }) {
  const props = (data && data.properties) || [];
  if (!props.length) {
    return <div style={{ color: C.muted, fontSize: 12, padding: "10px 0" }}>No other NYC properties under this exact owner name. (Owners often use a separate LLC per building.)</div>;
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
