#!/usr/bin/env node
/**
 * Open every source link of an issue in a real browser (Chromium via Playwright) and check that a reader
 * would actually land on a readable article. Run before publishing:
 *
 *   node scripts/verify_sources.mjs data/issues/<date>.json
 *
 * Hard failures (exit code 1, the story must be fixed or dropped):
 *   - navigation error or HTTP status >= 400
 *   - the page ends up on a different site (redirect off-site, e.g. to a login or region portal)
 *   - a visible password field, or login / paywall / region-block wording on a short page
 *   - too little text to be an article
 * Warnings (review, usually fix):
 *   - same-site redirect (update the link to the final URL)
 *   - published date on the page differs from the entry date by more than 2 days
 *   - login / paywall wording somewhere on a long page
 *
 * A check from this machine cannot see blocks that only apply in the reader's country or office;
 * those go into data/blocked-sources.json, which scripts/build.py enforces.
 *
 * Playwright: set PLAYWRIGHT_MODULE to its entry file if it is not resolvable from here, and
 * CHROMIUM_PATH to a Chromium binary if Playwright's own download is not installed.
 */
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/verify_sources.mjs data/issues/<date>.json");
  process.exit(2);
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const issue = JSON.parse(fs.readFileSync(file, "utf8"));

const WALL = /(subscribe (now )?to (continue|read)|sign in to (continue|read)|log ?in to (continue|read)|create a free account to|register (now )?to (continue|read)|this (article|content|story) is (only )?(available )?(for|to) (subscribers|members)|members[- ]only|internal portal|authorized device|access denied|you have reached your (free )?(article )?limit|not available in your (region|country))/i;
const MIN_TEXT = 1200;
const host = (u) => new URL(u).hostname.replace(/^www\./, "");

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
  locale: "en-SG",
  timezoneId: "Asia/Singapore",
});

let hard = 0, warn = 0;
const entries = issue.sections.flatMap((s, si) => s.entries.map((e, n) => ({ ...e, id: e.id || `t${si + 1}-${n + 1}` })));
for (const e of entries) {
  const url = e.source.url;
  const problems = [], notes = [];
  const page = await ctx.newPage();
  try {
    let res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Rate limits and bot challenges (429/503) are usually temporary: wait and retry once.
    if (res && [429, 503].includes(res.status())) {
      await page.waitForTimeout(8000);
      res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
    await page.waitForTimeout(3500); // let consent banners, paywalls and client-side redirects appear
    const status = res ? res.status() : 0;
    const final = page.url();
    const d = await page.evaluate(() => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const text = document.body ? document.body.innerText : "";
      const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
      return {
        text: text.length,
        head: text.slice(0, 4000),
        all: text,
        password: [...document.querySelectorAll("input[type=password]")].some(visible),
        published: meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || meta('meta[itemprop="datePublished"]')
          || document.querySelector("time[datetime]")?.getAttribute("datetime") || "",
      };
    });
    if (status >= 400) problems.push(`HTTP ${status}`);
    if (host(final) !== host(url)) problems.push(`redirected off-site to ${final}`);
    else if (final.replace(/[#?].*$/, "") !== url.replace(/[#?].*$/, "")) notes.push(`redirects to ${final} (update the link)`);
    if (d.password) problems.push("visible password field (login page)");
    const wall = d.all.match(WALL);
    if (wall && d.text < 3000) problems.push(`login/paywall wording: "${wall[0]}"`);
    else if (wall) notes.push(`login/paywall wording on page: "${wall[0]}" (check it is not blocking the article)`);
    if (d.text < MIN_TEXT) problems.push(`only ${d.text} characters of text (not a readable article)`);
    if (d.published) {
      const days = Math.abs((new Date(d.published) - new Date(e.date + "T12:00:00Z")) / 864e5);
      if (Number.isFinite(days) && days > 2) notes.push(`page date ${d.published.slice(0, 10)} vs entry date ${e.date}`);
    }
  } catch (err) {
    problems.push(`could not load: ${String(err.message).split("\n")[0]}`);
  }
  await page.close();
  hard += problems.length ? 1 : 0;
  warn += notes.length ? 1 : 0;
  const mark = problems.length ? "FAIL" : notes.length ? "warn" : " ok ";
  console.log(`${mark}  ${e.id}  ${e.source.name}  ${url}`);
  for (const p of problems) console.log(`        ✗ ${p}`);
  for (const n of notes) console.log(`        ! ${n}`);
}
await browser.close();
console.log(`\n${entries.length} sources checked: ${hard} failing, ${warn} with warnings.`);
process.exit(hard ? 1 : 0);
