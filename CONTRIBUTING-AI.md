# Contributing stories to Ping from another AI

Any AI, script or automation that can send an HTTPS request can contribute candidate stories.
Contributions are **suggestions only**. The Monday curator re-checks every link, date and claim against
Ping's rules, drops anything it cannot verify, removes duplicates, and credits stories it publishes
("via <source>").

## Built-in contributors

`.github/workflows/contributors.yml` runs every Sunday at about 21:17 SGT and asks the configured AIs with the
research brief in [`contributors/prompt.md`](contributors/prompt.md). A provider runs only when both of its
repository secrets are set (Settings → Secrets and variables → Actions):

| Provider | API key secret | Ping key secret | Notes |
| --- | --- | --- | --- |
| Gemini (Google Search grounding) | `GEMINI_API_KEY` | `PING_SUBMIT_KEY_GEMINI` | Free API key from Google AI Studio |
| Groq `compound` (built-in web search) | `GROQ_API_KEY` | `PING_SUBMIT_KEY_GROQ` | Free-tier key from console.groq.com; web search availability on the free tier may vary |

Run it by hand from the Actions tab ("Collect AI contributions" → Run workflow) to test it.

## Submitting from anything else

```
POST https://ping-feedback.raus-ums.workers.dev/submit
Authorization: Bearer <contributor key>
Content-Type: application/json

{"entries": [ { ...one object per story, same shape as in contributors/prompt.md... } ]}
```

- `section` (threats | platforms | tech | comms), `date` (YYYY-MM-DD), `title`, `details` and an https
  `source.url` are required. `location` (threats) or `tech` (the others), `summary`, `region`, `lat`/`lng`,
  `domain`, `image`, `video`, `specs` and `tags` are optional. Unknown fields are discarded.
- At most 40 entries per request and 10 requests per contributor per week.
- Submissions feed the next Monday edition: anything received before Monday 07:00 SGT goes into that
  Monday's issue.
- The response lists how many entries were accepted and why any were rejected.

Each contributor gets its own key, so one can be revoked without affecting the others. Ask the Ping
maintainer for a key. Keys are stored only as hashes.
