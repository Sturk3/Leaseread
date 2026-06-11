import React, { useState, useRef } from "react";

// FRONTAGE — Retail Acquisitions Screener
// Ingests a retail offering memorandum, extracts underwriting data,
// breaks out the tenant roster by lease expiration + credit, and scores
// the deal against a Crown-style trophy-retail buy box.
//
// The Anthropic API call now lives in the serverless backend (api/screen.js)
// so the API key never reaches the browser. This component POSTs the raw
// inputs to /api/screen and parses the same response shape as before.

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

// Light theme — white surfaces, dark indigo-ink text (the "blue undertone"),
// and an indigo-violet accent (purple with a blue lean). Key names are kept
// from the original dark theme so the rest of the component is untouched:
//   ink   = page background      ivory = primary text
//   panel = card surface         muted = secondary text
//   gold  = accent (now violet)  line  = borders
const C = {
  ink: "#f4f4fb", panel: "#ffffff", panel2: "#eceaf7", line: "#e5e3f1",
  ivory: "#1b1930", muted: "#6c6982", gold: "#6a5cf6", goldSoft: "rgba(106,92,246,0.10)",
  green: "#1f9d63", amber: "#b7791f", red: "#d14a3c",
};

function fmtPct(n) { return n == null ? "—" : `${(+n).toFixed(2)}%`; }
function money(n) { return n == null ? "—" : "$" + Math.round(+n).toLocaleString(); }

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

  // Shared-password gate. The password is validated server-side; here we just
  // remember it for the session and send it with each request.
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check: true, password: pwInput }),
      });
      if (res.ok) {
        sessionStorage.setItem("lr_pw", pwInput);
        setPw(pwInput); setAuthed(true);
      } else {
        const d = await res.json().catch(() => ({}));
        setPwError(d.error || "Incorrect password.");
      }
    } catch {
      setPwError("Could not reach the server. Try again.");
    } finally {
      setPwBusy(false);
    }
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, pdfData, memoText, password: pw }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
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

  function exportJSON() {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
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
    (result.tenants || []).forEach(t => rows.push([t.name, t.sf || "", t.lease_expiration || "", t.credit_tier || ""]));
    rows.push([]);
    rows.push(["Buy-box score", result.buy_box?.overall_score ?? "", result.buy_box?.recommendation || ""]);
    const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
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
          <input type="password" value={pwInput} onChange={e => setPwInput(e.target.value)} autoFocus
            placeholder="Password"
            style={{ width: "100%", marginTop: 18, background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 9, padding: 13, fontSize: 14, fontFamily: "Archivo, sans-serif" }} />
          <button type="submit" disabled={pwBusy || !pwInput}
            style={{ marginTop: 12, width: "100%", cursor: pwBusy || !pwInput ? "default" : "pointer", border: "none", borderRadius: 9, padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em", background: pwBusy || !pwInput ? C.panel2 : C.gold, color: pwBusy || !pwInput ? C.muted : C.ink }}>
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
        textarea::placeholder { color: ${C.muted}; }
        textarea:focus, button:focus { outline: none; }
        .lift { transition: transform .15s ease, border-color .15s ease; }
        .lift:hover { transform: translateY(-1px); border-color: ${C.gold}; }
      `}</style>

      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "28px 22px 80px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", borderBottom: `1px solid ${C.line}`, paddingBottom: 18 }}>
          <div>
            <div className="serif" style={{ fontSize: 30, letterSpacing: "-0.01em", fontWeight: 600 }}>
              FRONTAGE<span style={{ color: C.gold }}>.</span>
            </div>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>Retail acquisitions screener — high-street trophy assets</div>
          </div>
          <div className="mono" style={{ fontSize: 11, color: C.gold, textAlign: "right", lineHeight: 1.5 }}>
            POWERED BY CLAUDE<br /><span style={{ color: C.muted }}>v1 · demo build</span>
          </div>
        </div>

        {/* Input */}
        <div style={{ marginTop: 22, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {["text", "pdf"].map(m => (
              <button key={m} onClick={() => setMode(m)} className="mono"
                style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, border: `1px solid ${mode === m ? C.gold : C.line}`,
                  background: mode === m ? C.goldSoft : "transparent", color: mode === m ? C.gold : C.muted }}>
                {m === "text" ? "PASTE TEXT" : "UPLOAD PDF"}
              </button>
            ))}
            <button onClick={() => { setMode("text"); setMemoText(SAMPLE_OM); }} className="mono"
              style={{ cursor: "pointer", fontSize: 12, padding: "7px 14px", borderRadius: 7, marginLeft: "auto",
                border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>
              ✦ TRY SAMPLE DEAL
            </button>
          </div>

          {mode === "text" ? (
            <textarea value={memoText} onChange={e => setMemoText(e.target.value)} rows={7}
              placeholder="Paste the offering memorandum text here, or load the sample deal…"
              style={{ width: "100%", background: C.ink, color: C.ivory, border: `1px solid ${C.line}`, borderRadius: 9,
                padding: 14, fontSize: 13.5, lineHeight: 1.5, resize: "vertical", fontFamily: "Archivo, sans-serif" }} />
          ) : (
            <div onClick={() => fileRef.current?.click()} className="lift"
              style={{ cursor: "pointer", border: `1px dashed ${C.line}`, borderRadius: 9, padding: "30px 16px", textAlign: "center", background: C.ink }}>
              <div style={{ color: C.gold, fontSize: 22 }} className="serif">↑</div>
              <div style={{ marginTop: 6, fontSize: 14 }}>{fileName || "Drop a PDF offering memorandum, or click to browse"}</div>
              <input ref={fileRef} type="file" accept="application/pdf" style={{ display: "none" }}
                onChange={e => onFile(e.target.files[0])} />
            </div>
          )}

          <button onClick={analyze} disabled={loading}
            style={{ marginTop: 14, width: "100%", cursor: loading ? "default" : "pointer", border: "none", borderRadius: 9,
              padding: "13px", fontSize: 14, fontWeight: 600, letterSpacing: "0.02em",
              background: loading ? C.panel2 : C.gold, color: loading ? C.muted : C.ink }}>
            {loading ? progress || "Working…" : "Screen this deal →"}
          </button>
          {error && <div style={{ marginTop: 12, color: C.red, fontSize: 13 }}>{error}</div>}
        </div>

        {result && <Results r={result} onJSON={exportJSON} onCSV={exportCSV} />}

        {!result && !loading && (
          <div style={{ marginTop: 22, color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
            <span className="serif" style={{ color: C.ivory, fontSize: 15 }}>What this does.</span> Reads a retail OM, pulls the underwriting
            data, breaks out the tenant roster by lease expiration and credit quality, recomputes the deal's own math to catch
            inconsistencies, and scores it against a trophy-retail buy box with a written rationale. Built to triage a pipeline the way a
            principal team does — not just to read a document.
          </div>
        )}
      </div>
    </div>
  );
}

function Results({ r, onJSON, onCSV }) {
  const bb = r.buy_box || {};
  const crit = bb.criteria || {};
  const conf = r.confidence || {};
  const tenants = [...(r.tenants || [])].sort((a, b) => (a.expiration_year || 9999) - (b.expiration_year || 9999));
  const rec = bb.recommendation || "Watch";

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
          <Gauge score={bb.overall_score ?? 0} color={recColor(rec)} />
          <div>
            <div className="mono" style={{ fontSize: 11, color: C.muted, letterSpacing: "0.08em" }}>BUY-BOX FIT</div>
            <div className="serif" style={{ fontSize: 24, color: recColor(rec), fontWeight: 600 }}>{rec}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Trophy high-street screen</div>
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
        {metrics.map(([label, val, c]) => (
          <div key={label} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12, color: C.muted }}>{label}</div>
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
                <div className="mono" style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
                  computed {ck.computed} · stated {ck.stated}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Buy box breakdown */}
      <SectionTitle>Buy-box breakdown</SectionTitle>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: "8px 18px" }}>
        {Object.entries(crit).map(([k, v]) => (
          <div key={k} style={{ padding: "12px 0", borderBottom: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
              <span style={{ textTransform: "capitalize" }}>{k.replace(/_/g, " ")}</span>
              <span className="mono" style={{ color: C.gold }}>{v.score}</span>
            </div>
            <div style={{ height: 5, background: C.ink, borderRadius: 4, marginTop: 7, overflow: "hidden" }}>
              <div className="bar" style={{ width: `${v.score}%`, height: "100%", background: C.gold, borderRadius: 4 }} />
            </div>
            {v.note && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6 }}>{v.note}</div>}
          </div>
        ))}
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
      <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
        <button onClick={onCSV} className="lift mono" style={{ cursor: "pointer", fontSize: 12, padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXPORT CSV</button>
        <button onClick={onJSON} className="lift mono" style={{ cursor: "pointer", fontSize: 12, padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.ivory }}>↓ EXPORT JSON</button>
        <span style={{ alignSelf: "center", color: C.muted, fontSize: 12 }}>Ready to drop into an underwriting model.</span>
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
