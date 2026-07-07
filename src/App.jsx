import { useState, useRef, useEffect } from "react";
import { useRegisterSW } from 'virtual:pwa-register/react';
import { auth, googleProvider, db } from "./firebase";
import { onAuthStateChanged, signInWithRedirect, getRedirectResult, signOut } from "firebase/auth";
import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";

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
  textMid:   "#C6C6BE",
  textSub:   "#9C9D93",
  textDim:   "#85867B",
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
  jobs:         "inflow_jobs_v2",
  apiKey:       "inflow_api_key",
  proxyUrl:     "inflow_proxy_url",
  updatedResume:"inflow_resume_updated",
};
const store = {
  get: async (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  // Returns true on success, false on failure (e.g. QuotaExceededError).
  // Callers MUST check the result — a silent failure here means jobs vanish on reload.
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

// ─── CLOUD SYNC (Firebase) ────────────────────────────────────────────────────
// localStorage stays the source of truth for instant load / offline use. When
// signed in, we additionally mirror {resume, jobs, updatedResume} to a single
// Firestore doc keyed by uid, so other computers signed into the same account
// pick up the same pipeline. Conflicts are resolved last-write-wins via
// `updatedAt` (client timestamp) — fine for a single-user tool used on a
// handful of personal devices, not built for concurrent multi-user editing.
const cloud = {
  docRef: (uid) => doc(db, "users", uid),
  push: async (uid, data) => {
    try {
      await setDoc(cloud.docRef(uid), { ...data, updatedAt: Date.now() }, { merge: true });
      return true;
    } catch (e) {
      console.error("cloud sync push failed", e);
      return false;
    }
  },
  pullOnce: async (uid) => {
    try {
      const snap = await getDoc(cloud.docRef(uid));
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      console.error("cloud sync pull failed", e);
      return null;
    }
  },
  // Real-time listener — picks up changes made on another signed-in device
  // without needing a manual refresh.
  subscribe: (uid, cb) => onSnapshot(cloud.docRef(uid), (snap) => {
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

const scoreColor = (s) =>
  s === null || s === undefined ? C.textDim : s >= 7 ? C.accent : s >= 5 ? C.yellow : C.red;

const scoreLabel = (s) => {
  if (s === null || s === undefined) return "";
  if (s >= 8.5) return "Top-priority";
  if (s >= 7.5) return "Strong fit";
  if (s >= 6.5) return "Viable";
  if (s >= 5.5) return "Stretch";
  if (s >= 4.5) return "Low priority";
  return "Not recommended";
};

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
    const mitigation = entry.match(/MITIGATION:\s*([\s\S]*?)(?=RISK \d|$)/i)?.[1]?.trim();
    if (name) risks.push({ name, why, likelihood, teachability, mitigation });
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
      const why      = b.match(/WHY IT WORKS:\s*([\s\S]*?)(?=ESTIMATED LIFT:|IMPROVEMENT \d+:|$)/i)?.[1]?.trim().split("---")[0].trim();
      const lift     = b.match(/ESTIMATED LIFT:\s*(\+?\s*\d+\s*%[^\n]*)/i)?.[1]?.trim();
      return current ? { current, problem, improved, why, lift } : null;
    }).filter(Boolean);
};

// Fallback: parse old EDIT format
const parseEdits = (text) => {
  return [...text.matchAll(/EDIT \d+:([\s\S]*?)(?=EDIT \d+:|## STEP 7|## STEP 6|$)/g)]
    .map(m => {
      const b = m[1];
      const orig = b.match(/ORIGINAL:\s*([\s\S]*?)(?=SUGGESTED:|$)/i)?.[1]?.trim();
      const sugg = b.match(/SUGGESTED:\s*([\s\S]*?)(?=WHY:|$)/i)?.[1]?.trim();
      const why  = b.match(/WHY:\s*([\s\S]*?)(?=EDIT \d+:|$)/i)?.[1]?.trim();
      return orig && sugg ? { current: orig, improved: sugg, why, issue: "" } : null;
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
3. Run this exact analysis. Use ## headers for each step exactly as shown:

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

[2–3 sentences in plain recruiter language: Would you send this resume to the HM today? What is the single biggest concern stopping you? What is the strongest piece of evidence in their favor?]

Biggest concern: [one sentence — the one thing that could kill this application]
Strongest selling point: [one sentence — the one thing that makes this candidate stand out]
Smallest truthful change that increases interview probability: [one specific, actionable edit]
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

## STEP 4 — HIRING RISKS
List exactly 3 hiring risks — gaps between what this role needs and what this resume shows. For each:

RISK 1: [name the gap — be specific]
WHY IT MATTERS: [one sentence — tie directly to a stated or implied job requirement]
LIKELIHOOD: [Low / Medium / High — how likely this gap is to affect the hiring decision]
TEACHABILITY: [Already Demonstrated / Transferable / Learnable / Critical Gap — only true deal-breakers are Critical Gap]
MITIGATION: [one sentence — what this candidate can realistically do to address this before or during the interview]

RISK 2: [name the gap]
WHY IT MATTERS: [why it matters]
LIKELIHOOD: [likelihood level]
TEACHABILITY: [teachability class]
MITIGATION: [mitigation]

RISK 3: [name the gap]
WHY IT MATTERS: [why it matters]
LIKELIHOOD: [likelihood level]
TEACHABILITY: [teachability class]
MITIGATION: [mitigation]

## STEP 5 — RESUME IMPROVEMENTS
Exactly 5 specific, high-impact edits, RANKED highest-ROI first (largest estimated interview-probability increase at the top). Only recommend changes the candidate can genuinely defend in an interview. Do not invent experience. Optimize for clarity, recruiter readability, and ATS alignment — in that order. Format each exactly like this:

IMPROVEMENT 1:
CURRENT: [exact text from their resume — or "Missing — not present on resume" if absent]
ISSUE: [what is wrong or weak — be specific, no generic advice]
IMPROVED: [your rewrite — strong verb, specific outcome, natural keyword integration]
WHY IT WORKS: [one sentence — tied to this specific role, not general resume advice]
ESTIMATED LIFT: [+X% — realistic estimated increase in interview probability from this single change]

IMPROVEMENT 2:
CURRENT: [current text or "Missing"]
ISSUE: [the issue]
IMPROVED: [rewrite]
WHY IT WORKS: [why it matters for this role]
ESTIMATED LIFT: [+X%]

IMPROVEMENT 3:
CURRENT: [current text or "Missing"]
ISSUE: [the issue]
IMPROVED: [rewrite]
WHY IT WORKS: [why]
ESTIMATED LIFT: [+X%]

IMPROVEMENT 4:
CURRENT: [current text or "Missing"]
ISSUE: [the issue]
IMPROVED: [rewrite]
WHY IT WORKS: [why]
ESTIMATED LIFT: [+X%]

IMPROVEMENT 5:
CURRENT: [current text or "Missing"]
ISSUE: [the issue]
IMPROVED: [rewrite]
WHY IT WORKS: [why]
ESTIMATED LIFT: [+X%]

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
const SAMPLE_JOB_ANALYSIS = `## STEP 0 — JOB METADATA
JOB_TITLE: Business Analyst II
COMPANY: Meridian Health Systems
LOCATION: San Diego, CA (Hybrid)

## STEP 1 — EXECUTIVE SUMMARY
- Recruiter Confidence: 7/10 — Operations background reads as a credible analyst pivot; a recruiter would screen this despite the title gap.
- Hiring Manager Score: 6/10 — Would trust this person to run a requirements-gathering session; would worry about SQL depth on day one.
- Transferability: 8/10 — Process improvement, stakeholder coordination, and reporting map cleanly onto the core analyst competencies.
- ATS Alignment: Medium — approximately 60% keyword match (one input only)
- Interview Probability: 55%
- Overall Recommendation: Apply with Tailoring

## STEP 1B — FULL SCORECARD
SCORE: Overall Fit | 7/10 | Core operations competencies line up; the only real distance is the analyst title and SQL.
SCORE: ATS Match | 6/10 | Missing SQL/Tableau keywords cost literal match points the human read recovers.
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

Biggest concern: No explicit data-analysis toolkit — the JD lists SQL as required and this resume doesn't mention it.
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

## STEP 4 — HIRING RISKS
RISK 1: No SQL or BI tooling on the resume
WHY IT MATTERS: The posting lists SQL as required and Tableau as preferred — a keyword screen may reject this resume before a human reads it.
LIKELIHOOD: High
TEACHABILITY: Learnable
MITIGATION: Add a skills line for any real exposure (queries run, dashboards consumed) and start a two-week SQL fundamentals course to make the interview claim honest.

RISK 2: Title history reads "coordinator," not "analyst"
WHY IT MATTERS: Recruiters pattern-match on titles first; the gap forces them to infer the analyst work instead of seeing it.
LIKELIHOOD: Medium
TEACHABILITY: Transferable
MITIGATION: Reframe section headers and bullet verbs around analysis and requirements rather than coordination and support.

RISK 3: No direct healthcare-payer domain experience
WHY IT MATTERS: The JD mentions claims-processing workflows twice, and competing applicants from payer backgrounds will have the vocabulary cold.
LIKELIHOOD: Medium
TEACHABILITY: Learnable
MITIGATION: Learn the basic claims lifecycle before the phone screen and connect the regulated-manufacturing compliance parallel explicitly when asked.

## STEP 5 — RESUME IMPROVEMENTS
IMPROVEMENT 1:
CURRENT: Coordinated cross-functional projects across manufacturing and quality teams
ISSUE: "Coordinated" is a scheduling verb — it hides the analysis this role is hiring for.
IMPROVED: Analyzed cross-functional production workflows across manufacturing and quality teams, identifying bottlenecks that cut changeover time 18%
WHY IT WORKS: Leads with the analyst verb the JD repeats and lands the metric inside the first line the recruiter reads.
ESTIMATED LIFT: +5%

IMPROVEMENT 2:
CURRENT: Missing — not present on resume
ISSUE: The posting requires requirements documentation and this resume never uses the phrase, even though the work happened.
IMPROVED: Gathered and documented business requirements from 4 stakeholder groups for a line-transfer project delivered on schedule
WHY IT WORKS: Puts the exact required phrase on the page attached to a real, defensible project.
ESTIMATED LIFT: +4%

IMPROVEMENT 3:
CURRENT: Proficient in Microsoft Excel
ISSUE: Undifferentiated — every applicant says this, and it wastes the skills line the ATS reads first.
IMPROVED: Excel (pivot tables, lookups, capacity models); SQL fundamentals (in progress)
WHY IT WORKS: Specificity converts a filler line into keyword coverage the screen is checking for.
ESTIMATED LIFT: +3%

IMPROVEMENT 4:
CURRENT: Responsible for daily production reporting
ISSUE: "Responsible for" states a duty, not an outcome, and buries a genuinely relevant deliverable.
IMPROVED: Built daily production reports used by 3 department leads to reallocate staffing, reducing overtime spend 12%
WHY IT WORKS: Turns passive reporting into decision-support — which is this job's actual function.
ESTIMATED LIFT: +2%

IMPROVEMENT 5:
CURRENT: Objective: Seeking a challenging business analyst position
ISSUE: Objective statements spend prime real estate telling the recruiter what you want instead of what they get.
IMPROVED: Operations professional with 5 years translating production data into process improvements across regulated manufacturing — moving that toolkit into business analysis.
WHY IT WORKS: A summary that names the transition directly disarms the title-gap concern before the recruiter forms it.
ESTIMATED LIFT: +2%

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

Reason: The strongest asset (evidenced process improvement) and the weakest point (missing analysis toolkit) are both unambiguous, and neither would change without new information. The recommendation is stable: this is a qualified stretch that tailoring meaningfully improves.`;

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ::placeholder { color: #85867B !important; opacity: 0.75; }
  textarea, input { color: #F5F4F0 !important; font-family: 'Inter', sans-serif; }
  input[type=date] { color-scheme: dark; }
  input[type=date]::-webkit-calendar-picker-indicator { filter: invert(0.5) sepia(1) hue-rotate(80deg); }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #35352F; border-radius: 2px; }
  select option { background: #141412; color: #F5F4F0; }
  a { color: ${C.blue}; }
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
    <button onClick={!disabled ? onClick : undefined} style={{ ...vars[variant], padding: pad, borderRadius: "7px", fontFamily: T.mono, fontSize: fz, letterSpacing: "0.08em", textTransform: "uppercase", cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600, transition: "opacity 0.15s" }}>
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
const STEP_LABELS = {
  "STEP 1B": "Full Scorecard",
  "STEP 1": "Executive Summary",
  "STEP 2": "Hiring Decision",
  "STEP 3": "Strengths & Transferable Experience",
  "STEP 4": "Hiring Risks",
  "STEP 5": "Resume Improvements",
  "STEP 6": "Interview Risk",
  "STEP 7": "Honest Verdict",
  "STEP 8": "Decision Confidence",
};

function StepAccordion({ text }) {
  const [open, setOpen] = useState(null);
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

  lines.forEach((line, i) => {
    if (line.startsWith("### ")) {
      flushBullets();
      elements.push(<h3 key={i} style={{ fontFamily: T.display, fontSize: "16px", color: C.text, margin: "18px 0 6px", fontWeight: 700, lineHeight: 1.4, paddingBottom: "6px", borderBottom: `1px solid ${C.border}` }}>{line.slice(4)}</h3>);
    } else if (/^IMPROVEMENT \d+:/.test(line)) {
      flushBullets();
      elements.push(<p key={i} style={{ fontFamily: T.mono, fontSize: "12px", color: C.accent, margin: "20px 0 6px", letterSpacing: "0.06em", fontWeight: 500 }}>{line}</p>);
    } else if (/^EDIT \d+:/.test(line)) {
      flushBullets();
      elements.push(<p key={i} style={{ fontFamily: T.mono, fontSize: "12px", color: C.accent, margin: "20px 0 6px", letterSpacing: "0.06em", fontWeight: 500 }}>{line}</p>);
    } else if (line.startsWith("CURRENT:") || line.startsWith("ORIGINAL:")) {
      flushBullets();
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
      bulletBuffer.push(line.slice(2).replace(/\*\*(.*?)\*\*/g, (_, t) => t));
    } else if (line.trim() === "") {
      flushBullets();
      elements.push(<div key={i} style={{ height: "8px" }} />);
    } else if (line.startsWith("|")) {
      flushBullets();
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

// ─── ANALYZER PAGE ────────────────────────────────────────────────────────────
function AnalyzerPage({ resume, onSaveJob, onPatchJob }) {
  const [mode, setMode]             = useState("url");
  const [input, setInput]           = useState("");
  const [result, setResult]         = useState("");
  const [loading, setLoading]       = useState(false);
  const [phase, setPhase]           = useState("idle");
  const [phaseIdx, setPhaseIdx]     = useState(0);
  const [error, setError]           = useState("");
  const [tone, setTone]             = useState("recruiter");
  const [scores, setScores]         = useState({ recruiter: null, hm: null });
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
  const [isDemo, setIsDemo]         = useState(false);
  const resultRef      = useRef(null);
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

    setLoading(true); setResult(""); setPhase("loading"); setPhaseIdx(0); setError("");
    setScores({ recruiter: null, hm: null }); setScorecard([]); setTier(null); setOdds(null);
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
        jobDescription:      isUrl(input) ? "" : input.trim().slice(0, 8000),
      };

      if (savedJobIdRef.current) {
        // Same input re-analyzed (tone toggle / retry) — refresh the existing
        // pipeline entry rather than creating a duplicate.
        onPatchJob(savedJobIdRef.current, {
          title: autoTitle, company: autoCompany,
          recruiterScore: parsedScores.recruiter, hmScore: parsedScores.hm,
          tier: parsedTier?.label || null, analysis: text,
          ...listing,
        });
      } else {
        const id = uid();
        savedJobIdRef.current = id;
        const t2 = now();
        onSaveJob({
          id, title: autoTitle, company: autoCompany,
          url: isUrl(input) ? input.trim() : "", status: "saved",
          recruiterScore: parsedScores.recruiter, hmScore: parsedScores.hm,
          tier: parsedTier?.label || null,
          notes: "", analysis: text, dateAdded: t2, dateSaved: t2,
          dateApplied: null, dateScreen: null, dateInterview: null,
          dateOffer: null, dateRejected: null,
          ...listing,
        });
      }

      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 200);
    } catch (err) {
      clearInterval(interval);
      const msg = err.message || "Something went wrong.";
      setError(msg.includes("fetch") ? "Network error — check your connection and try again." : msg);
      setPhase("idle");
    }
    setLoading(false);
  };

  const runDemo = () => {
    const text = SAMPLE_JOB_ANALYSIS;
    const s = parseScores(text);
    setResult(text);
    setScores(s);
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
    setIsDemo(false);
    setInput(""); setResult(""); setPhase("idle"); setError("");
    setScores({ recruiter: null, hm: null }); setScorecard([]); setTier(null); setOdds(null);
    setDecision(null); setStrengths([]); setTransferable([]); setTechnical([]); setLeadership([]); setRisks([]); setImprovements([]);
    setInterviewRisk([]); setVerdict(null); setConfidence(null); setShowFull(false);
  };

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
          {error && (
            <div style={{ margin: "0 20px 20px", padding: "12px 16px", background: "#1D100E", border: `1px solid ${C.red}44`, borderRadius: "8px" }}>
              <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.red, margin: 0 }}>⚠ {error}</p>
            </div>
          )}
          <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {!localStorage.getItem(KEYS.apiKey)
              ? <button onClick={runDemo} style={{ background: "transparent", border: "none", color: C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.06em", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "3px", padding: 0 }}>No API key yet? View a sample analysis →</button>
              : <span />}
            <Btn onClick={() => analyze()} disabled={loading || input.trim().length < 10}>
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
        <div ref={resultRef} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>

          {/* User bubble */}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "18px 18px 4px 18px", padding: "12px 18px", maxWidth: "80%" }}>
              <p style={{ fontFamily: T.mono, fontSize: "12px", color: C.textSub, margin: 0, wordBreak: "break-all", lineHeight: 1.5 }}>
                {input.trim().slice(0, 120)}{input.trim().length > 120 ? "..." : ""}
              </p>
            </div>
          </div>

          {/* Score + Tier */}
          <ScoreTierBubble scores={scores} tier={tier} odds={odds} tone={tone} onToneChange={handleToneChange} isDemo={isDemo} />

          {/* Full explained scorecard */}
          <ScorecardBubble scorecard={scorecard} />

          {/* Hiring Decision */}
          <HiringDecisionBubble decision={decision} />

          {/* Strengths + Risks */}
          <StrengthsRisksBubble strengths={strengths} transferable={transferable} technical={technical} leadership={leadership} risks={risks} />

          {/* Resume Improvements */}
          <ImprovementsBubble improvements={improvements} />

          {/* Interview Risk */}
          <InterviewRiskBubble questions={interviewRisk} />

          {/* Honest Verdict */}
          <VerdictBubble verdict={verdict} />

          {/* Decision Confidence */}
          <DecisionConfidenceBubble confidence={confidence} />

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

// ─── RESULT BUBBLE WRAPPER ────────────────────────────────────────────────────
const ResultBubble = ({ children, style }) => (
  <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
    <InflowAvatar />
    <div style={{ flex: 1, ...style }}>{children}</div>
  </div>
);

// ─── SCORE + TIER BUBBLE ──────────────────────────────────────────────────────
function ScoreTierBubble({ scores, tier, odds, tone, onToneChange, isDemo }) {
  const impactColor = (pct) => pct >= 50 ? C.accent : pct >= 20 ? C.yellow : C.red;

  return (
    <ResultBubble>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>

        {/* Scores row */}
        <div style={{ display: "flex", gap: "10px" }}>
          {[{ label: "Recruiter Confidence", score: scores.recruiter }, { label: "Hiring Mgr Score", score: scores.hm }, { label: "Transferability", score: scores.transferability }].map(({ label, score }) => (
            <div key={label} style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "14px 16px" }}>
              <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 6px" }}>{label}</p>
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
function ScorecardBubble({ scorecard }) {
  const [open, setOpen] = useState(false);
  if (!scorecard?.length) return null;
  return (
    <ResultBubble>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "4px 18px 18px 18px", overflow: "hidden" }}>
        <button onClick={() => setOpen(o => !o)} style={{ width: "100%", padding: "14px 18px", background: "transparent", border: "none", borderBottom: open ? `1px solid ${C.border}` : "none", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "3px", height: "12px", background: C.accent, borderRadius: "2px" }} />
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>Full Scorecard</span>
            <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim }}>{scorecard.length} metrics</span>
          </div>
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>{open ? "▲ Hide" : "▼ Show"}</span>
        </button>
        {open && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {scorecard.map((m, i) => (
              <div key={i} style={{ padding: "12px 18px", borderBottom: i < scorecard.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "6px" }}>
                  <span style={{ fontFamily: T.body, fontSize: "13px", color: C.text, fontWeight: 600 }}>{m.name}</span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "3px", flexShrink: 0 }}>
                    <span style={{ fontFamily: T.display, fontSize: "18px", color: scoreColor(m.score), fontWeight: 800, lineHeight: 1 }}>{m.score}</span>
                    <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim }}>/10</span>
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
    </ResultBubble>
  );
}

// ─── HIRING DECISION BUBBLE ───────────────────────────────────────────────────
function HiringDecisionBubble({ decision }) {
  if (!decision) return null;
  const { verdict, reasoning, concern, selling, smallest, doNotChange } = decision;

  const verdictStyle = verdict === "Yes"
    ? { color: C.accent, bg: "#0E1A13", border: C.accent }
    : verdict === "No"
    ? { color: C.red, bg: "#1D100E", border: C.red }
    : { color: C.yellow, bg: "#1C1808", border: C.yellow };

  return (
    <ResultBubble>
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
    </ResultBubble>
  );
}

// ─── STRENGTHS + RISKS BUBBLE ─────────────────────────────────────────────────
function StrengthsRisksBubble({ strengths, transferable, technical, leadership, risks }) {
  const allStrengths = strengths || [];
  const allTransferable = transferable || [];
  const techList = technical || [];
  const leadList = leadership || [];
  const hasTransferable = allTransferable.length > 0;
  const tabs = [
    { key: "strengths",    label: "Strengths",    color: C.accent },
    ...(hasTransferable ? [{ key: "transferable", label: "Transferable", color: C.blue }] : []),
    { key: "risks",        label: "Hiring Risks", color: C.orange },
  ];
  const [tab, setTab] = useState("strengths");
  if (!allStrengths.length && !risks?.length) return null;

  const likelihoodColor = (l) => l === "High" ? C.red : l === "Medium" ? C.yellow : C.mint;

  return (
    <ResultBubble>
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
                    {r.teachability && (() => {
                      const tc = { "already demonstrated": C.accent, "transferable": C.blue, "learnable": C.yellow, "critical gap": C.red }[r.teachability.toLowerCase()] || C.textSub;
                      return (
                        <span style={{ fontFamily: T.mono, fontSize: "10px", color: tc, background: `${tc}15`, border: `1px solid ${tc}33`, borderRadius: "4px", padding: "3px 8px", letterSpacing: "0.06em" }}>
                          {r.teachability.toUpperCase()}
                        </span>
                      );
                    })()}
                    {r.likelihood && (
                      <span style={{ fontFamily: T.mono, fontSize: "10px", color: likelihoodColor(r.likelihood), background: `${likelihoodColor(r.likelihood)}15`, border: `1px solid ${likelihoodColor(r.likelihood)}33`, borderRadius: "4px", padding: "3px 8px", letterSpacing: "0.08em" }}>
                        {r.likelihood.toUpperCase()} LIKELIHOOD
                      </span>
                    )}
                  </div>
                </div>
                {r.why && <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: "0 0 8px", lineHeight: 1.65, paddingLeft: "11px" }}>{r.why}</p>}
                {r.mitigation && (
                  <div style={{ paddingLeft: "11px" }}>
                    <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.mint, letterSpacing: "0.1em", margin: "0 0 3px" }}>MITIGATION</p>
                    <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: 0, lineHeight: 1.6 }}>{r.mitigation}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </ResultBubble>
  );
}

// ─── RESUME IMPROVEMENTS BUBBLE ───────────────────────────────────────────────
function ImprovementsBubble({ improvements }) {
  const [active, setActive] = useState(0);
  if (!improvements?.length) return null;
  const imp = improvements[active];

  return (
    <ResultBubble>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "4px 18px 18px 18px", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "3px", height: "12px", background: C.accent, borderRadius: "2px" }} />
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>Resume Improvements</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {imp?.lift && (
              <span title="Estimated increase in interview probability" style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, background: `${C.accent}18`, border: `1px solid ${C.accent}44`, borderRadius: "4px", padding: "3px 8px", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{imp.lift.replace(/\s+/g, "")}</span>
            )}
            <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>{active + 1} / {improvements.length}</span>
            <button onClick={() => setActive(a => Math.max(0, a - 1))} disabled={active === 0} aria-label="Previous improvement" style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "5px", padding: "3px 10px", color: active === 0 ? C.textDim : C.textSub, cursor: active === 0 ? "default" : "pointer", fontFamily: T.mono, fontSize: "11px" }}>←</button>
            <button onClick={() => setActive(a => Math.min(improvements.length - 1, a + 1))} disabled={active === improvements.length - 1} aria-label="Next improvement" style={{ background: "transparent", border: `1px solid ${C.border2}`, borderRadius: "5px", padding: "3px 10px", color: active === improvements.length - 1 ? C.textDim : C.textSub, cursor: active === improvements.length - 1 ? "default" : "pointer", fontFamily: T.mono, fontSize: "11px" }}>→</button>
          </div>
        </div>

        {/* Content */}
        {imp && (
          <div>
            {imp.current && (
              <div style={{ padding: "14px 18px", background: "#150a0a", borderBottom: `1px solid ${C.border}` }}>
                <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.red, letterSpacing: "0.1em", margin: "0 0 6px", opacity: 0.8 }}>CURRENT</p>
                <p style={{ fontFamily: T.body, fontSize: "14px", color: "#FCA5A5", margin: 0, lineHeight: 1.7 }}>{imp.current}</p>
              </div>
            )}
            {(imp.problem || imp.issue) && (
              <div style={{ padding: "10px 18px", background: "#1a1400", borderBottom: `1px solid ${C.border}` }}>
                <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.yellow, letterSpacing: "0.1em", margin: "0 0 4px", opacity: 0.8 }}>ISSUE</p>
                <p style={{ fontFamily: T.body, fontSize: "13px", color: C.yellow, margin: 0, lineHeight: 1.6, opacity: 0.9 }}>{imp.problem || imp.issue}</p>
              </div>
            )}
            {imp.improved && (
              <div style={{ padding: "14px 18px", background: "#0a150a", borderBottom: `1px solid ${C.border}` }}>
                <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent, letterSpacing: "0.1em", margin: "0 0 6px", opacity: 0.8 }}>IMPROVED</p>
                <p style={{ fontFamily: T.body, fontSize: "14px", color: C.mint, margin: 0, lineHeight: 1.7 }}>{imp.improved}</p>
              </div>
            )}
            <div style={{ padding: "12px 18px", background: C.surface2, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
              <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, margin: 0, lineHeight: 1.6, fontStyle: "italic", flex: 1 }}>↳ {imp.why || "Stronger signal for this specific role"}</p>
              <button onClick={() => navigator.clipboard?.writeText(imp.improved || "")} style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "6px", padding: "6px 14px", fontFamily: T.mono, fontSize: "11px", color: C.accent, cursor: "pointer", letterSpacing: "0.08em", flexShrink: 0 }}>Copy ↗</button>
            </div>
          </div>
        )}

        {/* Dots */}
        <div style={{ padding: "10px 18px", display: "flex", gap: "6px", justifyContent: "center" }}>
          {improvements.map((_, i) => (
            <button key={i} onClick={() => setActive(i)} aria-label={`Go to improvement ${i + 1}`} style={{ width: i === active ? "18px" : "6px", height: "6px", borderRadius: "3px", background: i === active ? C.accent : C.border2, border: "none", cursor: "pointer", transition: "width 0.2s, background 0.2s", padding: 0 }} />
          ))}
        </div>
      </div>
    </ResultBubble>
  );
}

