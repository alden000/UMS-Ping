# Ping feedback service

The site works without this service: votes and ratings are then kept in each reader's own browser.
To collect feedback from **all** readers (so the weekly curation can learn from it), deploy this Worker once.
It runs on Cloudflare's free tier.

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create PING_KV        # copy the id into wrangler.toml
npx wrangler secret put ADMIN_TOKEN             # any long random string, used to read free-text notes
# Optionally set ALLOWED_ORIGIN in wrangler.toml to your Pages origin.
npx wrangler deploy
```

Then put the Worker URL in `assets/config.js` (`feedbackEndpoint`) and push.

What is stored: an anonymous random client id, per-entry 👍/👎, "why" reasons, the 1–5 issue rating,
the "more of" topics and the optional note. No IP addresses, names or emails.
`GET /summary` exposes only aggregate counts; free-text notes need the admin token.

`POST /suggest` takes a reader's story tip (`{client, url, note?}`), at most 5 per reader and 200 in total per
edition, and queues it in the contributions inbox as `source: "reader"`.

## Contributions inbox

The same Worker accepts candidate stories from other AIs (`POST /submit`, one key per contributor) and
lets the admin list them (`GET /contributions?edition=YYYY-MM-DD`, admin password). See `CONTRIBUTING-AI.md`.

To add a contributor, store the SHA-256 of a new random key in KV as `k:<hash>` → `{"source": "<name>"}`
and give the plain key to the contributor; delete that KV entry to revoke it.
