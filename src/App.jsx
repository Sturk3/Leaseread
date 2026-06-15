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
      `}</style>

      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "28px 22px 80px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", borderBottom: `1px solid ${C.line}`, paddingBottom: 18 }}>
          <div>
            <div className="serif" style={{ fontSize: 30, letterSpacing: "-0.01em", fontWeight: 600 }}>
              FRONTAGE<span style={{ color: C.gold }}>.</span>
            </div>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>
              {view === "screener"
                ? "Retail acquisitions screener — high-street trophy assets"
                : "Deal & contact sourcing — NYC Open Data (ACRIS + DOB)"}
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

function downloadBlob(content, name, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

const LEAD_COLS = [
  { key: "name", label: "Name" }, { key: "entity_type", label: "Type" }, { key: "role", label: "Role" },
  { key: "address", label: "Property" }, { key: "borough", label: "Borough" }, { key: "amount", label: "Amount" },
  { key: "deal_date", label: "Date" }, { key: "doc_type", label: "Doc" }, { key: "source", label: "Source" },
  { key: "contact_address", label: "Contact address" }, { key: "city", label: "City" },
  { key: "state", label: "State" }, { key: "zip", label: "Zip" }, { key: "status", label: "Status" },
];

function leadsToCSV(rows) {
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const head = LEAD_COLS.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => LEAD_COLS.map((c) => esc(r[c.key])).join(",")).join("\n");
  return head + "\n" + body;
}
const fmtAmount = (a) => (a == null || a === "" ? "" : "$" + Number(a).toLocaleString());

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
  const [tab, setTab] = useState("source");
  const [sources, setSources] = useState({ acris: true, dob: true, pluto: false });
  const [borough, setBorough] = useState("");
  const [docType, setDocType] = useState("");
  const [since, setSince] = useState("");
  const [assetType, setAssetType] = useState("any");
  const [blockFrom, setBlockFrom] = useState("");
  const [blockTo, setBlockTo] = useState("");
  const [limit, setLimit] = useState(100);
  const [saveOnRun, setSaveOnRun] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [leads, setLeads] = useState(null);

  async function run() {
    setError(""); setInfo(""); setLeads(null);
    const picked = Object.keys(sources).filter((s) => sources[s]);
    if (!picked.length) { setError("Pick at least one source (ACRIS or DOB)."); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/source", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw, sources: picked, borough, docType, since, assetType, blockFrom, blockTo, limit, save: saveOnRun }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setLeads(data.leads || []);
      if (saveOnRun) {
        setInfo(data.dbConfigured
          ? `Saved ${data.saved} new lead(s) to the shared list (duplicates skipped).`
          : "Sourced — but no database is connected, so nothing was saved. See SOURCING_SETUP.md.");
      }
    } catch (e) { setError(e.message || "Sourcing failed."); }
    finally { setLoading(false); }
  }

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[["source", "SOURCE LIVE"], ["shared", "SHARED LIST"]].map(([t, lab]) => (
          <button key={t} onClick={() => setTab(t)} className="mono"
            style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, border: `1px solid ${tab === t ? C.gold : C.line}`, background: tab === t ? C.goldSoft : "transparent", color: tab === t ? C.gold : C.muted }}>
            {lab}
          </button>
        ))}
      </div>

      {tab === "shared" ? <SharedLeads pw={pw} /> : (
        <>
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
              <label>
                <div className="mono" style={labelStyle}>BLOCK FROM</div>
                <input type="number" value={blockFrom} onChange={(e) => setBlockFrom(e.target.value)} placeholder="e.g. 1000" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} />
              </label>
              <label>
                <div className="mono" style={labelStyle}>BLOCK TO</div>
                <input type="number" value={blockTo} onChange={(e) => setBlockTo(e.target.value)} placeholder="e.g. 1100" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} />
              </label>
              <label>
                <div className="mono" style={labelStyle}>DOC TYPE (ACRIS)</div>
                <input value={docType} onChange={(e) => setDocType(e.target.value)} placeholder="e.g. DEED" style={{ ...fieldStyle, width: "100%", marginTop: 4 }} />
              </label>
              <label>
                <div className="mono" style={labelStyle}>SINCE</div>
                <input type="date" value={since} onChange={(e) => setSince(e.target.value)} style={{ ...fieldStyle, width: "100%", marginTop: 4 }} />
              </label>
              <label>
                <div className="mono" style={labelStyle}>MAX PER SOURCE</div>
                <input type="number" min="1" max="250" value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ ...fieldStyle, width: "100%", marginTop: 4 }} />
              </label>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
              <strong style={{ color: C.ivory }}>Asset type</strong> uses PLUTO (turn it on above) — e.g. Retail finds store buildings + their owners.
              <strong style={{ color: C.ivory }}> Block from/to</strong> sets a tax-block region within the borough and refines every source.
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, fontSize: 13, color: C.ivory, cursor: "pointer" }}>
              <input type="checkbox" checked={saveOnRun} onChange={(e) => setSaveOnRun(e.target.checked)} style={{ accentColor: C.gold }} />
              Save results to the shared list (deduped)
            </label>

            <button onClick={run} disabled={loading}
              style={{ marginTop: 14, width: "100%", cursor: loading ? "default" : "pointer", border: "none", borderRadius: 9, padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em", background: loading ? C.panel2 : C.gold, color: loading ? C.muted : "#ffffff" }}>
              {loading ? "Sourcing from NYC Open Data…" : "Source deals & contacts →"}
            </button>
            {error && <div style={{ marginTop: 12, color: C.red, fontSize: 13 }}>{error}</div>}
            {info && <div style={{ marginTop: 12, color: C.green, fontSize: 13 }}>{info}</div>}
          </div>

          {leads && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "22px 0 12px", flexWrap: "wrap", gap: 10 }}>
                <div className="serif" style={{ fontSize: 17 }}>{leads.length} contact{leads.length === 1 ? "" : "s"} sourced</div>
                <button onClick={() => leads.length && downloadBlob(leadsToCSV(leads), "frontage_leads.csv", "text/csv")} className="lift mono"
                  style={{ cursor: "pointer", fontSize: 12, padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXPORT CSV</button>
              </div>
              <LeadTable rows={leads} />
              {leads.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No records matched those filters. Try widening the date or borough.</div>}
            </>
          )}

          {!leads && !loading && (
            <div style={{ marginTop: 22, color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
              <span className="serif" style={{ color: C.ivory, fontSize: 15 }}>What this does.</span> Pulls recently recorded deeds (ACRIS) and
              building-job filings (DOB) for the filters above, and extracts the people and companies attached to each — sellers, buyers,
              and owners — as your leads. Check <strong>Save to the shared list</strong> to push them into the team's deduped database.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LeadTable({ rows, statusEditor }) {
  if (!rows.length) return null;
  const cols = ["Name", "Type", "Role", "Property", "Borough", "Class", "Amount", "Date", "Source"];
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
            <tr key={r.id ?? i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${C.line}` : "none" }}>
              <td style={{ padding: "10px 14px", fontWeight: 600 }}>{r.name}</td>
              <td style={{ padding: "10px 14px", color: C.muted }}>{r.entity_type}</td>
              <td style={{ padding: "10px 14px", color: C.muted }}>{r.role}</td>
              <td style={{ padding: "10px 14px" }}>{r.address || "—"}</td>
              <td style={{ padding: "10px 14px", color: C.muted }}>{r.borough || "—"}</td>
              <td className="mono" style={{ padding: "10px 14px", color: C.muted }}>{r.doc_type || "—"}</td>
              <td className="mono" style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>{fmtAmount(r.amount) || "—"}</td>
              <td className="mono" style={{ padding: "10px 14px", color: C.muted, whiteSpace: "nowrap" }}>{(r.deal_date || "").slice(0, 10) || "—"}</td>
              <td className="mono" style={{ padding: "10px 14px", color: C.muted }}>{r.source}</td>
              {statusEditor && <td style={{ padding: "10px 14px" }}>{statusEditor(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
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
      {rows && rows.length > 0 && <LeadTable rows={rows} statusEditor={statusEditor} />}
    </div>
  );
}
