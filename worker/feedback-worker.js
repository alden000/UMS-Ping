/**
 * Ping feedback Worker (Cloudflare Workers + KV).
 *
 *   POST /event              { type: "vote"|"reason"|"issue", issue, client, entry?, section?, value?, reason?, rating?, topics?, note? }
 *   GET  /summary?issue=ID   aggregate tallies for one issue (public, no free text)
 *   GET  /summary            aggregate tallies for every issue (used by weekly curation)
 *   GET  /notes?issue=ID     free-text notes (requires  Authorization: Bearer <ADMIN_TOKEN>)
 *   POST /suggest            { client, url, note? }  a reader's story tip, queued for the next edition
 *   POST /track              one visit's reading analytics from assets/analytics.js (site origin only)
 *   GET  /analytics?issue=ID visit records, newest first (requires ADMIN_TOKEN; issue=all for every issue)
 *   GET  /tips               all reader story tips still stored (requires ADMIN_TOKEN)
 *
 *   POST /submit             candidate stories from a contributing AI (requires  Authorization: Bearer <contributor key>)
 *   GET  /contributions?edition=YYYY-MM-DD   submissions queued for an edition (requires ADMIN_TOKEN)
 *
 * Contributor keys are stored hashed in KV as  k:<sha256 hex of key>  →  {"source": "gemini"}.
 * Bindings: KV namespace PING_KV; vars ALLOWED_ORIGIN (comma-separated origins); secret ADMIN_TOKEN.
 * Only an anonymous random client id is stored. No IPs, names or emails.
 */
const ISSUE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY = /^t[1-4]-\d{1,2}$/;
const CLIENT = /^[A-Za-z0-9]{8,40}$/;

export default {
  async fetch(req, env) {
    // ALLOWED_ORIGIN may list several comma-separated origins; echo back the one that matches.
    const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((o) => o.trim());
    const origin = req.headers.get("origin") || "";
    const cors = {
      "access-control-allow-origin": allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0],
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
      "vary": "origin",
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);

    try {
      if (req.method === "POST" && url.pathname === "/event") return json(await handleEvent(await req.json(), env));
      if (req.method === "GET" && url.pathname === "/summary") {
        const issue = url.searchParams.get("issue");
        if (issue) return ISSUE.test(issue) ? json(await getAgg(env, issue)) : json({ error: "bad issue" }, 400);
        const list = await env.PING_KV.list({ prefix: "a:" });
        const all = {};
        for (const k of list.keys) all[k.name.slice(2)] = await env.PING_KV.get(k.name, "json");
        return json(all);
      }
      if (req.method === "GET" && url.pathname === "/notes") {
        if (!env.ADMIN_TOKEN || req.headers.get("authorization") !== "Bearer " + env.ADMIN_TOKEN) return json({ error: "unauthorized" }, 401);
        const issue = url.searchParams.get("issue") || "";
        const list = await env.PING_KV.list({ prefix: "n:" + issue });
        const notes = [];
        for (const k of list.keys) notes.push(await env.PING_KV.get(k.name, "json"));
        return json(notes);
      }
      if (req.method === "POST" && url.pathname === "/track") {
        if (!allowed.includes(origin) && !allowed.includes("*")) return json({ error: "forbidden" }, 403);
        if (Number(req.headers.get("content-length") || 0) > 30000) return json({ error: "payload too large" }, 413);
        return json(await handleTrack(JSON.parse(await req.text()), req, env));
      }
      const admin = env.ADMIN_TOKEN && req.headers.get("authorization") === "Bearer " + env.ADMIN_TOKEN;
      if (req.method === "GET" && url.pathname === "/analytics") {
        if (!admin) return json({ error: "unauthorized" }, 401);
        const issue = url.searchParams.get("issue") || "all";
        if (issue !== "all" && !ISSUE.test(issue)) return json({ error: "bad issue" }, 400);
        return json(await listValues(env, issue === "all" ? "v:" : `v:${issue}:`, 900));
      }
      if (req.method === "GET" && url.pathname === "/tips") {
        if (!admin) return json({ error: "unauthorized" }, 401);
        const subs = await listValues(env, "s:", 500);
        return json(subs.filter((x) => x && x.source === "reader"));
      }
      if (req.method === "POST" && url.pathname === "/suggest") {
        if (Number(req.headers.get("content-length") || 0) > 4000) return json({ error: "payload too large" }, 413);
        return json(await handleSuggest(await req.json(), env));
      }
      if (req.method === "POST" && url.pathname === "/submit") {
        const source = await contributorFor(req, env);
        if (!source) return json({ error: "unauthorized" }, 401);
        if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return json({ error: "payload too large" }, 413);
        return json(await handleSubmit(source, await req.json(), env));
      }
      if (req.method === "GET" && url.pathname === "/contributions") {
        if (!env.ADMIN_TOKEN || req.headers.get("authorization") !== "Bearer " + env.ADMIN_TOKEN) return json({ error: "unauthorized" }, 401);
        const edition = url.searchParams.get("edition") || editionFor(new Date());
        if (!ISSUE.test(edition)) return json({ error: "bad edition" }, 400);
        const list = await env.PING_KV.list({ prefix: "s:" + edition + ":" });
        const subs = [];
        for (const k of list.keys) subs.push(await env.PING_KV.get(k.name, "json"));
        return json({ edition, submissions: subs });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "bad request" }, 400);
    }
  },
};

