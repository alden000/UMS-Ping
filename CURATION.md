# Ping weekly curation runbook

This is the source of truth for the scheduled task **"Compile weekly maritime intelligence report"**, which runs every
Monday at about 08:00 Singapore time (SGT). A fresh agent session follows these steps end to end, without asking questions.

- **Publish branch:** `main`. GitHub Pages serves the site from `main` / root.
- **Newsletter name:** Ping
- **Report title:** `🛥 Weekly Maritime Systems Intelligence & Technology Update`
- **Subtitle:** `Coverage Window: Past 7 Days ([Start Date] – [End Date]) | Verified Global Defense & Maritime Authorities`

---

## 1. Set up

1. Get the repo `raus-ums/UMS-Ping` with push access. If it is not already in the session, attach it with `add_repo` and clone it.
2. `git fetch origin main && git checkout -B main origin/main`
3. Work out the dates in SGT. `END` is today, the Monday of the run (`YYYY-MM-DD`), and `START` is `END − 7 days`. The issue id is `END`.
4. Read `data/index.json`. The new issue's `number` is the latest issue's number + 1. If an issue with id `END` already exists, update it instead of creating a duplicate.

## 2. Learn from reader feedback

- If `assets/config.js` has a non-empty `feedbackEndpoint`, `GET <endpoint>/summary` returns tallies for every issue:
  👍/👎 per entry, 👎 reasons, 👍/👎 per section, the 1–5 issue rating, and "more of" topic counts.
- Use the last 4 issues to tune emphasis, but never relax the verification rules:
  - Topics and sections with high 👍 rates or many "more of" requests get extra search effort, with a target of more entries if they exist.
  - Entry types with repeated 👎 reasons ("Not relevant to me", "Too far from SEA", "Not new", "Weak source") are deprioritised accordingly.
- Never cover a story whose source URL already appears in a previous issue (`data/issues/*.json`).
- If no endpoint is configured, skip this step.

## 3. Research: run the 4 scans in parallel (one sub-agent per table is ideal)

Lookback: only items **published between START and END inclusive**.

1. **Table 1: Threats & Incidents.** Verified global waterborne threats, incidents, strikes or incursions involving USVs, AUVs, ROVs,
   unmanned semi-submersibles and WBIEDs. Exclude purely aerial UAV strikes and crewed warships with no waterborne uncrewed involvement.
   Pay special attention to Singapore, the Singapore Strait, the Malacca Strait, the South China Sea and Southeast Asia: search them
   explicitly, including recovered or found UUVs and gliders, ROV and seabed-cable incidents, and narco semi-submersibles. Always write
   an explicit regional status note in `regionalWatch`.
2. **Table 2: Unmanned Maritime Systems Product News.** Newly unveiled, contracted or deployed USVs, AUVs, UUVs and ROVs, globally
   (Singapore, China, international defence and commercial manufacturers).
3. **Table 3: Product & Technology of Interest.** Sensors, launch & recovery, tethered or VTOL drones, machine vision and target tracking,
   firefighting, hazmat, SAR and other auxiliary tech that can be paired with uncrewed maritime platforms.
4. **Table 4: Maritime Comms.** Satcom, dynamic mesh radios, underwater acoustic modems, high-bandwidth RF datalinks and optical comms
   for uncrewed and digital maritime systems.

**Strict verification.** Fetch every candidate page before including it.

- **No gated content.** No logins, registration, paywalls or member-only overviews. Known gated sites: Janes, Lloyd's List, FT, WSJ,
  Bloomberg, Tech Briefs member pages.
- **Direct deep links only.** Never a `/news/` index, category, tag, search page or homepage.
- **Tables 2–4: concrete hardware, software or vendor releases only.** No conference agendas, event programs, symposium schedules,
  exhibition directories or calls for papers.
- Record the publication date exactly as shown on the page.
- Take the page's `og:image` for `image` (or `null`). Only use it if it actually depicts the subject; if it shows something
  unrelated, set `null` and the site generates artwork instead.
- `video`: a YouTube URL only if an **official or embedded** video for that exact story exists. Never guess one.
- Never invent URLs, numbers or quotes. Drop anything that cannot be verified. Don't put the same story in two tables.
- If a table has no qualifying items, leave `entries` empty and write a clear `emptyNote`.

## 4. Write the issue file `data/issues/<END>.json`

Copy the structure of the most recent issue file exactly. The schema is:

```jsonc
{
  "id": "YYYY-MM-DD", "number": 2,
  "title": "🛥 Weekly Maritime Systems Intelligence & Technology Update",
  "window": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "published": "YYYY-MM-DDT08:00:00+08:00",
  "editorial": { "headline": "≤ 60 chars, punchy", "lede": "2–3 sentences", "picks": ["t1-1", "t2-3", "t4-2"] },
  "regionalWatch": { "status": "calm|elevated|alert", "label": "short phrase", "note": "explicit Singapore/SEA status" },
  "sections": [   // exactly these four keys, in this order
    { "key": "threats",   "title": "Threats & Incidents (Past 7 Days)", "emptyNote": "…", "entries": [ … ] },
    { "key": "platforms", "title": "Unmanned Maritime Systems Product News (Past 7 Days)", "emptyNote": "…", "entries": [ … ] },
    { "key": "tech",      "title": "Product & Technology of Interest for Maritime Applications (Past 7 Days)", "emptyNote": "…", "entries": [ … ] },
    { "key": "comms",     "title": "Maritime Comms Products & Technologies (Past 7 Days)", "emptyNote": "…", "entries": [ … ] }
  ]
}
```

Each entry has these fields:

- `date` (`YYYY-MM-DD`)
- `title` (`"Product / Vendor"`, or for threats `"Incident headline / Area"`)
- `location` (threats only) or `tech` (Tech & Approach, tables 2–4)
- `details` (Key Details / Capabilities & Specs, 2–4 factual sentences)
- `summary` (one teaser sentence of ≤ 160 chars)
- `source` (`{ "name", "url" }`)
- `image`, `video`
- `region` (one of: Southeast Asia, East Asia, South Asia, Middle East, Black Sea, Europe, Americas, Africa, Oceania, Global)
- `lat`, `lng` (incident location, or the vendor's base)
- `domain` (`surface | subsurface | cross-domain`)
- `specs` (0–4 `{label, value}` chips, verified numbers only)
- `tags`
- Optional: `severity` (threats), `application` (tech), `medium` (comms)

Entry `id`s are assigned by the build, and pick ids follow the chronological order (`t2-3` means the third-oldest item in table 2).

## 5. Build and verify

```bash
python3 scripts/build.py --check-links
```

The build validates the schema, the window, deep links and gated hosts, sorts each table oldest to newest, assigns ids, rebuilds
`data/index.json` and renders the email edition at `issues/<END>/email.html`.

- Fix every error.
- Replace or drop any source that returns 401, 402, 404 or 410.
- A 403 is acceptable only when the page was confirmed readable during research, since some sites block scripts but not browsers.

Then run `node --check assets/app.js`. If Playwright or Chromium is available, also load the site from `python3 -m http.server`
and confirm there are no console errors.

## 6. Publish

1. Commit with the message `Ping Nº <number>: <START> – <END>`.
2. Push to `main` with `git push -u origin main`. On a network error, retry up to 4 times with 2s, 4s, 8s and 16s backoff.

## 7. Deliver

Finish with a short summary: the number of entries per table, the regional status, and the site URL
`https://raus-ums.github.io/UMS-Ping/#/<END>`. After that, paste the **complete** contents of `issues/<END>/email.html` in a single
```html code block.
