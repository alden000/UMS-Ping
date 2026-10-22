#!/usr/bin/env python3
"""Ping build: validate issue data, rebuild the archive index and render email editions.

Usage:
  python3 scripts/build.py                 # validate + build everything
  python3 scripts/build.py --check-links   # also fetch every source URL
"""
import argparse
import datetime as dt
import html
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ISSUES_DIR = ROOT / "data" / "issues"
INDEX_FILE = ROOT / "data" / "index.json"
EMAIL_DIR = ROOT / "issues"

SECTIONS = [
    ("threats", "T1", "Threats & Incidents (Past 7 Days)",
     ["Date Published", "Threat/Incident", "Location", "Key Details & Capabilities", "Source Link"]),
    ("platforms", "T2", "Unmanned Maritime Systems Product News (Past 7 Days)",
     ["Date Published", "Product / Vendor", "Tech & Approach", "Product Capabilities & Specs", "Source Link"]),
    ("tech", "T3", "Product & Technology of Interest for Maritime Applications (Past 7 Days)",
     ["Date Published", "Product / Vendor", "Tech & Approach", "Product Capabilities & Specs", "Source Link"]),
    ("comms", "T4", "Maritime Comms Products & Technologies (Past 7 Days)",
     ["Date Published", "Product / Vendor", "Tech & Approach", "Product Capabilities & Specs", "Source Link"]),
]
WIDTHS = ["12%", "22%", "18%", "33%", "15%"]
REGIONS = {"Southeast Asia", "East Asia", "South Asia", "Middle East", "Black Sea", "Europe",
           "Americas", "Africa", "Oceania", "Global"}
DOMAINS = {"surface", "subsurface", "cross-domain"}
# Paths that indicate an index / archive page rather than a standalone article.
INDEX_PATH = re.compile(r"^/?$|/(news|blog|press|media|category|categories|tag|tags|topics?|search|archive)/?$", re.I)
VIA = re.compile(r"^[a-z0-9-]{1,24}$")
# Subscription sites (rechecked 2026-10-22: they also turn automated readers away, so a story can't be verified).
GATED_HOSTS = {"lloydslist.com", "www.lloydslist.com", "ft.com", "www.ft.com",
               "wsj.com", "www.wsj.com", "bloomberg.com", "www.bloomberg.com"}
# Janes: the news articles are free to read; its intelligence products and databases are subscription-only.
JANES_NEWS = re.compile(r"/defence-news/", re.I)

BLOCKED_FILE = ROOT / "data" / "blocked-sources.json"
BLOCKED = {h["host"].lower(): h.get("reason", "") for h in
           (json.loads(BLOCKED_FILE.read_text(encoding="utf-8"))["hosts"] if BLOCKED_FILE.exists() else [])}

errors, warnings = [], []


def err(issue, msg):
    errors.append(f"[{issue}] {msg}")


def warn(issue, msg):
    warnings.append(f"[{issue}] {msg}")


def parse_date(s):
    return dt.date.fromisoformat(s)


def validate_url(issue, where, url):
    p = urllib.parse.urlparse(url or "")
    if p.scheme != "https" or not p.netloc:
        err(issue, f"{where}: source URL must be absolute https: {url!r}")
        return
    if INDEX_PATH.search(p.path) and not p.query:
        err(issue, f"{where}: source URL looks like an index/homepage, need a deep link: {url}")
    if p.netloc.lower() in GATED_HOSTS:
        err(issue, f"{where}: source host is known to be gated: {p.netloc}")
    if p.netloc.lower() in ("janes.com", "www.janes.com") and not JANES_NEWS.search(p.path):
        err(issue, f"{where}: only Janes news articles (/defence-news/) are free to read: {url}")
    host = p.netloc.lower().split(":")[0]
    for blocked, reason in BLOCKED.items():
        if host == blocked or host.endswith("." + blocked):
            err(issue, f"{where}: source host {host} is on data/blocked-sources.json ({reason})")


