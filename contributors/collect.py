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
                transient = any(f"HTTP {c}" in str(e) for c in (429, 500, 502, 503, 504, 524))
                if transient and attempt == 1:
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
    """Ask the API which models this key may call (new accounts lose access to older ones)."""
    try:
        data = get_json("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
                        {"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    except ApiError as e:
        print(f"  gemini: could not list models ({e}); using defaults")
        return ["gemini-3.8-pro", "gemini-3.8-flash"]
    names = [m["name"].split("/", 1)[1] for m in data.get("models", [])
             if "generateContent" in m.get("supportedGenerationMethods", [])]
    skip = ("image", "tts", "audio", "live", "embedding", "thinking", "exp", "latest", "computer")
    usable = [n for n in names if not any(x in n for x in skip)]
    newest = lambda ns: sorted(ns, key=version_key)[:1]
    stable = lambda ns: [n for n in ns if "preview" not in n] or ns
    pro = stable([n for n in usable if "pro" in n])
    flash = stable([n for n in usable if "flash" in n and "lite" not in n])
    # Best first: Pro searches more thoroughly and picks better; Flash is the fallback. Still cents per run.
    picks = newest(pro) + newest(flash)
    print(f"  gemini: models available to this key → trying {picks or 'none found'}")
    return picks


def ask_gemini(prompt):
    # GEMINI_MODEL (comma-separated) overrides discovery.
    models = models_from("GEMINI_MODEL", gemini_models())

    def call(model):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "tools": [{"google_search": {}}],
                # Cap each answer (thinking included) so a single run stays at a few cents of the prepaid credit.
                "generationConfig": {"maxOutputTokens": int(os.environ.get("GEMINI_MAX_OUTPUT_TOKENS", "16384"))}}
        data = post_json(url, body, {"x-goog-api-key": os.environ["GEMINI_API_KEY"]}, timeout=600)
        usage = data.get("usageMetadata", {})
        print(f"    gemini/{model}: {usage.get('promptTokenCount', '?')} tokens in, "
              f"{usage.get('candidatesTokenCount', 0) + usage.get('thoughtsTokenCount', 0)} out")
        cand = data.get("candidates", [{}])[0]
        # The pages Google actually returned for this answer. Gemini often writes article URLs from memory;
        # these grounding links (Google redirect URLs) point to what it really read.
        chunks = (cand.get("groundingMetadata") or {}).get("groundingChunks") or []
        GROUNDING.extend(c["web"]["uri"] for c in chunks if c.get("web", {}).get("uri"))
        return "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
    return first_working("gemini", models, call)


GROUNDING = []  # grounding redirect URLs collected from Gemini answers during this run


def _words(text):
    return {w for w in re.findall(r"[a-z0-9]{3,}", (text or "").lower())
            if w not in {"the", "and", "for", "with", "from", "news", "naval", "www", "com", "html"}}


def grounded_replacement(entry, resolved):
    """Pick the page Gemini actually read that best matches this entry's title (and host, if possible)."""
    want = _words(entry.get("title")) | _words(entry.get("summary"))
    host = urllib.parse.urlparse((entry.get("source") or {}).get("url", "")).hostname or ""
    best, score = None, 0
    for final in resolved:
        p = urllib.parse.urlparse(final)
        overlap = len(want & _words(p.path))
        bonus = 2 if p.hostname and p.hostname.replace("www.", "") == host.replace("www.", "") else 0
        if overlap >= 2 and overlap + bonus > score:
            best, score = final, overlap + bonus
    return best


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
            body["reasoning_effort"] = "low"  # keeps each answer well inside Groq's ~100 s gateway timeout
        data = post_json("https://api.groq.com/openai/v1/chat/completions", body,
                         {"authorization": "Bearer " + os.environ["GROQ_API_KEY"]})
        msg = data["choices"][0]["message"]
        print(f"    groq/{model}: ran {len(msg.get('executed_tools') or [])} web search/browse steps")
        return msg.get("content") or ""
    return first_working("groq", models, call)


PROVIDERS = {"gemini": ("GEMINI_API_KEY", ask_gemini), "groq": ("GROQ_API_KEY", ask_groq)}


# One focused request per table works far better than one request for all four.
FOCUS = {
    "threats": ("Section \"threats\" only.", [
        "sea drone attack ship", "unmanned surface vessel attack", "naval drone strike Black Sea",
        "underwater drone found fishermen Indonesia OR Philippines", "narco semi-submersible seized",
        "Singapore Strait OR Malacca Strait drone OR unmanned vessel"]),
    "platforms": ("Section \"platforms\" only.", [
        "unmanned surface vessel unveiled", "autonomous underwater vehicle contract", "USV navy order",
        "UUV launched", "ROV new launch", "Singapore unmanned vessel", "China unmanned underwater vehicle"]),
    "tech": ("Section \"tech\" only.", [
        "USV launch and recovery system", "maritime machine vision unmanned", "shipborne VTOL drone",
        "sonar payload AUV new", "firefighting unmanned boat", "search and rescue unmanned vessel"]),
    "comms": ("Section \"comms\" only.", [
        "underwater acoustic modem new", "maritime satellite terminal unmanned", "mesh radio USV",
        "maritime 5G port network", "optical underwater communication"]),
}


def focused_prompts(base):
    for key, (label, queries) in FOCUS.items():
        hints = "; ".join(f'"{q}"' for q in queries)
        yield key, (f"{base}\n\nFOCUS: {label} Search thoroughly before answering: as many targeted web "
                    f"searches as it takes to cover the week (start from, e.g.: {hints}, then follow leads). "
                    "Confirm each item's publication date from the result or the article. Return every relevant item "
                    "you can verify; there is no minimum or maximum. Use section \"" + key + "\" for all entries.")


def _objects(text, start=0):
    """Yield each balanced {...} block from start onwards, ignoring braces inside JSON strings."""
    depth, begin, in_str, esc = 0, None, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            esc = (ch == "\\") and not esc
            if ch == '"' and not esc:
                in_str = False
            continue
        if ch == '"':
            in_str, esc = True, False
        elif ch == "{":
            if depth == 0:
                begin = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0:
                yield text[begin:i + 1]


def extract_entries(text):
    """Pull the {"entries": [...]} list out of a model reply. Tolerates code fences and stray prose, and
    salvages the well-formed entries when the overall JSON is broken (e.g. a truncated last item)."""
    text = re.sub(r"```(?:json)?", "", text or "")
    for block in _objects(text):
        try:
            obj = json.loads(block)
            if isinstance(obj, dict) and isinstance(obj.get("entries"), list):
                return obj["entries"]
        except json.JSONDecodeError:
            continue
    at = text.find('"entries"')
    if at == -1:
        return []
    bracket = text.find("[", at)
    salvaged = []
    for block in _objects(text, bracket + 1 if bracket != -1 else at):
        try:
            item = json.loads(block)
            if isinstance(item, dict) and item.get("section"):
                salvaged.append(item)
        except json.JSONDecodeError:
            continue
    return salvaged


def resolve(url):
    """Load the page (following redirects) and return (final_url, status). A full GET, because some sites
    answer HEAD requests with 200 even for pages that don't exist."""
    try:
        req = urllib.request.Request(url, headers={"user-agent": UA})
        with urllib.request.urlopen(req, timeout=25) as r:
            r.read(2048)
            return r.geturl(), r.status
    except urllib.error.HTTPError as e:
        return e.geturl() or url, e.code
    except Exception:
        return url, None


def prefilter(entries, start, end):
    kept, dropped = [], []
    resolved = []  # real article URLs behind Gemini's grounding links, resolved once per run
    for g in dict.fromkeys(GROUNDING):
        final, status = resolve(g)
        if status == 200 and "vertexaisearch" not in final:
            resolved.append(final)
    GROUNDING.clear()
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
        if status in (404, 410, None) and resolved:
            fix = grounded_replacement(e, resolved)
            if fix:
                print(f"    repaired link for '{e.get('title')}': {url} -> {fix}")
                final, status = fix, 200
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
        prompts = [("all", prompt)] if args.from_file else list(focused_prompts(prompt))
        entries, failed = [], False
        for i, (section, p) in enumerate(prompts):
            if i:
                time.sleep(int(os.environ.get("PING_PAUSE_SECONDS", "20")))  # stay inside free-tier rate limits
            try:
                reply = fn(p)
            except Exception as e:  # one provider failing must not stop the others
                print(f"! {name}: request failed ({section}): {e}")
                failed = True
                if any(f"HTTP {c}" in str(e) for c in (500, 502, 503, 504, 524)) or "timed out" in str(e):
                    continue  # temporary server trouble: try the remaining tables
                break  # hard errors (quota, bad key, unknown model) would repeat for every table
            got = extract_entries(reply)
            if not got:
                # Show what the model actually said, so an empty or malformed answer can be diagnosed.
                excerpt = " ".join((reply or "").split())[:400]
                print(f"  {name}/{section}: no usable entries ({len(reply or '')} chars). Excerpt: {excerpt or '(empty)'}")
            else:
                print(f"  {name}/{section}: {len(got)} candidate(s)")
            entries += got
        if failed and not entries:
            failures += 1
            continue
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
