import { useState, useRef, useEffect } from "react";
import { useRegisterSW } from 'virtual:pwa-register/react';

// ─── DESIGN TOKENS — Graphite & Sage ─────────────────────────────────────────
const C = {
  bg:        "#0a0b0a",
  surface:   "#131815",
  surface2:  "#182018",
  border:    "#223020",
  border2:   "#2d3f2a",
  accent:    "#4ADE80",
  accentDim: "#4ADE8022",
  accentGlow:"#4ADE8044",
  text:      "#F0FDF4",
  textMid:   "#C1E8CC",
  textSub:   "#86EFAC",
  textDim:   "#3D5C42",
  green:     "#4ADE80",
  mint:      "#86EFAC",
  yellow:    "#FDE68A",
  orange:    "#FDBA74",
  red:       "#FCA5A5",
  blue:      "#93C5FD",
};

const T = {
  display: "'Syne', sans-serif",
  mono:    "'IBM Plex Mono', monospace",
  body:    "'DM Sans', sans-serif",
};

// ─── STORAGE ──────────────────────────────────────────────────────────────────
const KEYS = { resume: "inflow_resume_v2", jobs: "inflow_jobs_v2", apiKey: "inflow_api_key", proxyUrl: "inflow_proxy_url" };
const store = {
  get: async (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: async (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const STATUSES = [
  { key: "saved",     label: "Saved",         short: "SAVED",     color: C.blue,   bg: "#0d1520", dateKey: "dateSaved"     },
  { key: "applied",   label: "Applied",       short: "APPLIED",   color: C.accent, bg: "#0d1a10", dateKey: "dateApplied"   },
  { key: "screen",    label: "Phone Screen",  short: "SCREEN",    color: C.yellow, bg: "#1a1800", dateKey: "dateScreen"    },
  { key: "interview", label: "Interview",     short: "INTERVIEW", color: C.orange, bg: "#1a1000", dateKey: "dateInterview" },
  { key: "offer",     label: "Offer",         short: "OFFER",     color: C.mint,   bg: "#0a1f12", dateKey: "dateOffer"     },
  { key: "rejected",  label: "Rejected",      short: "REJECTED",  color: C.red,    bg: "#1a0d0d", dateKey: "dateRejected"  },
];
const SM = Object.fromEntries(STATUSES.map(s => [s.key, s]));

const PHASES = [
  "Fetching job posting...", "Parsing requirements...",
  "Analyzing keyword match...", "Scoring recruiter fit...",
  "Running hiring manager analysis...", "Rewriting resume bullets...",
  "Generating resume edits...", "Preparing interview questions...",
  "Writing honest verdict...",
];

// ─── UTILS ────────────────────────────────────────────────────────────────────
const uid   = () => Math.random().toString(36).slice(2, 10);
const now   = () => new Date().toISOString();
const isUrl = (s) => /^https?:\/\/.+/.test(s?.trim());

const fmtDate = (iso) => {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const fmtShort = (iso) => {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const parseScores = (text) => {
  const r = text.match(/recruiter score[:\s*_]*(\d+(?:\.\d+)?)/i);
  const h = text.match(/hiring manager score[:\s*_]*(\d+(?:\.\d+)?)/i);
  return { recruiter: r ? parseFloat(r[1]) : null, hm: h ? parseFloat(h[1]) : null };
};
const scoreColor = (s) => !s ? C.textDim : s >= 7 ? C.accent : s >= 5 ? C.yellow : C.red;

const stampDate = (job, newStatus) => {
  const st = SM[newStatus];
  if (!st || job[st.dateKey]) return {};
  return { [st.dateKey]: now() };
};

// ─── ANALYSIS PROMPT ──────────────────────────────────────────────────────────
const ANALYSIS_PROMPT = (resume) => `You are a brutally honest senior corporate recruiter and hiring manager with 15+ years of experience. No fluff, no sugarcoating, no generic advice.

You have the candidate's resume below. When given a job posting URL or text:
1. If a URL, use web search to fetch the full posting. Confirm the role and company you found.
2. Run this exact analysis:

## STEP 1 — RECRUITER EVALUATION
- Recruiter Score (1–10) with one-line verdict
- Top 3 Strengths (specific to this role)
- Top 3 Gaps (direct, no softening)
- How a recruiter reads this background in 2–3 sentences
- Interview odds: ATS pass / Phone Screen / Interview / Offer (% + one-line reasoning each)

## STEP 2 — HIRING MANAGER VIEW
- Hiring Manager Score (1–10) with one-line verdict
- What will resonate (specific to this role and company)
- What will concern them (be direct)
- The one question they will definitely ask

## STEP 3 — RESUME OPTIMIZATION
Rewrite the professional summary specifically for this role. Then rewrite the 3 most impactful experience bullets. Strong verbs, specific outcomes, natural ATS keyword integration. Human — not robotic.

## STEP 4 — ATS KEYWORDS
10 specific phrases from this job description the candidate must mirror in their resume and interviews.

## STEP 5 — INTERVIEW PREP
3 questions this interviewer will almost certainly ask. For each: one paragraph coaching note based on the candidate's actual background. Specific — no generic STAR method advice.

## STEP 6 — RESUME EDIT SUGGESTIONS
Provide exactly 5 specific, actionable edits to the candidate's existing resume — formatted like this:

EDIT [number]:
ORIGINAL: [exact text from their resume]
SUGGESTED: [your rewrite]
WHY: [one sentence explaining the improvement]

Make these edits specific to THIS job. Focus on highest-impact changes only.

## STEP 7 — HONEST VERDICT
One paragraph. Should they apply? What is their real probability of an offer? Single most important action before submitting. No hedging.

Candidate Resume:
${resume}`;

// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,400&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ::placeholder { color: #3D5C42 !important; }
  textarea, input { color: #F0FDF4 !important; font-family: 'DM Sans', sans-serif; }
  input[type=date] { color-scheme: dark; }
  input[type=date]::-webkit-calendar-picker-indicator { filter: invert(0.5) sepia(1) hue-rotate(80deg); }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2d3f2a; border-radius: 2px; }
  select option { background: #131815; color: #F0FDF4; }
  a { color: ${C.blue}; }
`;

// ─── REUSABLE COMPONENTS ──────────────────────────────────────────────────────

const Label = ({ children, color }) => (
  <p style={{ fontFamily: T.mono, fontSize: "11px", color: color || C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px", lineHeight: 1.4 }}>
    {children}
  </p>
);

const Pill = ({ label, color, bg }) => (
  <span style={{ background: bg, border: `1px solid ${color}44`, borderRadius: "4px", padding: "3px 9px", fontFamily: T.mono, fontSize: "10px", color, letterSpacing: "0.1em", whiteSpace: "nowrap", display: "inline-block" }}>
    {label}
  </span>
);

const Btn = ({ children, onClick, disabled, variant = "primary", small }) => {
  const pad = small ? "7px 14px" : "12px 26px";
  const fz  = small ? "11px" : "12px";
  const variants = {
    primary: { background: disabled ? C.border2 : C.accent, color: disabled ? C.textDim : "#0a0b0a", border: "none" },
    ghost:   { background: "transparent", color: C.textSub, border: `1px solid ${C.border2}` },
    danger:  { background: "transparent", color: "#FCA5A577", border: `1px solid #FCA5A522` },
  };
  return (
    <button onClick={!disabled ? onClick : undefined} style={{ ...variants[variant], padding: pad, borderRadius: "7px", fontFamily: T.mono, fontSize: fz, letterSpacing: "0.08em", textTransform: "uppercase", cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600, transition: "opacity 0.15s" }}>
      {children}
    </button>
  );
};

const Field = ({ value, onChange, placeholder, multiline, rows, disabled, mono, type }) => {
  const base = {
    width: "100%", background: C.surface2, border: `1px solid ${C.border}`,
    borderRadius: "8px", padding: "12px 16px", fontSize: "15px",
    color: C.text, fontFamily: mono ? T.mono : T.body,
    outline: "none", lineHeight: 1.7, resize: multiline ? "vertical" : undefined,
    transition: "border-color 0.15s",
  };
  if (multiline) return <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows || 6} disabled={disabled} style={{ ...base, minHeight: rows ? `${rows * 26}px` : "140px" }} />;
  return <input type={type || "text"} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} style={base} />;
};

const ScoreCard = ({ label, score }) => (
  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "20px 22px", flex: 1 }}>
    <Label>{label}</Label>
    <div style={{ fontFamily: T.display, fontSize: "48px", color: scoreColor(score), lineHeight: 1, fontWeight: 800, marginBottom: "12px" }}>
      {score ?? "—"}<span style={{ fontSize: "18px", color: C.textDim, fontWeight: 400 }}>/10</span>
    </div>
    <div style={{ height: "3px", background: C.border2, borderRadius: "2px" }}>
      {score && <div style={{ height: "100%", width: `${score * 10}%`, background: scoreColor(score), borderRadius: "2px", boxShadow: `0 0 10px ${scoreColor(score)}66` }} />}
    </div>
  </div>
);

