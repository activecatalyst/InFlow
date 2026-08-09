import { useState, useRef, useEffect, createContext, useContext } from "react";
import { useRegisterSW } from 'virtual:pwa-register/react';
import { auth, db } from "./firebase";
import { onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
import { makeJob, normalizeJob, migrateJobs, findJob, AC_JOBS_KEY } from "./acJobs";

// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
// "Signal on graphite" — surfaces are warm neutrals so the green reads as
// signal, not atmosphere. Accent is a custom mint-emerald (not a Tailwind stop).
// All text tiers pass WCAG AA on both bg and surface.
const C = {
  bg:        "#0C0C0B",
  surface:   "#141412",
  surface2:  "#1B1B18",
  border:    "#262622",
  border2:   "#35352F",
  accent:    "#33E68C",
  accentDim: "#33E68C22",
  accentGlow:"#33E68C44",
  text:      "#F5F4F0",
  // Body-text tiers, brightened for comfortable WCAG AA headroom on the dark
  // surfaces (same warm near-neutral hue). Ratios vs #0C0C0B bg / #1B1B18 card:
  // textMid 12.9/11.4, textSub 9.5/8.3, textDim 7.5/6.6 — all ≥4.5 with margin.
  textMid:   "#D2D2CB",
  textSub:   "#B4B5AB",
  textDim:   "#A0A196",
  green:     "#33E68C",
  mint:      "#7FEDB4",
  yellow:    "#F2D479",
  orange:    "#F0A468",
  red:       "#F27D74",
  blue:      "#85BDF2",
};

const T = {
  display: "'Space Grotesk', sans-serif",
  body:    "'Inter', sans-serif",
  // "mono" now points at the readable UI sans — used for labels, buttons, badges,
  // and chips. Keeping the token name avoids touching ~100 call sites.
  mono:    "'Inter', sans-serif",
  // True monospace, reserved for technical fields only (URLs, API keys).
  code:    "'IBM Plex Mono', monospace",
};

// Single source of truth for the Anthropic model. Claude Sonnet 5 is the
// current best-quality / lowest-cost option for this workload.
const MODEL = "claude-sonnet-5";

// ─── STORAGE ──────────────────────────────────────────────────────────────────
const KEYS = {
  resume:       "inflow_resume_v2",
  jobs:         AC_JOBS_KEY,        // shared suite job store (was "inflow_jobs_v2")
  apiKey:       "inflow_api_key",
  proxyUrl:     "inflow_proxy_url",
  updatedResume:"inflow_resume_updated",
  syncCode:     "inflow_sync_code",
  wordsMode:    "inflow_words_mode",
  reportView:   "inflow_report_view",  // "focused" | "full" — disclosure preference
  events:       "inflow_events_v1",    // local effort log — powers the "This week" strip
  jobDraft:     "inflow_job_draft_v1", // an unrun paste/URL, so a session can be resumed
  nudgesOn:     "inflow_nudges_on",    // opt-in for the reminder surface
  nudgesDismissed: "inflow_nudges_dismissed_v1", // per job+stage nudges the user waved off
  stretchDismissed: "inflow_stretch_dismissed_v1", // dismissed signature of the low-fit-pattern callout
  roleTargets:  "inflow_role_targets_v1", // cached 7+ role suggestions (keyed to a resume hash)
  jobBands:     "inflow_job_bands_v1",   // per-job fit-band overrides (reach/match/safe)
};
const store = {
  get: async (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  // Returns true on success, false on failure (e.g. QuotaExceededError).
  // Callers MUST check the result — a silent failure here means jobs vanish on reload.
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

// Turn a raw fetch/API failure into a plain-language, actionable diagnosis so no
// one ever sees a bare "Access-Control-Allow-Origin" string. A browser CORS block
// surfaces as a TypeError ("Failed to fetch") with no HTTP status; if we're
// calling Anthropic directly (no proxy) and the network is up, that's almost
// certainly CORS — the one thing the optional proxy fixes.
const classifyApiError = (err, hasProxy) => {
  const m = (err && err.message) || String(err || "");
  const looksNetwork = /failed to fetch|networkerror|load failed|fetch/i.test(m);
  // Only rule out CORS when the browser *explicitly* reports offline; an unknown
  // online status (navigator.onLine undefined) still points at a CORS block.
  const explicitlyOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (looksNetwork && !hasProxy && !explicitlyOffline) {
    return { kind: "cors", message: "Your browser blocked the direct connection to Anthropic. This is a known one-time hurdle — adding a free proxy in Setup fixes it for good." };
  }
  if (looksNetwork) return { kind: "network", message: "Couldn't reach the server — check your connection and try again." };
  if (/\b401\b|authentication|invalid x-api-key|unauthorized|permission/i.test(m)) {
    return { kind: "auth", message: "Anthropic didn't accept the API key. Open Setup to re-check it." };
  }
  return { kind: "other", message: m || "Something went wrong." };
};

// ─── CLOUD SYNC (Firebase) ────────────────────────────────────────────────────
// localStorage stays the source of truth for instant load / offline use. On
// top of that, we mirror {resume, jobs, updatedResume} to a Firestore doc
// keyed by a random human-typeable "sync code" instead of a Google account —
// no OAuth redirect, no cross-domain bounce, so it can't hit the browser
// storage-partitioning issues that broke Google sign-in across domains.
// Auth is just anonymous (instant, same-origin) so Firestore rules can still
// require request.auth != null; the code itself is the real shared secret.
// Conflicts are last-write-wins via `updatedAt` — fine for a personal tool
// used on a handful of devices, not built for concurrent multi-user editing.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L — easy to type from memory
const genSyncCode = () => {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
};
const normalizeCode = (raw) => (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const formatCode = (code) => code ? `${code.slice(0, 4)}-${code.slice(4)}` : "";

const cloud = {
  docRef: (code) => doc(db, "syncCodes", code),
  push: async (code, data) => {
    try {
      await setDoc(cloud.docRef(code), { ...data, updatedAt: Date.now() }, { merge: true });
      return true;
    } catch (e) {
      console.error("cloud sync push failed", e);
      return false;
    }
  },
  pullOnce: async (code) => {
    try {
      const snap = await getDoc(cloud.docRef(code));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      console.error("cloud sync pull failed", e);
      return null;
    }
  },
  // Real-time listener — picks up changes made on another linked device
  // without needing a manual refresh.
  subscribe: (code, cb) => onSnapshot(cloud.docRef(code), (snap) => {
    if (snap.exists()) cb(snap.data());
  }, (e) => console.error("cloud sync listener failed", e)),
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const STATUSES = [
  { key: "saved",     label: "Saved",        short: "SAVED",     color: C.blue,   bg: "#0E141C", dateKey: "dateSaved"     },
  { key: "applied",   label: "Applied",      short: "APPLIED",   color: C.accent, bg: "#0E1A13", dateKey: "dateApplied"   },
  { key: "screen",    label: "Phone Screen", short: "SCREEN",    color: C.yellow, bg: "#1C1808", dateKey: "dateScreen"    },
  { key: "interview", label: "Interview",    short: "INTERVIEW", color: C.orange, bg: "#1C1309", dateKey: "dateInterview" },
  { key: "offer",     label: "Offer",        short: "OFFER",     color: C.mint,   bg: "#0D1D14", dateKey: "dateOffer"     },
  { key: "rejected",  label: "Rejected",     short: "REJECTED",  color: C.red,    bg: "#1D100E", dateKey: "dateRejected"  },
];
const SM = Object.fromEntries(STATUSES.map(s => [s.key, s]));

const TIERS = [
  { key: "top",     label: "Strong Apply",         color: C.accent,  bg: "#0E1A13", aliases: ["Top-priority application"] },
  { key: "strong",  label: "Apply",                color: C.mint,    bg: "#0D1D14", aliases: ["Strong apply"] },
  { key: "tailor",  label: "Apply with Tailoring", color: C.yellow,  bg: "#1C1808", aliases: ["Apply with light tailoring"] },
  { key: "stretch", label: "Stretch Role",         color: C.orange,  bg: "#1C1309", aliases: ["Realistic stretch"] },
  { key: "low",     label: "Low Probability",      color: C.red,     bg: "#1D100E", aliases: ["Low-priority stretch"] },
  { key: "skip",    label: "Do Not Apply",         color: "#6b7280", bg: "#161614", aliases: ["Not recommended"] },
];
// Resolve a tier by its current label or any legacy alias (keeps old saved jobs working).
const findTier = (label) => label ? TIERS.find(t => t.label === label || t.aliases?.includes(label)) : null;

const PHASES = [
  "Fetching job posting...",
  "Identifying what the HM is optimizing for...",
  "Comparing resume against competencies...",
  "Separating strengths from gaps...",
  "Predicting recruiter reaction...",
  "Predicting hiring manager reaction...",
  "Rewriting resume improvements...",
  "Assessing interview risk...",
  "Writing honest verdict...",
];

// ─── UTILS ────────────────────────────────────────────────────────────────────
const uid     = () => Math.random().toString(36).slice(2, 10);
const now     = () => new Date().toISOString();
const isUrl   = (s) => /^https?:\/\/.+/.test(s?.trim());
const fmtDate = (iso) => {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const fmtShort = (iso) => {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const parseScores = (text) => {
  // "Recruiter Confidence" is the current wording; "Recruiter Score" kept as a fallback.
  const r = text.match(/recruiter (?:confidence|score)[:\s*_]*(\d+(?:\.\d+)?)/i);
  const h = text.match(/hiring manager (?:score|confidence)[:\s*_]*(\d+(?:\.\d+)?)/i);
  const t = text.match(/transferability[:\s*_]*(\d+(?:\.\d+)?)/i);
  return {
    recruiter: r ? parseFloat(r[1]) : null,
    hm: h ? parseFloat(h[1]) : null,
    transferability: t ? parseFloat(t[1]) : null,
  };
};

// Achievable ("ceiling") scores after the suggested edits — the realistic score
// the resume can reach once the STEP 5 improvements are made. Provided by STEP 1.
// Distinct labels ("Ceiling") so they never collide with the current-score regex.
const parseCeiling = (text) => {
  const r = text.match(/recruiter ceiling[:\s*_]*(\d+(?:\.\d+)?)/i);
  const h = text.match(/hiring manager ceiling[:\s*_]*(\d+(?:\.\d+)?)/i);
  return {
    recruiter: r ? parseFloat(r[1]) : null,
    hm:        h ? parseFloat(h[1]) : null,
  };
};

// Resolve the ceiling to display next to a current score. Priority: an actual
// re-score of an edited resume, else the analysis's achievable estimate. Always
// clamped to at least the current score so the UI never renders a deficit.
const resolveCeiling = (current, updated, achievable) => {
  const target = updated != null ? updated : achievable;
  if (target == null || current == null) return null;
  return Math.max(target, current);
};

// Compact number formatting: integers stay clean, fractions show one decimal.
const fmtScore = (n) => (n == null ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(1));

// Plain-language "coach summary" — the 1–2 sentence gist the anxious reader sees
// before any scores. Provided by the analysis on a "COACH SUMMARY:" line.
const parseCoachSummary = (text) => {
  const m = text.match(/^\s*(?:[-*]\s*)?(?:\*\*)?COACH SUMMARY(?:\*\*)?:\s*(.+)$/im);
  return m ? m[1].replace(/\*\*/g, "").trim() : null;
};

// Full scorecard — every "SCORE: <Dimension> | <X>/10 | <reason>" line from STEP 1B.
const parseScorecard = (text) => {
  const m = text.match(/## STEP 1B[^\n]*\n([\s\S]*?)(?=\n## STEP 2|$)/i);
  const block = m ? m[1] : text;
  return [...block.matchAll(/^\s*(?:[-*]\s*)?SCORE:\s*(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*\/\s*10\s*\|\s*(.+?)\s*$/gim)]
    .map(x => ({ name: x[1].replace(/[*_]/g, "").trim(), score: parseFloat(x[2]), reason: x[3].trim() }));
};

// Deterministic title/company extraction from the STEP 0 metadata block the
// prompt now requires. Strips markdown bold/brackets the model sometimes adds.
const parseJobMeta = (text) => {
  const grab = (label) => {
    const m = text.match(new RegExp(`^\\s*\\*{0,2}${label}\\*{0,2}[:\\s]+(.+)$`, "mi"));
    return m ? m[1].replace(/[*_\[\]]/g, "").trim() : null;
  };
  const clean = (v, max) => {
    if (!v) return null;
    const s = v.slice(0, max).trim();
    return /^(unknown|n\/a|not (listed|stated|specified))$/i.test(s) ? null : s;
  };
  return {
    title:          clean(grab("JOB_TITLE"), 80),
    company:        clean(grab("COMPANY"), 60),
    location:       clean(grab("LOCATION"), 60),
    workModel:      clean(grab("WORK_MODEL"), 20),
    employmentType: clean(grab("EMPLOYMENT_TYPE"), 24),
    seniority:      clean(grab("SENIORITY"), 24),
    salary:         clean(grab("SALARY_RANGE"), 40),
    team:           clean(grab("TEAM"), 60),
    keyRequirements: clean(grab("KEY_REQUIREMENTS"), 240),
  };
};

// Interpretable score bands. Every x/10 maps to a plain-language label and a
// color. The color scale is neutral-to-warm → green: a low score reads as
// "early on the path" (warm orange), never alarm-red / failure.
const scoreBand = (s) => {
  if (s === null || s === undefined) return null;
  const n = Math.round(s);
  if (n <= 3) return { key: "early",  label: "not a fit yet",             color: C.orange };
  if (n <= 6) return { key: "edits",  label: "worth applying with edits", color: C.yellow };
  if (n <= 8) return { key: "strong", label: "strong — apply",            color: C.accent };
  return              { key: "top",    label: "top candidate",             color: C.mint };
};
const scoreColor = (s) => scoreBand(s)?.color || C.textDim;
const scoreLabel = (s) => scoreBand(s)?.label || "";

// ─── "WORDS, NOT NUMBERS" MODE ────────────────────────────────────────────────
// Global preference: when on, score displays show the band label instead of the
// raw digit, for readers who fixate on the number. Persisted in localStorage;
// provided via context so any score component can honor it without prop drilling.
const WordsCtx = createContext(false);
const useWordsMode = () => useContext(WordsCtx);

// Effort-event log, exposed reactively so the "This week" strip updates the
// moment a win is recorded anywhere in the app.
const EventsCtx = createContext({ events: [], logEvent: () => {} });
const useEvents = () => useContext(EventsCtx);

const parseTier = (text) => {
  // Check current labels first, then legacy aliases, longest-first to avoid
  // matching "Apply" inside "Apply with Tailoring".
  const candidates = TIERS.flatMap(t => [t.label, ...(t.aliases || [])]).sort((a, b) => b.length - a.length);
  for (const l of candidates) {
    if (text.includes(l)) return findTier(l);
  }
  return null;
};

const tierFromScores = (recruiter, hm) => {
  const avg = ((recruiter || 0) + (hm || 0)) / (recruiter && hm ? 2 : 1);
  if (avg >= 8.5) return TIERS[0];
  if (avg >= 7.5) return TIERS[1];
  if (avg >= 6.5) return TIERS[2];
  if (avg >= 5.5) return TIERS[3];
  if (avg >= 4.5) return TIERS[4];
  return TIERS[5];
};

const parseHiringDecision = (text) => {
  const m = text.match(/## STEP 2[^\n]*\n([\s\S]*?)(?=\n## STEP 3|$)/i);
  if (!m) return null;
  const block = m[1].trim();
  const verdictMatch = block.match(/Would I interview[^\n]*\n?\s*(Yes|No|Conditional)/i)
    || block.match(/^(Yes|No|Conditional)/im);
  const verdict     = verdictMatch?.[1] || null;
  const concern     = block.match(/Biggest concern:\s*(.+?)(?:\n|$)/i)?.[1]?.trim() || null;
  const selling     = block.match(/Strongest selling point:\s*(.+?)(?:\n|$)/i)?.[1]?.trim() || null;
  const smallest    = block.match(/Smallest truthful change[^:]*:\s*(.+?)(?:\n|$)/i)?.[1]?.trim() || null;
  const doNotChange = block.match(/What should NOT be changed:\s*(.+?)(?:\n|$)/i)?.[1]?.trim() || null;
  const reasoning   = block
    .replace(/Would I interview[^\n]*/i, "")
    .replace(/^(Yes|No|Conditional)[^\n]*/im, "")
    .replace(/Biggest concern:[^\n]*/i, "")
    .replace(/Strongest selling point:[^\n]*/i, "")
    .replace(/Smallest truthful change[^\n]*/i, "")
    .replace(/What should NOT be changed:[^\n]*/i, "")
    .trim()
    .split("\n").filter(l => l.trim()).slice(0, 3).join(" ");
  return { verdict, reasoning, concern, selling, smallest, doNotChange };
};

const parseStrengths = (text) => {
  const m = text.match(/## STEP 3[^\n]*\n([\s\S]*?)(?=\n## STEP 4|$)/i);
  if (!m) return { strengths: [], transferable: [] };
  const block = m[1];

  // Parse strengths
  const strengths = [];
  const strEntries = block.split(/STRENGTH \d+:/gi).slice(1);
  for (const entry of strEntries) {
    const name = entry.trim().split("\n")[0].trim();
    const recruiter = entry.match(/RECRUITER READS:\s*([\s\S]*?)(?=HM READS:|STRENGTH \d|TRANSFERABLE|$)/i)?.[1]?.trim();
    const hm = entry.match(/HM READS:\s*([\s\S]*?)(?=STRENGTH \d|TRANSFERABLE|$)/i)?.[1]?.trim();
    if (name) strengths.push({ name, recruiter, hm });
  }

  // Parse transferable experience
  const transferable = [];
  const xferEntries = block.split(/TRANSFERABLE \d+:/gi).slice(1);
  for (const entry of xferEntries) {
    const name = entry.trim().split("\n")[0].trim();
    const how = entry.match(/HOW IT TRANSFERS:\s*([\s\S]*?)(?=TRANSFERABLE \d|TECHNICAL STRENGTHS|LEADERSHIP STRENGTHS|$)/i)?.[1]?.trim();
    if (name) transferable.push({ name, how });
  }

  // Technical / leadership strengths — short comma-separated lists.
  const grabList = (label) => {
    const line = block.match(new RegExp(`${label}:\\s*(.+)`, "i"))?.[1]?.trim();
    if (!line || /^(none|n\/a)\b/i.test(line)) return [];
    return line.split(/[,;]/).map(s => s.replace(/[*_\[\]]/g, "").trim()).filter(Boolean).slice(0, 8);
  };
  const technical  = grabList("TECHNICAL STRENGTHS");
  const leadership = grabList("LEADERSHIP STRENGTHS");

  return { strengths, transferable, technical, leadership };
};

const parseRisks = (text) => {
  const m = text.match(/## STEP 4[^\n]*\n([\s\S]*?)(?=\n## STEP 5|$)/i);
  if (!m) return [];
  const block = m[1];
  const risks = [];
  const entries = block.split(/RISK \d+:/gi).slice(1);
  for (const entry of entries) {
    const name = entry.trim().split("\n")[0].trim();
    const why        = entry.match(/WHY IT MATTERS:\s*([\s\S]*?)(?=LIKELIHOOD:|HIRING IMPACT:|TEACHABILITY:|RISK \d|$)/i)?.[1]?.trim();
    const likelihood = entry.match(/LIKELIHOOD:\s*(Low|Medium|High)/i)?.[1]
                    || entry.match(/HIRING IMPACT:\s*(Low|Medium|High)/i)?.[1]; // fallback
    const teachability = entry.match(/TEACHABILITY:\s*(Already Demonstrated|Transferable|Learnable|Critical Gap)/i)?.[1];
    const mitigation = entry.match(/MITIGATION:\s*([\s\S]*?)(?=EFFORT:|RISK \d|$)/i)?.[1]?.trim();
    const effort = entry.match(/EFFORT:\s*([^\n]+)/i)?.[1] ? normalizeEffort(entry.match(/EFFORT:\s*([^\n]+)/i)[1]) : null;
    if (name) risks.push({ name, why, likelihood, teachability, mitigation, effort });
  }
  return risks;
};

const parseImprovements = (text) => {
  const m = text.match(/## STEP 5[^\n]*\n([\s\S]*?)(?=\n## STEP 6|$)/i);
  if (!m) return [];
  const block = m[1];
  return [...block.matchAll(/IMPROVEMENT \d+:([\s\S]*?)(?=IMPROVEMENT \d+:|## STEP 6|$)/g)]
    .map(match => {
      const b = match[1];
      const current  = b.match(/CURRENT:\s*([\s\S]*?)(?=PROBLEM:|ISSUE:|$)/i)?.[1]?.trim();
      const problem  = b.match(/PROBLEM:\s*([\s\S]*?)(?=IMPROVED:|$)/i)?.[1]?.trim()
                    || b.match(/ISSUE:\s*([\s\S]*?)(?=IMPROVED:|$)/i)?.[1]?.trim(); // fallback
      const improved = b.match(/IMPROVED:\s*([\s\S]*?)(?=WHY IT WORKS:|$)/i)?.[1]?.trim();
      const why      = b.match(/WHY IT WORKS:\s*([\s\S]*?)(?=ESTIMATED LIFT:|EFFORT:|IMPROVEMENT \d+:|$)/i)?.[1]?.trim().split("---")[0].trim();
      const lift     = b.match(/ESTIMATED LIFT:\s*(\+?\s*\d+\s*%[^\n]*)/i)?.[1]?.trim();
      const effort   = normalizeEffort(b.match(/EFFORT:\s*([^\n]+)/i)?.[1]);
      return current ? { current, problem, improved, why, lift, effort } : null;
    }).filter(Boolean);
};

// Normalize an effort estimate to a compact "~N min" tag. Defaults to "~10 min"
// when the analysis didn't provide one.
const normalizeEffort = (raw) => {
  if (!raw) return "~10 min";
  const m = String(raw).match(/(\d+)\s*(?:–|-|to)?\s*(\d+)?\s*min/i);
  if (!m) return "~10 min";
  const n = m[2] || m[1]; // if a range, take the upper bound (honest, not rosy)
  return `~${n} min`;
};

// ─── EDIT CHECKLIST PERSISTENCE ───────────────────────────────────────────────
// Which resume edits the user has checked off, stored per job so progress and the
// dopamine of a completed item survive reloads and re-visits. Keyed by a hash of
// the edit text (not index) so it stays attached to the right item.
const EDITS_DONE_KEY = "inflow_edits_done_v1";
const editKey = (imp) => {
  const s = ((imp?.improved || imp?.current || imp?.issue || imp?.problem || "").slice(0, 140));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return "e" + h.toString(36);
};
const loadEditsDone = (jobId) => {
  if (!jobId) return {};
  try { return (JSON.parse(localStorage.getItem(EDITS_DONE_KEY) || "{}")[jobId]) || {}; }
  catch { return {}; }
};
const saveEditsDone = (jobId, map) => {
  if (!jobId) return;
  try {
    const all = JSON.parse(localStorage.getItem(EDITS_DONE_KEY) || "{}");
    all[jobId] = map;
    localStorage.setItem(EDITS_DONE_KEY, JSON.stringify(all));
  } catch { /* quota / disabled storage — checklist just won't persist */ }
};
const EDIT_AFFIRMATIONS = ["nice — that's one", "that's one done", "momentum.", "one step closer", "keep rolling"];

// ─── EFFORT EVENT LOG ─────────────────────────────────────────────────────────
// A local, append-only record of the wins the user actually controls — jobs
// analyzed, resumes tailored, scores improved, applications advanced a stage.
// Powers the calm "This week" strip. Purely on-device (never synced) and capped
// so it can't bloat localStorage.
const EVENTS_CAP = 500;
const EVENT_TYPES = ["analyzed", "tailored", "improved", "advanced"];
const loadEvents = () => {
  try { const a = JSON.parse(localStorage.getItem(KEYS.events) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
};
const appendEvent = (type, meta = {}) => {
  try {
    const a = loadEvents();
    a.push({ type, ts: Date.now(), ...meta });
    localStorage.setItem(KEYS.events, JSON.stringify(a.slice(-EVENTS_CAP)));
  } catch { /* quota / disabled storage — the strip just won't count it */ }
};
// Monday 00:00 of the current local week.
const startOfWeek = (ref = new Date()) => {
  const x = new Date(ref); x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  x.setDate(x.getDate() - dow);
  return x.getTime();
};
const weekEventCounts = (events, since = startOfWeek()) => {
  const c = { analyzed: 0, tailored: 0, improved: 0, advanced: 0 };
  for (const e of events || []) if (e && e.ts >= since && c[e.type] != null) c[e.type]++;
  return c;
};

// Stage rank for detecting *forward* pipeline movement. Rejected sits outside the
// ladder (rank -1) so moving into or out of it never reads as an "advance".
const stageRank = (key) => key === "rejected" ? -1 : STATUSES.findIndex(s => s.key === key);
const isAdvance = (fromKey, toKey) => {
  const f = stageRank(fromKey), t = stageRank(toKey);
  return f >= 0 && t >= 0 && t > f;
};
const MOMENTUM_MSG = {
  applied:   "applied — that's the hard part done",
  screen:    "a phone screen — nice, that's momentum",
  interview: "an interview — you earned this",
  offer:     "an offer — huge. take a moment.",
};

// ─── EXECUTIVE-FUNCTION NUDGES ────────────────────────────────────────────────
// Turn each pipeline card into an active prompt instead of a passive record:
// a gentle, stage- and age-aware "next step" the user can act on or wave off.
// All local; all opt-in for the aggregated reminder surface.
const daysSince = (iso) => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d < 0 ? 0 : d;
};
const agoPhrase = (n) => n == null ? "recently" : n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;

// The suggested next action for a card, or null when there's nothing worth
// nudging (e.g. a rejected job). `tone` drives styling + whether it's "actionable".
const cardNudge = (job) => {
  const st = job.status;
  const stamp = job[SM[st]?.dateKey] || job.dateAdded;
  const n = daysSince(stamp);
  const ago = agoPhrase(n);
  const key = `${job.id}:${st}`;
  switch (st) {
    case "saved":
      return { key, tone: "act",
        text: n >= 1 ? `Saved ${ago} — want to take ~15 minutes to apply?` : `Saved ${ago} — apply while it's fresh? About 15 minutes.` };
    case "applied":
      return n != null && n < 5
        ? { key, tone: "wait", text: `Applied ${ago} — you're in the queue. Nothing to do yet.` }
        : { key, tone: "act",  text: `Applied ${ago} — a short, friendly follow-up could move it forward.` };
    case "screen":
      return { key, tone: "act", text: `Phone screen ${ago} — send a thank-you and jot down what you learned.` };
    case "interview":
      return { key, tone: "act", text: `Interview ${ago} — a thank-you note and a gentle check-in are fair game.` };
    case "offer":
      return { key, tone: "celebrate", text: `You've got an offer here. Take a breath — decide when you're ready.` };
    default:
      return null; // rejected — never nag
  }
};
// How much a job would benefit from attention right now (higher = more). Applying
// to a saved job is the highest-leverage move, so saved outranks everything else.
const nudgeUrgency = (job) => {
  const st = job.status;
  const n = daysSince(job[SM[st]?.dateKey] || job.dateAdded) ?? 0;
  if (st === "saved")     return 100 + n;
  if (st === "applied")   return n >= 5 ? 60 + n : 0;
  if (st === "interview") return 55 + n;
  if (st === "screen")    return 50 + n;
  return 0;
};
const loadDismissedNudges = () => {
  try { const a = JSON.parse(localStorage.getItem(KEYS.nudgesDismissed) || "[]"); return new Set(Array.isArray(a) ? a : []); }
  catch { return new Set(); }
};
const saveDismissedNudges = (set) => {
  try { localStorage.setItem(KEYS.nudgesDismissed, JSON.stringify([...set])); } catch {}
};

// ─── CROSS-ANALYSIS PATTERN AWARENESS ─────────────────────────────────────────
// Look across the last few analyses the user actually ran (all local) and notice
// when they're consistently checking roles a band above their current match.
// This is a STRATEGY signal, never a personal verdict — the callout it feeds is
// coaching, not a warning. Detection is fully on-device.
const analyzedTime = (j) => new Date(j.dateAdded || j.savedAt || j.dateSaved || 0).getTime();
const bestScore = (j) => Math.max(j.recruiterScore ?? -1, j.hmScore ?? -1);
const detectStretchPattern = (jobs) => {
  // Consider the most recent analyses that carry a score or a decision.
  const recent = (jobs || [])
    .filter(j => j.recruiterScore != null || j.hmScore != null || j.hiringVerdict)
    .sort((a, b) => analyzedTime(b) - analyzedTime(a))
    .slice(0, 5);
  if (recent.length < 3) return null;

  const hasScore = (j) => j.recruiterScore != null || j.hmScore != null;
  // Trigger (a): every recent analysis is a genuine stretch on the numbers
  // (its BEST of recruiter/HM ≤ 6, so it isn't a strong match on either axis).
  const allScoreLow = recent.every(hasScore) && recent.every(j => bestScore(j) <= 6);
  // Trigger (b): every recent decision came back No / Conditional.
  const allDecLow = recent.every(j => j.hiringVerdict === "No" || j.hiringVerdict === "Conditional");
  if (!allScoreLow && !allDecLow) return null;

  const scored = recent.filter(hasScore);
  const avg = scored.length ? scored.reduce((s, j) => s + bestScore(j), 0) / scored.length : null;

  // The single strongest reframe to offer — the top-ranked edit from the most
  // recent analysis that has parseable improvements.
  let topImprovement = null, topJob = null;
  for (const j of recent) {
    if (!j.analysis) continue;
    const imps = parseImprovements(j.analysis);
    if (imps.length) { topImprovement = imps[0]; topJob = j; break; }
  }

  return {
    count: recent.length,
    avg: avg != null ? Math.round(avg * 10) / 10 : null,
    kind: allScoreLow ? "score" : "decision",
    topImprovement,
    topJob,
    // Signature ties the dismissal to *this* run of evidence: a newer low-fit
    // analysis changes the latest id, so the callout returns only if the pattern
    // genuinely persists — never nags about the same set the user already saw.
    signature: `${recent[0].id}:${recent.length}`,
  };
};

// ─── FIT BANDS ────────────────────────────────────────────────────────────────
// Read the landscape, not just the reach. Every score maps to a band so the user
// can aim: a Match is a realistic interview, a Reach is the upside play. The goal
// is a healthy MIX — matches build momentum, reaches are the swing.
const FIT_BANDS = {
  reach: { key: "reach", label: "Reach", color: C.orange, blurb: "a stretch — the upside play" },
  match: { key: "match", label: "Match", color: C.accent, blurb: "a realistic interview" },
  safe:  { key: "safe",  label: "Safe",  color: C.mint,   blurb: "a strong, high-odds fit" },
};
const BAND_ORDER = ["reach", "match", "safe"];
const bandFromScore = (s) => s == null ? null : s <= 6 ? "reach" : s <= 8 ? "match" : "safe";
const jobBestScore = (j) => {
  const v = Math.max(j.recruiterScore ?? -Infinity, j.hmScore ?? -Infinity);
  return isFinite(v) ? v : null;
};
// Band overrides live in their own local map so tagging never touches the shared
// job schema (which normalizeJob would strip). Auto-derived from score otherwise.
const loadBandOverrides = () => {
  try { const o = JSON.parse(localStorage.getItem(KEYS.jobBands) || "{}"); return o && typeof o === "object" ? o : {}; }
  catch { return {}; }
};
const saveBandOverrides = (map) => {
  try { localStorage.setItem(KEYS.jobBands, JSON.stringify(map)); } catch {}
};
const jobBand = (job, overrides) => (overrides && overrides[job.id]) || bandFromScore(jobBestScore(job));

// Stable short hash of the résumé, so cached role suggestions invalidate when the
// résumé actually changes.
const hashStr = (s) => { let h = 5381; const str = s || ""; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); };

// Fallback: parse old EDIT format
const parseEdits = (text) => {
  return [...text.matchAll(/EDIT \d+:([\s\S]*?)(?=EDIT \d+:|## STEP 7|## STEP 6|$)/g)]
    .map(m => {
      const b = m[1];
      const orig = b.match(/ORIGINAL:\s*([\s\S]*?)(?=SUGGESTED:|$)/i)?.[1]?.trim();
      const sugg = b.match(/SUGGESTED:\s*([\s\S]*?)(?=WHY:|$)/i)?.[1]?.trim();
      const why  = b.match(/WHY:\s*([\s\S]*?)(?=EDIT \d+:|$)/i)?.[1]?.trim();
      return orig && sugg ? { current: orig, improved: sugg, why, issue: "", effort: "~10 min" } : null;
    }).filter(Boolean);
};

const parseInterviewRisk = (text) => {
  const m = text.match(/## STEP 6[^\n]*\n([\s\S]*?)(?=\n## STEP 7|$)/i);
  if (!m) return [];
  const block = m[1];
  return block.split(/QUESTION \d+:/gi).slice(1).map(entry => {
    const question = entry.trim().split("\n")[0].trim();
    const coaching = entry.match(/COACHING:\s*([\s\S]*?)(?=QUESTION \d+:|$)/i)?.[1]?.trim();
    return question ? { question, coaching } : null;
  }).filter(Boolean);
};

const parseVerdict = (text) => {
  // Only STEP 7 is the Honest Verdict. Do NOT fall back to STEP 8
  // (Decision Confidence) — rendering that section here would be wrong content.
  const m = text.match(/## STEP 7[^\n]*\n([\s\S]*?)(?=\n## |$)/i);
  if (!m) return null;
  const raw = m[1].trim();
  const bottomLine = raw.match(/Bottom line:\s*(.+?)(?:\n|$)/i)?.[1]?.trim() || null;
  const body = raw.replace(/Bottom line:.*$/im, "").trim();
  return { body, bottomLine };
};

const parseOdds = (text) => {
  const prob = text.match(/Interview Probability[:\s]+(\d+)%?/i)?.[1];
  const ats  = text.match(/ATS Alignment[^%\n]*?(\d+)%/i)?.[1];
  return prob || ats ? { probability: prob ? parseInt(prob) : null, ats: ats ? parseInt(ats) : null } : null;
};


const parseDecisionConfidence = (text) => {
  const m = text.match(/## STEP 8[^\n]*\n([\s\S]*?)(?=\n## |$)/i);
  if (!m) return null;
  const block = m[1].trim();
  // Accept "Moderate" as an alias for "Medium" so either wording parses.
  const raw    = block.match(/Decision Confidence:\s*(High|Medium|Moderate|Low)/i)?.[1] || null;
  const level  = raw ? (/^mod/i.test(raw) ? "Medium" : raw[0].toUpperCase() + raw.slice(1).toLowerCase()) : null;
  const reason = block.match(/Reason:\s*([\s\S]*?)(?=\n## |$)/i)?.[1]?.trim() || null;
  return level ? { level, reason } : null;
};

const stampDate = (job, newStatus) => {
  const st = SM[newStatus];
  if (!st || job[st.dateKey]) return {};
  return { [st.dateKey]: now() };
};

// ─── ANALYSIS PROMPT ──────────────────────────────────────────────────────────
// Evaluation lenses — real hiring perspectives, replacing the old tone modes.
// Keyed default is "recruiter".
const TONE_CONFIG = {
  recruiter: {
    label: "Recruiter",
    icon: "◎",
    desc: "Balanced, practical, interview-focused.",
    persona: "You are an experienced Fortune 500 corporate recruiter with 15+ years screening candidates for operations, program management, supply chain, sourcing, analytics, and business-operations roles at companies like Apple, Amazon, Microsoft, Nike, and Medtronic. You think in transferable competencies, not exact title or keyword matches — you routinely advance strong candidates who are only 60–70% keyword matches. You are leaving practical, balanced, interview-focused notes for a colleague.",
    verdictStyle: "Give a balanced, practical read on whether you'd schedule a recruiter phone screen, and the single highest-ROI change that would move them up.",
  },
  senior: {
    label: "Senior Recruiter",
    icon: "◈",
    desc: "Higher standards, scrutinizes evidence.",
    persona: "You are a senior Fortune 500 recruiting lead with 20+ years of experience. You hold a higher bar than a line recruiter: you scrutinize whether each claimed competency is genuinely supported by work history and interview-defensible, and you weigh transferable evidence carefully rather than taking keywords at face value. You are leaving notes for the hiring team.",
    verdictStyle: "Apply higher standards. Be explicit about which strengths are proven versus merely asserted, and whether the evidence holds up under scrutiny.",
  },
  hm: {
    label: "Hiring Manager",
    icon: "◆",
    desc: "Can this person perform the role?",
    persona: "You are the hiring manager who owns this role and its outcomes. You care less about whether the resume screens well and more about whether this person can actually perform after onboarding — depth of relevant competency, operational maturity, and role-specific readiness. You are assessing fit for YOUR team.",
    verdictStyle: "Judge whether this person could perform the role after a normal ramp, and exactly what you'd need to probe in an interview to be confident.",
  },
  exec: {
    label: "Executive Panel",
    icon: "★",
    desc: "Very selective, leadership-oriented.",
    persona: "You are a selective executive interview panel evaluating for a senior or leadership-track role. You weigh leadership signals, business impact, judgment, and scope of ownership heavily, and you are comfortable passing on candidates who are merely competent. You are leaving notes for other executives.",
    verdictStyle: "Be very selective. Focus on leadership signals, scope, and business impact; state plainly whether this candidate clears a senior bar.",
  },
};

const ANALYSIS_PROMPT = (resume, tone = "recruiter") => {
  const cfg = TONE_CONFIG[tone] || TONE_CONFIG.recruiter;
  return `${cfg.persona}

MISSION — READ FIRST. You are simulating an internal hiring discussion to HELP a candidate act, not to make them quit. Be honest and specific — never inflate — but a discouraged candidate who closes the tab has been failed even by accurate feedback. Every response must leave a clear, doable path forward.

CANDIDATE-FACING TONE RULES (these override any conflicting stylistic guidance below):
1. Direct and specific, never harsh. NEVER use absolute deficit language. Do not write "zero experience", "no experience", "lacks", "missing", "weak", "unqualified", "not qualified", or "gap" in candidate-facing prose. Instead, describe what the resume does not YET show and how to surface it — e.g. "This resume doesn't yet show X — here's how to bring it out if you've done it." Frame every shortfall as a lever, not a verdict.
2. NEVER present a low score, a "No" decision, or any shortfall without an attached, concrete next action the candidate can take today. If you name a problem, you name the move in the same breath.
3. Keep every recommended change small and specific enough to start in one sitting. Prefer "rewrite your summary line to say X" over "gain more experience in Y". No recommendation may require new work history the candidate doesn't already have — only better surfacing of what's real.

Write like a recruiter leaving notes for another recruiter — direct, evidence-based, concise, practical. Do NOT write like a career coach, a motivational speaker, or a generic AI assistant. Every claim must be supported by the resume, the job posting, or established hiring practices. Avoid keyword stuffing, repetitive buzzwords, unsupported claims, and generic resume advice — recruiter readability always takes precedence over ATS optimization.

Every recommendation must pass all four tests before including it:
1. Truthful — directly supported by the candidate's actual experience.
2. Recruiter-relevant — improves the first 10–15 second scan.
3. Interview-defensible — the candidate can confidently explain it.
4. High-impact — meaningfully improves interview odds.
If a recommendation fails any of these tests, do not make it.

Evaluate like a recruiter, not an ATS. Keyword similarity is only ONE input. Weigh demonstrated competency, transferable experience, operational maturity, interview defensibility, business impact, and leadership signals more heavily than literal keyword overlap.

Recognize transferable competency clusters — credit equivalent evidence even when the exact term is absent:
- Program / Project Management: project coordination, milestones, timelines, dependencies, risk tracking, status reporting, stakeholder communication, prioritization.
- Supply Chain / Sourcing: planning, procurement, SAP/ERP, inventory, BOM, logistics, manufacturing, materials, supplier communication, finance partnership.
- Business Operations: reporting, dashboards, Power BI, Excel, KPIs, workflow optimization, documentation, analytics.
- Product Operations: cross-functional coordination, operational planning, process improvement, execution, product-lifecycle support.
- Engineering Operations: BOM, ECR/ECO, configuration management, PLM, manufacturing engineering, change management.
For example, treat SAP ERP + BOM + ECR/ECO + manufacturing + planning + supplier communication as strong evidence of Strategic Sourcing even if "RFx" never appears. Never require exact wording.

Classify every missing requirement as one of: Already Demonstrated, Transferable, Learnable, or Critical Gap (e.g. Power BI → Already Demonstrated; RFx → Transferable; Negotiation → Learnable; CPA License or Security Clearance → Critical Gap). Only true deal-breakers are Critical Gaps.

Before scoring, run this recruiter thinking model internally: (1) What story does the resume tell in the first 15 seconds? (2) Would I schedule a recruiter phone screen? (3) What strengths stand out? (4) Which missing requirements are teachable? (5) Which are true deal-breakers? (6) Would this candidate likely succeed after onboarding? (7) Does the resume feel authentic?

Explain every score with a specific, evidence-based reason. Reward measurable business impact (what changed because of the candidate) and penalize keyword stuffing or resumes that merely repeat the job description.

Scoring calibration: Scores reflect competitiveness against the expected applicant pool — not minimum qualifications. A 9–10 represents exceptional alignment with this specific role and applicant pool — not simply meeting the job requirements. Most qualified candidates should score 6–7. Reserve 8+ for candidates who stand out against competitive peers. Do not inflate weak fits.

When given a job posting URL or description:
1. If a URL, use web search to fetch the full posting. Confirm the role and company you found.
2. Identify what the hiring manager is ACTUALLY optimizing for — not just the job description bullet points. What problem are they trying to solve?
3. Run this exact analysis. Use ## headers for each step exactly as shown.

Begin the response with ONE plain-language coach summary on its own line, before STEP 0, in exactly this format — warm, honest, jargon-free, 1–2 sentences. Say what is working, whether the real fix is framing versus a genuine gap or career change, and the nearest achievable score. Example: "Solid operations background; the fix here is framing, not a career change. Two edits get you to a 7."
COACH SUMMARY: [1–2 sentence plain-language gist for the candidate]

## STEP 0 — JOB METADATA
Extract each field exactly as written in the posting. Write "Unknown" for anything not stated — never guess.
JOB_TITLE: [the exact job title from the posting — no commentary, title only]
COMPANY: [the company name exactly as written — no commentary, name only]
LOCATION: [city, state/country if stated, otherwise Unknown]
WORK_MODEL: [Remote / Hybrid / On-site / Unknown]
EMPLOYMENT_TYPE: [Full-time / Part-time / Contract / Internship / Temporary / Unknown]
SENIORITY: [Intern / Entry / Mid / Senior / Lead / Manager / Director / VP / Unknown]
SALARY_RANGE: [the pay range exactly as stated, e.g. "$120k–$150k", otherwise Unknown]
TEAM: [the team, department, or org if stated, otherwise Unknown]
KEY_REQUIREMENTS: [3–6 must-have skills or qualifications from the posting, comma-separated]

## STEP 1 — EXECUTIVE SUMMARY
- Recruiter Confidence: [X]/10 — [one-line reason; this is how likely a recruiter is to schedule a screen, NOT a keyword match — recruiters advance strong 60–70% keyword matches]
- Hiring Manager Score: [X]/10 — [one-line reason; can this person actually perform the role]
- Transferability: [X]/10 — [one-line reason; how well adjacent / transferable experience covers this role's competencies]
- Recruiter Ceiling: [X]/10 — realistic Recruiter Confidence AFTER the candidate makes the STEP 5 improvements. Must be greater than or equal to Recruiter Confidence and stay honest: edits to a resume rarely add more than 2–3 points and cannot manufacture missing experience. This is an achievable target, not a promise.
- Hiring Manager Ceiling: [X]/10 — realistic Hiring Manager Score after the same STEP 5 improvements, under the identical constraints.
- ATS Alignment: [High / Medium / Low] — approximately [X]% keyword match (one input only — do not let this drive Recruiter Confidence)
- Interview Probability: [X]%
- Overall Recommendation: [choose exactly one: Strong Apply | Apply | Apply with Tailoring | Stretch Role | Low Probability | Do Not Apply]

## STEP 1B — FULL SCORECARD
Score each dimension 0–10 and give a one-line, evidence-based reason. Never output a number without a reason. Format each line EXACTLY as: SCORE: <Dimension> | <X>/10 | <reason>
SCORE: Overall Fit | [X]/10 | [reason]
SCORE: ATS Match | [X]/10 | [reason]
SCORE: Recruiter Confidence | [X]/10 | [reason]
SCORE: Hiring Manager Confidence | [X]/10 | [reason]
SCORE: Transferability | [X]/10 | [reason]
SCORE: Interview Probability | [X]/10 | [reason]
SCORE: Resume Quality | [X]/10 | [reason]
SCORE: Layout | [X]/10 | [reason]
SCORE: Technical Alignment | [X]/10 | [reason]
SCORE: Business Competencies | [X]/10 | [reason]
SCORE: Risk Assessment | [X]/10 | [reason — higher means lower/less concerning risk]

## STEP 2 — HIRING DECISION
Would I interview this candidate? [Yes / No / Conditional]
If this is No or Conditional, the reasoning and the "Smallest truthful change" line below MUST name the concrete move that would flip it — never state the decision as a dead end.

[2–3 sentences in plain recruiter language: Would you send this resume to the HM today? What is the one thing most worth addressing before applying (framed as what to surface, not what's wrong)? What is the strongest piece of evidence in their favor?]

Biggest concern: [one sentence — the single thing most worth addressing first, phrased as what to surface or clarify, not as a deficiency]
Strongest selling point: [one sentence — the one thing that makes this candidate stand out]
Smallest truthful change that increases interview probability: [one specific, actionable edit they can start today]
What should NOT be changed: [one sentence — identify what is already working and should be left alone]

## STEP 3 — STRENGTHS AND TRANSFERABLE EXPERIENCE
Separate exactly what is working on this resume into two categories:

STRENGTHS (direct match — 3 items):
STRENGTH 1: [name it — be specific, not generic]
RECRUITER READS: [how a recruiter interprets this — why it passes the screen, 1–2 sentences]
HM READS: [how the hiring manager interprets this — why it resonates, 1–2 sentences]

STRENGTH 2: [name it]
RECRUITER READS: [recruiter perspective]
HM READS: [HM perspective]

STRENGTH 3: [name it]
RECRUITER READS: [recruiter perspective]
HM READS: [HM perspective]

TRANSFERABLE EXPERIENCE (adjacent — list up to 2 if present, skip section if none):
TRANSFERABLE 1: [name the experience]
HOW IT TRANSFERS: [one sentence — specifically how this experience maps to a requirement in this role]

TRANSFERABLE 2: [name the experience — only include if genuinely applicable]
HOW IT TRANSFERS: [one sentence]

TECHNICAL STRENGTHS: [comma-separated specific tools/systems/technical skills genuinely evidenced on the resume, or "None obvious"]
LEADERSHIP STRENGTHS: [comma-separated leadership / ownership / scope signals genuinely evidenced, or "None obvious"]

## STEP 4 — FASTEST WAYS TO MOVE UP
The top 3 things currently holding the score down — but write EACH as an action the candidate can take, never as a bare criticism. Name each item as the move to make ("Surface your SQL exposure"), not the deficiency ("no SQL"). Do not use the words "gap", "weakness", "missing", or "lacks". Every item must be a lever with a concrete step and a rough effort estimate. For each:

RISK 1: [name the lever as an action — specific, e.g. "Surface your SQL exposure in the skills line"]
WHY IT MATTERS: [one sentence — tie to a stated or implied job requirement, framed as the upside of doing it]
LIKELIHOOD: [Low / Medium / High — how much this is currently affecting the decision]
TEACHABILITY: [Already Demonstrated / Transferable / Learnable / Critical Gap — internal severity tag; reserve Critical Gap for true deal-breakers only]
MITIGATION: [one concrete step the candidate can take today to act on this]
EFFORT: [rough time to act on this, as one of: ~5 min, ~10 min, ~15 min, ~30 min, or ~60 min for the bigger lifts]

RISK 2: [name the lever as an action]
WHY IT MATTERS: [the upside]
LIKELIHOOD: [likelihood level]
TEACHABILITY: [teachability class]
MITIGATION: [concrete step today]
EFFORT: [~5 min / ~10 min / ~15 min / ~30 min / ~60 min]

RISK 3: [name the lever as an action]
WHY IT MATTERS: [the upside]
LIKELIHOOD: [likelihood level]
TEACHABILITY: [teachability class]
MITIGATION: [concrete step today]
EFFORT: [~5 min / ~10 min / ~15 min / ~30 min / ~60 min]

## STEP 5 — RESUME IMPROVEMENTS
Exactly 5 specific, high-impact edits, RANKED highest-ROI first (largest estimated interview-probability increase at the top). Only recommend changes the candidate can genuinely defend in an interview. Do not invent experience — every edit surfaces something real, it never fabricates. Each edit must be small enough to start in one sitting. Optimize for clarity, recruiter readability, and ATS alignment — in that order. Format each exactly like this:

IMPROVEMENT 1:
CURRENT: [exact text from their resume — or "Not yet shown on the resume" if the point isn't on the page]
ISSUE: [what this line doesn't yet do for this role — be specific and constructive, no generic advice, no harsh labels]
IMPROVED: [your rewrite — strong verb, specific outcome, natural keyword integration]
WHY IT WORKS: [one sentence — tied to this specific role, not general resume advice]
ESTIMATED LIFT: [+X% — realistic estimated increase in interview probability from this single change]
EFFORT: [realistic time for the candidate to make just this one edit, as one of: ~5 min, ~10 min, ~15 min, ~30 min]

IMPROVEMENT 2:
CURRENT: [current text or "Not yet shown on the resume"]
ISSUE: [the issue]
IMPROVED: [rewrite]
WHY IT WORKS: [why it matters for this role]
ESTIMATED LIFT: [+X%]
EFFORT: [~5 min / ~10 min / ~15 min / ~30 min]

IMPROVEMENT 3:
CURRENT: [current text or "Not yet shown on the resume"]
ISSUE: [the issue]
IMPROVED: [rewrite]
WHY IT WORKS: [why]
ESTIMATED LIFT: [+X%]
EFFORT: [~5 min / ~10 min / ~15 min / ~30 min]

IMPROVEMENT 4:
CURRENT: [current text or "Not yet shown on the resume"]
ISSUE: [the issue]
IMPROVED: [rewrite]
WHY IT WORKS: [why]
ESTIMATED LIFT: [+X%]
EFFORT: [~5 min / ~10 min / ~15 min / ~30 min]

IMPROVEMENT 5:
CURRENT: [current text or "Not yet shown on the resume"]
ISSUE: [the issue]
IMPROVED: [rewrite]
WHY IT WORKS: [why]
ESTIMATED LIFT: [+X%]
EFFORT: [~5 min / ~10 min / ~15 min / ~30 min]

## STEP 6 — INTERVIEW RISK
The 3 questions this interviewer will almost certainly ask — based on the gaps and signals in this specific resume. For each:

QUESTION 1: [the actual question — phrased exactly as the interviewer would ask it]
COACHING: [one paragraph of specific coaching based on what is in this candidate's actual background — do not give generic STAR method advice, give specific talking points from their resume]

QUESTION 2: [question]
COACHING: [coaching]

QUESTION 3: [question]
COACHING: [coaching]

## STEP 7 — HONEST VERDICT
One paragraph. ${cfg.verdictStyle} What is the realistic outcome if this candidate applies today, without changes?

Bottom line: [repeat the Overall Recommendation tier] — [one sentence that captures the clearest, most honest truth about this application]

## STEP 8 — DECISION CONFIDENCE
Decision Confidence: [High / Medium / Low]

Reason: [2–3 sentences explaining why you are or are not confident in this assessment. High = the strongest and weakest aspects are clear and the recommendation is unlikely to change without new experience. Medium = one or two factors could shift the verdict if clarified. Low = significant unknowns exist that would materially change the recommendation.]

---
Candidate Resume:
${resume}`;
};

// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────

// ─── SAMPLE ANALYSIS (demo mode — no API key required) ───────────────────────
const SAMPLE_JOB_ANALYSIS = `COACH SUMMARY: Solid operations background — the fix here is framing, not a career change. Two edits (naming the analyst pivot up front and surfacing SQL) get you to a 7.

## STEP 0 — JOB METADATA
JOB_TITLE: Business Analyst II
COMPANY: Meridian Health Systems
LOCATION: San Diego, CA (Hybrid)

## STEP 1 — EXECUTIVE SUMMARY
- Recruiter Confidence: 7/10 — Operations background reads as a credible analyst pivot; a recruiter would screen this despite the title gap.
- Hiring Manager Score: 6/10 — Would trust this person to run a requirements-gathering session; would worry about SQL depth on day one.
- Transferability: 8/10 — Process improvement, stakeholder coordination, and reporting map cleanly onto the core analyst competencies.
- Recruiter Ceiling: 9/10 — Naming the analyst transition up front and surfacing SQL/BI would move this from "credible pivot" to "obvious screen."
- Hiring Manager Ceiling: 8/10 — Quantifying a data-driven decision and reframing coordination as analysis closes most of the day-one doubt.
- ATS Alignment: Medium — approximately 60% keyword match (one input only)
- Interview Probability: 55%
- Overall Recommendation: Apply with Tailoring

## STEP 1B — FULL SCORECARD
SCORE: Overall Fit | 7/10 | Core operations competencies line up; the only real distance is the analyst title and SQL.
SCORE: ATS Match | 6/10 | Not yet naming SQL/Tableau costs literal match points a human read would recover.
SCORE: Recruiter Confidence | 7/10 | A recruiter screens this — the pivot is credible and the metrics survive the scan.
SCORE: Hiring Manager Confidence | 6/10 | Could run requirements sessions day one; SQL depth is the open question.
SCORE: Transferability | 8/10 | Process improvement, coordination, and reporting map straight onto the role.
SCORE: Interview Probability | 6/10 | Roughly a coin-flip today; the five edits push it toward a probable screen.
SCORE: Resume Quality | 7/10 | Clear progression and quantified outcomes; a few duty-based bullets dilute it.
SCORE: Layout | 8/10 | Clean, scannable, metrics-forward — nothing fights the 10-second read.
SCORE: Technical Alignment | 5/10 | Excel is present but the required SQL/BI stack is thin.
SCORE: Business Competencies | 8/10 | Strong evidence of process, stakeholder, and reporting ownership.
SCORE: Risk Assessment | 6/10 | Gaps are real but mostly teachable — no outright deal-breakers.

## STEP 2 — HIRING DECISION
Would I interview this candidate? Conditional

The operations background maps cleanly onto the core of this role — requirements gathering, stakeholder coordination, and process documentation are all evidenced with real outcomes. What stops me from sending it to the HM today is that the resume never says "analysis" out loud: the tools section lists Excel but not SQL, and no bullet quantifies a decision that data drove.

Biggest concern: The data-analysis toolkit isn't on the page yet — the JD lists SQL as required, so surfacing any real exposure is the first thing to address.
Strongest selling point: Five years of cross-functional coordination in a regulated manufacturing environment — exactly the stakeholder complexity this role describes.
Smallest truthful change that increases interview probability: Rename the "Project Coordination" section to "Business Process Analysis" and lead it with the cycle-time reduction metric.
What should NOT be changed: The career-progression narrative — the promotion path is doing real work and reads as momentum.

## STEP 3 — STRENGTHS AND TRANSFERABLE EXPERIENCE
Separate exactly what is working on this resume into two categories:

STRENGTHS (direct match — 3 items):
STRENGTH 1: Documented process-improvement outcomes with numbers attached
RECRUITER READS: Metrics in the first bullet of each role survive the 10-second scan — this resume doesn't ask the recruiter to take anything on faith.
HM READS: Someone who already thinks in baselines and deltas will onboard onto KPI dashboards faster than a candidate who only lists responsibilities.

STRENGTH 2: Regulated-industry stakeholder management
RECRUITER READS: Healthcare-adjacent compliance experience checks the "works with clinical and regulatory teams" line in the posting without any stretch.
HM READS: This person has survived documentation-heavy change control — they won't be shocked by our approval workflows.

STRENGTH 3: Steady internal promotion history
RECRUITER READS: Three roles at one employer with increasing scope reads as retention-safe, which matters for a backfill.
HM READS: Someone the previous org kept promoting is someone whose work other teams trusted.

TRANSFERABLE EXPERIENCE (adjacent — list up to 2 if present, skip section if none):
TRANSFERABLE 1: Production-line scheduling and capacity planning
HOW IT TRANSFERS: Capacity modeling is 80% of the demand-forecasting responsibility this JD buries in its third bullet.

TRANSFERABLE 2: Training-material development for new processes
HOW IT TRANSFERS: The role owns "documentation and end-user enablement," which this candidate has done, just under a different name.

TECHNICAL STRENGTHS: Excel (pivot tables, lookups), ERP data, production reporting, capacity modeling
LEADERSHIP STRENGTHS: Cross-functional coordination, stakeholder alignment, process ownership

## STEP 4 — FASTEST WAYS TO MOVE UP
RISK 1: Surface your SQL and dashboard exposure in a skills line
WHY IT MATTERS: The posting lists SQL as required and Tableau as preferred, so naming your real exposure (queries you've run, dashboards you rely on) gets you past the keyword screen and in front of a human.
LIKELIHOOD: High
TEACHABILITY: Learnable
MITIGATION: Add one honest skills line today for the exposure you have, and start a two-week SQL fundamentals course so the interview claim stays true.
EFFORT: ~15 min

RISK 2: Reframe your titles and verbs around analysis, not coordination
WHY IT MATTERS: Recruiters pattern-match on titles first — leading with analysis language lets them see the analyst work instead of inferring it.
LIKELIHOOD: Medium
TEACHABILITY: Transferable
MITIGATION: Rewrite section headers and bullet verbs around analysis, requirements, and outcomes rather than coordination and support.
EFFORT: ~30 min

RISK 3: Name the claims-workflow parallel from your regulated background
WHY IT MATTERS: The JD mentions claims-processing workflows twice; drawing the line from your regulated-manufacturing compliance work gives you the domain vocabulary competing applicants have cold.
LIKELIHOOD: Medium
TEACHABILITY: Learnable
MITIGATION: Skim the basic claims lifecycle before the phone screen and connect the compliance parallel explicitly when it comes up.
EFFORT: ~30 min

## STEP 5 — RESUME IMPROVEMENTS
IMPROVEMENT 1:
CURRENT: Coordinated cross-functional projects across manufacturing and quality teams
ISSUE: "Coordinated" is a scheduling verb — it hides the analysis this role is hiring for.
IMPROVED: Analyzed cross-functional production workflows across manufacturing and quality teams, identifying bottlenecks that cut changeover time 18%
WHY IT WORKS: Leads with the analyst verb the JD repeats and lands the metric inside the first line the recruiter reads.
ESTIMATED LIFT: +5%
EFFORT: ~15 min

IMPROVEMENT 2:
CURRENT: Not yet shown on the resume
ISSUE: The posting asks for requirements documentation and the resume doesn't yet use the phrase, even though the work happened.
IMPROVED: Gathered and documented business requirements from 4 stakeholder groups for a line-transfer project delivered on schedule
WHY IT WORKS: Puts the exact required phrase on the page attached to a real, defensible project.
ESTIMATED LIFT: +4%
EFFORT: ~15 min

IMPROVEMENT 3:
CURRENT: Proficient in Microsoft Excel
ISSUE: Undifferentiated — every applicant says this, and it wastes the skills line the ATS reads first.
IMPROVED: Excel (pivot tables, lookups, capacity models); SQL fundamentals (in progress)
WHY IT WORKS: Specificity converts a filler line into keyword coverage the screen is checking for.
ESTIMATED LIFT: +3%
EFFORT: ~5 min

IMPROVEMENT 4:
CURRENT: Responsible for daily production reporting
ISSUE: "Responsible for" states a duty, not an outcome, and buries a genuinely relevant deliverable.
IMPROVED: Built daily production reports used by 3 department leads to reallocate staffing, reducing overtime spend 12%
WHY IT WORKS: Turns passive reporting into decision-support — which is this job's actual function.
ESTIMATED LIFT: +2%
EFFORT: ~15 min

IMPROVEMENT 5:
CURRENT: Objective: Seeking a challenging business analyst position
ISSUE: Objective statements spend prime real estate telling the recruiter what you want instead of what they get.
IMPROVED: Operations professional with 5 years translating production data into process improvements across regulated manufacturing — moving that toolkit into business analysis.
WHY IT WORKS: A summary that names the transition directly disarms the title-gap concern before the recruiter forms it.
ESTIMATED LIFT: +2%
EFFORT: ~10 min

## STEP 6 — INTERVIEW RISK
QUESTION 1: You've never held an analyst title — walk me through the most analytical project you've owned end to end.
COACHING: Use the changeover-time project: baseline measurement, the data you pulled, the recommendation you made, and the 18% result. Name the stakeholders you had to convince. The structure matters more than the tooling — show that you already run the analyst loop of measure, diagnose, recommend, verify.

QUESTION 2: This role requires SQL from week one. Where are you with it honestly?
COACHING: Do not bluff this one. State current level plainly, name the course you're in and completion date, then pivot to the transferable logic: you already write complex Excel lookups and understand relational joins conceptually from working with the ERP's tables. Honest-plus-trajectory beats inflated-and-caught every time.

QUESTION 3: Why healthcare, and why now?
COACHING: Anchor it in the regulated-environment overlap — change control, documentation discipline, audit readiness — rather than a generic passion statement. Then give one concrete reason tied to this company's actual product line to prove you researched them and not just the title.

## STEP 7 — HONEST VERDICT
This is a live application, not a courtesy one. The operations-to-analyst pivot is credible on the evidence, and the promotion history buys real benefit of the doubt. But as written, the resume makes the recruiter do the translation work, and recruiters don't translate at screen speed — they skim and sort. Make the five edits, especially the SQL line and the summary reframe, and this moves from a coin-flip to a probable phone screen. Apply without the edits and the ATS or a tired human likely files it under "coordinator, not analyst."

Bottom line: Apply with Tailoring — one focused evening of edits is the difference between the maybe pile and the interview list.

## STEP 8 — DECISION CONFIDENCE
Decision Confidence: High

Reason: The strongest asset (evidenced process improvement) and the biggest lever (surfacing the analysis toolkit) are both unambiguous, and neither would change without new information. The recommendation is stable: this is a qualified stretch that tailoring meaningfully improves.`;

// ─── QUICK-CHECK PROMPT ───────────────────────────────────────────────────────
// A deliberately small ask — a recruiter's fast gut-check, not the full report.
// Returns just enough to answer "is this worth applying to?": the plain-language
// gist, one score with its ceiling, a verdict, and the single highest-impact
// move. Small max_tokens keeps it fast and cheap, which is the whole point — a
// low-commitment first step. The full analysis is one click away afterward.
const QUICK_PROMPT = (resume) => `You are a senior recruiter giving a candidate a fast, honest gut-check on whether a job is worth applying to. This is NOT a full report — it's a 20-second read.

Evaluate like a recruiter, not an ATS: weigh transferable experience, demonstrated competency, and interview-defensibility over literal keyword overlap. Be honest but encouraging, and never invent experience the resume doesn't support.

TONE — your job is to make them ACT, not quit. Be honest and specific, never harsh. Never use absolute deficit language ("no experience", "lacks", "missing", "weak", "gap"); instead say what the resume doesn't YET show and how to surface it. Never leave the verdict or TOP ACTION as a criticism — the TOP ACTION must be one concrete edit they could start in a single sitting (e.g. "rewrite your summary line to name the pivot"), never "get more experience".

The candidate's resume:
${resume}

Return ONLY this exact format — no preamble, no headings, no extra sections:

COACH SUMMARY: [1–2 warm, jargon-free sentences: is this worth their time, and is the gap about framing or a genuine stretch? Name the nearest achievable score.]
RECRUITER CONFIDENCE: [X]/10 — [one short reason — how likely a recruiter is to advance them, not a keyword match]
RECRUITER CEILING: [Y]/10
VERDICT: [exactly one of: Worth applying | Worth a tailored apply | A stretch — apply if excited | Probably skip]
TOP ACTION: [the single highest-impact, interview-defensible change they could make, in one concrete sentence]`;

// Parse the compact quick-check response into the few fields the fast view needs.
const parseQuick = (text) => ({
  coach:   parseCoachSummary(text),
  scores:  parseScores(text),
  ceiling: parseCeiling(text),
  verdict: text.match(/^\s*(?:[-*]\s*)?(?:\*\*)?VERDICT(?:\*\*)?:\s*(.+?)\s*$/im)?.[1]?.replace(/\*\*/g, "").trim() || null,
  action:  text.match(/^\s*(?:[-*]\s*)?(?:\*\*)?TOP ACTION(?:\*\*)?:\s*(.+?)\s*$/im)?.[1]?.replace(/\*\*/g, "").trim() || null,
});
// Map a verdict phrase to a warm signal color for the chip.
const verdictColor = (v) => {
  const s = (v || "").toLowerCase();
  if (s.startsWith("worth applying")) return C.accent;
  if (s.includes("tailored"))          return C.mint;
  if (s.includes("stretch"))           return C.yellow;
  if (s.includes("skip"))              return C.orange;
  return C.textSub;
};

// ─── ROLE-TARGET FINDER ───────────────────────────────────────────────────────
// From the base résumé alone, name the role types the candidate would realistically
// score 7+ on — winnable targets, not reaches. Aiming, not judging.
const ROLE_FINDER_PROMPT = (resume) => `You are a senior recruiter helping a candidate aim at WINNABLE roles, not only reaches. From the résumé below, name the role types this candidate would realistically score 7+ on TODAY — strong, interview-likely matches that reuse what they've already done. Be honest and specific: do not inflate, and do not name roles the résumé can't genuinely support.

Résumé:
${resume}

Return ONLY 3–5 lines, nothing else, each in EXACTLY this format:
ROLE: [a role type, or 2–3 closely related titles] | [one concrete sentence mapping their actual background to it]

Prefer titles that are a lateral or half-step move from their evidenced experience. Lead with the strongest match first.`;

const parseRoleTargets = (text) => [...(text || "").matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?ROLE(?:\*\*)?:\s*(.+?)\s*\|\s*(.+?)\s*$/gim)]
  .map(m => ({ title: m[1].replace(/\*\*/g, "").trim(), why: m[2].replace(/\*\*/g, "").trim() }))
  .filter(r => r.title && r.why)
  .slice(0, 5);

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ::placeholder { color: #A0A196 !important; opacity: 0.85; }
  textarea, input { color: #F5F4F0 !important; font-family: 'Inter', sans-serif; }
  input[type=date] { color-scheme: dark; }
  input[type=date]::-webkit-calendar-picker-indicator { filter: invert(0.5) sepia(1) hue-rotate(80deg); }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #35352F; border-radius: 2px; }
  select option { background: #141412; color: #F5F4F0; }
  a { color: ${C.blue}; }
  /* Accessibility: a clearly visible keyboard focus ring on every interactive
     element. !important defeats the inline outline:none some fields set, so
     keyboard users always get an indicator; mouse/touch users see nothing extra
     (focus-visible only). Offset + rounded to stay legible on dark surfaces. */
  a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible,
  select:focus-visible, [role="checkbox"]:focus-visible, [tabindex]:focus-visible {
    outline: 2px solid ${C.accent} !important;
    outline-offset: 2px;
    border-radius: 6px;
  }
  /* Comfortable, WCAG-sized tap targets without altering the visual style. */
  .tap { min-height: 44px; min-width: 44px; display: inline-flex; align-items: center; justify-content: center; }
  /* Edit-checklist microfeedback — CSS only, no animation library */
  @keyframes affirmIn { 0%{opacity:0;transform:translateY(3px)} 12%{opacity:1;transform:none} 78%{opacity:1} 100%{opacity:0;transform:translateY(-2px)} }
  @keyframes checkPop { 0%{transform:scale(0.5)} 60%{transform:scale(1.18)} 100%{transform:scale(1)} }
  /* Re-score celebration — a single calm glow pulse, no loop */
  @keyframes celebrateGlow { 0%{box-shadow:0 0 0 0 rgba(52,211,153,0)} 25%{box-shadow:0 0 28px 2px rgba(52,211,153,0.28)} 100%{box-shadow:0 0 0 0 rgba(52,211,153,0)} }
  @keyframes momentumIn { 0%{opacity:0;transform:translateY(8px)} 10%{opacity:1;transform:none} 85%{opacity:1} 100%{opacity:0;transform:translateY(-4px)} }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Keep the top nav from overflowing on phones */
  @media (max-width: 560px) {
    nav { padding: 0 14px !important; }
    .nav-status { display: none !important; }
  }
`;

// ─── REUSABLE COMPONENTS ──────────────────────────────────────────────────────
const Label = ({ children, color }) => (
  <p style={{ fontFamily: T.mono, fontSize: "11px", color: color || C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px", lineHeight: 1.4 }}>
    {children}
  </p>
);

const Pill = ({ label, color, bg }) => (
  <span style={{ background: bg, border: `1px solid ${color}44`, borderRadius: "4px", padding: "3px 9px", fontFamily: T.mono, fontSize: "11px", color, letterSpacing: "0.1em", whiteSpace: "nowrap", display: "inline-block" }}>
    {label}
  </span>
);

const TierBadge = ({ tier }) => {
  if (!tier) return null;
  return (
    <span style={{ background: tier.bg, border: `1px solid ${tier.color}55`, borderRadius: "6px", padding: "5px 12px", fontFamily: T.mono, fontSize: "11px", color: tier.color, letterSpacing: "0.08em", whiteSpace: "nowrap", display: "inline-block", fontWeight: 600 }}>
      {tier.label}
    </span>
  );
};

const Btn = ({ children, onClick, disabled, variant = "primary", small }) => {
  const pad  = small ? "7px 14px" : "12px 26px";
  const fz   = small ? "11px" : "12px";
  const vars = {
    primary: { background: disabled ? C.border2 : C.accent, color: disabled ? C.textDim : "#0C0C0B", border: "none" },
    ghost:   { background: "transparent", color: C.textSub, border: `1px solid ${C.border2}` },
    danger:  { background: "transparent", color: "#FCA5A577", border: `1px solid #FCA5A522` },
  };
  return (
    <button onClick={!disabled ? onClick : undefined} style={{ ...vars[variant], padding: pad, minHeight: "44px", display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "7px", fontFamily: T.mono, fontSize: fz, letterSpacing: "0.08em", textTransform: "uppercase", cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600, transition: "opacity 0.15s" }}>
      {children}
    </button>
  );
};

const Field = ({ value, onChange, placeholder, multiline, rows, disabled, mono, type, ariaLabel }) => {
  const base = {
    width: "100%", background: C.surface2, border: `1px solid ${C.border}`,
    borderRadius: "8px", padding: "12px 16px", fontSize: "15px",
    color: C.text, fontFamily: mono ? T.code : T.body,
    outline: "none", lineHeight: 1.7, resize: multiline ? "vertical" : undefined,
    transition: "border-color 0.15s",
  };
  const a11y = ariaLabel || placeholder || "Text input";
  if (multiline) return <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={a11y} rows={rows || 6} disabled={disabled} style={{ ...base, minHeight: rows ? `${rows * 26}px` : "140px" }} />;
  return <input type={type || "text"} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={a11y} disabled={disabled} style={base} />;
};

// ─── STEP ACCORDION ───────────────────────────────────────────────────────────
// Reframe deficit-labeled section headings ("Hiring Risks" / "Gaps" / "Weaknesses")
// to an action frame. Display-only relabel — the underlying content is unchanged.
// Safety net so older cached analyses (whose raw headings still say the old label)
// render reframed everywhere they're shown.
const reframeSectionLabel = (s) =>
  s.replace(/\b(?:hiring risks|weaknesses|weakness|gaps)\b/gi, "Fastest ways to move up");

const STEP_LABELS = {
  "STEP 1B": "Full Scorecard",
  "STEP 1": "Executive Summary",
  "STEP 2": "Hiring Decision",
  "STEP 3": "Strengths & Transferable Experience",
  "STEP 4": "Fastest ways to move up",
  "STEP 5": "Resume Improvements",
  "STEP 6": "Interview Risk",
  "STEP 7": "Honest Verdict",
  "STEP 8": "Decision Confidence",
};

function StepAccordion({ text }) {
  const [open, setOpen] = useState(null);
  // The coach summary is surfaced separately at the top, so strip it here to
  // avoid showing it twice in the full analysis.
  text = text.replace(/^\s*(?:[-*]\s*)?(?:\*\*)?COACH SUMMARY(?:\*\*)?:.*$/im, "").trimStart();
  const sections = [];
  const stepRegex = /(?:##\s*|\*\*)(STEP \d+[^*\n]*)(?:\*\*)?/g;
  const parts = text.split(stepRegex);
  let preamble = "";
  if (parts.length > 1) {
    preamble = parts[0];
    for (let i = 1; i < parts.length; i += 2) {
      const header = parts[i];
      const body   = parts[i + 1] || "";
      const key    = header.match(/STEP \d+[A-Z]?/)?.[0] || header;
      if (key === "STEP 0") continue; // machine-facing metadata — parsed, not displayed
      const friendlyTitle = Object.entries(STEP_LABELS).find(([k]) => header.includes(k))?.[1] || header;
      sections.push({ key, header, friendlyTitle, body });
    }
  }
  if (sections.length === 0) return <RenderLines text={text} />;

  const stepColors = {
    "STEP 1": C.accent, "STEP 2": C.mint,   "STEP 3": C.yellow,
    "STEP 4": C.orange, "STEP 5": C.red,    "STEP 6": C.blue,
    "STEP 7": C.accent, "STEP 8": C.textSub,
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
          const col = stepColors[key] || C.accent;
          return (
            <div key={key} style={{ border: `1px solid ${isOpen ? col + "55" : C.border}`, borderRadius: "10px", overflow: "hidden", background: isOpen ? C.surface : "transparent" }}>
              <button onClick={() => setOpen(isOpen ? null : key)} style={{ width: "100%", padding: "13px 18px", background: "transparent", border: "none", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", gap: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ width: "3px", height: "14px", background: isOpen ? col : C.textDim, borderRadius: "2px", flexShrink: 0 }} />
                  <span style={{ fontFamily: T.mono, fontSize: "11px", color: isOpen ? col : C.textDim, letterSpacing: "0.14em", textTransform: "uppercase" }}>{key}</span>
                  <span style={{ fontFamily: T.body, fontSize: "14px", color: isOpen ? C.text : C.textSub, fontWeight: isOpen ? 500 : 400 }}>{friendlyTitle}</span>
                </div>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, flexShrink: 0 }}>{isOpen ? "▲" : "▼"}</span>
              </button>
              {isOpen && (
                <div style={{ borderTop: `1px solid ${col}33` }}>
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

// ─── MARKDOWN RENDERER ────────────────────────────────────────────────────────
const RenderLines = ({ text }) => {
  const lines = text.split("\n");
  const elements = [];
  let bulletBuffer = [];
  let orderedBuffer = [];

  const flushBullets = () => {
    if (!bulletBuffer.length) return;
    elements.push(
      <div key={`b-${elements.length}`} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "12px 16px", margin: "10px 0", display: "flex", flexDirection: "column", gap: "6px" }}>
        {bulletBuffer.map((b, bi) => (
          <div key={bi} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
            <span style={{ color: C.accent, flexShrink: 0, marginTop: "5px", fontSize: "11px" }}>▸</span>
            <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, margin: 0, lineHeight: 1.75 }}>{b}</p>
          </div>
        ))}
      </div>
    );
    bulletBuffer = [];
  };

  const flushOrdered = () => {
    if (!orderedBuffer.length) return;
    elements.push(
      <div key={`o-${elements.length}`} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "12px 16px", margin: "10px 0", display: "flex", flexDirection: "column", gap: "8px" }}>
        {orderedBuffer.map((it, oi) => {
          const parts = it.text.split(/\*\*(.*?)\*\*/g);
          return (
            <div key={oi} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <span style={{ color: C.accent, flexShrink: 0, marginTop: "1px", fontFamily: T.mono, fontSize: "13px", fontWeight: 600, minWidth: "18px" }}>{it.num}.</span>
              <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, margin: 0, lineHeight: 1.75 }}>
                {parts.map((p, j) => j % 2 === 1 ? <strong key={j} style={{ color: C.text, fontWeight: 600 }}>{p}</strong> : p)}
              </p>
            </div>
          );
        })}
      </div>
    );
    orderedBuffer = [];
  };

  // Flush any open list block (bulleted or numbered) before a non-list element.
  const flush = () => { flushBullets(); flushOrdered(); };

  lines.forEach((line, i) => {
    if (line.startsWith("### ")) {
      flush();
      elements.push(<h3 key={i} style={{ fontFamily: T.display, fontSize: "16px", color: C.text, margin: "18px 0 6px", fontWeight: 700, lineHeight: 1.4, paddingBottom: "6px", borderBottom: `1px solid ${C.border}` }}>{reframeSectionLabel(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      flush();
      elements.push(<h2 key={i} style={{ fontFamily: T.display, fontSize: "18px", color: C.text, margin: "22px 0 8px", fontWeight: 700, lineHeight: 1.35, paddingBottom: "7px", borderBottom: `1px solid ${C.border}` }}>{reframeSectionLabel(line.slice(3).replace(/\*\*(.*?)\*\*/g, (_, t) => t).replace(/^#+\s*/, ""))}</h2>);
    } else if (line.startsWith("# ")) {
      flush();
      elements.push(<h1 key={i} style={{ fontFamily: T.display, fontSize: "21px", color: C.text, margin: "24px 0 10px", fontWeight: 700, lineHeight: 1.3 }}>{reframeSectionLabel(line.slice(2).replace(/\*\*(.*?)\*\*/g, (_, t) => t))}</h1>);
    } else if (/^IMPROVEMENT \d+:/.test(line)) {
      flush();
      elements.push(<p key={i} style={{ fontFamily: T.mono, fontSize: "12px", color: C.accent, margin: "20px 0 6px", letterSpacing: "0.06em", fontWeight: 500 }}>{line}</p>);
    } else if (/^EDIT \d+:/.test(line)) {
      flush();
      elements.push(<p key={i} style={{ fontFamily: T.mono, fontSize: "12px", color: C.accent, margin: "20px 0 6px", letterSpacing: "0.06em", fontWeight: 500 }}>{line}</p>);
    } else if (line.startsWith("CURRENT:") || line.startsWith("ORIGINAL:")) {
      flush();
      const val = line.replace(/^(CURRENT|ORIGINAL):/, "").trim();
      elements.push(
        <div key={i} style={{ background: "#1D100E", border: `1px solid ${C.red}33`, borderRadius: "6px", padding: "10px 14px", margin: "4px 0" }}>
          <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.red, opacity: 0.6, margin: "0 0 4px", letterSpacing: "0.1em" }}>CURRENT</p>
          <p style={{ fontFamily: T.body, fontSize: "13px", color: "#FCA5A5", margin: 0, lineHeight: 1.6 }}>{val}</p>
        </div>
      );
    } else if (line.startsWith("IMPROVED:") || line.startsWith("SUGGESTED:")) {
      const val = line.replace(/^(IMPROVED|SUGGESTED):/, "").trim();
      elements.push(
        <div key={i} style={{ background: "#0a1a0d", border: `1px solid ${C.accent}33`, borderRadius: "6px", padding: "10px 14px", margin: "4px 0" }}>
          <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, opacity: 0.6, margin: "0 0 4px", letterSpacing: "0.1em" }}>IMPROVED</p>
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.mint, margin: 0, lineHeight: 1.6 }}>{val}</p>
        </div>
      );
    } else if (line.startsWith("PROBLEM:") || line.startsWith("ISSUE:")) {
      const val = line.replace(/^(PROBLEM|ISSUE):/, "").trim();
      if (val) elements.push(<p key={i} style={{ fontFamily: T.body, fontSize: "12px", color: C.yellow, margin: "4px 0", lineHeight: 1.6, paddingLeft: "4px" }}>⚠ {val}</p>);
    } else if (line.startsWith("WHY IT WORKS:") || line.startsWith("WHY:")) {
      const val = line.replace(/^(WHY IT WORKS|WHY):/, "").trim().replace(/\*\*/g, "").split("---")[0].trim();
      if (val) elements.push(<p key={i} style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, margin: "4px 0 12px", fontStyle: "italic", lineHeight: 1.65, paddingLeft: "4px" }}>↳ {val}</p>);
    } else if (line.match(/^[-*] /)) {
      flushOrdered();
      bulletBuffer.push(line.slice(2).replace(/\*\*(.*?)\*\*/g, (_, t) => t));
    } else if (line.match(/^\d+\.\s+/)) {
      flushBullets();
      const m = line.match(/^(\d+)\.\s+(.*)$/);
      orderedBuffer.push({ num: m[1], text: m[2] });
    } else if (line.trim() === "") {
      flush();
      elements.push(<div key={i} style={{ height: "8px" }} />);
    } else if (line.startsWith("|")) {
      flush();
      const cells = line.split("|").filter(c => c.trim() && !c.match(/^[-\s]+$/));
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
      flush();
      const parts = line.split(/\*\*(.*?)\*\*/g);
      elements.push(
        <p key={i} style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "4px 0" }}>
          {parts.map((p, j) => j % 2 === 1 ? <strong key={j} style={{ color: C.text, fontWeight: 600 }}>{p}</strong> : p)}
        </p>
      );
    }
  });
  flush();
  return <>{elements}</>;
};

// Compact formatted preview for small cards (e.g. Pipeline "Analysis Preview").
// Renders headings, bold, and lists — never shows raw ## / ** / 1. syntax.
const RenderPreview = ({ text, limit = 700 }) => {
  // Drop the machine-facing STEP 0 metadata block so the preview leads with prose.
  const cleaned = text
    .replace(/^\s*(?:[-*]\s*)?(?:\*\*)?COACH SUMMARY(?:\*\*)?:.*$/im, "")
    .replace(/#{1,6}\s*STEP 0[\s\S]*?(?=\n#{1,6}\s*STEP|\n\*\*STEP|$)/i, "")
    .trim();
  const clipped = cleaned.length > limit
    ? cleaned.slice(0, limit).replace(/\s+\S*$/, "") + "…"
    : cleaned;

  const out = [];
  clipped.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const head = line.match(/^#{1,6}\s+(.*)$/) || line.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (head) {
      const label = reframeSectionLabel(head[1].replace(/\*\*/g, "").replace(/^STEP \d+[A-Z]?\s*[—\-–]\s*/i, ""));
      out.push(<p key={i} style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.1em", textTransform: "uppercase", margin: out.length ? "10px 0 3px" : "0 0 3px" }}>{label}</p>);
      return;
    }
    const body = line.replace(/^\s*[-*]\s+/, "▸ ").replace(/^\s*(\d+)\.\s+/, "$1. ");
    const parts = body.split(/\*\*(.*?)\*\*/g);
    out.push(
      <p key={i} style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: "2px 0", lineHeight: 1.7 }}>
        {parts.map((p, j) => j % 2 === 1 ? <strong key={j} style={{ color: C.textMid, fontWeight: 600 }}>{p}</strong> : p)}
      </p>
    );
  });
  return <div>{out}</div>;
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

// ─── ROLE TARGETS ─────────────────────────────────────────────────────────────
// Winnable-role suggestions from the base résumé. On-demand (one API call),
// cached locally by résumé hash so it's instant afterward and free to re-open.
function RoleTargets({ resume, onOpenSetup, warm }) {
  const hash = hashStr((resume || "").trim());
  const [roles, setRoles] = useState(() => {
    try { const c = JSON.parse(localStorage.getItem(KEYS.roleTargets) || "null"); return c && c.hash === hash ? c.roles : null; }
    catch { return null; }
  });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const accent = warm || C.accent;

  const generate = async () => {
    const apiKey = localStorage.getItem(KEYS.apiKey);
    const proxyUrl = localStorage.getItem(KEYS.proxyUrl);
    if (!apiKey) { setErr("nokey"); return; }
    if (!resume || resume.trim().length < 50) { setErr("Add your résumé in Settings first — that's what these are drawn from."); return; }
    setLoading(true); setErr("");
    try {
      const endpoint = proxyUrl ? proxyUrl.replace(/\/$/, "") : "https://api.anthropic.com/v1/messages";
      const headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
      if (!proxyUrl) headers["anthropic-dangerous-allow-browser"] = "true";
      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: "user", content: ROLE_FINDER_PROMPT(resume) }] }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
      const parsed = parseRoleTargets(text);
      if (!parsed.length) throw new Error("Couldn't read the suggestions — give it another try.");
      setRoles(parsed);
      try { localStorage.setItem(KEYS.roleTargets, JSON.stringify({ hash, roles: parsed })); } catch {}
    } catch (e) {
      setErr(classifyApiError(e, !!proxyUrl).message);
    }
    setLoading(false);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: roles ? "10px" : "8px", flexWrap: "wrap" }}>
        <span style={{ fontFamily: T.mono, fontSize: "10px", color: accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>Roles you'd likely score 7+ on</span>
        {roles && <button className="tap" onClick={generate} disabled={loading} style={{ background: "transparent", border: "none", color: C.textSub, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.06em", cursor: "pointer" }}>{loading ? "…" : "↻ refresh"}</button>}
      </div>

      {roles ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {roles.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: "9px", alignItems: "flex-start" }}>
              <span style={{ color: accent, fontFamily: T.mono, fontSize: "12px", flexShrink: 0, marginTop: "1px" }}>▸</span>
              <p style={{ fontFamily: T.body, fontSize: "13.5px", color: C.textMid, margin: 0, lineHeight: 1.55 }}>
                <span style={{ color: C.text, fontWeight: 600 }}>{r.title}</span> — {r.why}
              </p>
            </div>
          ))}
        </div>
      ) : err === "nokey" ? (
        <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: 0, lineHeight: 1.6 }}>
          Add your API key {onOpenSetup ? <button onClick={onOpenSetup} style={{ background: "transparent", border: "none", color: accent, cursor: "pointer", padding: 0, font: "inherit", textDecoration: "underline" }}>in Setup</button> : "in Settings"} to see the roles your résumé already wins.
        </p>
      ) : (
        <div>
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: "0 0 10px", lineHeight: 1.6 }}>
            Pull 3–5 role types your résumé already maps to at 7+ — winnable targets to aim at, not just reaches.
          </p>
          <Btn small onClick={generate} disabled={loading}>{loading ? "Finding your matches…" : "Show me winnable roles →"}</Btn>
          {err && err !== "nokey" && <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.red, margin: "10px 0 0", letterSpacing: "0.04em" }}>⚠ {err}</p>}
        </div>
      )}
    </div>
  );
}

// ─── STRETCH-PATTERN CALLOUT ──────────────────────────────────────────────────
// Warm, calm coaching (never a warning) shown when recent analyses are all
// stretches. Frames it as targeting + sequencing, offers two concrete levers,
// and only returns after dismissal if the pattern genuinely persists.
function StretchPatternCallout({ jobs, onOpenJob, resume, onOpenSetup }) {
  const pat = detectStretchPattern(jobs);
  const [dismissedSig, setDismissedSig] = useState(() => { try { return localStorage.getItem(KEYS.stretchDismissed); } catch { return null; } });
  const [panel, setPanel] = useState(null); // "recalibrate" | "reframe" | null
  if (!pat || dismissedSig === pat.signature) return null;

  const warm = C.orange;
  const dismiss = () => { try { localStorage.setItem(KEYS.stretchDismissed, pat.signature); } catch {} setDismissedSig(pat.signature); };
  const toggle = (k) => setPanel(p => p === k ? null : k);
  const imp = pat.topImprovement;
  const impText = imp?.improved || imp?.current || imp?.issue || imp?.problem || null;

  const leverBtn = (active) => ({ textAlign: "left", background: active ? `${warm}1E` : `${warm}12`, border: `1px solid ${warm}${active ? "66" : "33"}`, borderRadius: "9px", padding: "10px 14px", color: C.text, fontFamily: T.body, fontSize: "13.5px", fontWeight: 500, cursor: "pointer", lineHeight: 1.45 });

  return (
    <div style={{ background: "#17120C", border: `1px solid ${warm}44`, borderRadius: "12px", padding: "16px 18px", marginBottom: "18px", position: "relative" }}>
      <button className="tap" onClick={dismiss} aria-label="Dismiss" style={{ position: "absolute", top: "8px", right: "10px", background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: "13px", lineHeight: 1 }}>✕</button>

      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{ fontSize: "14px" }} aria-hidden="true">🧭</span>
        <span style={{ fontFamily: T.mono, fontSize: "10px", color: warm, letterSpacing: "0.14em", textTransform: "uppercase" }}>A quick strategy note</span>
      </div>

      <p style={{ fontFamily: T.body, fontSize: "14.5px", color: C.text, margin: "0 0 6px", lineHeight: 1.55, fontWeight: 500 }}>
        The last {pat.count} roles you checked all scored as stretches.
      </p>
      <p style={{ fontFamily: T.body, fontSize: "13.5px", color: C.textMid, margin: "0 0 10px", lineHeight: 1.65 }}>
        That usually means the search is aimed a band above your current match — not that you're not good enough. Let's recalibrate.
      </p>
      <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: "0 0 14px", lineHeight: 1.65 }}>
        No search comes with a promised date — but the two things that move your interview rate fastest are in your hands: trade a few reaches for matches, and tailor the résumé. Both are one tap below.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "9px" }}>
        <button className="tap" onClick={() => toggle("recalibrate")} style={leverBtn(panel === "recalibrate")}>
          🎯 See roles you'd likely score 7+ on
        </button>
        <button className="tap" onClick={() => toggle("reframe")} style={leverBtn(panel === "reframe")}>
          ✍️ Reframe your resume for the roles you DO match
        </button>
      </div>

      {panel === "recalibrate" && (
        <div style={{ marginTop: "12px", background: "#0F0C08", border: `1px solid ${warm}22`, borderRadius: "9px", padding: "13px 15px" }}>
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: "0 0 12px", lineHeight: 1.65 }}>
            You're landing around {pat.avg != null ? `${fmtScore(pat.avg)}/10` : "a stretch"} on these. The fastest route to the stretch role is usually landing an adjacent one first and growing in. Here's where your résumé already clears 7+:
          </p>
          <RoleTargets resume={resume} onOpenSetup={onOpenSetup} warm={warm} />
        </div>
      )}

      {panel === "reframe" && (
        <div style={{ marginTop: "12px", background: "#0F0C08", border: `1px solid ${warm}22`, borderRadius: "9px", padding: "13px 15px" }}>
          {impText ? (
            <>
              <p style={{ fontFamily: T.mono, fontSize: "10px", color: warm, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 6px" }}>Your highest-impact reframe right now</p>
              <p style={{ fontFamily: T.body, fontSize: "13.5px", color: C.text, margin: "0 0 10px", lineHeight: 1.6 }}>{impText}</p>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {imp?.improved && <button className="tap" onClick={() => navigator.clipboard?.writeText(imp.improved)} style={{ background: `${warm}14`, border: `1px solid ${warm}44`, borderRadius: "8px", padding: "6px 13px", color: warm, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.06em", cursor: "pointer" }}>Copy ↗</button>}
                {pat.topJob && onOpenJob && <button className="tap" onClick={() => onOpenJob(pat.topJob.id)} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "6px 13px", color: C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.06em", cursor: "pointer" }}>Open this analysis →</button>}
              </div>
            </>
          ) : (
            <p style={{ fontFamily: T.body, fontSize: "13.5px", color: C.textMid, margin: 0, lineHeight: 1.7 }}>
              Open your strongest recent analysis and start with its top edit — small, defensible reframes are what move a stretch toward a match.
            </p>
          )}
        </div>
      )}

      <p style={{ fontFamily: T.body, fontSize: "12px", color: C.textSub, margin: "12px 0 0", lineHeight: 1.6 }}>
        Smart targeting and sequencing — not lower standards. Land an adjacent role, then stretch from inside.
      </p>
    </div>
  );
}

// ─── QUICK RESULT VIEW ────────────────────────────────────────────────────────
// The fast, low-commitment read: the gist, one score with its band and ceiling,
// a verdict, and the single highest-impact move — plus a one-click path into the
// full analysis. Nothing here writes to the pipeline.
function QuickResultView({ quick, input, onRunFull, onReset, loading }) {
  const rec   = quick.scores?.recruiter ?? null;
  const rCeil = resolveCeiling(rec, null, quick.ceiling?.recruiter);
  const vColor = verdictColor(quick.verdict);
  const bandKey = bandFromScore(rec);
  const band = bandKey ? FIT_BANDS[bandKey] : null;
  return (
    <>
      {/* User bubble — mirrors the full result feed */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "18px 18px 4px 18px", padding: "12px 18px", maxWidth: "80%" }}>
          <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.textSub, margin: 0, wordBreak: "break-all", lineHeight: 1.5 }}>
            {input.trim().slice(0, 120)}{input.trim().length > 120 ? "..." : ""}
          </p>
        </div>
      </div>

      <CoachSummary text={quick.coach} />

      <ResultBubble>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", gap: "10px" }}>
            <ScoreCeiling label="Recruiter Confidence" current={rec} ceiling={rCeil} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {band && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "7px", background: `${band.color}14`, border: `1px solid ${band.color}44`, borderRadius: "20px", padding: "7px 14px" }}>
                <span style={{ fontFamily: T.mono, fontSize: "10px", color: band.color, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>{band.label}</span>
                <span style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid }}>{band.blurb}</span>
              </span>
            )}
            {quick.verdict && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "9px", background: `${vColor}14`, border: `1px solid ${vColor}44`, borderRadius: "20px", padding: "7px 16px" }}>
                <span style={{ fontFamily: T.mono, fontSize: "10px", color: vColor, letterSpacing: "0.12em", textTransform: "uppercase" }}>Verdict</span>
                <span style={{ fontFamily: T.body, fontSize: "14px", color: C.text, fontWeight: 500 }}>{quick.verdict}</span>
              </span>
            )}
          </div>
        </div>
      </ResultBubble>

      {quick.action && (
        <ResultBubble>
          <div style={{ background: "#0E1A13", border: `1px solid ${C.accent}44`, borderRadius: "4px 18px 18px 18px", padding: "14px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
              <div style={{ width: "3px", height: "12px", background: C.accent, borderRadius: "2px" }} />
              <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.14em", textTransform: "uppercase" }}>Your highest-impact move</span>
            </div>
            <p style={{ fontFamily: T.body, fontSize: "15px", color: C.text, margin: 0, lineHeight: 1.6 }}>{quick.action}</p>
          </div>
        </ResultBubble>
      )}

      {/* Path into the full analysis — one click, same input */}
      <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", paddingLeft: "38px" }}>
        <Btn onClick={onRunFull} disabled={loading}>{loading ? "Analyzing..." : "See the full analysis →"}</Btn>
        <button onClick={onReset} style={{ background: "transparent", border: "none", color: C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.06em", cursor: "pointer" }}>↺ Start over</button>
      </div>
      <p style={{ fontFamily: T.body, fontSize: "12px", color: C.textDim, margin: "2px 0 0", paddingLeft: "38px", lineHeight: 1.6 }}>
        That's the 20-second read. The full analysis adds strengths, risks, the interview questions they'll ask, and a resume-edit checklist.
      </p>
    </>
  );
}

// ─── ANALYZER PAGE ────────────────────────────────────────────────────────────
function AnalyzerPage({ resume, onSaveJob, onPatchJob, onOpenSetup, jobs, onOpenJob }) {
  const [mode, setMode]             = useState("url");
  const [input, setInput]           = useState("");
  const [result, setResult]         = useState("");
  const [loading, setLoading]       = useState(false);
  const [phase, setPhase]           = useState("idle");
  const [phaseIdx, setPhaseIdx]     = useState(0);
  const [error, setError]           = useState("");
  const [errorKind, setErrorKind]   = useState(null);   // "cors" | "auth" | "network" | "other"
  const [tone, setTone]             = useState("recruiter");
  const [scores, setScores]         = useState({ recruiter: null, hm: null });
  const [ceiling, setCeiling]       = useState({ recruiter: null, hm: null });
  const [coach, setCoach]           = useState(null);
  const [scorecard, setScorecard]   = useState([]);
  const [tier, setTier]             = useState(null);
  const [odds, setOdds]             = useState(null);
  const [decision, setDecision]     = useState(null);
  const [strengths, setStrengths]       = useState([]);
  const [transferable, setTransferable] = useState([]);
  const [technical, setTechnical]       = useState([]);
  const [leadership, setLeadership]     = useState([]);
  const [risks, setRisks]               = useState([]);
  const [improvements, setImprovements] = useState([]);
  const [interviewRisk, setInterviewRisk] = useState([]);
  const [verdict, setVerdict]           = useState(null);
  const [confidence, setConfidence]     = useState(null);
  const [showFull, setShowFull]     = useState(false);
  // Disclosure preference: focused (default) shows the gist, scores, and one next
  // action; "everything" expands every section card. Persisted across analyses.
  const [showEverything, setShowEverything] = useState(() => {
    try { return localStorage.getItem(KEYS.reportView) === "full"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(KEYS.reportView, showEverything ? "full" : "focused"); } catch {}
  }, [showEverything]);
  const [isDemo, setIsDemo]         = useState(false);
  const [quick, setQuick]           = useState(null);   // compact quick-check result, or null for full mode
  const [restorable, setRestorable] = useState(null);   // an unrun draft offered on return
  const { logEvent } = useEvents();
  const resultRef      = useRef(null);
  const analyzedRef    = useRef("");   // input already counted as an "analyzed" win (dedupes quick→full)
  // Holds the pipeline id of the job created by the current input.
  // Re-running the same input (e.g. tone toggle) UPDATES that entry
  // instead of saving a duplicate. Cleared when the input changes.
  const savedJobIdRef  = useRef(null);

  const analyze = async (overrideTone) => {
    const activeTone = overrideTone || tone;
    if (!input.trim()) return;
    const apiKey  = localStorage.getItem(KEYS.apiKey);
    const proxyUrl = localStorage.getItem(KEYS.proxyUrl);
    if (!apiKey) { setError("No API key found. Go to Settings and add your Anthropic API key."); return; }

    setLoading(true); setResult(""); setPhase("loading"); setPhaseIdx(0); setError(""); setErrorKind(null);
    setQuick(null); clearDraft();
    setScores({ recruiter: null, hm: null }); setCeiling({ recruiter: null, hm: null }); setCoach(null); setScorecard([]); setTier(null); setOdds(null);
    setDecision(null); setStrengths([]); setTransferable([]); setTechnical([]); setLeadership([]); setRisks([]); setImprovements([]);
    setInterviewRisk([]); setVerdict(null); setConfidence(null); setShowFull(false);

    const interval = setInterval(() => setPhaseIdx(p => (p + 1) % PHASES.length), 1800);

    try {
      const userMsg = isUrl(input)
        ? `Fetch and analyze this job posting URL: ${input.trim()}`
        : `Analyze this job posting:\n\n${input}`;

      const body = {
        model: MODEL,
        max_tokens: 6000,
        system: ANALYSIS_PROMPT(resume, activeTone),
        messages: [{ role: "user", content: userMsg }],
      };
      if (isUrl(input)) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];

      const endpoint = proxyUrl ? proxyUrl.replace(/\/$/, "") : "https://api.anthropic.com/v1/messages";
      const headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
      if (!proxyUrl) headers["anthropic-dangerous-allow-browser"] = "true";

      const res  = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) throw new Error(`API error: ${data.error.message || data.error.type}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "No response.";
      clearInterval(interval);

      // Parse all structured sections
      const parsedScores = parseScores(text);
      const parsedCeiling = parseCeiling(text);
      const parsedCoach = parseCoachSummary(text);
      const parsedTier   = parseTier(text) || tierFromScores(parsedScores.recruiter, parsedScores.hm);
      const parsedOdds   = parseOdds(text);
      const parsedDec    = parseHiringDecision(text);
      const { strengths: parsedStr, transferable: parsedXfer, technical: parsedTech, leadership: parsedLead } = parseStrengths(text);
      const parsedRisks  = parseRisks(text);
      const parsedImprv  = parseImprovements(text).length ? parseImprovements(text) : parseEdits(text);
      const parsedIR     = parseInterviewRisk(text);
      const parsedVerd   = parseVerdict(text);
      const parsedConf   = parseDecisionConfidence(text);

      setResult(text);
      setScores(parsedScores);
      setCeiling(parsedCeiling);
      setCoach(parsedCoach);
      setScorecard(parseScorecard(text));
      setTier(parsedTier);
      setOdds(parsedOdds);
      setDecision(parsedDec);
      setStrengths(parsedStr || []);
      setTransferable(parsedXfer || []);
      setTechnical(parsedTech || []);
      setLeadership(parsedLead || []);
      setRisks(parsedRisks);
      setImprovements(parsedImprv);
      setInterviewRisk(parsedIR);
      setVerdict(parsedVerd);
      setConfidence(parsedConf);
      setPhase("done");

      // Title + company come from the STEP 0 metadata block (deterministic).
      // Legacy regex kept only as a fallback for older/degraded responses.
      const meta = parseJobMeta(text);
      const legacyTitle = text.match(/(?:role|position|job)[:\s]+([^\n.]{5,60})/i)?.[1]?.trim().slice(0, 60);
      const legacyComp  = text.match(/(?:company|at)\s+([A-Z][a-zA-Z\s&,.]+?)(?:\s*[,.\n(])/)?.[1]?.trim().slice(0, 40);
      const autoTitle   = meta.title   || legacyTitle || "Untitled Role";
      const autoCompany = meta.company || legacyComp  || "Unknown Company";

      // Log the effort win — a fresh analysis only, not a lens re-run of the same
      // posting (those pass overrideTone), and not a full run of a posting a quick
      // check already counted (analyzedRef), so the "This week" count stays honest.
      if (!overrideTone && analyzedRef.current !== input.trim()) {
        logEvent("analyzed", { title: autoTitle, company: autoCompany });
        analyzedRef.current = input.trim();
      }

      // Capture as much of the listing as we can into the pipeline record:
      // parsed metadata, the executive-summary signals, and the raw posting.
      const listing = {
        location:            meta.location || null,
        workModel:           meta.workModel || null,
        employmentType:      meta.employmentType || null,
        seniority:           meta.seniority || null,
        salary:              meta.salary || null,
        team:                meta.team || null,
        keyRequirements:     meta.keyRequirements || null,
        atsAlignment:        parsedOdds?.ats ?? null,
        interviewProbability:parsedOdds?.probability ?? null,
        hiringVerdict:       parsedDec?.verdict || null,
        decisionConfidence:  parsedConf?.level || null,
        // Keep the source text so the posting survives even if the URL rots.
        jd:                  isUrl(input) ? "" : input.trim().slice(0, 8000),
      };

      if (savedJobIdRef.current) {
        // Same input re-analyzed (tone toggle / retry) — refresh the existing
        // pipeline entry rather than creating a duplicate.
        onPatchJob(savedJobIdRef.current, {
          title: autoTitle, company: autoCompany,
          recruiterScore: parsedScores.recruiter, hmScore: parsedScores.hm,
          recruiterCeiling: parsedCeiling.recruiter, hmCeiling: parsedCeiling.hm, coachSummary: parsedCoach,
          tier: parsedTier?.label || null, analysis: text,
          ...listing,
        });
      } else {
        // Build the canonical core via the shared factory (id derives from the
        // url, so this dedupes with a job Path Pursuit already saved), then
        // layer InFlow's own fields on top.
        const base = makeJob({
          url: isUrl(input) ? input.trim() : "",
          title: autoTitle, company: autoCompany,
          jd: listing.jd, source: "inflow", status: "saved",
        });
        const id = base.id;
        savedJobIdRef.current = id;
        const existing = base.url ? findJob(id) : null;
        if (existing) {
          // Already tracked (Path Pursuit saved it, or a prior analysis) — enrich
          // it without disturbing its status/appliedAt.
          onPatchJob(id, {
            title: autoTitle, company: autoCompany,
            recruiterScore: parsedScores.recruiter, hmScore: parsedScores.hm,
            recruiterCeiling: parsedCeiling.recruiter, hmCeiling: parsedCeiling.hm, coachSummary: parsedCoach,
            tier: parsedTier?.label || null, analysis: text,
            ...listing,
          });
        } else {
          const t2 = base.savedAt;
          onSaveJob({
            ...base,
            recruiterScore: parsedScores.recruiter, hmScore: parsedScores.hm,
            recruiterCeiling: parsedCeiling.recruiter, hmCeiling: parsedCeiling.hm, coachSummary: parsedCoach,
            tier: parsedTier?.label || null,
            notes: "", analysis: text, dateAdded: t2, dateSaved: t2,
            dateApplied: null, dateScreen: null, dateInterview: null,
            dateOffer: null, dateRejected: null,
            ...listing,
          });
        }
      }

      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 200);
    } catch (err) {
      clearInterval(interval);
      const c = classifyApiError(err, !!proxyUrl);
      setError(c.message); setErrorKind(c.kind);
      setPhase("idle");
    }
    setLoading(false);
  };

  // Quick check — a fast, low-commitment read (coach summary + score band + one
  // action). Deliberately does NOT touch the pipeline or the full-result state
  // beyond what the compact view shows; the full analysis is one click away.
  const quickAnalyze = async () => {
    if (!input.trim()) return;
    const apiKey  = localStorage.getItem(KEYS.apiKey);
    const proxyUrl = localStorage.getItem(KEYS.proxyUrl);
    if (!apiKey) { setError("No API key found. Go to Settings and add your Anthropic API key."); return; }

    setLoading(true); setResult(""); setPhase("loading"); setPhaseIdx(0); setError(""); setErrorKind(null);
    setQuick(null); setIsDemo(false); clearDraft();
    const interval = setInterval(() => setPhaseIdx(p => (p + 1) % PHASES.length), 1800);
    try {
      const userMsg = isUrl(input)
        ? `Fetch and read this job posting URL, then give the quick gut-check: ${input.trim()}`
        : `Give the quick gut-check on this job posting:\n\n${input}`;
      const body = { model: MODEL, max_tokens: 900, system: QUICK_PROMPT(resume), messages: [{ role: "user", content: userMsg }] };
      if (isUrl(input)) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }];

      const endpoint = proxyUrl ? proxyUrl.replace(/\/$/, "") : "https://api.anthropic.com/v1/messages";
      const headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
      if (!proxyUrl) headers["anthropic-dangerous-allow-browser"] = "true";

      const res  = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) throw new Error(`API error: ${data.error.message || data.error.type}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
      clearInterval(interval);

      const q = parseQuick(text);
      setQuick(q);
      setPhase("done");
      // A quick check is still a "job analyzed" win — count it once, and mark this
      // input so a follow-up full run doesn't double-count it.
      if (analyzedRef.current !== input.trim()) {
        logEvent("analyzed", { title: input.trim().slice(0, 60) });
        analyzedRef.current = input.trim();
      }
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 200);
    } catch (err) {
      clearInterval(interval);
      const c = classifyApiError(err, !!proxyUrl);
      setError(c.message); setErrorKind(c.kind);
      setPhase("idle");
    }
    setLoading(false);
  };

  const runDemo = () => {
    const text = SAMPLE_JOB_ANALYSIS;
    const s = parseScores(text);
    setResult(text);
    setScores(s);
    setCeiling(parseCeiling(text));
    setCoach(parseCoachSummary(text));
    setScorecard(parseScorecard(text));
    setTier(parseTier(text) || tierFromScores(s.recruiter, s.hm));
    setOdds(parseOdds(text));
    setDecision(parseHiringDecision(text));
    const { strengths: st, transferable: xf, technical: tc, leadership: ld } = parseStrengths(text);
    setStrengths(st || []); setTransferable(xf || []); setTechnical(tc || []); setLeadership(ld || []);
    setRisks(parseRisks(text));
    setImprovements(parseImprovements(text));
    setInterviewRisk(parseInterviewRisk(text));
    setVerdict(parseVerdict(text));
    setConfidence(parseDecisionConfidence(text));
    setIsDemo(true);
    setPhase("done");
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 200);
  };

  const reset = () => {
    savedJobIdRef.current = null;
    analyzedRef.current = "";
    setIsDemo(false); setQuick(null); setRestorable(null); clearDraft();
    setInput(""); setResult(""); setPhase("idle"); setError("");
    setScores({ recruiter: null, hm: null }); setCeiling({ recruiter: null, hm: null }); setCoach(null); setScorecard([]); setTier(null); setOdds(null);
    setDecision(null); setStrengths([]); setTransferable([]); setTechnical([]); setLeadership([]); setRisks([]); setImprovements([]);
    setInterviewRisk([]); setVerdict(null); setConfidence(null); setShowFull(false);
  };

  // ── Object permanence: keep an unrun paste/URL so a session can be resumed ──
  const clearDraft = () => { try { localStorage.removeItem(KEYS.jobDraft); } catch {} };
  // Offer to restore a prior unrun draft on first mount (only when the field is
  // empty, so we never clobber something the user is actively typing).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEYS.jobDraft);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && typeof d.input === "string" && d.input.trim().length >= 15 && !input.trim()) setRestorable(d);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Persist the draft as it's typed — but only before it's been run, so a
  // completed or in-flight analysis doesn't leave a stale "resume" prompt behind.
  useEffect(() => {
    if (phase === "done" || phase === "loading") return;
    try {
      if (input.trim().length >= 15) localStorage.setItem(KEYS.jobDraft, JSON.stringify({ mode, input, ts: Date.now() }));
    } catch {}
  }, [input, mode, phase]);

  const restoreDraft = () => {
    if (!restorable) return;
    if (restorable.mode) setMode(restorable.mode);
    setInput(restorable.input);
    setRestorable(null);
  };
  const dismissDraft = () => { clearDraft(); setRestorable(null); };

  const handleToneChange = (key) => { setTone(key); analyze(key); };

  return (
    <div style={{ maxWidth: "740px", margin: "0 auto", padding: "48px 24px 0" }}>

      {/* Hero — idle state only */}
      {phase === "idle" && (
        <div style={{ marginBottom: "32px" }}>
          <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 14px" }}>
            Hiring Simulation · Resume Active
          </p>
          <h1 style={{ fontFamily: T.display, fontSize: "clamp(28px,5vw,40px)", color: C.text, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em", margin: "0 0 12px" }}>
            Drop a job.<br /><span style={{ color: C.accent }}>Get the truth.</span>
          </h1>
          <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: 0 }}>
            Simulates the internal hiring discussion that determines whether a candidate advances — scores, decision, strengths, risks, improvements, and the questions they'll actually ask.
          </p>
        </div>
      )}

      {/* Cross-analysis strategy note — only when recent checks are all stretches */}
      {phase !== "done" && <StretchPatternCallout jobs={jobs} onOpenJob={onOpenJob} resume={resume} onOpenSetup={onOpenSetup} />}

      {/* Winnable-role targets — aim, don't only get judged. Shown on the empty state. */}
      {phase === "idle" && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "18px 20px", marginBottom: "16px" }}>
          <RoleTargets resume={resume} onOpenSetup={onOpenSetup} />
        </div>
      )}

      {/* Object permanence — offer to restore an unrun draft from a prior visit */}
      {phase !== "done" && restorable && (
        <div style={{ background: "#0E1A13", border: `1px solid ${C.accent}44`, borderRadius: "12px", padding: "14px 18px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>Pick up where you left off?</p>
            <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              You had a {restorable.mode === "url" ? "job link" : "job posting"} here — “{restorable.input.trim().slice(0, 72)}{restorable.input.trim().length > 72 ? "…" : ""}”
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
            <Btn small onClick={restoreDraft}>Restore</Btn>
            <button onClick={dismissDraft} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "6px 12px", color: C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.06em", cursor: "pointer" }}>Dismiss</button>
          </div>
        </div>
      )}

      {/* Input panel */}
      {phase !== "done" && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", overflow: "hidden", marginBottom: "16px" }}>
          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
            {[{ k: "url", label: "⌁  Job URL" }, { k: "paste", label: "≡  Paste Text" }].map(({ k, label }) => (
              <button key={k} onClick={() => { setMode(k); setInput(""); savedJobIdRef.current = null; }} style={{ flex: 1, padding: "14px", background: mode === k ? C.surface2 : "transparent", border: "none", borderBottom: `2px solid ${mode === k ? C.accent : "transparent"}`, color: mode === k ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ padding: "20px" }}>
            {mode === "url"
              ? <Field value={input} onChange={(v) => { savedJobIdRef.current = null; setInput(v); }} placeholder="https://careers.company.com/job/12345" mono />
              : <Field value={input} onChange={(v) => { savedJobIdRef.current = null; setInput(v); }} placeholder="Paste the full job description — title, responsibilities, requirements, everything..." multiline rows={10} />
            }
          </div>
          {error && (() => {
            const setupish = errorKind === "cors" || errorKind === "auth";
            const col = errorKind === "cors" ? C.yellow : C.red;
            const bg  = errorKind === "cors" ? "#1C1808" : "#1D100E";
            return (
              <div style={{ margin: "0 20px 20px", padding: "13px 16px", background: bg, border: `1px solid ${col}44`, borderRadius: "8px" }}>
                <p style={{ fontFamily: T.body, fontSize: "13px", color: setupish ? C.textMid : C.red, margin: 0, lineHeight: 1.6 }}>
                  {errorKind === "cors" ? "🔌 " : "⚠ "}{error}
                </p>
                {setupish && onOpenSetup && (
                  <button className="tap" onClick={onOpenSetup} style={{ marginTop: "10px", background: `${C.accent}14`, border: `1px solid ${C.accent}55`, borderRadius: "8px", padding: "8px 14px", color: C.accent, fontFamily: T.mono, fontSize: "12px", letterSpacing: "0.04em", cursor: "pointer" }}>
                    {errorKind === "cors" ? "Fix it — open one-time setup →" : "Open setup →"}
                  </button>
                )}
              </div>
            );
          })()}
          <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {!localStorage.getItem(KEYS.apiKey)
              ? <button onClick={runDemo} style={{ background: "transparent", border: "none", color: C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.06em", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "3px", padding: 0 }}>No API key yet? View a sample analysis →</button>
              : <span />}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <button onClick={quickAnalyze} disabled={loading || input.trim().length < 10} title="A fast, low-stakes read: is this worth applying to? Full analysis stays one click away." style={{ background: "transparent", border: `1px solid ${loading || input.trim().length < 10 ? C.border : C.accent}66`, borderRadius: "8px", padding: "9px 16px", color: loading || input.trim().length < 10 ? C.textDim : C.accent, fontFamily: T.mono, fontSize: "12px", letterSpacing: "0.04em", cursor: loading || input.trim().length < 10 ? "default" : "pointer", whiteSpace: "nowrap" }}>
                ⚡ Just tell me if it's worth it
              </button>
              <Btn onClick={() => analyze()} disabled={loading || input.trim().length < 10}>
                {loading ? "Analyzing..." : "Full analysis →"}
              </Btn>
            </div>
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

      {/* Quick-check result — compact, low-commitment; full analysis one click away */}
      {phase === "done" && quick && (
        <div ref={resultRef} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <QuickResultView quick={quick} input={input} loading={loading} onRunFull={() => analyze()} onReset={reset} />
        </div>
      )}

      {/* Results */}
      {phase === "done" && result && (
        <div ref={resultRef} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>

          {/* User bubble */}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "18px 18px 4px 18px", padding: "12px 18px", maxWidth: "80%" }}>
              <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.textSub, margin: 0, wordBreak: "break-all", lineHeight: 1.5 }}>
                {input.trim().slice(0, 120)}{input.trim().length > 120 ? "..." : ""}
              </p>
            </div>
          </div>

          {/* ── FOCUSED VIEW ── The gist, the scores, one clear next move. */}

          {/* Coach summary — the plain-language gist, before any scores */}
          <CoachSummary text={coach} />

          {/* Score + Tier — bands and achievable ceiling */}
          <ScoreTierBubble scores={scores} ceiling={ceiling} tier={tier} odds={odds} tone={tone} onToneChange={handleToneChange} isDemo={isDemo} />

          {/* One recommended next action — the highest-impact edit, pre-selected */}
          <NextAction imp={improvements[0]} />

          {/* ── Show-me-everything toggle (persisted default) ── */}
          {(scorecard.length > 0 || decision || strengths.length > 0 || improvements.length > 0 || interviewRisk.length > 0 || verdict || confidence) && (
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <div style={{ width: "28px", flexShrink: 0 }} />
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", padding: "2px 2px 0" }}>
                <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.08em" }}>
                  {showEverything ? "Showing the full report" : "The detail is tucked below — open any card, or:"}
                </span>
                <button onClick={() => setShowEverything(s => !s)} style={{ background: showEverything ? "#0E1A13" : "transparent", border: `1px solid ${showEverything ? C.accent : C.border}`, borderRadius: "20px", padding: "6px 16px", fontFamily: T.mono, fontSize: "11px", color: showEverything ? C.accent : C.textSub, letterSpacing: "0.08em", cursor: "pointer", whiteSpace: "nowrap" }}>
                  {showEverything ? "▲ Focused view" : "▼ Show me everything"}
                </button>
              </div>
            </div>
          )}

          {/* ── COLLAPSED SECTION CARDS ── one section per card, collapsed by default */}

          {scorecard.length > 0 && (
            <SectionCard title="Recruiter reasoning" meta={`${scorecard.length} metrics`} forceOpen={showEverything}>
              <ScorecardBubble scorecard={scorecard} bare />
            </SectionCard>
          )}

          {decision && (
            <SectionCard title="Hiring-manager reasoning" color={C.yellow} forceOpen={showEverything}>
              <HiringDecisionBubble decision={decision} bare />
            </SectionCard>
          )}

          {(strengths.length > 0 || risks.length > 0) && (
            <SectionCard title="Strengths & fastest gains" meta={strengths.length ? `${strengths.length} strengths` : undefined} forceOpen={showEverything}>
              <StrengthsRisksBubble strengths={strengths} transferable={transferable} technical={technical} leadership={leadership} risks={risks} bare />
            </SectionCard>
          )}

          {improvements.length > 0 && (
            <SectionCard title="All improvements" meta={`${improvements.length} edits`} forceOpen={showEverything}>
              <ImprovementsBubble improvements={improvements} jobId={isDemo ? "demo" : (savedJobIdRef.current || "current")} bare />
            </SectionCard>
          )}

          {interviewRisk.length > 0 && (
            <SectionCard title="Interview questions" meta={`${interviewRisk.length} questions`} color={C.blue} forceOpen={showEverything}>
              <InterviewRiskBubble questions={interviewRisk} bare />
            </SectionCard>
          )}

          {(verdict?.bottomLine || verdict?.body) && (
            <SectionCard title="Honest verdict" forceOpen={showEverything}>
              <VerdictBubble verdict={verdict} bare />
            </SectionCard>
          )}

          {confidence?.level && (
            <SectionCard title="Decision confidence" color={C.textSub} forceOpen={showEverything}>
              <DecisionConfidenceBubble confidence={confidence} bare />
            </SectionCard>
          )}

          {/* Full analysis toggle */}
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
            <div style={{ width: "28px", flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <button onClick={() => setShowFull(s => !s)} style={{ width: "100%", background: "transparent", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginBottom: showFull ? "10px" : "0" }}>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textSub, letterSpacing: "0.1em", textTransform: "uppercase" }}>Full Analysis (8 steps)</span>
                <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>{showFull ? "▲ Hide" : "▼ Show"}</span>
              </button>
              {showFull && (
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "28px 32px" }}>
                  <StepAccordion text={result} />
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: "10px", alignItems: "center", paddingLeft: "38px" }}>
            {isDemo ? (
              <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "#1C1808", border: `1px solid ${C.yellow}33`, borderRadius: "20px", padding: "6px 14px" }}>
                <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: C.yellow }} />
                <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.yellow, letterSpacing: "0.1em" }}>Sample — add your API key in Settings to analyze real jobs</span>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "#0E1A13", border: `1px solid ${C.accent}22`, borderRadius: "20px", padding: "6px 14px" }}>
                <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: C.accent }} />
                <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.1em" }}>Saved to Pipeline</span>
              </div>
            )}
            <button onClick={reset} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: "20px", padding: "6px 16px", fontFamily: T.mono, fontSize: "11px", color: C.textDim, cursor: "pointer", letterSpacing: "0.08em" }}>New Analysis</button>
            <button onClick={() => navigator.clipboard?.writeText(result)} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: "20px", padding: "6px 16px", fontFamily: T.mono, fontSize: "11px", color: C.textDim, cursor: "pointer", letterSpacing: "0.08em" }}>Copy</button>
          </div>

        </div>
      )}
    </div>
  );
}

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
    <button onClick={openIt} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "6px 14px", fontFamily: T.mono, fontSize: "11px", color: C.textSub, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", marginBottom: "20px" }}>
      Edit Dates
    </button>
  );

  return (
    <div style={{ background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "10px", padding: "18px", marginBottom: "20px" }}>
      <Label color={C.accent}>Edit Stage Dates</Label>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
        {STATUSES.map(st => (
          <div key={st.key} style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: st.color, letterSpacing: "0.08em", textTransform: "uppercase", width: "110px", flexShrink: 0 }}>{st.label}</span>
            <input type="date" value={draft[st.dateKey] || ""} onChange={e => setDraft(p => ({ ...p, [st.dateKey]: e.target.value }))}
              style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "7px 12px", fontSize: "13px", color: draft[st.dateKey] ? C.text : C.textDim, fontFamily: T.mono, outline: "none", colorScheme: "dark" }} />
            {draft[st.dateKey] && (
              <button onClick={() => setDraft(p => ({ ...p, [st.dateKey]: "" }))} aria-label={`Clear ${st.label} date`} style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontSize: "13px" }}>✕</button>
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

