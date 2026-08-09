# InFlow — Build Summary

InFlow is a local-first, privacy-preserving job-search coach. You paste a job (URL or text) and it simulates the internal hiring discussion — scores, decision, strengths, the fastest ways to move up, resume edits, and the interview questions you'll actually get — then helps you act on it. Everything lives in your browser; your API key and data are sent only to Anthropic (or your own proxy), never to us.

Single-page React app (Vite + PWA). Almost all app logic lives in `src/App.jsx`.

---

## What it does

### Analyze
- **Full analysis** of any job vs. your base resume: coach summary, recruiter + hiring-manager scores with an achievable ceiling, a full scorecard, hiring decision, strengths, the fastest ways to move up, a resume-edit checklist, and likely interview questions.
- **Quick check** ("Just tell me if it's worth it") — a fast, low-commitment read (coach summary + one score band + top action) for ~1/6th the tokens. Full analysis stays one click away.
- **Focused-by-default results:** the gist, the scores, and one recommended next action up front; everything else in collapsed cards with a "Show me everything" toggle (preference persisted).
- **Fit bands** (Reach / Match / Safe) on every analysis, plus honest mix guidance ("aim for ~2 matches per stretch").
- **Object permanence:** an unrun paste/URL is saved and offered back — "Pick up where you left off?"

### Targeting coach (aim at winnable roles, not only reaches)
- **Winnable-role finder:** from your base resume, suggests 3–5 role types you'd realistically score 7+ on, each with a one-line why. Cached locally, generated on demand.
- **Cross-analysis pattern awareness:** if your recent analyses are all stretches, a calm, dismissible strategy callout appears (never a warning) with two levers — see winnable roles, and your strongest resume reframe.

### Pipeline (executive-function support, not a passive ledger)
- **Per-card next step:** each card suggests a gentle, dismissible action based on stage + elapsed time ("Saved 8 days ago — want to take ~15 min to apply?").
- **Opt-in reminders:** highlights the single stalest item most worth acting on. Never guilt-based.
- **This-week effort tally** of the wins you control (jobs analyzed, resumes tailored, scores improved, stages advanced).
- **This-week plan:** the "what if I don't get a job soon" fear answered with controllable effort — apply to ~2 match-band roles, one resume reframe, one follow-up. No promised dates, no hopelessness.
- **Fit-band tags** per card (auto from score, user-overridable) and a pipeline mix summary that flags an all-reaches board.
- **Encouraging empty states** and clickable stat cards that jump to the most relevant next action.
- **Re-score celebration:** when an edited resume lifts a job's score, the number animates old → new with a brief, calm affirmation.
- **Momentum acknowledgements** on forward stage moves; CSV export.

### Setup, resume, sync
- **Guided one-time setup:** numbered checklist, inline API-key validation ("key looks good ✓" or a friendly error), reassuring microcopy, and — if a browser CORS block occurs — plain-language proxy instructions instead of a raw error. The analyzer's CORS errors link straight to the fix.
- **Base + updated resume** management, used for analysis and projected re-scores.
- **Cross-device sync** via an anonymous code (Firebase); works offline either way.

### Tone & accessibility
- The analysis engine is coached to make you **act, not quit**: honest and specific, but never absolute-deficit language ("no experience", "missing", "gap"). Shortfalls are framed as levers with effort estimates, and never shown without a next action.
- WCAG-AA body-text contrast on the dark theme, visible keyboard focus states, and ≥44px tap targets on primary controls.

---

## Tech

- **React 18** + **Vite 5**, PWA (`vite-plugin-pwa`, offline caching).
- **Firebase** (anonymous auth + Firestore) for optional device sync. The config in `src/firebase.js` is public by design (it identifies the project; access is gated by Firestore security rules) — it is not a secret.
- **Anthropic API** called directly from the browser with the user's own key (stored in `localStorage`), or through an optional user-deployed proxy for CORS.
- No backend of our own. All user data is local + (optionally) the user's own Firestore doc.

## Project structure

```
InFlow/
├─ index.html
├─ package.json / package-lock.json
├─ vite.config.js
├─ .gitignore
├─ SUMMARY.md
└─ src/
   ├─ App.jsx      # the whole app (analysis prompts, parsers, UI, pipeline)
   ├─ acJobs.js    # shared job store / normalization
   ├─ firebase.js  # Firebase init (public config)
   └─ main.jsx     # entry point
```

## Run locally

```bash
npm install
npm run dev      # local dev server
npm run build    # production build → dist/
npm run preview  # preview the production build
```

To use it, open Settings, follow the one-time setup, and paste your Anthropic API key (stored locally).
