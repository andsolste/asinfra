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
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids[attrs["id"]] += 1
        if tag == "base" and attrs.get("href"):
            self.base_href = attrs["href"]
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonical = attrs.get("href")
        key = "href" if tag in ("a", "link") else "src" if tag in ("script", "img", "iframe", "source") else "data" if tag == "object" else None
        if key and attrs.get(key):
            self.links.append(attrs[key])


pages = {p.resolve(): Page(p) for p in ROOT.rglob("*.html") if ".git" not in p.parts}

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

if errors:
    print("\n".join(errors))
    raise SystemExit(1)
print(f"OK: {len(pages)} HTML pages and {len(entries)} search entries; links, assets, anchors and IDs checked.")