// ─── INFLOW AVATAR ────────────────────────────────────────────────────────────
const InflowAvatar = () => (
  <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: C.surface, border: `1px solid ${C.border2}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "2px" }}>
    <svg width="14" height="14" viewBox="0 0 48 48">
      <path d="M7 35 C16 35 15 23 24 22 C33 21 32 14 38 13" fill="none" stroke={C.accent} strokeWidth="3.5" strokeLinecap="round" opacity="0.45"/>
      <path d="M7 35 C16 35 15 23 24 22" fill="none" stroke={C.accent} strokeWidth="3.5" strokeLinecap="round"/>
      <circle cx="38" cy="13" r="4.5" fill={C.accent}/>
    </svg>
  </div>
);

// ─── COACH SUMMARY ────────────────────────────────────────────────────────────
// The plain-language gist, shown before any scores. Leads with what's working and
// the nearest fix so an anxious reader gets the takeaway without parsing details.
function CoachSummary({ text, compact }) {
  if (!text) return null;
  const inner = (
    <div style={{ background: "#0E1A13", border: `1px solid ${C.accent}44`, borderRadius: compact ? "10px" : "4px 18px 18px 18px", padding: compact ? "12px 16px" : "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <div style={{ width: "3px", height: "12px", background: C.accent, borderRadius: "2px" }} />
        <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.14em", textTransform: "uppercase" }}>The gist</span>
      </div>
      <p style={{ fontFamily: T.body, fontSize: compact ? "14px" : "16px", color: C.text, margin: 0, lineHeight: 1.6 }}>{text}</p>
    </div>
  );
  return compact ? inner : <ResultBubble>{inner}</ResultBubble>;
}

// ─── RESULT BUBBLE WRAPPER ────────────────────────────────────────────────────
const ResultBubble = ({ children, style }) => (
  <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
    <InflowAvatar />
    <div style={{ flex: 1, ...style }}>{children}</div>
  </div>
);

// ─── SCORE CEILING ────────────────────────────────────────────────────────────
// Shows a score as forward motion: current → achievable. A progress bar fills
// solid to the current score, then a lighter "headroom" fill extends to the
// achievable ceiling (green, never a red deficit). Always renders a bar, so a
// score is never shown as a bare number. `ceiling` should already be resolved
// (>= current) or null when there is nothing to project yet.
function ScoreCeiling({ label, current, ceiling, size = "lg" }) {
  const words = useWordsMode();
  const big = size === "lg";
  const hasCeil = ceiling != null && current != null && ceiling > current;
  const curColor = scoreColor(current);
  const curBand = scoreLabel(current);
  const ceilBand = scoreLabel(ceiling);
  const clamp = (v) => Math.max(0, Math.min(10, v));
  const numFont = big ? "34px" : "17px";
  const lift = hasCeil ? Math.round((ceiling - current) * 10) / 10 : 0;
  return (
    <div style={{ flex: 1, minWidth: 0, background: C.surface, border: `1px solid ${C.border}`, borderRadius: big ? "12px" : "10px", padding: big ? "14px 16px" : "8px 11px" }}>
      <p style={{ fontFamily: T.mono, fontSize: big ? "10px" : "8px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: big ? "0 0 6px" : "0 0 5px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</p>

      {words ? (
        // Words mode: the band label replaces the digit entirely.
        <div style={{ marginBottom: big ? "8px" : "6px" }}>
          <span style={{ fontFamily: T.display, fontSize: big ? "17px" : "12px", color: curColor, fontWeight: 700, lineHeight: 1.25 }}>{curBand || "—"}</span>
          {hasCeil && <div style={{ fontFamily: T.body, fontSize: big ? "12px" : "10px", color: C.accent, marginTop: "2px", lineHeight: 1.25 }}>→ {ceilBand}</div>}
        </div>
      ) : (
        // Number mode: the digit(s), with the band words shown alongside below.
        <div style={{ display: "flex", alignItems: "baseline", gap: "5px", marginBottom: big ? "6px" : "5px" }}>
          <span style={{ fontFamily: T.display, fontSize: numFont, color: curColor, fontWeight: 800, lineHeight: 1 }}>{fmtScore(current)}</span>
          {hasCeil && (
            <>
              <span style={{ fontFamily: T.mono, fontSize: big ? "15px" : "11px", color: C.accent, fontWeight: 700, lineHeight: 1 }}>→</span>
              <span style={{ fontFamily: T.display, fontSize: numFont, color: C.accent, fontWeight: 800, lineHeight: 1 }}>{fmtScore(ceiling)}</span>
            </>
          )}
          <span style={{ fontFamily: T.mono, fontSize: big ? "12px" : "9px", color: C.textDim }}>/10</span>
        </div>
      )}

      <div style={{ position: "relative", height: big ? "6px" : "4px", background: C.border2, borderRadius: "3px", overflow: "hidden" }}>
        {hasCeil && <div style={{ position: "absolute", top: 0, left: 0, height: "100%", width: `${clamp(ceiling) * 10}%`, background: `${C.accent}44`, borderRadius: "3px" }} />}
        {current != null && <div style={{ position: "absolute", top: 0, left: 0, height: "100%", width: `${clamp(current) * 10}%`, background: curColor, borderRadius: "3px" }} />}
      </div>

      {!words && curBand && (
        <p style={{ fontFamily: T.body, fontSize: big ? "12px" : "9px", color: curColor, margin: big ? "8px 0 0" : "5px 0 0", lineHeight: 1.3 }}>
          {curBand}{big && hasCeil ? ` · +${fmtScore(lift)} with the edits below` : ""}
        </p>
      )}
    </div>
  );
}

// ─── SCORE + TIER BUBBLE ──────────────────────────────────────────────────────
function ScoreTierBubble({ scores, ceiling, tier, odds, tone, onToneChange, isDemo }) {
  const impactColor = (pct) => pct >= 50 ? C.accent : pct >= 20 ? C.yellow : C.red;
  const rCeil = resolveCeiling(scores.recruiter, null, ceiling?.recruiter);
  const hCeil = resolveCeiling(scores.hm, null, ceiling?.hm);

  const best = Math.max(scores.recruiter ?? -Infinity, scores.hm ?? -Infinity);
  const bandKey = isFinite(best) ? bandFromScore(best) : null;
  const band = bandKey ? FIT_BANDS[bandKey] : null;

  return (
    <ResultBubble>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>

        {/* Fit band — teaches the user to read the landscape (reach / match / safe) */}
        {band && (
          <div style={{ background: `${band.color}12`, border: `1px solid ${band.color}33`, borderRadius: "12px", padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.mono, fontSize: "11px", color: band.color, background: `${band.color}1E`, border: `1px solid ${band.color}55`, borderRadius: "6px", padding: "4px 12px", letterSpacing: "0.08em", fontWeight: 700 }}>{band.label.toUpperCase()}</span>
              <span style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid }}>This role is {band.blurb}.</span>
            </div>
            <p style={{ fontFamily: T.body, fontSize: "12px", color: C.textSub, margin: "8px 0 0", lineHeight: 1.6 }}>
              {bandKey === "reach"
                ? "Aim for ~2 matches for every stretch — matches get you interviews and momentum; stretches are the upside."
                : "Keep a healthy mix: matches build momentum, and a reach or two are the upside worth taking."}
            </p>
          </div>
        )}

        {/* Scores row — current → achievable ceiling */}
        <div style={{ display: "flex", gap: "10px" }}>
          <ScoreCeiling label="Recruiter Confidence" current={scores.recruiter} ceiling={rCeil} />
          <ScoreCeiling label="Hiring Mgr Score" current={scores.hm} ceiling={hCeil} />
          <ScoreCeiling label="Transferability" current={scores.transferability} ceiling={null} />
        </div>

        {/* Tier + interview probability */}
        {(tier || odds?.probability) && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
            {tier && (
              <div>
                <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 8px" }}>Overall Recommendation</p>
                <TierBadge tier={tier} />
              </div>
            )}
            {odds?.probability != null && (
              <div style={{ textAlign: "right" }}>
                <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>Interview Probability</p>
                <span style={{ fontFamily: T.display, fontSize: "32px", color: impactColor(odds.probability), fontWeight: 800, lineHeight: 1 }}>{odds.probability}<span style={{ fontSize: "16px", color: C.textDim, fontWeight: 400 }}>%</span></span>
              </div>
            )}
          </div>
        )}

        {/* Evaluation lens — re-runs the analysis, so only show it for real
            (non-demo) results where an API key is present. */}
        {!isDemo && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.1em" }}>LENS</span>
            {Object.entries(TONE_CONFIG).map(([key, cfg]) => (
              <button key={key} onClick={() => onToneChange(key)} title={cfg.desc} style={{ padding: "5px 14px", borderRadius: "20px", border: `1px solid ${tone === key ? C.accent : C.border}`, background: tone === key ? "#0E1A13" : "transparent", color: tone === key ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
                <span>{cfg.icon}</span> {cfg.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </ResultBubble>
  );
}

// ─── FULL SCORECARD BUBBLE ────────────────────────────────────────────────────
function ScorecardBubble({ scorecard, bare }) {
  const [open, setOpen] = useState(false);
  const words = useWordsMode();
  if (!scorecard?.length) return null;
  const isOpen = bare ? true : open;
  const inner = (
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "4px 18px 18px 18px", overflow: "hidden" }}>
        {!bare && (
        <button onClick={() => setOpen(o => !o)} style={{ width: "100%", padding: "14px 18px", background: "transparent", border: "none", borderBottom: open ? `1px solid ${C.border}` : "none", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "3px", height: "12px", background: C.accent, borderRadius: "2px" }} />
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>Full Scorecard</span>
            <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim }}>{scorecard.length} metrics</span>
          </div>
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>{open ? "▲ Hide" : "▼ Show"}</span>
        </button>
        )}
        {isOpen && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {scorecard.map((m, i) => (
              <div key={i} style={{ padding: "12px 18px", borderBottom: i < scorecard.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "6px" }}>
                  <span style={{ fontFamily: T.body, fontSize: "13px", color: C.text, fontWeight: 600 }}>{m.name}</span>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
                    {words ? (
                      <span style={{ fontFamily: T.display, fontSize: "13px", color: scoreColor(m.score), fontWeight: 700, lineHeight: 1.2 }}>{scoreLabel(m.score)}</span>
                    ) : (
                      <>
                        <div style={{ display: "flex", alignItems: "baseline", gap: "3px" }}>
                          <span style={{ fontFamily: T.display, fontSize: "18px", color: scoreColor(m.score), fontWeight: 800, lineHeight: 1 }}>{m.score}</span>
                          <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim }}>/10</span>
                        </div>
                        <span style={{ fontFamily: T.body, fontSize: "9px", color: scoreColor(m.score), lineHeight: 1.2, marginTop: "2px", whiteSpace: "nowrap" }}>{scoreLabel(m.score)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ height: "3px", background: C.border2, borderRadius: "2px", marginBottom: "7px" }}>
                  <div style={{ height: "100%", width: `${Math.max(0, Math.min(10, m.score)) * 10}%`, background: scoreColor(m.score), borderRadius: "2px" }} />
                </div>
                {m.reason && <p style={{ fontFamily: T.body, fontSize: "12px", color: C.textSub, margin: 0, lineHeight: 1.55 }}>{m.reason}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
  );
  return bare ? inner : <ResultBubble>{inner}</ResultBubble>;
}

// ─── HIRING DECISION BUBBLE ───────────────────────────────────────────────────
function HiringDecisionBubble({ decision, bare }) {
  if (!decision) return null;
  const { verdict, reasoning, concern, selling, smallest, doNotChange } = decision;

  const verdictStyle = verdict === "Yes"
    ? { color: C.accent, bg: "#0E1A13", border: C.accent }
    : verdict === "No"
    ? { color: C.red, bg: "#1D100E", border: C.red }
    : { color: C.yellow, bg: "#1C1808", border: C.yellow };

  const inner = (
      <div style={{ background: C.surface, border: `1px solid ${verdictStyle.color}44`, borderRadius: "4px 18px 18px 18px", overflow: "hidden", boxShadow: `0 0 32px ${verdictStyle.color}14` }}>
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: "10px", background: verdictStyle.bg }}>
          <div style={{ width: "3px", height: "14px", background: verdictStyle.color, borderRadius: "2px", flexShrink: 0 }} />
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: verdictStyle.color, letterSpacing: "0.12em", textTransform: "uppercase" }}>Hiring Decision</span>
          {verdict && (
            <span style={{ marginLeft: "auto", background: C.bg, border: `1px solid ${verdictStyle.border}66`, borderRadius: "6px", padding: "4px 12px", fontFamily: T.mono, fontSize: "12px", color: verdictStyle.color, fontWeight: 700, letterSpacing: "0.08em", boxShadow: `0 0 14px ${verdictStyle.color}33` }}>
              {verdict === "Conditional" ? "Conditional ▸" : verdict === "Yes" ? "Interview ✓" : "Pass ✗"}
            </span>
          )}
        </div>

        {/* Reasoning */}
        {reasoning && (
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
            <p style={{ fontFamily: T.body, fontSize: "14px", color: C.textMid, margin: 0, lineHeight: 1.8 }}>{reasoning}</p>
          </div>
        )}

        {/* Key signals */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
          {concern && (
            <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: "12px", alignItems: "flex-start" }}>
              <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.red, letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0, paddingTop: "2px", width: "90px" }}>Biggest Risk</span>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.65 }}>{concern}</p>
            </div>
          )}
          {selling && (
            <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: "12px", alignItems: "flex-start" }}>
              <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0, paddingTop: "2px", width: "90px" }}>Best Signal</span>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.65 }}>{selling}</p>
            </div>
          )}
          {smallest && (
            <div style={{ padding: "12px 18px", borderBottom: doNotChange ? `1px solid ${C.border}` : "none", display: "flex", gap: "12px", alignItems: "flex-start" }}>
              <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.yellow, letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0, paddingTop: "2px", width: "90px" }}>Quick Win</span>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.65 }}>{smallest}</p>
            </div>
          )}
          {doNotChange && (
            <div style={{ padding: "12px 18px", display: "flex", gap: "12px", alignItems: "flex-start" }}>
              <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.mint, letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0, paddingTop: "2px", width: "90px" }}>Keep As-Is</span>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.65 }}>{doNotChange}</p>
            </div>
          )}
        </div>
      </div>
  );
  return bare ? inner : <ResultBubble>{inner}</ResultBubble>;
}

// ─── STRENGTHS + RISKS BUBBLE ─────────────────────────────────────────────────
function StrengthsRisksBubble({ strengths, transferable, technical, leadership, risks, bare }) {
  const allStrengths = strengths || [];
  const allTransferable = transferable || [];
  const techList = technical || [];
  const leadList = leadership || [];
  const hasTransferable = allTransferable.length > 0;
  const tabs = [
    { key: "strengths",    label: "Strengths",    color: C.accent },
    ...(hasTransferable ? [{ key: "transferable", label: "Transferable", color: C.blue }] : []),
    { key: "risks",        label: "Fastest ways to move up", color: C.orange },
  ];
  const [tab, setTab] = useState("strengths");
  if (!allStrengths.length && !risks?.length) return null;

  const likelihoodColor = (l) => l === "High" ? C.red : l === "Medium" ? C.yellow : C.mint;

  const inner = (
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "4px 18px 18px 18px", overflow: "hidden" }}>
        {/* Tab header */}
        <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
          {tabs.map(({ key, label, color }) => (
            <button key={key} onClick={() => setTab(key)} style={{ flex: 1, padding: "13px 18px", background: "transparent", border: "none", borderBottom: `2px solid ${tab === key ? color : "transparent"}`, color: tab === key ? color : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>
              {label}
            </button>
          ))}
        </div>

        {/* Strengths */}
        {tab === "strengths" && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {allStrengths.map((s, i) => (
              <div key={i} style={{ padding: "16px 20px", borderBottom: i < allStrengths.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                  <div style={{ width: "3px", height: "12px", background: C.accent, borderRadius: "2px" }} />
                  <p style={{ fontFamily: T.display, fontSize: "14px", color: C.text, margin: 0, fontWeight: 700 }}>{s.name}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {s.recruiter && (
                    <div style={{ background: C.surface2, borderRadius: "6px", padding: "10px 14px" }}>
                      <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.1em", margin: "0 0 4px" }}>RECRUITER READS</p>
                      <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.65 }}>{s.recruiter}</p>
                    </div>
                  )}
                  {s.hm && (
                    <div style={{ background: C.surface2, borderRadius: "6px", padding: "10px 14px" }}>
                      <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.yellow, letterSpacing: "0.1em", margin: "0 0 4px" }}>HM READS</p>
                      <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.65 }}>{s.hm}</p>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {(techList.length > 0 || leadList.length > 0) && (
              <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: "12px" }}>
                {techList.length > 0 && (
                  <div>
                    <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.blue, letterSpacing: "0.1em", margin: "0 0 7px" }}>TECHNICAL STRENGTHS</p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {techList.map((t, i) => <span key={i} style={{ fontFamily: T.mono, fontSize: "11px", color: C.blue, background: `${C.blue}12`, border: `1px solid ${C.blue}33`, borderRadius: "5px", padding: "3px 9px" }}>{t}</span>)}
                    </div>
                  </div>
                )}
                {leadList.length > 0 && (
                  <div>
                    <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.mint, letterSpacing: "0.1em", margin: "0 0 7px" }}>LEADERSHIP STRENGTHS</p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {leadList.map((t, i) => <span key={i} style={{ fontFamily: T.mono, fontSize: "11px", color: C.mint, background: `${C.mint}12`, border: `1px solid ${C.mint}33`, borderRadius: "5px", padding: "3px 9px" }}>{t}</span>)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Transferable experience */}
        {tab === "transferable" && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {allTransferable.length === 0 ? (
              <div style={{ padding: "20px", textAlign: "center" }}>
                <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, margin: 0 }}>No directly transferable experience identified for this role.</p>
              </div>
            ) : allTransferable.map((t, i) => (
              <div key={i} style={{ padding: "16px 20px", borderBottom: i < allTransferable.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                  <div style={{ width: "3px", height: "12px", background: C.blue, borderRadius: "2px" }} />
                  <p style={{ fontFamily: T.display, fontSize: "14px", color: C.text, margin: 0, fontWeight: 700 }}>{t.name}</p>
                </div>
                {t.how && (
                  <div style={{ background: C.surface2, borderRadius: "6px", padding: "10px 14px" }}>
                    <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.blue, letterSpacing: "0.1em", margin: "0 0 4px" }}>HOW IT TRANSFERS</p>
                    <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.65 }}>{t.how}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Risks */}
        {tab === "risks" && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {[...(risks || [])]
              .sort((a, b) => {
                const order = { "critical gap": 0, "learnable": 1, "transferable": 2, "already demonstrated": 3 };
                return (order[a.teachability?.toLowerCase()] ?? 4) - (order[b.teachability?.toLowerCase()] ?? 4);
              })
              .map((r, i, arr) => (
              <div key={i} style={{ padding: "16px 20px", borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <div style={{ width: "3px", height: "12px", background: C.orange, borderRadius: "2px" }} />
                    <p style={{ fontFamily: T.display, fontSize: "14px", color: C.text, margin: 0, fontWeight: 700 }}>{r.name}</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {r.effort && (
                      <span title="Rough time to act on this" style={{ fontFamily: T.mono, fontSize: "10px", color: C.textSub, background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "4px", padding: "3px 8px", whiteSpace: "nowrap" }}>{r.effort}</span>
                    )}
                    {r.teachability && (() => {
                      const key = r.teachability.toLowerCase();
                      const tc = { "already demonstrated": C.accent, "transferable": C.blue, "learnable": C.yellow, "critical gap": C.orange }[key] || C.textSub;
                      // Display-only relabel so the banned word "gap" never reaches the candidate.
                      const label = { "already demonstrated": "ALREADY THERE", "transferable": "TRANSFERABLE", "learnable": "LEARNABLE", "critical gap": "BIGGER LIFT" }[key] || r.teachability.toUpperCase();
                      return (
                        <span style={{ fontFamily: T.mono, fontSize: "10px", color: tc, background: `${tc}15`, border: `1px solid ${tc}33`, borderRadius: "4px", padding: "3px 8px", letterSpacing: "0.06em" }}>
                          {label}
                        </span>
                      );
                    })()}
                    {r.likelihood && (
                      <span style={{ fontFamily: T.mono, fontSize: "10px", color: likelihoodColor(r.likelihood), background: `${likelihoodColor(r.likelihood)}15`, border: `1px solid ${likelihoodColor(r.likelihood)}33`, borderRadius: "4px", padding: "3px 8px", letterSpacing: "0.08em" }}>
                        {r.likelihood.toUpperCase()} IMPACT
                      </span>
                    )}
                  </div>
                </div>
                {r.why && <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: "0 0 8px", lineHeight: 1.65, paddingLeft: "11px" }}>{r.why}</p>}
                {r.mitigation && (
                  <div style={{ paddingLeft: "11px" }}>
                    <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.mint, letterSpacing: "0.1em", margin: "0 0 3px" }}>THE MOVE</p>
                    <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: 0, lineHeight: 1.6 }}>{r.mitigation}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
  );
  return bare ? inner : <ResultBubble>{inner}</ResultBubble>;
}

// ─── RESUME IMPROVEMENTS BUBBLE ───────────────────────────────────────────────
// Single checklist row: checkbox + the edit, an effort tag, expandable detail,
// and a brief affirmation when it flips to done.
function EditItem({ imp, checked, affirm, onToggle }) {
  const [open, setOpen] = useState(false);
  const editText = imp.improved || imp.current || imp.issue || imp.problem || "This edit";
  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, background: checked ? "#0C1410" : "transparent", transition: "background 0.2s" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "2px", padding: "13px 18px" }}>
        {/* Checkbox — 44px tap target wraps the 22px visual box so the hit area
            meets WCAG without changing the box's appearance. Negative top/bottom/
            left margins collapse the padded footprint back to the box's old spot;
            the button's right half supplies the gap to the text. */}
        <button
          onClick={onToggle}
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? "Mark edit not done" : "Mark edit done"}
          style={{ flexShrink: 0, width: "44px", height: "44px", margin: "-11px 0 -11px -11px", background: "transparent", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ width: "22px", height: "22px", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", background: checked ? C.accent : "transparent", border: `1.5px solid ${checked ? C.accent : C.border2}`, transition: "background 0.15s, border-color 0.15s" }}>
            {checked && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ animation: "checkPop 0.28s ease" }}>
                <path d="M5 12.5l4.5 4.5L19 7" stroke="#04120A" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
        </button>

        {/* Edit text + effort + expand */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px" }}>
            <button onClick={() => setOpen(o => !o)} aria-expanded={open} style={{ flex: 1, textAlign: "left", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}>
              <span style={{ fontFamily: T.body, fontSize: "14px", color: checked ? C.textDim : C.textMid, lineHeight: 1.55, textDecoration: checked ? "line-through" : "none", display: "block" }}>{editText}</span>
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
              <span title="Rough time to make this edit" style={{ fontFamily: T.mono, fontSize: "10px", color: C.textSub, background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "4px", padding: "2px 7px", whiteSpace: "nowrap" }}>{imp.effort || "~10 min"}</span>
              <button onClick={() => setOpen(o => !o)} aria-label={open ? "Hide detail" : "Show detail"} style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: "11px", padding: "0 2px" }}>{open ? "▲" : "▼"}</button>
            </div>
          </div>

          {affirm && (
            <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, margin: "6px 0 0", letterSpacing: "0.04em", animation: "affirmIn 1.8s ease forwards" }}>✓ {affirm}</p>
          )}

          {open && (
            <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
              {imp.current && (
                <div style={{ background: "#150a0a", border: `1px solid ${C.red}22`, borderRadius: "6px", padding: "8px 12px" }}>
                  <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.red, letterSpacing: "0.1em", margin: "0 0 3px", opacity: 0.8 }}>CURRENT</p>
                  <p style={{ fontFamily: T.body, fontSize: "13px", color: "#FCA5A5", margin: 0, lineHeight: 1.6 }}>{imp.current}</p>
                </div>
              )}
              {(imp.problem || imp.issue) && (
                <div style={{ background: "#1a1400", border: `1px solid ${C.yellow}22`, borderRadius: "6px", padding: "8px 12px" }}>
                  <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.yellow, letterSpacing: "0.1em", margin: "0 0 3px", opacity: 0.8 }}>ISSUE</p>
                  <p style={{ fontFamily: T.body, fontSize: "13px", color: C.yellow, margin: 0, lineHeight: 1.55, opacity: 0.9 }}>{imp.problem || imp.issue}</p>
                </div>
              )}
              {imp.improved && (
                <div style={{ background: "#0a150a", border: `1px solid ${C.accent}22`, borderRadius: "6px", padding: "8px 12px" }}>
                  <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.accent, letterSpacing: "0.1em", margin: "0 0 3px", opacity: 0.8 }}>IMPROVED</p>
                  <p style={{ fontFamily: T.body, fontSize: "13px", color: C.mint, margin: 0, lineHeight: 1.6 }}>{imp.improved}</p>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
                <p style={{ fontFamily: T.body, fontSize: "12px", color: C.textDim, margin: 0, lineHeight: 1.55, fontStyle: "italic", flex: 1 }}>↳ {imp.why || "Stronger signal for this specific role"}</p>
                {imp.improved && <button onClick={() => navigator.clipboard?.writeText(imp.improved)} style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "5px 12px", fontFamily: T.mono, fontSize: "11px", color: C.accent, cursor: "pointer", letterSpacing: "0.08em", flexShrink: 0 }}>Copy ↗</button>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ImprovementsBubble({ improvements, jobId, bare }) {
  const [done, setDone] = useState(() => loadEditsDone(jobId));
  const [justDid, setJustDid] = useState(null); // { key, msg }
  // Reload the saved checklist when the job (a new analysis) changes.
  useEffect(() => { setDone(loadEditsDone(jobId)); setJustDid(null); }, [jobId]);
  // Auto-clear the affirmation after it plays.
  useEffect(() => {
    if (!justDid) return;
    const t = setTimeout(() => setJustDid(null), 1800);
    return () => clearTimeout(t);
  }, [justDid]);

  if (!improvements?.length) return null;

  const total = improvements.length;
  const completed = improvements.filter(imp => done[editKey(imp)]).length;
  const allDone = completed === total;

  const toggle = (imp) => {
    const k = editKey(imp);
    setDone(prev => {
      const next = { ...prev, [k]: !prev[k] };
      if (!next[k]) delete next[k];
      saveEditsDone(jobId, next);
      // Affirm only when checking on (not when unchecking).
      if (next[k]) setJustDid({ key: k, msg: EDIT_AFFIRMATIONS[Math.min(completed, EDIT_AFFIRMATIONS.length - 1)] });
      return next;
    });
  };

  const inner = (
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "4px 18px 18px 18px", overflow: "hidden" }}>
        {/* Header + progress */}
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "3px", height: "12px", background: C.accent, borderRadius: "2px" }} />
              <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>Resume Improvements</span>
            </div>
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: allDone ? C.accent : C.textDim, whiteSpace: "nowrap" }}>{completed} of {total} edits done</span>
          </div>
          <div style={{ height: "5px", background: C.border2, borderRadius: "3px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(completed / total) * 100}%`, background: C.accent, borderRadius: "3px", transition: "width 0.35s ease" }} />
          </div>
          {allDone && (
            <p style={{ fontFamily: T.body, fontSize: "12px", color: C.accent, margin: "9px 0 0", lineHeight: 1.5 }}>All {total} done — save your updated resume and re-score to see your new ceiling.</p>
          )}
        </div>

        {/* Checklist */}
        <div>
          {improvements.map((imp) => {
            const k = editKey(imp);
            return (
              <EditItem
                key={k}
                imp={imp}
                checked={!!done[k]}
                affirm={justDid?.key === k ? justDid.msg : null}
                onToggle={() => toggle(imp)}
              />
            );
          })}
        </div>
      </div>
  );
  return bare ? inner : <ResultBubble>{inner}</ResultBubble>;
}