// ─── MARKDOWN RENDERER ────────────────────────────────────────────────────────
const Render = ({ text }) => text.split('\n').map((line, i) => {
  if (line.startsWith('## ')) return (
    <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", margin: "32px 0 14px" }}>
      <div style={{ width: "3px", height: "16px", background: C.accent, borderRadius: "2px", flexShrink: 0 }} />
      <h2 style={{ fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.16em", textTransform: "uppercase", color: C.accent, margin: 0 }}>{line.slice(3)}</h2>
    </div>
  );
  if (line.startsWith('### ')) return (
    <h3 key={i} style={{ fontFamily: T.display, fontSize: "16px", color: C.text, margin: "18px 0 8px", fontWeight: 700, lineHeight: 1.4 }}>{line.slice(4)}</h3>
  );
  // Resume edit formatting
  if (/^EDIT \d+:/.test(line)) return (
    <p key={i} style={{ fontFamily: T.mono, fontSize: "12px", color: C.accent, margin: "20px 0 6px", letterSpacing: "0.06em", fontWeight: 500 }}>{line}</p>
  );
  if (line.startsWith('ORIGINAL:')) return (
    <div key={i} style={{ background: "#1a0d0d", border: `1px solid ${C.red}33`, borderRadius: "6px", padding: "8px 12px", margin: "4px 0" }}>
      <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.red, margin: 0, lineHeight: 1.6 }}>{line}</p>
    </div>
  );
  if (line.startsWith('SUGGESTED:')) return (
    <div key={i} style={{ background: "#0d1a10", border: `1px solid ${C.accent}33`, borderRadius: "6px", padding: "8px 12px", margin: "4px 0" }}>
      <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.accent, margin: 0, lineHeight: 1.6 }}>{line}</p>
    </div>
  );
  if (line.startsWith('WHY:')) return (
    <p key={i} style={{ fontFamily: T.body, fontSize: "14px", color: C.textSub, margin: "4px 0 12px", fontStyle: "italic", lineHeight: 1.65 }}>{line.slice(4)}</p>
  );
  if (line.match(/^[-*] /)) return (
    <div key={i} style={{ display: "flex", gap: "10px", margin: "6px 0" }}>
      <span style={{ color: C.accent, flexShrink: 0, marginTop: "5px", fontSize: "10px" }}>▸</span>
      <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, margin: 0, lineHeight: 1.75 }}>{line.slice(2).replace(/\*\*(.*?)\*\*/g, (_, t) => t)}</p>
    </div>
  );
  if (line.trim() === '') return <div key={i} style={{ height: "8px" }} />;
  const parts = line.split(/\*\*(.*?)\*\*/g);
  return (
    <p key={i} style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "4px 0" }}>
      {parts.map((p, j) => j % 2 === 1 ? <strong key={j} style={{ color: C.text, fontWeight: 600 }}>{p}</strong> : p)}
    </p>
  );
});

