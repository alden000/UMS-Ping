#!/usr/bin/env node
/**
 * Save a copy of every story's picture with the site, so readers never depend on a news site allowing its
 * images to be embedded elsewhere (some refuse on phones or outside their region). Run before publishing:
 *
 *   node scripts/fetch_images.mjs data/issues/<date>.json
 *
 * For each entry it uses, in order: the entry's `image`, the article's og:image / twitter:image, or the largest
 * photo inside the article (at least 600 px wide). The file is downloaded from the article page itself (so the
 * publisher sees a normal reader), resized to 1200 px wide JPEG by Python Pillow, and saved as
 * assets/img/<issue>/<entry id>.jpg. The entry's `image` then points at that file and `imageSource` keeps
 * the original URL. Entries with a YouTube `video` keep its thumbnail and are skipped.
 * Entries whose `image` already points into assets/img/ are skipped, so re-running is cheap.
 *
 * Playwright: set PLAYWRIGHT_MODULE / CHROMIUM_PATH as for verify_sources.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/fetch_images.mjs data/issues/<date>.json"); process.exit(2); }
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const issue = JSON.parse(fs.readFileSync(file, "utf8"));
const outDir = path.join("assets", "img", issue.id);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  viewport: { width: 1280, height: 900 }, locale: "en-SG", timezoneId: "Asia/Singapore",
});

let saved = 0, missing = 0;
for (const sec of issue.sections) for (const e of sec.entries) {
  if (e.video || String(e.image || "").startsWith("assets/img/")) continue;
  const page = await ctx.newPage();
  let src = e.image || "", how = src ? "entry" : "";
  try {
    await page.goto(e.source.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    if (!src) {
      const found = await page.evaluate(() => {
        const meta = (s) => document.querySelector(s)?.getAttribute("content") || "";
        const og = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
        if (og) return { src: new URL(og, location.href).href, how: "og:image" };
        const imgs = [...document.querySelectorAll("article img, main img, .entry-content img, img")]
          .filter((i) => i.naturalWidth >= 600 && !/logo|icon|avatar|sprite|banner-ad/i.test(i.src + i.className))
          .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
        return imgs[0] ? { src: imgs[0].currentSrc || imgs[0].src, how: "article photo" } : null;
      });
      if (found) ({ src, how } = found);
    }
    if (!src) { console.log(`none  ${e.id}  no picture on ${e.source.url}`); missing++; await page.close(); continue; }
    let body;
    const res = await page.request.get(src, { headers: { referer: e.source.url }, timeout: 30000 });
    const type = res.headers()["content-type"] || "";
    if (res.ok() && (!type || type.startsWith("image/"))) body = await res.body();
    else {
      // Some sites only serve images to their own pages: fetch it from inside the article instead.
      const b64 = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) return null;
        const bytes = new Uint8Array(await r.arrayBuffer());
        let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      }, src).catch(() => null);
      if (!b64) throw new Error(`HTTP ${res.status()} ${type}`);
      body = Buffer.from(b64, "base64");
    }
    const raw = path.join(outDir, `${e.id}.download`);
    fs.writeFileSync(raw, body);
    const out = path.join(outDir, `${e.id}.jpg`);
    execFileSync("python3", ["-c", `
import sys
from PIL import Image
im = Image.open(sys.argv[1])
im = im.convert("RGB")
if im.width > 1200:
    im = im.resize((1200, round(im.height * 1200 / im.width)), Image.LANCZOS)
if im.width < 320:
    raise SystemExit("image too small")
im.save(sys.argv[2], "JPEG", quality=80, optimize=True, progressive=True)
`, raw, out]);
    fs.unlinkSync(raw);
    e.imageSource = src;
    e.image = out.split(path.sep).join("/");
    saved++;
    console.log(`saved ${e.id}  (${how})  ${Math.round(fs.statSync(out).size / 1024)} KB`);
  } catch (err) {
    console.log(`fail  ${e.id}  ${String(err.message).split("\n")[0]}  (${src || e.source.url})`);
    missing++;
  }
  await page.close();
}
await browser.close();
fs.writeFileSync(file, JSON.stringify(issue, null, 2) + "\n");
console.log(`\n${saved} pictures saved to ${outDir}, ${missing} entries without one (the site draws an infographic for those).`);