// ─── INTERVIEW RISK BUBBLE ────────────────────────────────────────────────────
function InterviewRiskBubble({ questions, bare }) {
  const [open, setOpen] = useState(0);
  if (!questions?.length) return null;

  const inner = (
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "4px 18px 18px 18px", overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ width: "3px", height: "12px", background: C.blue, borderRadius: "2px" }} />
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.blue, letterSpacing: "0.12em", textTransform: "uppercase" }}>Interview Risk — Questions They'll Ask</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {questions.map((q, i) => {
            const isOpen = open === i;
            return (
              <div key={i} style={{ borderBottom: i < questions.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <button onClick={() => setOpen(isOpen ? -1 : i)} style={{ width: "100%", padding: "14px 18px", background: "transparent", border: "none", display: "flex", alignItems: "flex-start", justifyContent: "space-between", cursor: "pointer", gap: "12px", textAlign: "left" }}>
                  <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                    <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.blue, letterSpacing: "0.1em", flexShrink: 0, paddingTop: "3px" }}>Q{i + 1}</span>
                    <p style={{ fontFamily: T.body, fontSize: "14px", color: isOpen ? C.text : C.textMid, margin: 0, lineHeight: 1.6, fontWeight: isOpen ? 500 : 400 }}>{q.question}</p>
                  </div>
                  <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, flexShrink: 0 }}>{isOpen ? "▲" : "▼"}</span>
                </button>
                {isOpen && q.coaching && (
                  <div style={{ padding: "0 18px 16px 18px", paddingLeft: "37px" }}>
                    <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "12px 16px" }}>
                      <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.mint, letterSpacing: "0.1em", margin: "0 0 6px" }}>COACHING</p>
                      <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.75 }}>{q.coaching}</p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
  );
  return bare ? inner : <ResultBubble>{inner}</ResultBubble>;
}

