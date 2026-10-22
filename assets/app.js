/* Ping: interactive newsletter viewer.
   Data: data/index.json (archive) + data/issues/<id>.json (one issue).
   Routes: #/            → latest issue
           #/<id>        → a given issue
           #/<id>/<eid>  → a given issue, scrolled to one entry */
(() => {
  "use strict";

  const CFG = window.PING_CONFIG || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const fine = matchMedia("(pointer: fine)");

  /* ---------- Persistence (best effort; never required) ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("ping:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ping:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const clientId = store.get("client") || (() => {
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, "").slice(0, 20);
    store.set("client", id);
    return id;
  })();

  /* ---------- Haptics ---------- */
  const haptics = { on: store.get("haptics", true) };
  const PATTERNS = { tap: 8, select: 12, up: [10, 40, 18], down: [22], success: [12, 60, 12, 60, 24], ping: [6, 30, 6] };
  function haptic(kind = "tap") {
    if (!haptics.on || reduced.matches || !navigator.vibrate) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    try { navigator.vibrate(PATTERNS[kind] || 8); } catch { /* unsupported */ }
  }

  /* ---------- Section metadata ---------- */
  const SECTIONS = {
    threats: { n: "01", short: "Threats", label: "Threats & Incidents", color: "var(--c-threats)", hex: "#FF6B5B", depth: 200, zone: "Twilight zone · 200 m", third: "Location", blurb: "Verified waterborne threats, strikes and incursions involving USVs, AUVs, ROVs, semi-submersibles and WBIEDs." },
    platforms: { n: "02", short: "Platforms", label: "Unmanned Maritime Systems Product News", color: "var(--c-platforms)", hex: "#4CC9F0", depth: 1000, zone: "Midnight zone · 1,000 m", third: "Tech & Approach", blurb: "Newly unveiled, contracted or deployed surface and underwater platforms, globally." },
    tech: { n: "03", short: "Tech", label: "Product & Technology of Interest", color: "var(--c-tech)", hex: "#B69CFF", depth: 4000, zone: "Abyssal zone · 4,000 m", third: "Tech & Approach", blurb: "Sensors, launch & recovery, VTOL and tethered drones, and machine vision for security, emergency response and SAR." },
    comms: { n: "04", short: "Comms", label: "Maritime Comms Products & Technologies", color: "var(--c-comms)", hex: "#FFC857", depth: 6000, zone: "Hadal zone · 6,000 m", third: "Tech & Approach", blurb: "Satcom, mesh radio, acoustic modems, RF datalinks and optical links for uncrewed and digital maritime systems." },
  };
  const DOMAIN = { surface: { label: "Surface", c: "#4CC9F0" }, subsurface: { label: "Subsurface", c: "#7B8CFF" }, "cross-domain": { label: "Cross-domain", c: "#5CE1E6" } };
  const STATUS = { calm: { c: "var(--ok)", label: "Calm" }, elevated: { c: "var(--warn)", label: "Elevated" }, alert: { c: "var(--alert)", label: "Alert" } };

  const ICON = {
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0l4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 18.2 21H7"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3zm0 0l-4 8a3 3 0 0 1-3-3v-4H4.5a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 5.8 3H17"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
    cards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 10v10"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    star: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M12 2.8l2.75 5.57 6.15.9-4.45 4.33 1.05 6.12L12 16.83 6.5 19.72l1.05-6.12L3.1 9.27l6.15-.9z"/></svg>`,
    signal: (n) => `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${[0, 1, 2, 3].map((i) => `<path d="M${16 - 4 - i * 3.2} ${22 - i * 3.2}a${4 + i * 3.2} ${4 + i * 3.2} 0 0 1 ${8 + i * 6.4} 0" opacity="${i < n ? 1 : 0.22}"/>`).join("")}<circle cx="16" cy="24" r="2" fill="currentColor" stroke="none"/></svg>`,
  };

  const state = { index: null, issue: null, entries: [], votes: store.get("votes", {}), view: store.get("view", "cards"), summary: null };

  /* ---------- Formatting ---------- */
  const D = (s) => new Date(s + "T00:00:00Z");
  const fmt = (s, o) => D(s).toLocaleDateString("en-GB", { timeZone: "UTC", ...o });
  const short = (s) => fmt(s, { day: "numeric", month: "short" });
  const long = (s) => fmt(s, { day: "numeric", month: "short", year: "numeric" });
  const splitTitle = (t) => { const i = t.indexOf(" / "); return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i + 3)]; };
  // Special editions carry a decimal number, e.g. 1.5 → "Nº 001.5".
  const issueNo = (n) => { const [whole, part] = String(n).split("."); return "Nº " + whole.padStart(3, "0") + (part ? "." + part : ""); };

  /* ---------- Feedback transport ---------- */
  const Feedback = {
    get enabled() { return !!CFG.feedbackEndpoint; },
    url(p) { return CFG.feedbackEndpoint.replace(/\/+$/, "") + p; },
    async send(type, payload) {
      const body = { type, issue: state.issue.id, client: clientId, ts: new Date().toISOString(), ...payload };
      if (!this.enabled) return false;
      try {
        const r = await fetch(this.url("/event"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true });
        return r.ok;
      } catch { return false; }
    },
    async suggest(url, note) {
      if (!this.enabled) return { ok: false, error: "The feedback service isn't connected yet" };
      try {
        const r = await fetch(this.url("/suggest"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: clientId, url, note }) });
        return await r.json();
      } catch { return { ok: false, error: "Couldn't reach the Ping desk. Try again later." }; }
    },
    async summary(issue) {
      if (!this.enabled) return null;
      try { const r = await fetch(this.url("/summary?issue=" + encodeURIComponent(issue))); return r.ok ? r.json() : null; } catch { return null; }
    },
  };

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    $("span", t).textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------- Generative fallback art (when a source has no usable image) ---------- */
  function art(e, color) {
    let h = 0; for (const ch of e.id + e.title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => ((h = (h * 1664525 + 1013904223) >>> 0) / 4294967296);
    const rings = Array.from({ length: 6 }, (_, i) => `<circle cx="${70 + rnd() * 30}%" cy="${40 + rnd() * 30}%" r="${30 + i * 34}" fill="none" stroke="${color}" stroke-opacity="${0.5 - i * 0.07}" stroke-width="1"/>`).join("");
    const blips = Array.from({ length: 9 }, () => `<circle cx="${rnd() * 100}%" cy="${rnd() * 100}%" r="${1 + rnd() * 2.4}" fill="${color}" fill-opacity="${0.4 + rnd() * 0.6}"/>`).join("");
    const lines = Array.from({ length: 14 }, (_, i) => `<path d="M0 ${20 + i * 14} Q 160 ${10 + i * 14 + rnd() * 20} 320 ${20 + i * 14} T 640 ${20 + i * 14}" fill="none" stroke="${color}" stroke-opacity="${0.05 + rnd() * 0.08}"/>`).join("");
    return `<svg class="art" viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs><radialGradient id="g${e.id}" cx="75%" cy="45%" r="80%"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="#030B17" stop-opacity="0"/></radialGradient></defs>
      <rect width="640" height="360" fill="#061428"/><rect width="640" height="360" fill="url(#g${e.id})"/>${lines}${rings}${blips}
      <text x="24" y="336" fill="${color}" fill-opacity=".55" font-family="JetBrains Mono, monospace" font-size="13" letter-spacing="3">${esc((DOMAIN[e.domain]?.label || "").toUpperCase())} · ${esc(e.region.toUpperCase())}</text></svg>`;
  }

  // When a story has no usable picture: a small infographic of its key figures over the sonar artwork.
  function infographic(e, color) {
    const specs = (e.specs || []).slice(0, 3);
    const [t, vendor] = splitTitle(e.title);
    const body = specs.length
      ? `<ul class="ig-specs">${specs.map((x) => `<li><b>${esc(x.value)}</b><small>${esc(x.label)}</small></li>`).join("")}</ul>`
      : `<p class="ig-title">${esc(vendor || t)}</p>`;
    return `<div class="infog" style="--ig:${color}">${art(e, color)}<div class="ig-in">${body}</div></div>`;
  }

  // Contributing AIs credited on a story ("claude" is the curator itself, so it is not shown).
  const SOURCE_NAMES = { reader: "Reader tip", spark: "Gemini Spark", gemini: "Gemini API" };
  const sourceName = (v) => SOURCE_NAMES[v] || v.charAt(0).toUpperCase() + v.slice(1);
  const viaLabel = (e) => (e.via || []).filter((v) => v !== "claude").map(sourceName).join(", ");

  function ytId(url) {
    const m = String(url || "").match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  function media(e, sec, { big = false } = {}) {
    const vid = ytId(e.video);
    const thumb = vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : e.image;
    const img = thumb
      ? `<img src="${esc(thumb)}" alt="" loading="${big ? "eager" : "lazy"}" decoding="async" referrerpolicy="no-referrer" data-fallback="${esc(e.id)}">`
      : infographic(e, sec.hex);
    return img;
  }

  // The regional note is a list of short points (older issues have a single paragraph).
  const rwPoints = (rw) => (Array.isArray(rw?.note) ? rw.note : rw?.note ? [rw.note] : []).filter(Boolean);

  /* ---------- Render: hero ---------- */
  function renderHero(issue) {
    const counts = issue.sections.map((s) => [s.key, s.entries.length]);
    return `
    <section class="hero" id="top" aria-labelledby="heroTitle">
      <canvas id="sonar" aria-label="Sonar display. Each contact is a story in this issue; click to ping." role="img"></canvas>
      <div class="wrap">
        <div class="eyebrow"><span class="live"></span>${issueNo(issue.number)} · Week of ${esc(long(issue.window.end))}</div>
        <div class="wordmark" aria-hidden="true"><span>P</span><span>I</span><span>N</span><span>G</span><span class="dot">.</span></div>
        <h1 id="heroTitle">${esc(CFG.tagline || "Weekly intelligence on uncrewed maritime systems.")}</h1>
        <p class="window">${esc(issue.title)}<br>Coverage Window: Past 7 Days (<b>${esc(long(issue.window.start))} – ${esc(long(issue.window.end))}</b>)</p>
        <div class="stats">
          ${counts.map(([k, n]) => `<a class="stat mag" href="#${k}" style="--c:${SECTIONS[k].color}"><b data-count="${n}">0</b><span>${esc(SECTIONS[k].short)}</span></a>`).join("")}
        </div>
        <div class="cta-row">
          <a class="btn primary mag" href="#brief">Start the dive ${ICON.chev}</a>
          <a class="btn mag" href="issues/${esc(issue.id)}/email.html" target="_blank" rel="noopener noreferrer">${ICON.mail} Email edition</a>
        </div>
      </div>
      <div class="scroll-cue" aria-hidden="true">Descend<i></i></div>
    </section>`;
  }

  /* ---------- Render: editor's brief ---------- */
  function renderBrief(issue) {
    const picks = (issue.editorial?.picks || []).map((id) => state.entries.find((e) => e.id === id)).filter(Boolean);
    if (!picks.length) return "";
    return `
    <section class="block" id="brief" style="--c:var(--ping)" data-depth="40" data-zone="Sunlight zone · 40 m">
      <div class="wrap">
        <div class="block-head rv">
          <div class="block-num">00</div>
          <div class="block-title"><span class="zone">Sunlight zone · 40 m</span><h2>The Brief</h2><p>Three signals worth your first five minutes this week.</p></div>
        </div>
        <div class="picks">
          ${picks.map((e, i) => {
            const sec = SECTIONS[e.section];
            const [t, v] = splitTitle(e.title);
            return `<a class="pick rv" href="#/${esc(issue.id)}/${esc(e.id)}" data-jump="${esc(e.id)}" style="--c:${sec.color};--d:${i * 0.08}s">
              <div class="bgimg">${media(e, sec, { big: i === 0 })}</div>
              <div class="in"><span class="tag"><i></i>${esc(sec.short)} · ${esc(e.region)}</span><h3>${esc(t)}</h3><p>${esc(v ? v + " · " : "")}${esc(e.summary)}</p></div>
            </a>`;
          }).join("")}
        </div>
      </div>
    </section>`;
  }

  /* ---------- Render: intel / infographics ---------- */
  function renderIntel(issue) {
    const rw = issue.regionalWatch || { status: "calm", note: "" };
    const pts = rwPoints(rw);
    const st = STATUS[rw.status] || STATUS.calm;
    const sea = state.entries.filter((e) => e.region === "Southeast Asia");
    const days = [];
    for (let d = D(issue.window.start); d <= D(issue.window.end); d = new Date(d.getTime() + 864e5)) days.push(d.toISOString().slice(0, 10));
    const max = Math.max(1, ...issue.sections.map((s) => s.entries.length));
    const dom = Object.keys(DOMAIN).map((k) => [k, state.entries.filter((e) => e.domain === k).length]);
    const total = state.entries.length || 1;
    let acc = 0;
    const C = 2 * Math.PI * 38;
    return `
    <section class="block" id="intel" style="--c:var(--ping)" data-depth="120" data-zone="Sunlight zone · 120 m">
      <div class="wrap">
        <div class="block-head rv">
          <div class="block-num">∿</div>
          <div class="block-title"><span class="zone">Situation picture</span><h2>Where the signals came from</h2><p>Every contact on the map is a story in this issue. Hover or tap a contact for the headline, then click to jump to it.</p></div>
        </div>
        <div class="intel">
          <div class="panel map rv">
            <h3><span>Contact map · ${state.entries.length} contacts</span>
              <span class="seg" role="group" aria-label="Map focus"><span class="thumb"></span>
                <button type="button" data-map="global" aria-pressed="true">Global</button>
                <button type="button" data-map="sea" aria-pressed="false">Singapore &amp; SEA</button>
              </span></h3>
            <div class="mapbox" id="mapbox">
              <svg id="map" viewBox="0 0 360 140" preserveAspectRatio="xMidYMid meet" role="group" aria-label="World map of story locations">
                <path class="land" d="${window.PING_WORLD_DOTS || ""}" stroke-width="1.15"/>
                <path class="land fine" d="${window.PING_SEA_DOTS || ""}" stroke-width=".3"/>
                <g id="sgMark" transform="translate(283.8 78.65)"><circle class="sg-mark" r="3" stroke-width=".35" stroke-dasharray="1 1"/><text class="sg-label" x="4" y="-3" font-size="3">SINGAPORE</text></g>
                ${state.entries.map((e, i) => `<g class="blip" tabindex="0" role="button" aria-label="${esc(SECTIONS[e.section].short)}: ${esc(e.title)}" data-jump="${esc(e.id)}" style="--c:${SECTIONS[e.section].color};--d:${(i % 7) * 0.37}s" transform="translate(${(+e.lng + 180).toFixed(2)} ${(80 - e.lat).toFixed(2)})"><circle class="halo" r="2" stroke-width=".4"/><circle class="core" r="1.4"/></g>`).join("")}
              </svg>
              <div class="tip" id="tip"></div>
            </div>
            <div class="legend">${Object.entries(SECTIONS).map(([k, s]) => `<span style="--c:${s.color}"><i></i>${esc(s.short)}</span>`).join("")}</div>
          </div>
          <div class="panel watch rv" style="--s:${st.c};--d:.08s">
            <h3>Regional watch · Singapore &amp; SEA</h3>
            <div class="status"><div class="orb" aria-hidden="true"></div><div><small>Threat status</small><b>${esc(st.label)}${rw.label ? " · " + esc(rw.label) : ""}</b></div></div>
            ${pts.length > 1 ? `<ul class="rw-points">${pts.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p>${esc(pts[0] || "")}</p>`}
            ${sea.length ? `<h3 style="margin-top:30px;line-height:1.5">South-East Asia linked this&nbsp;week&nbsp;·&nbsp;${sea.length}</h3><ul>${sea.map((e) => `<li><a href="#/${esc(issue.id)}/${esc(e.id)}" data-jump="${esc(e.id)}" style="--c:${SECTIONS[e.section].color}"><i></i><span>${esc(splitTitle(e.title)[0])}</span></a></li>`).join("")}</ul>` : ""}
          </div>
          <div class="panel week rv">
            <h3>Week pulse · stories by publish date</h3>
            <div class="weekgrid" id="weekgrid" style="--days:${days.length}">
              ${days.map((d, di) => {
                const es = state.entries.filter((e) => e.date === d);
                return `<div class="day${d === issue.window.end ? " today" : ""}"><div class="stack">${es.map((e, j) => `<button type="button" title="${esc(e.title)}" aria-label="${esc(short(d))}: ${esc(e.title)}" data-jump="${esc(e.id)}" style="--c:${SECTIONS[e.section].color};--d:${(di * 0.06 + j * 0.05).toFixed(2)}s"></button>`).join("")}</div>
                  <label><b>${fmt(d, { day: "numeric" })}</b>${fmt(d, { weekday: "short" })}</label></div>`;
              }).join("")}
            </div>
          </div>
          <div class="panel mix rv" style="--d:.08s">
            <h3>Signal mix</h3>
            <div class="bars" id="bars">
              ${issue.sections.map((s) => `<div class="bar" style="--c:${SECTIONS[s.key].color}"><span>${esc(SECTIONS[s.key].short)}</span><div class="track"><div class="fill" data-w="${(s.entries.length / max) * 100}"></div></div><b>${s.entries.length}</b></div>`).join("")}
            </div>
            <div class="domains">
              <svg class="donut" viewBox="0 0 96 96" aria-hidden="true">
                <circle cx="48" cy="48" r="38" stroke="var(--surface-2)"/>
                ${dom.map(([k, n]) => { const len = (n / total) * C; const el = `<circle cx="48" cy="48" r="38" stroke="${DOMAIN[k].c}" stroke-dasharray="0 ${C}" data-dash="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}"/>`; acc += len; return el; }).join("")}
              </svg>
              <ul>${dom.map(([k, n]) => `<li style="--c:${DOMAIN[k].c}"><i></i>${DOMAIN[k].label}<b>${n}</b></li>`).join("")}</ul>
            </div>
            ${contributors(issue)}
          </div>
        </div>
      </div>
    </section>`;
  }

  // Who found this week's stories: { "claude": {"published": 15}, "gemini": {"submitted": 9, "published": 4} }
  function contributors(issue) {
    const c = issue.contributors;
    if (!c || Object.keys(c).length < 2) return "";
    const rows = Object.entries(c).map(([name, v]) => {
      const label = name === "claude" ? "Ping curator" : sourceName(name);
      const of = v.submitted != null ? ` <small>of ${v.submitted} suggested</small>` : "";
      return `<li><span>${esc(label)}</span><b>${v.published ?? 0}</b>${of}</li>`;
    }).join("");
    return `<div class="contrib"><h4>Sources of this week's stories</h4><ul>${rows}</ul></div>`;
  }

  /* ---------- Render: entry card ---------- */
  function card(e, i) {
    const sec = SECTIONS[e.section];
    const [t, vendor] = splitTitle(e.title);
    const third = e.section === "threats" ? e.location : e.tech;
    const v = state.votes[state.issue.id + ":" + e.id] || 0;
    const counts = state.summary?.entries?.[e.id];
    const vid = ytId(e.video);
    const extra = e.application || e.medium || (e.severity ? "Severity: " + e.severity : "");
    return `
    <article class="card rv" id="${esc(e.id)}" data-eid="${esc(e.id)}" style="--c:${sec.color};--d:${(i % 3) * 0.07}s" aria-labelledby="h-${esc(e.id)}">
      ${vid
        ? `<button type="button" class="media" data-media="${esc(e.id)}" aria-label="Play video: ${esc(t)}">`
        : `<a class="media" href="${esc(e.source.url)}" target="_blank" rel="noopener noreferrer" aria-label="Read the article on ${esc(e.source.name)}: ${esc(t)}">`}
        ${media(e, sec)}
        <span class="date">${esc(long(e.date))}</span>
        ${vid ? `<span class="play">${ICON.play}</span>` : `<span class="open">Read article ${ICON.ext}</span>`}
      ${vid ? "</button>" : "</a>"}
      <div class="body">
        <div class="kicker"><span class="sec">${esc(sec.short)}</span><span>${esc(e.region)}</span><span>${esc(DOMAIN[e.domain]?.label || "")}</span>${viaLabel(e) ? `<span class="via" title="First suggested by a contributor (another AI or a reader), verified by the Ping curator">via ${esc(viaLabel(e))}</span>` : ""}</div>
        <h3 id="h-${esc(e.id)}">${esc(t)}</h3>
        ${vendor ? `<p class="vendor">${esc(vendor)}</p>` : ""}
        ${extra ? `<p class="use">${esc(extra)}</p>` : ""}
        <p class="meta"><b>${esc(sec.third)}</b>${esc(third)}</p>
        <p class="summary">${esc(e.summary)}</p>
        <div class="details" id="d-${esc(e.id)}"><div><p>${esc(e.details)}</p></div></div>
        <button type="button" class="more" aria-expanded="false" aria-controls="d-${esc(e.id)}"><span>Full brief</span>${ICON.chev}</button>
        ${e.specs?.length ? `<ul class="specs">${e.specs.map((s) => `<li><small>${esc(s.label)}</small><b>${esc(s.value)}</b></li>`).join("")}</ul>` : ""}
      </div>
      <footer>
        <a class="src" href="${esc(e.source.url)}" target="_blank" rel="noopener noreferrer" title="Open source in a new tab"><span>${esc(e.source.name)}</span>${ICON.ext}</a>
        <div class="votes" role="group" aria-label="Was this useful?">
          <button type="button" class="vote up" data-vote="1" aria-pressed="${v === 1}" aria-label="Useful" title="More like this">${ICON.up}<span class="n">${counts?.up || ""}</span></button>
          <button type="button" class="vote down" data-vote="-1" aria-pressed="${v === -1}" aria-label="Not useful" title="Less like this">${ICON.down}<span class="n">${counts?.down || ""}</span></button>
          <button type="button" class="vote share" data-share aria-label="Share this brief" title="Share">${ICON.share}</button>
        </div>
        <div class="reasons" role="group" aria-label="What was off?">Why? ${["Not relevant to me", "Too far from SEA", "Not new", "Weak source"].map((r) => `<button type="button" class="chip" data-reason="${esc(r)}" aria-pressed="false">${esc(r)}</button>`).join("")}</div>
      </footer>
    </article>`;
  }

  function table(sec, key) {
    const m = SECTIONS[key];
    const cols = ["Date Published", key === "threats" ? "Threat/Incident" : "Product / Vendor", m.third, key === "threats" ? "Key Details & Capabilities" : "Product Capabilities & Specs", "Source Link"];
    const w = ["12%", "22%", "18%", "33%", "15%"];
    const rows = sec.entries.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.title)}</td><td>${esc(key === "threats" ? e.location : e.tech)}</td><td>${esc(e.details)}</td><td><a href="${esc(e.source.url)}" target="_blank" rel="noopener noreferrer">${esc(e.source.name)}</a></td></tr>`);
    if (!sec.entries.length) rows.push(`<tr><td class="n" colspan="5">${esc(sec.emptyNote)}</td></tr>`);
    if (key === "threats" && state.issue.regionalWatch?.note) rows.push(`<tr><td class="n" colspan="5"><b>Regional Note (Singapore &amp; Surrounding Waterways):</b> ${esc(rwPoints(state.issue.regionalWatch).join(" · "))}</td></tr>`);
    return `<div class="tablewrap"><table class="classic"><caption class="sr-only">${esc(sec.title)}</caption><thead><tr>${cols.map((c, i) => `<th scope="col" style="width:${w[i]}">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  }

  function renderSection(sec) {
    const m = SECTIONS[sec.key];
    const rw = state.issue.regionalWatch;
    const st = STATUS[rw?.status] || STATUS.calm;
    const cards = sec.entries.length
      ? `<div class="cards">${sec.entries.map(card).join("")}</div>`
      : `<div class="empty rv"><b>Quiet waters</b>${esc(sec.emptyNote)}</div>`;
    return `
    <section class="block sec" id="${esc(sec.key)}" style="--c:${m.color}" data-depth="${m.depth}" data-zone="${esc(m.zone)}">
      <div class="wrap">
        <div class="block-head rv">
          <div class="block-num">${m.n}</div>
          <div class="block-title"><span class="zone">${esc(m.zone)}</span><h2>${esc(sec.title)}</h2><p>${esc(m.blurb)} Sorted oldest to newest.</p></div>
          <div class="block-tools">
            <span class="seg" role="group" aria-label="Layout"><span class="thumb"></span>
              <button type="button" data-view="cards" aria-pressed="${state.view === "cards"}">${ICON.cards}Cards</button>
              <button type="button" data-view="table" aria-pressed="${state.view === "table"}">${ICON.table}Table</button>
            </span>
          </div>
        </div>
        <div class="view-cards" ${state.view === "table" ? "hidden" : ""}>${cards}
          ${sec.key === "threats" && rw?.note ? `<div class="note rv" style="--s:${st.c}">${ICON.shield}<div><b>Regional note: Singapore &amp; surrounding waterways.</b> ${esc(rwPoints(rw).join(" · "))}</div></div>` : ""}
        </div>
        <div class="view-table" ${state.view === "cards" ? "hidden" : ""}>${table(sec, sec.key)}</div>
      </div>
    </section>`;
  }

  /* ---------- Render: issue feedback ---------- */
  function renderFeedback(issue) {
    const prev = store.get("rating:" + issue.id);
    const topics = CFG.topics || [];
    return `
    <section class="block" id="feedback" data-depth="6500" data-zone="Trench floor · 6,500 m" style="--c:var(--ping)">
      <div class="wrap">
        <div class="fb rv${prev ? " sent" : ""}" id="fb">
          <div class="form">
            <div class="eyebrow"><span class="live"></span>Return signal</div>
            <h2>Shape next Monday's Ping.</h2>
            <p>Your 👍 / 👎 on each brief and this short check-in tune what gets curated next week. Feedback is anonymous, and we never ask for your name or email.</p>
            <h4 id="rateLbl">How was this week's newsletter?</h4>
            <div class="rating" role="radiogroup" aria-labelledby="rateLbl">
              ${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="false" data-rate="${n}" aria-label="${n} of 5">${ICON.star}</button>`).join("")}
            </div>
            <div class="rating-label" id="rateText"></div>
            <h4>Give me more of</h4>
            <div class="topics" role="group" aria-label="Topics">${topics.map((t) => `<button type="button" class="chip" data-topic="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join("")}</div>
            <label for="fbNote"><h4>Anything we missed? (optional)</h4></label>
            <textarea id="fbNote" maxlength="1000" placeholder="A story, vendor or region you want covered. Please leave out personal details."></textarea>
            <button type="button" class="btn primary mag" id="fbSend">Send Feedback</button>
            <p class="fine" id="fbFine">${Feedback.enabled ? "Feedback is collated automatically and used to improve the AI curation model. It's anonymous." : "Saved on this device. The shared feedback service isn't connected yet."}</p>
          </div>
          <div class="thanks" aria-live="polite">
            <svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="60" cy="60" r="54"/><circle cx="60" cy="60" r="54"/><circle cx="60" cy="60" r="54"/><circle cx="60" cy="60" r="6" fill="currentColor"/></svg>
            <h3>Feedback received.</h3>
            <p>Thank you. Next Monday's issue will take it into account.</p>
            <p style="margin-top:14px"><button type="button" class="btn" id="fbAgain">Edit my feedback</button></p>
          </div>
          ${Feedback.enabled ? `
          <div class="tipbox">
            <label for="tipUrl"><h4>Spotted a story we should cover?</h4></label>
            <input id="tipUrl" type="url" inputmode="url" maxlength="1000" placeholder="https:// link to the article" autocomplete="off">
            <input id="tipNote" type="text" maxlength="300" placeholder="Why it matters (optional)" autocomplete="off">
            <button type="button" class="btn primary mag" id="tipSend">Send Story Recommendation</button>
            <p class="fine">Recommendations help the AI curation model prepare future issues. Please leave out personal details.</p>
          </div>` : ""}
        </div>
      </div>
    </section>`;
  }

  /* ---------- Assemble ---------- */
  function render() {
    const issue = state.issue;
    state.entries = issue.sections.flatMap((s) => s.entries.map((e) => Object.assign(e, { section: s.key })));
    $("#main").innerHTML = renderHero(issue) + renderBrief(issue) + renderIntel(issue) + issue.sections.map(renderSection).join("") + renderFeedback(issue);
    $("#issuePill").textContent = `${issueNo(issue.number)} · ${short(issue.window.start)}–${short(issue.window.end)}`;
    $("#nav").innerHTML = [["brief", "Brief", "var(--ping)"], ["intel", "Map", "var(--ping)"], ...issue.sections.map((s) => [s.key, SECTIONS[s.key].short, SECTIONS[s.key].color]), ["feedback", "Feedback", "var(--ping)"]]
      .map(([id, l, c]) => `<a href="#${id}" style="--c:${c}" data-nav="${id}">${l}</a>`).join("");
    $("#footLinks").innerHTML = `<a href="issues/${esc(issue.id)}/email.html" target="_blank" rel="noopener noreferrer">Email edition (HTML)</a> · <a href="data/issues/${esc(issue.id)}.json" target="_blank" rel="noopener noreferrer">Issue data (JSON)</a>`;
    document.title = `Ping ${issueNo(issue.number)} · ${long(issue.window.end)}`;
    renderArchive();
    wire();
    // Lets assets/analytics.js know which issue is on screen.
    window.dispatchEvent(new CustomEvent("ping:render", { detail: { issue: issue.id, client: clientId } }));
  }

  function renderArchive() {
    $("#archiveList").innerHTML = (state.index?.issues || []).map((it) => `
      <li><a href="#/${esc(it.id)}" ${it.id === state.issue.id ? 'aria-current="page"' : ""}>
        <small>${issueNo(it.number)} · ${esc(long(it.window.start))} – ${esc(long(it.window.end))}</small>
        <b>${esc(it.top || it.headline || "Weekly update")}</b>
        <div class="dots">${Object.entries(it.counts).map(([k, n]) => `<span style="--c:${SECTIONS[k]?.color}">${n} ${esc(SECTIONS[k]?.short || k)}</span>`).join("")}</div>
      </a></li>`).join("");
  }

  /* ---------- Interactions ---------- */
  let cleanup = [];
  function wire() {
    cleanup.forEach((f) => f()); cleanup = [];

    // Images: fade in on load, fall back to generative art on error.
    $$("img[data-fallback]").forEach((img) => {
      const done = () => img.classList.add("loaded");
      if (img.complete && img.naturalWidth) done();
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", () => {
        const e = state.entries.find((x) => x.id === img.dataset.fallback);
        if (e) img.outerHTML = infographic(e, SECTIONS[e.section].hex);
      }, { once: true });
    });

    // Reveal + count-ups + bar fills
    const io = new IntersectionObserver((ents) => ents.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add("in");
      io.unobserve(en.target);
    }), { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    $$(".rv, #weekgrid").forEach((el) => io.observe(el));
    cleanup.push(() => io.disconnect());

    const vizIO = new IntersectionObserver((ents) => ents.forEach((en) => {
      if (!en.isIntersecting) return;
      $$(".fill", en.target).forEach((f) => (f.style.width = f.dataset.w + "%"));
      $$("[data-dash]", en.target).forEach((c) => c.setAttribute("stroke-dasharray", c.dataset.dash));
      vizIO.unobserve(en.target);
    }), { threshold: 0.3 });
    const mix = $(".panel.mix"); if (mix) vizIO.observe(mix);
    cleanup.push(() => vizIO.disconnect());

    $$("[data-count]").forEach((el, i) => countUp(el, +el.dataset.count, 900 + i * 150));

    // Segmented controls
    $$(".seg").forEach(positionThumb);

    // Layout toggle (applies to every section, remembered)
    $$("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

    // Card interactions
    $$(".card").forEach((c) => {
      c.addEventListener("pointermove", (ev) => {
        const r = c.getBoundingClientRect();
        c.style.setProperty("--mx", ev.clientX - r.left + "px");
        c.style.setProperty("--my", ev.clientY - r.top + "px");
      });
      $(".more", c).addEventListener("click", (ev) => {
        const open = c.classList.toggle("open");
        ev.currentTarget.setAttribute("aria-expanded", open);
        $("span", ev.currentTarget).textContent = open ? "Collapse" : "Full brief";
        haptic("tap");
      });
      $$(".vote[data-vote]", c).forEach((b) => b.addEventListener("click", () => vote(c, +b.dataset.vote, b)));
      $("[data-share]", c).addEventListener("click", () => share(c.dataset.eid));
      $$("[data-reason]", c).forEach((b) => b.addEventListener("click", () => {
        b.setAttribute("aria-pressed", "true");
        Feedback.send("reason", { entry: c.dataset.eid, reason: b.dataset.reason });
        const key = state.issue.id + ":" + c.dataset.eid;
        const rs = store.get("reasons", {}); rs[key] = b.dataset.reason; store.set("reasons", rs);
        haptic("select");
        setTimeout(() => $(".reasons", c).classList.remove("show"), 500);
        toast("Noted. We'll steer away from that.");
      }));
      // Images open the article in a new tab; only videos open the in-page player.
      const play = $("button.media", c);
      if (play) play.addEventListener("click", () => openMedia(c.dataset.eid));
      else $("a.media", c).addEventListener("click", () => haptic("tap"));
    });

    // Jump links (map blips, week dots, picks, SEA list)
    $$("[data-jump]").forEach((el) => {
      const go = (ev) => { ev.preventDefault(); jumpTo(el.dataset.jump); };
      el.addEventListener("click", go);
      el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") go(ev); });
    });

    wireMap();
    wireFeedback();
    wireMagnets();
    startSonar();
    observeSections();
  }

  function setView(v) {
    state.view = v; store.set("view", v);
    $$("section.sec").forEach((s) => {
      $(".view-cards", s).hidden = v !== "cards";
      $(".view-table", s).hidden = v !== "table";
    });
    $$("[data-view]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === v));
    $$(".block-tools .seg").forEach(positionThumb);
    if (v === "cards") $$("section.sec .rv").forEach((el) => el.classList.add("in"));
    haptic("select");
  }

  function positionThumb(seg) {
    const on = $('button[aria-pressed="true"]', seg); const th = $(".thumb", seg);
    if (!on || !th) return;
    th.style.left = on.offsetLeft + "px"; th.style.width = on.offsetWidth + "px";
  }

  function countUp(el, to, dur) {
    if (reduced.matches) { el.textContent = to; return; }
    const t0 = performance.now();
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  function jumpTo(id, { instant = false } = {}) {
    const el = document.getElementById(id);
    if (!el) return;
    const sec = el.closest("section.sec");
    if (sec && state.view === "table") setView("cards");
    el.classList.add("in");
    el.scrollIntoView({ behavior: instant || reduced.matches ? "auto" : "smooth", block: "center" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    history.replaceState(null, "", `#/${state.issue.id}/${id}`);
    haptic("ping");
  }

  function burst(btn) {
    if (reduced.matches) return;
    for (let i = 0; i < 10; i++) {
      const s = document.createElement("i");
      s.className = "burst";
      const a = (i / 10) * Math.PI * 2, r = 18 + Math.random() * 10;
      s.style.setProperty("--x", Math.cos(a) * r + "px"); s.style.setProperty("--y", Math.sin(a) * r + "px");
      btn.appendChild(s); setTimeout(() => s.remove(), 700);
    }
  }

  function vote(cardEl, val, btn) {
    const key = state.issue.id + ":" + cardEl.dataset.eid;
    const prev = state.votes[key] || 0;
    const next = prev === val ? 0 : val;
    if (next) state.votes[key] = next; else delete state.votes[key];
    store.set("votes", state.votes);
    $$(".vote[data-vote]", cardEl).forEach((b) => {
      const on = +b.dataset.vote === next;
      b.setAttribute("aria-pressed", on);
      const n = $(".n", b); const base = state.summary?.entries?.[cardEl.dataset.eid];
      if (base) {
        const k = b.dataset.vote === "1" ? "up" : "down";
        const delta = (on ? 1 : 0) - (+b.dataset.vote === prev ? 1 : 0);
        base[k] = Math.max(0, (base[k] || 0) + delta); n.textContent = base[k] || "";
      }
    });
    $(".reasons", cardEl).classList.toggle("show", next === -1);
    if (next === 1) { burst(btn); haptic("up"); } else if (next === -1) haptic("down"); else haptic("tap");
    Feedback.send("vote", { entry: cardEl.dataset.eid, section: state.entries.find((e) => e.id === cardEl.dataset.eid)?.section, value: next, previous: prev });
    if (next && !store.get("votedOnce")) { store.set("votedOnce", true); toast(next === 1 ? "Signal boosted. More like this next week." : "Got it. Less like this."); }
  }

  async function share(id) {
    const e = state.entries.find((x) => x.id === id);
    const url = location.href.split("#")[0] + `#/${state.issue.id}/${id}`;
    haptic("tap");
    if (navigator.share && !fine.matches) {
      try { await navigator.share({ title: "Ping · " + splitTitle(e.title)[0], text: e.summary, url }); return; } catch { /* cancelled */ }
    }
    try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { prompt("Copy link", url); }
  }

  /* ---------- Lightbox ---------- */
  let lastFocus = null;
  function openMedia(id) {
    const e = state.entries.find((x) => x.id === id);
    const vid = ytId(e.video);
    if (!vid) return;
    const frame = $("#lightboxFrame");
    frame.className = "frame video";
    frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&rel=0" title="${esc(e.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
    lastFocus = document.activeElement;
    const lb = $("#lightbox");
    lb.classList.add("show"); lb.setAttribute("aria-hidden", "false");
    $("#scrim").classList.add("show");
    lb.focus();
    haptic("tap");
  }
  function closeOverlays() {
    const lb = $("#lightbox");
    if (lb.classList.contains("show")) { lb.classList.remove("show"); lb.setAttribute("aria-hidden", "true"); setTimeout(() => ($("#lightboxFrame").innerHTML = ""), 300); }
    const dr = $("#drawer");
    if (dr.classList.contains("show")) { dr.classList.remove("show"); dr.setAttribute("aria-hidden", "true"); $("#archiveBtn").setAttribute("aria-expanded", "false"); }
    $("#scrim").classList.remove("show");
    if (lastFocus) { lastFocus.focus({ preventScroll: true }); lastFocus = null; }
  }
  function openArchive() {
    lastFocus = document.activeElement;
    $("#drawer").classList.add("show"); $("#drawer").setAttribute("aria-hidden", "false");
    $("#archiveBtn").setAttribute("aria-expanded", "true");
    $("#scrim").classList.add("show");
    ($("#archiveList a") || $("#drawer [data-close]")).focus();
    haptic("tap");
  }

  /* ---------- Map ---------- */
  function wireMap() {
    const svg = $("#map"); if (!svg) return;
    const tip = $("#tip"), box = $("#mapbox");
    const VIEWS = { global: [0, 0, 360, 140], sea: [240, 52, 96, 37.3] };
    let cur = VIEWS.global.slice(), raf;
    const scaleBlips = (w) => {
      const k = Math.max(0.32, w / 360);
      $$(".blip", svg).forEach((g) => { $(".core", g).setAttribute("r", (1.4 * k).toFixed(3)); $(".halo", g).setAttribute("r", (2 * k).toFixed(3)); $(".halo", g).setAttribute("stroke-width", (0.4 * k).toFixed(3)); });
      const sg = $("#sgMark"); $("circle", sg).setAttribute("r", 3 * k); $("circle", sg).setAttribute("stroke-width", 0.35 * k);
      const tx = $("text", sg); tx.setAttribute("font-size", Math.max(1.4, 3 * k)); tx.setAttribute("x", 4 * k); tx.setAttribute("y", -3 * k);
      $(".land", svg).setAttribute("stroke-width", (1.15 * Math.max(0.5, k)).toFixed(3));
      svg.classList.toggle("zoomed", w < 200);
    };
    const go = (to) => {
      cancelAnimationFrame(raf);
      const from = cur.slice(), t0 = performance.now(), dur = reduced.matches ? 1 : 900;
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        cur = from.map((v, i) => v + (to[i] - v) * e);
        svg.setAttribute("viewBox", cur.join(" ")); scaleBlips(cur[2]);
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    $$("[data-map]").forEach((b) => b.addEventListener("click", () => {
      $$("[data-map]").forEach((x) => x.setAttribute("aria-pressed", x === b));
      positionThumb(b.closest(".seg")); go(VIEWS[b.dataset.map]); haptic("select"); hideTip();
    }));
    const showTip = (g) => {
      const e = state.entries.find((x) => x.id === g.dataset.jump); if (!e) return;
      const r = g.getBoundingClientRect(), br = box.getBoundingClientRect();
      tip.innerHTML = `<small>${esc(SECTIONS[e.section].short)} · ${esc(short(e.date))}</small><b>${esc(splitTitle(e.title)[0])}</b>${esc(e.region)}`;
      let x = r.left + r.width / 2 - br.left; x = Math.max(110, Math.min(br.width - 110, x));
      tip.style.left = x + "px"; tip.style.top = r.top - br.top + "px";
      tip.classList.add("show"); g.classList.add("hot");
    };
    const hideTip = () => { tip.classList.remove("show"); $$(".blip.hot", svg).forEach((g) => g.classList.remove("hot")); };
    $$(".blip", svg).forEach((g) => {
      g.addEventListener("pointerenter", () => showTip(g));
      g.addEventListener("pointerleave", hideTip);
      g.addEventListener("focus", () => showTip(g));
      g.addEventListener("blur", hideTip);
    });
  }

  /* ---------- Issue feedback ---------- */
  function wireFeedback() {
    const fb = $("#fb"); if (!fb) return;
    const labels = ["", "Poor: mostly not useful", "Fair: a few useful bits", "Good: a solid week", "Very good: very useful", "Excellent: essential reading"];
    let rating = 0;
    const paint = (n) => $$("[data-rate]", fb).forEach((b) => { const on = +b.dataset.rate <= n; b.classList.toggle("lit", on); b.setAttribute("aria-checked", +b.dataset.rate === rating); });
    $$("[data-rate]", fb).forEach((b) => {
      b.addEventListener("pointerenter", () => { paint(+b.dataset.rate); $("#rateText").textContent = labels[+b.dataset.rate]; });
      b.addEventListener("pointerleave", () => { paint(rating); $("#rateText").textContent = labels[rating]; });
      b.addEventListener("click", () => { rating = +b.dataset.rate; paint(rating); $("#rateText").textContent = labels[rating]; haptic(rating >= 4 ? "up" : "select"); });
    });
    $$("[data-topic]", fb).forEach((b) => b.addEventListener("click", () => { b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true"); haptic("select"); }));
    $("#fbSend").addEventListener("click", async () => {
      const topics = $$('[data-topic][aria-pressed="true"]', fb).map((b) => b.dataset.topic);
      const note = $("#fbNote").value.trim();
      if (!rating && !topics.length && !note) { toast("Pick a rating or a topic first"); haptic("down"); return; }
      store.set("rating:" + state.issue.id, { rating, topics, note, ts: Date.now() });
      fb.classList.add("sent");
      haptic("success");
      await Feedback.send("issue", { rating, topics, note });
    });
    $("#tipSend")?.addEventListener("click", async () => {
      const url = $("#tipUrl").value.trim(), note = $("#tipNote").value.trim();
      if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url)) { toast("Paste the article's full https:// link"); haptic("down"); $("#tipUrl").focus(); return; }
      $("#tipSend").disabled = true;
      const r = await Feedback.suggest(url, note);
      $("#tipSend").disabled = false;
      if (r && r.ok) { $("#tipUrl").value = ""; $("#tipNote").value = ""; haptic("success"); toast("Recommendation received. Thank you!"); }
      else { haptic("down"); toast((r && r.error) || "Couldn't send the recommendation"); }
    });
    $("#fbAgain").addEventListener("click", () => {
      const prev = store.get("rating:" + state.issue.id) || {};
      fb.classList.remove("sent");
      rating = prev.rating || 0; paint(rating); $("#rateText").textContent = labels[rating];
      $$("[data-topic]", fb).forEach((b) => b.setAttribute("aria-pressed", (prev.topics || []).includes(b.dataset.topic)));
      $("#fbNote").value = prev.note || "";
    });
  }

  /* ---------- Magnetic buttons ---------- */
  function wireMagnets() {
    if (!fine.matches || reduced.matches) return;
    $$(".mag").forEach((el) => {
      el.addEventListener("pointermove", (ev) => {
        const r = el.getBoundingClientRect();
        el.style.transform = `translate(${(ev.clientX - r.left - r.width / 2) * 0.18}px, ${(ev.clientY - r.top - r.height / 2) * 0.25}px)`;
      });
      el.addEventListener("pointerleave", () => (el.style.transform = ""));
    });
  }

  /* ---------- Sonar hero ---------- */
  let sonarStop = () => {};
  function startSonar() {
    sonarStop();
    const cv = $("#sonar"); if (!cv) return;
    const ctx = cv.getContext("2d");
    let W = 0, dpr = 1, raf = 0, visible = true, last = performance.now(), ang = -Math.PI / 2;
    const pings = [];
    // Place each story as a contact: angle from its longitude, range from its position in the issue.
    const contacts = state.entries.map((e, i) => ({
      a: ((+e.lng + 180) / 360) * Math.PI * 2 - Math.PI / 2,
      r: 0.25 + ((i * 0.618) % 1) * 0.68,
      c: SECTIONS[e.section].hex, lit: 0,
    }));
    const css = () => getComputedStyle(document.documentElement);
    let ping = css().getPropertyValue("--ping").trim() || "#5CE1E6";
    const resize = () => { const r = cv.getBoundingClientRect(); dpr = Math.min(2, devicePixelRatio || 1); W = r.width; cv.width = W * dpr; cv.height = W * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ping = css().getPropertyValue("--ping").trim() || ping; };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(cv);

    const draw = (t) => {
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      const c = W / 2, R = W / 2 - 4;
      ctx.clearRect(0, 0, W, W);
      ctx.lineWidth = 1;
      for (let i = 1; i <= 5; i++) { ctx.beginPath(); ctx.arc(c, c, (R * i) / 5, 0, Math.PI * 2); ctx.strokeStyle = hexA(ping, i === 5 ? 0.35 : 0.13); ctx.stroke(); }
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * R * 0.2, c + Math.sin(a) * R * 0.2); ctx.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R); ctx.strokeStyle = hexA(ping, 0.06); ctx.stroke(); }
      // Bearing ticks
      for (let i = 0; i < 72; i++) { const a = (i / 72) * Math.PI * 2, l = i % 6 ? 6 : 12; ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * R, c + Math.sin(a) * R); ctx.lineTo(c + Math.cos(a) * (R - l), c + Math.sin(a) * (R - l)); ctx.strokeStyle = hexA(ping, 0.3); ctx.stroke(); }
      if (!reduced.matches) ang += dt * 0.9;
      // Sweep wedge
      if (ctx.createConicGradient) {
        const g = ctx.createConicGradient(ang - 1.2, c, c);
        g.addColorStop(0, hexA(ping, 0)); g.addColorStop(1.2 / (Math.PI * 2), hexA(ping, 0.28)); g.addColorStop(1.2 / (Math.PI * 2) + 0.001, hexA(ping, 0)); g.addColorStop(1, hexA(ping, 0));
        ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, R, ang - 1.2, ang); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      }
      ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.cos(ang) * R, c + Math.sin(ang) * R); ctx.strokeStyle = hexA(ping, 0.85); ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
      // Contacts flare as the sweep passes, then decay.
      for (const k of contacts) {
        const d = (((ang - k.a) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        if (d < 0.06) k.lit = 1;
        k.lit = reduced.matches ? 0.8 : Math.max(0.12, k.lit - dt * 0.35);
        const x = c + Math.cos(k.a) * k.r * R, y = c + Math.sin(k.a) * k.r * R;
        ctx.beginPath(); ctx.arc(x, y, 9 * k.lit + 2, 0, Math.PI * 2); ctx.fillStyle = hexA(k.c, 0.12 * k.lit); ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fillStyle = hexA(k.c, 0.25 + 0.75 * k.lit); ctx.fill();
      }
      // Click pings
      for (let i = pings.length - 1; i >= 0; i--) {
        const p = pings[i]; p.t += dt;
        const rr = p.t * R * 0.9, al = Math.max(0, 1 - p.t / 1.3);
        ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.strokeStyle = hexA(ping, al * 0.8); ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
        if (al <= 0) pings.splice(i, 1);
      }
      ctx.beginPath(); ctx.arc(c, c, 3, 0, Math.PI * 2); ctx.fillStyle = ping; ctx.fill();
      if (visible && !reduced.matches) raf = requestAnimationFrame(draw);
    };
    const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) { cancelAnimationFrame(raf); last = performance.now(); raf = requestAnimationFrame(draw); } });
    io.observe(cv);
    const onClick = (ev) => {
      const r = cv.getBoundingClientRect();
      pings.push({ x: ev.clientX - r.left, y: ev.clientY - r.top, t: 0 });
      contacts.forEach((k) => (k.lit = 1));
      haptic("ping");
      if (reduced.matches) requestAnimationFrame(draw);
    };
    cv.addEventListener("click", onClick);
    raf = requestAnimationFrame(draw);
    sonarStop = () => { cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); cv.removeEventListener("click", onClick); };
  }

  function hexA(color, a) {
    const m = color.trim().match(/^#([0-9a-f]{6})$/i);
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
  }

  /* ---------- Marine snow ---------- */
  (function snow() {
    const cv = $("#snow"), ctx = cv.getContext("2d");
    let W, H, parts = [], raf;
    const init = () => {
      W = cv.width = innerWidth; H = cv.height = innerHeight;
      const n = Math.round(Math.min(90, (W * H) / 22000));
      parts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.4 + 0.3, v: Math.random() * 0.25 + 0.05, w: Math.random() * Math.PI * 2, a: Math.random() * 0.35 + 0.08 }));
    };
    const tick = () => {
      ctx.clearRect(0, 0, W, H);
      const light = document.documentElement.dataset.theme === "light";
      ctx.fillStyle = light ? "rgba(31,78,121,1)" : "rgba(200,230,255,1)";
      const depth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--depth")) || 0;
      for (const p of parts) {
        p.y += p.v; p.w += 0.01; p.x += Math.sin(p.w) * 0.15;
        if (p.y > H + 4) { p.y = -4; p.x = Math.random() * W; }
        ctx.globalAlpha = p.a * (0.4 + depth * 0.9) * (light ? 0.5 : 1);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    init(); addEventListener("resize", init, { passive: true });
    const run = () => { cancelAnimationFrame(raf); if (!reduced.matches && !document.hidden) tick(); else ctx.clearRect(0, 0, W, H); };
    document.addEventListener("visibilitychange", run); reduced.addEventListener?.("change", run);
    run();
  })();

  /* ---------- Scroll: progress, depth gauge, active nav ---------- */
  let sectionIO;
  function observeSections() {
    sectionIO?.disconnect();
    sectionIO = new IntersectionObserver((ents) => ents.forEach((en) => {
      if (!en.isIntersecting) return;
      const id = en.target.id;
      $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === id));
      $("#depthZone").textContent = en.target.dataset.zone || "Surface";
    }), { rootMargin: "-45% 0px -50% 0px" });
    $$("#main > section").forEach((s) => sectionIO.observe(s));
  }
  let ticking = false;
  function onScroll() {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const max = document.documentElement.scrollHeight - innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
      $(".progress i").style.transform = `scaleX(${p})`;
      document.documentElement.style.setProperty("--depth", p.toFixed(3));
      $("#topbar").classList.toggle("scrolled", scrollY > 10);
      $("#depth").classList.toggle("show", scrollY > innerHeight * 0.5);
      $("#depthDot").style.top = p * 100 + "%";
      $("#depthRead").textContent = String(Math.round(p * 6500)).padStart(4, "0") + " m";
    });
  }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", () => $$(".seg").forEach(positionThumb), { passive: true });

  /* ---------- Global controls ---------- */
  function syncToggles() {
    $("#themeBtn").setAttribute("aria-pressed", document.documentElement.dataset.theme === "light");
    $("#hapticBtn").setAttribute("aria-pressed", haptics.on);
    $('meta[name="theme-color"]').setAttribute("content", document.documentElement.dataset.theme === "light" ? "#F2F6FB" : "#030B17");
  }
  function toggleTheme() {
    const apply = () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next; store.set("theme", next); syncToggles();
    };
    if (document.startViewTransition && !reduced.matches) document.startViewTransition(apply); else apply();
    haptic("select");
  }
  $("#themeBtn").addEventListener("click", toggleTheme);
  $("#hapticBtn").addEventListener("click", () => {
    haptics.on = !haptics.on; store.set("haptics", haptics.on); syncToggles();
    if (haptics.on) haptic("success");
    toast(haptics.on ? "Haptics on" : "Haptics off");
  });
  $("#archiveBtn").addEventListener("click", openArchive);
  $("#scrim").addEventListener("click", closeOverlays);
  $$("[data-close]").forEach((b) => b.addEventListener("click", closeOverlays));
  // The video viewer closes with a tap anywhere around the player (taps on the video itself go to YouTube).
  $("#lightbox").addEventListener("click", () => { closeOverlays(); haptic("tap"); });
  $("#archiveList").addEventListener("click", (ev) => { if (ev.target.closest("a")) closeOverlays(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") return closeOverlays();
    if (ev.target.closest("input, textarea, [contenteditable]") || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === "j" || k === "k") {
      const cards = $$(".card"); if (!cards.length) return;
      const mid = innerHeight / 2;
      let i = cards.findIndex((c) => c.getBoundingClientRect().top > mid - 40);
      if (i < 0) i = cards.length;
      const target = k === "j" ? cards[Math.min(cards.length - 1, i)] : cards[Math.max(0, i - 2)];
      if (target) jumpTo(target.id);
    } else if (k === "a") openArchive();
    else if (k === "t") toggleTheme();
  });
  syncToggles();

  /* ---------- Data + routing ---------- */
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(url + " → " + r.status);
    return r.json();
  }
  function parseRoute() {
    const [, id, eid] = location.hash.match(/^#\/([\d-]{10})?(?:\/(t\d-\d+))?/) || [];
    return { id, eid };
  }
  async function route() {
    const { id, eid } = parseRoute();
    if (!location.hash.startsWith("#/") && state.issue) return; // in-page anchor
    try {
      state.index = state.index || await getJSON("data/index.json");
      const target = id || state.index.latest;
      if (!state.issue || state.issue.id !== target) {
        const issue = await getJSON(`data/issues/${target}.json`);
        const swap = () => { state.issue = issue; state.summary = null; render(); window.scrollTo(0, 0); };
        if (state.issue && document.startViewTransition && !reduced.matches) await document.startViewTransition(swap).finished; else swap();
        Feedback.summary(issue.id).then((s) => { if (s && state.issue.id === issue.id) { state.summary = s; updateCounts(); } });
      }
      if (eid) requestAnimationFrame(() => setTimeout(() => jumpTo(eid, { instant: true }), 60));
    } catch (err) {
      console.error(err);
      $("#main").innerHTML = `<div class="fail"><div><h1>Lost contact.</h1><p>We couldn't load this issue. Check your connection, or open the <a href="#/">latest issue</a>.</p></div></div>`;
    }
  }
  function updateCounts() {
    $$(".card").forEach((c) => {
      const s = state.summary?.entries?.[c.dataset.eid]; if (!s) return;
      $(".vote.up .n", c).textContent = s.up || ""; $(".vote.down .n", c).textContent = s.down || "";
    });
  }
  addEventListener("hashchange", route);
  route();
})();
