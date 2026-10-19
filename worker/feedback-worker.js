/**
 * Ping feedback Worker (Cloudflare Workers + KV).
 *
 *   POST /event              { type: "vote"|"reason"|"issue", issue, client, entry?, section?, value?, reason?, rating?, topics?, note? }
 *   GET  /summary?issue=ID   aggregate tallies for one issue (public, no free text)
 *   GET  /summary            aggregate tallies for every issue (used by weekly curation)
 *   GET  /notes?issue=ID     free-text notes (requires  Authorization: Bearer <ADMIN_TOKEN>)
 *
 * Bindings: KV namespace PING_KV; vars ALLOWED_ORIGIN (e.g. https://alden000.github.io); secret ADMIN_TOKEN.
 * Only an anonymous random client id is stored. No IPs, names or emails.
 */
const ISSUE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY = /^t[1-4]-\d{1,2}$/;
const CLIENT = /^[A-Za-z0-9]{8,40}$/;

export default {
  async fetch(req, env) {
    const cors = {
      "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
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
    if (note) await env.PING_KV.put(`n:${ev.issue}:${Date.now()}:${ev.client}`, JSON.stringify({ note, rating, topics, ts: new Date().toISOString() }));
  } else throw new Error("invalid");

  agg.updated = new Date().toISOString();
  await env.PING_KV.put("a:" + ev.issue, JSON.stringify(agg));
  return { ok: true };
}
