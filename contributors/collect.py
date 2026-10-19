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
import time
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


class ApiError(Exception):
    pass


def post_json(url, body, headers, timeout=TIMEOUT):
    """POST JSON and return the parsed reply. HTTP errors carry the API's own message (never the key)."""
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "user-agent": UA, **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            err = json.loads(detail).get("error", detail)
            detail = err.get("message", err) if isinstance(err, dict) else err
        except (ValueError, AttributeError):
            pass
        raise ApiError(f"HTTP {e.code}: {str(detail)[:300]}") from None


def first_working(name, models, call):
    """Try each model in turn; on a rate limit, wait once and retry the same model."""
    errors = []
    for model in models:
        for attempt in (1, 2):
            try:
                text = call(model)
                print(f"  {name}: answered by {model}")
                return text
            except ApiError as e:
                errors.append(f"{model}: {e}")
                if "HTTP 429" in str(e) and attempt == 1:
                    time.sleep(30)
                    continue
                break
    raise ApiError("; ".join(errors))


def get_json(url, headers):
    req = urllib.request.Request(url, headers={"user-agent": UA, **headers})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise ApiError(f"HTTP {e.code} listing models") from None


def version_key(name):
    """Sort key so newer model versions come first (gemini-3.8-flash before gemini-3.5-flash)."""
    return [-int(n) for n in re.findall(r"\d+", name)] or [0]


def models_from(env, discovered):
    override = [m.strip() for m in os.environ.get(env, "").split(",") if m.strip()]
    return override or discovered


def gemini_models():
    """Ask the API which Flash models this key may call (new accounts lose access to older ones)."""
    try:
        data = get_json("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
                        {"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    except ApiError as e:
        print(f"  gemini: could not list models ({e}); using defaults")
        return ["gemini-3.8-flash", "gemini-3.5-flash-lite"]
    names = [m["name"].split("/", 1)[1] for m in data.get("models", [])
             if "generateContent" in m.get("supportedGenerationMethods", [])]
    skip = ("image", "tts", "audio", "live", "embedding", "thinking", "exp", "preview", "latest")
    flash = sorted((n for n in names if "flash" in n and not any(x in n for x in skip)), key=version_key)
    full = [n for n in flash if "lite" not in n]
    lite = [n for n in flash if "lite" in n]
    picks = full[:2] + lite[:1]
    print(f"  gemini: models available to this key → trying {picks or 'none found'}")
    return picks


def ask_gemini(prompt):
    # GEMINI_MODEL (comma-separated) overrides discovery.
    models = models_from("GEMINI_MODEL", gemini_models())

    def call(model):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "tools": [{"google_search": {}}]}
        data = post_json(url, body, {"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        return "".join(p.get("text", "") for p in parts)
    return first_working("gemini", models, call)


def groq_models():
    """Web-search-capable models this key may call: 'compound' systems, else gpt-oss with browser search."""
    try:
        data = get_json("https://api.groq.com/openai/v1/models", {"authorization": "Bearer " + os.environ["GROQ_API_KEY"]})
    except ApiError as e:
        print(f"  groq: could not list models ({e}); using defaults")
        return ["groq/compound", "openai/gpt-oss-120b"]
    ids = [m["id"] for m in data.get("data", []) if m.get("active", True)]
    compound = sorted((i for i in ids if "compound" in i), key=lambda i: ("mini" in i, i))
    oss = sorted((i for i in ids if "gpt-oss" in i and "safeguard" not in i), key=version_key)
    picks = compound[:2] + oss[:2]
    print(f"  groq: models available to this key → trying {picks or 'none found'}")
    return picks


def ask_groq(prompt):
    # GROQ_MODEL (comma-separated) overrides discovery.
    models = models_from("GROQ_MODEL", groq_models())

    def call(model):
        body = {"model": model, "messages": [{"role": "user", "content": prompt}]}
        if "compound" not in model:
            body["tools"] = [{"type": "browser_search"}]  # gpt-oss models search the web through this tool
        data = post_json("https://api.groq.com/openai/v1/chat/completions", body,
                         {"authorization": "Bearer " + os.environ["GROQ_API_KEY"]})
        return data["choices"][0]["message"]["content"]
    return first_working("groq", models, call)


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