// ─── VERDICT BUBBLE ───────────────────────────────────────────────────────────
function VerdictBubble({ verdict, bare }) {
  if (!verdict?.bottomLine && !verdict?.body) return null;
  const inner = (
      <div style={{ background: "#0E1A13", border: `1px solid ${C.accent}33`, borderRadius: "4px 18px 18px 18px", padding: "18px 20px" }}>
        {verdict.body && (
          <p style={{ fontFamily: T.body, fontSize: "14px", color: C.textMid, margin: "0 0 12px", lineHeight: 1.8 }}>{verdict.body}</p>
        )}
        {verdict.bottomLine && (
          <p style={{ fontFamily: T.body, fontSize: "15px", color: C.text, margin: 0, lineHeight: 1.75 }}>
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.1em", marginRight: "8px" }}>BOTTOM LINE</span>
            {verdict.bottomLine}
          </p>
        )}
      </div>
  );
  return bare ? inner : <ResultBubble>{inner}</ResultBubble>;
}

// ─── DECISION CONFIDENCE BUBBLE ───────────────────────────────────────────────
function DecisionConfidenceBubble({ confidence, bare }) {
  if (!confidence?.level) return null;
  const colors = { High: C.accent, Medium: C.yellow, Low: C.red };
  const bgs    = { High: "#0E1A13", Medium: "#1C1808", Low: "#1D100E" };
  const col = colors[confidence.level] || C.textDim;
  const bg  = bgs[confidence.level]   || C.surface;
  const inner = (
      <div style={{ background: bg, border: `1px solid ${col}33`, borderRadius: "4px 18px 18px 18px", padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: confidence.reason ? "12px" : 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.1em" }}>DECISION CONFIDENCE</span>
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: col, background: `${col}18`, border: `1px solid ${col}44`, borderRadius: "4px", padding: "3px 10px", letterSpacing: "0.08em" }}>{confidence.level.toUpperCase()}</span>
        </div>
        {confidence.reason && (
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.7 }}>{confidence.reason}</p>
        )}
      </div>
  );
  return bare ? inner : <ResultBubble>{inner}</ResultBubble>;
}

