"""Assemble publish/ from public static files, including the legacy Study redirect."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
PUBLISH = ROOT / "publish"
STATIC_PATHS = ("index.html", "404.html", "about", "education", "projects", "apps", "assets", "study")
PUBLIC_SUFFIXES = {
    ".html", ".css", ".js", ".json", ".svg", ".jpg", ".jpeg", ".png",
    ".webp", ".avif", ".gif", ".ico", ".pdf", ".woff", ".woff2",
    ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".wav", ".ogg",
}


def public_files(source):
    """Never include dotfiles, dependencies, symlinks or development files."""
    if not source.exists():
        raise ValueError(f"Missing input: {source.relative_to(ROOT)}")
    if source.is_symlink() or source.resolve() != source:
        raise ValueError(f"Symlinks cannot be published: {source}")
    for file in sorted(source.rglob("*") if source.is_dir() else [source]):
        parts = file.relative_to(source.parent).parts
        if any(part.startswith(".") or part == "node_modules" for part in parts):
            continue
        if file.is_symlink():
            raise ValueError(f"Symlinks cannot be published: {file}")
        if not file.is_file():
            continue
        if file.suffix.lower() not in PUBLIC_SUFFIXES or file.name in {"package.json", "package-lock.json"}:
            raise ValueError(f"Not a public asset: {file.relative_to(ROOT)}")
        yield file


def build():
    # Collect and check inputs before replacing this one generated directory.
    files = []
    for name in STATIC_PATHS:
        files.extend((file, file.relative_to(ROOT)) for file in public_files(ROOT / name))
    if [relative for _, relative in files if relative.parts[0] == "study"] != [Path("study/index.html")]:
        raise ValueError("The legacy study/ directory must contain only index.html, not frontend build assets.")

    if PUBLISH.is_symlink() or PUBLISH.resolve() != ROOT / "publish":
        raise ValueError("Refusing to replace an unsafe publish directory.")
    if PUBLISH.exists():
        shutil.rmtree(PUBLISH)
    PUBLISH.mkdir()
    for source, relative in files:
        target = PUBLISH / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    for name in ("index.html", "404.html", "about/index.html", "education/index.html",
                 "projects/index.html", "apps/index.html", "assets/favicon.svg", "study/index.html"):
        if not (PUBLISH / name).is_file():
            raise ValueError(f"Missing production file: {name}")
    print(f"OK: publish/ contains {len(files)} public files; static site + legacy Study redirect only.")


if __name__ == "__main__":
    try:
        build()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
