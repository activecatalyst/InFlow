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
const KEYS = { resume: "inflow_resume_v2", jobs: "inflow_jobs_v2", apiKey: "inflow_api_key", proxyUrl: "inflow_proxy_url", updatedResume: "inflow_resume_updated" };
const store = {
  get: async (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: async (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const STATUSES = [
  { key: "saved",     label: "Bookmarked",    short: "SAVED",     color: C.blue,   bg: "#0d1520", dateKey: "dateSaved"     },
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
const scoreColor = (s) => (s === null || s === undefined) ? C.textDim : s >= 7 ? C.accent : s >= 5 ? C.yellow : C.red;

const parseVerdict = (text) => {
  const m = text.match(/## STEP 8[\s\S]*?\n([\s\S]*?)(?=\n## |$)/i)
            || text.match(/## STEP 7[\s\S]*?\n([\s\S]*?)(?=\n## |$)/i);
  if (!m) return null;
  const raw = m[1].trim();
  const bottomLine = raw.match(/Bottom line:(.*?)(?:\n|$)/i)?.[1]?.trim() || null;
  const body = raw.replace(/Bottom line:.*$/im, '').trim();
  return { body, bottomLine };
};

const parseNextSteps = (text) => {
  const m = text.match(/## STEP 7[\s\S]*?\n([\s\S]*?)(?=\n## STEP 8|$)/i);
  if (!m) return [];
  const block = m[1];
  const actions = [...block.matchAll(/ACTION \d+:\s*(.+)/gi)].map(a => a[1].trim());
  return actions;
};

const parseOdds = (text) => {
  const ats    = text.match(/ATS\s+(?:pass|check)[^%\d]*(\d+)%?/i)?.[1];
  const screen = text.match(/(?:phone\s+)?screen[^%\d]*(\d+)%?/i)?.[1];
  const inter  = text.match(/interview[^%\d]*(\d+)%?/i)?.[1];
  const offer  = text.match(/offer[^%\d]*(\d+)%?/i)?.[1];
  if (!ats && !screen) return null;
  return [
    { label: "ATS",       pct: parseInt(ats || 0) },
    { label: "Screen",    pct: parseInt(screen || 0) },
    { label: "Interview", pct: parseInt(inter || 0) },
    { label: "Offer",     pct: parseInt(offer || 0) },
  ];
};

const scoreLabel = (s) => {
  if (s === null || s === undefined) return "";
  if (s >= 8) return "Strong fit";
  if (s >= 6) return "Viable — gaps exist";
  if (s >= 4) return "Stretch — needs work";
  return "Not ready for this role";
};

const stampDate = (job, newStatus) => {
  const st = SM[newStatus];
  if (!st || job[st.dateKey]) return {};
  return { [st.dateKey]: now() };
};

// ─── ANALYSIS PROMPTS ─────────────────────────────────────────────────────────
const TONE_CONFIG = {
  brutal: {
    label: "Brutal",
    icon: "⚡",
    desc: "No filter. Raw recruiter truth.",
    persona: "You are a brutally honest senior corporate recruiter and hiring manager with 15+ years of experience. No fluff, no sugarcoating, no generic advice. Call out every gap directly. Do not soften bad news.",
    verdictStyle: "Be completely direct about their real odds. If their chances are low, say so plainly. Don't encourage false hope.",
  },
  honest: {
    label: "Honest",
    icon: "◎",
    desc: "Clear feedback with a path forward.",
    persona: "You are an experienced senior corporate recruiter and hiring manager with 15+ years of experience. Be honest and specific, but frame feedback constructively — identify gaps clearly while also highlighting genuine strengths and actionable next steps.",
    verdictStyle: "Be honest about their odds but focus on what they can do to improve their chances. Balance realism with actionable guidance.",
  },
};

const ANALYSIS_PROMPT = (resume, tone = "brutal") => {
  const cfg = TONE_CONFIG[tone] || TONE_CONFIG.brutal;
  return `${cfg.persona}

You have the candidate's resume below. When given a job posting URL or text:
1. If a URL, use web search to fetch the full posting. Confirm the role and company you found.
2. Run this exact analysis. Use ## headers for each step exactly as shown — do not use bold markers or any other format for step headers:

## STEP 1 — RECRUITER EVALUATION
- Recruiter Score (1–10) with one-line verdict
- Top 3 Strengths (specific to this role)
- Top 3 Gaps (${tone === "brutal" ? "direct, no softening" : "clear but constructive"})
- How a recruiter reads this background in 2–3 sentences
- Interview odds: ATS pass / Phone Screen / Interview / Offer (% + one-line reasoning each)

## STEP 2 — HIRING MANAGER VIEW
- Hiring Manager Score (1–10) with one-line verdict
- What will resonate (specific to this role and company)
- What will concern them
- The one question they will definitely ask

## STEP 3 — RESUME OPTIMIZATION
Rewrite the professional summary specifically for this role. Then rewrite the 3 most impactful experience bullets. Strong verbs, specific outcomes, natural ATS keyword integration. Human — not robotic.

## STEP 4 — ATS KEYWORDS
10 specific phrases from this job description the candidate must mirror in their resume and interviews.

## STEP 5 — INTERVIEW PREP
3 questions this interviewer will almost certainly ask. For each: one paragraph coaching note based on the candidate's actual background. Specific — no generic STAR method advice.

## STEP 6 — RESUME EDIT SUGGESTIONS
Provide exactly 5 specific, actionable edits to the candidate's existing resume — formatted exactly like this for each edit:

EDIT [number]:
ORIGINAL: [exact text from their resume]
SUGGESTED: [your rewrite]
WHY: [one sentence explaining the improvement]

Make these edits specific to THIS job. Focus on highest-impact changes only.

## STEP 7 — NEXT STEPS
List exactly 4 concrete, ordered actions the candidate should take before submitting this application. Format as:
ACTION 1: [specific action — be concrete, not generic]
ACTION 2: [specific action]
ACTION 3: [specific action]
ACTION 4: [specific action]

## STEP 8 — HONEST VERDICT
One paragraph. ${cfg.verdictStyle} End with one sentence starting with "Bottom line:"

After Step 8, add this block on its own line — fill in exact values from the job posting, no placeholders:
STRUCTURED_DATA: {"title":"[exact job title]","company":"[company name]","location":"[city, state]","salary":"[salary range or empty string]","jobId":"[job ID or empty string]","workArrangement":"[Remote|Hybrid|On-site|Not specified]","employmentType":"[Full-time|Part-time|Contract|Not specified]","deadline":"[application deadline as YYYY-MM-DD or empty string]","skills":["top skill 1","top skill 2","top skill 3","top skill 4","top skill 5"],"recruiterContact":"[recruiter or hiring manager name/title if found, else empty string]"}

Candidate Resume:
${resume}`;
};


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

// ─── STEP ACCORDION RENDERER ─────────────────────────────────────────────────
const STEP_LABELS = {
  "STEP 1": "Recruiter Evaluation",
  "STEP 2": "Hiring Manager View",
  "STEP 3": "Resume Optimization",
  "STEP 4": "ATS Keywords",
  "STEP 5": "Interview Prep",
  "STEP 6": "Resume Edit Suggestions",
  "STEP 7": "Next Steps",
  "STEP 8": "Honest Verdict",
};

function StepAccordion({ text }) {
  const [open, setOpen] = useState(null); // all collapsed by default

  // Split text into sections by ## STEP markers
  const sections = [];
  let preamble = "";
  const stepRegex = /(?:##\s*|\*\*)(STEP \d+[^*\n]*)(?:\*\*)?/g;
  const parts = text.split(stepRegex);
  if (parts.length > 1) {
    preamble = parts[0];
    for (let i = 1; i < parts.length; i += 2) {
      const header = parts[i];
      const body = parts[i + 1] || "";
      const key = header.match(/STEP \d+/)?.[0] || header;
      const friendlyTitle = Object.entries(STEP_LABELS).find(([k]) => header.includes(k))?.[1] || header;
      sections.push({ key, header, friendlyTitle, body });
    }
  }

  if (sections.length === 0) return <RenderLines text={text} />;

  // Step accent colors for visual variety
  const stepColors = {
    "STEP 1": C.accent,
    "STEP 2": C.yellow,
    "STEP 3": C.mint,
    "STEP 4": C.blue,
    "STEP 5": C.orange,
    "STEP 6": C.red,
    "STEP 7": C.accent,
  };

  return (
    <div>
      {preamble.trim() && (
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "14px 18px", marginBottom: "10px" }}>
          <RenderLines text={preamble} />
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {sections.map(({ key, friendlyTitle, body }) => {
          const isOpen = open === key;
          const stepColor = stepColors[key] || C.accent;
          return (
            <div key={key} style={{ border: `1px solid ${isOpen ? stepColor + "55" : C.border}`, borderRadius: "10px", overflow: "hidden", transition: "border-color 0.2s", background: isOpen ? C.surface : "transparent" }}>
              <button
                onClick={() => setOpen(isOpen ? null : key)}
                style={{ width: "100%", padding: "13px 18px", background: "transparent", border: "none", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", gap: "12px" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ width: "3px", height: "14px", background: isOpen ? stepColor : C.textDim, borderRadius: "2px", flexShrink: 0, transition: "background 0.2s" }} />
                  <span style={{ fontFamily: T.mono, fontSize: "10px", color: isOpen ? stepColor : C.textDim, letterSpacing: "0.14em", textTransform: "uppercase" }}>{key}</span>
                  <span style={{ fontFamily: T.body, fontSize: "14px", color: isOpen ? C.text : C.textSub, fontWeight: isOpen ? 500 : 400 }}>{friendlyTitle}</span>
                </div>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, flexShrink: 0 }}>{isOpen ? "▲" : "▼"}</span>
              </button>
              {isOpen && (
                <div style={{ borderTop: `1px solid ${stepColor}33` }}>
                  <div style={{ padding: "20px 22px 22px" }}>
                    <RenderLines text={body} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── INLINE MARKDOWN RENDERER ─────────────────────────────────────────────────
const RenderLines = ({ text }) => {
  const lines = text.split('\n');
  const elements = [];
  let bulletBuffer = [];

  const flushBullets = () => {
    if (!bulletBuffer.length) return;
    elements.push(
      <div key={`bullets-${elements.length}`} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "12px 16px", margin: "10px 0", display: "flex", flexDirection: "column", gap: "6px" }}>
        {bulletBuffer.map((b, bi) => (
          <div key={bi} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
            <span style={{ color: C.accent, flexShrink: 0, marginTop: "5px", fontSize: "10px" }}>▸</span>
            <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, margin: 0, lineHeight: 1.75 }}>{b}</p>
          </div>
        ))}
      </div>
    );
    bulletBuffer = [];
  };

  lines.forEach((line, i) => {
    if (line.startsWith('### ')) {
      flushBullets();
      elements.push(<h3 key={i} style={{ fontFamily: T.display, fontSize: "16px", color: C.text, margin: "18px 0 6px", fontWeight: 700, lineHeight: 1.4, paddingBottom: "6px", borderBottom: `1px solid ${C.border}` }}>{line.slice(4)}</h3>);
    } else if (/^EDIT \d+:/.test(line)) {
      flushBullets();
      elements.push(<p key={i} style={{ fontFamily: T.mono, fontSize: "12px", color: C.accent, margin: "20px 0 6px", letterSpacing: "0.06em", fontWeight: 500 }}>{line}</p>);
    } else if (line.startsWith('ORIGINAL:')) {
      flushBullets();
      elements.push(
        <div key={i} style={{ background: "#1a0d0d", border: `1px solid ${C.red}33`, borderRadius: "6px", padding: "10px 14px", margin: "4px 0" }}>
          <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.red, opacity: 0.6, margin: "0 0 4px", letterSpacing: "0.1em" }}>ORIGINAL</p>
          <p style={{ fontFamily: T.body, fontSize: "13px", color: "#FCA5A5", margin: 0, lineHeight: 1.6 }}>{line.replace('ORIGINAL:', '').trim()}</p>
        </div>
      );
    } else if (line.startsWith('SUGGESTED:')) {
      elements.push(
        <div key={i} style={{ background: "#0a1a0d", border: `1px solid ${C.accent}33`, borderRadius: "6px", padding: "10px 14px", margin: "4px 0" }}>
          <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, opacity: 0.6, margin: "0 0 4px", letterSpacing: "0.1em" }}>SUGGESTED</p>
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.mint, margin: 0, lineHeight: 1.6 }}>{line.replace('SUGGESTED:', '').trim()}</p>
        </div>
      );
    } else if (line.startsWith('WHY:')) {
      const whyText = line.slice(4).trim().replace(/\*\*/g, '').split('---')[0].trim();
      if (whyText) elements.push(<p key={i} style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, margin: "4px 0 12px", fontStyle: "italic", lineHeight: 1.65, paddingLeft: "4px" }}>↳ {whyText}</p>);
    } else if (line.match(/^[-*] /)) {
      bulletBuffer.push(line.slice(2).replace(/\*\*(.*?)\*\*/g, (_, t) => t));
    } else if (line.trim() === '') {
      flushBullets();
      elements.push(<div key={i} style={{ height: "8px" }} />);
    } else if (line.startsWith('|')) {
      // Table row — frame as a subtle row
      flushBullets();
      const cells = line.split('|').filter(c => c.trim() && !c.match(/^[-\s]+$/));
      if (cells.length > 0) {
        elements.push(
          <div key={i} style={{ display: "grid", gridTemplateColumns: `repeat(${cells.length}, 1fr)`, gap: "0", borderBottom: `1px solid ${C.border}`, padding: "8px 0" }}>
            {cells.map((cell, ci) => (
              <span key={ci} style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, lineHeight: 1.5, paddingRight: "12px" }}>
                {cell.trim().replace(/\*\*(.*?)\*\*/g, (_, t) => t)}
              </span>
            ))}
          </div>
        );
      }
    } else {
      flushBullets();
      const parts = line.split(/\*\*(.*?)\*\*/g);
      elements.push(
        <p key={i} style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "4px 0" }}>
          {parts.map((p, j) => j % 2 === 1 ? <strong key={j} style={{ color: C.text, fontWeight: 600 }}>{p}</strong> : p)}
        </p>
      );
    }
  });
  flushBullets();
  return <>{elements}</>;
};

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