// ─── RECOMMENDED NEXT ACTION ──────────────────────────────────────────────────
// The focused view's single call-to-action: the highest-ROI edit (improvements[0]),
// shown expanded and highlighted so the anxious reader has exactly one clear move.
function NextAction({ imp }) {
  if (!imp) return null;
  const editText = imp.improved || imp.current || imp.issue || imp.problem || "This edit";
  return (
    <ResultBubble>
      <div style={{ background: "#0E1A13", border: `1px solid ${C.accent}55`, borderRadius: "4px 18px 18px 18px", overflow: "hidden", boxShadow: `0 0 32px ${C.accent}18` }}>
        <div style={{ padding: "13px 18px", borderBottom: `1px solid ${C.accent}22`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "3px", height: "13px", background: C.accent, borderRadius: "2px" }} />
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>Start Here — Your Highest-Impact Edit</span>
          </div>
          <span title="Rough time to make this edit" style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, background: `${C.accent}14`, border: `1px solid ${C.accent}33`, borderRadius: "4px", padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0 }}>{imp.effort || "~10 min"}</span>
        </div>
        <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: "9px" }}>
          <p style={{ fontFamily: T.body, fontSize: "15px", color: C.text, margin: 0, lineHeight: 1.6, fontWeight: 500 }}>{editText}</p>
          {imp.current && (
            <div style={{ background: "#150a0a", border: `1px solid ${C.red}22`, borderRadius: "6px", padding: "8px 12px" }}>
              <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.red, letterSpacing: "0.1em", margin: "0 0 3px", opacity: 0.8 }}>CURRENT</p>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: "#FCA5A5", margin: 0, lineHeight: 1.6 }}>{imp.current}</p>
            </div>
          )}
          {imp.improved && (
            <div style={{ background: "#0a150a", border: `1px solid ${C.accent}22`, borderRadius: "6px", padding: "8px 12px" }}>
              <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.accent, letterSpacing: "0.1em", margin: "0 0 3px", opacity: 0.8 }}>IMPROVED</p>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.mint, margin: 0, lineHeight: 1.6 }}>{imp.improved}</p>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
            <p style={{ fontFamily: T.body, fontSize: "12px", color: C.textDim, margin: 0, lineHeight: 1.55, fontStyle: "italic", flex: 1 }}>↳ {imp.why || "Stronger signal for this specific role"}</p>
            {imp.improved && <button onClick={() => navigator.clipboard?.writeText(imp.improved)} style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "5px 12px", fontFamily: T.mono, fontSize: "11px", color: C.accent, cursor: "pointer", letterSpacing: "0.08em", flexShrink: 0 }}>Copy ↗</button>}
          </div>
        </div>
      </div>
    </ResultBubble>
  );
}

