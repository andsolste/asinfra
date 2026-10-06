"""Check static site links with Python's standard library; no network requests."""
import json
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://andsolste.github.io/website/"
errors = []


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.ids = Counter()
        self.links = []
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids[attrs["id"]] += 1
        key = "href" if tag in ("a", "link") else "src" if tag in ("script", "img", "iframe", "source") else "data" if tag == "object" else None
        if key and attrs.get(key):
            self.links.append(attrs[key])


pages = {p.resolve(): Page(p) for p in ROOT.rglob("*.html") if ".git" not in p.parts}


def check(raw, source, base):
    url = urlsplit(urljoin(base, raw))
    if url.scheme not in ("http", "https") or url.netloc != urlsplit(BASE).netloc:
        return
    path = unquote(url.path)
    if not path.startswith("/website/"):
        errors.append(f"{source}: outside /website/: {raw}")
        return
    target = (ROOT / path[len("/website/"):]).resolve()
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
    for link in page.links:
        check(link, relative, urljoin(BASE, relative))

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