// ─── EDIT CARD ────────────────────────────────────────────────────────────────
function EditCard({ edit, index, isLast = false }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: isLast ? "none" : `1px solid ${C.border}` }}>
      <button onClick={() => setOpen(!open)} style={{ width: "100%", padding: "12px 22px", background: "transparent", border: "none", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: "9px", color: open ? C.accent : C.textDim, letterSpacing: "0.1em", flexShrink: 0 }}>EDIT {index + 1}</span>
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{edit.orig?.slice(0, 60)}{edit.orig?.length > 60 ? "..." : ""}</p>
        </div>
        <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${C.border}` }}>
          <div style={{ padding: "12px 22px", background: "#1a0d0d" }}>
            <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.red, letterSpacing: "0.1em", margin: "0 0 5px", opacity: 0.7 }}>ORIGINAL</p>
            <p style={{ fontFamily: T.body, fontSize: "13px", color: "#FCA5A5", margin: 0, lineHeight: 1.65 }}>{edit.orig}</p>
          </div>
          <div style={{ padding: "12px 22px", background: "#0a1a0d", borderTop: `1px solid ${C.border}` }}>
            <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.accent, letterSpacing: "0.1em", margin: "0 0 5px", opacity: 0.7 }}>SUGGESTED</p>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px" }}>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.mint, margin: 0, lineHeight: 1.65, flex: 1 }}>{edit.sugg}</p>
              <button onClick={() => navigator.clipboard?.writeText(edit.sugg)} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "5px", padding: "4px 10px", fontFamily: T.mono, fontSize: "9px", color: C.textDim, cursor: "pointer", flexShrink: 0, letterSpacing: "0.08em" }}>Copy</button>
            </div>
          </div>
          {edit.why && (
            <div style={{ padding: "10px 22px 12px", background: C.surface2, borderTop: `1px solid ${C.border}` }}>
              <p style={{ fontFamily: T.body, fontSize: "12px", color: C.textDim, margin: 0, lineHeight: 1.6, fontStyle: "italic" }}>↳ {edit.why}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ANALYZER PAGE ────────────────────────────────────────────────────────────
function AnalyzerPage({ resume, onSaveJob }) {
  const [mode, setMode] = useState("paste");
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
  const [tone, setTone] = useState("brutal");
  const [edits, setEdits] = useState([]);
  const [nextSteps, setNextSteps] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const [odds, setOdds] = useState(null);
  const [showFullAnalysis, setShowFullAnalysis] = useState(false);
  const [activeEdit, setActiveEdit] = useState(0);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const resultRef = useRef(null);
  const savedRef  = useRef(false); // prevents duplicate pipeline entries on tone re-run
  const retryTimer = useRef(null);

  const analyze = async (overrideTone) => {
    const activeTone = overrideTone || tone;
    // Guard checks BEFORE any state changes
    if (!input.trim()) return;
    const apiKey = localStorage.getItem(KEYS.apiKey);
    const proxyUrl = localStorage.getItem(KEYS.proxyUrl);
    if (!apiKey) { setError("No API key found. Go to Settings and add your Anthropic API key."); return; }
    savedRef.current = false; // reset save guard for new analysis
    setLoading(true); setResult(""); setScores({ recruiter: null, hm: null });
    setPhase("loading"); setPhaseIdx(0); setError("");
    const interval = setInterval(() => setPhaseIdx(p => (p + 1) % PHASES.length), 1800);
    try {
      const userMsg = isUrl(input)
        ? `Fetch and analyze this job posting URL: ${input.trim()}`
        : `Analyze this job posting:\n\n${input}`;
      const body = {
        model: "claude-sonnet-4-6", max_tokens: 4000,
        system: ANALYSIS_PROMPT(resume, activeTone),
        messages: [{ role: "user", content: userMsg }],
      };
      if (isUrl(input)) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];

      const endpoint = proxyUrl ? proxyUrl.replace(/\/$/, '') : "https://api.anthropic.com/v1/messages";
      const headers = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      if (!proxyUrl) headers["anthropic-dangerous-allow-browser"] = "true";

      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      if (res.status === 503) throw new Error("__503__");
      const data = await res.json();
      if (data.error) {
        if (data.error.type === "authentication_error" || data.error.message?.includes("auth") || data.error.message?.includes("key")) throw new Error("__authError__:" + (data.error.message || ""));
        throw new Error(`API error: ${data.error.message || data.error.type}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "No response.";
      clearInterval(interval);
      // Parse scores once, reuse everywhere
      const parsed = parseScores(text);
      setResult(text); setScores(parsed); setPhase("done");
      // Parse resume edits for prominent display
      const editsRaw = [...text.matchAll(/EDIT \d+:[\s\S]*?(?=EDIT \d+:|## STEP 7|$)/g)].map(m => {
        const block = m[0];
        const orig = (block.match(/ORIGINAL:\s*(.+?)(?=SUGGESTED:|$)/s) || [])[1]?.trim();
        const sugg = (block.match(/SUGGESTED:\s*(.+?)(?=WHY:|$)/s) || [])[1]?.trim();
        const why  = (block.match(/WHY:\s*(.+?)(?=EDIT \d+:|$)/s) || [])[1]?.trim();
        return orig && sugg ? { orig, sugg, why } : null;
      }).filter(Boolean);
      setEdits(editsRaw);
      setNextSteps(parseNextSteps(text));
      setVerdict(parseVerdict(text));
      setOdds(parseOdds(text));
      setShowFullAnalysis(false);
      setActiveEdit(0);
      // Parse structured data block Claude appends after Step 8
      let autoTitle = "Untitled Role", autoCompany = "Unknown Company";
      let autoLocation = "", autoSalary = "", autoJobId = "";
      let autoWorkArrangement = "", autoEmploymentType = "", autoDeadline = "";
      let autoSkills = [], autoRecruiterContact = "";
      const structuredMatch = text.match(/STRUCTURED_DATA:\s*(\{[\s\S]+?\})\s*$/m);
      if (structuredMatch) {
        try {
          const sd = JSON.parse(structuredMatch[1]);
          autoTitle            = sd.title?.trim()            || autoTitle;
          autoCompany          = sd.company?.trim()          || autoCompany;
          autoLocation         = sd.location?.trim()         || "";
          autoSalary           = sd.salary?.trim()           || "";
          autoJobId            = sd.jobId?.trim()            || "";
          autoWorkArrangement  = sd.workArrangement?.trim()  || "";
          autoEmploymentType   = sd.employmentType?.trim()   || "";
          autoDeadline         = sd.deadline?.trim()         || "";
          autoSkills           = Array.isArray(sd.skills) ? sd.skills.filter(Boolean).slice(0,5) : [];
          autoRecruiterContact = sd.recruiterContact?.trim() || "";
        } catch {}
      }
      if (autoTitle === "Untitled Role") {
        // Fallback: strip markdown and try regex
        const cleanText = text.replace(/\*\*/g, '').replace(/\*/g, '');
        const confirmMatch = cleanText.match(/[Tt]his is\s+(?:[Jj]ob [Ii][Dd] [\w-]+ [—–-] )?(.+?) at ((?:The )?[A-Z][a-zA-Z0-9 &.,']+?)(?=\s*[(\n,]|$)/);
        if (confirmMatch) {
          autoTitle   = confirmMatch[1].trim().slice(0, 80);
          autoCompany = confirmMatch[2].trim().slice(0, 40);
        }
      }
      setJobTitle(autoTitle);
      setCompany(autoCompany);
      // Auto-add to pipeline — only if not already saved for this input
      if (!savedRef.current) {
        savedRef.current = true;
        const t2 = now();
        onSaveJob({ id: uid(), title: autoTitle, company: autoCompany, location: autoLocation, salary: autoSalary, jobId: autoJobId, workArrangement: autoWorkArrangement, employmentType: autoEmploymentType, deadline: autoDeadline, skills: autoSkills, recruiterContact: autoRecruiterContact, url: isUrl(input) ? input.trim() : "", status: "saved", recruiterScore: parsed.recruiter, hmScore: parsed.hm, notes: "", interviewNotes: "", followUpDate: null, analysis: text, dateAdded: t2, dateSaved: t2, dateApplied: null, dateScreen: null, dateInterview: null, dateOffer: null, dateRejected: null });
        setSavedToast(true); setTimeout(() => setSavedToast(false), 3000);
      }
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 200);
    } catch (err) {
      clearInterval(interval);
      const msg = err.message || "";
      if (msg === "__503__") {
        // 503: auto-retry after countdown
        setLoading(false); setPhase("idle");
        let secs = 10;
        setRetryCountdown(secs);
        setError("Anthropic API is temporarily overloaded. Retrying in...");
        retryTimer.current = setInterval(() => {
          secs--;
          if (secs <= 0) {
            clearInterval(retryTimer.current);
            setRetryCountdown(0);
            setError("");
            analyze(activeTone);
          } else {
            setRetryCountdown(secs);
          }
        }, 1000);
        return;
      } else if (msg.startsWith("__authError__")) {
        setError("Invalid API key — check your key in Settings. Make sure it starts with sk-ant-.");
      } else if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("Load failed") || msg.includes("fetch")) {
        if (mode === "url") {
          // CORS block from URL mode — auto-switch to paste
          setError("This site blocks direct URL access (CORS). Switch to Paste Text and copy-paste the job description instead.");
          setMode("paste");
          setInput("");
        } else {
          setError("Network error — check your connection and try again.");
        }
      } else {
        setError(msg || "Something went wrong. Please try again.");
      }
      setPhase("idle");
    }
    setLoading(false);
  };

  const reset = () => { setInput(""); setResult(""); setScores({ recruiter: null, hm: null }); setPhase("idle"); setError(""); setJobTitle(""); setCompany(""); setEdits([]); setNextSteps([]); setVerdict(null); setOdds(null); setShowFullAnalysis(false); setActiveEdit(0); };

  return (
    <div style={{ maxWidth: "740px", margin: "0 auto", padding: "48px 24px 0" }}>
      {phase === "idle" && (
      <div style={{ marginBottom: "32px" }}>
        <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 14px" }}>
          Analyzer · Resume Active
        </p>
        <h1 style={{ fontFamily: T.display, fontSize: "clamp(28px,5vw,40px)", color: C.text, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em", margin: "0 0 12px" }}>
          Drop a job.<br /><span style={{ color: C.accent }}>Get the truth.</span>
        </h1>
        <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: 0 }}>
          Paste the job description (or try a URL — note most career sites block direct URL fetching). Get scored, specific resume edits, a clear next steps list, and an honest verdict.
        </p>
      </div>
      )}

      {phase !== "done" && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", overflow: "hidden", marginBottom: "16px" }}>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
            {[{ k: "paste", label: "≡  Paste Text" }, { k: "url", label: "⌁  Job URL" }].map(({ k, label }) => (
              <button key={k} onClick={() => { setMode(k); setInput(""); setError(""); }} style={{ flex: 1, padding: "14px", background: mode === k ? C.surface2 : "transparent", border: "none", borderBottom: `2px solid ${mode === k ? C.accent : "transparent"}`, color: mode === k ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>
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
            <div style={{ margin: "0 20px 20px", padding: "12px 16px", background: "#1a0d0d", border: `1px solid ${C.red}44`, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
              <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.red, margin: 0, flex: 1 }}>⚠ {error}{retryCountdown > 0 ? ` ${retryCountdown}s` : ""}</p>
              {retryCountdown > 0 && (
                <button onClick={() => { clearInterval(retryTimer.current); setRetryCountdown(0); setError(""); }} style={{ background: "transparent", border: `1px solid ${C.red}44`, borderRadius: "5px", padding: "4px 10px", fontFamily: T.mono, fontSize: "10px", color: C.red, cursor: "pointer", flexShrink: 0, letterSpacing: "0.06em" }}>Cancel</button>
              )}
            </div>
          )}
          <div style={{ padding: "0 20px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.1em" }}>TONE</span>
              {Object.entries(TONE_CONFIG).map(([key, cfg]) => (
                <button key={key} onClick={() => setTone(key)} style={{ padding: "5px 14px", borderRadius: "20px", border: `1px solid ${tone === key ? C.accent : C.border}`, background: tone === key ? "#0d1a10" : "transparent", color: tone === key ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.08em", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
                  <span>{cfg.icon}</span> {cfg.label}
                </button>
              ))}
            </div>
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

      {/* Results — Chat Style */}
      {phase === "done" && result && (
        <div ref={resultRef} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>

          {/* ── USER BUBBLE ── */}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "18px 18px 4px 18px", padding: "12px 18px", maxWidth: "80%" }}>
              <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.textSub, margin: 0, wordBreak: "break-all", lineHeight: 1.5 }}>{input.trim().slice(0, 120)}{input.trim().length > 120 ? "..." : ""}</p>
            </div>
          </div>

          {/* ── INFLOW BUBBLE 1: VERDICT + SCORES ── */}
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
            <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: C.surface, border: `1px solid ${C.border2}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "2px" }}>
              <svg width="14" height="14" viewBox="0 0 48 48"><circle cx="24" cy="13" r="4.5" fill={C.accent}/><path d="M8 28 C13 22 19 36 24 30 C29 24 35 38 40 32" fill="none" stroke={C.accent} strokeWidth="3" strokeLinecap="round"/></svg>
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "10px" }}>

              {/* Score row */}
              <div style={{ display: "flex", gap: "10px" }}>
                {[{ label: "Recruiter", score: scores.recruiter }, { label: "Hiring Mgr", score: scores.hm }].map(({ label, score }) => (
                  <div key={label} style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "14px 16px" }}>
                    <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 6px" }}>{label}</p>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginBottom: "8px" }}>
                      <span style={{ fontFamily: T.display, fontSize: "36px", color: scoreColor(score), fontWeight: 800, lineHeight: 1 }}>{score ?? "—"}</span>
                      <span style={{ fontFamily: T.mono, fontSize: "12px", color: C.textDim }}>/10</span>
                    </div>
                    <div style={{ height: "3px", background: C.border2, borderRadius: "2px", marginBottom: "8px" }}>
                      {score && <div style={{ height: "100%", width: `${score * 10}%`, background: scoreColor(score), borderRadius: "2px" }} />}
                    </div>
                    <p style={{ fontFamily: T.body, fontSize: "12px", color: scoreColor(score), margin: 0 }}>{scoreLabel(score)}</p>
                  </div>
                ))}
              </div>

              {/* Odds funnel */}
              {odds && (
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "14px 18px" }}>
                  <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 12px" }}>Interview Odds</p>
                  <div style={{ display: "flex", gap: "6px", alignItems: "flex-end" }}>
                    {odds.map(({ label, pct }) => (
                      <div key={label} style={{ flex: 1, textAlign: "center" }}>
                        <div style={{ height: "48px", background: C.surface2, borderRadius: "6px", display: "flex", alignItems: "flex-end", overflow: "hidden", marginBottom: "6px" }}>
                          <div style={{ width: "100%", height: `${Math.max(pct, 4)}%`, background: pct >= 50 ? C.accent : pct >= 20 ? C.yellow : C.red, opacity: 0.8, borderRadius: "4px 4px 0 0" }} />
                        </div>
                        <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, margin: "0 0 2px", letterSpacing: "0.08em" }}>{label}</p>
                        <p style={{ fontFamily: T.mono, fontSize: "11px", color: pct >= 50 ? C.accent : pct >= 20 ? C.yellow : C.red, margin: 0, fontWeight: 600 }}>{pct}%</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Bottom line verdict */}
              {verdict?.bottomLine && (
                <div style={{ background: "#0d1a10", border: `1px solid ${C.accent}33`, borderRadius: "12px", padding: "14px 18px" }}>
                  <p style={{ fontFamily: T.body, fontSize: "15px", color: C.text, margin: 0, lineHeight: 1.75 }}>
                    <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.1em", marginRight: "8px" }}>BOTTOM LINE</span>
                    {verdict.bottomLine}
                  </p>
                </div>
              )}

              {/* Tone toggle */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.1em" }}>TONE</span>
                {Object.entries(TONE_CONFIG).map(([key, cfg]) => (
                  <button key={key} onClick={() => { setTone(key); analyze(key); }} style={{ padding: "5px 14px", borderRadius: "20px", border: `1px solid ${tone === key ? C.accent : C.border}`, background: tone === key ? "#0d1a10" : "transparent", color: tone === key ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.08em", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
                    <span>{cfg.icon}</span> {cfg.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── INFLOW BUBBLE 2: RESUME EDITS ── */}
          {edits.length > 0 && (
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: C.surface, border: `1px solid ${C.border2}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "2px" }}>
                <svg width="14" height="14" viewBox="0 0 48 48"><circle cx="24" cy="13" r="4.5" fill={C.accent}/><path d="M8 28 C13 22 19 36 24 30 C29 24 35 38 40 32" fill="none" stroke={C.accent} strokeWidth="3" strokeLinecap="round"/></svg>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "4px 18px 18px 18px", overflow: "hidden" }}>
                  {/* Edit nav header */}
                  <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ width: "3px", height: "12px", background: C.accent, borderRadius: "2px" }} />
                      <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>Resume Edits</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim }}>{activeEdit + 1} / {edits.length}</span>
                      <button onClick={() => setActiveEdit(a => Math.max(0, a - 1))} disabled={activeEdit === 0} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "5px", padding: "3px 10px", color: activeEdit === 0 ? C.textDim : C.textSub, cursor: activeEdit === 0 ? "default" : "pointer", fontFamily: T.mono, fontSize: "11px" }}>←</button>
                      <button onClick={() => setActiveEdit(a => Math.min(edits.length - 1, a + 1))} disabled={activeEdit === edits.length - 1} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "5px", padding: "3px 10px", color: activeEdit === edits.length - 1 ? C.textDim : C.textSub, cursor: activeEdit === edits.length - 1 ? "default" : "pointer", fontFamily: T.mono, fontSize: "11px" }}>→</button>
                    </div>
                  </div>
                  {/* Active edit */}
                  {edits[activeEdit] && (
                    <div>
                      <div style={{ padding: "14px 18px", background: "#150a0a", borderBottom: `1px solid ${C.border}` }}>
                        <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.red, letterSpacing: "0.1em", margin: "0 0 6px", opacity: 0.8 }}>BEFORE</p>
                        <p style={{ fontFamily: T.body, fontSize: "14px", color: "#FCA5A5", margin: 0, lineHeight: 1.7 }}>{edits[activeEdit].orig}</p>
                      </div>
                      <div style={{ padding: "14px 18px", background: "#0a150a", borderBottom: `1px solid ${C.border}` }}>
                        <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.accent, letterSpacing: "0.1em", margin: "0 0 6px", opacity: 0.8 }}>AFTER</p>
                        <p style={{ fontFamily: T.body, fontSize: "14px", color: C.mint, margin: 0, lineHeight: 1.7 }}>{edits[activeEdit].sugg}</p>
                      </div>
                      <div style={{ padding: "12px 18px", background: C.surface2, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
                        <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, margin: 0, lineHeight: 1.6, fontStyle: "italic", flex: 1 }}>↳ {edits[activeEdit].why || "Stronger action verb + measurable outcome"}</p>
                        <button onClick={() => navigator.clipboard?.writeText(edits[activeEdit].sugg)} style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "6px 14px", fontFamily: T.mono, fontSize: "10px", color: C.accent, cursor: "pointer", letterSpacing: "0.08em", flexShrink: 0 }}>Copy ↗</button>
                      </div>
                    </div>
                  )}
                  {/* Edit dots */}
                  <div style={{ padding: "10px 18px", display: "flex", gap: "6px", justifyContent: "center" }}>
                    {edits.map((_, i) => (
                      <button key={i} onClick={() => setActiveEdit(i)} style={{ width: i === activeEdit ? "18px" : "6px", height: "6px", borderRadius: "3px", background: i === activeEdit ? C.accent : C.border2, border: "none", cursor: "pointer", transition: "width 0.2s, background 0.2s", padding: 0 }} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── INFLOW BUBBLE 3: NEXT STEPS ── */}
          {nextSteps.length > 0 && (
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: C.surface, border: `1px solid ${C.border2}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "2px" }}>
                <svg width="14" height="14" viewBox="0 0 48 48"><circle cx="24" cy="13" r="4.5" fill={C.accent}/><path d="M8 28 C13 22 19 36 24 30 C29 24 35 38 40 32" fill="none" stroke={C.accent} strokeWidth="3" strokeLinecap="round"/></svg>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "4px 18px 18px 18px", padding: "16px 20px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
                    <div style={{ width: "3px", height: "12px", background: C.yellow, borderRadius: "2px" }} />
                    <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.yellow, letterSpacing: "0.12em", textTransform: "uppercase" }}>Before You Apply</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {nextSteps.map((step, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                        <div style={{ width: "22px", height: "22px", borderRadius: "50%", border: `1.5px solid ${C.border2}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "2px" }}>
                          <span style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim }}>{i + 1}</span>
                        </div>
                        <p style={{ fontFamily: T.body, fontSize: "14px", color: C.textMid, margin: 0, lineHeight: 1.7 }}>{step}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── FULL ANALYSIS TOGGLE ── */}
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
            <div style={{ width: "28px", flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <button onClick={() => setShowFullAnalysis(s => !s)} style={{ width: "100%", background: "transparent", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginBottom: showFullAnalysis ? "10px" : "0" }}>
                <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textSub, letterSpacing: "0.1em", textTransform: "uppercase" }}>Full Analysis (7 steps)</span>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>{showFullAnalysis ? "▲ Hide" : "▼ Show"}</span>
              </button>
              {showFullAnalysis && (
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "28px 32px" }}>
                  <StepAccordion text={result} />
                </div>
              )}
            </div>
          </div>

          {/* ── AUTO-SAVED + ACTIONS ── */}
          <div style={{ display: "flex", gap: "10px", alignItems: "center", paddingLeft: "38px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "#0d1a10", border: `1px solid ${C.accent}22`, borderRadius: "20px", padding: "6px 14px" }}>
              <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: C.accent }} />
              <span style={{ fontFamily: T.mono, fontSize: "9px", color: C.accent, letterSpacing: "0.1em" }}>Saved to Pipeline</span>
            </div>
            <button onClick={reset} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: "20px", padding: "6px 16px", fontFamily: T.mono, fontSize: "10px", color: C.textDim, cursor: "pointer", letterSpacing: "0.08em" }}>New Analysis</button>
            <button onClick={() => navigator.clipboard?.writeText(result)} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: "20px", padding: "6px 16px", fontFamily: T.mono, fontSize: "10px", color: C.textDim, cursor: "pointer", letterSpacing: "0.08em" }}>Copy</button>
            <button onClick={() => { const blob = new Blob([result], { type: "text/plain;charset=utf-8;" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); const fname = `inflow-${(jobTitle||"analysis").replace(/[^a-z0-9]/gi,"-").toLowerCase()}-${new Date().toISOString().slice(0,10)}.txt`; a.href=url; a.download=fname; a.click(); URL.revokeObjectURL(url); }} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: "20px", padding: "6px 16px", fontFamily: T.mono, fontSize: "10px", color: C.textDim, cursor: "pointer", letterSpacing: "0.08em" }}>↓ Save</button>
          </div>

        </div>
      )}
    </div>
  );
}