// ─── SECTION CARD ─────────────────────────────────────────────────────────────
// A single collapsible section in the results feed. Collapsed by default in the
// focused view; `forceOpen` (driven by "Show me everything") expands it. Wraps a
// `bare` bubble so the section header owns the collapse, not the bubble.
function SectionCard({ title, meta, color = C.accent, forceOpen, children }) {
  const [open, setOpen] = useState(false);
  const isOpen = forceOpen || open;
  return (
    <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
      <div style={{ width: "28px", flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <button onClick={() => setOpen(o => !o)} style={{ width: "100%", background: "transparent", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginBottom: isOpen ? "10px" : "0" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
            <span style={{ width: "3px", height: "12px", background: color, borderRadius: "2px", flexShrink: 0 }} />
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: color, letterSpacing: "0.1em", textTransform: "uppercase" }}>{title}</span>
            {meta && <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim }}>{meta}</span>}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, flexShrink: 0 }}>{isOpen ? "▲ Hide" : "▼ Show"}</span>
        </button>
        {isOpen && children}
      </div>
    </div>
  );
}

// ─── EDIT JOB MODAL ───────────────────────────────────────────────────────────
function EditJobModal({ job, onSave, onClose }) {
  const { logEvent } = useEvents();
  const [draft, setDraft] = useState({
    title:   job.title   || "",
    company: job.company || "",
    url:     job.url     || "",
    notes:   job.notes   || "",
    status:  job.status  || "saved",
    location:       job.location       || "",
    workModel:      job.workModel      || "",
    employmentType: job.employmentType || "",
    seniority:      job.seniority      || "",
    salary:         job.salary         || "",
    team:           job.team           || "",
  });
  const [rerunning, setRerunning]   = useState(false);
  const [rerunError, setRerunError] = useState("");
  const [rerunStatus, setRerunStatus] = useState("");

  const save = () => {
    if (!draft.title.trim()) return;
    onSave({ ...job, ...draft, ...stampDate(job, draft.status) });
  };

  const rerunAnalysis = async () => {
    const apiKey   = localStorage.getItem(KEYS.apiKey);
    const proxyUrl = localStorage.getItem(KEYS.proxyUrl);
    const resume   = localStorage.getItem(KEYS.resume);
    const targetUrl = draft.url || job.url;
    if (!apiKey)  { setRerunError("No API key. Go to Settings."); return; }
    if (!resume)  { setRerunError("No resume found."); return; }
    if (!targetUrl && !job.analysis) { setRerunError("No URL to re-analyze."); return; }

    setRerunning(true); setRerunError(""); setRerunStatus("Fetching job posting...");
    try {
      const userMsg = targetUrl
        ? `Fetch and analyze this job posting URL: ${targetUrl}`
        : `Re-analyze this job based on the original analysis context:\n\n${job.analysis?.slice(0, 1000)}`;

      const body = {
        model: MODEL, max_tokens: 6000,
        system: ANALYSIS_PROMPT(resume, "recruiter"),
        messages: [{ role: "user", content: userMsg }],
      };
      if (targetUrl) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];

      const endpoint = proxyUrl ? proxyUrl.replace(/\/$/, "") : "https://api.anthropic.com/v1/messages";
      const headers  = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
      if (!proxyUrl) headers["anthropic-dangerous-allow-browser"] = "true";

      setRerunStatus("Analyzing...");
      const res  = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const text   = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
      const parsed = parseScores(text);
      // A re-run that lifts the recruiter score is effort that paid off — count it.
      if (parsed.recruiter != null && job.recruiterScore != null && parsed.recruiter > job.recruiterScore) {
        logEvent("improved", { job: job.id, r: parsed.recruiter });
      }
      const tier   = parseTier(text) || tierFromScores(parsed.recruiter, parsed.hm);
      const meta   = parseJobMeta(text);
      const odds   = parseOdds(text);
      const dec    = parseHiringDecision(text);
      const conf   = parseDecisionConfidence(text);

      // Heal placeholder titles/companies from older analyses, but never
      // overwrite a name the user typed in themselves.
      const isPlaceholderTitle = !draft.title?.trim() || draft.title === "Untitled Role";
      const isPlaceholderComp  = !draft.company?.trim() || draft.company === "Unknown Company";

      onSave({
        ...job, ...draft, analysis: text,
        title:   isPlaceholderTitle && meta.title   ? meta.title   : draft.title,
        company: isPlaceholderComp  && meta.company ? meta.company : draft.company,
        recruiterScore: parsed.recruiter ?? job.recruiterScore,
        hmScore: parsed.hm ?? job.hmScore,
        tier: tier?.label || job.tier,
        // Refresh captured listing fields (fall back to existing values).
        location:        meta.location        ?? job.location,
        workModel:       meta.workModel        ?? job.workModel,
        employmentType:  meta.employmentType   ?? job.employmentType,
        seniority:       meta.seniority        ?? job.seniority,
        salary:          meta.salary           ?? job.salary,
        team:            meta.team             ?? job.team,
        keyRequirements: meta.keyRequirements  ?? job.keyRequirements,
        atsAlignment:        odds?.ats          ?? job.atsAlignment,
        interviewProbability:odds?.probability  ?? job.interviewProbability,
        hiringVerdict:       dec?.verdict       ?? job.hiringVerdict,
        decisionConfidence:  conf?.level        ?? job.decisionConfidence,
      });
    } catch (err) {
      setRerunError(classifyApiError(err, !!proxyUrl).message || "Re-analysis failed.");
    } finally {
      setRerunning(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000ee", backdropFilter: "blur(12px)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "16px", width: "100%", maxWidth: "520px", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ padding: "22px 28px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Label color={C.accent}>Edit Job</Label>
          <button className="tap" onClick={onClose} aria-label="Close dialog" style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: "16px", lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ padding: "16px 28px 28px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <div><Label>Job Title</Label><Field value={draft.title} onChange={v => setDraft(p => ({ ...p, title: v }))} placeholder="Job Title *" /></div>
          <div><Label>Company</Label><Field value={draft.company} onChange={v => setDraft(p => ({ ...p, company: v }))} placeholder="Company" /></div>
          <div><Label>Job URL</Label><Field value={draft.url} onChange={v => setDraft(p => ({ ...p, url: v }))} placeholder="https://..." mono /></div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div><Label>Location</Label><Field value={draft.location} onChange={v => setDraft(p => ({ ...p, location: v }))} placeholder="City / Remote" /></div>
            <div><Label>Work Model</Label><Field value={draft.workModel} onChange={v => setDraft(p => ({ ...p, workModel: v }))} placeholder="Remote / Hybrid / On-site" /></div>
            <div><Label>Employment Type</Label><Field value={draft.employmentType} onChange={v => setDraft(p => ({ ...p, employmentType: v }))} placeholder="Full-time / Contract" /></div>
            <div><Label>Seniority</Label><Field value={draft.seniority} onChange={v => setDraft(p => ({ ...p, seniority: v }))} placeholder="Mid / Senior / Lead" /></div>
            <div><Label>Salary</Label><Field value={draft.salary} onChange={v => setDraft(p => ({ ...p, salary: v }))} placeholder="$120k–$150k" /></div>
            <div><Label>Team</Label><Field value={draft.team} onChange={v => setDraft(p => ({ ...p, team: v }))} placeholder="Team / Dept" /></div>
          </div>

          <div>
            <Label>Status</Label>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {STATUSES.map(s => (
                <button key={s.key} onClick={() => setDraft(p => ({ ...p, status: s.key }))} style={{ padding: "6px 14px", borderRadius: "18px", border: `1px solid ${draft.status === s.key ? s.color : C.border}`, background: draft.status === s.key ? s.bg : "transparent", color: draft.status === s.key ? s.color : C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer" }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div><Label>Notes</Label><Field value={draft.notes} onChange={v => setDraft(p => ({ ...p, notes: v }))} placeholder="Notes..." multiline rows={4} /></div>

          {/* Re-run */}
          <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: rerunError ? "10px" : "0" }}>
              <div>
                <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>Re-run Analysis</p>
                <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, margin: 0, lineHeight: 1.5 }}>{rerunning ? rerunStatus : "Fetch fresh scores and analysis using the current URL and your base resume."}</p>
              </div>
              <Btn small onClick={rerunAnalysis} disabled={rerunning}>{rerunning ? "Running..." : "⚡ Re-run"}</Btn>
            </div>
            {rerunError && <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.red, margin: "8px 0 0", letterSpacing: "0.06em" }}>⚠ {rerunError}</p>}
          </div>

          {/* Scores preview — current → achievable ceiling */}
          {(job.recruiterScore != null || job.hmScore != null) && (
            <div style={{ display: "flex", gap: "10px" }}>
              {job.recruiterScore != null && (
                <ScoreCeiling label="Recruiter Score" size="sm" current={job.recruiterScore} ceiling={resolveCeiling(job.recruiterScore, job.updatedRecruiterScore, job.recruiterCeiling)} />
              )}
              {job.hmScore != null && (
                <ScoreCeiling label="HM Score" size="sm" current={job.hmScore} ceiling={resolveCeiling(job.hmScore, job.updatedHmScore, job.hmCeiling)} />
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: "12px", paddingTop: "4px" }}>
            <Btn onClick={save} disabled={!draft.title.trim()}>Save Changes</Btn>
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SCORE LEAP ───────────────────────────────────────────────────────────────
// A one-shot celebratory reveal: the number counts up from old→new and the bar
// fills to match, so an improvement reads as motion the user made happen — not a
// silent stat swap. Calm by design: one smooth ease, no bounce, no loop.
function ScoreLeap({ label, from, to }) {
  const words = useWordsMode();
  const [val, setVal] = useState(from);
  useEffect(() => {
    let raf; const t0 = performance.now(); const dur = 850;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);   // easeOutCubic
      setVal(from + (to - from) * e);
      if (p < 1) raf = requestAnimationFrame(tick); else setVal(to);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [from, to]);
  const clamp = (v) => Math.max(0, Math.min(10, v));
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 5px" }}>{label}</p>
      {words ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginBottom: "6px" }}>
          <span style={{ fontFamily: T.display, fontSize: "13px", color: C.textDim, fontWeight: 700 }}>{scoreLabel(from)}</span>
          <span style={{ fontFamily: T.mono, fontSize: "12px", color: C.accent }}>→</span>
          <span style={{ fontFamily: T.display, fontSize: "15px", color: C.accent, fontWeight: 700 }}>{scoreLabel(to)}</span>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginBottom: "6px" }}>
          <span style={{ fontFamily: T.display, fontSize: "16px", color: C.textDim, fontWeight: 700, textDecoration: "line-through", opacity: 0.7 }}>{fmtScore(from)}</span>
          <span style={{ fontFamily: T.mono, fontSize: "14px", color: C.accent, fontWeight: 700 }}>→</span>
          <span style={{ fontFamily: T.display, fontSize: "26px", color: C.accent, fontWeight: 800, lineHeight: 1 }}>{fmtScore(Math.round(val * 10) / 10)}</span>
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>/10</span>
        </div>
      )}
      <div style={{ height: "5px", background: C.border2, borderRadius: "3px", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${clamp(val) * 10}%`, background: C.accent, borderRadius: "3px" }} />
      </div>
    </div>
  );
}
const RESCORE_CHEERS = [
  "that's real movement — you earned it",
  "the edits worked",
  "nice — the resume's pulling its weight now",
  "that's the climb paying off",
];

// ─── RESCORE CARD ─────────────────────────────────────────────────────────────
function ReScoreCard({ job, updatedResume, onUpdate }) {
  const { logEvent } = useEvents();
  const [scoring, setScoring] = useState(false);
  const [error, setError]     = useState("");
  const [celebrate, setCelebrate] = useState(null); // { r, h, msg } after an improving re-score
  const words = useWordsMode();
  // Let the celebration linger, then calm itself — encourage, don't nag.
  useEffect(() => {
    if (!celebrate) return;
    const t = setTimeout(() => setCelebrate(null), 7000);
    return () => clearTimeout(t);
  }, [celebrate]);
  const hasUpdated = !!updatedResume?.trim();
  const hasScores  = job.updatedRecruiterScore != null || job.updatedHmScore != null;

  const delta = (orig, updated) => {
    if (orig == null || updated == null) return null;
    const d = updated - orig;
    if (d === 0) return <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>→ {updated}</span>;
    return <span style={{ fontFamily: T.mono, fontSize: "11px", color: d > 0 ? C.accent : C.red }}>{d > 0 ? `↑${d}` : `↓${Math.abs(d)}`} → {updated}</span>;
  };

  const runRescore = async () => {
    const apiKey   = localStorage.getItem(KEYS.apiKey);
    const proxyUrl = localStorage.getItem(KEYS.proxyUrl);
    if (!apiKey)    { setError("No API key. Go to Settings."); return; }
    if (!hasUpdated){ setError("No updated resume saved. Go to the Resume tab first."); return; }

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

      const endpoint = proxyUrl ? proxyUrl.replace(/\/$/, "") : "https://api.anthropic.com/v1/messages";
      const headers  = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
      if (!proxyUrl) headers["anthropic-dangerous-allow-browser"] = "true";

      const res  = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: "user", content: prompt }] }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const text   = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
      const rMatch = text.match(/RECRUITER SCORE:\s*(\d+(?:\.\d+)?)/i);
      const hMatch = text.match(/HIRING MANAGER SCORE:\s*(\d+(?:\.\d+)?)/i);
      const sMatch = text.match(/CHANGE SUMMARY:\s*(.+)/i);
      const newR = rMatch ? parseFloat(rMatch[1]) : null;
      const newH = hMatch ? parseFloat(hMatch[1]) : null;
      onUpdate({ ...job, updatedRecruiterScore: newR, updatedHmScore: newH, updatedScoreSummary: sMatch ? sMatch[1].trim() : "", updatedScoreDate: now() });

      // Celebrate only genuine forward movement, measured against the last score
      // the user saw (a previous re-score if any, otherwise the original).
      const prevR = job.updatedRecruiterScore ?? job.recruiterScore ?? null;
      const prevH = job.updatedHmScore ?? job.hmScore ?? null;
      const upR = newR != null && prevR != null && newR > prevR;
      const upH = newH != null && prevH != null && newH > prevH;
      if (upR || upH) {
        logEvent("improved", { job: job.id, r: upR ? newR : null, h: upH ? newH : null });
        setCelebrate({
          r: upR ? { from: prevR, to: newR } : null,
          h: upH ? { from: prevH, to: newH } : null,
          msg: RESCORE_CHEERS[Math.floor(Math.random() * RESCORE_CHEERS.length)],
        });
      }
    } catch (err) {
      setError(classifyApiError(err, !!proxyUrl).message || "Re-score failed.");
    }
    setScoring(false);
  };

  return (
    <div style={{ marginBottom: "18px" }}>
      <Label>Projected Score with Updated Resume</Label>

      {/* Celebrated moment — only appears right after a re-score that improved */}
      {celebrate && (
        <div style={{ position: "relative", background: "#0E1A13", border: `1px solid ${C.accent}66`, borderRadius: "12px", padding: "16px 18px", marginBottom: "12px", animation: "celebrateGlow 2.4s ease-out", overflow: "hidden" }}>
          <button onClick={() => setCelebrate(null)} aria-label="Dismiss" style={{ position: "absolute", top: "10px", right: "12px", background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: "13px", lineHeight: 1 }}>✕</button>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>▲ Your work paid off</span>
          </div>
          <div style={{ display: "flex", gap: "22px", marginBottom: "10px" }}>
            {celebrate.r && <ScoreLeap label="Recruiter" from={celebrate.r.from} to={celebrate.r.to} />}
            {celebrate.h && <ScoreLeap label="Hiring Mgr" from={celebrate.h.from} to={celebrate.h.to} />}
          </div>
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.mint, margin: 0, lineHeight: 1.5 }}>{celebrate.msg}</p>
        </div>
      )}

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
                {[{ l: "Recruiter", orig: job.recruiterScore, upd: job.updatedRecruiterScore }, { l: "Hiring Mgr", orig: job.hmScore, upd: job.updatedHmScore }].map(({ l, orig, upd }) => (
                  <div key={l}>
                    <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>{l}</p>
                    {words ? (
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <span style={{ fontFamily: T.display, fontSize: "15px", color: scoreColor(upd), fontWeight: 700 }}>{scoreLabel(upd) || "—"}</span>
                        {orig != null && upd != null && upd !== orig && (
                          <span style={{ fontFamily: T.body, fontSize: "11px", color: C.textDim }}>{upd > orig ? "up from" : "down from"} {scoreLabel(orig)}</span>
                        )}
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontFamily: T.display, fontSize: "22px", color: scoreColor(upd), fontWeight: 800 }}>{upd ?? "—"}</span>
                        <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>/10</span>
                        {delta(orig, upd)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {job.updatedScoreSummary && <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: "0 0 12px", lineHeight: 1.6, fontStyle: "italic" }}>{job.updatedScoreSummary}</p>}
              <Btn small onClick={runRescore} disabled={scoring}>{scoring ? "Re-scoring..." : "Re-score Again"}</Btn>
            </div>
          ) : (
            <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.5 }}>Updated resume saved. Run a re-score to see projected improvement.</p>
              <Btn small onClick={runRescore} disabled={scoring}>{scoring ? "Scoring..." : "Re-score →"}</Btn>
            </div>
          )}
          {error && <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.red, margin: "0 18px 14px", letterSpacing: "0.06em" }}>⚠ {error}</p>}
        </div>
      )}
    </div>
  );
}

// ─── THIS WEEK STRIP ──────────────────────────────────────────────────────────
// A calm tally of the effort the user actually controls this week — the wins
// that come before any offer does. Encourages by simply reflecting motion back;
// never a target, a streak, or a nudge to do more.
function WeekStrip() {
  const { events } = useEvents();
  const counts = weekEventCounts(events);
  const items = [
    { label: "analyzed",  sub: "jobs",    v: counts.analyzed, c: C.blue   },
    { label: "tailored",  sub: "resumes", v: counts.tailored, c: C.accent },
    { label: "improved",  sub: "scores",  v: counts.improved, c: C.mint   },
    { label: "advanced",  sub: "stages",  v: counts.advanced, c: C.yellow },
  ];
  const total = items.reduce((n, i) => n + i.v, 0);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "16px 20px", marginBottom: "18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: total ? "14px" : "8px", flexWrap: "wrap" }}>
        <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, letterSpacing: "0.14em", textTransform: "uppercase" }}>This week</span>
        <span style={{ fontFamily: T.body, fontSize: "12px", color: C.textDim, lineHeight: 1.5 }}>
          {total ? "Progress you made — not luck, not offers. Effort." : "A fresh week. Everything you analyze, tailor, and advance shows up here."}
        </span>
      </div>
      {total > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px" }}>
          {items.map(({ label, sub, v, c }) => (
            <div key={label} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ fontFamily: T.display, fontSize: "26px", fontWeight: 800, lineHeight: 1, color: v > 0 ? c : C.border2 }}>{v}</span>
              <span style={{ fontFamily: T.body, fontSize: "12px", color: v > 0 ? C.textMid : C.textDim, lineHeight: 1.3 }}>{sub} {label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── THIS WEEK'S PLAN ─────────────────────────────────────────────────────────
// Answers the "what if I don't get a job soon?" fear with the opposite of dread:
// a short list of things entirely in the user's control this week. Effort, not
// outcomes. Honest about timelines (no promised dates, no hopelessness), and
// every line is paired with a lever — the two moves that actually raise interview
// rate (trade reaches for matches, tailor the résumé) are right here.
function WeekPlan({ jobs, onOpenJob, onOpenResume, onOpenAnalyze }) {
  const { events } = useEvents();
  const wk = weekEventCounts(events);
  const overrides = loadBandOverrides();
  const since = startOfWeek();
  const appliedThisWeek = (jobs || []).filter(j => j.dateApplied && new Date(j.dateApplied).getTime() >= since).length;
  const matchSaved = (jobs || []).filter(j => j.status === "saved" && jobBand(j, overrides) === "match");
  const staleApplied = (jobs || []).filter(j => j.status === "applied" && (daysSince(j.dateApplied || j.dateAdded) ?? 0) >= 5)
    .sort((a, b) => (daysSince(b.dateApplied) || 0) - (daysSince(a.dateApplied) || 0));
  const applyTarget = 2;
  const reframeDone = (wk.tailored + wk.improved) >= 1;

  const short = (s, n = 26) => { const t = (s || "").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

  const items = [
    {
      key: "apply", done: appliedThisWeek >= applyTarget,
      title: `Apply to ${applyTarget} match-band roles`,
      detail: appliedThisWeek >= applyTarget
        ? `${appliedThisWeek} applied this week — that's real momentum.`
        : matchSaved.length
          ? `${appliedThisWeek} of ${applyTarget} this week · ${matchSaved.length} match role${matchSaved.length > 1 ? "s" : ""} saved and ready to send`
          : `${appliedThisWeek} of ${applyTarget} this week · a match beats a reach for landing interviews`,
      cta: matchSaved.length && onOpenJob
        ? { label: `Apply to ${short(matchSaved[0].title || matchSaved[0].company || "a saved match")} →`, fn: () => onOpenJob(matchSaved[0].id) }
        : onOpenAnalyze ? { label: "Check a new role →", fn: onOpenAnalyze } : null,
    },
    {
      key: "reframe", done: reframeDone,
      title: "Make one résumé reframe",
      detail: reframeDone
        ? "Done this week ✓ — one edit lifts every future score."
        : "The highest-leverage 15 minutes you have — it compounds across every application.",
      cta: !reframeDone && onOpenResume ? { label: "Open your résumé →", fn: onOpenResume } : null,
    },
    {
      key: "followup", done: false, muted: staleApplied.length === 0,
      title: "Send one follow-up",
      detail: staleApplied.length
        ? `${short(staleApplied[0].company || staleApplied[0].title, 30)} — applied ${agoPhrase(daysSince(staleApplied[0].dateApplied))}`
        : "Unlocks once you've applied — a friendly nudge can restart a stalled one.",
      cta: staleApplied.length && onOpenJob ? { label: "Follow up →", fn: () => onOpenJob(staleApplied[0].id) } : null,
    },
  ];

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "16px 20px", marginBottom: "18px" }}>
      <div style={{ marginBottom: "12px" }}>
        <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.14em", textTransform: "uppercase" }}>This week — in your control</span>
        <p style={{ fontFamily: T.body, fontSize: "12.5px", color: C.textSub, margin: "6px 0 0", lineHeight: 1.6 }}>
          No one can promise a date. What reliably raises your interview rate is trading reaches for matches and tailoring your résumé — both are on this list, and both are things you do today.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        {items.map(it => (
          <div key={it.key} style={{ display: "flex", alignItems: "flex-start", gap: "12px", padding: "11px 0", borderTop: `1px solid ${C.border}` }}>
            <span style={{ flexShrink: 0, marginTop: "2px", width: "18px", height: "18px", borderRadius: "50%", border: `1.5px solid ${it.done ? C.accent : it.muted ? C.border2 : C.orange}`, background: it.done ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {it.done && <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="#04120A" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontFamily: T.body, fontSize: "14px", color: it.muted ? C.textSub : C.text, margin: 0, fontWeight: 600, lineHeight: 1.4, textDecoration: it.done ? "line-through" : "none" }}>{it.title}</p>
              <p style={{ fontFamily: T.body, fontSize: "12.5px", color: C.textSub, margin: "3px 0 0", lineHeight: 1.5 }}>{it.detail}</p>
              {it.cta && !it.done && (
                <button className="tap" onClick={it.cta.fn} style={{ marginTop: "7px", background: `${C.accent}12`, border: `1px solid ${C.accent}44`, borderRadius: "8px", padding: "6px 12px", color: C.accent, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.04em", cursor: "pointer" }}>{it.cta.label}</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── TRACKER PAGE ─────────────────────────────────────────────────────────────
function TrackerPage({ jobs, onUpdateJob, onDeleteJob, onAddJob, updatedResume, focusId, resume, onOpenSetup, onOpenResume, onOpenAnalyze }) {
  const { logEvent } = useEvents();
  const [momentum, setMomentum]   = useState(null); // calm acknowledgement on a forward stage move
  const [filter, setFilter]       = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  // Opt-in reminder surface + per-card nudge dismissals (all local).
  const [nudgesOn, setNudgesOn]   = useState(() => { try { return localStorage.getItem(KEYS.nudgesOn) === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(KEYS.nudgesOn, nudgesOn ? "1" : "0"); } catch {} }, [nudgesOn]);
  const [dismissed, setDismissed] = useState(() => loadDismissedNudges());
  const dismissNudge = (key) => setDismissed(prev => { const next = new Set(prev); next.add(key); saveDismissedNudges(next); return next; });
  // Per-job fit-band overrides (auto-derived from score otherwise), kept local.
  const [bands, setBands] = useState(() => loadBandOverrides());
  const setBand = (id, b) => setBands(prev => { const next = { ...prev }; if (b) next[id] = b; else delete next[id]; saveBandOverrides(next); return next; });
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [showAdd, setShowAdd]     = useState(false);
  const [editingJob, setEditingJob] = useState(null);
  const [newJob, setNewJob]       = useState({ title: "", company: "", url: "", status: "saved", notes: "", location: "", workModel: "", employmentType: "", seniority: "", salary: "", team: "" });

  // Deep link (?job=<id> from Path Pursuit): reveal the right filter, expand the
  // card, scroll to it, and flash a highlight.
  useEffect(() => {
    if (!focusId) return;
    const target = jobs.find(j => j.id === focusId);
    if (!target) return;
    setFilter(target.status === "rejected" ? "rejected" : "all");
    setExpandedId(focusId);
    const t = setTimeout(() => {
      const el = document.getElementById("acjob-" + focusId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.style.boxShadow = `0 0 0 1px ${C.accent}, 0 0 24px ${C.accentGlow}`;
        setTimeout(() => { el.style.boxShadow = ""; }, 2200);
      }
    }, 180);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, jobs.length]);

  const activeJobs   = jobs.filter(j => j.status !== "rejected");
  const rejectedJobs = jobs.filter(j => j.status === "rejected");
  const filtered = filter === "all" ? activeJobs : filter === "rejected" ? rejectedJobs : jobs.filter(j => j.status === filter);

  const stats = {
    total:   activeJobs.length,
    applied: activeJobs.filter(j => ["applied","screen","interview","offer"].includes(j.status)).length,
    active:  activeJobs.filter(j => ["screen","interview"].includes(j.status)).length,
    offers:  activeJobs.filter(j => j.status === "offer").length,
  };
  const savedCount = activeJobs.filter(j => j.status === "saved").length;

  // Reveal + flash a card (used by the reminder surface and clickable stats).
  const jumpToJob = (id, status) => {
    setFilter(status === "rejected" ? "rejected" : "all");
    setExpandedId(id);
    setTimeout(() => {
      const el = document.getElementById("acjob-" + id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.style.boxShadow = `0 0 0 1px ${C.accent}, 0 0 24px ${C.accentGlow}`;
        setTimeout(() => { el.style.boxShadow = ""; }, 2200);
      }
    }, 180);
  };

  // The single stale, actionable item most worth doing right now (opt-in only).
  const focus = (() => {
    if (!nudgesOn) return null;
    let best = null, bestU = -1;
    for (const j of activeJobs) {
      const nd = cardNudge(j);
      if (!nd || nd.tone !== "act" || dismissed.has(nd.key)) continue;
      const u = nudgeUrgency(j);
      if (u > bestU) { bestU = u; best = { job: j, nudge: nd }; }
    }
    return best;
  })();

  // A forward move through the pipeline is a win the user controls — log it and
  // surface a brief, calm acknowledgement. Backward or sideways moves stay quiet.
  const noteAdvance = (fromKey, toKey) => {
    if (!isAdvance(fromKey, toKey)) return;
    logEvent("advanced", { from: fromKey, to: toKey });
    setMomentum(MOMENTUM_MSG[toKey] || "that's forward motion");
  };
  const changeStatus = (job, s) => { noteAdvance(job.status, s); onUpdateJob({ ...job, status: s, ...stampDate(job, s) }); };

  useEffect(() => {
    if (!momentum) return;
    const t = setTimeout(() => setMomentum(null), 3200);
    return () => clearTimeout(t);
  }, [momentum]);

  const addJob = () => {
    if (!newJob.title.trim()) return;
    const base = makeJob({ url: newJob.url, title: newJob.title, company: newJob.company, source: "inflow", status: newJob.status });
    const t = base.savedAt;
    const dates = { dateAdded: t, dateSaved: t, dateApplied: null, dateScreen: null, dateInterview: null, dateOffer: null, dateRejected: null };
    const dk = SM[base.status]?.dateKey;
    if (dk && dk !== "dateSaved") dates[dk] = t;   // stamp the chosen starting stage
    onAddJob({ ...base, notes: newJob.notes, location: newJob.location, workModel: newJob.workModel, employmentType: newJob.employmentType, seniority: newJob.seniority, salary: newJob.salary, team: newJob.team, recruiterScore: null, hmScore: null, tier: null, analysis: "", ...dates });
    setNewJob({ title: "", company: "", url: "", status: "saved", notes: "", location: "", workModel: "", employmentType: "", seniority: "", salary: "", team: "" });
    setShowAdd(false);
  };

  const exportCSV = () => {
    if (!jobs.length) return;
    const cols = ["Title","Company","Location","Work Model","Employment Type","Seniority","Salary","Team","Key Requirements","Status","Tier","Recruiter Score","HM Score","ATS %","Interview Probability %","Hiring Verdict","Decision Confidence","Date Added","Date Applied","Date Screen","Date Interview","Date Offer","Date Rejected","URL","Notes"];
    const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const toRows = (list) => list.map(j => [
      escape(j.title), escape(j.company), escape(j.location), escape(j.workModel),
      escape(j.employmentType), escape(j.seniority), escape(j.salary), escape(j.team),
      escape(j.keyRequirements), escape(SM[j.status]?.label || j.status),
      escape(j.tier || ""), escape(j.recruiterScore ?? ""), escape(j.hmScore ?? ""),
      escape(j.atsAlignment ?? ""), escape(j.interviewProbability ?? ""),
      escape(j.hiringVerdict || ""), escape(j.decisionConfidence || ""),
      escape(fmtDate(j.dateAdded) || ""), escape(fmtDate(j.dateApplied) || ""),
      escape(fmtDate(j.dateScreen) || ""), escape(fmtDate(j.dateInterview) || ""),
      escape(fmtDate(j.dateOffer) || ""), escape(fmtDate(j.dateRejected) || ""),
      escape(j.url), escape(j.notes),
    ].join(","));
    const header = cols.map(c => `"${c}"`).join(",");
    const dl = (rows, name) => {
      const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
      const url  = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
    };
    const date = new Date().toISOString().slice(0, 10);
    dl(toRows(activeJobs), `inflow-active-${date}.csv`);
    if (rejectedJobs.length) setTimeout(() => dl(toRows(rejectedJobs), `inflow-rejected-${date}.csv`), 300);
  };

  const cardSub = (job) => {
    const st = SM[job.status]; const date = st ? job[st.dateKey] : null;
    if (date) return `${st.label} · ${fmtShort(date)}`;
    return job.dateAdded ? `Added ${fmtShort(job.dateAdded)}` : "";
  };

  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "48px 24px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "36px" }}>
        <div>
          <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 12px" }}>Pipeline</p>
          <h1 style={{ fontFamily: T.display, fontSize: "clamp(26px,4vw,38px)", color: C.text, fontWeight: 800, letterSpacing: "-0.03em" }}>Application Tracker</h1>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {jobs.length > 0 && <Btn onClick={exportCSV} variant="ghost" small>↓ Export CSV</Btn>}
          <Btn onClick={() => setShowAdd(true)} small>+ Add Job</Btn>
        </div>
      </div>

      {/* This-week effort tally */}
      <WeekStrip />

      {/* Controllable plan — turns "what if I don't get a job soon" into effort you own */}
      {jobs.length > 0 && (
        <WeekPlan jobs={jobs} onOpenJob={(id) => jumpToJob(id, (jobs.find(j => j.id === id) || {}).status)} onOpenResume={onOpenResume} onOpenAnalyze={onOpenAnalyze} />
      )}

      {/* Cross-analysis strategy note — recalibrate when everything's a stretch */}
      <StretchPatternCallout jobs={jobs} onOpenJob={(id) => jumpToJob(id, (jobs.find(j => j.id === id) || {}).status)} resume={resume} onOpenSetup={onOpenSetup} />

      {/* Reminder surface — opt-in, never guilt-based */}
      {jobs.length > 0 && (
        <div style={{ marginBottom: "18px" }}>
          {!nudgesOn ? (
            <button onClick={() => setNudgesOn(true)} style={{ width: "100%", textAlign: "left", background: "transparent", border: `1px dashed ${C.border2}`, borderRadius: "12px", padding: "12px 18px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, lineHeight: 1.5 }}>
                🔔 Want a gentle nudge toward the one thing most worth doing? It stays on this device.
              </span>
              <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.08em", whiteSpace: "nowrap" }}>Turn on →</span>
            </button>
          ) : focus ? (
            <div style={{ background: "#0E1A13", border: `1px solid ${C.accent}44`, borderRadius: "12px", padding: "15px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "9px" }}>
                <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>One thing worth a look</span>
                <button onClick={() => setNudgesOn(false)} title="Turn off reminders" style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.06em" }}>mute</button>
              </div>
              <p style={{ fontFamily: T.display, fontSize: "15px", color: C.text, margin: "0 0 3px", fontWeight: 700 }}>{focus.job.title}{focus.job.company ? ` · ${focus.job.company}` : ""}</p>
              <p style={{ fontFamily: T.body, fontSize: "14px", color: C.textMid, margin: "0 0 12px", lineHeight: 1.55 }}>{focus.nudge.text}</p>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <Btn small onClick={() => jumpToJob(focus.job.id, focus.job.status)}>Take a look →</Btn>
                {focus.job.url && <a href={focus.job.url} target="_blank" rel="noreferrer" style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, alignSelf: "center", textDecoration: "none", border: `1px solid ${C.accent}44`, borderRadius: "8px", padding: "6px 12px" }}>Open posting ↗</a>}
                <button onClick={() => dismissNudge(focus.nudge.key)} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "6px 12px", color: C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.06em", cursor: "pointer" }}>Not now</button>
              </div>
            </div>
          ) : (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "13px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, lineHeight: 1.5 }}>Nothing pressing right now — you're on top of it. 🌱</span>
              <button onClick={() => setNudgesOn(false)} style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.06em" }}>mute</button>
            </div>
          )}
        </div>
      )}

      {/* Stats — clickable, and a bare zero becomes a coaching prompt */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "12px", marginBottom: "32px" }}>
        {[
          { l: "Active",      v: stats.total,   c: C.textMid, zero: "Add your first job",              onClick: () => stats.total ? setFilter("all") : setShowAdd(true) },
          { l: "Applied",     v: stats.applied, c: C.accent,  zero: savedCount ? "Apply to a saved one" : "Save a job to start", onClick: () => savedCount ? setFilter("saved") : (stats.total ? setFilter("all") : setShowAdd(true)) },
          { l: "In Progress", v: stats.active,  c: C.yellow,  zero: "Screens follow applications",     onClick: () => setFilter(stats.applied ? "applied" : (savedCount ? "saved" : "all")) },
          { l: "Offers",      v: stats.offers,  c: C.mint,    zero: "Every offer starts as one saved job", onClick: () => setFilter("all") },
        ].map(({ l, v, c, zero, onClick }) => (
          <button key={l} onClick={onClick} title="Jump to the next thing you can do here" style={{ textAlign: "left", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "18px 20px", cursor: "pointer", transition: "border-color 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = `${c}66`}
            onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
            <div style={{ fontFamily: T.display, fontSize: "36px", color: v > 0 ? c : C.border2, lineHeight: 1, marginBottom: "8px", fontWeight: 800 }}>{v}</div>
            <div style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: v === 0 ? "6px" : 0 }}>{l}</div>
            {v === 0 && <div style={{ fontFamily: T.body, fontSize: "11.5px", color: C.textSub, lineHeight: 1.4 }}>{zero} →</div>}
          </button>
        ))}
      </div>

      {/* Pipeline fit-mix — is the whole board reaches? */}
      {(() => {
        const counts = activeJobs.reduce((a, j) => { const b = jobBand(j, bands); if (b) a[b] = (a[b] || 0) + 1; return a; }, {});
        const total = (counts.reach || 0) + (counts.match || 0) + (counts.safe || 0);
        if (total < 2) return null;
        const winnable = (counts.match || 0) + (counts.safe || 0);
        const mostlyReaches = (counts.reach || 0) >= Math.ceil(total * 0.7) && winnable <= 1;
        return (
          <div style={{ background: C.surface, border: `1px solid ${mostlyReaches ? `${C.orange}44` : C.border}`, borderRadius: "12px", padding: "13px 18px", marginBottom: "22px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" }}>Pipeline mix</span>
              {BAND_ORDER.map(k => (
                <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: FIT_BANDS[k].color }} />
                  <span style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid }}><b style={{ color: C.text }}>{counts[k] || 0}</b> {FIT_BANDS[k].label}</span>
                </span>
              ))}
            </div>
            {mostlyReaches && (
              <span style={{ fontFamily: T.body, fontSize: "12.5px", color: C.orange, lineHeight: 1.5, flex: 1, minWidth: "180px", textAlign: "right" }}>
                Mostly reaches — adding a couple of matches is what turns a slow search into interviews.
              </span>
            )}
          </div>
        );
      })()}

      {/* Filters */}
      <div style={{ display: "flex", gap: "7px", marginBottom: "22px", flexWrap: "wrap", alignItems: "center" }}>
        <button className="tap" onClick={() => setFilter("all")} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === "all" ? C.accent : C.border}`, background: filter === "all" ? "#0E1A13" : "transparent", color: filter === "all" ? C.accent : C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer" }}>
          Active ({activeJobs.length})
        </button>
        {STATUSES.filter(s => s.key !== "rejected").map(s => {
          const count = jobs.filter(j => j.status === s.key).length;
          return (
            <button key={s.key} className="tap" onClick={() => setFilter(s.key)} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === s.key ? s.color : C.border}`, background: filter === s.key ? s.bg : "transparent", color: filter === s.key ? s.color : C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer" }}>
              {s.label} ({count})
            </button>
          );
        })}
        {rejectedJobs.length > 0 && (
          <>
            <div style={{ width: "1px", height: "20px", background: C.border, flexShrink: 0 }} />
            <button className="tap" onClick={() => setFilter("rejected")} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === "rejected" ? C.red : C.border}`, background: filter === "rejected" ? "#1D100E" : "transparent", color: filter === "rejected" ? C.red : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer", opacity: filter === "rejected" ? 1 : 0.6 }}>
              Rejected ({rejectedJobs.length})
            </button>
          </>
        )}
      </div>

      {/* Job list */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "64px 20px" }}>
          {jobs.length === 0 ? (
            <>
              <p style={{ fontFamily: T.display, fontSize: "22px", color: C.text, fontWeight: 800, marginBottom: "10px", letterSpacing: "-0.02em" }}>Every offer starts as one saved job.</p>
              <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.7, maxWidth: "440px", margin: "0 auto 20px" }}>
                Here's the whole first step: analyze a posting on the Analyze tab, or drop one in here by hand. Nothing else required yet.
              </p>
              <Btn onClick={() => setShowAdd(true)}>+ Add your first job</Btn>
            </>
          ) : filter === "rejected" ? (
            <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textDim, lineHeight: 1.7 }}>No rejected jobs. Keep it that way.</p>
          ) : filter === "all" ? (
            <>
              <p style={{ fontFamily: T.display, fontSize: "20px", color: C.textMid, fontWeight: 800, marginBottom: "10px" }}>Your active list is clear.</p>
              <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textDim, lineHeight: 1.7, marginBottom: "18px" }}>Ready when you are — add the next one whenever you find it.</p>
              <Btn onClick={() => setShowAdd(true)} variant="ghost" small>+ Add a job</Btn>
            </>
          ) : (
            <>
              <p style={{ fontFamily: T.display, fontSize: "20px", color: C.textMid, fontWeight: 800, marginBottom: "10px" }}>Nothing at {SM[filter]?.label} yet.</p>
              <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textDim, lineHeight: 1.7, marginBottom: "18px" }}>
                {filter === "applied" ? "Applying to a saved job is the fastest way to fill this." : filter === "saved" ? "Save a job from an analysis, or add one manually." : "Keep going — this stage fills as earlier ones advance."}
              </p>
              <Btn onClick={() => setFilter(filter === "applied" ? "saved" : "all")} variant="ghost" small>
                {filter === "applied" ? "See saved jobs to apply to →" : "Back to active →"}
              </Btn>
            </>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {filtered.map(job => {
            const st  = SM[job.status] || STATUSES[0];
            const exp = expandedId === job.id;
            const jobTier = findTier(job.tier);
            const nd = cardNudge(job);
            const showNudge = nd && !dismissed.has(nd.key);
            const nudgeTint = nd?.tone === "act" ? C.accent : nd?.tone === "celebrate" ? C.mint : C.textDim;
            return (
              <div key={job.id} id={"acjob-" + job.id} style={{ background: C.surface, border: `1px solid ${exp ? C.border2 : C.border}`, borderRadius: "12px", overflow: "hidden", transition: "box-shadow 0.4s" }}>
                <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: "14px" }}>
                  <Pill label={st.short} color={st.color} bg={st.bg} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontFamily: T.display, fontSize: "16px", color: C.text, margin: "0 0 3px", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{job.title}</p>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.textSub, margin: 0, lineHeight: 1.4 }}>
                        {job.company}{cardSub(job) ? `  ·  ${cardSub(job)}` : ""}
                      </p>
                      {jobTier && <TierBadge tier={jobTier} />}
                      {(() => { const bk = jobBand(job, bands); if (!bk) return null; const b = FIT_BANDS[bk]; return (
                        <span title={`Fit: ${b.blurb}`} style={{ fontFamily: T.mono, fontSize: "10px", color: b.color, background: `${b.color}14`, border: `1px solid ${b.color}44`, borderRadius: "4px", padding: "2px 8px", letterSpacing: "0.06em", whiteSpace: "nowrap", fontWeight: 600 }}>{b.label}</span>
                      ); })()}
                      {[job.workModel, job.location, job.employmentType, job.seniority, job.salary]
                        .filter(v => v && v.trim())
                        .map((v, i) => (
                          <span key={i} style={{ fontFamily: T.mono, fontSize: "10px", color: C.textSub, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "2px 7px", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{v}</span>
                        ))}
                    </div>
                  </div>
                  {(job.recruiterScore || job.hmScore) && (
                    <div style={{ display: "flex", gap: "8px", flexShrink: 0, width: "min(230px, 42%)" }}>
                      {job.recruiterScore != null && (
                        <ScoreCeiling label="REC" size="sm" current={job.recruiterScore} ceiling={resolveCeiling(job.recruiterScore, job.updatedRecruiterScore, job.recruiterCeiling)} />
                      )}
                      {job.hmScore != null && (
                        <ScoreCeiling label="HM" size="sm" current={job.hmScore} ceiling={resolveCeiling(job.hmScore, job.updatedHmScore, job.hmCeiling)} />
                      )}
                    </div>
                  )}
                  <button className="tap" aria-label={exp ? "Collapse job details" : "Expand job details"} aria-expanded={exp} onClick={() => setExpandedId(exp ? null : job.id)} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "6px 10px", color: C.textSub, cursor: "pointer", fontFamily: T.mono, fontSize: "12px", flexShrink: 0 }}>
                    {exp ? "▲" : "▼"}
                  </button>
                </div>

                {/* Per-card next step — gentle, dismissible executive-function support */}
                {showNudge && (
                  <div style={{ borderTop: `1px solid ${C.border}`, background: nd.tone === "act" ? "#0E1A1310" : "transparent", padding: "10px 20px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <span style={{ width: "3px", alignSelf: "stretch", minHeight: "16px", background: nudgeTint, borderRadius: "2px", flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: "180px", fontFamily: T.body, fontSize: "13px", color: C.textMid, lineHeight: 1.5 }}>{nd.text}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: "7px", flexShrink: 0 }}>
                      {job.status === "saved" && (
                        <button onClick={() => changeStatus(job, "applied")} style={{ background: `${C.accent}14`, border: `1px solid ${C.accent}44`, borderRadius: "7px", padding: "5px 11px", color: C.accent, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.04em", cursor: "pointer", whiteSpace: "nowrap" }}>I applied ✓</button>
                      )}
                      {job.url && nd.tone === "act" && (
                        <a href={job.url} target="_blank" rel="noreferrer" style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "7px", padding: "5px 11px", color: C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.04em", textDecoration: "none", whiteSpace: "nowrap" }}>Open ↗</a>
                      )}
                      <button className="tap" onClick={() => dismissNudge(nd.key)} aria-label="Dismiss suggestion" title="Not now" style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: "13px", lineHeight: 1, padding: "2px 4px" }}>✕</button>
                    </div>
                  </div>
                )}

                {exp && (
                  <div style={{ borderTop: `1px solid ${C.border}`, padding: "22px 20px" }}>
                    {job.coachSummary && (
                      <div style={{ marginBottom: "18px" }}>
                        <CoachSummary text={job.coachSummary} compact />
                      </div>
                    )}
                    <Timeline job={job} />
                    <DateEditor job={job} onUpdate={onUpdateJob} />

                    {(() => {
                      const details = [
                        { l: "Location",       v: job.location },
                        { l: "Work Model",     v: job.workModel },
                        { l: "Type",           v: job.employmentType },
                        { l: "Seniority",      v: job.seniority },
                        { l: "Salary",         v: job.salary },
                        { l: "Team",           v: job.team },
                        { l: "ATS Alignment",  v: job.atsAlignment != null ? `${job.atsAlignment}%` : null },
                        { l: "Interview Prob.",v: job.interviewProbability != null ? `${job.interviewProbability}%` : null },
                        { l: "Hiring Verdict", v: job.hiringVerdict },
                        { l: "Confidence",     v: job.decisionConfidence },
                      ].filter(d => d.v != null && d.v !== "");
                      if (!details.length && !job.keyRequirements) return null;
                      return (
                        <div style={{ marginBottom: "22px" }}>
                          <Label>Listing Details</Label>
                          {details.length > 0 && (
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "8px" }}>
                              {details.map(({ l, v }) => (
                                <div key={l} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "8px 12px" }}>
                                  <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 3px" }}>{l}</p>
                                  <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.4 }}>{v}</p>
                                </div>
                              ))}
                            </div>
                          )}
                          {job.keyRequirements && (
                            <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "10px 12px", marginTop: "8px" }}>
                              <p style={{ fontFamily: T.mono, fontSize: "9px", color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 4px" }}>Key Requirements</p>
                              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.5 }}>{job.keyRequirements}</p>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    <div style={{ marginBottom: "22px" }}>
                      <Label>Update Status</Label>
                      <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
                        {STATUSES.map(s => (
                          <button key={s.key} className="tap" onClick={() => changeStatus(job, s.key)} style={{ padding: "6px 14px", borderRadius: "18px", border: `1px solid ${job.status === s.key ? s.color : C.border}`, background: job.status === s.key ? s.bg : "transparent", color: job.status === s.key ? s.color : C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer" }}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Fit band — auto from score, overridable so the mix stays honest */}
                    <div style={{ marginBottom: "22px" }}>
                      <Label>Fit Band {!bands[job.id] && jobBand(job, bands) && <span style={{ color: C.textDim, textTransform: "none", letterSpacing: 0, fontFamily: T.body, fontSize: "12px" }}>— auto from score, tap to set your own</span>}</Label>
                      <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
                        {BAND_ORDER.map(k => {
                          const active = jobBand(job, bands) === k;
                          const overridden = bands[job.id] === k;
                          const b = FIT_BANDS[k];
                          return (
                            <button key={k} className="tap" onClick={() => setBand(job.id, overridden ? null : k)} style={{ padding: "6px 14px", borderRadius: "18px", border: `1px solid ${active ? b.color : C.border}`, background: active ? `${b.color}14` : "transparent", color: active ? b.color : C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer" }}>
                              {b.label}{overridden ? " ✓" : ""}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <ReScoreCard job={job} updatedResume={updatedResume} onUpdate={onUpdateJob} />

                    {job.url && (
                      <div style={{ marginBottom: "18px" }}>
                        <Label>Job URL</Label>
                        <a href={job.url} target="_blank" rel="noreferrer" style={{ fontFamily: T.code, fontSize: "12px", wordBreak: "break-all", lineHeight: 1.6 }}>{job.url}</a>
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

                    {job.jd && (
                      <div style={{ marginBottom: "18px" }}>
                        <Label>Saved Job Description</Label>
                        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px 16px", maxHeight: "200px", overflowY: "auto" }}>
                          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: 0, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                            {job.jd}
                          </p>
                        </div>
                      </div>
                    )}

                    {job.analysis && (
                      <div style={{ marginBottom: "18px" }}>
                        <Label>Analysis Preview</Label>
                        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px 16px", maxHeight: "200px", overflowY: "auto" }}>
                          <RenderPreview text={job.analysis} limit={700} />
                        </div>
                      </div>
                    )}

                    <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                      <Btn small variant="ghost" onClick={() => setEditingJob({ ...job })}>✏ Edit Job</Btn>
                      <Btn small variant="danger" onClick={() => { if (window.confirm("Remove this job from your pipeline?")) onDeleteJob(job.id); }}>Remove</Btn>
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
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <Field value={newJob.location} onChange={v => setNewJob(p => ({ ...p, location: v }))} placeholder="Location" />
                <Field value={newJob.workModel} onChange={v => setNewJob(p => ({ ...p, workModel: v }))} placeholder="Remote / Hybrid / On-site" />
                <Field value={newJob.employmentType} onChange={v => setNewJob(p => ({ ...p, employmentType: v }))} placeholder="Full-time / Contract" />
                <Field value={newJob.seniority} onChange={v => setNewJob(p => ({ ...p, seniority: v }))} placeholder="Seniority" />
                <Field value={newJob.salary} onChange={v => setNewJob(p => ({ ...p, salary: v }))} placeholder="Salary range" />
                <Field value={newJob.team} onChange={v => setNewJob(p => ({ ...p, team: v }))} placeholder="Team / Dept" />
              </div>
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

      {editingJob && (
        <EditJobModal job={editingJob} onSave={(updated) => { noteAdvance(editingJob.status, updated.status); onUpdateJob(updated); setEditingJob(null); }} onClose={() => setEditingJob(null)} />
      )}

      {/* Momentum acknowledgement — a quiet, self-dismissing nod on a stage advance */}
      {momentum && (
        <div style={{ position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)", zIndex: 120, background: "#0E1A13", border: `1px solid ${C.accent}55`, borderRadius: "22px", padding: "10px 20px", display: "flex", alignItems: "center", gap: "9px", boxShadow: `0 6px 28px ${C.accent}22`, animation: "momentumIn 3.2s ease forwards", maxWidth: "90vw" }}>
          <span style={{ fontFamily: T.mono, fontSize: "13px", color: C.accent }}>▲</span>
          <span style={{ fontFamily: T.body, fontSize: "14px", color: C.text, lineHeight: 1.4 }}>{momentum}</span>
        </div>
      )}
    </div>
  );
}

// ─── SETUP STEP ───────────────────────────────────────────────────────────────
// One row of the numbered one-time-setup checklist. A completed step shows a ✓
// in a filled bubble; the active step is highlighted; others sit quiet.
function SetupStep({ n, done, active, optional, title, children, last }) {
  const ring = done || active ? C.accent : C.border2;
  return (
    <li style={{ display: "flex", gap: "0", position: "relative", paddingLeft: "40px", paddingBottom: last ? 0 : "20px" }}>
      {!last && <span style={{ position: "absolute", left: "14px", top: "26px", bottom: 0, width: "1.5px", background: C.border }} />}
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, width: "29px", height: "29px", borderRadius: "50%", background: done ? C.accent : C.surface2, border: `1.5px solid ${ring}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono, fontSize: "13px", fontWeight: 700, color: done ? "#04120A" : active ? C.accent : C.textSub }}>
        {done ? "✓" : n}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontFamily: T.body, fontSize: "15px", color: C.text, fontWeight: 600, margin: "4px 0 0", lineHeight: 1.4 }}>
          {title}
          {optional && <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, marginLeft: "8px", letterSpacing: "0.1em" }}>OPTIONAL</span>}
        </p>
        <div style={{ marginTop: "9px" }}>{children}</div>
      </div>
    </li>
  );
}

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
function SettingsPage({ resume, onUpdateResume, authReady, syncCode, syncStatus, linkError, onLinkCode, hint, onHintConsumed }) {
  const [draft, setDraft]       = useState(resume);
  const [apiKey, setApiKey]     = useState(() => localStorage.getItem(KEYS.apiKey) || "");
  const [proxyUrl, setProxyUrl] = useState(() => localStorage.getItem(KEYS.proxyUrl) || "");
  const [saved, setSaved]       = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const charOk = draft.trim().length >= 100;
  // Inline key validation state: idle | checking | ok | badkey | cors | neterr.
  // Seed to "ok" when a key is already stored so returning users see step 2 done.
  const [verify, setVerify] = useState(() => localStorage.getItem(KEYS.apiKey)
    ? { state: "ok", msg: "Saved and ready ✓" } : { state: "idle", msg: "" });
  // The optional proxy step opens automatically when we arrive here from a CORS
  // error, or when validation turns up a connection block.
  const [proxyOpen, setProxyOpen] = useState(() => { try { return !!localStorage.getItem(KEYS.proxyUrl); } catch { return false; } });
  const proxyRef = useRef(null);
  useEffect(() => {
    if (hint === "proxy") {
      setProxyOpen(true);
      setTimeout(() => proxyRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
      onHintConsumed && onHintConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hint]);

  // Write the key + proxy locally only. Never leaves the device except on the
  // direct call to Anthropic (or the user's own proxy).
  const persistKey = (key, px) => {
    localStorage.setItem(KEYS.apiKey, key);
    if (px) localStorage.setItem(KEYS.proxyUrl, px); else localStorage.removeItem(KEYS.proxyUrl);
  };

  // Verify the key with one tiny live call, so a bad key fails here — friendly and
  // immediate — instead of silently later. On success (or a CORS block, where the
  // key itself is fine) we save it.
  const validateKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    if (!/^sk-ant-/.test(key)) {
      setVerify({ state: "badkey", msg: "That doesn't look like an Anthropic key — they start with “sk-ant-”. Copy the whole string from the console." });
      return;
    }
    setVerify({ state: "checking", msg: "Checking with Anthropic…" });
    const px = proxyUrl.trim();
    const endpoint = px ? px.replace(/\/$/, "") : "https://api.anthropic.com/v1/messages";
    const headers = { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
    if (!px) headers["anthropic-dangerous-allow-browser"] = "true";
    try {
      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }) });
      if (res.status === 401 || res.status === 403) {
        setVerify({ state: "badkey", msg: "Anthropic rejected that key. Double-check you copied all of it, or create a fresh one in the console." });
        return;
      }
      // Any non-auth response means the key authenticated (200 normally; a 400
      // would still have passed the auth check that fires first).
      persistKey(key, px);
      setVerify({ state: "ok", msg: px ? "Key looks good ✓ — connected through your proxy." : "Key looks good ✓ — you're all set." });
    } catch (err) {
      const c = classifyApiError(err, !!px);
      if (c.kind === "cors") {
        persistKey(key, px);                 // key is valid; the browser just blocked the direct call
        setVerify({ state: "cors", msg: "Your key saved fine, but your browser blocked the direct connection. One quick fix below and you're done." });
        setProxyOpen(true);
        setTimeout(() => proxyRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
      } else {
        setVerify({ state: "neterr", msg: c.message });
      }
    }
  };
  const saveProxy = () => {
    if (proxyUrl.trim()) localStorage.setItem(KEYS.proxyUrl, proxyUrl.trim());
    else localStorage.removeItem(KEYS.proxyUrl);
    // Re-verify through the new proxy so the user gets confirmation.
    validateKey();
  };

  const copyCode = () => {
    if (!syncCode) return;
    navigator.clipboard?.writeText(formatCode(syncCode));
    setCodeCopied(true); setTimeout(() => setCodeCopied(false), 2000);
  };

  const save = async () => {
    if (!charOk) return;
    await store.set(KEYS.resume, draft.trim());
    onUpdateResume(draft.trim());
    setSaved(true); setTimeout(() => setSaved(false), 2500);
  };

  const clearKey = () => {
    if (!window.confirm("Remove your API key and proxy URL from this browser?")) return;
    localStorage.removeItem(KEYS.apiKey); localStorage.removeItem(KEYS.proxyUrl);
    setApiKey(""); setProxyUrl(""); setVerify({ state: "idle", msg: "" }); setProxyOpen(false);
  };

  return (
    <div style={{ maxWidth: "740px", margin: "0 auto", padding: "48px 24px 0" }}>
      <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 16px" }}>Settings</p>
      <h1 style={{ fontFamily: T.display, fontSize: "clamp(26px,4vw,38px)", color: C.text, fontWeight: 800, letterSpacing: "-0.03em", margin: "0 0 36px" }}>Settings</h1>

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "28px", marginBottom: "18px" }}>
        <Label color={C.accent}>Sync Across Computers</Label>
        <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 18px" }}>
          This device has a sync code — enter the same code on your other computer or iPhone (Settings → Link a Device) to connect them. No account needed; everything still works offline and caches locally either way.
        </p>
        {!authReady ? (
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>setting up sync...</span>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap", marginBottom: "22px" }}>
            <div style={{ background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "10px 16px", fontFamily: T.code, fontSize: "18px", letterSpacing: "0.08em", color: C.text }}>
              {syncCode ? formatCode(syncCode) : "generating..."}
            </div>
            <Btn variant="ghost" small onClick={copyCode} disabled={!syncCode}>{codeCopied ? "✓ Copied" : "Copy Code"}</Btn>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: syncStatus === "error" ? C.red : C.accent, boxShadow: syncStatus === "synced" ? `0 0 8px ${C.accent}` : "none" }} />
              <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, letterSpacing: "0.05em" }}>
                {syncStatus === "syncing" ? "syncing…" : syncStatus === "error" ? "sync error" : "synced"}
              </span>
            </div>
          </div>
        )}

        <Label>Link a Device</Label>
        <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, lineHeight: 1.7, margin: "0 0 12px" }}>
          Got a code from another device? Enter it here to pull its data down and link this device to it — this replaces what's currently on this device.
        </p>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text" value={codeInput} onChange={e => setCodeInput(e.target.value)}
            placeholder="XXXX-XXXX" aria-label="Sync code from another device"
            style={{ background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "10px 14px", fontSize: "14px", color: C.text, fontFamily: T.code, outline: "none", width: "160px" }}
          />
          <Btn small onClick={() => onLinkCode(codeInput)} disabled={!codeInput.trim()}>Link</Btn>
        </div>
        {linkError && <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.red, margin: "10px 0 0" }}>{linkError}</p>}
      </div>

      {(() => {
        const step1done = apiKey.trim().length > 0;
        const step2done = verify.state === "ok";
        const step3done = verify.state === "ok";
        const step3active = verify.state === "cors";
        const vColor = verify.state === "ok" ? C.accent : verify.state === "cors" ? C.yellow : verify.state === "checking" ? C.textSub : C.red;
        const inputStyle = { width: "100%", background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "12px 16px", fontSize: "14px", color: C.text, fontFamily: T.code, boxSizing: "border-box" };
        const linkBtn = { display: "inline-flex", alignItems: "center", background: `${C.accent}14`, border: `1px solid ${C.accent}55`, borderRadius: "8px", padding: "9px 15px", color: C.accent, fontFamily: T.mono, fontSize: "12px", letterSpacing: "0.04em", textDecoration: "none", minHeight: "44px" };
        return (
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "28px", marginBottom: "18px" }}>
        <Label color={C.accent}>One-time setup</Label>
        <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 6px" }}>
          You only do this once — everything stays on your device. Your key is saved in this browser and sent straight to Anthropic when you run an analysis, never to us.
        </p>
        <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, lineHeight: 1.7, margin: "0 0 22px" }}>
          Two quick steps (three if your browser is fussy). Nothing to remember afterward.
        </p>

        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {/* Step 1 — get the key */}
          <SetupStep n={1} done={step1done} active={!step1done} title="Grab your Anthropic API key">
            <p style={{ fontFamily: T.body, fontSize: "13.5px", color: C.textSub, lineHeight: 1.7, margin: "0 0 10px" }}>
              Sign in (or make a free account), create a key, and copy it. It starts with <code style={{ fontFamily: T.code, fontSize: "12px", color: C.textMid }}>sk-ant-</code>.
            </p>
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="tap" style={linkBtn}>Open the Anthropic console ↗</a>
          </SetupStep>

          {/* Step 2 — paste + verify */}
          <SetupStep n={2} done={step2done} active={step1done && !step2done} title="Paste it here — we'll check it for you">
            <input type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); if (verify.state !== "idle") setVerify({ state: "idle", msg: "" }); }} onKeyDown={e => { if (e.key === "Enter") validateKey(); }} placeholder="sk-ant-..." aria-label="Anthropic API key" style={{ ...inputStyle, marginBottom: "10px" }} />
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
              <Btn onClick={validateKey} disabled={!apiKey.trim() || verify.state === "checking"}>
                {verify.state === "checking" ? "Checking…" : step2done ? "Re-check" : "Check my key"}
              </Btn>
            </div>
            {verify.msg && (
              <p style={{ fontFamily: T.body, fontSize: "13px", color: vColor, lineHeight: 1.6, margin: "10px 0 0", display: "flex", alignItems: "center", gap: "6px" }}>
                {verify.state === "checking" && <span style={{ width: "10px", height: "10px", borderRadius: "50%", border: `2px solid ${C.textDim}`, borderTopColor: "transparent", display: "inline-block", animation: "spin 0.7s linear infinite" }} />}
                {verify.msg}
              </p>
            )}
          </SetupStep>

          {/* Step 3 — optional proxy */}
          <SetupStep n={3} done={step3done && !step3active} active={step3active} optional title="Only if a connection error appears: add a quick proxy" last>
            <div ref={proxyRef}>
              {step2done && !proxyUrl.trim() ? (
                <p style={{ fontFamily: T.body, fontSize: "13.5px", color: C.textSub, lineHeight: 1.7, margin: 0 }}>
                  Not needed — your direct connection worked. If analyses ever stop connecting, come back and set this up.
                </p>
              ) : (
                <>
                  {!proxyOpen && (
                    <button className="tap" onClick={() => setProxyOpen(true)} style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "9px 14px", color: C.textSub, fontFamily: T.mono, fontSize: "12px", letterSpacing: "0.04em", cursor: "pointer" }}>
                      I hit a connection error — walk me through the proxy
                    </button>
                  )}
                  {proxyOpen && (
                    <div>
                      <p style={{ fontFamily: T.body, fontSize: "13.5px", color: C.textSub, lineHeight: 1.75, margin: "0 0 12px" }}>
                        Some browsers block the direct call to Anthropic for security (a “CORS” block). A tiny free proxy forwards the request and clears it. Your key still goes only to Anthropic — the proxy just relays it.
                      </p>
                      <ol style={{ margin: "0 0 14px", padding: "0 0 0 18px", fontFamily: T.body, fontSize: "13.5px", color: C.textMid, lineHeight: 1.9 }}>
                        <li>Open <a href="https://workers.cloudflare.com" target="_blank" rel="noreferrer">Cloudflare Workers</a> (free) and create a Worker.</li>
                        <li>Paste in the code from <code style={{ fontFamily: T.code, fontSize: "12px", color: C.textMid }}>cloudflare-worker/proxy.js</code> in this project.</li>
                        <li>Deploy it, copy the Worker URL, and paste it below.</li>
                      </ol>
                      <input type="text" value={proxyUrl} onChange={e => setProxyUrl(e.target.value)} placeholder="https://your-worker.workers.dev" aria-label="Proxy URL" style={{ ...inputStyle, marginBottom: "10px" }} />
                      <Btn onClick={saveProxy} disabled={!proxyUrl.trim() || verify.state === "checking"}>{verify.state === "checking" ? "Checking…" : "Save proxy & re-check"}</Btn>
                    </div>
                  )}
                </>
              )}
            </div>
          </SetupStep>
        </ol>

        {localStorage.getItem(KEYS.apiKey) && (
          <div style={{ marginTop: "20px", paddingTop: "18px", borderTop: `1px solid ${C.border}` }}>
            <Btn variant="danger" onClick={clearKey} small>Clear key from this browser</Btn>
          </div>
        )}
      </div>
        );
      })()}

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "28px", marginBottom: "18px" }}>
        <Label>Resume</Label>
        <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 20px" }}>
          This resume is used for every job analysis. Keep it current — all future analyses reference whatever version is saved here.
        </p>
        <Field value={draft} onChange={setDraft} placeholder="Your resume..." multiline rows={22} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
        <Btn onClick={save} disabled={!charOk}>{saved ? "✓ Resume Updated" : "Save Resume"}</Btn>
        <span style={{ fontFamily: T.mono, fontSize: "11px", color: charOk ? C.accent : C.textDim }}>{draft.trim().length} characters</span>
      </div>
    </div>
  );
}

