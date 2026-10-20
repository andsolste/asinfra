"""Check static site links with Python's standard library; no network requests."""
import argparse
import json
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]
errors = []


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.ids = Counter()
        self.links = []
        self.base_href = None
        self.canonical = None
        self.metadata = {}
        self.text = []
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta":
            self.metadata[attrs.get("name") or attrs.get("property") or attrs.get("http-equiv", "").lower()] = attrs.get("content", "")
        if attrs.get("id"):
            self.ids[attrs["id"]] += 1
        if tag == "base" and attrs.get("href"):
            self.base_href = attrs["href"]
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonical = attrs.get("href")
        key = "href" if tag in ("a", "link") else "src" if tag in ("script", "img", "iframe", "source") else "data" if tag == "object" else None
        if key and attrs.get(key):
            self.links.append(attrs[key])

    def handle_data(self, data):
        self.text.append(data)


# Backend and assembled output are not static website pages. apps/ is the public hub.
pages = {
    p.resolve(): Page(p) for p in ROOT.rglob("*.html")
    if ".git" not in p.parts
    and not p.is_relative_to(ROOT / "supabase")
    and not p.is_relative_to(ROOT / "publish")
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--base-url", help="Override the site root URL (defaults to the homepage canonical).")
args = parser.parse_args()
BASE = args.base_url or pages[(ROOT / "index.html").resolve()].canonical
site_url = urlsplit(BASE or "")
if site_url.scheme not in ("http", "https") or not site_url.netloc or not site_url.path.endswith("/") or site_url.query or site_url.fragment:
    parser.error("Site root must be an absolute HTTP(S) URL ending in /.")
base_path = site_url.path


def check(raw, source, base):
    url = urlsplit(urljoin(base, raw))
    if url.scheme not in ("http", "https") or url.netloc != site_url.netloc:
        return
    path = unquote(url.path)
    if not path.startswith(base_path):
        errors.append(f"{source}: outside {base_path}: {raw}")
        return
    target = (ROOT / path[len(base_path):]).resolve()
    if not target.is_relative_to(ROOT):
        errors.append(f"{source}: outside repository: {raw}")
        return
    if target.is_dir():
        target /= "index.html"
    if not target.is_file():
        errors.append(f"{source}: missing file: {raw}")
    elif url.fragment and target in pages and unquote(url.fragment) not in pages[target].ids:
        errors.append(f"{source}: missing anchor: {raw}")


for path, page in pages.items():
    relative = path.relative_to(ROOT).as_posix()
    for ident, count in page.ids.items():
        if count > 1:
            errors.append(f"{relative}: duplicate ID: {ident}")
    document_url = urljoin(BASE, relative)
    link_base = urljoin(document_url, page.base_href) if page.base_href else document_url
    for link in page.links:
        check(link, relative, link_base)

try:
    index = json.loads((ROOT / "assets/data/search-index.json").read_text(encoding="utf-8"))
    entries = index["entries"]
    for entry in entries:
        check(entry["url"], f"search: {entry['id']}", BASE)
except (OSError, ValueError, KeyError, TypeError) as error:
    errors.append(f"search-index.json: {error}")

# Cutover contract: Apps and the legacy entry go directly to Flow, not via Study.
FLOW_URL = "https://flow.asinfra.no/"
apps = pages[(ROOT / "apps/index.html").resolve()]
apps_text = " ".join(apps.text)
if "Flow" not in apps_text or "Åpne Flow" not in apps_text or "Åpne Study" in apps_text:
    errors.append("apps/: expected Flow name/action, not old Study copy")
if FLOW_URL not in apps.links or "https://study.asinfra.no/" in apps.links:
    errors.append("apps/: Flow must link directly to https://flow.asinfra.no/")
for name in ("description", "og:description"):
    if "Flow" not in apps.metadata.get(name, "") or "arbeidstid" not in apps.metadata.get(name, ""):
        errors.append(f"apps/: missing Flow/arbeidstid in {name}")
if not all(anchor in apps.ids for anchor in ("flow", "flow-title", "study")):
    errors.append("apps/: missing Flow anchor or legacy #study compatibility")

legacy = pages.get((ROOT / "study/index.html").resolve())
if not legacy:
    errors.append("study/: missing legacy redirect page")
else:
    legacy_text = " ".join(legacy.text)
    if legacy.canonical != FLOW_URL or legacy.metadata.get("refresh") != f"0; url={FLOW_URL}" or FLOW_URL not in legacy.links:
        errors.append("study/: canonical, meta refresh and fallback link must go directly to Flow")
    if "Åpne Flow" not in legacy_text or "Study" in legacy_text or "https://study.asinfra.no" in legacy_text:
        errors.append("study/: expected Flow legacy copy/target, not old Study copy")
    for expected in (f"new URL('{FLOW_URL}')", "target.search = window.location.search", "target.hash = window.location.hash", "window.location.replace(target.href)"):
        if expected not in legacy_text:
            errors.append(f"study/: missing redirect contract: {expected}")

if errors:
    print("\n".join(errors))
    raise SystemExit(1)
print(f"OK: {len(pages)} HTML pages and {len(entries)} search entries; links, assets, anchors and IDs checked.")