const blank = () => ({ entries: {}, sections: {}, rating: { sum: 0, n: 0, dist: [0, 0, 0, 0, 0] }, topics: {}, updated: null });
async function getAgg(env, issue) { return (await env.PING_KV.get("a:" + issue, "json")) || blank(); }

async function handleEvent(ev, env) {
  if (!ev || !ISSUE.test(ev.issue) || !CLIENT.test(ev.client)) throw new Error("invalid");
  const agg = await getAgg(env, ev.issue);

  if (ev.type === "vote") {
    if (!ENTRY.test(ev.entry) || ![-1, 0, 1].includes(ev.value)) throw new Error("invalid");
    const key = `c:${ev.issue}:${ev.entry}:${ev.client}`;
    const prev = Number(await env.PING_KV.get(key)) || 0; // trust the server's record, not the client's
    if (prev === ev.value) return { ok: true };
    const e = (agg.entries[ev.entry] ||= { up: 0, down: 0, reasons: {} });
    const s = (agg.sections[ev.section || ev.entry.slice(0, 2)] ||= { up: 0, down: 0 });
    for (const [v, d] of [[prev, -1], [ev.value, 1]]) {
      if (v === 1) { e.up = Math.max(0, e.up + d); s.up = Math.max(0, s.up + d); }
      if (v === -1) { e.down = Math.max(0, e.down + d); s.down = Math.max(0, s.down + d); }
    }
    await env.PING_KV.put(key, String(ev.value));
  } else if (ev.type === "reason") {
    if (!ENTRY.test(ev.entry) || typeof ev.reason !== "string") throw new Error("invalid");
    const e = (agg.entries[ev.entry] ||= { up: 0, down: 0, reasons: {} });
    const r = ev.reason.slice(0, 40);
    e.reasons[r] = (e.reasons[r] || 0) + 1;
  } else if (ev.type === "issue") {
    const key = `r:${ev.issue}:${ev.client}`;
    const prev = await env.PING_KV.get(key, "json");
    const rating = Number.isInteger(ev.rating) && ev.rating >= 1 && ev.rating <= 5 ? ev.rating : 0;
    const topics = Array.isArray(ev.topics) ? ev.topics.filter((t) => typeof t === "string").slice(0, 12).map((t) => t.slice(0, 40)) : [];
    if (prev) { // replace this reader's earlier submission
      if (prev.rating) { agg.rating.sum -= prev.rating; agg.rating.n -= 1; agg.rating.dist[prev.rating - 1] -= 1; }
      for (const t of prev.topics || []) agg.topics[t] = Math.max(0, (agg.topics[t] || 0) - 1);
    }
    if (rating) { agg.rating.sum += rating; agg.rating.n += 1; agg.rating.dist[rating - 1] += 1; }
    for (const t of topics) agg.topics[t] = (agg.topics[t] || 0) + 1;
    await env.PING_KV.put(key, JSON.stringify({ rating, topics }));
    const note = typeof ev.note === "string" ? ev.note.trim().slice(0, 1000) : "";
    if (note) await env.PING_KV.put(`n:${ev.issue}:${Date.now()}:${ev.client}`, JSON.stringify({ issue: ev.issue, note, rating, topics, ts: new Date().toISOString() }));
  } else throw new Error("invalid");

  agg.updated = new Date().toISOString();
  await env.PING_KV.put("a:" + ev.issue, JSON.stringify(agg));
  return { ok: true };
}