// ─── RESUME PAGE ──────────────────────────────────────────────────────────────
function ResumePage({ baseResume, updatedResume, onUpdateBase, onUpdateUpdated }) {
  const { logEvent } = useEvents();
  const [activeTab, setActiveTab]       = useState("base");
  const [baseDraft, setBaseDraft]       = useState(baseResume || "");
  const [updatedDraft, setUpdatedDraft] = useState(updatedResume || "");
  const [baseSaved, setBaseSaved]       = useState(false);
  const [updatedSaved, setUpdatedSaved] = useState(false);

  const saveBase = async () => {
    if (baseDraft.trim().length < 100) return;
    await store.set(KEYS.resume, baseDraft.trim());
    onUpdateBase(baseDraft.trim());
    setBaseSaved(true); setTimeout(() => setBaseSaved(false), 2500);
  };

  const saveUpdated = async () => {
    if (updatedDraft.trim().length < 50) return;
    const changed = updatedDraft.trim() !== (updatedResume || "").trim();
    await store.set(KEYS.updatedResume, updatedDraft.trim());
    onUpdateUpdated(updatedDraft.trim());
    // Count a "tailored resume" win only when the content actually changed, so
    // re-saving the same text doesn't inflate the weekly tally.
    if (changed) logEvent("tailored");
    setUpdatedSaved(true); setTimeout(() => setUpdatedSaved(false), 2500);
  };

  const clearUpdated = async () => {
    await store.set(KEYS.updatedResume, "");
    onUpdateUpdated(""); setUpdatedDraft("");
  };

  return (
    <div style={{ maxWidth: "740px", margin: "0 auto", padding: "48px 24px 0" }}>
      <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 16px" }}>Resume</p>
      <h1 style={{ fontFamily: T.display, fontSize: "clamp(26px,4vw,38px)", color: C.text, fontWeight: 800, letterSpacing: "-0.03em", margin: "0 0 8px" }}>Your Resumes</h1>
      <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 28px" }}>
        Keep your base resume for all new analyses. Paste your edited version to re-score saved jobs and see projected score improvements.
      </p>

      <div style={{ display: "flex", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "4px", gap: "4px", marginBottom: "24px", width: "fit-content" }}>
        {[{ key: "base", label: "Base Resume" }, { key: "updated", label: "Updated Resume", badge: updatedResume?.trim() ? "✓" : null }].map(({ key, label, badge }) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{ padding: "8px 20px", borderRadius: "7px", border: "none", background: activeTab === key ? C.surface2 : "transparent", color: activeTab === key ? C.text : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px" }}>
            {label}
            {badge && <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent }}>{badge}</span>}
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
                <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "6px", background: "#0E1A13", border: `1px solid ${C.accent}33`, borderRadius: "6px", padding: "4px 10px" }}>
                  <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: C.accent }} />
                  <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.1em" }}>SAVED</span>
                </div>
              )}
            </div>
            <Field value={updatedDraft} onChange={setUpdatedDraft} placeholder="Paste your updated resume here..." multiline rows={18} />
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
              Used for all new job analyses. Update it here when you make permanent changes to your resume.
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

