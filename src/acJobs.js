// ─── SHARED JOB CONTRACT (ac_jobs_v1) ──────────────────────────────────────────
// ONE shared job record under ONE key, read/written by BOTH apps in the suite
// (Path Pursuit + InFlow). A job saved in either app appears in the other with
// no duplication. The body of this file is IDENTICAL to the inline block in
// Path Pursuit's index.html — keep them in sync.
//
// Ownership rules:
//   • id is deterministic from url, so the same posting never double-saves.
//   • InFlow is the ONLY writer of `status` and `appliedAt`.
//   • Path Pursuit writes discovery fields + status:"saved" on first save and
//     never touches status again afterwards.
//   • Both apps read the full array, mutate by id, write the full array back.

export const AC_JOBS_KEY      = "ac_jobs_v1";
export const AC_MIGRATED_KEY  = "ac_migrated_v1";
export const LEGACY_PP_KEY    = "sdjobs_saved_v1";
export const LEGACY_INFLOW_KEY = "inflow_jobs_v2";

// Canonical status vocabulary — InFlow's richer set is canonical.
export const AC_STATUSES = ["saved", "applied", "screen", "interview", "offer", "rejected"];
// Advancement rank, used for migration conflict resolution.
const AC_STATUS_RANK = { saved: 0, applied: 1, screen: 2, interview: 3, offer: 4, rejected: 5 };
// Legacy Path Pursuit status names → canonical.
const AC_STATUS_ALIAS = { interviewing: "interview", offered: "offer" };

export function acMapStatus(s) {
  if (!s) return "saved";
  const m = AC_STATUS_ALIAS[s] || s;
  return AC_STATUSES.includes(m) ? m : "saved";
}

// Deterministic 32-bit FNV-1a hash → base36. Same url ⇒ same id.
function acHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}
function acRandId() { return "j_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

// Stable id from url; random id when there is no url (e.g. a pasted JD).
export function jobId(url) {
  const u = (url || "").trim();
  return u ? "u_" + acHash(u) : acRandId();
}

function acNow() { return new Date().toISOString(); }
function acToIso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString();
  return v; // already an ISO string
}

// The single record factory — IDENTICAL in both apps.
export function makeJob(f) {
  f = f || {};
  const url = (f.url || "").trim();
  return {
    id:        f.id || jobId(url),
    url,
    title:     f.title   || "",
    company:   f.company || "",
    jd:        f.jd      || "",
    source:    f.source  || "",
    status:    acMapStatus(f.status || "saved"),
    savedAt:   acToIso(f.savedAt) || acNow(),
    appliedAt: acToIso(f.appliedAt),
    analysis:  f.analysis != null ? f.analysis : null,
    tailored:  f.tailored != null ? f.tailored : null,
  };
}

// Coerce ANY record (canonical, legacy InFlow, legacy Path Pursuit) into the
// canonical shape WITHOUT losing app-specific extras. id is (re)derived from
// url so records from every source dedupe against each other. Idempotent, so it
// is safe to run on every read, cloud ingest, and persist.
export function normalizeJob(o) {
  o = o || {};
  const url = (o.url || "").trim();
  const rec = Object.assign({}, o, {
    id:        url ? jobId(url) : (o.id || acRandId()),
    url,
    title:     o.title   || "",
    company:   o.company || "",
    jd:        o.jd != null ? o.jd : (o.jobDescription != null ? o.jobDescription : ""),
    source:    o.source  || "",
    status:    acMapStatus(o.status || "saved"),
    savedAt:   acToIso(o.savedAt) || acToIso(o.dateSaved) || acToIso(o.dateAdded) || acNow(),
    appliedAt: acToIso(o.appliedAt) || acToIso(o.dateApplied) || null,
    analysis:  o.analysis != null ? o.analysis : null,
    tailored:  o.tailored != null ? o.tailored : null,
  });
  delete rec.jobDescription; // superseded by `jd`
  return rec;
}

