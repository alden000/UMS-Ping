# Ping: Unmanned Maritime Intelligence Weekly

Ping is a web newsletter that curates verified news on unmanned maritime systems (USVs, AUVs, ROVs and semi-submersibles) every Monday at 08:00 SGT.
It covers four tables: threats & incidents, platform news, enabling technology, and maritime comms. Singapore and Southeast Asia get a dedicated regional watch.

- **Interactive edition** (`index.html`): sonar hero, contact map with a Singapore/SEA zoom, week pulse, signal mix, card or classic-table views, image and video lightbox, per-story 👍/👎 with "why", an issue rating, and topic requests. It also has haptic feedback, light and dark modes, keyboard shortcuts (J/K/A/T) and reduced-motion support.
- **Email edition** (`issues/<date>/email.html`): the original inline-styled four-table HTML, generated from the same data.
- **Archive** (`data/index.json`): every issue stays browsable from the archive drawer.

## Layout

| Path | Purpose |
| --- | --- |
| `data/issues/<date>.json` | One issue. This is the only file curation writes by hand |
| `scripts/build.py` | Validates issues, sorts entries, rebuilds `data/index.json` and the email editions (`--check-links` fetches every source) |
| `assets/` | Site code (`app.js`, `styles.css`), runtime config (`config.js`) and the map dot matrices |
| `worker/` | Optional Cloudflare Worker that collects feedback from all readers |
| `CURATION.md` | Runbook followed by the weekly scheduled task |
| `contributors/` + `CONTRIBUTING-AI.md` | Other AIs (Gemini, Groq…) suggest stories every Sunday; the Monday curator verifies and merges them |

## Run locally

```bash
python3 scripts/build.py
python3 -m http.server 8000   # then open http://localhost:8000
```

## Publish with GitHub Pages

Settings → Pages → *Deploy from a branch* → `main` / `(root)`. The site is then served at `https://raus-ums.github.io/UMS-Ping/`.

## Reader feedback

Votes and ratings work immediately, but without a backend they stay in each reader's browser.
To collect them across readers and let the weekly curation adapt, deploy `worker/` (see `worker/README.md`) and set `feedbackEndpoint` in `assets/config.js`.