/* ---------- Contributions from other AIs ---------- */
const MAX_BODY = 200_000;
const MAX_ENTRIES = 40;
const MAX_SUBMISSIONS_PER_WEEK = 10;
const SECTIONS = ["threats", "platforms", "tech", "comms"];
const DOMAINS = ["surface", "subsurface", "cross-domain"];

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function contributorFor(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S{20,200})$/);
  if (!m) return null;
  const rec = await env.PING_KV.get("k:" + (await sha256(m[1])), "json");
  return rec && rec.source ? rec.source : null;
}

// The Monday edition a submission feeds: today if it is Monday before 07:00 SGT, else the next Monday.
function editionFor(now) {
  const sgt = new Date(now.getTime() + 8 * 3600e3);
  const dow = sgt.getUTCDay();
  let add = (8 - dow) % 7;
  if (dow === 1 && sgt.getUTCHours() >= 7) add = 7;
  return new Date(sgt.getTime() + add * 864e5).toISOString().slice(0, 10);
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function httpsUrl(v) {
  try { const u = new URL(String(v)); return u.protocol === "https:" && String(v).length <= 1000 ? u.toString() : ""; } catch { return ""; }
}

// Keep only known fields, bounded in size. Everything is still re-verified by the curator.
function cleanEntry(e) {
  if (!e || typeof e !== "object") return { error: "not an object" };
  const section = str(e.section, 20);
  if (!SECTIONS.includes(section)) return { error: "section must be one of " + SECTIONS.join("|") };
  const date = str(e.date, 10);
  if (!ISSUE.test(date)) return { error: "date must be YYYY-MM-DD" };
  const url = httpsUrl(e.source && e.source.url);
  if (!url) return { error: "source.url must be an https URL" };
  const title = str(e.title, 200), details = str(e.details, 1500);
  if (!title || !details) return { error: "title and details are required" };
  const out = {
    section, date, title, details,
    summary: str(e.summary, 300),
    source: { name: str(e.source.name, 100) || new URL(url).hostname, url },
  };
  if (section === "threats") out.location = str(e.location, 400); else out.tech = str(e.tech, 400);
  const img = httpsUrl(e.image), vid = httpsUrl(e.video);
  if (img) out.image = img;
  if (vid) out.video = vid;
  if (e.region) out.region = str(e.region, 40);
  if (Number.isFinite(e.lat) && Number.isFinite(e.lng) && Math.abs(e.lat) <= 90 && Math.abs(e.lng) <= 180) { out.lat = e.lat; out.lng = e.lng; }
  if (DOMAINS.includes(e.domain)) out.domain = e.domain;
  if (Array.isArray(e.specs)) out.specs = e.specs.slice(0, 6).map((x) => ({ label: str(x && x.label, 40), value: str(x && x.value, 40) })).filter((x) => x.label && x.value);
  if (Array.isArray(e.tags)) out.tags = e.tags.slice(0, 10).map((t) => str(t, 30)).filter(Boolean);
  return { entry: out };
}

async function handleSubmit(source, body, env) {
  const edition = editionFor(new Date());
  const countKey = `q:${edition}:${source}`;
  const count = Number(await env.PING_KV.get(countKey)) || 0;
  if (count >= MAX_SUBMISSIONS_PER_WEEK) return { ok: false, error: "weekly submission limit reached", edition };
  const raw = Array.isArray(body && body.entries) ? body.entries : [];
  if (!raw.length) return { ok: false, error: "entries must be a non-empty array", edition };
  const accepted = [], rejected = [];
  raw.slice(0, MAX_ENTRIES).forEach((e, index) => {
    const r = cleanEntry(e);
    if (r.error) rejected.push({ index, error: r.error }); else accepted.push(r.entry);
  });
  if (raw.length > MAX_ENTRIES) rejected.push({ index: MAX_ENTRIES, error: `only the first ${MAX_ENTRIES} entries are read` });
  if (accepted.length) {
    const ts = new Date().toISOString();
    await env.PING_KV.put(`s:${edition}:${source}:${Date.now()}`,
      JSON.stringify({ source, received: ts, edition, entries: accepted }),
      { expirationTtl: 60 * 60 * 24 * 60 });
    await env.PING_KV.put(countKey, String(count + 1), { expirationTtl: 60 * 60 * 24 * 21 });
  }
  return { ok: accepted.length > 0, source, edition, accepted: accepted.length, rejected };
}

/* ---------- Story tips from readers ---------- */
const MAX_TIPS_PER_READER = 5;     // per edition
const MAX_TIPS_PER_EDITION = 200;

// Stored in the same queue as AI contributions (source "reader"), so the curator verifies them the same way.
async function handleSuggest(body, env) {
  if (!body || !CLIENT.test(body.client)) throw new Error("invalid");
  const url = httpsUrl(body.url);
  if (!url) return { ok: false, error: "Paste the article's full https:// link" };
  const edition = editionFor(new Date());
  const mine = `t:${edition}:${body.client}`, all = `t:${edition}:all`;
  const [m, a] = [Number(await env.PING_KV.get(mine)) || 0, Number(await env.PING_KV.get(all)) || 0];
  if (m >= MAX_TIPS_PER_READER || a >= MAX_TIPS_PER_EDITION) return { ok: false, error: "Tip limit reached for this week" };
  const ttl = { expirationTtl: 60 * 60 * 24 * 21 };
  await env.PING_KV.put(`s:${edition}:reader:${Date.now()}:${body.client}`, JSON.stringify({
    source: "reader", received: new Date().toISOString(), edition,
    entries: [{ tip: true, source: { name: new URL(url).hostname, url }, note: str(body.note, 300) }],
  }), { expirationTtl: 60 * 60 * 24 * 60 });
  await env.PING_KV.put(mine, String(m + 1), ttl);
  await env.PING_KV.put(all, String(a + 1), ttl);
  return { ok: true, edition };
}

/* ---------- Reading analytics ---------- */
const SID = /^[a-z0-9]{8,24}$/;
const SECTION_KEY = /^[a-z0-9-]{1,20}$/;
const num = (v, max) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v * 10) / 10)) : 0);

