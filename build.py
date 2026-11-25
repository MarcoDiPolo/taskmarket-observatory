"""Refresh the data, then package only the public files. Run with Python 3.10+."""
import json
from html import escape
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PUBLIC_FILES = ("index.html", "styles.css", "app.js", "share.png", "LICENSE")

def main():
    subprocess.run([sys.executable, str(ROOT / "collect.py")], cwd=ROOT, check=True)
    data = ROOT / "data" / "market.json"
    snapshot = json.loads(data.read_text(encoding="utf-8"))
    if not snapshot["asOf"] or set(snapshot["chains"]) != {"base", "tempo"}:
        raise ValueError("The snapshot must cover both networks")
    site = ROOT / "_site"
    site.mkdir(exist_ok=True)
    for name in PUBLIC_FILES:
        shutil.copyfile(ROOT / name, site / name)
    shutil.copytree(ROOT / "assets", site / "assets", dirs_exist_ok=True)
    (site / "data").mkdir(exist_ok=True)
    shutil.copyfile(data, site / "data" / "market.json")
    (site / ".nojekyll").touch()
    cache = os.environ.get("MARKET_CACHE_URL", "").strip()
    if cache:
        parts = urlsplit(cache)
        if parts.scheme != "https" or parts.username or parts.password or not parts.hostname or parts.query or parts.fragment:
            raise ValueError("MARKET_CACHE_URL must be a public HTTPS endpoint")
        page = site / "index.html"
        page.write_text(page.read_text(encoding="utf-8").replace(
            'name="market-cache-url" content=""',
            f'name="market-cache-url" content="{escape(cache, quote=True)}"',
        ), encoding="utf-8")
    # Absolute Open Graph URLs need to follow the deployment when a fork self-hosts.
    public = os.environ.get("SITE_URL")
    if not public and os.environ.get("GITHUB_REPOSITORY"):
        owner, repo = os.environ["GITHUB_REPOSITORY"].split("/", 1)
        public = f"https://{owner.lower()}.github.io/{repo}/"
    if public:
        html = site / "index.html"
        html.write_text(html.read_text(encoding="utf-8").replace(
            "https://marcodipolo.github.io/taskmarket-observatory/",
            public.rstrip("/") + "/",
        ), encoding="utf-8")
    print(f"Packaged market data as of {snapshot['asOf']}")

if __name__ == "__main__":
    main()
