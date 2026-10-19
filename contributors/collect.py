#!/usr/bin/env python3
"""Ask contributing AIs for candidate Ping stories and submit them to the Ping inbox.

Runs weekly from .github/workflows/contributors.yml. Each provider runs only when its
API key and its Ping submission key are both set:

  gemini  GEMINI_API_KEY + PING_SUBMIT_KEY_GEMINI   (Gemini API with Google Search grounding)
  groq    GROQ_API_KEY   + PING_SUBMIT_KEY_GROQ     (Groq "compound" system with built-in web search)

Usage:
  python3 contributors/collect.py                 # run every configured provider
  python3 contributors/collect.py --dry-run       # print what would be submitted
  python3 contributors/collect.py --from-file x.json --source gemini --dry-run   # test parsing offline

Everything submitted is re-verified by the Monday curator; this script only does cheap pre-filtering
(unwraps redirect links and drops dead ones) so the inbox is not cluttered.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
INBOX = os.environ.get("PING_INBOX", "https://ping-feedback.raus-ums.workers.dev/submit")
UA = "Mozilla/5.0 (PingContributor)"
TIMEOUT = 240


def edition_window(now=None):
    """Coverage window for the edition this run feeds: the coming Monday (SGT) and the 7 days before it.
    Matches the inbox: on a Monday from 07:00 SGT onwards, submissions go to the following week."""
    sgt = (now or dt.datetime.now(dt.timezone.utc)) + dt.timedelta(hours=8)
    days = (7 - sgt.weekday()) % 7
    if sgt.weekday() == 0 and sgt.hour >= 7:
        days = 7
    monday = sgt.date() + dt.timedelta(days=days)
    return monday - dt.timedelta(days=7), monday


def post_json(url, body, headers, timeout=TIMEOUT):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "user-agent": UA, **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def ask_gemini(prompt):
    model = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "tools": [{"google_search": {}}]}
    data = post_json(url, body, {"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts)


def ask_groq(prompt):
    body = {"model": os.environ.get("GROQ_MODEL", "groq/compound"),
            "messages": [{"role": "user", "content": prompt}]}
    data = post_json("https://api.groq.com/openai/v1/chat/completions", body,
                     {"authorization": "Bearer " + os.environ["GROQ_API_KEY"]})
    return data["choices"][0]["message"]["content"]


PROVIDERS = {"gemini": ("GEMINI_API_KEY", ask_gemini), "groq": ("GROQ_API_KEY", ask_groq)}


def extract_entries(text):
    """Pull the {"entries": [...]} object out of a model reply (tolerates code fences and stray prose)."""
    text = re.sub(r"```(?:json)?", "", text)
    start = text.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start:i + 1])
                        if isinstance(obj, dict) and isinstance(obj.get("entries"), list):
                            return obj["entries"]
                    except json.JSONDecodeError:
                        pass
                    break
        start = text.find("{", start + 1)
    return []


def resolve(url):
    """Follow redirects (e.g. search-grounding redirect links) and return (final_url, status)."""
    for method in ("HEAD", "GET"):
        try:
            req = urllib.request.Request(url, method=method, headers={"user-agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.geturl(), r.status
        except urllib.error.HTTPError as e:
            if method == "GET" or e.code not in (403, 405, 501):
                return e.geturl() or url, e.code
        except Exception:
            if method == "GET":
                return url, None
    return url, None


def prefilter(entries, start, end):
    kept, dropped = [], []
    for e in entries:
        url = (e.get("source") or {}).get("url", "")
        try:
            d = dt.date.fromisoformat(str(e.get("date", "")))
        except ValueError:
            dropped.append((e.get("title"), "bad date"))
            continue
        if not (start <= d <= end):
            dropped.append((e.get("title"), f"date {d} outside window"))
            continue
        if not url.startswith("https://"):
            dropped.append((e.get("title"), "no https url"))
            continue
        final, status = resolve(url)
        if status in (404, 410):
            dropped.append((e.get("title"), f"dead link {status}"))
            continue
        e["source"]["url"] = final
        kept.append(e)
    return kept, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--from-file", help="parse a saved model reply instead of calling a provider")
    ap.add_argument("--source", help="provider name to use with --from-file")
    args = ap.parse_args()

    start, end = edition_window()
    prompt = (HERE / "prompt.md").read_text().replace("{START}", start.isoformat()).replace("{END}", end.isoformat())
    print(f"Edition {end} · window {start} → {end} · inbox {INBOX}")

    jobs = []
    if args.from_file:
        jobs.append((args.source or "file", lambda _p: Path(args.from_file).read_text()))
    else:
        for name, (key_env, fn) in PROVIDERS.items():
            if os.environ.get(key_env) and (args.dry_run or os.environ.get(f"PING_SUBMIT_KEY_{name.upper()}")):
                jobs.append((name, fn))
            else:
                print(f"- {name}: skipped (needs {key_env} and PING_SUBMIT_KEY_{name.upper()})")

    failures = 0
    for name, fn in jobs:
        try:
            reply = fn(prompt)
        except Exception as e:  # one provider failing must not stop the others
            print(f"! {name}: request failed: {e}")
            failures += 1
            continue
        entries = extract_entries(reply)
        kept, dropped = prefilter(entries, start, end)
        print(f"- {name}: {len(entries)} returned, {len(kept)} kept, {len(dropped)} dropped")
        for title, why in dropped:
            print(f"    dropped: {why}: {title}")
        if not kept:
            continue
        if args.dry_run:
            print(json.dumps({"entries": kept}, indent=2, ensure_ascii=False))
            continue
        try:
            res = post_json(INBOX, {"entries": kept},
                            {"authorization": "Bearer " + os.environ[f"PING_SUBMIT_KEY_{name.upper()}"]}, timeout=60)
            print(f"  submitted: {res}")
        except Exception as e:
            print(f"! {name}: submit failed: {e}")
            failures += 1
    sys.exit(1 if failures and failures == len(jobs) else 0)


if __name__ == "__main__":
    main()