// ─── EDIT JOB MODAL ───────────────────────────────────────────────────────────
function EditJobModal({ job, onSave, onClose }) {
  const [draft, setDraft] = useState({
    title:   job.title   || "",
    company: job.company || "",
    url:     job.url     || "",
    notes:   job.notes   || "",
    status:  job.status  || "saved",
  });
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState("");
  const [rerunStatus, setRerunStatus] = useState("");

  const save = () => {
    if (!draft.title.trim()) return;
    onSave({ ...job, ...draft, status: draft.status, ...stampDate(job, draft.status) });
  };

  const rerunAnalysis = async () => {
    const apiKey = localStorage.getItem(KEYS.apiKey);
    const proxyUrl = localStorage.getItem(KEYS.proxyUrl);
    const resume = localStorage.getItem(KEYS.resume);
    const targetUrl = draft.url || job.url;
    if (!apiKey) { setRerunError("No API key. Go to Settings."); return; }
    if (!resume) { setRerunError("No resume found."); return; }
    if (!targetUrl && !job.analysis) { setRerunError("No URL to re-analyze."); return; }

    setRerunning(true); setRerunError(""); setRerunStatus("Fetching job posting...");

    try {
      const userMsg = targetUrl
        ? `Fetch and analyze this job posting URL: ${targetUrl}`
        : `Re-analyze this job based on the original analysis context:\n\n${job.analysis?.slice(0, 1000)}`;

      const body = {
        model: "claude-sonnet-4-6", max_tokens: 4000,
        system: ANALYSIS_PROMPT(resume, "brutal"),
        messages: [{ role: "user", content: userMsg }],
      };
      if (targetUrl) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];

      const endpoint = proxyUrl ? proxyUrl.replace(/\/$/, '') : "https://api.anthropic.com/v1/messages";
      const headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
      if (!proxyUrl) headers["anthropic-dangerous-allow-browser"] = "true";

      setRerunStatus("Analyzing...");
      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
      const parsed = parseScores(text);

      // Save updated job with fresh analysis and scores
      onSave({
        ...job,
        ...draft,
        analysis: text,
        recruiterScore: parsed.recruiter ?? job.recruiterScore,
        hmScore: parsed.hm ?? job.hmScore,
        updatedRecruiterScore: null,
        updatedHmScore: null,
        updatedScoreSummary: "",
      });
    } catch (err) {
      setRerunError(err.message || "Re-analysis failed.");
      setRerunning(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000ee", backdropFilter: "blur(12px)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "16px", width: "100%", maxWidth: "520px", maxHeight: "90vh", overflowY: "auto" }}>

        {/* Header */}
        <div style={{ padding: "22px 28px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Label color={C.accent}>Edit Job</Label>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: "16px", lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ padding: "16px 28px 28px", display: "flex", flexDirection: "column", gap: "14px" }}>

          {/* Title */}
          <div>
            <Label>Job Title</Label>
            <Field value={draft.title} onChange={v => setDraft(p => ({ ...p, title: v }))} placeholder="Job Title *" />
          </div>

          {/* Company */}
          <div>
            <Label>Company</Label>
            <Field value={draft.company} onChange={v => setDraft(p => ({ ...p, company: v }))} placeholder="Company" />
          </div>

          {/* URL */}
          <div>
            <Label>Job URL</Label>
            <Field value={draft.url} onChange={v => setDraft(p => ({ ...p, url: v }))} placeholder="https://..." mono />
          </div>

          {/* Status */}
          <div>
            <Label>Status</Label>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {STATUSES.map(s => (
                <button key={s.key} onClick={() => setDraft(p => ({ ...p, status: s.key }))} style={{ padding: "6px 14px", borderRadius: "18px", border: `1px solid ${draft.status === s.key ? s.color : C.border}`, background: draft.status === s.key ? s.bg : "transparent", color: draft.status === s.key ? s.color : C.textSub, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.08em", cursor: "pointer" }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label>Notes</Label>
            <Field value={draft.notes} onChange={v => setDraft(p => ({ ...p, notes: v }))} placeholder="Notes..." multiline rows={4} />
          </div>

          {/* Re-run analysis */}
          <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: rerunError ? "10px" : "0" }}>
              <div>
                <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>Re-run Analysis</p>
                <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, margin: 0, lineHeight: 1.5 }}>
                  {rerunning ? rerunStatus : "Fetch fresh scores and analysis using the current URL and your base resume."}
                </p>
              </div>
              <Btn small onClick={rerunAnalysis} disabled={rerunning}>
                {rerunning ? "Running..." : "⚡ Re-run"}
              </Btn>
            </div>
            {rerunError && (
              <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.red, margin: "8px 0 0", letterSpacing: "0.06em" }}>⚠ {rerunError}</p>
            )}
          </div>

          {/* Scores preview */}
          {(job.recruiterScore || job.hmScore) && (
            <div style={{ display: "flex", gap: "10px" }}>
              {[{ l: "Recruiter Score", v: job.recruiterScore }, { l: "HM Score", v: job.hmScore }].map(({ l, v }) => (
                <div key={l} style={{ flex: 1, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "10px 14px" }}>
                  <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 4px" }}>{l}</p>
                  <span style={{ fontFamily: T.display, fontSize: "22px", color: scoreColor(v), fontWeight: 800 }}>{v}</span>
                  <span style={{ fontFamily: T.mono, fontSize: "12px", color: C.textDim }}>/10</span>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: "12px", paddingTop: "4px" }}>
            <Btn onClick={save} disabled={!draft.title.trim()}>Save Changes</Btn>
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── TRACKER PAGE ─────────────────────────────────────────────────────────────
function TrackerPage({ jobs, onUpdateJob, onDeleteJob, onAddJob, updatedResume }) {
  const [filter, setFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editingJob, setEditingJob] = useState(null); // job being edited
  const [newJob, setNewJob] = useState({ title: "", company: "", url: "", status: "saved", notes: "" });

  const activeJobs = jobs.filter(j => j.status !== "rejected");
  const rejectedJobs = jobs.filter(j => j.status === "rejected");
  const filtered = filter === "all"
    ? activeJobs
    : filter === "rejected"
    ? rejectedJobs
    : jobs.filter(j => j.status === filter);

  const today = new Date();
  const stats = {
    total:      activeJobs.length,
    applied:    activeJobs.filter(j => ["applied","screen","interview","offer"].includes(j.status)).length,
    active:     activeJobs.filter(j => ["screen","interview"].includes(j.status)).length,
    offers:     activeJobs.filter(j => j.status === "offer").length,
    followUps:  activeJobs.filter(j => j.followUpDate && new Date(j.followUpDate) <= today).length,
  };

  const changeStatus = (job, s) => onUpdateJob({ ...job, status: s, ...stampDate(job, s) });

  const addJob = () => {
    if (!newJob.title.trim()) return;
    const t = now();
    onAddJob({ id: uid(), ...newJob, recruiterScore: null, hmScore: null, analysis: "", interviewNotes: "", followUpDate: null, skills: [], workArrangement: "", employmentType: "", deadline: "", recruiterContact: "", location: "", salary: "", jobId: "", dateAdded: t, dateSaved: t, dateApplied: null, dateScreen: null, dateInterview: null, dateOffer: null, dateRejected: null });
    setNewJob({ title: "", company: "", url: "", status: "saved", notes: "" });
    setShowAdd(false);
  };

  const exportCSV = () => {
    if (!jobs.length) return;
    const cols = [
      "Title", "Company", "Status", "Recruiter Score", "HM Score",
      "Date Added", "Date Applied", "Date Screen", "Date Interview",
      "Date Offer", "Date Rejected", "URL", "Notes"
    ];
    const escape = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
    const toRows = (list) => list.map(j => [
      escape(j.title), escape(j.company), escape(SM[j.status]?.label || j.status),
      escape(j.recruiterScore ?? ""), escape(j.hmScore ?? ""),
      escape(fmtDate(j.dateAdded) || ""), escape(fmtDate(j.dateApplied) || ""),
      escape(fmtDate(j.dateScreen) || ""), escape(fmtDate(j.dateInterview) || ""),
      escape(fmtDate(j.dateOffer) || ""), escape(fmtDate(j.dateRejected) || ""),
      escape(j.url), escape(j.notes),
    ].join(","));
    const header = cols.map(c => `"${c}"`).join(",");
    const dl = (rows, name) => {
      const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
    };
    const date = new Date().toISOString().slice(0, 10);
    dl(toRows(activeJobs), `inflow-active-${date}.csv`);
    if (rejectedJobs.length) setTimeout(() => dl(toRows(rejectedJobs), `inflow-rejected-${date}.csv`), 300);
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
        <div style={{ display: "flex", gap: "8px" }}>
          {jobs.length > 0 && (
            <Btn onClick={exportCSV} variant="ghost" small>↓ Export CSV</Btn>
          )}
          <Btn onClick={() => setShowAdd(true)} small>+ Add Job</Btn>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "12px", marginBottom: "32px" }}>
        {[
          { l: "Active",       v: stats.total,     c: C.textMid  },
          { l: "Applied",      v: stats.applied,   c: C.accent   },
          { l: "In Progress",  v: stats.active,    c: C.yellow   },
          { l: "Follow-ups",   v: stats.followUps, c: stats.followUps > 0 ? C.orange : C.textMid },
        ].map(({ l, v, c }) => (
          <div key={l} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "18px 20px" }}>
            <div style={{ fontFamily: T.display, fontSize: "36px", color: c, lineHeight: 1, marginBottom: "8px", fontWeight: 800 }}>{v}</div>
            <div style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "7px", marginBottom: "22px", flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => setFilter("all")} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === "all" ? C.accent : C.border}`, background: filter === "all" ? "#0d1a10" : "transparent", color: filter === "all" ? C.accent : C.textSub, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.08em", cursor: "pointer" }}>
          Active ({activeJobs.length})
        </button>
        {STATUSES.filter(s => s.key !== "rejected").map(s => {
          const count = jobs.filter(j => j.status === s.key).length;
          return (
            <button key={s.key} onClick={() => setFilter(s.key)} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === s.key ? s.color : C.border}`, background: filter === s.key ? s.bg : "transparent", color: filter === s.key ? s.color : C.textSub, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.08em", cursor: "pointer" }}>
              {s.label} ({count})
            </button>
          );
        })}
        {/* Rejected — separated visually */}
        {rejectedJobs.length > 0 && (
          <>
            <div style={{ width: "1px", height: "20px", background: C.border, flexShrink: 0 }} />
            <button onClick={() => setFilter("rejected")} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === "rejected" ? C.red : C.border}`, background: filter === "rejected" ? "#1a0d0d" : "transparent", color: filter === "rejected" ? C.red : C.textDim, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.08em", cursor: "pointer", opacity: filter === "rejected" ? 1 : 0.6 }}>
              Rejected ({rejectedJobs.length})
            </button>
          </>
        )}
      </div>

      {/* Job list */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "72px 20px" }}>
          <p style={{ fontFamily: T.display, fontSize: "20px", color: C.border2, fontWeight: 800, marginBottom: "10px" }}>Nothing here yet.</p>
          <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textDim, lineHeight: 1.7 }}>
            {filter === "all" ? "Analyze a job and save it, or add one manually." : filter === "rejected" ? "No rejected jobs. Keep it that way." : `No jobs at "${SM[filter]?.label}" stage.`}
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
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "3px", flexWrap: "wrap" }}>
                      <p style={{ fontFamily: T.display, fontSize: "16px", color: C.text, margin: 0, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{job.title}</p>
                      {job.workArrangement && job.workArrangement !== "Not specified" && (
                        <span style={{ fontFamily: T.mono, fontSize: "9px", color: job.workArrangement === "Remote" ? C.mint : C.yellow, background: job.workArrangement === "Remote" ? "#0a1a0d" : "#1a1800", border: `1px solid ${job.workArrangement === "Remote" ? C.mint : C.yellow}44`, borderRadius: "4px", padding: "2px 7px", letterSpacing: "0.08em", flexShrink: 0 }}>{job.workArrangement.toUpperCase()}</span>
                      )}
                      {job.employmentType && job.employmentType !== "Not specified" && job.employmentType !== "Full-time" && (
                        <span style={{ fontFamily: T.mono, fontSize: "9px", color: C.blue, background: "#0d1520", border: `1px solid ${C.blue}44`, borderRadius: "4px", padding: "2px 7px", letterSpacing: "0.08em", flexShrink: 0 }}>{job.employmentType.toUpperCase()}</span>
                      )}
                    </div>
                    <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.textSub, margin: 0, lineHeight: 1.4 }}>
                      {job.company}{job.location ? `  ·  ${job.location}` : ""}{cardSub(job) ? `  ·  ${cardSub(job)}` : ""}
                    </p>
                    {(job.salary || job.deadline) && (
                      <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, margin: "2px 0 0", lineHeight: 1.4 }}>
                        {job.salary}{job.salary && job.deadline ? "  ·  " : ""}{job.deadline ? `Deadline: ${fmtDate(job.deadline + "T12:00:00")}` : ""}
                      </p>
                    )}
                    {job.skills?.length > 0 && (
                      <div style={{ display: "flex", gap: "5px", flexWrap: "wrap", marginTop: "6px" }}>
                        {job.skills.map((s, i) => <span key={i} style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "2px 7px" }}>{s}</span>)}
                      </div>
                    )}
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

                    <ReScoreCard job={job} updatedResume={updatedResume} onUpdate={onUpdateJob} />

                    {job.url && (
                      <div style={{ marginBottom: "18px" }}>
                        <Label>Job URL</Label>
                        <a href={job.url} target="_blank" rel="noreferrer" style={{ fontFamily: T.mono, fontSize: "12px", wordBreak: "break-all", lineHeight: 1.6 }}>{job.url}</a>
                      </div>
                    )}

                    {/* Follow-up date */}
                    <div style={{ marginBottom: "18px" }}>
                      <Label>Follow-up Date</Label>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <input type="date" value={job.followUpDate ? job.followUpDate.slice(0,10) : ""}
                          onChange={e => onUpdateJob({ ...job, followUpDate: e.target.value ? new Date(e.target.value + "T12:00:00").toISOString() : null })}
                          style={{ background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "7px 12px", fontSize: "13px", color: job.followUpDate ? C.text : C.textDim, fontFamily: T.mono, outline: "none", colorScheme: "dark" }} />
                        {job.followUpDate && (() => {
                          const daysUntil = Math.ceil((new Date(job.followUpDate) - new Date()) / 86400000);
                          const color = daysUntil < 0 ? C.red : daysUntil <= 2 ? C.yellow : C.textDim;
                          return <span style={{ fontFamily: T.mono, fontSize: "11px", color }}>{daysUntil < 0 ? `${Math.abs(daysUntil)}d overdue` : daysUntil === 0 ? "Today" : `in ${daysUntil}d`}</span>;
                        })()}
                      </div>
                    </div>

                    {/* Recruiter contact */}
                    {job.recruiterContact && (
                      <div style={{ marginBottom: "18px" }}>
                        <Label>Recruiter / Contact</Label>
                        <p style={{ fontFamily: T.body, fontSize: "14px", color: C.textMid, margin: 0 }}>{job.recruiterContact}</p>
                      </div>
                    )}

                    {/* Notes */}
                    <div style={{ marginBottom: "18px" }}>
                      <Label>Notes</Label>
                      {editingNotes === job.id ? (
                        <div>
                          <Field value={notesDraft} onChange={setNotesDraft} placeholder="Notes — recruiter name, what to prep, anything relevant..." multiline rows={4} />
                          <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                            <Btn small onClick={() => { onUpdateJob({ ...job, notes: notesDraft }); setEditingNotes(null); }}>Save</Btn>
                            <Btn small variant="ghost" onClick={() => setEditingNotes(null)}>Cancel</Btn>
                          </div>
                        </div>
                      ) : (
                        <div onClick={() => { setEditingNotes(job.id); setNotesDraft(job.notes || ""); }} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "12px 16px", minHeight: "52px", cursor: "text" }}>
                          <p style={{ fontFamily: T.body, fontSize: "15px", color: job.notes ? C.textMid : C.textDim, margin: 0, lineHeight: 1.75 }}>
                            {job.notes || "Click to add notes..."}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Interview notes */}
                    <div style={{ marginBottom: "18px" }}>
                      <Label>Interview Notes</Label>
                      {editingNotes === job.id + "_interview" ? (
                        <div>
                          <Field value={notesDraft} onChange={setNotesDraft} placeholder="Who you spoke to, what was discussed, questions asked, next steps..." multiline rows={5} />
                          <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                            <Btn small onClick={() => { onUpdateJob({ ...job, interviewNotes: notesDraft }); setEditingNotes(null); }}>Save</Btn>
                            <Btn small variant="ghost" onClick={() => setEditingNotes(null)}>Cancel</Btn>
                          </div>
                        </div>
                      ) : (
                        <div onClick={() => { setEditingNotes(job.id + "_interview"); setNotesDraft(job.interviewNotes || ""); }} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "12px 16px", minHeight: "52px", cursor: "text" }}>
                          <p style={{ fontFamily: T.body, fontSize: "15px", color: job.interviewNotes ? C.textMid : C.textDim, margin: 0, lineHeight: 1.75 }}>
                            {job.interviewNotes || "Click to add interview notes..."}
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

                    <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                      <Btn small variant="ghost" onClick={() => setEditingJob({ ...job })}>✏ Edit Job</Btn>
                      <Btn small variant="danger" onClick={() => { if (window.confirm("Remove this job from your pipeline?")) onDeleteJob(job.id); }}>
                        Remove
                      </Btn>
                    </div>
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

      {/* Edit Job Modal */}
      {editingJob && (
        <EditJobModal
          job={editingJob}
          onSave={(updated) => { onUpdateJob(updated); setEditingJob(null); }}
          onClose={() => setEditingJob(null)}
        />
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

  const clearKey = () => { if (!window.confirm("Clear your saved API key and proxy URL? You'll need to re-enter them.")) return; localStorage.removeItem(KEYS.apiKey); localStorage.removeItem(KEYS.proxyUrl); setApiKey(""); setProxyUrl(""); };

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

// ─── RESCORE CARD ─────────────────────────────────────────────────────────────
function ReScoreCard({ job, updatedResume, onUpdate }) {
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState("");

  const hasUpdated = !!updatedResume?.trim();
  const hasScores = job.updatedRecruiterScore != null || job.updatedHmScore != null;

  const delta = (orig, updated) => {
    if (orig == null || updated == null) return null;
    const d = updated - orig;
    if (d === 0) return <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim }}>→ {updated}</span>;
    return (
      <span style={{ fontFamily: T.mono, fontSize: "10px", color: d > 0 ? C.accent : C.red }}>
        {d > 0 ? `↑${d}` : `↓${Math.abs(d)}`} → {updated}
      </span>
    );
  };

  const runRescore = async () => {
    const apiKey = localStorage.getItem(KEYS.apiKey);
    const proxyUrl = localStorage.getItem(KEYS.proxyUrl);
    if (!apiKey) { setError("No API key. Go to Settings."); return; }
    if (!hasUpdated) { setError("No updated resume saved. Go to the Resume tab first."); return; }

    setScoring(true); setError("");
    try {
      const prompt = `You are a senior recruiter. Re-score this candidate for the job below using their UPDATED resume.

Return ONLY this exact format — nothing else:
RECRUITER SCORE: [number 1-10]
HIRING MANAGER SCORE: [number 1-10]
CHANGE SUMMARY: [one sentence explaining the key improvement or remaining gap]

ORIGINAL RECRUITER SCORE: ${job.recruiterScore ?? "unknown"}
ORIGINAL HM SCORE: ${job.hmScore ?? "unknown"}

UPDATED RESUME:
${updatedResume}

JOB CONTEXT (from original analysis):
${job.analysis?.slice(0, 800) || "No analysis available."}`;

      const endpoint = proxyUrl ? proxyUrl.replace(/\/$/, '') : "https://api.anthropic.com/v1/messages";
      const headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
      if (!proxyUrl) headers["anthropic-dangerous-allow-browser"] = "true";

      const res = await fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 200, messages: [{ role: "user", content: prompt }] })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
      const rMatch = text.match(/RECRUITER SCORE:\s*(\d+(?:\.\d+)?)/i);
      const hMatch = text.match(/HIRING MANAGER SCORE:\s*(\d+(?:\.\d+)?)/i);
      const sMatch = text.match(/CHANGE SUMMARY:\s*(.+)/i);
      onUpdate({
        ...job,
        updatedRecruiterScore: rMatch ? parseFloat(rMatch[1]) : null,
        updatedHmScore: hMatch ? parseFloat(hMatch[1]) : null,
        updatedScoreSummary: sMatch ? sMatch[1].trim() : "",
        updatedScoreDate: now(),
      });
    } catch (err) {
      setError(err.message || "Re-score failed.");
    }
    setScoring(false);
  };

  return (
    <div style={{ marginBottom: "18px" }}>
      <Label>Projected Score with Updated Resume</Label>
      {!hasUpdated ? (
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "12px 16px" }}>
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, margin: 0, lineHeight: 1.6 }}>
            No updated resume saved. Go to the <strong style={{ color: C.textSub }}>Resume</strong> tab, paste your edited resume, and save it — then come back to re-score.
          </p>
        </div>
      ) : (
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "10px", overflow: "hidden" }}>
          {hasScores ? (
            <div style={{ padding: "14px 18px" }}>
              <div style={{ display: "flex", gap: "24px", marginBottom: "10px" }}>
                <div>
                  <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>Recruiter</p>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontFamily: T.display, fontSize: "24px", color: scoreColor(job.recruiterScore), fontWeight: 800, lineHeight: 1, opacity: 0.5 }}>{job.recruiterScore}</span>
                    <span style={{ fontFamily: T.mono, fontSize: "12px", color: C.textDim }}>→</span>
                    <span style={{ fontFamily: T.display, fontSize: "28px", color: scoreColor(job.updatedRecruiterScore), fontWeight: 800, lineHeight: 1 }}>{job.updatedRecruiterScore}</span>
                    <span style={{ fontFamily: T.mono, fontSize: "10px", color: (job.updatedRecruiterScore - job.recruiterScore) > 0 ? C.accent : C.red }}>
                      {job.updatedRecruiterScore > job.recruiterScore ? `↑${job.updatedRecruiterScore - job.recruiterScore}` : job.updatedRecruiterScore < job.recruiterScore ? `↓${job.recruiterScore - job.updatedRecruiterScore}` : "→"}
                    </span>
                  </div>
                </div>
                <div>
                  <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>HM Score</p>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontFamily: T.display, fontSize: "24px", color: scoreColor(job.hmScore), fontWeight: 800, lineHeight: 1, opacity: 0.5 }}>{job.hmScore}</span>
                    <span style={{ fontFamily: T.mono, fontSize: "12px", color: C.textDim }}>→</span>
                    <span style={{ fontFamily: T.display, fontSize: "28px", color: scoreColor(job.updatedHmScore), fontWeight: 800, lineHeight: 1 }}>{job.updatedHmScore}</span>
                    <span style={{ fontFamily: T.mono, fontSize: "10px", color: (job.updatedHmScore - job.hmScore) > 0 ? C.accent : C.red }}>
                      {job.updatedHmScore > job.hmScore ? `↑${job.updatedHmScore - job.hmScore}` : job.updatedHmScore < job.hmScore ? `↓${job.hmScore - job.updatedHmScore}` : "→"}
                    </span>
                  </div>
                </div>
              </div>
              {job.updatedScoreSummary && (
                <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: "0 0 12px", lineHeight: 1.6, fontStyle: "italic" }}>↳ {job.updatedScoreSummary}</p>
              )}
              {job.updatedScoreDate && (
                <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, margin: "0 0 12px", letterSpacing: "0.08em" }}>Last scored {fmtDate(job.updatedScoreDate)}</p>
              )}
              <Btn small variant="ghost" onClick={runRescore} disabled={scoring}>{scoring ? "Scoring..." : "Re-run Score"}</Btn>
            </div>
          ) : (
            <div style={{ padding: "14px 18px" }}>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: "0 0 12px", lineHeight: 1.6 }}>
                Updated resume is saved. Run a re-score to see projected score improvements.
              </p>
              <Btn small onClick={runRescore} disabled={scoring}>{scoring ? "Scoring..." : "⚡ Run Re-Score"}</Btn>
            </div>
          )}
          {error && <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.red, margin: "0 18px 14px", letterSpacing: "0.06em" }}>⚠ {error}</p>}
        </div>
      )}
    </div>
  );
}

// ─── RESUME PAGE ──────────────────────────────────────────────────────────────
function ResumePage({ baseResume, updatedResume, onUpdateBase, onUpdateUpdated }) {
  const [activeTab, setActiveTab] = useState("base");
  const [baseDraft, setBaseDraft] = useState(baseResume || "");
  const [updatedDraft, setUpdatedDraft] = useState(updatedResume || "");
  const [baseSaved, setBaseSaved] = useState(false);
  const [updatedSaved, setUpdatedSaved] = useState(false);

  const saveBase = async () => {
    if (baseDraft.trim().length < 100) return;
    await store.set(KEYS.resume, baseDraft.trim());
    onUpdateBase(baseDraft.trim());
    setBaseSaved(true); setTimeout(() => setBaseSaved(false), 2500);
  };

  const saveUpdated = async () => {
    if (updatedDraft.trim().length < 50) return;
    await store.set(KEYS.updatedResume, updatedDraft.trim());
    onUpdateUpdated(updatedDraft.trim());
    setUpdatedSaved(true); setTimeout(() => setUpdatedSaved(false), 2500);
  };

  const clearUpdated = async () => {
    await store.set(KEYS.updatedResume, "");
    onUpdateUpdated("");
    setUpdatedDraft("");
  };

  return (
    <div style={{ maxWidth: "740px", margin: "0 auto", padding: "48px 24px 0" }}>
      <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 16px" }}>Resume</p>
      <h1 style={{ fontFamily: T.display, fontSize: "clamp(26px,4vw,38px)", color: C.text, fontWeight: 800, letterSpacing: "-0.03em", margin: "0 0 8px" }}>Your Resumes</h1>
      <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 28px" }}>
        Keep your base resume for all new analyses. Paste your edited version to re-score saved jobs and see projected score improvements.
      </p>

      {/* Tab switcher */}
      <div style={{ display: "flex", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "4px", gap: "4px", marginBottom: "24px", width: "fit-content" }}>
        {[
          { key: "base", label: "Base Resume" },
          { key: "updated", label: "Updated Resume", badge: updatedResume?.trim() ? "✓" : null },
        ].map(({ key, label, badge }) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{ padding: "8px 20px", borderRadius: "7px", border: "none", background: activeTab === key ? C.surface2 : "transparent", color: activeTab === key ? C.text : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px" }}>
            {label}
            {badge && <span style={{ fontFamily: T.mono, fontSize: "9px", color: C.accent }}>{badge}</span>}
          </button>
        ))}
      </div>

      {activeTab === "updated" && (
        <div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "24px 28px", marginBottom: "18px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px", gap: "12px" }}>
              <div>
                <Label color={C.accent}>Updated Resume</Label>
                <p style={{ fontFamily: T.body, fontSize: "14px", color: C.textMid, margin: 0, lineHeight: 1.7 }}>
                  Paste your resume after making the suggested edits. Used only for re-scoring saved jobs in your Pipeline — doesn't affect new analyses.
                </p>
              </div>
              {updatedResume?.trim() && (
                <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "6px", background: "#0d1a10", border: `1px solid ${C.accent}33`, borderRadius: "6px", padding: "4px 10px" }}>
                  <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: C.accent }} />
                  <span style={{ fontFamily: T.mono, fontSize: "9px", color: C.accent, letterSpacing: "0.1em" }}>SAVED</span>
                </div>
              )}
            </div>
            <Field value={updatedDraft} onChange={setUpdatedDraft} placeholder="Paste your updated resume here — the version you've edited based on the suggestions..." multiline rows={18} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Btn onClick={saveUpdated} disabled={updatedDraft.trim().length < 50}>{updatedSaved ? "✓ Saved" : "Save Updated Resume"}</Btn>
            {updatedResume?.trim() && <Btn variant="ghost" small onClick={clearUpdated}>Clear</Btn>}
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>{updatedDraft.trim().length} chars</span>
          </div>
        </div>
      )}

      {activeTab === "base" && (
        <div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "24px 28px", marginBottom: "18px" }}>
            <Label>Base Resume</Label>
            <p style={{ fontFamily: T.body, fontSize: "14px", color: C.textMid, lineHeight: 1.8, margin: "0 0 18px" }}>
              This is the resume used for all new job analyses. Update it here when you make permanent changes to your resume.
            </p>
            <Field value={baseDraft} onChange={setBaseDraft} placeholder="Your base resume..." multiline rows={20} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <Btn onClick={saveBase} disabled={baseDraft.trim().length < 100}>{baseSaved ? "✓ Saved" : "Save Base Resume"}</Btn>
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: baseDraft.trim().length >= 100 ? C.accent : C.textDim }}>{baseDraft.trim().length} chars</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [ready, setReady]   = useState(false);
  const [resume, setResume] = useState(null);
  const [updatedResume, setUpdatedResume] = useState("");
  const [jobs, setJobs]     = useState([]);
  const [page, setPage]     = useState("analyzer");

  useEffect(() => {
    Promise.all([store.get(KEYS.resume), store.get(KEYS.jobs), store.get(KEYS.updatedResume)]).then(([r, j, u]) => {
      setResume(r || null);
      setJobs(j ? JSON.parse(j) : []);
      setUpdatedResume(u || "");
      setReady(true);
    });
  }, []);

  const persist       = (u) => { setJobs(u); store.set(KEYS.jobs, JSON.stringify(u)); };
  const handleSaveJob = (j) => persist([j, ...jobs]);
  const handleUpdate  = (u) => persist(jobs.map(j => j.id === u.id ? u : j));
  const handleDelete  = (id) => persist(jobs.filter(j => j.id !== id));
  const handleAdd     = (j) => persist([j, ...jobs]);
  const handleResume  = (r) => setResume(r);
  const handleUpdatedResume = (r) => setUpdatedResume(r);
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
    { key: "analyzer", label: "Analyze" },
    { key: "tracker",  label: `Pipeline${jobs.length > 0 ? ` (${jobs.length})` : ""}` },
    { key: "resumes",  label: "Resume", badge: updatedResume?.trim() ? "✓" : null },
    { key: "settings", label: "Settings" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: "80px" }}>
      <style>{GLOBAL_CSS}</style>

      <nav style={{ borderBottom: `1px solid ${C.border}`, padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: `${C.bg}f0`, backdropFilter: "blur(20px)", zIndex: 50, height: "56px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <svg width="24" height="24" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
            <rect width="48" height="48" rx="10" fill={C.bg} stroke={C.border2} strokeWidth="2"/>
            <circle cx="24" cy="13" r="4.5" fill={C.accent}/>
            <path d="M8 28 C13 22 19 36 24 30 C29 24 35 38 40 32" fill="none" stroke={C.accent} strokeWidth="3" strokeLinecap="round"/>
          </svg>
          <span style={{ fontFamily: T.display, fontSize: "18px", color: C.text, fontWeight: 800, letterSpacing: "-0.02em" }}>inflow</span>
        </div>

        <div style={{ display: "flex", gap: "3px" }}>
          {NAV.map(({ key, label, badge }) => (
            <button key={key} onClick={() => setPage(key)} style={{ padding: "7px 18px", borderRadius: "7px", background: page === key ? C.surface : "transparent", border: `1px solid ${page === key ? C.border2 : "transparent"}`, color: page === key ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", position: "relative", transition: "all 0.15s", display: "flex", alignItems: "center", gap: "5px" }}>
              {label}
              {badge && <span style={{ fontFamily: T.mono, fontSize: "9px", color: C.accent }}>{badge}</span>}
              {key === "tracker" && pending > 0 && (
                <span style={{ position: "absolute", top: "-4px", right: "-4px", width: "16px", height: "16px", borderRadius: "50%", background: C.yellow, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono, fontSize: "9px", color: "#000", fontWeight: 700 }}>{pending}</span>
              )}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: C.accent, boxShadow: `0 0 8px ${C.accent}` }} />
          <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.08em", textTransform: "uppercase" }}>Resume Active</span>
        </div>
      </nav>

      {page === "analyzer" && <AnalyzerPage resume={resume} onSaveJob={handleSaveJob} />}
      {page === "tracker"  && <TrackerPage  jobs={jobs} onUpdateJob={handleUpdate} onDeleteJob={handleDelete} onAddJob={handleAdd} updatedResume={updatedResume} />}
      {page === "resumes"  && <ResumePage baseResume={resume} updatedResume={updatedResume} onUpdateBase={handleResume} onUpdateUpdated={handleUpdatedResume} />}
      {page === "settings" && <SettingsPage resume={resume} onUpdateResume={handleResume} />}
      <UpdateToast />
    </div>
  );
}