// ─── INTERVIEW RISK BUBBLE ────────────────────────────────────────────────────
function InterviewRiskBubble({ questions }) {
  const [open, setOpen] = useState(0);
  if (!questions?.length) return null;

  return (
    <ResultBubble>
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
    </ResultBubble>
  );
}

// ─── VERDICT BUBBLE ───────────────────────────────────────────────────────────
function VerdictBubble({ verdict }) {
  if (!verdict?.bottomLine && !verdict?.body) return null;
  return (
    <ResultBubble>
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
    </ResultBubble>
  );
}

// ─── DECISION CONFIDENCE BUBBLE ───────────────────────────────────────────────
function DecisionConfidenceBubble({ confidence }) {
  if (!confidence?.level) return null;
  const colors = { High: C.accent, Medium: C.yellow, Low: C.red };
  const bgs    = { High: "#0E1A13", Medium: "#1C1808", Low: "#1D100E" };
  const col = colors[confidence.level] || C.textDim;
  const bg  = bgs[confidence.level]   || C.surface;
  return (
    <ResultBubble>
      <div style={{ background: bg, border: `1px solid ${col}33`, borderRadius: "4px 18px 18px 18px", padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: confidence.reason ? "12px" : 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.1em" }}>DECISION CONFIDENCE</span>
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: col, background: `${col}18`, border: `1px solid ${col}44`, borderRadius: "4px", padding: "3px 10px", letterSpacing: "0.08em" }}>{confidence.level.toUpperCase()}</span>
        </div>
        {confidence.reason && (
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textMid, margin: 0, lineHeight: 1.7 }}>{confidence.reason}</p>
        )}
      </div>
    </ResultBubble>
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
      setRerunError(err.message || "Re-analysis failed.");
    } finally {
      setRerunning(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000ee", backdropFilter: "blur(12px)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: "16px", width: "100%", maxWidth: "520px", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ padding: "22px 28px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Label color={C.accent}>Edit Job</Label>
          <button onClick={onClose} aria-label="Close dialog" style={{ background: "transparent", border: "none", color: C.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: "16px", lineHeight: 1 }}>✕</button>
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

          {/* Scores preview */}
          {(job.recruiterScore || job.hmScore) && (
            <div style={{ display: "flex", gap: "10px" }}>
              {[{ l: "Recruiter Score", v: job.recruiterScore }, { l: "HM Score", v: job.hmScore }].map(({ l, v }) => (
                <div key={l} style={{ flex: 1, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "10px 14px" }}>
                  <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 4px" }}>{l}</p>
                  <span style={{ fontFamily: T.display, fontSize: "22px", color: scoreColor(v), fontWeight: 800 }}>{v}</span>
                  <span style={{ fontFamily: T.mono, fontSize: "12px", color: C.textDim }}>/10</span>
                </div>
              ))}
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

// ─── RESCORE CARD ─────────────────────────────────────────────────────────────
function ReScoreCard({ job, updatedResume, onUpdate }) {
  const [scoring, setScoring] = useState(false);
  const [error, setError]     = useState("");
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
      onUpdate({ ...job, updatedRecruiterScore: rMatch ? parseFloat(rMatch[1]) : null, updatedHmScore: hMatch ? parseFloat(hMatch[1]) : null, updatedScoreSummary: sMatch ? sMatch[1].trim() : "", updatedScoreDate: now() });
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
                {[{ l: "Recruiter", orig: job.recruiterScore, upd: job.updatedRecruiterScore }, { l: "Hiring Mgr", orig: job.hmScore, upd: job.updatedHmScore }].map(({ l, orig, upd }) => (
                  <div key={l}>
                    <p style={{ fontFamily: T.mono, fontSize: "10px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>{l}</p>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontFamily: T.display, fontSize: "22px", color: scoreColor(upd), fontWeight: 800 }}>{upd ?? "—"}</span>
                      <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>/10</span>
                      {delta(orig, upd)}
                    </div>
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

// ─── TRACKER PAGE ─────────────────────────────────────────────────────────────
function TrackerPage({ jobs, onUpdateJob, onDeleteJob, onAddJob, updatedResume }) {
  const [filter, setFilter]       = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [showAdd, setShowAdd]     = useState(false);
  const [editingJob, setEditingJob] = useState(null);
  const [newJob, setNewJob]       = useState({ title: "", company: "", url: "", status: "saved", notes: "", location: "", workModel: "", employmentType: "", seniority: "", salary: "", team: "" });

  const activeJobs   = jobs.filter(j => j.status !== "rejected");
  const rejectedJobs = jobs.filter(j => j.status === "rejected");
  const filtered = filter === "all" ? activeJobs : filter === "rejected" ? rejectedJobs : jobs.filter(j => j.status === filter);

  const stats = {
    total:   activeJobs.length,
    applied: activeJobs.filter(j => ["applied","screen","interview","offer"].includes(j.status)).length,
    active:  activeJobs.filter(j => ["screen","interview"].includes(j.status)).length,
    offers:  activeJobs.filter(j => j.status === "offer").length,
  };

  const changeStatus = (job, s) => onUpdateJob({ ...job, status: s, ...stampDate(job, s) });

  const addJob = () => {
    if (!newJob.title.trim()) return;
    const t = now();
    onAddJob({ id: uid(), ...newJob, recruiterScore: null, hmScore: null, tier: null, analysis: "", dateAdded: t, dateSaved: t, dateApplied: null, dateScreen: null, dateInterview: null, dateOffer: null, dateRejected: null });
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

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "12px", marginBottom: "32px" }}>
        {[
          { l: "Active",      v: stats.total,   c: C.textMid },
          { l: "Applied",     v: stats.applied, c: C.accent  },
          { l: "In Progress", v: stats.active,  c: C.yellow  },
          { l: "Offers",      v: stats.offers,  c: C.mint    },
        ].map(({ l, v, c }) => (
          <div key={l} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "18px 20px" }}>
            <div style={{ fontFamily: T.display, fontSize: "36px", color: c, lineHeight: 1, marginBottom: "8px", fontWeight: 800 }}>{v}</div>
            <div style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "7px", marginBottom: "22px", flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => setFilter("all")} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === "all" ? C.accent : C.border}`, background: filter === "all" ? "#0E1A13" : "transparent", color: filter === "all" ? C.accent : C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer" }}>
          Active ({activeJobs.length})
        </button>
        {STATUSES.filter(s => s.key !== "rejected").map(s => {
          const count = jobs.filter(j => j.status === s.key).length;
          return (
            <button key={s.key} onClick={() => setFilter(s.key)} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === s.key ? s.color : C.border}`, background: filter === s.key ? s.bg : "transparent", color: filter === s.key ? s.color : C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer" }}>
              {s.label} ({count})
            </button>
          );
        })}
        {rejectedJobs.length > 0 && (
          <>
            <div style={{ width: "1px", height: "20px", background: C.border, flexShrink: 0 }} />
            <button onClick={() => setFilter("rejected")} style={{ padding: "6px 14px", borderRadius: "20px", border: `1px solid ${filter === "rejected" ? C.red : C.border}`, background: filter === "rejected" ? "#1D100E" : "transparent", color: filter === "rejected" ? C.red : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer", opacity: filter === "rejected" ? 1 : 0.6 }}>
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
            const jobTier = findTier(job.tier);
            return (
              <div key={job.id} style={{ background: C.surface, border: `1px solid ${exp ? C.border2 : C.border}`, borderRadius: "12px", overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: "14px" }}>
                  <Pill label={st.short} color={st.color} bg={st.bg} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontFamily: T.display, fontSize: "16px", color: C.text, margin: "0 0 3px", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{job.title}</p>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.textSub, margin: 0, lineHeight: 1.4 }}>
                        {job.company}{cardSub(job) ? `  ·  ${cardSub(job)}` : ""}
                      </p>
                      {jobTier && <TierBadge tier={jobTier} />}
                      {[job.workModel, job.location, job.employmentType, job.seniority, job.salary]
                        .filter(v => v && v.trim())
                        .map((v, i) => (
                          <span key={i} style={{ fontFamily: T.mono, fontSize: "10px", color: C.textSub, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "2px 7px", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{v}</span>
                        ))}
                    </div>
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

                {exp && (
                  <div style={{ borderTop: `1px solid ${C.border}`, padding: "22px 20px" }}>
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
                          <button key={s.key} onClick={() => changeStatus(job, s.key)} style={{ padding: "6px 14px", borderRadius: "18px", border: `1px solid ${job.status === s.key ? s.color : C.border}`, background: job.status === s.key ? s.bg : "transparent", color: job.status === s.key ? s.color : C.textSub, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", cursor: "pointer" }}>
                            {s.label}
                          </button>
                        ))}
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

                    {job.jobDescription && (
                      <div style={{ marginBottom: "18px" }}>
                        <Label>Saved Job Description</Label>
                        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px 16px", maxHeight: "200px", overflowY: "auto" }}>
                          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textSub, margin: 0, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                            {job.jobDescription}
                          </p>
                        </div>
                      </div>
                    )}

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
        <EditJobModal job={editingJob} onSave={(updated) => { onUpdateJob(updated); setEditingJob(null); }} onClose={() => setEditingJob(null)} />
      )}
    </div>
  );
}

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
function SettingsPage({ resume, onUpdateResume, user, authReady, syncStatus, onSignIn, onSignOut }) {
  const [draft, setDraft]       = useState(resume);
  const [apiKey, setApiKey]     = useState(() => localStorage.getItem(KEYS.apiKey) || "");
  const [proxyUrl, setProxyUrl] = useState(() => localStorage.getItem(KEYS.proxyUrl) || "");
  const [saved, setSaved]       = useState(false);
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

  const clearKey = () => {
    if (!window.confirm("Remove your API key and proxy URL from this browser?")) return;
    localStorage.removeItem(KEYS.apiKey); localStorage.removeItem(KEYS.proxyUrl); setApiKey(""); setProxyUrl("");
  };

  return (
    <div style={{ maxWidth: "740px", margin: "0 auto", padding: "48px 24px 0" }}>
      <p style={{ fontFamily: T.mono, fontSize: "11px", color: C.accent, letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 16px" }}>Settings</p>
      <h1 style={{ fontFamily: T.display, fontSize: "clamp(26px,4vw,38px)", color: C.text, fontWeight: 800, letterSpacing: "-0.03em", margin: "0 0 36px" }}>Settings</h1>

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "28px", marginBottom: "18px" }}>
        <Label color={C.accent}>Sync Across Computers</Label>
        <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 18px" }}>
          Sign in to mirror your resume and pipeline to the cloud. Sign into the same account on another computer to pick up where you left off — everything still works offline and caches locally either way.
        </p>
        {!authReady ? (
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim }}>checking sign-in status...</span>
        ) : user ? (
          <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: syncStatus === "error" ? C.red : C.accent, boxShadow: syncStatus === "synced" ? `0 0 8px ${C.accent}` : "none" }} />
              <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, letterSpacing: "0.05em" }}>
                {user.email} — {syncStatus === "syncing" ? "syncing…" : syncStatus === "error" ? "sync error" : "synced"}
              </span>
            </div>
            <Btn variant="ghost" small onClick={onSignOut}>Sign Out</Btn>
          </div>
        ) : (
          <Btn onClick={onSignIn}>Sign In With Google</Btn>
        )}
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "28px", marginBottom: "18px" }}>
        <Label color={C.accent}>Anthropic API Key</Label>
        <p style={{ fontFamily: T.body, fontSize: "15px", color: C.textMid, lineHeight: 1.8, margin: "0 0 18px" }}>
          Stored locally in your browser — never sent anywhere except directly to Anthropic's API. Get a key at{" "}
          <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">console.anthropic.com</a>.
        </p>
        <div style={{ marginBottom: "14px" }}>
          <Label>API Key</Label>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-..." style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "12px 16px", fontSize: "14px", color: C.text, fontFamily: T.code, outline: "none", boxSizing: "border-box", marginBottom: "14px" }} />
          <Label>Proxy URL <span style={{ color: C.textDim, textTransform: "none", letterSpacing: 0, fontFamily: T.body, fontSize: "13px" }}>— optional, fixes CORS errors</span></Label>
          <input type="text" value={proxyUrl} onChange={e => setProxyUrl(e.target.value)} placeholder="https://your-worker.workers.dev" style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: "8px", padding: "12px 16px", fontSize: "14px", color: C.text, fontFamily: T.code, outline: "none", boxSizing: "border-box" }} />
          <p style={{ fontFamily: T.body, fontSize: "13px", color: C.textDim, lineHeight: 1.7, margin: "10px 0 0" }}>
            Seeing "Access-Control-Allow-Origin" errors? Deploy <code style={{ fontFamily: T.code, fontSize: "12px", color: C.textSub }}>cloudflare-worker/proxy.js</code> to a free Cloudflare Worker and paste the URL here.
          </p>
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          <Btn onClick={saveKey} disabled={!apiKey.trim()}>{keySaved ? "✓ Saved" : "Save Settings"}</Btn>
          {localStorage.getItem(KEYS.apiKey) && <Btn variant="danger" onClick={clearKey} small>Clear</Btn>}
        </div>
      </div>

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
    await store.set(KEYS.updatedResume, updatedDraft.trim());
    onUpdateUpdated(updatedDraft.trim());
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

  const [storageError, setStorageError] = useState(false);
  const hydrated = useRef(false);

  // ─── Cloud sync state ───────────────────────────────────────────────────────
  const [user, setUser]           = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | syncing | synced | error
  // Set right before a remote snapshot writes local state, so the very next
  // push-to-cloud effect run knows to skip — otherwise every remote update
  // would immediately be pushed straight back up.
  const applyingRemote = useRef(false);

  useEffect(() => {
    Promise.all([store.get(KEYS.resume), store.get(KEYS.jobs), store.get(KEYS.updatedResume)]).then(([r, j, u]) => {
      setResume(r || null);
      let parsed = [];
      try { parsed = j ? JSON.parse(j) : []; } catch { parsed = []; }
      if (!Array.isArray(parsed)) parsed = [];
      setJobs(parsed);
      setUpdatedResume(u || "");
      hydrated.current = true;
      setReady(true);
    });
  }, []);

  // Single write path: whatever `jobs` becomes, it gets persisted — after
  // hydration only, so the initial [] never clobbers stored data.
  useEffect(() => {
    if (!hydrated.current) return;
    setStorageError(!store.set(KEYS.jobs, JSON.stringify(jobs)));
  }, [jobs]);

  // Track auth state across reloads/devices. We use redirect (not popup) sign-in
  // because iOS home-screen PWAs run in a stripped-down WebView that can't
  // reliably open/return a popup window — a full-page redirect works the same
  // way on desktop browsers and installed iPhone PWAs alike.
  useEffect(() => {
    getRedirectResult(auth).catch((e) => console.error("google sign-in redirect failed", e));
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setAuthReady(true); });
    return unsub;
  }, []);

  // On sign-in: pull whatever's in the cloud once (cloud wins on login — that's
  // the point of linking a second computer), then keep a live listener open so
  // changes made elsewhere while this tab is open show up automatically.
  useEffect(() => {
    if (!user || !hydrated.current) return;
    let unsub = () => {};
    (async () => {
      const remote = await cloud.pullOnce(user.uid);
      if (remote) {
        applyingRemote.current = true;
        if (typeof remote.resume === "string") { setResume(remote.resume); store.set(KEYS.resume, remote.resume); }
        if (typeof remote.updatedResume === "string") { setUpdatedResume(remote.updatedResume); store.set(KEYS.updatedResume, remote.updatedResume); }
        if (Array.isArray(remote.jobs)) setJobs(remote.jobs);
      } else {
        // Nothing in the cloud yet for this account — seed it with what's local.
        cloud.push(user.uid, { resume, updatedResume, jobs });
      }
      setSyncStatus("synced");
      unsub = cloud.subscribe(user.uid, (remoteData) => {
        applyingRemote.current = true;
        if (typeof remoteData.resume === "string") { setResume(remoteData.resume); store.set(KEYS.resume, remoteData.resume); }
        if (typeof remoteData.updatedResume === "string") { setUpdatedResume(remoteData.updatedResume); store.set(KEYS.updatedResume, remoteData.updatedResume); }
        if (Array.isArray(remoteData.jobs)) setJobs(remoteData.jobs);
        setSyncStatus("synced");
      });
    })();
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Push local changes up whenever resume/jobs/updatedResume change, as long as
  // the change didn't just come *from* the cloud (see applyingRemote above).
  useEffect(() => {
    if (!user || !hydrated.current) return;
    if (applyingRemote.current) { applyingRemote.current = false; return; }
    setSyncStatus("syncing");
    cloud.push(user.uid, { resume, updatedResume, jobs }).then(ok => setSyncStatus(ok ? "synced" : "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, updatedResume, jobs, user]);

  const signInWithGoogle = async () => {
    try { await signInWithRedirect(auth, googleProvider); }
    catch (e) { console.error("sign-in failed", e); }
  };
  const signOutOfSync = async () => { await signOut(auth); setSyncStatus("idle"); };

  // Functional updates — no stale closures, safe under rapid successive saves.
  const handleSaveJob  = (j)          => setJobs(prev => [j, ...prev]);
  const handleUpdate   = (u)          => setJobs(prev => prev.map(j => j.id === u.id ? u : j));
  const handlePatchJob = (id, patch)  => setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j));
  const handleDelete   = (id)         => setJobs(prev => prev.filter(j => j.id !== id));
  const handleAdd      = (j)          => setJobs(prev => [j, ...prev]);
  const handleResume        = (r) => setResume(r);
  const handleUpdatedResume = (r) => setUpdatedResume(r);
  const handleOnboard       = (r) => { setResume(r); setPage("analyzer"); };

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
            <path d="M7 35 C16 35 15 23 24 22 C33 21 32 14 38 13" fill="none" stroke={C.accent} strokeWidth="3.5" strokeLinecap="round" opacity="0.45"/>
            <path d="M7 35 C16 35 15 23 24 22" fill="none" stroke={C.accent} strokeWidth="3.5" strokeLinecap="round"/>
            <circle cx="38" cy="13" r="4.5" fill={C.accent}/>
          </svg>
          <span style={{ fontFamily: T.display, fontSize: "18px", color: C.text, fontWeight: 800, letterSpacing: "-0.02em" }}>inflow</span>
        </div>

        <div style={{ display: "flex", gap: "3px" }}>
          {NAV.map(({ key, label, badge }) => (
            <button key={key} onClick={() => setPage(key)} style={{ padding: "7px 18px", borderRadius: "7px", background: page === key ? C.surface : "transparent", border: `1px solid ${page === key ? C.border2 : "transparent"}`, color: page === key ? C.accent : C.textDim, fontFamily: T.mono, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", position: "relative", transition: "all 0.15s", display: "flex", alignItems: "center", gap: "5px" }}>
              {label}
              {badge && <span style={{ fontFamily: T.mono, fontSize: "10px", color: C.accent }}>{badge}</span>}
              {key === "tracker" && pending > 0 && (
                <span style={{ position: "absolute", top: "-4px", right: "-4px", width: "16px", height: "16px", borderRadius: "50%", background: C.yellow, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono, fontSize: "10px", color: "#000", fontWeight: 700 }}>{pending}</span>
              )}
            </button>
          ))}
        </div>

        <div className="nav-status" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: C.accent, boxShadow: `0 0 8px ${C.accent}` }} />
          <span style={{ fontFamily: T.mono, fontSize: "11px", color: C.textDim, letterSpacing: "0.08em", textTransform: "uppercase" }}>Resume Active</span>
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

      {page === "analyzer" && <AnalyzerPage resume={resume} onSaveJob={handleSaveJob} onPatchJob={handlePatchJob} />}
      {page === "tracker"  && <TrackerPage  jobs={jobs} onUpdateJob={handleUpdate} onDeleteJob={handleDelete} onAddJob={handleAdd} updatedResume={updatedResume} />}
      {page === "resumes"  && <ResumePage   baseResume={resume} updatedResume={updatedResume} onUpdateBase={handleResume} onUpdateUpdated={handleUpdatedResume} />}
      {page === "settings" && <SettingsPage resume={resume} onUpdateResume={handleResume} user={user} authReady={authReady} syncStatus={syncStatus} onSignIn={signInWithGoogle} onSignOut={signOutOfSync} />}
      <UpdateToast />
    </div>
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