// ─── TIMELINE ─────────────────────────────────────────────────────────────────
const Timeline = ({ job }) => {
  const hasAny = STATUSES.some(s => job[s.dateKey]);
  if (!hasAny) return null;
  return (
    <div style={{ marginBottom: "24px" }}>
      <Label>Stage Timeline</Label>
      <div style={{ position: "relative", paddingLeft: "26px" }}>
        <div style={{ position: "absolute", left: "6px", top: "10px", bottom: "10px", width: "1px", background: C.border2 }} />
        {STATUSES.map(st => {
          const date = job[st.dateKey];
          const isCurrent = job.status === st.key;
          const isDone = !!date;
          return (
            <div key={st.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", opacity: isDone ? 1 : 0.2 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ position: "absolute", left: 0, width: "14px", height: "14px", borderRadius: "50%", background: isDone ? st.bg : C.surface, border: `2px solid ${isDone ? st.color : C.border2}`, boxShadow: isCurrent ? `0 0 12px ${st.color}66` : "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {isCurrent && <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: st.color }} />}
                </div>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: isDone ? st.color : C.textDim, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: isCurrent ? 700 : 400 }}>
                  {st.label}{isCurrent ? "  ◀" : ""}
                </span>
              </div>
              {date && <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textSub }}>{fmtDate(date)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── DATE EDITOR ──────────────────────────────────────────────────────────────
const DateEditor = ({ job, onUpdate }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});

  const openIt = () => {
    const d = {};
    STATUSES.forEach(s => { d[s.dateKey] = job[s.dateKey] ? job[s.dateKey].slice(0, 10) : ""; });
    setDraft(d); setOpen(true);
  };
  const save = () => {
    const u = {};
    STATUSES.forEach(s => { u[s.dateKey] = draft[s.dateKey] ? new Date(draft[s.dateKey] + "T12:00:00").toISOString() : null; });
    onUpdate({ ...job, ...u }); setOpen(false);
  };

  if (!open) return (
    <button onClick={openIt} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "6px 14px", fontFamily: T.mono, fontSize: "10px", color: C.textSub, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", marginBottom: "20px" }}>
      Edit Dates
    </button>
  );

  return (
    <div style={{ background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "10px", padding: "18px", marginBottom: "20px" }}>
      <Label color={C.accent}>Edit Stage Dates</Label>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
        {STATUSES.map(st => (
          <div key={st.key} style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <span style={{ fontFamily: T.mono, fontSize: "10px", color: st.color, letterSpacing: "0.08em", textTransform: "uppercase", width: "110px", flexShrink: 0 }}>{st.label}</span>
            <input type="date" value={draft[st.dateKey] || ""} onChange={e => setDraft(p => ({ ...p, [st.dateKey]: e.target.value }))}
              style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "7px 12px", fontSize: "13px", color: draft[st.dateKey] ? C.text : C.textDim, fontFamily: T.mono, outline: "none", colorScheme: "dark" }} />
            {draft[st.dateKey] && (
              <button onClick={() => setDraft(p => ({ ...p, [st.dateKey]: "" }))} style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontSize: "13px" }}>✕</button>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: "10px" }}>
        <Btn small onClick={save}>Save Dates</Btn>
        <Btn small variant="ghost" onClick={() => setOpen(false)}>Cancel</Btn>
      </div>
    </div>
  );
};

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const [resume, setResume] = useState("");
  const charOk = resume.trim().length >= 100;

  const save = async () => {
    if (!charOk) return;
    await store.set(KEYS.resume, resume.trim());
    onComplete(resume.trim());
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <div style={{ width: "100%", maxWidth: "580px" }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "56px" }}>
          <svg width="30" height="30" viewBox="0 0 48 48">
            <rect width="48" height="48" rx="10" fill={C.bg} stroke={C.border2} strokeWidth="2"/>
            <circle cx="24" cy="13" r="4.5" fill={C.accent}/>
            <path d="M8 28 C13 22 19 36 24 30 C29 24 35 38 40 32" fill="none" stroke={C.accent} strokeWidth="3" strokeLinecap="round"/>
          </svg>
          <span style={{ fontFamily: T.display, fontSize: "22px", color: C.text, fontWeight: 800, letterSpacing: "-0.02em" }}>inflow</span>
        </div>

        {step === 0 && (
          <div>
            <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.18em", textTransform: "uppercase", margin: "0 0 18px" }}>Welcome</p>
            <h1 style={{ fontFamily: T.display, fontSize: "clamp(36px,6vw,56px)", color: C.text, fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.03em", margin: "0 0 22px" }}>
              Your job search,<br /><span style={{ color: C.accent }}>in flow state.</span>
            </h1>
            <p style={{ fontFamily: T.body, fontSize: "16px", color: C.textMid, lineHeight: 1.8, margin: "0 0 36px" }}>
              inflow analyzes any job posting against your resume — scores your fit honestly, rewrites your bullets for each role, gives you specific resume edits, and tracks your entire pipeline with stage-by-stage timestamps.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "40px" }}>
              {[
                "Brutally honest recruiter + hiring manager scoring",
                "AI-powered resume edit suggestions per role",
                "ATS keyword analysis and interview prep",
                "Full pipeline tracker with per-stage date history",
              ].map((f, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                  <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: C.accent, flexShrink: 0, marginTop: "8px" }} />
                  <span style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.6 }}>{f}</span>
                </div>
              ))}
            </div>
            <Btn onClick={() => setStep(1)}>Get Started →</Btn>
          </div>
        )}

        {step === 1 && (
          <div>
            <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.18em", textTransform: "uppercase", margin: "0 0 18px" }}>Setup — Step 1 of 1</p>
            <h2 style={{ fontFamily: T.display, fontSize: "34px", color: C.text, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 12px" }}>Paste your resume.</h2>
            <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 24px" }}>
              Plain text is fine — copy from your Word doc, Google Doc, or PDF. Include your summary, experience, education, and skills. inflow references this for every job you analyze. You can update it anytime in Settings.
            </p>
            <div style={{ marginBottom: "20px" }}>
              <Field value={resume} onChange={setResume} placeholder="Paste your full resume here..." multiline rows={14} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <Btn onClick={save} disabled={!charOk}>Save Resume & Launch →</Btn>
              <span style={{ fontFamily: T.mono, fontSize: "11px", color: charOk ? C.accent : C.textDim }}>
                {resume.trim().length} chars {charOk ? "✓ ready" : `— need ${100 - resume.trim().length} more`}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ANALYZER PAGE ────────────────────────────────────────────────────────────
function AnalyzerPage({ resume, onSaveJob }) {
  const [mode, setMode] = useState("url");
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [scores, setScores] = useState({ recruiter: null, hm: null });
  const [phase, setPhase] = useState("idle");
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [error, setError] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [company, setCompany] = useState("");
  const [savedToast, setSavedToast] = useState(false);
  const resultRef = useRef(null);

  const analyze = async () => {
    if (!input.trim()) return;
    setLoading(true); setResult(""); setScores({ recruiter: null, hm: null });
    setPhase("loading"); setPhaseIdx(0); setError("");
    const interval = setInterval(() => setPhaseIdx(p => (p + 1) % PHASES.length), 1800);
    try {
      const apiKey = localStorage.getItem(KEYS.apiKey);
      const proxyUrl = localStorage.getItem(KEYS.proxyUrl);
      if (!apiKey) { setError("No API key found. Go to Settings and add your Anthropic API key."); clearInterval(interval); setPhase("idle"); setLoading(false); return; }
      const userMsg = isUrl(input)
        ? `Fetch and analyze this job posting URL: ${input.trim()}`
        : `Analyze this job posting:\n\n${input}`;
      const body = {
        model: "claude-sonnet-4-20250514", max_tokens: 1000,
        system: ANALYSIS_PROMPT(resume),
        messages: [{ role: "user", content: userMsg }],
      };
      if (isUrl(input)) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

      const endpoint = proxyUrl ? proxyUrl.replace(/\/$/, '') : "https://api.anthropic.com/v1/messages";
      const headers = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      if (!proxyUrl) headers["anthropic-dangerous-allow-browser"] = "true";

      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) throw new Error(`API error: ${data.error.message || data.error.type}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "No response.";
      clearInterval(interval);
      setResult(text); setScores(parseScores(text)); setPhase("done");
      const tm = text.match(/(?:role|position)[:\s]+([^\n.]{5,60})/i);
      const cm = text.match(/(?:company|at)\s+([A-Z][a-zA-Z\s&,.]+?)(?:\s*[,.\n(])/);
      if (tm) setJobTitle(tm[1].trim().slice(0, 60));
      if (cm) setCompany(cm[1].trim().slice(0, 40));
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 200);
    } catch (err) {
      clearInterval(interval);
      const msg = err.message || "Something went wrong.";
      setError(msg.includes("fetch") ? "Network error — check your connection and try again." : msg);
      setPhase("idle");
    }
    setLoading(false);
  };

  const handleSave = () => {
    const t = now();
    onSaveJob({ id: uid(), title: jobTitle || "Untitled Role", company: company || "Unknown Company", url: isUrl(input) ? input.trim() : "", status: "saved", recruiterScore: scores.recruiter, hmScore: scores.hm, notes: "", analysis: result, dateAdded: t, dateSaved: t, dateApplied: null, dateScreen: null, dateInterview: null, dateOffer: null, dateRejected: null });
    setSavedToast(true); setTimeout(() => setSavedToast(false), 2500);
  };

  const reset = () => { setInput(""); setResult(""); setScores({ recruiter: null, hm: null }); setPhase("idle"); setError(""); setJobTitle(""); setCompany(""); };

  return (
    <div style={{ maxWidth: "740px", margin: "0 auto", padding: "48px 24px 0" }}>
      <div style={{ marginBottom: "44px" }}>
        <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 16px" }}>
          Analyzer · Resume Active
        </p>
        <h1 style={{ fontFamily: T.display, fontSize: "clamp(30px,5vw,44px)", color: C.text, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em", margin: "0 0 14px" }}>
          Drop a job.<br /><span style={{ color: C.accent }}>Get the truth.</span>
        </h1>
        <p style={{ fontFamily: T.body, fontSize: "16px", color: C.textMid, lineHeight: 1.8, margin: 0 }}>
          Paste a URL or full job description. Get scored, rewritten bullets, specific resume edits, interview prep, and an honest verdict.
        </p>
      </div>

      {phase !== "done" && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", overflow: "hidden", marginBottom: "16px" }}>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
            {[{ k: "url", label: "⌁  Job URL" }, { k: "paste", label: "≡  Paste Text" }].map(({ k, label }) => (
              <button key={k} onClick={() => { setMode(k); setInput(""); }} style={{ flex: 1, padding: "14px", background: mode === k ? C.surface2 : "transparent", border: "none", borderBottom: `2px solid ${mode === k ? C.accent : "transparent"}`, color: mode === k ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ padding: "20px" }}>
            {mode === "url"
              ? <Field value={input} onChange={setInput} placeholder="https://careers.company.com/job/12345" mono />
              : <Field value={input} onChange={setInput} placeholder="Paste the full job description — title, responsibilities, requirements, everything..." multiline rows={10} />
            }
          </div>
          {error && (
            <div style={{ margin: "0 20px 20px", padding: "12px 16px", background: "#1a0d0d", border: `1px solid ${C.red}44`, borderRadius: "8px" }}>
              <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.red, margin: 0 }}>⚠ {error}</p>
            </div>
          )}
          <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={analyze} disabled={loading || input.trim().length < 10}>
              {loading ? "Analyzing..." : "Analyze →"}
            </Btn>
          </div>
        </div>
      )}

      {/* Loading */}
      {phase === "loading" && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "44px", textAlign: "center" }}>
          <div style={{ display: "flex", gap: "5px", justifyContent: "center", marginBottom: "22px" }}>
            {[0,1,2,3].map(i => (
              <div key={i} style={{ width: "4px", height: "22px", background: C.accent, borderRadius: "2px", animation: `bar 1.2s ease-in-out ${i*0.15}s infinite` }} />
            ))}
          </div>
          <style>{`@keyframes bar{0%,100%{transform:scaleY(0.35);opacity:0.25}50%{transform:scaleY(1);opacity:1}}`}</style>
          <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.accent, letterSpacing: "0.1em", textTransform: "uppercase", margin: 0 }}>{PHASES[phaseIdx]}</p>
        </div>
      )}

      {/* Results */}
      {phase === "done" && result && (
        <div ref={resultRef}>
          <div style={{ display: "flex", gap: "14px", marginBottom: "16px" }}>
            <ScoreCard label="Recruiter Score" score={scores.recruiter} />
            <ScoreCard label="Hiring Manager Score" score={scores.hm} />
          </div>

          {/* Save card */}
          <div style={{ background: "#0d1a10", border: `1px solid ${C.accent}22`, borderRadius: "12px", padding: "20px 22px", marginBottom: "16px" }}>
            <Label color={C.accent}>Save to Pipeline</Label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
              <Field value={jobTitle} onChange={setJobTitle} placeholder="Job Title" />
              <Field value={company} onChange={setCompany} placeholder="Company" />
            </div>
            <Btn onClick={handleSave}>{savedToast ? "✓ Saved to Pipeline" : "Save to Pipeline →"}</Btn>
          </div>

          {/* Analysis */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "32px 36px", marginBottom: "16px" }}>
            <Render text={result} />
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <Btn onClick={reset}>← New Analysis</Btn>
            <Btn variant="ghost" onClick={() => navigator.clipboard?.writeText(result)}>Copy Analysis</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TRACKER PAGE ─────────────────────────────────────────────────────────────
function TrackerPage({ jobs, onUpdateJob, onDeleteJob, onAddJob }) {
  const [filter, setFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newJob, setNewJob] = useState({ title: "", company: "", url: "", status: "saved", notes: "" });

  const filtered = filter === "all" ? jobs : jobs.filter(j => j.status === filter);
  const stats = {
    total:   jobs.length,
    applied: jobs.filter(j => ["applied","screen","interview","offer"].includes(j.status)).length,
    active:  jobs.filter(j => ["screen","interview"].includes(j.status)).length,
    offers:  jobs.filter(j => j.status === "offer").length,
  };

  const changeStatus = (job, s) => onUpdateJob({ ...job, status: s, ...stampDate(job, s) });

  const addJob = () => {
    if (!newJob.title.trim()) return;
    const t = now();
    onAddJob({ id: uid(), ...newJob, recruiterScore: null, hmScore: null, analysis: "", dateAdded: t, dateSaved: t, dateApplied: null, dateScreen: null, dateInterview: null, dateOffer: null, dateRejected: null });
    setNewJob({ title: "", company: "", url: "", status: "saved", notes: "" });
    setShowAdd(false);
  };

  const cardSub = (job) => {
    const st = SM[job.status];
    const date = st ? job[st.dateKey] : null;
    if (date) return `${st.label} · ${fmtShort(date)}`;
    return job.dateAdded ? `Added ${fmtShort(job.dateAdded)}` : "";
  };

  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "48px 24px 0" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "36px" }}>
        <div>
          <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 12px" }}>Pipeline</p>
          <h1 style={{ fontFamily: T.display, fontSize: "clamp(26px,4vw,38px)", color: C.text, fontWeight: 800, letterSpacing: "-0.03em" }}>Application Tracker</h1>
        </div>
        <Btn onClick={() => setShowAdd(true)} small>+ Add Job</Btn>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "12px", marginBottom: "32px" }}>
        {[
          { l: "Total",       v: stats.total,   c: C.textMid  },
          { l: "Applied",     v: stats.applied, c: C.accent   },
          { l: "Active",      v: stats.active,  c: C.yellow   },
          { l: "Offers",      v: stats.offers,  c: C.mint     },
        ].map(({ l, v, c }) => (
          <div key={l} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "18px 20px" }}>
            <div style={{ fontFamily: T.display, fontSize: "36px", color: c, lineHeight: 1, marginBottom: "8px", fontWeight: 800 }}>{v}</div>
            <div style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "7px", marginBottom: "22px", flexWrap: "wrap" }}>
        <button onClick={() => setFilter("all")} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === "all" ? C.accent : C.border}`, background: filter === "all" ? "#0d1a10" : "transparent", color: filter === "all" ? C.accent : C.textSub, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.08em", cursor: "pointer" }}>
          All ({jobs.length})
        </button>
        {STATUSES.map(s => {
          const count = jobs.filter(j => j.status === s.key).length;
          return (
            <button key={s.key} onClick={() => setFilter(s.key)} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === s.key ? s.color : C.border}`, background: filter === s.key ? s.bg : "transparent", color: filter === s.key ? s.color : C.textSub, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.08em", cursor: "pointer" }}>
              {s.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Job list */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "72px 20px" }}>
          <p style={{ fontFamily: T.display, fontSize: "20px", color: C.border2, fontWeight: 800, marginBottom: "10px" }}>Nothing here yet.</p>
          <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textDim, lineHeight: 1.7 }}>
            {filter === "all" ? "Analyze a job and save it, or add one manually." : `No jobs at "${SM[filter]?.label}" stage.`}
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {filtered.map(job => {
            const st  = SM[job.status] || STATUSES[0];
            const exp = expandedId === job.id;
            return (
              <div key={job.id} style={{ background: C.surface, border: `1px solid ${exp ? C.border2 : C.border}`, borderRadius: "12px", overflow: "hidden" }}>
                {/* Card row */}
                <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: "14px" }}>
                  <Pill label={st.short} color={st.color} bg={st.bg} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontFamily: T.display, fontSize: "16px", color: C.text, margin: "0 0 3px", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{job.title}</p>
                    <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.textSub, margin: 0, lineHeight: 1.4 }}>
                      {job.company}{cardSub(job) ? `  ·  ${cardSub(job)}` : ""}
                    </p>
                  </div>
                  {(job.recruiterScore || job.hmScore) && (
                    <div style={{ display: "flex", gap: "12px", flexShrink: 0 }}>
                      {job.recruiterScore && (
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontFamily: T.display, fontSize: "18px", color: scoreColor(job.recruiterScore), fontWeight: 800, lineHeight: 1 }}>{job.recruiterScore}</div>
                          <div style={{ fontFamily: T.mono, fontSize: "8px", color: C.textDim, letterSpacing: "0.1em", marginTop: "2px" }}>REC</div>
                        </div>
                      )}
                      {job.hmScore && (
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontFamily: T.display, fontSize: "18px", color: scoreColor(job.hmScore), fontWeight: 800, lineHeight: 1 }}>{job.hmScore}</div>
                          <div style={{ fontFamily: T.mono, fontSize: "8px", color: C.textDim, letterSpacing: "0.1em", marginTop: "2px" }}>HM</div>
                        </div>
                      )}
                    </div>
                  )}
                  <button onClick={() => setExpandedId(exp ? null : job.id)} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "6px 10px", color: C.textSub, cursor: "pointer", fontFamily: T.mono, fontSize: "12px", flexShrink: 0 }}>
                    {exp ? "▲" : "▼"}
                  </button>
                </div>

                {/* Expanded panel */}
                {exp && (
                  <div style={{ borderTop: `1px solid ${C.border}`, padding: "22px 20px" }}>
                    <Timeline job={job} />
                    <DateEditor job={job} onUpdate={onUpdateJob} />

                    <div style={{ marginBottom: "22px" }}>
                      <Label>Update Status</Label>
                      <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
                        {STATUSES.map(s => (
                          <button key={s.key} onClick={() => changeStatus(job, s.key)} style={{ padding: "6px 14px", borderRadius: "18px", border: `1px solid ${job.status === s.key ? s.color : C.border}`, background: job.status === s.key ? s.bg : "transparent", color: job.status === s.key ? s.color : C.textSub, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.08em", cursor: "pointer" }}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {job.url && (
                      <div style={{ marginBottom: "18px" }}>
                        <Label>Job URL</Label>
                        <a href={job.url} target="_blank" rel="noreferrer" style={{ fontFamily: T.mono, fontSize: "12px", wordBreak: "break-all", lineHeight: 1.6 }}>{job.url}</a>
                      </div>
                    )}

                    <div style={{ marginBottom: "18px" }}>
                      <Label>Notes</Label>
                      {editingNotes === job.id ? (
                        <div>
                          <Field value={notesDraft} onChange={setNotesDraft} placeholder="Notes..." multiline rows={4} />
                          <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                            <Btn small onClick={() => { onUpdateJob({ ...job, notes: notesDraft }); setEditingNotes(null); }}>Save</Btn>
                            <Btn small variant="ghost" onClick={() => setEditingNotes(null)}>Cancel</Btn>
                          </div>
                        </div>
                      ) : (
                        <div onClick={() => { setEditingNotes(job.id); setNotesDraft(job.notes || ""); }} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "12px 16px", minHeight: "52px", cursor: "text" }}>
                          <p style={{ fontFamily: T.body, fontSize: "15px", color: job.notes ? C.textMid : C.textDim, margin: 0, lineHeight: 1.75 }}>
                            {job.notes || "Click to add notes — recruiter name, follow-up date, what was discussed..."}
                          </p>
                        </div>
                      )}
                    </div>

                    {job.analysis && (
                      <div style={{ marginBottom: "18px" }}>
                        <Label>Analysis Preview</Label>
                        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px 16px", maxHeight: "200px", overflowY: "auto" }}>
                          <p style={{ fontFamily: T.body, fontSize: "14px", color: C.textSub, margin: 0, lineHeight: 1.75, whiteSpace: "pre-wrap" }}>
                            {job.analysis.slice(0, 700)}{job.analysis.length > 700 ? "..." : ""}
                          </p>
                        </div>
                      </div>
                    )}

                    <Btn small variant="danger" onClick={() => { if (window.confirm("Remove this job from your pipeline?")) onDeleteJob(job.id); }}>
                      Remove
                    </Btn>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add modal */}
      {showAdd && (
        <div style={{ position: "fixed", inset: 0, background: "#000000dd", backdropFilter: "blur(12px)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "16px", padding: "32px", width: "100%", maxWidth: "440px" }}>
            <Label color={C.accent}>Add Job Manually</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "22px", marginTop: "4px" }}>
              <Field value={newJob.title} onChange={v => setNewJob(p => ({ ...p, title: v }))} placeholder="Job Title *" />
              <Field value={newJob.company} onChange={v => setNewJob(p => ({ ...p, company: v }))} placeholder="Company" />
              <Field value={newJob.url} onChange={v => setNewJob(p => ({ ...p, url: v }))} placeholder="Job URL (optional)" mono />
              <select value={newJob.status} onChange={e => setNewJob(p => ({ ...p, status: e.target.value }))} style={{ background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "12px 16px", fontSize: "15px", color: C.text, fontFamily: T.mono, outline: "none", width: "100%" }}>
                {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <Field value={newJob.notes} onChange={v => setNewJob(p => ({ ...p, notes: v }))} placeholder="Notes (optional)" multiline rows={3} />
            </div>
            <div style={{ display: "flex", gap: "12px" }}>
              <Btn onClick={addJob} disabled={!newJob.title.trim()}>Add to Pipeline</Btn>
              <Btn variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
function SettingsPage({ resume, onUpdateResume }) {
  const [draft, setDraft] = useState(resume);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEYS.apiKey) || "");
  const [proxyUrl, setProxyUrl] = useState(() => localStorage.getItem(KEYS.proxyUrl) || "");
  const [saved, setSaved] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const charOk = draft.trim().length >= 100;

  const save = async () => {
    if (!charOk) return;
    await store.set(KEYS.resume, draft.trim());
    onUpdateResume(draft.trim());
    setSaved(true); setTimeout(() => setSaved(false), 2500);
  };

  const saveKey = () => {
    if (!apiKey.trim()) return;
    localStorage.setItem(KEYS.apiKey, apiKey.trim());
    if (proxyUrl.trim()) localStorage.setItem(KEYS.proxyUrl, proxyUrl.trim());
    else localStorage.removeItem(KEYS.proxyUrl);
    setKeySaved(true); setTimeout(() => setKeySaved(false), 2500);
  };

  const clearKey = () => { localStorage.removeItem(KEYS.apiKey); localStorage.removeItem(KEYS.proxyUrl); setApiKey(""); setProxyUrl(""); };

  return (
    <div style={{ maxWidth: "740px", margin: "0 auto", padding: "48px 24px 0" }}>
      <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 16px" }}>Settings</p>
      <h1 style={{ fontFamily: T.display, fontSize: "clamp(26px,4vw,38px)", color: C.text, fontWeight: 800, letterSpacing: "-0.03em", margin: "0 0 36px" }}>Settings</h1>

      {/* API Key */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "28px", marginBottom: "18px" }}>
        <Label color={C.accent}>Anthropic API Key</Label>
        <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 18px" }}>
          Your API key is stored locally in your browser and never sent anywhere except directly to Anthropic's API. Get a key at{" "}
          <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">console.anthropic.com</a>.
        </p>
        <div style={{ marginBottom: "14px" }}>
          <Label>API Key</Label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "12px 16px", fontSize: "14px", color: C.text, fontFamily: T.mono, outline: "none", boxSizing: "border-box", marginBottom: "14px" }}
          />
          <Label>Proxy URL <span style={{ color: C.textDim, textTransform: "none", letterSpacing: 0, fontFamily: T.body, fontSize: "13px" }}>— optional, fixes CORS errors</span></Label>
          <input
            type="text"
            value={proxyUrl}
            onChange={e => setProxyUrl(e.target.value)}
            placeholder="https://your-worker.workers.dev"
            style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "12px 16px", fontSize: "14px", color: C.text, fontFamily: T.mono, outline: "none", boxSizing: "border-box" }}
          />
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, lineHeight: 1.7, margin: "10px 0 0" }}>
            Seeing "Access-Control-Allow-Origin" errors? Deploy <code style={{ fontFamily: T.mono, fontSize: "12px", color: C.textSub }}>cloudflare-worker/proxy.js</code> to a free Cloudflare Worker and paste the URL here.
          </p>
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          <Btn onClick={saveKey} disabled={!apiKey.trim()}>{keySaved ? "✓ Saved" : "Save Settings"}</Btn>
          {localStorage.getItem(KEYS.apiKey) && <Btn variant="danger" onClick={clearKey} small>Clear</Btn>}
        </div>
      </div>

      {/* Resume */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "28px", marginBottom: "18px" }}>
        <Label>Resume</Label>
        <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 20px" }}>
          This is the resume inflow uses for every job analysis. Keep it current. All future analyses will use whatever version is saved here.
        </p>
        <Field value={draft} onChange={setDraft} placeholder="Your resume..." multiline rows={22} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
        <Btn onClick={save} disabled={!charOk}>{saved ? "✓ Resume Updated" : "Save Resume"}</Btn>
        <span style={{ fontFamily: T.mono, fontSize: "11px", color: charOk ? C.accent : C.textDim }}>
          {draft.trim().length} characters
        </span>
      </div>
    </div>
  );
}

// ─── PWA UPDATE TOAST ─────────────────────────────────────────────────────────
function UpdateToast() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div style={{ position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', background: C.surface, border: `1px solid ${C.accent}44`, borderRadius: '10px', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: '16px', zIndex: 999, boxShadow: `0 4px 24px #00000066` }}>
      <span style={{ fontFamily: T.body, fontSize: '14px', color: C.textMid }}>New version available</span>
      <button onClick={() => updateServiceWorker(true)} style={{ background: C.accent, color: '#0a0b0a', border: 'none', borderRadius: '6px', padding: '6px 14px', fontFamily: T.mono, fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer', fontWeight: 600 }}>Update</button>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [ready, setReady]   = useState(false);
  const [resume, setResume] = useState(null);
  const [jobs, setJobs]     = useState([]);
  const [page, setPage]     = useState("analyzer");

  useEffect(() => {
    Promise.all([store.get(KEYS.resume), store.get(KEYS.jobs)]).then(([r, j]) => {
      setResume(r || null);
      setJobs(j ? JSON.parse(j) : []);
      setReady(true);
    });
  }, []);

  const persist       = (u) => { setJobs(u); store.set(KEYS.jobs, JSON.stringify(u)); };
  const handleSaveJob = (j) => persist([j, ...jobs]);
  const handleUpdate  = (u) => persist(jobs.map(j => j.id === u.id ? u : j));
  const handleDelete  = (id) => persist(jobs.filter(j => j.id !== id));
  const handleAdd     = (j) => persist([j, ...jobs]);
  const handleResume  = (r) => setResume(r);
  const handleOnboard = (r) => { setResume(r); setPage("analyzer"); };

  const pending = jobs.filter(j => ["screen","interview"].includes(j.status)).length;

  if (!ready) return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <style>{GLOBAL_CSS}</style>
      <span style={{ fontFamily: T.mono, fontSize: "12px", color: C.textDim, letterSpacing: "0.1em" }}>loading...</span>
    </div>
  );

  if (!resume) return (
    <>
      <style>{GLOBAL_CSS}</style>
      <Onboarding onComplete={handleOnboard} />
    </>
  );

  const NAV = [
    { key: "analyzer", label: "Analyze"  },
    { key: "tracker",  label: `Pipeline${jobs.length > 0 ? ` (${jobs.length})` : ""}` },
    { key: "settings", label: "Settings" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: "80px" }}>
      <style>{GLOBAL_CSS}</style>

      <nav style={{ borderBottom: `1px solid ${C.border}`, padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: `${C.bg}f0`, backdropFilter: "blur(20px)", zIndex: 50, height: "56px" }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <svg width="24" height="24" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
            <rect width="48" height="48" rx="10" fill={C.bg} stroke={C.border2} strokeWidth="2"/>
            <circle cx="24" cy="13" r="4.5" fill={C.accent}/>
            <path d="M8 28 C13 22 19 36 24 30 C29 24 35 38 40 32" fill="none" stroke={C.accent} strokeWidth="3" strokeLinecap="round"/>
          </svg>
          <span style={{ fontFamily: T.display, fontSize: "18px", color: C.text, fontWeight: 800, letterSpacing: "-0.02em" }}>inflow</span>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: "3px" }}>
          {NAV.map(({ key, label }) => (
            <button key={key} onClick={() => setPage(key)} style={{ padding: "7px 18px", borderRadius: "7px", background: page === key ? C.surface : "transparent", border: `1px solid ${page === key ? C.border2 : "transparent"}`, color: page === key ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", position: "relative", transition: "all 0.15s" }}>
              {label}
              {key === "tracker" && pending > 0 && (
                <span style={{ position: "absolute", top: "-4px", right: "-4px", width: "16px", height: "16px", borderRadius: "50%", background: C.yellow, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono, fontSize: "9px", color: "#000", fontWeight: 700 }}>{pending}</span>
              )}
            </button>
          ))}
        </div>

        {/* Status indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: C.accent, boxShadow: `0 0 8px ${C.accent}` }} />
          <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.08em", textTransform: "uppercase" }}>Resume Active</span>
        </div>
      </nav>

      {page === "analyzer" && <AnalyzerPage resume={resume} onSaveJob={handleSaveJob} />}
      {page === "tracker"  && <TrackerPage  jobs={jobs} onUpdateJob={handleUpdate} onDeleteJob={handleDelete} onAddJob={handleAdd} />}
      {page === "settings" && <SettingsPage resume={resume} onUpdateResume={handleResume} />}
      <UpdateToast />
    </div>
  );
}