// One record per visit, overwritten by later sends from the same visit. No IP is stored.
async function handleTrack(b, req, env) {
  if (!b || !SID.test(b.sid) || !CLIENT.test(b.client) || !ISSUE.test(b.issue)) throw new Error("invalid");
  const cf = req.cf || {};
  const ua = req.headers.get("user-agent") || "";
  if (/bot|crawl|spider|headless|lighthouse|preview/i.test(ua)) return { ok: true, skipped: "bot" };
  const sections = {}, cards = {}, ev = {};
  for (const [k, val] of Object.entries(b.sections || {}).slice(0, 20)) if (SECTION_KEY.test(k)) sections[k] = num(val, 86400);
  for (const [k, c] of Object.entries(b.cards || {}).slice(0, 80)) if (ENTRY.test(k) && c) {
    cards[k] = { s: num(c.s, 86400), o: num(c.o, 99), m: num(c.m, 99), p: num(c.p, 99), u: num(c.u, 99) };
  }
  for (const [k, val] of Object.entries(b.ev || {}).slice(0, 40)) if (SECTION_KEY.test(k.replace(/_/g, "-"))) ev[k] = num(val, 999);
  const rec = {
    sid: b.sid, client: b.client, issue: b.issue,
    start: str(b.start, 30), last: new Date().toISOString(),
    device: ["mobile", "tablet", "desktop"].includes(b.device) ? b.device : "other",
    vw: num(b.vw, 10000), vh: num(b.vh, 10000), ref: str(b.ref, 60), returning: !!b.returning, entry: ENTRY.test(b.entry) ? b.entry : "",
    active: num(b.active, 86400), total: num(b.total, 86400), depth: num(b.depth, 100), bottom: !!b.bottom,
    pauses: num(b.pauses, 9999), scrolled: num(b.scrolled, 1e7), fast: num(b.fast, 1e7),
    sections, cards, ev,
    country: cf.country || "", city: cf.city || "", region: cf.region || "", network: cf.asOrganization || "", tz: cf.timezone || "",
  };
  await env.PING_KV.put(`v:${b.issue}:${b.sid}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 400 });
  return { ok: true };
}

async function listValues(env, prefix, max) {
  const out = [];
  let cursor;
  do {
    const page = await env.PING_KV.list({ prefix, cursor });
    for (const k of page.keys) {
      if (out.length >= max) break;
      out.push(await env.PING_KV.get(k.name, "json"));
    }
    cursor = page.list_complete || out.length >= max ? null : page.cursor;
  } while (cursor);
  return out.filter(Boolean).sort((a, b) => String(b.last || b.received || "").localeCompare(String(a.last || a.received || "")));
}