def validate_issue(data):
    iid = data.get("id", "?")
    for key in ("id", "number", "title", "window", "sections"):
        if key not in data:
            err(iid, f"missing top-level field {key!r}")
    if errors:
        return
    start, end = parse_date(data["window"]["start"]), parse_date(data["window"]["end"])
    if (end - start).days != 7:
        warn(iid, f"coverage window is {(end - start).days} days, expected 7")
    keys = [s["key"] for s in data["sections"]]
    if keys != [s[0] for s in SECTIONS]:
        err(iid, f"sections must be exactly {[s[0] for s in SECTIONS]} in order, got {keys}")
    seen_urls = {}
    for sec_i, sec in enumerate(data["sections"], start=1):
        entries = sec.get("entries", [])
        if not entries and not sec.get("emptyNote"):
            err(iid, f"section {sec['key']} has no entries and no emptyNote")
        # Chronological, oldest first (stable for equal dates).
        entries.sort(key=lambda e: e.get("date", ""))
        for n, e in enumerate(entries, start=1):
            e["id"] = f"t{sec_i}-{n}"
            where = f"{sec['key']}#{n}"
            required = ["date", "title", "details", "summary", "source", "region", "lat", "lng", "domain"]
            required.append("location" if sec["key"] == "threats" else "tech")
            for f in required:
                if e.get(f) in (None, ""):
                    err(iid, f"{where}: missing {f}")
            try:
                d = parse_date(e["date"])
                if not (start <= d <= end):
                    err(iid, f"{where}: date {d} outside window {start}..{end}")
            except (KeyError, ValueError):
                err(iid, f"{where}: bad date {e.get('date')!r}")
            src = e.get("source") or {}
            validate_url(iid, where, src.get("url"))
            if src.get("url") in seen_urls:
                warn(iid, f"{where}: duplicate source URL also used in {seen_urls[src['url']]}")
            seen_urls[src.get("url")] = where
            if e.get("region") not in REGIONS:
                err(iid, f"{where}: region {e.get('region')!r} not in {sorted(REGIONS)}")
            if e.get("domain") not in DOMAINS:
                err(iid, f"{where}: domain {e.get('domain')!r} not in {sorted(DOMAINS)}")
            if not (-90 <= float(e.get("lat", 0)) <= 90 and -180 <= float(e.get("lng", 0)) <= 180):
                err(iid, f"{where}: lat/lng out of range")
            if len(e.get("summary", "")) > 200:
                warn(iid, f"{where}: summary longer than 200 chars")
            via = e.get("via", [])
            if not isinstance(via, list) or not all(isinstance(v, str) and VIA.match(v) for v in via):
                err(iid, f"{where}: via must be a list of short lowercase source names, e.g. [\"gemini\"]")
    picks = data.get("editorial", {}).get("picks", [])
    ids = {e["id"] for s in data["sections"] for e in s.get("entries", [])}
    for p in picks:
        if p not in ids:
            err(iid, f"editorial pick {p!r} does not match an entry id")


def fmt_window(data):
    f = lambda s: parse_date(s).strftime("%-d %b %Y")
    return f"{f(data['window']['start'])} – {f(data['window']['end'])}"


def via_note(ent):
    """Credit for stories first suggested by a contributing AI (shown under the source link)."""
    via = [v for v in ent.get("via", []) if v != "claude"]
    if not via:
        return ""
    names = {"reader": "Reader tip", "spark": "Gemini Spark", "gemini": "Gemini API"}
    return f'<br><span style="font-size: 11px; color: #888888;">via {html.escape(", ".join(names.get(v, v.title()) for v in via))}</span>'


def render_email(data):
    e = html.escape
    td = "padding: 10px 12px; border: 1px solid #dddddd; vertical-align: top;"
    out = [
        "<!DOCTYPE html>", "<html>", "<head>", '  <meta charset="utf-8">',
        f"  <title>{e(data['title'])}</title>", "</head>",
        '<body style="font-family: Arial, sans-serif; color: #333333; line-height: 1.5; margin: 0; padding: 20px; background-color: #f9f9f9;">',
        "",
        '  <div style="width: 100%; box-sizing: border-box; background-color: #ffffff; padding: 24px; border-radius: 6px; border: 1px solid #e0e0e0;">',
        "",
        '    <h2 style="color: #1F4E79; margin-top: 0; border-bottom: 2px solid #1F4E79; padding-bottom: 8px;">',
        f"      {e(data['title'])}", "    </h2>",
        '    <p style="font-size: 14px; color: #666666; margin-bottom: 24px;">',
        f"      Coverage Window: Past 7 Days ({e(fmt_window(data))}) | Verified Global Defense &amp; Maritime Authorities",
        "    </p>",
    ]
    for (key, code, title, cols), sec in zip(SECTIONS, data["sections"]):
        last = key == "comms"
        out += ["", f"    <!-- Table {code[1]}: {e(title)} -->",
                f'    <h3 style="color: #2c3e50; margin-top: 24px; margin-bottom: 12px;">{e(title)}</h3>',
                f'    <table style="width: 100%; border-collapse: collapse; margin-bottom: {20 if last else 30}px; font-size: 13px; box-sizing: border-box;">',
                "      <thead>", '        <tr style="background-color: #1F4E79; color: #ffffff; text-align: left;">']
        for c, w in zip(cols, WIDTHS):
            out.append(f'          <th style="padding: 10px 12px; border: 1px solid #1F4E79; width: {w};">{e(c)}</th>')
        out += ["        </tr>", "      </thead>", "      <tbody>"]
        rows = sec.get("entries", [])
        for i, ent in enumerate(rows):
            bg = "#ffffff" if i % 2 == 0 else "#fcfcfc"
            third = ent["location"] if key == "threats" else ent["tech"]
            src = ent["source"]
            out += [f'        <tr style="background-color: {bg};">',
                    f'          <td style="{td}">{e(ent["date"])}</td>',
                    f'          <td style="{td} font-weight: bold;">{e(ent["title"])}</td>',
                    f'          <td style="{td}">{e(third)}</td>',
                    f'          <td style="{td}">{e(ent["details"])}</td>',
                    f'          <td style="{td}"><a href="{e(src["url"])}" target="_blank" rel="noopener noreferrer" style="color: #1F4E79; text-decoration: underline;">{e(src["name"])}</a>{via_note(ent)}</td>',
                    "        </tr>"]
        notes = []
        if not rows:
            notes.append(sec.get("emptyNote") or "No verified updates were published in this category within the 7-day window.")
        if key == "threats" and data.get("regionalWatch", {}).get("note"):
            note = data["regionalWatch"]["note"]
            note = "<br>".join("• " + e(x) for x in note) if isinstance(note, list) else e(note)
            notes.append("Regional Note (Singapore &amp; Surrounding Waterways):<br>" + note)
        for j, note in enumerate(notes):
            bg = "#ffffff" if (len(rows) + j) % 2 == 0 else "#fcfcfc"
            text = note if note.startswith("Regional Note") else e(note)
            out += [f'        <tr style="background-color: {bg};">',
                    f'          <td colspan="5" style="{td} font-style: italic; color: #555555;">{text}</td>',
                    "        </tr>"]
        out += ["      </tbody>", "    </table>"]
    out += ["", "  </div>", "", "</body>", "</html>", ""]
    return "\n".join(out)