// ─── localStorage array helpers ───────────────────────────────────────────────
function acRead() {
  try { const v = localStorage.getItem(AC_JOBS_KEY); const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function acWrite(arr) {
  try { localStorage.setItem(AC_JOBS_KEY, JSON.stringify(arr)); return true; } catch { return false; }
}

export function getJobs() { return acRead().map(normalizeJob); }
export function findJob(id) { return getJobs().find(j => j.id === id) || null; }

// Upsert on discovery. If the job already exists, DO NOT touch its status or
// dates (InFlow owns those) — only backfill empty discovery fields. This is
// what keeps a second save from creating a duplicate.
export function saveJob(record) {
  const rec = normalizeJob(record);
  const arr = acRead();
  const i = arr.findIndex(j => normalizeJob(j).id === rec.id);
  if (i === -1) {
    arr.unshift(rec);
  } else {
    const cur = normalizeJob(arr[i]);
    arr[i] = Object.assign({}, cur, {
      title:   cur.title   || rec.title,
      company: cur.company || rec.company,
      jd:      cur.jd      || rec.jd,
      source:  cur.source  || rec.source,
    });
  }
  acWrite(arr);
  return normalizeJob(arr[i === -1 ? 0 : i]);
}

export function updateJob(id, patch) {
  const arr = acRead();
  const i = arr.findIndex(j => normalizeJob(j).id === id);
  if (i === -1) return null;
  arr[i] = normalizeJob(Object.assign({}, normalizeJob(arr[i]), patch));
  acWrite(arr);
  return arr[i];
}

export function removeJob(id) {
  acWrite(acRead().filter(j => normalizeJob(j).id !== id));
}

// ─── One-time migration ───────────────────────────────────────────────────────
function ppLegacyToJob(o) {
  o = o || {};
  return makeJob({
    url:     o.url || "",
    title:   o.title || "",
    company: o.company || "",
    jd:      o.desc != null ? o.desc : (o.jd || ""),
    source:  o.source || "path-pursuit",
    status:  o.status || "saved",
    savedAt: o.savedAt,           // number (ms) or ISO — makeJob coerces
  });
}
function inflowLegacyToJob(o) {
  const rec = normalizeJob(o);
  if (!rec.source) rec.source = "inflow";
  return rec;
}
// On conflict (same id in both stores) prefer the more-advanced status and keep
// that record's dates; backfill empty discovery fields from the other.
function acMergePrefer(a, b) {
  const hi = (AC_STATUS_RANK[b.status] || 0) > (AC_STATUS_RANK[a.status] || 0) ? b : a;
  const lo = hi === a ? b : a;
  return Object.assign({}, lo, hi, {
    title:    hi.title    || lo.title,
    company:  hi.company  || lo.company,
    jd:       hi.jd       || lo.jd,
    source:   hi.source   || lo.source,
    analysis: hi.analysis != null ? hi.analysis : lo.analysis,
    tailored: hi.tailored != null ? hi.tailored : lo.tailored,
  });
}

// Runs once, in whichever app opens first (shared origin ⇒ shared localStorage).
// Guarded by AC_MIGRATED_KEY so it can never run twice.
export function migrateJobs() {
  try {
    if (localStorage.getItem(AC_MIGRATED_KEY) === "1") return;
    let ok = true;
    if (acRead().length === 0) {
      const map = new Map();
      const add = (rec) => { const cur = map.get(rec.id); map.set(rec.id, cur ? acMergePrefer(cur, rec) : rec); };
      let inf = [], pp = [];
      try { inf = JSON.parse(localStorage.getItem(LEGACY_INFLOW_KEY) || "[]"); } catch { inf = []; }
      try { pp  = JSON.parse(localStorage.getItem(LEGACY_PP_KEY)     || "[]"); } catch { pp  = []; }
      if (Array.isArray(inf)) inf.forEach(o => add(inflowLegacyToJob(o)));
      if (Array.isArray(pp))  pp.forEach(o => add(ppLegacyToJob(o)));
      if (map.size > 0) ok = acWrite(Array.from(map.values()));
    }
    // Legacy keys are intentionally LEFT in place (safe rollback); we simply
    // stop reading/writing them from here on.
    if (ok) localStorage.setItem(AC_MIGRATED_KEY, "1");
  } catch { /* leave unmigrated; will retry next load */ }
}
