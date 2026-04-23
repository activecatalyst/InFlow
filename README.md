# inflow

> Your job search, in flow state.

AI-powered job search analyzer and pipeline tracker. Paste any job posting URL or description, get brutally honest recruiter and hiring manager scores, specific resume edit suggestions, ATS keyword analysis, interview prep, and a full pipeline tracker with per-stage date history.

## Features

- **Honest scoring** — Recruiter score + Hiring Manager score out of 10
- **Resume edit suggestions** — 5 specific line-by-line rewrites per job
- **ATS keyword analysis** — phrases to mirror from each job description
- **Interview prep** — likely questions with coaching notes
- **Pipeline tracker** — full application pipeline with per-stage timestamps
- **Settings** — update your resume anytime, manage your API key

## Setup

### 1. Fork or clone this repo

```bash
git clone https://github.com/YOUR_USERNAME/inflow.git
cd inflow
npm install
```

### 2. Get an Anthropic API key

Sign up at [console.anthropic.com](https://console.anthropic.com) and create an API key.

### 3. Run locally

```bash
npm run dev
```

Open `http://localhost:5173/inflow/` in your browser. On first launch, paste your resume and add your API key in Settings.

### 4. Deploy to GitHub Pages

**Option A — Automatic (recommended)**

1. Push to a repo named `inflow` on your GitHub account
2. Go to **Settings → Pages** in your repo
3. Set Source to **GitHub Actions**
4. Push to `main` — the workflow auto-builds and deploys

Your app will be live at `https://YOUR_USERNAME.github.io/inflow/`

**Option B — Manual**

```bash
npm run build
# Upload the dist/ folder to your hosting of choice
```

### 5. If your repo name is different

Update `vite.config.js`:

```js
base: '/YOUR_REPO_NAME/',
```

## API Key Security

Your Anthropic API key is stored in `localStorage` in your browser only. It is never sent anywhere except directly to Anthropic's API with each analysis request. inflow has no backend and no database — everything runs client-side.

> **Note:** Calling the Anthropic API directly from a browser exposes your API key in network requests. This is fine for personal use. If you share the deployment publicly, consider adding a usage limit on your key at console.anthropic.com.

## Tech Stack

- React 18
- Vite
- Anthropic Claude API (claude-sonnet-4)
- localStorage for persistence
- Zero external UI dependencies

## License

MIT