def check_links(data):
    for sec in data["sections"]:
        for ent in sec.get("entries", []):
            url = ent["source"]["url"]
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (PingLinkCheck)"})
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    status = r.status
            except urllib.error.HTTPError as ex:
                status = ex.code
            except Exception as ex:  # network errors are reported, not fatal
                status = f"ERR {type(ex).__name__}"
            mark = "ok " if status == 200 else "!! "
            print(f"  {mark}{status}  {ent['id']}  {url}")
            if status in (401, 402, 404, 410):
                err(data["id"], f"{ent['id']}: source returned {status}: {url}")


def top_story(data):
    """Title of the first editor's pick, shown in the archive (e.g. "Ghost Shark XL-AUV payloads")."""
    picks = data.get("editorial", {}).get("picks", [])
    for s in data["sections"]:
        for e in s.get("entries", []):
            if picks and e.get("id") == picks[0]:
                return e["title"].split(" / ")[0]
    return ""


def check_learning_files():
    """data/learnings.json and contributors/focus.md are rewritten every Monday; keep them sane."""
    learn = ROOT / "data" / "learnings.json"
    if learn.exists():
        try:
            data = json.loads(learn.read_text(encoding="utf-8"))
            for key in ("readers", "sources", "search", "sites", "history"):
                if key not in data:
                    errors.append(f"data/learnings.json: missing \"{key}\"")
        except json.JSONDecodeError as ex:
            errors.append(f"data/learnings.json is not valid JSON: {ex}")
    focus = ROOT / "contributors" / "focus.md"
    if focus.exists():
        text = focus.read_text(encoding="utf-8")
        if len(text.splitlines()) > 45:
            warnings.append("contributors/focus.md is over 40 lines; keep it short so contributors read all of it")
        if re.search(r"docs\.google\.com|@[a-z0-9-]+\.[a-z]{2,}", text, re.I):
            errors.append("contributors/focus.md is public: remove private document links and email addresses")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-links", action="store_true")
    args = ap.parse_args()

    issues = []
    for path in sorted(ISSUES_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        validate_issue(data)
        if args.check_links:
            print(f"Checking links for {data.get('id')}:")
            check_links(data)
        issues.append((path, data))

    check_learning_files()

    for w in warnings:
        print("warning:", w)
    if errors:
        for x in errors:
            print("error:", x, file=sys.stderr)
        sys.exit(1)

    index = []
    for path, data in issues:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        out = EMAIL_DIR / data["id"] / "email.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render_email(data), encoding="utf-8")
        index.append({
            "id": data["id"], "number": data["number"], "window": data["window"],
            "headline": data.get("editorial", {}).get("headline", ""),
            "top": top_story(data),
            "counts": {s["key"]: len(s.get("entries", [])) for s in data["sections"]},
        })
    index.sort(key=lambda x: x["id"], reverse=True)
    INDEX_FILE.write_text(json.dumps({"latest": index[0]["id"] if index else None, "issues": index},
                                     indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Built {len(index)} issue(s). Latest: {index[0]['id'] if index else '-'}")


if __name__ == "__main__":
    main()