// ─── PWA UPDATE TOAST ─────────────────────────────────────────────────────────
function UpdateToast() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div style={{ position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)", background: C.surface, border: `1px solid ${C.accent}44`, borderRadius: "10px", padding: "12px 20px", display: "flex", alignItems: "center", gap: "16px", zIndex: 999, boxShadow: "0 4px 24px #00000066" }}>
      <span style={{ fontFamily: T.body, fontSize: "14px", color: C.textMid }}>New version available</span>
      <button onClick={() => updateServiceWorker(true)} style={{ background: C.accent, color: "#0C0C0B", border: "none", borderRadius: "6px", padding: "6px 14px", fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontWeight: 600 }}>Update</button>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [ready, setReady]               = useState(false);
  const [resume, setResume]             = useState(null);
  const [updatedResume, setUpdatedResume] = useState("");
  const [jobs, setJobs]                 = useState([]);
  const [page, setPage]                 = useState("analyzer");
  const [settingsHint, setSettingsHint] = useState(null);   // e.g. "proxy" — deep-links Settings to a step
  const openSetup = () => { setSettingsHint("proxy"); setPage("settings"); };
  // "Words, not numbers" preference — read synchronously so scores render right
  // on first paint; persisted on change.
  const [wordsMode, setWordsMode]       = useState(() => {
    try { return localStorage.getItem(KEYS.wordsMode) === "1"; } catch { return false; }
  });
  useEffect(() => { store.set(KEYS.wordsMode, wordsMode ? "1" : "0"); }, [wordsMode]);
  // Effort-event log — local only, held in state so counters stay live.
  const [events, setEvents] = useState(() => loadEvents());
  const logEvent = (type, meta) => { appendEvent(type, meta); setEvents(loadEvents()); };
  // Deep link from Path Pursuit: ?job=<id> selects/scrolls to that job.
  const [focusJob, setFocusJob] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("job") || null; } catch { return null; }
  });
  // Jump from the Analyze screen straight to a specific job in the Pipeline.
  const openPipelineJob = (id) => { setFocusJob(null); setTimeout(() => setFocusJob(id), 0); setPage("tracker"); };

  const [storageError, setStorageError] = useState(false);
  const hydrated = useRef(false);

  // ─── Cloud sync state ───────────────────────────────────────────────────────
  const [user, setUser]             = useState(null);       // anonymous Firebase user — invisible to the person using the app
  const [authReady, setAuthReady]   = useState(false);
  const [syncCode, setSyncCode]     = useState(null);        // the code this device is currently linked to
  const [syncStatus, setSyncStatus] = useState("idle");      // idle | syncing | synced | error
  const [linkError, setLinkError]   = useState("");
  // Set right before a remote snapshot writes local state, so the very next
  // push-to-cloud effect run knows to skip — otherwise every remote update
  // would immediately be pushed straight back up.
  const applyingRemote = useRef(false);

  useEffect(() => {
    // Migrate legacy stores into ac_jobs_v1 once, before first read (guarded so
    // it can't run twice, and a no-op if Path Pursuit already migrated).
    migrateJobs();
    Promise.all([store.get(KEYS.resume), store.get(KEYS.jobs), store.get(KEYS.updatedResume)]).then(([r, j, u]) => {
      setResume(r || null);
      let parsed = [];
      try { parsed = j ? JSON.parse(j) : []; } catch { parsed = []; }
      if (!Array.isArray(parsed)) parsed = [];
      setJobs(parsed.map(normalizeJob));
      setUpdatedResume(u || "");
      hydrated.current = true;
      setReady(true);
    });
  }, []);

  // Single write path: whatever `jobs` becomes, it gets persisted (canonical) —
  // after hydration only, so the initial [] never clobbers stored data.
  useEffect(() => {
    if (!hydrated.current) return;
    setStorageError(!store.set(KEYS.jobs, JSON.stringify(jobs.map(normalizeJob))));
  }, [jobs]);

  // Sign in anonymously in the background — no button, no redirect, nothing
  // cross-domain, so this can't hit the browser storage-partitioning issue
  // that broke Google sign-in. This just gives Firestore something to check
  // in its security rules (request.auth != null); the sync code below is
  // what actually identifies which cloud doc this device talks to.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) { signInAnonymously(auth).catch((e) => console.error("anonymous sign-in failed", e)); return; }
      setUser(u);
      setAuthReady(true);
    });
    return unsub;
  }, []);

  // Once we have both an anonymous session and hydrated local data, figure out
  // which sync code this device belongs to. First time ever: mint a new code
  // and seed the cloud with local data. Returning device: pull whatever's in
  // the cloud for that code (cloud wins — that's the point of a second
  // device), then keep a live listener open for updates from elsewhere.
  useEffect(() => {
    if (!user || !hydrated.current) return;
    let unsub = () => {};
    (async () => {
      let code = await store.get(KEYS.syncCode);
      if (!code) {
        code = genSyncCode();
        await store.set(KEYS.syncCode, code);
        await cloud.push(code, { resume, updatedResume, jobs: jobs.map(normalizeJob) });
      } else {
        const remote = await cloud.pullOnce(code);
        if (remote) {
          applyingRemote.current = true;
          if (typeof remote.resume === "string") { setResume(remote.resume); store.set(KEYS.resume, remote.resume); }
          if (typeof remote.updatedResume === "string") { setUpdatedResume(remote.updatedResume); store.set(KEYS.updatedResume, remote.updatedResume); }
          if (Array.isArray(remote.jobs)) setJobs(remote.jobs.map(normalizeJob));
        } else {
          cloud.push(code, { resume, updatedResume, jobs: jobs.map(normalizeJob) });
        }
      }
      setSyncCode(code);
      setSyncStatus("synced");
      unsub = cloud.subscribe(code, (remoteData) => {
        applyingRemote.current = true;
        if (typeof remoteData.resume === "string") { setResume(remoteData.resume); store.set(KEYS.resume, remoteData.resume); }
        if (typeof remoteData.updatedResume === "string") { setUpdatedResume(remoteData.updatedResume); store.set(KEYS.updatedResume, remoteData.updatedResume); }
        if (Array.isArray(remoteData.jobs)) setJobs(remoteData.jobs.map(normalizeJob));
        setSyncStatus("synced");
      });
    })();
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Push local changes up whenever resume/jobs/updatedResume change, as long as
  // the change didn't just come *from* the cloud (see applyingRemote above).
  useEffect(() => {
    if (!syncCode || !hydrated.current) return;
    if (applyingRemote.current) { applyingRemote.current = false; return; }
    setSyncStatus("syncing");
    cloud.push(syncCode, { resume, updatedResume, jobs: jobs.map(normalizeJob) }).then(ok => setSyncStatus(ok ? "synced" : "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, updatedResume, jobs, syncCode]);

  // Called from Settings when the person types in a code from another device.
  // Cloud wins here too — linking a device replaces its local data with
  // whatever's already stored under that code.
  const linkWithCode = async (raw) => {
    const code = normalizeCode(raw);
    if (code.length < 6) { setLinkError("That doesn't look like a full code."); return; }
    const remote = await cloud.pullOnce(code);
    if (!remote) { setLinkError("No data found for that code — check it was typed correctly."); return; }
    applyingRemote.current = true;
    if (typeof remote.resume === "string") { setResume(remote.resume); store.set(KEYS.resume, remote.resume); }
    if (typeof remote.updatedResume === "string") { setUpdatedResume(remote.updatedResume); store.set(KEYS.updatedResume, remote.updatedResume); }
    if (Array.isArray(remote.jobs)) setJobs(remote.jobs.map(normalizeJob));
    await store.set(KEYS.syncCode, code);
    setSyncCode(code);
    setSyncStatus("synced");
    setLinkError("");
  };

  // Functional updates — no stale closures, safe under rapid successive saves.
  const handleSaveJob  = (j)          => setJobs(prev => {
    // Dedupe by id. If this posting is already tracked (e.g. Path Pursuit saved
    // it first, or it was analyzed before), merge new discovery/analysis data
    // but preserve the existing status + appliedAt — InFlow owns those.
    const i = prev.findIndex(p => p.id === j.id);
    if (i === -1) return [j, ...prev];
    const next = prev.slice();
    next[i] = { ...prev[i], ...j, status: prev[i].status, appliedAt: prev[i].appliedAt };
    return next;
  });
  const handleUpdate   = (u)          => setJobs(prev => prev.map(j => j.id === u.id ? u : j));
  const handlePatchJob = (id, patch)  => setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j));
  const handleDelete   = (id)         => setJobs(prev => prev.filter(j => j.id !== id));
  const handleAdd      = (j)          => setJobs(prev => [j, ...prev]);
  const handleResume        = (r) => setResume(r);
  const handleUpdatedResume = (r) => setUpdatedResume(r);
  const handleOnboard       = (r) => { setResume(r); setPage("analyzer"); };

  // If deep-linked to a specific job, land on the pipeline once loaded.
  useEffect(() => { if (ready && resume && focusJob) setPage("tracker"); }, [ready, resume, focusJob]);

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
   <WordsCtx.Provider value={wordsMode}>
    <EventsCtx.Provider value={{ events, logEvent }}>
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: "80px" }}>
      <style>{GLOBAL_CSS}</style>

      <nav style={{ borderBottom: `1px solid ${C.border}`, padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: `${C.bg}f0`, backdropFilter: "blur(20px)", zIndex: 50, height: "56px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <svg width="24" height="24" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
            <rect width="48" height="48" rx="10" fill={C.bg} stroke={C.border2} strokeWidth="2"/>
            <path d="M7 35 C16 35 15 23 24 22 C33 21 32 14 38 13" fill="none" stroke={C.accent} strokeWidth="3.5" strokeLinecap="round" opacity="0.45"/>
            <path d="M7 35 C16 35 15 23 24 22" fill="none" stroke={C.accent} strokeWidth="3.5" strokeLinecap="round"/>
            <circle cx="38" cy="13" r="4.5" fill={C.accent}/>
          </svg>
          <span style={{ fontFamily: T.display, fontSize: "18px", color: C.text, fontWeight: 800, letterSpacing: "-0.02em" }}>inflow</span>
        </div>

        <div style={{ display: "flex", gap: "3px" }}>
          {NAV.map(({ key, label, badge }) => (
            <button key={key} className="tap" onClick={() => setPage(key)} style={{ padding: "7px 18px", borderRadius: "7px", background: page === key ? C.surface : "transparent", border: `1px solid ${page === key ? C.border2 : "transparent"}`, color: page === key ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", position: "relative", transition: "all 0.15s", display: "flex", alignItems: "center", gap: "5px" }}>
              {label}
              {badge && <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent }}>{badge}</span>}
              {key === "tracker" && pending > 0 && (
                <span style={{ position: "absolute", top: "-4px", right: "-4px", width: "16px", height: "16px", borderRadius: "50%", background: C.yellow, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono, fontSize: "10px", color: "#000", fontWeight: 700 }}>{pending}</span>
              )}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            onClick={() => setWordsMode(w => !w)}
            title="Show plain-language labels instead of numeric scores"
            aria-pressed={wordsMode}
            style={{ display: "flex", alignItems: "center", gap: "7px", padding: "5px 11px", borderRadius: "20px", cursor: "pointer", background: wordsMode ? C.accentDim : "transparent", border: `1px solid ${wordsMode ? C.accent : C.border2}`, color: wordsMode ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "10px", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>
            <span style={{ width: "22px", height: "13px", borderRadius: "8px", background: wordsMode ? C.accent : C.border2, position: "relative", flexShrink: 0, transition: "background 0.15s" }}>
              <span style={{ position: "absolute", top: "2px", left: wordsMode ? "11px" : "2px", width: "9px", height: "9px", borderRadius: "50%", background: wordsMode ? "#04120A" : C.textDim, transition: "left 0.15s" }} />
            </span>
            Words, not numbers
          </button>
          <div className="nav-status" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: C.accent, boxShadow: `0 0 8px ${C.accent}` }} />
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, letterSpacing: "0.08em", textTransform: "uppercase" }}>Resume Active</span>
          </div>
        </div>
      </nav>

      {storageError && (
        <div style={{ position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)", zIndex: 200, background: "#1D100E", border: `1px solid ${C.red}`, borderRadius: "10px", padding: "10px 18px", fontFamily: T.mono, fontSize: "11px", color: C.red, letterSpacing: "0.04em", maxWidth: "90vw", display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
          <span>Storage full — latest changes were NOT saved.</span>
          <button
            onClick={() => setJobs(prev => prev.map(j => j.status === "rejected" && j.analysis ? { ...j, analysis: "" } : j))}
            style={{ background: "transparent", border: `1px solid ${C.red}66`, borderRadius: "6px", padding: "4px 10px", fontFamily: T.mono, fontSize: "11px", color: C.red, cursor: "pointer", letterSpacing: "0.04em" }}>
            Free up space (clears analysis text from rejected jobs)
          </button>
        </div>
      )}

      {page === "analyzer" && <AnalyzerPage resume={resume} onSaveJob={handleSaveJob} onPatchJob={handlePatchJob} onOpenSetup={openSetup} jobs={jobs} onOpenJob={openPipelineJob} />}
      {page === "tracker"  && <TrackerPage  jobs={jobs} onUpdateJob={handleUpdate} onDeleteJob={handleDelete} onAddJob={handleAdd} updatedResume={updatedResume} focusId={focusJob} resume={resume} onOpenSetup={openSetup} onOpenResume={() => setPage("resumes")} onOpenAnalyze={() => setPage("analyzer")} />}
      {page === "resumes"  && <ResumePage   baseResume={resume} updatedResume={updatedResume} onUpdateBase={handleResume} onUpdateUpdated={handleUpdatedResume} />}
      {page === "settings" && <SettingsPage resume={resume} onUpdateResume={handleResume} authReady={authReady} syncCode={syncCode} syncStatus={syncStatus} linkError={linkError} onLinkCode={linkWithCode} hint={settingsHint} onHintConsumed={() => setSettingsHint(null)} />}
      <UpdateToast />
    </div>
    </EventsCtx.Provider>
   </WordsCtx.Provider>
  );
}
// ─── ONBOARDING ───────────────────────────────────────────────────────────────
function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const [resume, setResume] = useState("");
  const [key, setKey] = useState("");
  const charOk = resume.trim().length >= 100;
  const keyOk = key.trim().startsWith("sk-ant-");

  const saveResume = async () => {
    if (!charOk) return;
    await store.set(KEYS.resume, resume.trim());
    setStep(2);
  };

  const finishWithKey = () => {
    if (!keyOk) return;
    store.set(KEYS.apiKey, key.trim());
    onComplete(resume.trim());
  };

  const finishWithoutKey = () => onComplete(resume.trim());

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <div style={{ width: "100%", maxWidth: "580px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "56px" }}>
          <svg width="30" height="30" viewBox="0 0 48 48">
            <rect width="48" height="48" rx="10" fill={C.bg} stroke={C.border2} strokeWidth="2"/>
            <path d="M7 35 C16 35 15 23 24 22 C33 21 32 14 38 13" fill="none" stroke={C.accent} strokeWidth="3.5" strokeLinecap="round" opacity="0.45"/>
            <path d="M7 35 C16 35 15 23 24 22" fill="none" stroke={C.accent} strokeWidth="3.5" strokeLinecap="round"/>
            <circle cx="38" cy="13" r="4.5" fill={C.accent}/>
          </svg>
          <span style={{ fontFamily: T.display, fontSize: "22px", color: C.text, fontWeight: 800, letterSpacing: "-0.02em" }}>inflow</span>
        </div>

        {step === 0 && (
          <div>
            <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.18em", textTransform: "uppercase", margin: "0 0 18px" }}>Welcome</p>
            <h1 style={{ fontFamily: T.display, fontSize: "clamp(36px,6vw,56px)", color: C.text, fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.03em", margin: "0 0 22px" }}>
              Simulate how<br /><span style={{ color: C.accent }}>recruiters see you.</span>
            </h1>
            <p style={{ fontFamily: T.body, fontSize: "16px", color: C.textMid, lineHeight: 1.8, margin: "0 0 36px" }}>
              inflow simulates the internal hiring discussion that determines whether a candidate advances — not a resume scorer, not a keyword checker. A real evaluation of whether you'd get the interview.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "40px" }}>
              {[
                "Dual recruiter + hiring manager scoring against the actual applicant pool",
                "Honest hiring decision: Yes / No / Conditional — with specific reasoning",
                "Resume improvements you can genuinely defend in an interview",
                "Interview risk assessment: the questions they'll actually ask",
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
            <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.18em", textTransform: "uppercase", margin: "0 0 18px" }}>Setup — Step 1 of 2</p>
            <h2 style={{ fontFamily: T.display, fontSize: "34px", color: C.text, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 12px" }}>Paste your resume.</h2>
            <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 24px" }}>
              Plain text is fine — copy from Word, Google Doc, or PDF. Include your summary, experience, education, and skills. inflow references this for every job you analyze. Update it anytime in Settings.
            </p>
            <div style={{ marginBottom: "20px" }}>
              <Field value={resume} onChange={setResume} placeholder="Paste your full resume here..." multiline rows={14} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <Btn onClick={saveResume} disabled={!charOk}>Save Resume →</Btn>
              <span style={{ fontFamily: T.mono, fontSize: "11px", color: charOk ? C.accent : C.textDim }}>
                {resume.trim().length} chars {charOk ? "✓ ready" : `— need ${100 - resume.trim().length} more`}
              </span>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.18em", textTransform: "uppercase", margin: "0 0 18px" }}>Setup — Step 2 of 2</p>
            <h2 style={{ fontFamily: T.display, fontSize: "34px", color: C.text, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 12px" }}>Connect your API key.</h2>
            <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 20px" }}>
              inflow runs on your own Anthropic API key — you pay Anthropic directly, roughly <span style={{ color: C.text }}>$0.05–0.15 per analysis</span>, no subscription. Create a key at{" "}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a> (takes about a minute), then paste it below.
            </p>
            <div style={{ marginBottom: "16px" }}>
              <Field value={key} onChange={setKey} placeholder="sk-ant-..." type="password" mono />
            </div>
            <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, letterSpacing: "0.04em", lineHeight: 1.7, margin: "0 0 24px" }}>
              Stored only in this browser. Your key and resume are never sent anywhere except directly to Anthropic's API. Tip: set a monthly spend cap on the key.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
              <Btn onClick={finishWithKey} disabled={!keyOk}>Save Key & Launch →</Btn>
              <Btn onClick={finishWithoutKey} variant="ghost">Skip for now — explore with a sample →</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
