/**
 * Ping reading analytics.
 *
 * Measures how an issue is read so the weekly curation can learn what readers value: active reading time,
 * how far they scroll and whether they skim or stop to read, time spent on each section and story, and what
 * they interact with. One record per visit, sent to the feedback Worker (POST /track) when the page is hidden
 * and every minute while it is being read; the Worker overwrites the record, so a visit is counted once.
 *
 * Anonymous: the only identifiers are the random device id the site already uses for votes and a random
 * visit id. No names, emails, IPs or page content leave the browser. The Worker adds country, city and network
 * from Cloudflare. Automated browsers and devices excluded from the dashboard ("ping:notrack") are not tracked.
 */
(() => {
  const CFG = window.PING_CONFIG || {};
  let excluded = false;
  try { excluded = localStorage.getItem("ping:notrack") === "1"; } catch {}
  if (!CFG.feedbackEndpoint || navigator.webdriver || excluded) return;

  const ENDPOINT = CFG.feedbackEndpoint.replace(/\/+$/, "") + "/track";
  const IDLE_AFTER = 20;        // seconds without input before a visible page stops counting as "reading"
  const PAUSE_AFTER = 3;        // seconds without scrolling (while active) that count as a reading pause
  const FAST_SCROLL = 2500;     // px per second: faster than anyone reads
  const MAX_SENDS = 30;
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);

  let v = null;                 // the current visit record
  let sends = 0, dirty = false, lastInput = Date.now(), lastScrollAt = Date.now(), lastY = scrollY, pausedCounted = false;
  let visibleCards = new Map(), cardObs = null;

  function device() {
    const w = Math.min(screen.width, screen.height);
    return w < 600 ? "mobile" : w < 1000 ? "tablet" : "desktop";
  }
  function referrer() {
    if (!document.referrer) return "direct";
    try {
      const h = new URL(document.referrer).hostname;
      return h === location.hostname ? "internal" : /mail|outlook|gmail/i.test(h) ? "email" : h.replace(/^www\./, "");
    } catch { return "other"; }
  }

  function start(issue, client) {
    if (v && v.issue === issue) return;
    if (v) send(true);
    let visits = 0;
    try { visits = +localStorage.getItem("ping:visits") || 0; localStorage.setItem("ping:visits", visits + 1); } catch {}
    v = { sid: rid(), client, issue, start: new Date().toISOString(), last: null, device: device(),
          vw: innerWidth, vh: innerHeight, ref: referrer(), returning: visits > 0, entry: location.hash.split("/")[2] || "",
          active: 0, total: 0, depth: 0, bottom: false, pauses: 0, scrolled: 0, fast: 0,
          sections: {}, cards: {}, ev: {} };
    sends = 0; dirty = true;
    observeCards();
  }

  const card = (id) => (v.cards[id] ||= { s: 0, o: 0, m: 0, p: 0, u: 0 });
  const bump = (name) => { v.ev[name] = (v.ev[name] || 0) + 1; dirty = true; };

  function observeCards() {
    cardObs?.disconnect(); visibleCards = new Map();
    cardObs = new IntersectionObserver((ents) => ents.forEach((en) => {
      if (en.isIntersecting && en.intersectionRatio >= 0.5) visibleCards.set(en.target.dataset.eid, true);
      else visibleCards.delete(en.target.dataset.eid);
    }), { threshold: [0, 0.5, 1] });
    setTimeout(() => document.querySelectorAll(".card[data-eid]").forEach((c) => cardObs.observe(c)), 300);
  }

  // The section under the middle of the screen gets the second; visible story cards share it.
  function currentSection() {
    const mid = innerHeight / 2;
    for (const s of document.querySelectorAll("#top, section.block[id]")) {
      const r = s.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) return s.id === "top" ? "hero" : s.id;
    }
    return "";
  }

  setInterval(() => {
    if (!v) return;
    v.total += 1;
    const active = document.visibilityState === "visible" && (Date.now() - lastInput) / 1000 < IDLE_AFTER;
    if (!active) return;
    v.active += 1; dirty = true;
    const sec = currentSection();
    if (sec) v.sections[sec] = (v.sections[sec] || 0) + 1;
    if (visibleCards.size) {
      const share = 1 / visibleCards.size;
      for (const id of visibleCards.keys()) card(id).s = Math.round((card(id).s + share) * 10) / 10;
    }
    if (!pausedCounted && (Date.now() - lastScrollAt) / 1000 >= PAUSE_AFTER) { v.pauses += 1; pausedCounted = true; }
  }, 1000);

  const input = () => { lastInput = Date.now(); };
  ["pointerdown", "keydown", "touchstart", "wheel", "mousemove"].forEach((t) => addEventListener(t, input, { passive: true }));

  let lastScrollT = performance.now();
  // Measured once per animation frame (not per scroll event), so tracking never adds work mid-scroll.
  let scrollQueued = false;
  addEventListener("scroll", () => {
    if (!v || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      input();
      const now = performance.now(), dy = Math.abs(scrollY - lastY), dt = Math.max(16, now - lastScrollT);
      v.scrolled += dy;
      if (dy / (dt / 1000) > FAST_SCROLL) v.fast += dy;
      lastY = scrollY; lastScrollT = now; lastScrollAt = Date.now(); pausedCounted = false;
      const h = document.documentElement.scrollHeight - innerHeight;
      if (h > 0) v.depth = Math.max(v.depth, Math.round((scrollY / h) * 100));
      if (!v.bottom) {
        const fb = document.getElementById("feedback");
        if (fb && fb.getBoundingClientRect().top < innerHeight) v.bottom = true;
      }
      dirty = true;
    });
  }, { passive: true });

  // What readers interact with (event delegation, so it survives re-renders).
  document.addEventListener("click", (e) => {
    if (!v) return;
    const t = e.target.closest("a, button, [data-map], canvas"); if (!t) return;
    const c = t.closest(".card[data-eid]"), id = c?.dataset.eid;
    if (id && t.matches("a.media, a.src, a[target=_blank]")) { card(id).o += 1; bump("outbound"); }
    else if (id && t.matches(".more")) { card(id).m += 1; bump("full_brief"); }
    else if (id && t.matches("[data-media]")) { card(id).p += 1; bump("video"); }
    else if (id && t.matches(".vote[data-vote]")) { card(id).u += 1; bump("vote"); }
    else if (id && t.matches("[data-share]")) bump("share");
    else if (id && t.matches("[data-reason]")) bump("vote_reason");
    else if (t.closest(".pick")) bump("brief_pick");
    else if (t.matches("[data-view]")) bump("view_" + t.dataset.view);
    else if (t.closest("#intel")) bump("map");
    else if (t.id === "archiveBtn") bump("archive");
    else if (t.id === "themeBtn") bump("theme");
    else if (t.id === "fbSend") bump("feedback_sent");
    else if (t.id === "tipSend") bump("recommendation_sent");
    else if (t.closest(".nav")) bump("nav");
    else if (t.closest(".stat, .cta-row")) bump("hero_cta");
    else if (t.closest("#footLinks a")) bump("email_or_json");
  }, true);

  function send(force) {
    if (!v || (!dirty && !force) || sends >= MAX_SENDS || v.active < 1) return;
    v.last = new Date().toISOString();
    const body = JSON.stringify(v);
    const ok = navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "text/plain" }));
    if (!ok) fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => {});
    sends += 1; dirty = false;
  }
  setInterval(() => send(false), 60000);
  addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") send(true); });
  addEventListener("pagehide", () => send(true));
  addEventListener("ping:render", (e) => start(e.detail.issue, e.detail.client));
})();
